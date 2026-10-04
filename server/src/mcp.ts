// Minimal stateless MCP server (Streamable HTTP transport, JSON responses only).
// Stateless is enough here: every tool is a self-contained read or write, so there's
// no session to track and each POST can be answered on its own.

import { localTime, plannerToday, plannerTimeToEpoch, resolveDate, shiftDate } from './dates';
import { MAX_DEFER_DAYS, MAX_OPEN_COMMITMENTS, computeFramework, unaddressed } from './framework';
import { MAX_ACTIVE_NOTES, resolvedToPrune, viewUserNotes } from './user-notes';
import { DEFAULT_WINDOW_DAYS, MAX_WINDOW_DAYS, computeHabits } from './habits';
import { DEFAULT_PREFIXES, isSyncable, reconcile, type SyncConfig } from './sync';
import { bulkTickedIds, completedAtLocal, dayTiming, isBackfilled, lateMinutes } from './timing';
import {
  COMMITMENT_STATUSES,
  PLANS,
  TAGS,
  USER_NOTE_KINDS,
  USER_NOTE_STATUSES,
  ValidationError,
  parseCommitmentId,
  parseDayInfo,
  parseHabitNotes,
  parseId,
  parseNewTask,
  parseNewTasks,
  parsePatch,
  parsePlan,
  parseStart,
  parseUserNoteId,
  type Commitment,
  type CommitmentStatus,
  type UserNote,
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
  'list_tasks shows what is on the list and what the user has already checked off. ' +
  'get_habits returns statistics on how he actually works plus the habit notes you keep with set_habits; read it before planning. ' +
  'get_framework returns a short list of SUGGESTIONS from earlier planning runs about what might matter over the next month; ' +
  'you are free to follow, change or ignore them, but do not let a flagged one vanish by accident. ' +
  'get_user_notes returns short summaries of things he told earlier agents that are not tied to one date (context, never definitive).';

const TAG_HELP =
  'school = general schoolwork; calculus3 = Calculus 3 (homework, studying, quizzes); ' +
  'sat = SAT prep; pcb = PCB design, assembly and debugging; photography = photography; college = college applications, essays, recommenders and other admissions work; other = anything else that fits no subject (dinner, errands, admin). ' +
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
const commitmentProp = {
  type: 'string',
  pattern: '^[a-z0-9][a-z0-9-]{0,39}$',
  description:
    'Optional: id of the framework commitment this task works on (e.g. "piq-7"), so real progress on it can be counted. ' +
    'It must be an open commitment (see get_framework / set_commitments).',
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
              commitment: commitmentProp,
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
      'average and worst lateness, and which tasks were done out of order. Ticks that say nothing about when the work happened are ' +
      'flagged and left out of those figures (the rest of the day still counts): `bulk_ticked` lists tasks ticked in a batch ' +
      '(3+ within 10 minutes; their times show when he ticked, not when he worked). ' +
      'Tasks ticked after their planner day ended are `backfilled` (carried over and finished on a later day, or recorded late): they are listed in `timing.backfilled` and left out of every figure. ' +
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
    name: 'get_habits',
    description:
      'How he actually works. `stats` are computed from his check-offs over the last `days` finished days (default 28): ' +
      'lateness by subject, when check-offs happen on weekdays vs weekends, and what carries over or gets missed ' +
      '(by subject and by where a block sits in the day). Figures with too few samples are withheld and listed under ' +
      '`insufficient`, and `confidence` is "low" until there are 5 finished days, so do not write habits from thin data. ' +
      '`notes` is the habit note you maintain with set_habits (null if none yet) and `versions` lists the saved versions; ' +
      'pass `version` to read an older note instead.',
    inputSchema: {
      type: 'object',
      properties: {
        days: {
          type: 'integer',
          minimum: 7,
          maximum: MAX_WINDOW_DAYS,
          description: `How many finished days back to measure. Default ${DEFAULT_WINDOW_DAYS}.`,
        },
        version: { type: 'integer', minimum: 1, description: 'Return just this saved version of the notes.' },
      },
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'set_habits',
    description:
      'Save a new version of the habit notes: a short note (max 6000 characters) about how he works, used to schedule more ' +
      'efficiently. It replaces the whole note; the last 10 versions are kept so a bad rewrite can be undone. ' +
      'Write only habits the get_habits stats support, cite the numbers and the window, drop habits the data no longer ' +
      'supports, and keep it short enough to read at the start of every plan. He can read it in the app.',
    inputSchema: {
      type: 'object',
      properties: { notes: { type: 'string', minLength: 1, maxLength: 6000 } },
      required: ['notes'],
    },
    annotations: { destructiveHint: false, idempotentHint: false },
  },
  {
    name: 'get_framework',
    description:
      'A short list of SUGGESTIONS from earlier planning runs about what might matter over the next month: each has a due date, ' +
      'a rough size and the earlier agent\'s reasoning. They are forecasts made with less information than you have now. You are free to ' +
      'follow, resize, split, defer or drop any of them, and to disagree with the whole framework. The server adds plain-language ' +
      '`signals` when one seems to be slipping (no work logged yet, behind a steady pace, stalled, overdue). `worth_a_look` are the ones ' +
      'not to lose by accident; `deferred` were set aside on purpose by an earlier run (with the reason); `recent_choices` shows what ' +
      'earlier runs decided. It says WHAT might matter, never WHEN. Small by design: read it every run.',
    inputSchema: {
      type: 'object',
      properties: { all: { type: 'boolean', description: 'Also include every open item, not just the flagged and due-soon ones.' } },
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'set_commitments',
    description:
      `Add or change suggestions in the framework (at most ${MAX_OPEN_COMMITMENTS} open). Keep them rough on purpose: a short slug id, ` +
      'a title, a due date, a rough size in minutes, and a short `note` with your reasoning and assumptions ("assumed 3 sessions of ~60 min, ' +
      'outline first") so the next planner can disagree with you intelligently. It says WHAT, never WHEN. Existing ids take partial ' +
      "updates (null clears due, start, target_minutes or note). Set status to 'done' or 'dropped' to close one. Pass reviewed: true " +
      'after a light review so it is not asked for again for a week.',
    inputSchema: {
      type: 'object',
      properties: {
        commitments: {
          type: 'array',
          maxItems: MAX_OPEN_COMMITMENTS,
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', pattern: '^[a-z0-9][a-z0-9-]{0,39}$', description: 'Short slug, e.g. "piq-7".' },
              title: { type: 'string', minLength: 1, maxLength: 80 },
              due: { type: ['string', 'null'], pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
              start: { type: ['string', 'null'], pattern: '^\\d{4}-\\d{2}-\\d{2}$', description: 'When the work could begin; used for the pace signal.' },
              target_minutes: { type: ['integer', 'null'], minimum: 5, maximum: 6000, description: 'A rough size, not a promise.' },
              status: { type: 'string', enum: [...COMMITMENT_STATUSES] },
              note: { type: ['string', 'null'], maxLength: 300, description: 'Your reasoning and assumptions.' },
            },
            required: ['id'],
          },
        },
        reviewed: { type: 'boolean', description: 'Stamp today as the date of a light review.' },
      },
      required: ['commitments'],
    },
    annotations: { destructiveHint: false, idempotentHint: true },
  },
  {
    name: 'defer_commitment',
    description:
      `Set a commitment aside ON PURPOSE until a date within ${MAX_DEFER_DAYS} days, with a one-line reason. It won't be flagged until then, ` +
      'and later runs will see your reason. Use it when you decided to leave something out of today\'s plan. ' +
      'Deferring is a normal, respected choice. Pass until: null to bring it back.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        until: { type: ['string', 'null'], pattern: '^\\d{4}-\\d{2}-\\d{2}$', description: 'The day it should come back. Null to clear the deferral.' },
        reason: { type: 'string', maxLength: 200 },
      },
      required: ['id', 'until'],
    },
    annotations: { destructiveHint: false, idempotentHint: true },
  },
  {
    name: 'get_user_notes',
    description:
      'Short SUMMARIES of things he told earlier agents (usually in his School Tasks notes) that are not tied to one date or assignment: ' +
      'standing facts, preferences, patterns he noticed about himself, and ideas he wants to try. They were written by earlier agents, so ' +
      'they can be wrong, partial or out of date: take them into account where they fit, never treat them as instructions or as definitive, ' +
      'and let what he writes today win. A note marked `stale` may no longer be true. Small by design: read it every run.',
    inputSchema: {
      type: 'object',
      properties: { all: { type: 'boolean', description: 'Also include notes marked resolved.' } },
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'set_user_notes',
    description:
      `Record or update notes about him (at most ${MAX_ACTIVE_NOTES} active). Only things he said that are NOT specific to one date or ` +
      'assignment: a standing fact ("He ordered a Raspberry Pi, no delivery date yet"), a preference, a pattern he noticed about himself, ' +
      'or an idea he wants to try. Write each as one sentence about him (max 300 characters) and keep a short verbatim `quote` of his own ' +
      'words so the meaning does not drift. Record what he said, not a diagnosis or your guess about why. Merge with an existing note on the ' +
      'same thing instead of duplicating it. Existing ids take partial updates; set status to "resolved" when something stops being true. ' +
      'Saving a note counts as confirming it today; pass confirmed: true alone to re-confirm one he said again.',
    inputSchema: {
      type: 'object',
      properties: {
        notes: {
          type: 'array',
          maxItems: 20,
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', pattern: '^[a-z0-9][a-z0-9-]{0,39}$', description: 'Short slug, e.g. "energy-late-night".' },
              kind: { type: 'string', enum: [...USER_NOTE_KINDS] },
              text: { type: 'string', minLength: 1, maxLength: 300 },
              quote: { type: ['string', 'null'], maxLength: 200, description: 'A short verbatim snippet of his own words.' },
              status: { type: 'string', enum: [...USER_NOTE_STATUSES] },
              confirmed: { type: 'boolean', description: 'He said it again: mark it confirmed today without changing anything else.' },
            },
            required: ['id'],
          },
        },
      },
      required: ['notes'],
    },
    annotations: { destructiveHint: false, idempotentHint: true },
  },
  {
    name: 'delete_user_note',
    description: 'Permanently delete one note, for example when he asks you to forget something.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    annotations: { destructiveHint: true, idempotentHint: true },
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
        commitment: commitmentProp,
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

const view = (t: Task, timeZone: string, bulk?: Set<string>) => ({
  id: t.id,
  plan: t.plan,
  title: t.title,
  tag: t.tag,
  start: t.start,
  minutes: t.minutes,
  notes: t.notes,
  siteKey: t.siteKey,
  commitment: t.commitmentId,
  done: t.done,
  // Local HH:MM he checked it off; null while it's not done.
  completed: t.done && t.completedAt ? localTime(t.completedAt, timeZone) : null,
  // Same moment with its date ("2026-10-02 00:30"), so a tick after midnight isn't ambiguous.
  completed_at: completedAtLocal(t, timeZone),
  // Minutes after its planned end (start + minutes) that he ticked it; negative = early. Null for backfilled or batch-ticked tasks.
  late_min: lateMinutes(t, timeZone, bulk),
  // Ticked after its planner day ended, so the time isn't when the work happened (no lateness is reported).
  backfilled: isBackfilled(t, timeZone),
  // Ticked in a batch (3+ within 10 minutes), so the time is when he ticked, not when he worked (no lateness is reported).
  bulk_ticked: bulk?.has(t.id) ?? false,
});

function summarize(date: string, plan: Plan, tasks: Task[], timeZone: string): Json {
  const timing = dayTiming(tasks, timeZone);
  const bulk = bulkTickedIds(tasks, timeZone);
  return {
    date,
    plan,
    done: tasks.filter((t) => t.done).length,
    total: tasks.length,
    ...(timing ? { timing } : {}),
    tasks: tasks.map((t) => view(t, timeZone, bulk)),
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

async function loadFramework(ctx: McpContext, includeAll = false) {
  const { store, timeZone, now } = ctx;
  const today = plannerToday(timeZone, now);
  const [commitments, work, log, reviewedOn] = await Promise.all([
    store.listCommitments(),
    store.commitmentWork(),
    store.listFrameworkLog(10),
    store.getMeta('framework_reviewed_on'),
  ]);
  return { today, commitments, framework: computeFramework(commitments, work, log, reviewedOn, today, includeAll) };
}

/** A task may only point at a commitment that exists and is still open. */
async function checkCommitments(ids: (string | null | undefined)[], ctx: McpContext): Promise<void> {
  const wanted = [...new Set(ids.filter((i): i is string => !!i))];
  if (wanted.length === 0) return;
  const byId = new Map((await ctx.store.listCommitments()).map((c) => [c.id, c]));
  for (const id of wanted) {
    const c = byId.get(id);
    if (!c) throw new ValidationError(`unknown commitment "${id}": create it first with set_commitments, or leave commitment out`);
    if (c.status !== 'open') throw new ValidationError(`commitment "${id}" is ${c.status}; leave commitment out or reopen it with set_commitments`);
  }
}

/** After publishing today's plan: which flagged suggestions did the plan leave out? (Reported, never enforced.) */
async function frameworkCheck(ctx: McpContext, date: string, todaysTasks: Task[]): Promise<Json | null> {
  const { today, framework } = await loadFramework(ctx);
  if (date !== today) return null;
  const scheduled = new Set(todaysTasks.map((t) => t.commitmentId).filter((i): i is string => !!i));
  const left = unaddressed(framework, scheduled);
  if (left.length === 0 && !framework.review_due) return null;
  return {
    ...(left.length ? { not_in_todays_plan: left.map((i) => ({ id: i.id, title: i.title, signals: i.signals })) } : {}),
    ...(framework.review_due ? { review_due: true } : {}),
    hint:
      "These are earlier agents' suggestions and the call is yours. If you leave one out on purpose, say so with defer_commitment " +
      '(a one-line reason) or change it with set_commitments; there is no penalty for disagreeing. ' +
      (framework.review_due ? 'A light review is due: see get_framework.' : ''),
  };
}

function strictDate(value: unknown, name: string): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new ValidationError(`${name} must look like YYYY-MM-DD`);
  return resolveDate(value, 'UTC');
}

async function setCommitments(args: Json, ctx: McpContext): Promise<Json> {
  const { store, now, timeZone } = ctx;
  if (!Array.isArray(args.commitments)) throw new ValidationError('commitments must be an array');
  if (args.commitments.length > MAX_OPEN_COMMITMENTS) throw new ValidationError(`at most ${MAX_OPEN_COMMITMENTS} commitments per call`);
  const today = plannerToday(timeZone, now);
  const stamp = (now ?? new Date()).toISOString();

  // Validate and merge everything first, so a bad entry leaves the framework untouched.
  const existing = new Map((await store.listCommitments()).map((c) => [c.id, c]));
  const merged = new Map(existing);
  const changed: { c: Commitment; closed: 'done' | 'dropped' | null; added: boolean }[] = [];
  for (const raw of args.commitments) {
    if (typeof raw !== 'object' || raw === null) throw new ValidationError('each commitment must be an object with an id');
    const r = raw as Json;
    const id = parseCommitmentId(r.id);
    const old = merged.get(id);
    const has = (k: string) => Object.prototype.hasOwnProperty.call(r, k);
    if (!old && (typeof r.title !== 'string' || r.title.trim() === '')) throw new ValidationError(`new commitment "${id}" needs a title`);

    const next: Commitment = old
      ? { ...old }
      : { id, title: '', due: null, start: null, targetMinutes: null, status: 'open', note: null, deferUntil: null, deferReason: null, createdOn: today, updatedAt: stamp };
    if (has('title')) {
      if (typeof r.title !== 'string' || r.title.trim() === '' || r.title.trim().length > 80) throw new ValidationError(`title for "${id}" must be 1 to 80 characters`);
      next.title = r.title.trim();
    }
    if (has('due')) next.due = r.due === null ? null : strictDate(r.due, `due for "${id}"`);
    if (has('start')) next.start = r.start === null ? null : strictDate(r.start, `start for "${id}"`);
    if (has('target_minutes')) {
      const m = r.target_minutes;
      if (m !== null && (typeof m !== 'number' || !Number.isInteger(m) || m < 5 || m > 6000)) throw new ValidationError(`target_minutes for "${id}" must be a whole number from 5 to 6000, or null`);
      next.targetMinutes = m as number | null;
    }
    if (has('note')) {
      if (r.note !== null && (typeof r.note !== 'string' || r.note.trim().length > 300)) throw new ValidationError(`note for "${id}" must be at most 300 characters`);
      next.note = r.note === null || (r.note as string).trim() === '' ? null : (r.note as string).trim();
    }
    let closed: 'done' | 'dropped' | null = null;
    if (has('status')) {
      if (typeof r.status !== 'string' || !(COMMITMENT_STATUSES as readonly string[]).includes(r.status)) throw new ValidationError(`status for "${id}" must be one of: ${COMMITMENT_STATUSES.join(', ')}`);
      if (r.status !== next.status && r.status !== 'open') closed = r.status as 'done' | 'dropped';
      next.status = r.status as CommitmentStatus;
      if (next.status !== 'open') {
        next.deferUntil = null;
        next.deferReason = null;
      }
    }
    next.updatedAt = stamp;
    merged.set(id, next);
    changed.push({ c: next, closed, added: !old });
  }
  const open = [...merged.values()].filter((c) => c.status === 'open').length;
  if (open > MAX_OPEN_COMMITMENTS) {
    throw new ValidationError(`that would leave ${open} open commitments; keep at most ${MAX_OPEN_COMMITMENTS} (drop or finish some, and keep them rough)`);
  }

  for (const { c, closed } of changed) {
    await store.saveCommitment(c);
    if (closed) await store.addFrameworkLog({ onDate: today, commitmentId: c.id, action: closed, detail: c.note ?? c.title });
  }
  if (args.reviewed === true) {
    await store.setMeta('framework_reviewed_on', today);
    const added = changed.filter((x) => x.added).length;
    const closedCount = changed.filter((x) => x.closed).length;
    await store.addFrameworkLog({ onDate: today, commitmentId: null, action: 'review', detail: `${added} added, ${closedCount} closed, ${open} open` });
  }
  return { saved: changed.length, open, reviewed_on: (await store.getMeta('framework_reviewed_on')) ?? null };
}

async function deferCommitment(args: Json, ctx: McpContext): Promise<Json> {
  const { store, now, timeZone } = ctx;
  const id = parseCommitmentId(args.id);
  const today = plannerToday(timeZone, now);
  const c = (await store.listCommitments()).find((x) => x.id === id);
  if (!c) throw new ValidationError(`no commitment "${id}"`);
  if (c.status !== 'open') throw new ValidationError(`commitment "${id}" is ${c.status}, so there is nothing to defer`);
  const stamp = (now ?? new Date()).toISOString();

  if (args.until === null) {
    await store.saveCommitment({ ...c, deferUntil: null, deferReason: null, updatedAt: stamp });
    await store.addFrameworkLog({ onDate: today, commitmentId: id, action: 'undefer', detail: typeof args.reason === 'string' ? args.reason.trim() : 'brought back' });
    return { id, deferred_until: null };
  }
  const until = strictDate(args.until, 'until');
  if (until <= today) throw new ValidationError('until must be after today');
  if (until > shiftDate(today, MAX_DEFER_DAYS)) throw new ValidationError(`a deferral can last at most ${MAX_DEFER_DAYS} days; pick an earlier day (you can defer again then)`);
  if (typeof args.reason !== 'string' || args.reason.trim() === '' || args.reason.trim().length > 200) {
    throw new ValidationError('give a one-line reason (at most 200 characters) so later runs understand the choice');
  }
  const reason = args.reason.trim();
  await store.saveCommitment({ ...c, deferUntil: until, deferReason: reason, updatedAt: stamp });
  await store.addFrameworkLog({ onDate: today, commitmentId: id, action: 'defer', detail: `until ${until}: ${reason}` });
  return { id, deferred_until: until, reason };
}

async function setUserNotes(args: Json, ctx: McpContext): Promise<Json> {
  const { store, now, timeZone } = ctx;
  if (!Array.isArray(args.notes)) throw new ValidationError('notes must be an array');
  if (args.notes.length > 20) throw new ValidationError('at most 20 notes per call');
  const today = plannerToday(timeZone, now);
  const stamp = (now ?? new Date()).toISOString();
  const has = (r: Json, k: string) => Object.prototype.hasOwnProperty.call(r, k);

  // Validate and merge everything first, so one bad entry leaves the notes untouched.
  const merged = new Map((await store.listUserNotes()).map((n) => [n.id, n]));
  const touched = new Map<string, UserNote>();
  for (const raw of args.notes) {
    if (typeof raw !== 'object' || raw === null) throw new ValidationError('each note must be an object with an id');
    const r = raw as Json;
    const id = parseUserNoteId(r.id);
    const old = merged.get(id);
    if (!old && (typeof r.text !== 'string' || r.text.trim() === '' || typeof r.kind !== 'string')) {
      throw new ValidationError(`new note "${id}" needs a kind and a text`);
    }
    const next: UserNote = old
      ? { ...old }
      : { id, kind: 'fact', text: '', quote: null, notedOn: today, confirmedOn: today, status: 'active', updatedAt: stamp };

    let reconfirm = !old || r.confirmed === true;
    if (has(r, 'kind')) {
      if (typeof r.kind !== 'string' || !(USER_NOTE_KINDS as readonly string[]).includes(r.kind)) {
        throw new ValidationError(`kind for "${id}" must be one of: ${USER_NOTE_KINDS.join(', ')}`);
      }
      next.kind = r.kind as UserNote['kind'];
      reconfirm = true;
    }
    if (has(r, 'text')) {
      if (typeof r.text !== 'string' || r.text.trim() === '' || r.text.trim().length > 300) {
        throw new ValidationError(`text for "${id}" must be 1 to 300 characters`);
      }
      next.text = r.text.trim();
      reconfirm = true;
    }
    if (has(r, 'quote')) {
      if (r.quote !== null && (typeof r.quote !== 'string' || r.quote.trim().length > 200)) {
        throw new ValidationError(`quote for "${id}" must be at most 200 characters`);
      }
      next.quote = r.quote === null || (r.quote as string).trim() === '' ? null : (r.quote as string).trim();
      reconfirm = true;
    }
    if (has(r, 'status')) {
      if (typeof r.status !== 'string' || !(USER_NOTE_STATUSES as readonly string[]).includes(r.status)) {
        throw new ValidationError(`status for "${id}" must be one of: ${USER_NOTE_STATUSES.join(', ')}`);
      }
      next.status = r.status as UserNote['status'];
    }
    if (reconfirm && next.status === 'active') next.confirmedOn = today;
    next.updatedAt = stamp;
    merged.set(id, next);
    touched.set(id, next);
  }
  const active = [...merged.values()].filter((n) => n.status === 'active').length;
  if (active > MAX_ACTIVE_NOTES) {
    throw new ValidationError(`that would leave ${active} active notes; keep at most ${MAX_ACTIVE_NOTES} (merge duplicates or resolve old ones)`);
  }

  for (const note of touched.values()) await store.saveUserNote(note);
  for (const id of resolvedToPrune([...merged.values()])) await store.deleteUserNote(id);
  return { saved: touched.size, active };
}

function parseWindow(value: unknown): number {
  if (value === undefined || value === null) return DEFAULT_WINDOW_DAYS;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 7 || value > MAX_WINDOW_DAYS) {
    throw new ValidationError(`days must be a whole number from 7 to ${MAX_WINDOW_DAYS}`);
  }
  return value;
}

const noteView = (n: { version: number; updatedAt: string; text: string }) => ({
  version: n.version,
  updated_at: n.updatedAt,
  text: n.text,
});

async function habits(args: Json, ctx: McpContext): Promise<Json> {
  const { store, timeZone, now } = ctx;
  if (args.version !== undefined && args.version !== null) {
    if (typeof args.version !== 'number' || !Number.isInteger(args.version) || args.version < 1) {
      throw new ValidationError('version must be a whole number from the versions list');
    }
    const found = await store.getHabitNotes(args.version);
    if (!found) throw new ValidationError(`no habit notes version ${args.version}`);
    return { notes: noteView(found) };
  }
  const days = parseWindow(args.days);
  const today = plannerToday(timeZone, now);
  const all = await store.listRange(shiftDate(today, -days), today);
  await reconcile(store, all, ctx.sync); // pick up anything he ticked on the site
  const [latest, versions] = await Promise.all([store.getHabitNotes(), store.listHabitVersions()]);
  return {
    stats: computeHabits(all, timeZone, today, days),
    notes: latest ? noteView(latest) : null,
    versions: versions.map((v) => ({ version: v.version, updated_at: v.updatedAt, chars: v.chars })),
  };
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
    const bulk = bulkTickedIds(tasks, timeZone);
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
        late_min: lateMinutes(t, timeZone, bulk),
        backfilled: isBackfilled(t, timeZone),
        bulk_ticked: bulk.has(t.id),
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
      await checkCommitments(parsed.map((t) => t.commitment), ctx);
      await store.replaceDay(date, plan, parsed);
      const all = await store.list(date);
      await reconcile(store, all, ctx.sync); // a lesson already ticked on the site arrives ticked
      const published = summarize(date, plan, all.filter((t) => t.plan === plan), timeZone);
      const check = await frameworkCheck(ctx, date, all);
      return check ? { ...published, framework_check: check } : published;
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
    case 'get_habits':
      return habits(args, ctx);
    case 'get_framework':
      return { ...(await loadFramework(ctx, args.all === true)).framework };
    case 'set_commitments':
      return setCommitments(args, ctx);
    case 'defer_commitment':
      return deferCommitment(args, ctx);
    case 'get_user_notes':
      return viewUserNotes(await store.listUserNotes(), plannerToday(timeZone, now), args.all === true);
    case 'set_user_notes':
      return setUserNotes(args, ctx);
    case 'delete_user_note': {
      const id = parseUserNoteId(args.id);
      if (!(await store.deleteUserNote(id))) throw new ValidationError(`no note "${id}"`);
      return { deleted: id };
    }
    case 'set_habits': {
      const saved = await store.saveHabitNotes(parseHabitNotes(args.notes));
      return { version: saved.version, updated_at: saved.updatedAt, chars: saved.text.length };
    }
    case 'add_task': {
      const date = resolveDate(args.date, timeZone, now);
      const parsed = parseNewTask(args);
      checkSiteKeys([parsed.siteKey], ctx);
      await checkCommitments([parsed.commitment], ctx);
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
