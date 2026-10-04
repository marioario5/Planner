import { describe, expect, it } from 'vitest';
import { computeHabits } from '../src/habits';
import type { Plan, Tag, Task } from '../src/tasks';

const TZ = 'America/Los_Angeles'; // PDT (UTC-7) for every date used here
const TODAY = '2026-10-20';

let seq = 0;
/** Local PDT wall-clock time on a date (+ dayOffset) as an ISO string. */
const iso = (date: string, hhmm: string, dayOffset = 0) => {
  const [y, mo, d] = date.split('-').map(Number);
  const [h, m] = hhmm.split(':').map(Number);
  return new Date(Date.UTC(y, mo - 1, d + dayOffset, h + 7, m)).toISOString();
};

interface Spec {
  date: string;
  tag?: Tag;
  plan?: Plan;
  start?: string | null;
  minutes?: number | null;
  /** Local time he ticked it on the same day; or [time, dayOffset] for a later day. */
  tick?: string | [string, number];
}

function task(s: Spec): Task {
  const tick = s.tick === undefined ? null : typeof s.tick === 'string' ? ([s.tick, 0] as [string, number]) : s.tick;
  return {
    id: `t${++seq}`,
    date: s.date,
    plan: s.plan ?? 'A',
    title: `task ${seq}`,
    tag: s.tag ?? 'school',
    start: s.start === undefined ? '15:30' : s.start,
    minutes: s.minutes === undefined ? 30 : s.minutes,
    notes: null,
    siteKey: null,
    done: tick !== null,
    doneAt: tick ? Date.parse(iso(s.date, tick[0], tick[1])) : null,
    position: 0,
    createdAt: iso(s.date, '12:00'),
    completedAt: tick ? iso(s.date, tick[0], tick[1]) : null,
  };
}

// Mon Oct 12 .. Fri Oct 16 2026; Sat Oct 10, Sun Oct 11, Sat Oct 17.
const WEEKDAYS = ['2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16'];

describe('lateness by subject', () => {
  it('reports median, average and on-time share per tag, with sample sizes', () => {
    const tasks = WEEKDAYS.flatMap((date) => [
      task({ date, tag: 'calculus3', start: '15:30', minutes: 25, tick: '16:05' }), // 10 min late
      task({ date, tag: 'sat', start: '16:30', minutes: 30, tick: '17:30' }), // 30 min late
    ]);
    const h = computeHabits(tasks, TZ, TODAY);
    expect(h.lateness_by_tag.calculus3).toEqual({ n: 5, median_late_min: 10, avg_late_min: 10, on_time_pct: 100 });
    expect(h.lateness_by_tag.sat).toEqual({ n: 5, median_late_min: 30, avg_late_min: 30, on_time_pct: 0 });
    expect(h.lateness_overall).toMatchObject({ n: 10, median_late_min: 20, avg_late_min: 20, on_time_pct: 50 });
  });

  it('refuses to report a tag with too few samples', () => {
    const tasks = [
      ...WEEKDAYS.map((date) => task({ date, tag: 'sat', tick: '16:30' })),
      task({ date: WEEKDAYS[0], tag: 'pcb', tick: '17:00' }),
      task({ date: WEEKDAYS[1], tag: 'pcb', tick: '17:00' }),
    ];
    const h = computeHabits(tasks, TZ, TODAY);
    expect(h.lateness_by_tag.pcb).toBeUndefined();
    expect(h.insufficient).toContainEqual({ measure: 'lateness', key: 'pcb', n: 2 });
  });

  it('ignores untimed tasks and tasks with no length', () => {
    const tasks = WEEKDAYS.flatMap((date) => [
      task({ date, tag: 'sat', tick: '17:00' }),
      task({ date, tag: 'school', start: null, tick: '18:00' }),
      task({ date, tag: 'pcb', minutes: null, tick: '19:00' }),
    ]);
    const h = computeHabits(tasks, TZ, TODAY);
    expect(Object.keys(h.lateness_by_tag)).toEqual(['sat']);
  });
});

