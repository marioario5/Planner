// Minimal stateless MCP server (Streamable HTTP transport, JSON responses only).
// Stateless is enough here: every tool is a self-contained read or write, so there's
// no session to track and each POST can be answered on its own.

import { localTime, plannerTimeToEpoch, resolveDate, shiftDate } from './dates';
import { DEFAULT_PREFIXES, isSyncable, reconcile, type SyncConfig } from './sync';
import { completedAtLocal, dayTiming, isBackfilled, lateMinutes } from './timing';
import {
  PLANS,
  TAGS,
  ValidationError,
  parseDayInfo,
  parseId,
  parseNewTask,
  parseNewTasks,
  parsePatch,
  parsePlan,
  parseStart,
  type Plan,
  type Task,
  type TaskStore,
} from './tasks';

const SUPPORTED_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const SERVER_INFO = { name: 'cozy-planner', version: '1.0.0' };

const INSTRUCTIONS =
  "Manage the daily task list shown in the user's cozy planner app. " +
  'To publish a day, call set_daily_plan once with the full ordered list. ' +
  'set_day_info publishes the headline and info sections (warnings, pre-start checklist, next PCB work...) that go with the day. ' +
  'list_tasks shows what is on the list and what the user has already checked off.';

const TAG_HELP =
  'school = general schoolwork; calculus3 = Calculus 3 (homework, studying, quizzes); ' +
  'sat = SAT prep; pcb = PCB design, assembly and debugging; photography = photography. ' +
  "Defaults to school if omitted.";

const dateProp = {
  type: 'string',
  pattern: '^\\d{4}-\\d{2}-\\d{2}$',
  description:
    'Planner day as YYYY-MM-DD. Defaults to today in the planner time zone. A day runs from 4:00am to 4:00am, ' +
    'so 12:30am still belongs to the day that is ending.',
};
const tagProp = { type: 'string', enum: [...TAGS], description: TAG_HELP };
const titleProp = {
  type: 'string',
  minLength: 1,
  maxLength: 200,
  description: 'Short title that fits on one or two lines. Put the time in start, not here.',
};
const startProp = {
  type: 'string',
  pattern: '^([01]\\d|2[0-3]):[0-5]\\d$',
  description: '24-hour start time, e.g. "15:30". Leave out for untimed tasks (shown last).',
};
const minutesProp = { type: 'integer', minimum: 1, maximum: 1440, description: 'Planned length in minutes.' };
const notesProp = {
  type: 'string',
  maxLength: 1000,
  description:
    'Detail shown when he taps the task: start move, if-then cue, method, stop time and break.',
};
const planProp = {
  type: 'string',
  enum: [...PLANS],
  description:
    'A = the normal day (default). B = the backup plan, a complete alternative list for the same day ' +
    '(e.g. a later start). Each plan is replaced independently; publishing one never touches the other.',
};
const siteKeyProp = {
  type: 'string',
  pattern: '^[A-Za-z0-9_-]{1,80}$',
  description:
    'Id of the matching task on his progress site, e.g. "calc3-t12" (Calc 3 lessons and rest-day rows). ' +
    'Checking the task in the app ticks it on the site and the other way round. ' +
    'Only ids starting with calc3- are mirrored; leave out for everything else.',
};

