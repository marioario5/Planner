// What the check-off times say about how the day went: late or early, out of order, ticked all at once.
// Pure functions over a plan's tasks so the MCP tools can report them.
//
// Three kinds of tick say nothing reliable about when the work happened, so they are flagged and kept out of every
// lateness, order, duration and time-of-day figure (the other ticks on the same day still count):
//  - a *backfill*: ticked after the planner day ended (04:00 the next morning)
//  - a *bulk tick*: three or more ticks within 10 minutes of each other (he ticked a batch)
//  - a *flagged* task: he held the flag on it because he forgot to start or finish it on time
// When he pressed Start on a block, the real time it took (`actualMinutes`) and how late it began (`startDelayMinutes`)
// are known too, instead of guessed from the tick.

import { DAY_START_HOUR, shiftDate } from './dates';
import type { Task } from './tasks';

interface Parts {
  date: string; // YYYY-MM-DD in the planner time zone
  minutes: number; // minutes since local midnight
}

function localParts(iso: string, timeZone: string): Parts {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(iso));
  const get = (type: string) => parts.find((p) => p.type === type)!.value;
  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    minutes: Number(get('hour')) * 60 + Number(get('minute')),
  };
}

const hhmm = (minutes: number) =>
  `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;

const dayNumber = (date: string) => Date.UTC(+date.slice(0, 4), +date.slice(5, 7) - 1, +date.slice(8, 10)) / 86_400_000;

/** "YYYY-MM-DD HH:MM" local, or null if the task isn't done. */
export function completedAtLocal(t: Task, timeZone: string): string | null {
  if (!t.done || !t.completedAt) return null;
  const p = localParts(t.completedAt, timeZone);
  return `${p.date} ${hhmm(p.minutes)}`;
}

/** True if the task was ticked after its planner day ended, so its time isn't when the work happened. */
export function isBackfilled(t: Task, timeZone: string): boolean {
  if (!t.done || !t.completedAt) return false;
  const p = localParts(t.completedAt, timeZone);
  // The planner day the tick itself falls in: before 04:00 it is still the previous calendar date.
  const tickDay = p.minutes < DAY_START_HOUR * 60 ? shiftDate(p.date, -1) : p.date;
  return tickDay > t.date;
}

/** True if he flagged the task: its start and finish times must not feed any figure. */
export const isFlagged = (t: Task): boolean => t.flaggedAt !== null && t.flaggedAt !== undefined;

const BULK_WINDOW_MS = 10 * 60_000;

const TOGETHER_WINDOW_MS = 3 * 60_000;

/** "Chem POGIL" for "Chem POGIL: part 1": the part before the first colon, lower-cased; null without a colon. */
const seriesOf = (t: Task): string | null => {
  const i = t.title.indexOf(':');
  return i > 0 ? t.title.slice(0, i).trim().toLowerCase() : null;
};

/**
 * Blocks of one piece of work that were finished in a single sitting: a block with no Start press, ticked within three
 * minutes of another block he did start, with the same subject and the same title prefix before the colon ("Chem POGIL:
 * part 1" and "Chem POGIL: finish"). The unstarted block says nothing about its own time: the work was done together
 * with the other one. Returns each such block's id mapped to the block it was finished with.
 */
export function finishedTogether(tasks: Task[], timeZone: string): Map<string, Task> {
  const done = tasks.filter((t) => t.done && t.completedAt && !isFlagged(t) && !isBackfilled(t, timeZone));
  const out = new Map<string, Task>();
  for (const follower of done) {
    const series = seriesOf(follower);
    if (!series || follower.startedAt) continue;
    const at = new Date(follower.completedAt!).getTime();
    let best: { task: Task; gap: number } | null = null;
    for (const leader of done) {
      if (leader.id === follower.id || !leader.startedAt || leader.tag !== follower.tag || seriesOf(leader) !== series) continue;
      const gap = Math.abs(new Date(leader.completedAt!).getTime() - at);
      if (gap <= TOGETHER_WINDOW_MS && (!best || gap < best.gap)) best = { task: leader, gap };
    }
    if (best) out.set(follower.id, best.task);
  }
  return out;
}

/**
 * The ids of tasks whose tick time says nothing about when the work happened: any run of three or more ticks within
 * 10 minutes (he ticked a batch), plus blocks finished together with another block of the same work (`finishedTogether`).
 * Backfilled ticks are not counted (they are flagged separately).
 */
export function bulkTickedIds(tasks: Task[], timeZone: string): Set<string> {
  // Blocks finished together with another count as one tick (they are one piece of work), so they never make a batch.
  const together = finishedTogether(tasks, timeZone);
  const ticks = tasks
    .filter((t) => t.done && t.completedAt && !isFlagged(t) && !isBackfilled(t, timeZone) && !together.has(t.id))
    .map((t) => ({ id: t.id, ms: new Date(t.completedAt!).getTime() }))
    .sort((a, b) => a.ms - b.ms);
  const bulk = new Set<string>(together.keys());
  for (let i = 0; i + 2 < ticks.length; i++) {
    if (ticks[i + 2].ms - ticks[i].ms <= BULK_WINDOW_MS) {
      bulk.add(ticks[i].id);
      bulk.add(ticks[i + 1].id);
      bulk.add(ticks[i + 2].id);
    }
  }
  return bulk;
}

/**
 * Minutes after its planner day's local midnight that the task was really finished (1440+ = after midnight).
 * null if not done, backfilled, or ticked in bulk, since those times say nothing about when the work happened.
 */
export function completedMinutes(t: Task, timeZone: string, bulk?: Set<string>): number | null {
  if (!t.done || !t.completedAt || isFlagged(t) || isBackfilled(t, timeZone) || bulk?.has(t.id)) return null;
  const p = localParts(t.completedAt, timeZone);
  return (dayNumber(p.date) - dayNumber(t.date)) * 1440 + p.minutes;
}

/**
 * Minutes after its planned end that the task was checked off (negative = early).
 * null unless the task is done, has both a start and a length, and wasn't backfilled or ticked in bulk.
 */
export function lateMinutes(t: Task, timeZone: string, bulk?: Set<string>): number | null {
  if (!t.done || !t.completedAt || !t.start || !t.minutes || isFlagged(t) || isBackfilled(t, timeZone) || bulk?.has(t.id)) return null;
  const p = localParts(t.completedAt, timeZone);
  const [h, m] = t.start.split(':').map(Number);
  const plannedEnd = h * 60 + m + t.minutes;
  const completed = (dayNumber(p.date) - dayNumber(t.date)) * 1440 + p.minutes;
  return completed - plannedEnd;
}

const SWAP_WINDOW_MIN = 120;

/**
 * Lateness with order swaps taken out, so doing two neighbouring blocks the other way round is not counted as lateness.
 * When a block was planned right before another but he finished it after that one, and both ticks are within two hours
 * of each other, each is compared with the other's planned end instead of its own: planned PIQ 1:35 / Calc 12:20 and
 * done Calc-after-PIQ stays on time for both, while being genuinely behind still shows as behind. Everything else keeps
 * its own planned end, so a block that was simply put off until late at night is still late and the blocks done on time
 * around it are not blamed. Only blocks `lateMinutes` can measure are used. Returns id -> minutes after the planned end
 * (negative = early).
 */
export function slotLateness(tasks: Task[], timeZone: string, bulk?: Set<string>): Map<string, number> {
  const rows = tasks
    .filter((t) => lateMinutes(t, timeZone, bulk) !== null)
    .map((t) => {
      const [h, m] = t.start!.split(':').map(Number);
      const p = localParts(t.completedAt!, timeZone);
      const start = h * 60 + m;
      return { id: t.id, start, end: start + t.minutes!, done: (dayNumber(p.date) - dayNumber(t.date)) * 1440 + p.minutes };
    })
    .sort((x, y) => x.start - y.start || x.end - y.end);
  const out = new Map<string, number>();
  for (let i = 0; i < rows.length; i++) {
    const a = rows[i];
    const b = rows[i + 1];
    if (b && b.done < a.done && a.done - b.done <= SWAP_WINDOW_MIN) {
      out.set(a.id, a.done - b.end);
      out.set(b.id, b.done - a.end);
      i++;
    } else {
      out.set(a.id, a.done - a.end);
    }
  }
  return out;
}

/** Minutes after its planner day's local midnight that he pressed Start; null if he didn't, flagged it, or it was a different day. */
export function startedMinutes(t: Task, timeZone: string): number | null {
  if (!t.startedAt || isFlagged(t)) return null;
  const p = localParts(t.startedAt, timeZone);
  const m = (dayNumber(p.date) - dayNumber(t.date)) * 1440 + p.minutes;
  return m >= 0 && m < 1680 ? m : null; // within the planner day (04:00 the next morning = 1680)
}

/** How long the block really took: Start to tick, in minutes. Null unless both are trustworthy and in order. */
export function actualMinutes(t: Task, timeZone: string, bulk?: Set<string>): number | null {
  const done = completedMinutes(t, timeZone, bulk);
  const began = startedMinutes(t, timeZone);
  if (done === null || began === null) return null;
  const took = done - began;
  return took > 0 && took <= 720 ? took : null;
}

/** Minutes after its planned start that he pressed Start (negative = early). Null unless it has a planned start and a Start press. */
export function startDelayMinutes(t: Task, timeZone: string): number | null {
  const began = startedMinutes(t, timeZone);
  if (began === null || !t.start) return null;
  const [h, m] = t.start.split(':').map(Number);
  return began - (h * 60 + m);
}

export interface OutOfOrder {
  title: string;
  planned_position: number;
  done_position: number;
}

export interface DayTiming {
  /** From the trustworthy ticks only; null when there are none. */
  first_done: string | null;
  last_done: string | null;
  /** Average of late_min over the trustworthy ticks that have a start and a length; null if none do. */
  avg_late_min: number | null;
  max_late_min: number | null;
  /** Trustworthy done tasks whose place in the order he did them differs from the planned order. */
  out_of_order: OutOfOrder[];
  /** True when some ticks were a batch (3+ within 10 minutes). */
  ticked_in_bulk: boolean;
  /** Titles ticked in a batch. Left out of every figure above. */
  bulk_ticked: string[];
  /**
   * Work split into several blocks that he finished in one sitting (the later blocks have no Start press and were ticked
   * within minutes of the first). `actual_min` is how long the one block he started really took, against `planned_min` for all of them.
   * The unstarted blocks are left out of every figure above.
   */
  finished_together?: { blocks: string[]; planned_min: number | null; actual_min: number | null }[];
  /** Titles ticked after the day ended. Left out of every figure above. */
  backfilled: string[];
  /** Titles he flagged (forgot to start or finish them on time). Left out of every figure. */
  flagged: string[];
  /** Blocks where he pressed Start: how many, and the averages of what they show. Null when he pressed Start on none. */
  started_blocks: { n: number; avg_start_delay_min: number | null; avg_actual_min: number | null; avg_overrun_min: number | null } | null;
  /** Said once, in words, when anything was left out. */
  note?: string;
}

/**
 * `tasks` is one plan's tasks in planned order (the order the store lists them).
 * Returns null when nothing is done yet.
 */
export function dayTiming(tasks: Task[], timeZone: string): DayTiming | null {
  const done = tasks.filter((t) => t.done && t.completedAt);
  if (done.length === 0) return null;

  const flagged = done.filter((t) => isFlagged(t));
  const backfilled = done.filter((t) => !isFlagged(t) && isBackfilled(t, timeZone));
  const real = done.filter((t) => !isFlagged(t) && !isBackfilled(t, timeZone));
  const together = finishedTogether(real, timeZone);
  const bulkIds = bulkTickedIds(real, timeZone);
  const bulk = real.filter((t) => bulkIds.has(t.id) && !together.has(t.id));
  const groups = new Map<string, Task[]>();
  for (const [followerId, leader] of together) {
    const follower = real.find((t) => t.id === followerId)!;
    groups.set(leader.id, [...(groups.get(leader.id) ?? [leader]), follower]);
  }
  const finished_together = [...groups.values()].map((blocks) => ({
    blocks: blocks.map((t) => t.title),
    planned_min: blocks.every((t) => t.minutes) ? blocks.reduce((n, t) => n + t.minutes!, 0) : null,
    actual_min: actualMinutes(blocks[0], timeZone),
  }));
  const trusted = real.filter((t) => !bulkIds.has(t.id));

  const stamps = trusted.map((t) => new Date(t.completedAt!).getTime());
  const byDone = trusted.map((t, i) => ({ t, ms: stamps[i], planned: i })).sort((a, b) => a.ms - b.ms || a.planned - b.planned);

  const out_of_order = byDone
    .map((entry, doneIndex) => ({ entry, doneIndex }))
    .filter(({ entry, doneIndex }) => entry.planned !== doneIndex)
    .map(({ entry, doneIndex }) => ({
      title: entry.t.title,
      planned_position: entry.planned + 1,
      done_position: doneIndex + 1,
    }))
    .sort((a, b) => a.planned_position - b.planned_position);

  const slot = slotLateness(trusted, timeZone);
  const late = [...slot.values()];
  const reordered = trusted.some((t) => slot.has(t.id) && slot.get(t.id) !== lateMinutes(t, timeZone));
  const sorted = byDone.map((e) => e.ms);
  const clock = (ms: number) => hhmm(localParts(new Date(ms).toISOString(), timeZone).minutes);

  const avg = (xs: number[]) => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : null);
  const startedTasks = tasks.filter((t) => startedMinutes(t, timeZone) !== null);
  const delays = startedTasks.map((t) => startDelayMinutes(t, timeZone)).filter((n): n is number => n !== null);
  const took = trusted.map((t) => ({ t, m: actualMinutes(t, timeZone) })).filter((x): x is { t: Task; m: number } => x.m !== null);
  const overruns = took.filter((x) => x.t.minutes).map((x) => x.m - x.t.minutes!);

  const timing: DayTiming = {
    first_done: sorted.length ? clock(sorted[0]) : null,
    last_done: sorted.length ? clock(sorted[sorted.length - 1]) : null,
    avg_late_min: late.length ? Math.round(late.reduce((a, b) => a + b, 0) / late.length) : null,
    max_late_min: late.length ? Math.max(...late) : null,
    out_of_order,
    ticked_in_bulk: bulk.length > 0,
    bulk_ticked: bulk.map((t) => t.title),
    ...(finished_together.length ? { finished_together } : {}),
    backfilled: backfilled.map((t) => t.title),
    flagged: flagged.map((t) => t.title),
    started_blocks: startedTasks.length
      ? { n: startedTasks.length, avg_start_delay_min: avg(delays), avg_actual_min: avg(took.map((x) => x.m)), avg_overrun_min: avg(overruns) }
      : null,
  };
  const left = [
    bulk.length ? `${bulk.length} ticked in a batch (their times show when he ticked, not when he worked)` : '',
    together.size ? `${together.size} finished in one sitting with an earlier block of the same work (see finished_together)` : '',
    backfilled.length ? `${backfilled.length} ticked after the day ended` : '',
    flagged.length ? `${flagged.length} flagged by him (his times for them are unreliable)` : '',
  ].filter(Boolean);
  const notes = [
    left.length ? `Left out of the figures above: ${left.join('; ')}.` : '',
    reordered ? "Two neighbouring blocks he did in the other order are compared with each other's planned ends, so swapping them is not counted as lateness." : '',
  ].filter(Boolean);
  if (notes.length) timing.note = notes.join(' ');
  return timing;
}