describe('what it leaves out', () => {
  it('keeps bulk-ticked days out of every time measure but still counts done / missed', () => {
    const tasks = [
      ...WEEKDAYS.map((date) => task({ date, tag: 'sat', start: '15:30', minutes: 30, tick: '16:00' })), // on time
      // Oct 19: three ticks within 5 minutes at 23:00, wildly "late" (and one missed task)
      task({ date: '2026-10-19', tag: 'sat', start: '15:30', minutes: 30, tick: '23:00' }),
      task({ date: '2026-10-19', tag: 'sat', start: '16:00', minutes: 30, tick: '23:02' }),
      task({ date: '2026-10-19', tag: 'sat', start: '16:30', minutes: 30, tick: '23:04' }),
      task({ date: '2026-10-19', tag: 'sat', start: '17:00', minutes: 30 }),
    ];
    const h = computeHabits(tasks, TZ, TODAY);
    expect(h.lateness_by_tag.sat).toMatchObject({ n: 5, median_late_min: 0 }); // the bulk day isn't in it
    expect(h.data_quality.days_ticked_in_bulk).toBe(1);
    expect(h.carry_over.by_tag.sat).toMatchObject({ planned: 9, done_on_day: 8, missed: 1 }); // but it is counted here
  });

  it('counts a later-day tick as carried over, not as lateness or a time of day', () => {
    const tasks = WEEKDAYS.flatMap((date) => [
      task({ date, tag: 'sat', start: '15:30', minutes: 30, tick: '16:00' }),
      task({ date, tag: 'pcb', start: '17:00', minutes: 30, tick: ['10:00', 1] }), // ticked next morning
    ]);
    const h = computeHabits(tasks, TZ, TODAY);
    expect(h.lateness_by_tag.pcb).toBeUndefined();
    expect(h.carry_over.by_tag.pcb).toMatchObject({ planned: 5, done_on_day: 0, carried_over: 5, missed: 0, done_on_day_pct: 0 });
    expect(h.data_quality.backfilled_tasks).toBe(5);
  });

  it('measures only finished days, inside the window, on the plan he followed', () => {
    const tasks = [
      ...WEEKDAYS.map((date) => task({ date, tag: 'sat', tick: '16:00' })),
      task({ date: TODAY, tag: 'pcb', tick: '16:00' }), // today: not finished yet
      task({ date: '2026-10-21', tag: 'pcb' }), // future
      task({ date: '2026-08-01', tag: 'pcb', tick: '16:00' }), // older than 28 days
      // Oct 19: plan A untouched, plan B done -> only B is measured
      task({ date: '2026-10-19', tag: 'photography', plan: 'A' }),
      task({ date: '2026-10-19', tag: 'calculus3', plan: 'B', tick: '16:00' }),
      task({ date: '2026-10-19', tag: 'calculus3', plan: 'B', tick: '16:30' }),
    ];
    const h = computeHabits(tasks, TZ, TODAY);
    expect(h.window).toEqual({ from: '2026-09-22', through: '2026-10-19', days_with_tasks: 6 });
    expect(h.carry_over.by_tag.pcb).toBeUndefined();
    expect(h.carry_over.by_tag.photography).toBeUndefined();
    expect(h.carry_over.by_tag.calculus3).toBeUndefined(); // only 2 samples
    expect(h.carry_over.overall).toMatchObject({ planned: 7, done_on_day: 7 });
  });
});

