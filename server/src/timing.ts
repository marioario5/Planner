// What the check-off times say about how the day went: late or early, out of order,
// ticked all at once. Pure functions over a plan's tasks so the MCP tools can report them.
//
// A tick made after the planner day has ended (04:00 the next morning) is a *backfill*: he is
// recording something he did earlier, so its time says nothing about when the work happened.
// Backfilled ticks are flagged and kept out of every statistic here.

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

/**
 * Minutes after its planned end that the task was checked off (negative = early).
 * null unless the task is done, has both a start and a length, and wasn't backfilled.
 */
export function lateMinutes(t: Task, timeZone: string): number | null {
  if (!t.done || !t.completedAt || !t.start || !t.minutes || isBackfilled(t, timeZone)) return null;
  const p = localParts(t.completedAt, timeZone);
  const [h, m] = t.start.split(':').map(Number);
  const plannedEnd = h * 60 + m + t.minutes;
  const completed = (dayNumber(p.date) - dayNumber(t.date)) * 1440 + p.minutes;
  return completed - plannedEnd;
}

export interface OutOfOrder {
  title: string;
  planned_position: number;
  done_position: number;
}

export interface DayTiming {
  /** null when every done task was backfilled. */
  first_done: string | null;
  last_done: string | null;
  /** Average of late_min over the tasks that have a start and a length; null if none do. */
  avg_late_min: number | null;
  max_late_min: number | null;
  /** Done tasks whose place in the order he did them differs from the planned order. */
  out_of_order: OutOfOrder[];
  /** 3+ check-offs within 10 minutes: the times then say when he ticked, not when he worked. */
  ticked_in_bulk: boolean;
  /** Titles ticked after the day ended. Left out of everything above. */
  backfilled: string[];
}

const BULK_WINDOW_MIN = 10;

/**
 * `tasks` is one plan's tasks in planned order (the order the store lists them).
 * Returns null when nothing is done yet.
 */
export function dayTiming(tasks: Task[], timeZone: string): DayTiming | null {
  const done = tasks.filter((t) => t.done && t.completedAt);
  if (done.length === 0) return null;

  const backfilled = done.filter((t) => isBackfilled(t, timeZone)).map((t) => t.title);
  const real = done.filter((t) => !isBackfilled(t, timeZone));

  const stamps = real.map((t) => new Date(t.completedAt!).getTime());
  const byDone = real.map((t, i) => ({ t, ms: stamps[i], planned: i })).sort((a, b) => a.ms - b.ms || a.planned - b.planned);

  const out_of_order = byDone
    .map((entry, doneIndex) => ({ entry, doneIndex }))
    .filter(({ entry, doneIndex }) => entry.planned !== doneIndex)
    .map(({ entry, doneIndex }) => ({
      title: entry.t.title,
      planned_position: entry.planned + 1,
      done_position: doneIndex + 1,
    }))
    .sort((a, b) => a.planned_position - b.planned_position);

  const late = real.map((t) => lateMinutes(t, timeZone)).filter((n): n is number => n !== null);
  const sorted = byDone.map((e) => e.ms);
  const window = BULK_WINDOW_MIN * 60_000;
  const bulk = sorted.some((ms, i) => i + 2 < sorted.length && sorted[i + 2] - ms <= window);
  const clock = (ms: number) => hhmm(localParts(new Date(ms).toISOString(), timeZone).minutes);

  return {
    first_done: sorted.length ? clock(sorted[0]) : null,
    last_done: sorted.length ? clock(sorted[sorted.length - 1]) : null,
    avg_late_min: late.length ? Math.round(late.reduce((a, b) => a + b, 0) / late.length) : null,
    max_late_min: late.length ? Math.max(...late) : null,
    out_of_order,
    ticked_in_bulk: bulk,
    backfilled,
  };
}
