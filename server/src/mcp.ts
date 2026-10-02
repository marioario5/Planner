// Minimal stateless MCP server (Streamable HTTP transport, JSON responses only).
// Stateless is enough here: every tool is a self-contained read or write, so there's
// no session to track and each POST can be answered on its own.

import { localTime, resolveDate, shiftDate } from './dates';
import {
  TAGS,
  ValidationError,
  parseDayInfo,
  parseId,
  parseNewTask,
  parseNewTasks,
  parsePatch,
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
  description: 'Planner day as YYYY-MM-DD. Defaults to today in the planner time zone.',
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
  pattern: '^([01]\d|2[0-3]):[0-5]\d$',
  description: '24-hour start time, e.g. "15:30". Leave out for untimed tasks (shown last).',
};
const minutesProp = { type: 'integer', minimum: 1, maximum: 1440, description: 'Planned length in minutes.' };
const notesProp = {
  type: 'string',
  maxLength: 1000,
  description:
    'Detail shown when he taps the task: start move, if-then cue, method, stop time and break.',
};

const TOOLS = [
  {
    name: 'set_daily_plan',
    description:
      "Replace the whole task list for a day with the given tasks. Use this to publish a day's plan. Timed tasks are shown in clock order, then untimed ones in the order given. " +
      'Tasks the user already checked off stay checked if they appear again with the same title. ' +
      'Pass an empty array to clear the day.',
    inputSchema: {
      type: 'object',
      properties: {
        date: dateProp,
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
      'The app prints front=true sections on the first side of the receipt (the briefing he reads before starting: ' +
      'warnings, pre-start checklist) and gives every other section its own button (e.g. next PCB work, at school, ' +
      'deviations, if you drift). Section bodies are plain text; start lines with "- " for bullets. ' +
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
              front: {
                type: 'boolean',
                description: 'true = printed on the briefing side. Default false = a button.',
              },
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
    description: 'List the tasks for a day with their ids and whether each is done.',
    inputSchema: { type: 'object', properties: { date: dateProp } },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'get_history',
    description:
      'What was planned and what he actually checked off over the last several days, oldest first. ' +
      'Each day lists its tasks with done true/false and the local time (HH:MM) each was checked off. ' +
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
    description: "Append one task to the end of a day's list.",
    inputSchema: {
      type: 'object',
      properties: {
        date: dateProp,
        title: titleProp,
        tag: tagProp,
        start: startProp,
        minutes: minutesProp,
        notes: notesProp,
      },
      required: ['title'],
    },
    annotations: { destructiveHint: false },
  },
  {
    name: 'update_task',
    description:
      "Change a task's title, tag, time, length or notes, or mark it done / not done. " +
      'Pass null for start, minutes or notes to clear them. Get ids from list_tasks.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        title: titleProp,
        tag: tagProp,
        start: { ...startProp, type: ['string', 'null'] },
        minutes: { ...minutesProp, type: ['integer', 'null'] },
        notes: { ...notesProp, type: ['string', 'null'] },
        done: { type: 'boolean' },
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
}

type Json = Record<string, unknown>;

const view = (t: Task, timeZone: string) => ({
  id: t.id,
  title: t.title,
  tag: t.tag,
  start: t.start,
  minutes: t.minutes,
  notes: t.notes,
  done: t.done,
  // Local HH:MM he checked it off; null while it's not done.
  completed: t.done && t.completedAt ? localTime(t.completedAt, timeZone) : null,
});

function summarize(date: string, tasks: Task[], timeZone: string): Json {
  return {
    date,
    done: tasks.filter((t) => t.done).length,
    total: tasks.length,
    tasks: tasks.map((t) => view(t, timeZone)),
  };
}

function parseDays(value: unknown): number {
  if (value === undefined || value === null) return 7;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 31) {
    throw new ValidationError('days must be a whole number from 1 to 31');
  }
  return value;
}

async function history(args: Json, ctx: McpContext): Promise<Json> {
  const { store, timeZone, now } = ctx;
  const through = resolveDate(args.through, timeZone, now);
  const days = parseDays(args.days);
  const from = shiftDate(through, -(days - 1));

  const byDate = new Map<string, Task[]>();
  for (const t of await store.listRange(from, through)) {
    byDate.set(t.date, [...(byDate.get(t.date) ?? []), t]);
  }

  let done = 0;
  let total = 0;
  const out = [...byDate.entries()].map(([date, tasks]) => {
    const dayDone = tasks.filter((t) => t.done).length;
    done += dayDone;
    total += tasks.length;
    return {
      date,
      done: dayDone,
      total: tasks.length,
      tasks: tasks.map((t) => ({
        title: t.title,
        tag: t.tag,
        start: t.start,
        minutes: t.minutes,
        done: t.done,
        completed: t.done && t.completedAt ? localTime(t.completedAt, timeZone) : null,
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
      const tasks = await store.replaceDay(date, parseNewTasks(args.tasks));
      return summarize(date, tasks, timeZone);
    }
    case 'set_day_info': {
      const date = resolveDate(args.date, timeZone, now);
      const info = parseDayInfo(args);
      await store.setDayInfo(date, info);
      return {
        date,
        headline: info.headline,
        sections: info.sections.map((s) => ({ title: s.title, front: s.front })),
      };
    }
    case 'list_tasks': {
      const date = resolveDate(args.date, timeZone, now);
      return summarize(date, await store.list(date), timeZone);
    }
    case 'get_history':
      return history(args, ctx);
    case 'add_task': {
      const date = resolveDate(args.date, timeZone, now);
      return { added: view(await store.add(date, parseNewTask(args)), timeZone), date };
    }
    case 'update_task': {
      const id = parseId(args.id);
      const { id: _id, ...rest } = args;
      const task = await store.update(id, parsePatch(rest));
      if (!task) throw new ValidationError(`no task with id ${id}`);
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