describe('carry-over and misses', () => {
  it('shows what is missed by subject and by where the block sits in the day', () => {
    // 5 days x [first 15:30 SAT done, middle 16:30 school done, last 17:30 pcb never done]
    const tasks = WEEKDAYS.flatMap((date) => [
      task({ date, tag: 'sat', start: '15:30', tick: '16:00' }),
      task({ date, tag: 'school', start: '16:30', tick: '17:00' }),
      task({ date, tag: 'pcb', start: '17:30' }),
    ]);
    const h = computeHabits(tasks, TZ, TODAY);
    expect(h.carry_over.by_tag.pcb).toEqual({ planned: 5, done_on_day: 0, carried_over: 0, missed: 5, done_on_day_pct: 0 });
    expect(h.carry_over.by_tag.sat.done_on_day_pct).toBe(100);
    expect(h.carry_over.by_position.first.done_on_day_pct).toBe(100);
    expect(h.carry_over.by_position.middle.done_on_day_pct).toBe(100);
    expect(h.carry_over.by_position.last).toMatchObject({ planned: 5, missed: 5, done_on_day_pct: 0 });
  });

  it('says nothing about a position with fewer than 5 samples', () => {
    const tasks = WEEKDAYS.slice(0, 3).flatMap((date) => [
      task({ date, start: '15:30', tick: '16:00' }),
      task({ date, start: '16:30', tick: '17:00' }),
    ]);
    const h = computeHabits(tasks, TZ, TODAY);
    expect(h.carry_over.by_position).toEqual({});
    expect(h.insufficient).toContainEqual({ measure: 'carry_over_by_position', key: 'first', n: 3 });
  });
});

describe('best times of day', () => {
  it('profiles weekdays and weekends separately, including work past midnight', () => {
    const weekday = WEEKDAYS.flatMap((date) => [
      task({ date, tag: 'sat', start: '15:30', tick: '16:05' }),
      task({ date, tag: 'school', start: '19:00', tick: '21:30' }),
      task({ date, tag: 'pcb', start: '20:00', tick: ['00:30', 1] }),
    ]);
    const weekend = ['2026-10-10', '2026-10-11', '2026-10-17'].map((date) =>
      task({ date, tag: 'sat', start: '10:00', minutes: 60, tick: '11:20' }),
    );
    const h = computeHabits([...weekday, ...weekend], TZ, TODAY);

    expect(h.best_times.weekday).toMatchObject({
      days: 5,
      median_planned_first_start: '15:30',
      median_first_done: '16:05',
      median_last_done: '00:30 (+1)',
    });
    expect(h.best_times.weekday!.checkoffs_by_time_of_day).toEqual({
      morning: { n: 0, pct: 0 },
      afternoon: { n: 5, pct: 33 }, // 16:05
      evening: { n: 0, pct: 0 },
      night: { n: 10, pct: 67 }, // 21:30 and 00:30 (+1)
    });
    expect(h.best_times.weekend).toMatchObject({ days: 3, median_first_done: '11:20', median_last_done: '11:20' });
    expect(h.best_times.weekend!.checkoffs_by_time_of_day.morning).toEqual({ n: 3, pct: 100 });
  });

  it('withholds a profile with fewer than 3 days', () => {
    const tasks = WEEKDAYS.slice(0, 2).map((date) => task({ date, tick: '16:00' }));
    const h = computeHabits(tasks, TZ, TODAY);
    expect(h.best_times.weekday).toBeNull();
    expect(h.insufficient).toContainEqual({ measure: 'best_times_weekday', key: 'days', n: 2 });
  });
});

describe('confidence', () => {
  it('is low until there are 5 finished days, and says so', () => {
    const few = computeHabits(WEEKDAYS.slice(0, 3).map((date) => task({ date, tick: '16:00' })), TZ, TODAY);
    expect(few.confidence).toBe('low');
    expect(few.note).toContain('tentative');
    const enough = computeHabits(WEEKDAYS.map((date) => task({ date, tick: '16:00' })), TZ, TODAY);
    expect(enough.confidence).toBe('ok');
  });

  it('returns an empty, honest result when there is no data', () => {
    const h = computeHabits([], TZ, TODAY);
    expect(h).toMatchObject({
      confidence: 'low',
      lateness_by_tag: {},
      lateness_overall: null,
      best_times: { weekday: null, weekend: null },
      carry_over: { overall: null, by_tag: {}, by_position: {} },
    });
    expect(h.window.days_with_tasks).toBe(0);
  });
});