const TOOLS = [
  {
    name: 'set_daily_plan',
    description:
      "Replace one plan's task list for a day with the given tasks. Use this to publish a day's plan: call it once for Plan A and, if the day has a backup, once more with plan B. " +
      'Timed tasks are shown in clock order, then untimed ones in the order given. ' +
      'Tasks the user already checked off stay checked if they appear again with the same title. ' +
      'Pass an empty array to clear that plan.',
    inputSchema: {
      type: 'object',
      properties: {
        date: dateProp,
        plan: planProp,
        tasks: {
          type: 'array',
          maxItems: 100,
          items: {
            type: 'object',
            properties: {
              title: titleProp,
              tag: tagProp,
              start: startProp,
              minutes: minutesProp,
              notes: notesProp,
              siteKey: siteKeyProp,
            },
            required: ['title'],
          },
        },
      },
      required: ['tasks'],
    },
    annotations: { destructiveHint: true, idempotentHint: true },
  },
  {
    name: 'set_day_info',
    description:
      "Replace the info that goes with a day's plan: a one-line headline plus titled sections of text. " +
      'The headline is shown at the top of the receipt. Every section becomes its own button in the app, in the order given ' +
      '(e.g. warnings, pre-start checklist, next PCB work, at school, deviations, if you drift), so put the ones he should read first up front. ' +
      'Section bodies are plain text; start lines with "- " for bullets. ' +
      'Call with no arguments to clear the day. Separate from set_daily_plan, so call both.',
    inputSchema: {
      type: 'object',
      properties: {
        date: dateProp,
        headline: {
          type: 'string',
          maxLength: 300,
          description: 'One or two lines: the most important thing today and days to the next deadline.',
        },
        sections: {
          type: 'array',
          maxItems: 12,
          items: {
            type: 'object',
            properties: {
              title: { type: 'string', minLength: 1, maxLength: 60 },
              body: { type: 'string', minLength: 1, maxLength: 4000 },
            },
            required: ['title', 'body'],
          },
        },
      },
    },
    annotations: { destructiveHint: true, idempotentHint: true },
  },
  {
    name: 'list_tasks',
    description:
      'List one plan\'s tasks for a day (Plan A unless you pass plan) with their ids and whether each is done. ' +
      '`plans` shows which plans exist for the day and how many tasks are done in each. ' +
      'Done tasks carry `completed_at` and `late_min`, and the plan carries a `timing` summary (see get_history).',
    inputSchema: { type: 'object', properties: { date: dateProp, plan: planProp } },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'get_history',
    description:
      'What was planned and what he actually checked off over the last several days, oldest first. ' +
      'Each day lists its tasks with done true/false, when each was checked off (`completed_at`, local) and `late_min` ' +
      '(minutes after its planned end he ticked it; negative = early), plus a `timing` summary: first and last check-off, ' +
      'average and worst lateness, which tasks were done out of order, and `ticked_in_bulk` (3+ ticks within 10 minutes, ' +
      'meaning the times show when he ticked, not when he worked, so do not read lateness from them). ' +
      'Tasks ticked after their planner day ended are `backfilled`: they are listed in `timing.backfilled` and left out of every figure. ' +
      'If a day had both Plan A and Plan B, the day shows the one he followed (the plan with more tasks checked off, A on a tie) ' +
      'and `other_plan` gives the other one\'s totals. ' +
      'Days with no tasks are left out. Use it to see what slipped and what to carry forward. ' +
      'A task not checked off may still have been done: he has to tick it in the app.',
    inputSchema: {
      type: 'object',
      properties: {
        days: {
          type: 'integer',
          minimum: 1,
          maximum: 31,
          description: 'How many days to look at, counting back from `through`. Default 7.',
        },
        through: {
          ...dateProp,
          description: 'Last day to include, YYYY-MM-DD. Defaults to today in the planner time zone.',
        },
      },
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'add_task',
    description: "Append one task to the end of a plan's list for the day (Plan A unless you pass plan).",
    inputSchema: {
      type: 'object',
      properties: {
        date: dateProp,
        plan: planProp,
        title: titleProp,
        tag: tagProp,
        start: startProp,
        minutes: minutesProp,
        notes: notesProp,
        siteKey: siteKeyProp,
      },
      required: ['title'],
    },
    annotations: { destructiveHint: false },
  },
  {
    name: 'update_task',
    description:
      "Change a task's title, tag, time, length or notes, or mark it done / not done. " +
      'Pass null for start, minutes or notes to clear them. Get ids from list_tasks. ' +
      'When marking a task done after the fact, pass `completed` with the time he actually finished so the lateness stays accurate; ' +
      'without it the check-off is stamped with the current time.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        title: titleProp,
        tag: tagProp,
        start: { ...startProp, type: ['string', 'null'] },
        minutes: { ...minutesProp, type: ['integer', 'null'] },
        notes: { ...notesProp, type: ['string', 'null'] },
        siteKey: { ...siteKeyProp, type: ['string', 'null'] },
        done: { type: 'boolean' },
        completed: {
          ...startProp,
          description:
            "When he actually finished, 24-hour HH:MM on the task's planner day (00:00 to 03:59 means after midnight, the next morning). " +
            'Only with done: true, and not in the future.',
        },
      },
      required: ['id'],
    },
    annotations: { destructiveHint: false, idempotentHint: true },
  },
  {
    name: 'delete_task',
    description: 'Delete one task. Get ids from list_tasks.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    annotations: { destructiveHint: true, idempotentHint: true },
  },
];

export interface McpContext {
  store: TaskStore;
  timeZone: string;
  now?: Date;
  /** Mirrors check-offs with the progress site; absent = feature off. */
  sync?: SyncConfig;
}

type Json = Record<string, unknown>;

const view = (t: Task, timeZone: string) => ({
  id: t.id,
  plan: t.plan,
  title: t.title,
  tag: t.tag,
  start: t.start,
  minutes: t.minutes,
  notes: t.notes,
  siteKey: t.siteKey,
  done: t.done,
  // Local HH:MM he checked it off; null while it's not done.
  completed: t.done && t.completedAt ? localTime(t.completedAt, timeZone) : null,
  // Same moment with its date ("2026-10-02 00:30"), so a tick after midnight isn't ambiguous.
  completed_at: completedAtLocal(t, timeZone),
  // Minutes after its planned end (start + minutes) that he ticked it; negative = early.
  late_min: lateMinutes(t, timeZone),
  // Ticked after its planner day ended, so the time isn't when the work happened (no lateness is reported).
  backfilled: isBackfilled(t, timeZone),
});

