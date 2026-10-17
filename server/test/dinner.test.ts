import { describe, expect, it } from 'vitest';
import { computeDinner, type DinnerDay } from '../src/dinner';
import { bulkTickedIds } from '../src/timing';
import type { Task } from '../src/tasks';

const TZ = 'America/Los_Angeles';
let seq = 0;
const dinner = (date: string, o: { began?: string; tick?: string; planned?: string; flagged?: boolean; title?: string }): Task =>
  ({
    id: `d${++seq}`, date, plan: 'A', commitment: null, title: o.title ?? 'Dinner', tag: 'other', start: o.planned ?? '19:30', minutes: 30,
    notes: null, siteKey: null, done: o.tick !== undefined, doneAt: 0, position: 0, createdAt: `${date}T00:00:00Z`,
    completedAt: o.tick ? `${date}T${o.tick}:00-07:00` : null,
    startedAt: o.began ? `${date}T${o.began}:00-07:00` : null,
    flaggedAt: o.flagged ? `${date}T00:00:00Z` : null,
    pausedAt: null, pausedMs: 0,
  }) as unknown as Task;
const day = (date: string, ...tasks: Task[]): DinnerDay => ({ date, tasks, bulkIds: bulkTickedIds(tasks, TZ) });

describe('dinner habits', () => {
  it('is null with no usable dinner', () => {
    expect(computeDinner([day('2026-10-05', dinner('2026-10-05', {}))], TZ)).toBeNull();
    expect(computeDinner([], TZ)).toBeNull();
  });

  it('uses the Start press, else the tick minus the planned length, and skips flagged ones', () => {
    const r = computeDinner(
      [
        day('2026-10-05', dinner('2026-10-05', { began: '19:10', tick: '19:40' })),
        day('2026-10-06', dinner('2026-10-06', { tick: '20:30' })), // 30 min long -> 20:00
        day('2026-10-07', dinner('2026-10-07', { began: '18:00', tick: '18:30', flagged: true })),
        day('2026-10-08', dinner('2026-10-08', { began: '19:00', title: 'Lunch' })),
      ],
      TZ,
    )!;
    expect(r.overall).toMatchObject({ n: 2, median_start: '19:35', earliest: '19:10', latest: '20:00' });
    expect(r.recent.map((x) => [x.date, x.weekday, x.start, x.basis])).toEqual([
      ['2026-10-06', 'Tuesday', '20:00', 'tick'],
      ['2026-10-05', 'Monday', '19:10', 'start'],
    ]);
  });

  it('gives a weekday its own figure only with 3+ days of it', () => {
    const wed = ['2026-09-16', '2026-09-23', '2026-09-30'].map((d) => day(d, dinner(d, { began: '20:00', tick: '20:30' })));
    const tue = ['2026-09-15', '2026-09-22'].map((d) => day(d, dinner(d, { began: '19:00', tick: '19:30' })));
    const r = computeDinner([...wed, ...tue], TZ)!;
    expect(r.by_weekday).toEqual({ Wednesday: { n: 3, median_start: '20:00', earliest: '20:00', latest: '20:00' } });
    expect(r.too_few_weekdays).toEqual({ Tuesday: 2 });
    expect(r.overall!.n).toBe(5);
  });
});
