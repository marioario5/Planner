import { describe, expect, it } from 'vitest';
import { computeTransitions, type TransitionDay } from '../src/transitions';
import { bulkTickedIds } from '../src/timing';
import type { Task } from '../src/tasks';

const TZ = 'America/Los_Angeles';
let seq = 0;

interface Spec {
  title: string;
  tag: string;
  start: string; // planned
  minutes?: number;
  began?: string; // local HH:MM the Start press
  tick?: string; // local HH:MM the finish
  flagged?: boolean;
}
const task = (date: string, s: Spec): Task =>
  ({
    id: `t${++seq}`, date, plan: 'A', commitment: null, title: s.title, tag: s.tag, start: s.start, minutes: s.minutes ?? 30,
    notes: null, siteKey: null, done: s.tick !== undefined, doneAt: 0, position: 0, createdAt: `${date}T00:00:00Z`,
    completedAt: s.tick ? `${date}T${s.tick}:00-07:00` : null,
    startedAt: s.began ? `${date}T${s.began}:00-07:00` : null,
    flaggedAt: s.flagged ? `${date}T00:00:00Z` : null,
    pausedAt: null, pausedMs: 0,
  }) as unknown as Task;

const day = (date: string, specs: Spec[]): TransitionDay => {
  const tasks = specs.map((s) => task(date, s));
  return { date, tasks, bulkIds: bulkTickedIds(tasks, TZ) };
};

// three days: a school block, then (an hour or so later) Calc 3
const days = [
  day('2026-10-05', [
    { title: 'Homework', tag: 'school', start: '15:30', began: '15:30', tick: '16:00' },
    { title: 'Calc 3: 6.2 learn', tag: 'calculus3', start: '16:00', began: '17:00', tick: '18:00' },
    { title: 'Subwoofer', tag: 'pcb', start: '18:30', began: '18:35', tick: '19:30' },
  ]),
  day('2026-10-06', [
    { title: 'Homework', tag: 'school', start: '15:30', began: '15:40', tick: '16:10' },
    { title: 'Calc 3: 6.3 learn', tag: 'calculus3', start: '16:10', began: '17:20', tick: '18:20' },
  ]),
  day('2026-10-07', [
    { title: 'SAT set', tag: 'sat', start: '15:30', began: '15:30', tick: '16:15' },
    { title: 'Calc 3: 6.4 triple integrals', tag: 'calculus3', start: '16:15', began: '17:15', tick: '19:00' },
  ]),
];

describe('transitions: what he does between blocks', () => {
  const t = computeTransitions(days, TZ)!;

  it('measures the rest before and after each subject, from finish to the next Start press', () => {
    expect(t.before_tag.calculus3).toEqual({ n: 3, median_gap_min: 60, avg_gap_min: 63 }); // 60, 70, 60
    expect(t.overall).toMatchObject({ n: 4 }); // 60, 5, 70, 60
    // only two blocks came after school, which is too few to summarise
    expect(t.after_tag.school).toBeUndefined();
    expect(t.too_few).toContain('school');
  });

  it('finds which subject follows which, and when', () => {
    expect(t.pairs[0]).toEqual({ from: 'school', to: 'calculus3', n: 2, median_gap_min: 65 });
    expect(t.first_of_day).toEqual({ school: 2, sat: 1 });
    expect(t.last_of_day).toEqual({ pcb: 1, calculus3: 2 });
  });

  it('lists the latest transitions with titles, newest first, so the topic can be read', () => {
    expect(t.recent[0]).toEqual({ date: '2026-10-07', from: 'SAT set', to: 'Calc 3: 6.4 triple integrals', gap_min: 60 });
    expect(t.recent).toHaveLength(4);
  });

  it('counts days done in a different order than planned', () => {
    expect(t.reordered_days).toEqual({ days: 0, of: 3 });
    const swapped = day('2026-10-08', [
      { title: 'A', tag: 'school', start: '15:30', began: '16:30', tick: '17:00' },
      { title: 'B', tag: 'sat', start: '16:00', began: '15:35', tick: '16:20' },
    ]);
    expect(computeTransitions([...days, swapped], TZ)!.reordered_days).toEqual({ days: 1, of: 4 });
  });

  it('leaves out dinner and errands, flagged blocks, blocks without a Start press, and gaps over ten hours', () => {
    const noisy = day('2026-10-09', [
      { title: 'Work 1', tag: 'school', start: '10:00', began: '10:00', tick: '10:30' },
      { title: 'Dinner', tag: 'other', start: '10:30', began: '10:35', tick: '11:00' }, // not a work block
      { title: 'Work 2', tag: 'sat', start: '11:00', tick: '11:20' }, // no Start press: no gap to measure
      { title: 'Flagged', tag: 'pcb', start: '11:30', began: '11:40', tick: '12:00', flagged: true },
      { title: 'Late night', tag: 'calculus3', start: '22:00', began: '22:30', tick: '23:30' }, // 11 h after Work 2
    ]);
    const only = computeTransitions([noisy], TZ);
    expect(only).toBeNull(); // nothing usable: every pair is excluded
  });

  it('is null until there is something to measure', () => {
    expect(computeTransitions([], TZ)).toBeNull();
  });
});