function summarize(date: string, plan: Plan, tasks: Task[], timeZone: string): Json {
  const timing = dayTiming(tasks, timeZone);
  return {
    date,
    plan,
    done: tasks.filter((t) => t.done).length,
    total: tasks.length,
    ...(timing ? { timing } : {}),
    tasks: tasks.map((t) => view(t, timeZone)),
  };
}

/** Which plans exist among these tasks, with how many are done in each. */
function planTotals(all: Task[]): { plan: Plan; done: number; total: number }[] {
  return PLANS.filter((p) => all.some((t) => t.plan === p)).map((p) => {
    const mine = all.filter((t) => t.plan === p);
    return { plan: p, done: mine.filter((t) => t.done).length, total: mine.length };
  });
}

function parseDays(value: unknown): number {
  if (value === undefined || value === null) return 7;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 31) {
    throw new ValidationError('days must be a whole number from 1 to 31');
  }
  return value;
}

/** A siteKey must be one we actually mirror, so a typo fails loudly instead of silently never syncing. */
function checkSiteKeys(keys: (string | null | undefined)[], ctx: McpContext): void {
  const prefixes = ctx.sync?.prefixes ?? DEFAULT_PREFIXES;
  for (const key of keys) {
    if (key && !isSyncable(key, prefixes)) {
      throw new ValidationError(
        `siteKey "${key}" is not mirrored: only ids starting with ${prefixes.join(', ')} sync with the site`,
      );
    }
  }
}

async function history(args: Json, ctx: McpContext): Promise<Json> {
  const { store, timeZone, now } = ctx;
  const through = resolveDate(args.through, timeZone, now);
  const days = parseDays(args.days);
  const from = shiftDate(through, -(days - 1));

  const all = await store.listRange(from, through);
  await reconcile(store, all, ctx.sync); // pick up anything he ticked on the site
  const byDate = new Map<string, Task[]>();
  for (const t of all) {
    byDate.set(t.date, [...(byDate.get(t.date) ?? []), t]);
  }

  let done = 0;
  let total = 0;
  const out = [...byDate.entries()].map(([date, dayTasks]) => {
    // He follows one plan a day. Take the one with more check-offs; A wins a tie.
    const totals = planTotals(dayTasks);
    const followed = totals.reduce((best, p) => (p.done > best.done ? p : best));
    const other = totals.find((p) => p.plan !== followed.plan);
    const tasks = dayTasks.filter((t) => t.plan === followed.plan);
    done += followed.done;
    total += followed.total;
    const timing = dayTiming(tasks, timeZone);
    return {
      date,
      plan: followed.plan,
      done: followed.done,
      total: followed.total,
      ...(other ? { other_plan: other } : {}),
      ...(timing ? { timing } : {}),
      tasks: tasks.map((t) => ({
        title: t.title,
        tag: t.tag,
        start: t.start,
        minutes: t.minutes,
        done: t.done,
        completed: t.done && t.completedAt ? localTime(t.completedAt, timeZone) : null,
        completed_at: completedAtLocal(t, timeZone),
        late_min: lateMinutes(t, timeZone),
        backfilled: isBackfilled(t, timeZone),
      })),
    };
  });
  return { from, through, done, total, days: out };
}

