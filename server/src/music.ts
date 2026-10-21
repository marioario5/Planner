// The music experiment: is he more (or less) productive with YouTube on than in silence?
//
// Kept completely apart from the planner: its own MCP endpoint (/music/mcp), its own tables, its own experiments. The planner's
// tools never return any of this, and the planning run never calls this endpoint.
//
// The phone app's pink printer button toggles "YouTube mode"; each stretch is recorded as a session (same offline-safe sync as the
// gym switch). Here the sessions are laid over his finished tasks to see which blocks ran with YouTube and which in silence.

import { plannerToday, shiftDate, plannerTimeToEpoch } from './dates';
import { evaluateExperiments, finishedDays } from './habits';
import { setExperiments, type ExperimentIO, type McpContext } from './mcp';
import { actualMinutes, isFlagged, startDelayMinutes, completedMinutes } from './timing';
import { EXPERIMENT_MEASURES, ValidationError, type GymSession, type Task } from './tasks';

type Json = Record<string, unknown>;

const SUPPORTED_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const SERVER_INFO = { name: 'cozy-planner-music', version: '1.0.0' };
const MIN_PER_GROUP = 3; // blocks needed before a figure is shown
const OPEN_SESSION_CAP_MS = 6 * 3_600_000; // an open session older than this was probably forgotten
const YOUTUBE_SHARE = 0.6; // a block is a "youtube" block when at least this much of it overlapped a session
const SILENCE_SHARE = 0.1; // ...and a "silence" block when no more than this did

export const MUSIC_INSTRUCTIONS =
  'This is a separate experiment from the daily planner. A pink button on his phone app toggles "YouTube mode", and each stretch it was on is ' +
  'recorded as a session. Everything else is silence. The planner never uses this data; you do. ' +
  'Use get_music_stats to see how his work blocks went with YouTube on versus in silence, and set_music_experiments to run experiments on it, ' +
  'the same way the planner runs experiments: change ONE thing for several days (for example "silence during Calc 3"), and read the before/after in get_music_experiments. ' +
  'The comparison is an association, not proof: he may put YouTube on for easy work and keep silence for hard work, so always say what else differs between the groups before drawing a conclusion. ' +
  'Times are in the planner time zone (America/Los_Angeles); a planner day runs 04:00 to 04:00.';

const dateOf = (ms: number, timeZone: string): string =>
  new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
const timeOf = (ms: number, timeZone: string): string =>
  new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(ms));

const median = (xs: number[]): number | null => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round(((s[m - 1] + s[m]) / 2) * 100) / 100;
};
const round = (x: number | null, digits = 2): number | null => (x === null ? null : Math.round(x * 10 ** digits) / 10 ** digits);

interface Span {
  start: number;
  end: number;
}

/** The sessions as time spans; an open one runs until `nowMs` but never more than the cap. */
export function sessionSpans(sessions: GymSession[], nowMs: number): { spans: Span[]; open: boolean } {
  let open = false;
  const spans = sessions.map((s) => {
    const start = Date.parse(s.startedAt);
    if (s.endedAt) return { start, end: Date.parse(s.endedAt) };
    open = true;
    return { start, end: Math.min(nowMs, start + OPEN_SESSION_CAP_MS) };
  });
  return { spans, open };
}

function overlapMs(a: Span, spans: Span[]): number {
  let total = 0;
  for (const s of spans) total += Math.max(0, Math.min(a.end, s.end) - Math.max(a.start, s.start));
  return total;
}

export type Mode = 'youtube' | 'silence' | 'mixed';

interface Block {
  date: string;
  tag: string;
  mode: Mode;
  share: number;
  ratio: number | null; // real minutes / planned minutes
  actual: number;
  late: number | null;
  delay: number | null;
}

const summarize = (blocks: Block[]) => ({
  n: blocks.length,
  median_ratio_of_planned: round(median(blocks.map((b) => b.ratio).filter((x): x is number => x !== null))),
  median_actual_min: round(median(blocks.map((b) => b.actual)), 0),
  median_late_min: round(median(blocks.map((b) => b.late).filter((x): x is number => x !== null)), 0),
  median_start_delay_min: round(median(blocks.map((b) => b.delay).filter((x): x is number => x !== null)), 0),
});

