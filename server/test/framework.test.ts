import { describe, expect, it } from 'vitest';
import { NOTE_TO_YOU, computeFramework, unaddressed } from '../src/framework';
import type { Commitment, CommitmentWork } from '../src/tasks';

const TODAY = '2026-10-10';

let n = 0;
const c = (o: Partial<Commitment> & { id: string }): Commitment => ({
  title: o.id,
  due: null,
  start: null,
  targetMinutes: null,
  status: 'open',
  note: null,
  deferUntil: null,
  deferReason: null,
  createdOn: '2026-10-01',
  updatedAt: '2026-10-01T00:00:00Z',
  ...o,
});
const w = (commitmentId: string, date: string, minutes: number, done = true): CommitmentWork => ({ commitmentId, date, minutes, done });
const fw = (commitments: Commitment[], work: CommitmentWork[] = [], reviewedOn: string | null = '2026-10-08', all = false) =>
  computeFramework(commitments, work, [], reviewedOn, TODAY, all);
const signalsOf = (f: ReturnType<typeof fw>, id: string) => f.worth_a_look.find((i) => i.id === id)?.signals ?? [];

describe('framing', () => {
  it('always tells the reader these are suggestions it is free to ignore', () => {
    const f = fw([]);
    expect(f.note_to_you).toBe(NOTE_TO_YOU);
    expect(NOTE_TO_YOU).toContain('SUGGESTIONS from earlier planning runs');
    expect(NOTE_TO_YOU).toContain('free to follow, resize, split, defer or drop');
    expect(NOTE_TO_YOU).toContain('disagree with the whole framework');
    expect(NOTE_TO_YOU).toContain('not verdicts');
  });

  it('carries the proposing agent\'s reasoning and date with each item', () => {
    const f = fw([c({ id: 'piq-7', due: '2026-10-20', note: 'assumed 3 sessions of ~60 min, outline first' })], [], '2026-10-08', true);
    expect(f.all_open![0]).toMatchObject({ proposed_on: '2026-10-01', note: 'assumed 3 sessions of ~60 min, outline first' });
  });
});

describe('signals', () => {
  it('notes nothing when work is on pace', () => {
    // 180 min over Oct 1 -> Oct 21; by Oct 10 (9 of 20 days) ~81 min expected, 90 logged
    const f = fw([c({ id: 'essay', due: '2026-10-21', targetMinutes: 180 })], [w('essay', '2026-10-08', 90)]);
    expect(f.worth_a_look).toEqual([]);
  });

  it('says when nothing has been worked on and the due date is within a month', () => {
    const f = fw([c({ id: 'common-app', due: '2026-10-26', targetMinutes: 240 })]);
    expect(signalsOf(f, 'common-app')).toContain('no work logged yet and it is due in 16 days');
  });

  it('does not nag about something brand new or far away', () => {
    const fresh = fw([c({ id: 'new', due: '2026-10-20', createdOn: '2026-10-09' })]); // proposed yesterday
    expect(fresh.worth_a_look).toEqual([]);
    const far = fw([c({ id: 'far', due: '2026-12-15', createdOn: '2026-09-01' })]); // 66 days out
    expect(far.worth_a_look).toEqual([]);
  });

  it('reports a steady-pace shortfall with the numbers', () => {
    // 300 min over Oct 1 -> Oct 31 (30 days); by Oct 10 (9 days) expected 90; 20 logged
    const f = fw([c({ id: 'apps', due: '2026-10-31', targetMinutes: 300 })], [w('apps', '2026-10-05', 20)]);
    expect(signalsOf(f, 'apps')).toContain('on a steady pace about 90 min would be done by now; 20 logged');
  });

  it('flags work that cannot fit at an hour a day', () => {
    const f = fw([c({ id: 'tight', due: '2026-10-12', targetMinutes: 400 })], [w('tight', '2026-10-09', 100)]);
    expect(signalsOf(f, 'tight').some((s) => s.startsWith('300 min left and 2 days to go'))).toBe(true);
  });

  it('flags a stalled item and an overdue one', () => {
    const stalled = fw([c({ id: 'pcb', due: '2026-10-25', targetMinutes: 200 })], [w('pcb', '2026-10-01', 150)]);
    expect(signalsOf(stalled, 'pcb')).toContain('last worked 9 days ago and it is due in 15 days');
    const overdue = fw([c({ id: 'late', due: '2026-10-07', targetMinutes: 60 })], [w('late', '2026-10-03', 30)]);
    expect(signalsOf(overdue, 'late')).toContain("was due 2026-10-07 (3 days ago) and isn't marked done");
  });

  it('stays quiet once the target is met, even past the due date', () => {
    const f = fw([c({ id: 'done-ish', due: '2026-10-07', targetMinutes: 60 })], [w('done-ish', '2026-10-06', 60)]);
    expect(f.worth_a_look).toEqual([]);
  });

  it('only counts work that was actually done', () => {
    const f = fw([c({ id: 'x', due: '2026-10-26', targetMinutes: 100 })], [w('x', '2026-10-08', 100, false)]);
    expect(signalsOf(f, 'x')).toContain('no work logged yet and it is due in 16 days');
  });

  it('works without a target or a due date', () => {
    const f = fw([c({ id: 'loose' }), c({ id: 'dated', due: '2026-10-26' })]);
    expect(f.worth_a_look.map((i) => i.id)).toEqual(['dated']); // only the one with a date and no work
    expect(signalsOf(f, 'dated')).toEqual(['no work logged yet and it is due in 16 days']);
  });
});