async function callTool(name: string, args: Json, ctx: McpContext): Promise<Json> {
  const { store, timeZone, now } = ctx;
  switch (name) {
    case 'set_daily_plan': {
      const date = resolveDate(args.date, timeZone, now);
      const plan = parsePlan(args.plan);
      const parsed = parseNewTasks(args.tasks);
      checkSiteKeys(parsed.map((t) => t.siteKey), ctx);
      await store.replaceDay(date, plan, parsed);
      const all = await store.list(date);
      await reconcile(store, all, ctx.sync); // a lesson already ticked on the site arrives ticked
      return summarize(date, plan, all.filter((t) => t.plan === plan), timeZone);
    }
    case 'set_day_info': {
      const date = resolveDate(args.date, timeZone, now);
      const info = parseDayInfo(args);
      await store.setDayInfo(date, info);
      return {
        date,
        headline: info.headline,
        sections: info.sections.map((s) => ({ title: s.title })),
      };
    }
    case 'list_tasks': {
      const date = resolveDate(args.date, timeZone, now);
      const plan = parsePlan(args.plan);
      const all = await store.list(date);
      await reconcile(store, all, ctx.sync);
      return { ...summarize(date, plan, all.filter((t) => t.plan === plan), timeZone), plans: planTotals(all) };
    }
    case 'get_history':
      return history(args, ctx);
    case 'add_task': {
      const date = resolveDate(args.date, timeZone, now);
      const parsed = parseNewTask(args);
      checkSiteKeys([parsed.siteKey], ctx);
      const added = await store.add(date, parsePlan(args.plan), parsed);
      await reconcile(store, [added], ctx.sync);
      return { added: view(added, timeZone), date };
    }
    case 'update_task': {
      const id = parseId(args.id);
      const { id: _id, completed, ...rest } = args;
      const finishedTime = completed === undefined || completed === null ? null : parseStart(completed);
      if (finishedTime && rest.done !== true) throw new ValidationError('completed only goes with done: true');
      const patch = parsePatch(rest);
      checkSiteKeys([patch.siteKey], ctx);

      // "I actually finished at 6:15pm": validate before writing anything, then record that time
      // instead of the moment of ticking. Site sync still uses when it was ticked.
      let finishedAtMs: number | null = null;
      if (finishedTime) {
        const existing = await store.get(id);
        if (!existing) throw new ValidationError(`no task with id ${id}`);
        finishedAtMs = plannerTimeToEpoch(existing.date, finishedTime, timeZone);
        if (finishedAtMs > (now ?? new Date()).getTime() + 60_000) {
          throw new ValidationError(`${finishedTime} on ${existing.date} hasn't happened yet`);
        }
      }

      let task = await store.update(id, patch);
      if (!task) throw new ValidationError(`no task with id ${id}`);
      if (finishedAtMs !== null) {
        await store.setCompletedAt(id, finishedAtMs);
        task = (await store.get(id)) ?? task;
      }
      if (patch.done !== undefined || patch.siteKey) await reconcile(store, [task], ctx.sync);
      return { updated: view(task, timeZone) };
    }
    case 'delete_task': {
      const id = parseId(args.id);
      if (!(await store.remove(id))) throw new ValidationError(`no task with id ${id}`);
      return { deleted: id };
    }
    default:
      throw new RpcError(-32602, `Unknown tool: ${name}`);
  }
}

class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

async function handleRequest(msg: Json, ctx: McpContext): Promise<unknown> {
  const params = (msg.params ?? {}) as Json;
  switch (msg.method) {
    case 'initialize': {
      const wanted = params.protocolVersion;
      const protocolVersion = SUPPORTED_VERSIONS.includes(wanted as string)
        ? (wanted as string)
        : SUPPORTED_VERSIONS[0];
      return {
        protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions: INSTRUCTIONS,
      };
    }
    case 'ping':
      return {};
    case 'tools/list':
      return { tools: TOOLS };
    case 'tools/call': {
      if (typeof params.name !== 'string') throw new RpcError(-32602, 'tools/call needs a name');
      const args = (params.arguments ?? {}) as Json;
      try {
        const result = await callTool(params.name, args, ctx);
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        // Bad input is reported to the model as a tool error so it can correct itself.
        if (err instanceof ValidationError) {
          return { content: [{ type: 'text', text: err.message }], isError: true };
        }
        throw err;
      }
    }
    default:
      throw new RpcError(-32601, `Method not found: ${String(msg.method)}`);
  }
}

async function handleOne(msg: unknown, ctx: McpContext): Promise<Json | null> {
  if (typeof msg !== 'object' || msg === null || (msg as Json).jsonrpc !== '2.0') {
    return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } };
  }
  const m = msg as Json;
  const isRequest = typeof m.method === 'string' && m.id !== undefined && m.id !== null;
  // Notifications (no id) and responses from the client need no reply.
  if (!isRequest) return null;

  try {
    return { jsonrpc: '2.0', id: m.id, result: await handleRequest(m, ctx) };
  } catch (err) {
    if (err instanceof RpcError) {
      return { jsonrpc: '2.0', id: m.id, error: { code: err.code, message: err.message } };
    }
    console.error('MCP tool failure', err);
    return { jsonrpc: '2.0', id: m.id, error: { code: -32603, message: 'Internal error' } };
  }
}

/** Handles the body of one POST to the MCP endpoint. */
export async function handleMcpPost(request: Request, ctx: McpContext): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json(
      { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } },
      { status: 400 },
    );
  }

  if (Array.isArray(body)) {
    const replies = (await Promise.all(body.map((m) => handleOne(m, ctx)))).filter(
      (r): r is Json => r !== null,
    );
    return replies.length ? Response.json(replies) : new Response(null, { status: 202 });
  }

  const reply = await handleOne(body, ctx);
  return reply ? Response.json(reply) : new Response(null, { status: 202 });
}
