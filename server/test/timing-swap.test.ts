import { describe, expect, it } from 'vitest';
import { dayTiming, lateMinutes, slotLateness } from '../src/timing';
import type { Task } from '../src/tasks';

const TZ = 'America/Los_Angeles';
const task = (id: string, start: string, minutes: number, tick: string | null): Task =>
  ({
    id, date: '2026-10-10', plan: 'B', commitment: null, title: id, tag: 'school', start, minutes,
    notes: null, siteKey: null, done: tick !== null, doneAt: 0, position: 0, createdAt: '2026-10-10T00:00:00Z',
    completedAt: tick ? `2026-10-10T${tick}:00-07:00` : null, startedAt: null, flaggedAt: null,
  }) as unknown as Task;

describe('lateness with order swaps taken out', () => {
  it('work done in the planned order keeps its own lateness', () => {
    const a = task('a', '12:20', 65, '13:35'); // ends 13:25
    const b = task('b', '13:35', 50, '14:30'); // ends 14:25
    const m = slotLateness([a, b], TZ);
    expect(m.get('a')).toBe(10);
    expect(m.get('b')).toBe(5);
    expect(m.get('a')).toBe(lateMinutes(a, TZ));
  });

  it('two neighbouring blocks done the other way round are each judged against the other slot', () => {
    // planned Calc 12:20-13:25, then PIQ 13:35-14:25; he did PIQ first (13:30) and Calc after (14:35)
    const calc = task('calc', '12:20', 65, '14:35');
    const piq = task('piq', '13:35', 50, '13:30');
    expect(lateMinutes(piq, TZ)).toBe(-55); // by its own plan it looks very early...
    expect(lateMinutes(calc, TZ)).toBe(70); // ...and Calc very late
    const m = slotLateness([calc, piq], TZ);
    expect(m.get('piq')).toBe(5); // 13:30 vs Calc's end 13:25
    expect(m.get('calc')).toBe(10); // 14:35 vs PIQ's end 14:25
  });

  it('being genuinely behind still shows as behind after a swap', () => {
    const calc = task('calc', '12:20', 65, '16:00');
    const piq = task('piq', '13:35', 50, '15:00');
    const m = slotLateness([calc, piq], TZ);
    expect(m.get('piq')).toBe(95); // 15:00 vs 13:25
    expect(m.get('calc')).toBe(95); // 16:00 vs 14:25
  });

  it('a swap of blocks finished more than two hours apart is not a swap: the late one stays late', () => {
    const calc = task('calc', '12:20', 65, '23:11');
    const bench = task('bench', '15:45', 120, '17:50');
    const m = slotLateness([calc, bench], TZ);
    expect(m.get('bench')).toBe(5); // 17:50 vs its own end 17:45, not blamed for Calc being put off
    expect(m.get('calc')).toBe(23 * 60 + 11 - (13 * 60 + 25)); // still late against its own end
  });

  it('unfinished blocks are skipped and do not shift the others', () => {
    const m = slotLateness([task('a', '12:20', 65, '13:30'), task('b', '13:35', 50, null), task('c', '14:30', 30, '15:05')], TZ);
    expect(m.get('a')).toBe(5);
    expect(m.has('b')).toBe(false);
    expect(m.get('c')).toBe(5);
  });

  it('the day summary uses it, and says so', () => {
    const timing = dayTiming([task('calc', '12:20', 65, '14:35'), task('piq', '13:35', 50, '13:30')], TZ)!;
    expect(timing.avg_late_min).toBe(8); // (5 + 10) / 2 rounded
    expect(timing.max_late_min).toBe(10);
    expect(timing.note).toContain('swapping them is not counted as lateness');
  });
});