/**
 * How each finished work block went, split by whether YouTube mode was on while it ran. Only blocks with a trustworthy Start press and
 * finish are used (the same rule as the habit stats: flagged, backfilled and batch-ticked blocks are left out).
 */
export function computeMusicStats(all: Task[], sessions: GymSession[], timeZone: string, today: string, days: number, nowMs: number) {
  const from = shiftDate(today, -days);
  const through = shiftDate(today, -1);
  const { spans, open } = sessionSpans(sessions, nowMs);

  const blocks: Block[] = [];
  const perDay: { date: string; youtube_min: number; planned: number; done: number }[] = [];
  for (const d of finishedDays(all, timeZone, from, through)) {
    const work = d.tasks.filter((t) => t.tag !== 'other');
    const dayStart = plannerTimeToEpoch(d.date, '04:00', timeZone);
    const dayEnd = plannerTimeToEpoch(shiftDate(d.date, 1), '04:00', timeZone);
    perDay.push({
      date: d.date,
      youtube_min: Math.round(overlapMs({ start: dayStart, end: dayEnd }, spans) / 60_000),
      planned: work.length,
      done: work.filter((t) => t.done).length,
    });
    for (const t of work) {
      if (!t.done || !t.startedAt || !t.completedAt || isFlagged(t)) continue;
      const actual = actualMinutes(t, timeZone, d.bulkIds);
      if (actual === null || completedMinutes(t, timeZone, d.bulkIds) === null) continue;
      const window = { start: Date.parse(t.startedAt), end: Date.parse(t.completedAt) };
      if (window.end <= window.start) continue;
      const share = overlapMs(window, spans) / (window.end - window.start);
      blocks.push({
        date: d.date,
        tag: t.tag,
        mode: share >= YOUTUBE_SHARE ? 'youtube' : share <= SILENCE_SHARE ? 'silence' : 'mixed',
        share,
        ratio: t.minutes ? actual / t.minutes : null,
        actual,
        late: d.slotLate.get(t.id) ?? null,
        delay: startDelayMinutes(t, timeZone),
      });
    }
  }

  const byMode = (mode: Mode) => blocks.filter((b) => b.mode === mode);
  const by_mode = { youtube: summarize(byMode('youtube')), silence: summarize(byMode('silence')), mixed: summarize(byMode('mixed')) };

  const by_tag: Record<string, { youtube: ReturnType<typeof summarize>; silence: ReturnType<typeof summarize> }> = {};
  const too_few: string[] = [];
  for (const tag of [...new Set(blocks.map((b) => b.tag))].sort()) {
    const y = blocks.filter((b) => b.tag === tag && b.mode === 'youtube');
    const s = blocks.filter((b) => b.tag === tag && b.mode === 'silence');
    if (y.length >= MIN_PER_GROUP && s.length >= MIN_PER_GROUP) by_tag[tag] = { youtube: summarize(y), silence: summarize(s) };
    else too_few.push(`${tag} (youtube ${y.length}, silence ${s.length})`);
  }

  // whole days: with YouTube on for a good part of the day, or not
  const heavy = perDay.filter((d) => d.youtube_min >= 60 && d.planned > 0);
  const quiet = perDay.filter((d) => d.youtube_min < 15 && d.planned > 0);
  const pct = (xs: typeof perDay) => (xs.length ? Math.round((100 * xs.reduce((n, d) => n + d.done, 0)) / xs.reduce((n, d) => n + d.planned, 0)) : null);

  const closed = sessions.filter((s) => s.endedAt);
  const minutes = closed.map((s) => Math.round((Date.parse(s.endedAt!) - Date.parse(s.startedAt)) / 60_000));
  return {
    window: { from, through, days },
    note:
      'Blocks are grouped by how much of their running time (Start press to check-off) overlapped YouTube mode: "youtube" = at least 60%, "silence" = at most 10%, "mixed" = between. ' +
      'It is an association: check which kinds of work land in each group (see by_tag) before reading a difference as an effect, and prefer an experiment.',
    sessions: {
      count: sessions.length,
      open_now: open,
      median_minutes: median(minutes),
    },
    blocks_used: blocks.length,
    by_mode,
    by_tag,
    too_few_to_split: too_few,
    whole_days: {
      youtube_days: { days: heavy.length, done_pct: pct(heavy) },
      quiet_days: { days: quiet.length, done_pct: pct(quiet) },
      note: 'youtube day = 60+ minutes of YouTube mode that planner day; quiet day = under 15 minutes. done_pct = planned work blocks checked off.',
    },
    recent_days: perDay.slice(-14).map((d) => ({ date: d.date, youtube_min: d.youtube_min, done: d.done, planned: d.planned })),
  };
}

