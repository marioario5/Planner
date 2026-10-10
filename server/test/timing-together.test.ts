import { describe, expect, it } from 'vitest';
import { bulkTickedIds, dayTiming, finishedTogether } from '../src/timing';
import type { Task } from '../src/tasks';

const TZ = 'America/Los_Angeles';

interface Spec {
  id: string;
  title: string;
  start: string;
  minutes: number;
  tick: string | null;
  began?: string;
  tag?: string;
}
const task = (s: Spec): Task =>
  ({
    id: s.id, date: '2026-10-10', plan: 'B', commitment: null, title: s.title, tag: s.tag ?? 'school', start: s.start, minutes: s.minutes,
    notes: null, siteKey: null, done: s.tick !== null, doneAt: 0, position: 0, createdAt: '2026-10-10T00:00:00Z',
    completedAt: s.tick ? `2026-10-10T${s.tick}:00-07:00` : null,
    startedAt: s.began ? `2026-10-10T${s.began}:00-07:00` : null,
    flaggedAt: null,
  }) as unknown as Task;

const part1 = (over: Partial<Spec> = {}) => task({ id: 'p1', title: 'Chem POGIL: part 1', start: '11:45', minutes: 25, tick: '12:08', began: '11:54', ...over });
const finish = (over: Partial<Spec> = {}) => task({ id: 'p2', title: 'Chem POGIL: finish', start: '16:15', minutes: 50, tick: '12:08', ...over });

describe('blocks of one piece of work finished in a single sitting', () => {
  it('an unstarted block ticked with the started one of the same work is finished together with it', () => {
    const together = finishedTogether([part1(), finish()], TZ);
    expect([...together.keys()]).toEqual(['p2']);
    expect(together.get('p2')?.title).toBe('Chem POGIL: part 1');
  });

  it('is within three minutes, not more', () => {
    expect(finishedTogether([part1(), finish({ tick: '12:11' })], TZ).size).toBe(1);
    expect(finishedTogether([part1(), finish({ tick: '12:12' })], TZ).size).toBe(0);
  });

  it('needs the same subject and the same title prefix', () => {
    expect(finishedTogether([part1(), finish({ tag: 'sat' })], TZ).size).toBe(0);
    expect(finishedTogether([part1(), finish({ title: 'Calc 3: finish' })], TZ).size).toBe(0);
    expect(finishedTogether([part1(), finish({ title: 'Finish up' })], TZ).size).toBe(0);
  });

  it('needs the other block to have been started, and the later one not to have been', () => {
    expect(finishedTogether([part1({ began: undefined }), finish()], TZ).size).toBe(0);
    expect(finishedTogether([part1(), finish({ began: '12:00' })], TZ).size).toBe(0);
  });

  it('keeps the unstarted block out of every figure and reports the piece as one', () => {
    const timing = dayTiming([part1(), finish()], TZ)!;
    expect(timing.finished_together).toEqual([{ blocks: ['Chem POGIL: part 1', 'Chem POGIL: finish'], planned_min: 75, actual_min: 14 }]);
    expect(timing.bulk_ticked).toEqual([]);
    expect(timing.ticked_in_bulk).toBe(false);
    // only part 1's lateness counts: the finish block's -297 does not
    expect(timing.avg_late_min).toBe(-2);
    expect(timing.max_late_min).toBe(-2);
    expect(timing.note).toContain('finished in one sitting');
  });

  it('a plain pair of ticks with no Start press anywhere is left alone', () => {
    const timing = dayTiming([part1({ began: undefined }), finish()], TZ)!;
    expect(timing.finished_together).toBeUndefined();
    expect(timing.avg_late_min).toBe(-149);
  });

  it('two follow-up blocks both join the one he started', () => {
    const third = finish({ id: 'p3', title: 'Chem POGIL: wrap up', start: '17:10', minutes: 20, tick: '12:09' });
    const timing = dayTiming([part1(), finish(), third], TZ)!;
    expect(timing.finished_together![0]).toMatchObject({ planned_min: 95, actual_min: 14 });
    expect(timing.finished_together![0].blocks).toHaveLength(3);
    expect(timing.bulk_ticked).toEqual([]);
  });

  it('counts as left out of the batch-tick figures too, so habits ignore its time', () => {
    expect(bulkTickedIds([part1(), finish()], TZ).has('p2')).toBe(true);
    expect(bulkTickedIds([part1(), finish()], TZ).has('p1')).toBe(false);
  });
});
