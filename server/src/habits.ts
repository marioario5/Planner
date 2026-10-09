// Facts about how he actually works, computed from his check-offs. These are numbers, not opinions:
// Claude reads them (get_habits) and writes its interpretation into the habit notes.
//
// Rules that keep the numbers honest:
//  - only finished days (before today) count, and only the plan he followed on each day
//  - backfilled ticks never feed a time measurement (their time isn't when the work happened)
//  - tasks he ticked in a batch (3+ within 10 minutes) never feed a time measurement; the rest of that day still counts
//  - tasks he flagged (forgot to start or finish on time) never feed a time measurement either
//  - real durations only come from blocks where he pressed Start; everything else is a tick time, not a duration
//  - a figure is reported only with enough samples; otherwise it is listed as insufficient

import { shiftDate } from './dates';
import { PLANS, type Experiment, type Plan, type Tag, type Task } from './tasks';
import {
  actualMinutes,
  bulkTickedIds,
  completedMinutes,
  isBackfilled,
  isFlagged,
  lateMinutes,
  startDelayMinutes,
} from './timing';

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
const percentile = (xs: number[], p: number): number => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.max(0, Math.ceil(p * s.length) - 1)];
};

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
  /** Real durations, from blocks where he pressed Start (a tick alone says nothing about how long it took). */
  duration_by_tag: Record<string, Duration>;
  /** How long after the planned start he pressed Start; null until there are enough Start presses. */
  start_delay: { n: number; median_min: number; avg_min: number } | null;
  /** What a day of his can actually hold: the honest budget to plan against. Work blocks only (not dinner or wrap-up). */
  capacity: { weekday: Capacity | null; weekend: Capacity | null };
  /** How heavy the last 7 days were, with the plain-language reasons. Use it to keep a week from getting too heavy. */
  week_load: WeekLoad;
  /** How draining his days felt (1 drained and wrecked, 5 good with energy left): strain and energy, not grades or mood. */
  ratings: { scale: string; n: number; avg: number; recent: { date: string; rating: number }[] } | null;
  data_quality: {
    days_ticked_in_bulk: number;
    bulk_ticked_tasks: number;
    backfilled_tasks: number;
    flagged_tasks: number;
    tasks_with_start_press: number;
  };
}

interface Duration {
  n: number;
  median_planned_min: number;
  median_actual_min: number;
  /** actual / planned: 1.4 means blocks take 40% longer than planned. */
  median_ratio: number;
}

export interface WeekLoad {
  /** Finished days with a plan among the last 7. */
  days: number;
  /** Work minutes (not dinner or wrap-up) asked of him per day, and actually finished per day. */
  planned_minutes_per_day: number;
  done_minutes_per_day: number;
  /** The usual finished work minutes on a day over the whole window, the yardstick for the figures below. */
  typical_done_minutes: number | null;
  days_above_typical: number;
  /** Days whose last trustworthy check-off was at or after 23:00: a sleep cost. */
  late_finish_days: number;
  /** Share of the week's work blocks not finished on their own day. */
  missed_or_carried_pct: number;
  level: 'unknown' | 'normal' | 'elevated' | 'heavy';
  /** Why the level is what it is, each with its numbers. Empty when normal. */
  reasons: string[];
  note: string;
}

// A week counts as heavier when these hold; two reasons = heavy, one = elevated.
export const RATING_SCALE = '1 = drained and wrecked, 5 = good with energy left (strain and energy, not grades or mood)';
const WEEK_DAYS = 7;
const WEEK_MIN_DAYS = 4;
const SUSTAINED_DAYS = 5; // worked more than his typical amount on this many days
const LATE_FINISH_MINUTES = 23 * 60;
const LATE_FINISH_DAYS = 3;
const OVERASKED_RATIO = 1.5; // planned per day vs typical finished per day...
const OVERASKED_MISSED_PCT = 30; // ...while at least this much was not finished on its day

interface Capacity {
  days: number;
  median_planned_blocks: number;
  median_done_blocks: number;
  median_planned_minutes: number;
  /** Minutes of the blocks he finished on their own day: the typical day's real load. */
  median_done_minutes: number;
  /** A good day (75th percentile): the ceiling to plan as "if time allows", never as the base. */
  good_day_done_minutes: number;
  done_on_day_pct: number;
}