// ---------------------------------------------------------------- tools

const TOOLS = [
  {
    name: 'get_music_sessions',
    description:
      'The stretches of YouTube mode he switched on with the pink printer button (date, start, end, minutes). `open: true` means it is on now or he forgot to switch it off. ' +
      'Optional `days` (default 14, max 90) looks back from today.',
    inputSchema: { type: 'object', properties: { days: { type: 'integer', minimum: 1, maximum: 90 } } },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'get_music_stats',
    description:
      'How his work blocks went with YouTube mode on versus in silence: per mode (and per subject where there are enough blocks) the median real time as a share of planned, ' +
      'median lateness, median start delay, plus whole days with lots of YouTube versus quiet days. It is an association, not proof. Optional `days` (default 28, max 90).',
    inputSchema: { type: 'object', properties: { days: { type: 'integer', minimum: 7, maximum: 90 } } },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'get_music_experiments',
    description:
      'The music experiments with the live before/after comparison for each running one (same measures as the planner experiments: done_pct, lateness, blocks_done, rating), ' +
      'measured from the day it started against the 14 days before.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'set_music_experiments',
    description:
      'Start, update or close music experiments, the same way the planner does. A new one needs an id (short slug), a title, a `change` (the ONE thing that differs, e.g. "no YouTube during Calc 3 blocks") and a `measure` ' +
      `(${EXPERIMENT_MEASURES.join(', ')}). Optional tag (limit it to one subject), started_on. At most 3 running at once. Closing one (status kept or dropped) needs a short result.`,
    inputSchema: {
      type: 'object',
      properties: {
        experiments: {
          type: 'array',
          maxItems: 10,
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', pattern: '^[a-z0-9][a-z0-9-]{0,39}$' },
              title: { type: 'string', maxLength: 100 },
              change: { type: 'string', maxLength: 300 },
              measure: { type: 'string', enum: [...EXPERIMENT_MEASURES] },
              tag: { type: ['string', 'null'] },
              started_on: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
              status: { type: 'string', enum: ['running', 'kept', 'dropped'] },
              result: { type: ['string', 'null'], maxLength: 400 },
            },
            required: ['id'],
          },
        },
      },
      required: ['experiments'],
    },
    annotations: { destructiveHint: false, idempotentHint: true },
  },
];

function parseDays(value: unknown, fallback: number, min: number): number {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > 90) {
    throw new ValidationError(`days must be a whole number from ${min} to 90`);
  }
  return value;
}

