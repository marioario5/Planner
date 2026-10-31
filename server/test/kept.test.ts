import { describe, expect, it } from 'vitest';
import { carriedKept, keptUntil } from '../src/kept';
import { MemoryTaskStore } from './memory-store';

const TZ = 'America/Los_Angeles';
const task = (title: string, notes: string | null) => ({ title, tag: 'college', start: null, minutes: null, notes, siteKey: null, commitment: null }) as any;
const at = (iso: string) => Date.parse(iso);

describe('kept checklist items follow him until their last day', () => {
  it('reads the last day from the notes', () => {
    expect(keptUntil({ notes: '[kept until 2026-11-01] x' })).toBe('2026-11-01');
    expect(keptUntil({ notes: '[kept] x' })).toBeNull();
    expect(keptUntil({ notes: null })).toBeNull();
  });

  it('shows unchecked items on later days through the last day, then drops them', async () => {
    const store = new MemoryTaskStore();
    await store.add('2026-10-30', 'A', task('USC essay', '[kept until 2026-11-01] x'));
    await store.add('2026-10-30', 'A', task('GT submit', '[kept until 2026-11-02] x'));
    await store.add('2026-10-30', 'A', task('Plain', null));
    const titles = async (d: string) => (await carriedKept(store, d, TZ)).map((t) => t.title).sort();
    expect(await titles('2026-10-30')).toEqual([]); // its own day comes from the day's own list
    expect(await titles('2026-10-31')).toEqual(['GT submit', 'USC essay']);
    expect(await titles('2026-11-01')).toEqual(['GT submit', 'USC essay']);
    expect(await titles('2026-11-02')).toEqual(['GT submit']);
    expect(await titles('2026-11-03')).toEqual([]);
  });

  it('keeps a checked item only for the planner day it was checked, which ends at 4am', async () => {
    const store = new MemoryTaskStore();
    const a = await store.add('2026-10-30', 'A', task('Checked late', '[kept until 2026-11-02] x'));
    store.clock = () => at('2026-11-01T22:00:00-07:00'); // 10pm Nov 1, still planner day Nov 1
    await store.update(a.id, { done: true });
    const titles = async (d: string) => (await carriedKept(store, d, TZ)).map((t) => t.title);
    expect(await titles('2026-10-31')).toEqual([]);
    expect(await titles('2026-11-01')).toEqual(['Checked late']);
    expect(await titles('2026-11-02')).toEqual([]); // gone at 4am
  });
});
