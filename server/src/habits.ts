// Facts about how he actually works, computed from his check-offs. These are numbers, not opinions:
// Claude reads them (get_habits) and writes its interpretation into the habit notes.
//
// Rules that keep the numbers honest:
//  - only finished days (before today) count, and only the plan he followed on each day
//  - backfilled ticks never feed a time measurement (their time isn't when the work happened)
//  - tasks he ticked in a batch (3+ within 10 minutes) never feed a time measurement; the rest of that day still counts
//  - a figure is reported only with enough samples; otherwise it is listed as insufficient

import { shiftDate } from './dates';
import { PLANS, type Plan, type Task } from './tasks';
import { bulkTickedIds, completedMinutes, isBackfilled, lateMinutes } from './timing';

export const DEFAULT_WINDOW_DAYS = 28;
export const MAX_WINDOW_DAYS = 90;

const MIN_TAG_SAMPLES = 3;
const MIN_POSITION_SAMPLES = 5;
const MIN_PROFILE_DAYS = 3;
const MIN_DAYS_FOR_CONFIDENCE = 5;
/** Within this many minutes after the planned end still counts as on time. */
const ON_TIME_SLACK_MIN = 10;

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
};
const mean = (xs: number[]): number => Math.round(xs.reduce((a, b) => a + b, 0) / xs.length);
const pct = (part: number, whole: number): number => Math.round((100 * part) / whole);

/** Minutes since local midnight of the planner day -> "HH:MM", with "(+1)" once it is past midnight. */
function clock(minutes: number): string {
  const wrapped = ((minutes % 1440) + 1440) % 1440;
  const hh = String(Math.floor(wrapped / 60)).padStart(2, '0');
  const mm = String(wrapped % 60).padStart(2, '0');
  return `${hh}:${mm}${minutes >= 1440 ? ' (+1)' : ''}`;
}

const startMinutes = (hhmm: string): number => {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
};

function isWeekend(date: string): boolean {
  const dow = new Date(`${date}T00:00:00Z`).getUTCDay();
  return dow === 0 || dow === 6;
}

/** He follows one plan a day: the one with more check-offs, A on a tie. */
function followedTasks(dayTasks: Task[]): Task[] {
  let best: Plan | null = null;
  let bestDone = -1;
  for (const p of PLANS) {
    const mine = dayTasks.filter((t) => t.plan === p);
    if (mine.length === 0) continue;
    const done = mine.filter((t) => t.done).length;
    if (done > bestDone) {
      best = p;
      bestDone = done;
    }
  }
  return best ? dayTasks.filter((t) => t.plan === best) : [];
}

function bucketOf(minutes: number): 'morning' | 'afternoon' | 'evening' | 'night' {
  const hour = Math.floor((((minutes % 1440) + 1440) % 1440) / 60);
  if (hour >= 4 && hour < 12) return 'morning';
  if (hour >= 12 && hour < 17) return 'afternoon';
  if (hour >= 17 && hour < 21) return 'evening';
  return 'night'; // 21:00 to 03:59
}

interface Lateness {
  n: number;
  median_late_min: number;
  avg_late_min: number;
  /** Share of blocks ticked within 10 minutes of their planned end (or earlier). */
  on_time_pct: number;
}

function latenessOf(values: number[]): Lateness {
  return {
    n: values.length,
    median_late_min: median(values),
    avg_late_min: mean(values),
    on_time_pct: pct(values.filter((v) => v <= ON_TIME_SLACK_MIN).length, values.length),
  };
}

interface TimeProfile {
  days: number;
  median_planned_first_start: string | null;
  median_first_done: string;
  median_last_done: string;
  /** Where his check-offs fall: how many, and what share, in each part of the day. */
  checkoffs_by_time_of_day: Record<'morning' | 'afternoon' | 'evening' | 'night', { n: number; pct: number }>;
}

interface Outcome {
  planned: number;
  done_on_day: number;
  carried_over: number;
  missed: number;
  done_on_day_pct: number;
}

function outcomeOf(tasks: Task[], timeZone: string): Outcome {
  const done = tasks.filter((t) => t.done);
  const carried = done.filter((t) => isBackfilled(t, timeZone)).length;
  const onDay = done.length - carried;
  return {
    planned: tasks.length,
    done_on_day: onDay,
    carried_over: carried,
    missed: tasks.length - done.length,
    done_on_day_pct: pct(onDay, tasks.length),
  };
}

export interface HabitStats {
  window: { from: string; through: string; days_with_tasks: number };
  confidence: 'low' | 'ok';
  note: string;
  lateness_by_tag: Record<string, Lateness>;
  lateness_overall: Lateness | null;
  /** Tags with too few samples to say anything about. */
  insufficient: { measure: string; key: string; n: number }[];
  best_times: { weekday: TimeProfile | null; weekend: TimeProfile | null };
  carry_over: {
    overall: Outcome | null;
    by_tag: Record<string, Outcome>;
    by_position: Record<string, Outcome>;
  };
  data_quality: { days_ticked_in_bulk: number; bulk_ticked_tasks: number; backfilled_tasks: number };
}

/**
 * `all` is every task in the window (any plan); `today` is the current planner day. Only days before
 * today are measured, because today's unfinished tasks aren't misses yet.
 */
