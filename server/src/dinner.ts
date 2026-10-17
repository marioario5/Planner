// When he actually eats dinner, from the blocks titled "dinner" in recent days, so the planner can predict a dinner time
// (overall, and by weekday once there are enough days) instead of using a fixed one.
//
// A day's dinner time is when he pressed Start on it; with no Start press, when he ticked it minus its planned length.
// Flagged, backfilled and batch-ticked blocks are left out like everywhere else.

import { completedMinutes, startedMinutes } from './timing';
import type { Task } from './tasks';

const MIN_PER_WEEKDAY = 3; // days of one weekday needed before it gets its own figure
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export interface DinnerDay {
  date: string;
  tasks: Task[];
  bulkIds: Set<string>;
}

export interface DinnerStat {
  n: number;
  median_start: string;
  earliest: string;
  latest: string;
}

export interface DinnerHabits {
  note: string;
  overall: DinnerStat | null;
  /** Only weekdays with enough days of data; the others are in `too_few_weekdays`. */
  by_weekday: Record<string, DinnerStat>;
  too_few_weekdays: Record<string, number>;
  /** Newest first. `basis` says whether the time is his Start press or the tick minus the planned length. */
  recent: { date: string; weekday: string; start: string; planned: string | null; basis: 'start' | 'tick' }[];
}

const clock = (m: number): string => `${String(Math.floor((m % 1440) / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
};
const stat = (xs: number[]): DinnerStat => ({
  n: xs.length,
  median_start: clock(median(xs)),
  earliest: clock(Math.min(...xs)),
  latest: clock(Math.max(...xs)),
});

/** Null when no day has a usable dinner time yet. */
export function computeDinner(days: DinnerDay[], timeZone: string): DinnerHabits | null {
  const all: number[] = [];
  const byDow = new Map<string, number[]>();
  const recent: DinnerHabits['recent'] = [];

  for (const day of [...days].sort((a, b) => (a.date < b.date ? 1 : -1))) {
    const dinner = day.tasks.find((t) => /\bdinner\b/i.test(t.title) && t.plan === 'A') ?? day.tasks.find((t) => /\bdinner\b/i.test(t.title));
    if (!dinner) continue;
    let minutes = startedMinutes(dinner, timeZone);
    let basis: 'start' | 'tick' = 'start';
    if (minutes === null) {
      const ticked = completedMinutes(dinner, timeZone, day.bulkIds);
      if (ticked === null || dinner.minutes === null) continue;
      minutes = ticked - dinner.minutes;
      basis = 'tick';
    }
    if (minutes < 0 || minutes >= 1680) continue;
    const weekday = WEEKDAYS[new Date(`${day.date}T00:00:00Z`).getUTCDay()];
    all.push(minutes);
    byDow.set(weekday, [...(byDow.get(weekday) ?? []), minutes]);
    if (recent.length < 14) recent.push({ date: day.date, weekday, start: clock(minutes), planned: dinner.start, basis });
  }
  if (all.length === 0) return null;

  const by_weekday: Record<string, DinnerStat> = {};
  const too_few: Record<string, number> = {};
  for (const [d, xs] of byDow) {
    if (xs.length >= MIN_PER_WEEKDAY) by_weekday[d] = stat(xs);
    else too_few[d] = xs.length;
  }
  return {
    note:
      `Dinner start times from the days he did dinner, in the planner time zone. A weekday figure needs ${MIN_PER_WEEKDAY}+ days of that weekday; ` +
      'use it only if it differs from `overall` in a way that repeats, otherwise predict from `overall`. A gym session or a late finish that day can push it later.',
    overall: stat(all),
    by_weekday,
    too_few_weekdays: too_few,
    recent,
  };
}