/**
 * `all` is every task in the window (any plan); `today` is the current planner day. Only days before
 * today are measured, because today's unfinished tasks aren't misses yet.
 */
interface FinishedDay {
  date: string;
  tasks: Task[];
  bulkIds: Set<string>;
}

/** Finished days from..through, each reduced to the plan he followed. */
export function finishedDays(all: Task[], timeZone: string, from: string, through: string): FinishedDay[] {
  const byDate = new Map<string, Task[]>();
  for (const t of all) {
    if (t.date < from || t.date > through) continue;
    byDate.set(t.date, [...(byDate.get(t.date) ?? []), t]);
  }
  return [...byDate.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([date, dayTasks]) => ({ date, tasks: followedTasks(dayTasks) }))
    .filter((d) => d.tasks.length > 0)
    .map((d) => ({ ...d, bulkIds: bulkTickedIds(d.tasks, timeZone) }));
}

/** Work blocks: everything except dinner, errands and the nightly wrap-up. */
const isWork = (t: Task) => t.tag !== 'other';

export function computeHabits(
  all: Task[],
  timeZone: string,
  today: string,
  windowDays = DEFAULT_WINDOW_DAYS,
  ratings: Map<string, number> = new Map(),
): HabitStats {
  const from = shiftDate(today, -windowDays);
  const through = shiftDate(today, -1);
  const days = finishedDays(all, timeZone, from, through);

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

  // --- real durations (only blocks where he pressed Start) ---
  const duration_by_tag: Record<string, Duration> = {};
  const startedRows = days.flatMap((d) =>
    d.tasks.map((t) => ({ t, actual: actualMinutes(t, timeZone, d.bulkIds) })).filter((x) => x.actual !== null && x.t.minutes),
  ) as { t: Task; actual: number }[];
  for (const tag of [...new Set(startedRows.map((x) => x.t.tag))].sort()) {
    const mine = startedRows.filter((x) => x.t.tag === tag);
    if (mine.length < MIN_TAG_SAMPLES) {
      insufficient.push({ measure: 'duration', key: tag, n: mine.length });
      continue;
    }
    const planned = median(mine.map((x) => x.t.minutes!));
    const actual = median(mine.map((x) => x.actual));
    duration_by_tag[tag] = {
      n: mine.length,
      median_planned_min: planned,
      median_actual_min: actual,
      median_ratio: Math.round(100 * median(mine.map((x) => x.actual / x.t.minutes!))) / 100,
    };
  }
  const delays = days.flatMap((d) => d.tasks.map((t) => startDelayMinutes(t, timeZone)).filter((n): n is number => n !== null));
  if (delays.length > 0 && delays.length < MIN_TAG_SAMPLES) insufficient.push({ measure: 'start_delay', key: 'all', n: delays.length });
  const start_delay =
    delays.length >= MIN_TAG_SAMPLES ? { n: delays.length, median_min: median(delays), avg_min: mean(delays) } : null;

  // --- capacity: what a day can actually hold ---
  const capacityOf = (weekend: boolean): Capacity | null => {
    const group = days.filter((d) => isWeekend(d.date) === weekend);
    const rows = group
      .map((d) => {
        const work = d.tasks.filter(isWork);
        const doneOnDay = work.filter((t) => t.done && !isBackfilled(t, timeZone));
        return {
          planned: work.length,
          done: doneOnDay.length,
          plannedMin: work.reduce((n, t) => n + (t.minutes ?? 0), 0),
          doneMin: doneOnDay.reduce((n, t) => n + (t.minutes ?? 0), 0),
        };
      })
      .filter((r) => r.planned > 0);
    if (rows.length < MIN_PROFILE_DAYS) {
      insufficient.push({ measure: `capacity_${weekend ? 'weekend' : 'weekday'}`, key: 'days', n: rows.length });
      return null;
    }
    return {
      days: rows.length,
      median_planned_blocks: median(rows.map((r) => r.planned)),
      median_done_blocks: median(rows.map((r) => r.done)),
      median_planned_minutes: median(rows.map((r) => r.plannedMin)),
      median_done_minutes: median(rows.map((r) => r.doneMin)),
      good_day_done_minutes: percentile(rows.map((r) => r.doneMin), 0.75),
      done_on_day_pct: pct(
        rows.reduce((n, r) => n + r.done, 0),
        rows.reduce((n, r) => n + r.planned, 0),
      ),
    };
  };

  // --- how heavy the last week was ---
  const doneWorkMinutes = (d: FinishedDay) =>
    d.tasks.filter((t) => isWork(t) && t.done && !isBackfilled(t, timeZone)).reduce((n, t) => n + (t.minutes ?? 0), 0);
  const typicalDone = days.length ? median(days.map(doneWorkMinutes)) : null;
  const weekDays = days.filter((d) => d.date >= shiftDate(today, -WEEK_DAYS) && d.tasks.some(isWork));
  const weekLoad = ((): WeekLoad => {
    const work = weekDays.flatMap((d) => d.tasks.filter(isWork));
    const base = {
      days: weekDays.length,
      planned_minutes_per_day: 0,
      done_minutes_per_day: 0,
      typical_done_minutes: typicalDone,
      days_above_typical: 0,
      late_finish_days: 0,
      missed_or_carried_pct: 0,
    };
    if (weekDays.length < WEEK_MIN_DAYS || typicalDone === null) {
      return {
        ...base,
        level: 'unknown',
        reasons: [],
        note: `Only ${weekDays.length} finished day(s) in the last ${WEEK_DAYS} (need ${WEEK_MIN_DAYS}+): can't tell how heavy the week was.`,
      };
    }
    const plannedPerDay = Math.round(work.reduce((n, t) => n + (t.minutes ?? 0), 0) / weekDays.length);
    const donePerDay = Math.round(weekDays.reduce((n, d) => n + doneWorkMinutes(d), 0) / weekDays.length);
    const above = weekDays.filter((d) => doneWorkMinutes(d) > typicalDone).length;
    const lateDays = weekDays.filter((d) => {
      const finished = d.tasks.map((t) => completedMinutes(t, timeZone, d.bulkIds)).filter((m): m is number => m !== null);
      return finished.length > 0 && Math.max(...finished) >= LATE_FINISH_MINUTES;
    }).length;
    const notDone = work.filter((t) => !t.done || isBackfilled(t, timeZone)).length;
    const missedPct = work.length ? pct(notDone, work.length) : 0;

    const reasons: string[] = [];
    if (above >= SUSTAINED_DAYS) {
      reasons.push(`worked more than his typical ${typicalDone} min on ${above} of ${weekDays.length} days`);
    }
    if (lateDays >= LATE_FINISH_DAYS) {
      reasons.push(`last check-off at or after 23:00 on ${lateDays} of ${weekDays.length} days (sleep cost)`);
    }
    if (typicalDone > 0 && plannedPerDay >= OVERASKED_RATIO * typicalDone && missedPct >= OVERASKED_MISSED_PCT) {
      reasons.push(`asked for ~${plannedPerDay} min a day but finishes ~${donePerDay}; ${missedPct}% of blocks missed or carried over`);
    }
    const level = reasons.length >= 2 ? 'heavy' : reasons.length === 1 ? 'elevated' : 'normal';
    return {
      days: weekDays.length,
      planned_minutes_per_day: plannedPerDay,
      done_minutes_per_day: donePerDay,
      typical_done_minutes: typicalDone,
      days_above_typical: above,
      late_finish_days: lateDays,
      missed_or_carried_pct: missedPct,
      level,
      reasons,
      note:
        level === 'normal'
          ? 'The last week looks sustainable.'
          : 'A heavy or elevated week is a reason to lighten days that have no required work (see the rules); it never cuts required work.',
    };
  })();

  // --- how the days felt ---
  const rated = [...ratings.entries()].filter(([date]) => date >= from && date <= through).sort(([a], [b]) => (a < b ? -1 : 1));
  const ratingStats = rated.length
    ? {
        scale: RATING_SCALE,
        n: rated.length,
        avg: Math.round((10 * rated.reduce((n, [, r]) => n + r, 0)) / rated.length) / 10,
        recent: rated.slice(-7).map(([date, rating]) => ({ date, rating })),
      }
    : null;

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
    duration_by_tag,
    start_delay,
    capacity: { weekday: capacityOf(false), weekend: capacityOf(true) },
    week_load: weekLoad,
    ratings: ratingStats,
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
      flagged_tasks: everyTask.filter(isFlagged).length,
      tasks_with_start_press: everyTask.filter((t) => t.startedAt !== null).length,
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Experiments: one deliberate change at a time, compared before and after.

const BEFORE_DAYS = 14;
const MIN_EXPERIMENT_DAYS = 3;

interface Side {
  days: number;
  done_on_day_pct: number | null;
  median_late_min: number | null;
  blocks_done_per_day: number | null;
  avg_rating: number | null;
}

export interface ExperimentView {
  id: string;
  title: string;
  change: string;
  measure: Experiment['measure'];
  tag: Tag | null;
  started_on: string;
  status: Experiment['status'];
  result: string | null;
  /** Finished days since it started (running ones only). */
  days_since_start?: number;
  before?: Side;
  after?: Side;
  /** The one number this experiment was meant to move, before vs after. */
  focus?: { metric: string; before: number | null; after: number | null };
  note?: string;
}

function sideOf(days: FinishedDay[], tag: Tag | null, timeZone: string, ratings: Map<string, number>): Side {
  const rows = days
    .map((d) => ({ d, tasks: d.tasks.filter((t) => (tag ? t.tag === tag : isWork(t))) }))
    .filter((r) => r.tasks.length > 0);
  const tasks = rows.flatMap((r) => r.tasks);
  const late = rows.flatMap((r) => r.tasks.map((t) => lateMinutes(t, timeZone, r.d.bulkIds)).filter((n): n is number => n !== null));
  const rates = rows.map((r) => ratings.get(r.d.date)).filter((n): n is number => n !== undefined);
  const doneOnDay = tasks.filter((t) => t.done && !isBackfilled(t, timeZone)).length;
  return {
    days: rows.length,
    done_on_day_pct: tasks.length ? pct(doneOnDay, tasks.length) : null,
    median_late_min: late.length >= MIN_TAG_SAMPLES ? median(late) : null,
    blocks_done_per_day: rows.length ? Math.round((10 * doneOnDay) / rows.length) / 10 : null,
    avg_rating: rates.length ? Math.round((10 * rates.reduce((a, b) => a + b, 0)) / rates.length) / 10 : null,
  };
}

/** `all` must reach back far enough to cover the 14 days before the earliest running experiment. */
export function evaluateExperiments(
  all: Task[],
  ratings: Map<string, number>,
  experiments: Experiment[],
  timeZone: string,
  today: string,
): ExperimentView[] {
  const through = shiftDate(today, -1);
  return experiments.map((e) => {
    const base: ExperimentView = {
      id: e.id,
      title: e.title,
      change: e.change,
      measure: e.measure,
      tag: e.tag,
      started_on: e.startedOn,
      status: e.status,
      result: e.result,
    };
    if (e.status !== 'running') return base;

    const before = sideOf(finishedDays(all, timeZone, shiftDate(e.startedOn, -BEFORE_DAYS), shiftDate(e.startedOn, -1)), e.tag, timeZone, ratings);
    const after = sideOf(finishedDays(all, timeZone, e.startedOn, through), e.tag, timeZone, ratings);
    const key = { done_pct: 'done_on_day_pct', lateness: 'median_late_min', blocks_done: 'blocks_done_per_day', rating: 'avg_rating' } as const;
    const metric = key[e.measure];
    const ready = before.days >= MIN_EXPERIMENT_DAYS && after.days >= MIN_EXPERIMENT_DAYS;
    return {
      ...base,
      days_since_start: after.days,
      before,
      after,
      focus: { metric, before: before[metric], after: after[metric] },
      note: ready
        ? 'Enough days on both sides to compare. Still a handful of days, so call it a lean, not a proof; change one thing at a time.'
        : `Too early to judge: need ${MIN_EXPERIMENT_DAYS}+ finished days on each side (have ${before.days} before, ${after.days} after).`,
    };
  });
}