export function computeHabits(all: Task[], timeZone: string, today: string, windowDays = DEFAULT_WINDOW_DAYS): HabitStats {
  const from = shiftDate(today, -windowDays);
  const through = shiftDate(today, -1);

  const byDate = new Map<string, Task[]>();
  for (const t of all) {
    if (t.date < from || t.date > through) continue;
    byDate.set(t.date, [...(byDate.get(t.date) ?? []), t]);
  }
  const days = [...byDate.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([date, dayTasks]) => ({ date, tasks: followedTasks(dayTasks) }))
    .filter((d) => d.tasks.length > 0)
    .map((d) => ({ ...d, bulkIds: bulkTickedIds(d.tasks, timeZone) }));

  const insufficient: HabitStats['insufficient'] = [];

  // --- lateness by subject (ticks that say nothing about when the work happened are skipped) ---
  const lateByTag = new Map<string, number[]>();
  const lateAll: number[] = [];
  for (const day of days) {
    for (const t of day.tasks) {
      const late = lateMinutes(t, timeZone, day.bulkIds);
      if (late === null) continue;
      lateByTag.set(t.tag, [...(lateByTag.get(t.tag) ?? []), late]);
      lateAll.push(late);
    }
  }
  const lateness_by_tag: Record<string, Lateness> = {};
  for (const [tag, values] of [...lateByTag.entries()].sort()) {
    if (values.length >= MIN_TAG_SAMPLES) lateness_by_tag[tag] = latenessOf(values);
    else insufficient.push({ measure: 'lateness', key: tag, n: values.length });
  }

  // --- best times of day: weekdays and weekends are different animals ---
  const profile = (weekend: boolean): TimeProfile | null => {
    const group = days.filter((d) => isWeekend(d.date) === weekend);
    const firsts: number[] = [];
    const lasts: number[] = [];
    const plannedStarts: number[] = [];
    const buckets = { morning: 0, afternoon: 0, evening: 0, night: 0 };
    let total = 0;
    for (const day of group) {
      const finished = day.tasks.map((t) => completedMinutes(t, timeZone, day.bulkIds)).filter((m): m is number => m !== null);
      if (finished.length === 0) continue;
      firsts.push(Math.min(...finished));
      lasts.push(Math.max(...finished));
      const starts = day.tasks.filter((t) => t.start).map((t) => startMinutes(t.start!));
      if (starts.length) plannedStarts.push(Math.min(...starts));
      for (const m of finished) {
        buckets[bucketOf(m)]++;
        total++;
      }
    }
    if (firsts.length < MIN_PROFILE_DAYS) {
      insufficient.push({ measure: `best_times_${weekend ? 'weekend' : 'weekday'}`, key: 'days', n: firsts.length });
      return null;
    }
    const share = (n: number) => ({ n, pct: pct(n, total) });
    return {
      days: firsts.length,
      median_planned_first_start: plannedStarts.length ? clock(median(plannedStarts)) : null,
      median_first_done: clock(median(firsts)),
      median_last_done: clock(median(lasts)),
      checkoffs_by_time_of_day: {
        morning: share(buckets.morning),
        afternoon: share(buckets.afternoon),
        evening: share(buckets.evening),
        night: share(buckets.night),
      },
    };
  };

  // --- carry-over and misses (done / not done doesn't depend on trusting the clock) ---
  const everyTask = days.flatMap((d) => d.tasks);
  const tagsSeen = [...new Set(everyTask.map((t) => t.tag))].sort();
  const by_tag: Record<string, Outcome> = {};
  for (const tag of tagsSeen) {
    const mine = everyTask.filter((t) => t.tag === tag);
    if (mine.length >= MIN_TAG_SAMPLES) by_tag[tag] = outcomeOf(mine, timeZone);
    else insufficient.push({ measure: 'carry_over', key: tag, n: mine.length });
  }
  const positioned: Record<'first' | 'middle' | 'last', Task[]> = { first: [], middle: [], last: [] };
  for (const day of days) {
    const timed = day.tasks.filter((t) => t.start);
    if (timed.length < 2) continue;
    timed.forEach((t, i) => positioned[i === 0 ? 'first' : i === timed.length - 1 ? 'last' : 'middle'].push(t));
  }
  const by_position: Record<string, Outcome> = {};
  for (const [position, tasks] of Object.entries(positioned)) {
    if (tasks.length >= MIN_POSITION_SAMPLES) by_position[position] = outcomeOf(tasks, timeZone);
    else if (tasks.length > 0) insufficient.push({ measure: 'carry_over_by_position', key: position, n: tasks.length });
  }

  const confidence = days.length >= MIN_DAYS_FOR_CONFIDENCE ? 'ok' : 'low';
  return {
    window: { from, through, days_with_tasks: days.length },
    confidence,
    note:
      confidence === 'low'
        ? `Only ${days.length} finished day(s) of data (need ${MIN_DAYS_FOR_CONFIDENCE}+): treat everything below as tentative and don't write habits from it yet.`
        : 'Finished days only, the plan he followed each day. Times exclude backfilled ticks and bulk-ticked days.',
    lateness_by_tag,
    lateness_overall: lateAll.length >= MIN_TAG_SAMPLES ? latenessOf(lateAll) : null,
    insufficient,
    best_times: { weekday: profile(false), weekend: profile(true) },
    carry_over: {
      overall: everyTask.length ? outcomeOf(everyTask, timeZone) : null,
      by_tag,
      by_position,
    },
    data_quality: {
      days_ticked_in_bulk: days.filter((d) => d.bulkIds.size > 0).length,
      bulk_ticked_tasks: days.reduce((n, d) => n + d.bulkIds.size, 0),
      backfilled_tasks: everyTask.filter((t) => isBackfilled(t, timeZone)).length,
    },
  };
}