async function callMusicTool(name: string, args: Json, ctx: McpContext): Promise<Json> {
  const { store, timeZone } = ctx;
  const nowDate = ctx.now ?? new Date();
  const today = plannerToday(timeZone, nowDate);
  const musicIO: ExperimentIO = {
    list: () => store.listMusicExperiments(),
    save: (e) => store.saveMusicExperiment(e),
    remove: (id) => store.deleteMusicExperiment(id),
  };

  switch (name) {
    case 'get_music_sessions': {
      const days = parseDays(args.days, 14, 1);
      const sessions = await store.listMusic(new Date(plannerTimeToEpoch(shiftDate(today, -days), '00:00', timeZone)).toISOString());
      return {
        window_days: days,
        sessions: sessions.map((s) => {
          const start = Date.parse(s.startedAt);
          return {
            date: dateOf(start, timeZone),
            start: timeOf(start, timeZone),
            end: s.endedAt ? timeOf(Date.parse(s.endedAt), timeZone) : null,
            minutes: s.endedAt ? Math.round((Date.parse(s.endedAt) - start) / 60_000) : null,
            open: s.endedAt === null,
          };
        }),
      };
    }
    case 'get_music_stats': {
      const days = parseDays(args.days, 28, 7);
      const from = shiftDate(today, -days);
      const [all, sessions] = await Promise.all([
        store.listRange(from, today),
        store.listMusic(new Date(plannerTimeToEpoch(shiftDate(from, -1), '00:00', timeZone)).toISOString()),
      ]);
      return computeMusicStats(all, sessions, timeZone, today, days, nowDate.getTime());
    }
    case 'get_music_experiments': {
      const experiments = await store.listMusicExperiments();
      const earliest = experiments.filter((e) => e.status === 'running').map((e) => shiftDate(e.startedOn, -14));
      const from = [shiftDate(today, -14), ...earliest].sort()[0];
      const [all, ratings] = await Promise.all([store.listRange(from, today), store.listRatings(from, today)]);
      return { experiments: evaluateExperiments(all, ratings, experiments, timeZone, today) };
    }
    case 'set_music_experiments':
      return setExperiments(args, ctx, musicIO);
    default:
      throw new RpcError(-32602, `Unknown tool: ${name}`);
  }
}

// ---------------------------------------------------------------- JSON-RPC over HTTP (the same shape as the planner's endpoint)

class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

async function handleMethod(m: Json, ctx: McpContext): Promise<unknown> {
  const params = (m.params ?? {}) as Json;
  switch (m.method) {
    case 'initialize': {
      const wanted = params.protocolVersion;
      return {
        protocolVersion: SUPPORTED_VERSIONS.includes(wanted as string) ? (wanted as string) : SUPPORTED_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions: MUSIC_INSTRUCTIONS,
      };
    }
    case 'ping':
      return {};
    case 'tools/list':
      return { tools: TOOLS };
    case 'tools/call': {
      if (typeof params.name !== 'string') throw new RpcError(-32602, 'tools/call needs a name');
      try {
        const result = await callMusicTool(params.name, (params.arguments ?? {}) as Json, ctx);
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        if (err instanceof ValidationError) return { content: [{ type: 'text', text: err.message }], isError: true };
        throw err;
      }
    }
    default:
      throw new RpcError(-32601, `Method not found: ${String(m.method)}`);
  }
}

async function handleOne(msg: unknown, ctx: McpContext): Promise<Json | null> {
  if (typeof msg !== 'object' || msg === null || (msg as Json).jsonrpc !== '2.0') {
    return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } };
  }
  const m = msg as Json;
  if (!(typeof m.method === 'string' && m.id !== undefined && m.id !== null)) return null;
  try {
    return { jsonrpc: '2.0', id: m.id, result: await handleMethod(m, ctx) };
  } catch (err) {
    if (err instanceof RpcError) return { jsonrpc: '2.0', id: m.id, error: { code: err.code, message: err.message } };
    console.error('music MCP failure', err);
    return { jsonrpc: '2.0', id: m.id, error: { code: -32603, message: 'Internal error' } };
  }
}

export async function handleMusicMcpPost(request: Request, ctx: McpContext): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }, { status: 400 });
  }
  if (Array.isArray(body)) {
    const replies = (await Promise.all(body.map((m) => handleOne(m, ctx)))).filter((r): r is Json => r !== null);
    return replies.length ? Response.json(replies) : new Response(null, { status: 202 });
  }
  const reply = await handleOne(body, ctx);
  return reply ? Response.json(reply) : new Response(null, { status: 202 });
}