describe('what is shown', () => {
  it('keeps deferrals visible with the earlier reason, and silent until the date', () => {
    const items = [
      c({ id: 'sat-prep', due: '2026-10-20', deferUntil: '2026-10-14', deferReason: 'SAT taper: nothing new before the test' }),
      c({ id: 'back', due: '2026-10-20', deferUntil: '2026-10-10' }), // until == today: it is back
    ];
    const f = fw(items);
    expect(f.deferred).toHaveLength(1);
    expect(f.deferred[0]).toMatchObject({ id: 'sat-prep', deferred_until: '2026-10-14', deferred_reason: 'SAT taper: nothing new before the test' });
    expect(f.worth_a_look.map((i) => i.id)).toEqual(['back']);
    expect(f.counts).toMatchObject({ open: 2, deferred: 1, worth_a_look: 1 });
  });

  it('lists due-soon items without signals, and hides closed ones', () => {
    const f = fw([
      c({ id: 'soon', due: '2026-10-14', targetMinutes: 30 }),
      c({ id: 'far', due: '2026-12-01' }),
      c({ id: 'finished', due: '2026-10-12', status: 'done' }),
      c({ id: 'dropped', due: '2026-10-12', status: 'dropped' }),
    ], [w('soon', '2026-10-09', 30)]);
    // Only open items count: 'finished' and 'dropped' are gone. 'soon' has no signals but is due in 4 days.
    expect(f.counts.open).toBe(2);
    expect(f.due_soon.map((i) => i.id)).toEqual(['soon']);
    expect(f.worth_a_look).toEqual([]);
  });

  it('shows due-soon items that have no signals', () => {
    const f = fw([c({ id: 'soon', due: '2026-10-14', targetMinutes: 60 })], [w('soon', '2026-10-09', 30)]);
    expect(f.due_soon.map((i) => i.id)).toEqual(['soon']);
    expect(f.counts.due_within_7_days).toBe(1);
  });

  it('returns the full list only when asked, and the last 10 choices', () => {
    const log = Array.from({ length: 12 }, (_, i) => ({ onDate: `2026-10-${String(i + 1).padStart(2, '0')}`, commitmentId: 'a', action: 'defer' as const, detail: `d${i}` }));
    const f = computeFramework([c({ id: 'a', due: '2026-10-26' })], [], log, '2026-10-08', TODAY, false);
    expect(f.all_open).toBeUndefined();
    expect(f.recent_choices).toHaveLength(10);
    expect(f.recent_choices[0].detail).toBe('d0'); // the log is passed newest first
    expect(fw([c({ id: 'a' })], [], '2026-10-08', true).all_open).toHaveLength(1);
  });
});

describe('review and the publish check', () => {
  it('asks for a light review only after a week, or when none has happened', () => {
    expect(fw([], [], null).review_due).toBe(true);
    expect(fw([], [], null).review_hint).toContain('No review has been done yet');
    expect(fw([], [], '2026-10-03').review_due).toBe(true); // 7 days
    expect(fw([], [], '2026-10-04').review_due).toBe(false); // 6 days
    expect(fw([], [], '2026-10-04').review_hint).toBeUndefined();
    expect(fw([], [], null).review_hint).toContain('your call how much');
  });

  it('lists flagged items that nothing in the plan works on', () => {
    const f = fw([c({ id: 'a', due: '2026-10-26' }), c({ id: 'b', due: '2026-10-26' }), c({ id: 'quiet', due: '2026-12-31' })]);
    expect(unaddressed(f, new Set(['a'])).map((i) => i.id)).toEqual(['b']);
    expect(unaddressed(f, new Set(['a', 'b']))).toEqual([]);
  });
});
