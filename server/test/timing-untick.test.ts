import { describe, expect, it } from 'vitest';
import { bulkTickedIds, dayTiming } from '../src/timing';
import type { Task } from '../src/tasks';

const TZ = 'America/Los_Angeles';
const task = (id: string, done: boolean, tick: string | null): Task =>
  ({
    id, date: '2026-10-05', plan: 'A', commitment: null, title: id, tag: 'school', start: '15:30', minutes: 25,
    notes: null, siteKey: null, done, doneAt: 0, position: 0, createdAt: '2026-10-05T00:00:00Z',
    completedAt: tick ? `2026-10-05T${tick}:00-07:00` : null,
  }) as unknown as Task;

describe('unticked tasks and bulk detection', () => {
  it('an accidental tick that was unticked does not make a batch', () => {
    const tasks = [task('a', true, '16:00'), task('b', true, '16:04'), task('c', false, null)];
    expect(bulkTickedIds(tasks, TZ).size).toBe(0);
    expect(dayTiming(tasks, TZ)?.ticked_in_bulk).toBe(false);
  });
  it('three real ticks within 10 minutes still do', () => {
    const tasks = [task('a', true, '16:00'), task('b', true, '16:04'), task('c', true, '16:08')];
    expect(bulkTickedIds(tasks, TZ).size).toBe(3);
  });
});
