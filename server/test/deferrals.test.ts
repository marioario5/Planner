import { describe, expect, it } from 'vitest';
import { handleRequest } from '../src/index';
import { MemoryTaskStore } from './memory-store';
import { computeSlipping, deferHistory, deferRefusal, describeItem, slippingLines } from '../src/framework';
import type { Commitment, FrameworkLogEntry } from '../src/tasks';

const env = { API_TOKEN: 'a'.repeat(40), PLANNER_TZ: 'America/Los_Angeles' } as any;
const auth = { Authorization: `Bearer ${env.API_TOKEN}`, 'Content-Type': 'application/json' };
const now = new Date(Date.UTC(2026, 9, 18, 18, 0)); // Sun Oct 18, 11am PDT

const c = (o: Partial<Commitment>): Commitment => ({
  id: 'x', title: 'X', due: '2026-11-01', start: null, targetMinutes: 90, status: 'open', note: null,
  deferUntil: null, deferReason: null, createdOn: '2026-10-01', updatedAt: '2026-10-01T00:00:00Z', ...o,
});
const refusal = (o: Partial<Commitment>, extra: Partial<Parameters<typeof deferRefusal>[0]> = {}) => {
  const com = c(o);
  return deferRefusal({
    c: com, item: describeItem(com, [], '2026-10-18'), isProtected: false, history: { n: 0, lastReason: null },
    until: '2026-10-22', reason: 'a perfectly fine reason that is long enough', hisWords: null, ...extra,
  });
};

describe('when a deferral is refused', () => {
  it('allows an ordinary first deferral', () => {
    expect(refusal({})).toBeNull();
  });
  it('never lets the planner defer a protected item, but his words do', () => {
    expect(refusal({}, { isProtected: true })).toContain('protected');
    expect(refusal({}, { isProtected: true, hisWords: 'push the PIQs, I am sick' })).toBeNull();
  });
  it('refuses overdue items, deferrals past the due date, and due-within-a-week items with nothing done', () => {
    expect(refusal({ due: '2026-10-16' })).toContain('overdue');
    expect(refusal({ due: '2026-10-21' }, { until: '2026-10-25' })).toContain('past its due date');
    expect(refusal({ due: '2026-10-24' })).toContain('nothing done');
    expect(refusal({ due: '2026-10-24' }, { hisWords: 'leave it for now' })).toBeNull();
    expect(refusal({ due: '2026-11-20' })).toBeNull(); // far off: fine
  });
  it('needs a new reason the second time, and his words the third', () => {
    expect(refusal({}, { history: { n: 1, lastReason: 'busy' }, reason: 'busy again' })).toContain('new reason');
    expect(refusal({}, { history: { n: 1, lastReason: 'a perfectly fine reason that is long enough' } })).toContain('new reason');
    expect(refusal({}, { history: { n: 1, lastReason: 'busy' } })).toBeNull();
    expect(refusal({}, { history: { n: 2, lastReason: 'busy' } })).toContain('third deferral');
    expect(refusal({}, { history: { n: 2, lastReason: 'busy' }, hisWords: 'wait another week' })).toBeNull();
  });
});

describe('the slipping list', () => {
  const log: FrameworkLogEntry[] = [
    { onDate: '2026-10-17', commitmentId: 'piqs', action: 'defer', detail: 'until 2026-10-19: Sat is full (his words: "ok")' },
    { onDate: '2026-10-15', commitmentId: 'piqs', action: 'defer', detail: 'until 2026-10-17: Oct 15 is busy' },
  ];
  it('counts deferrals and strips the date and his words from the reason', () => {
    expect(deferHistory(log).get('piqs')).toEqual({ n: 2, lastReason: 'Sat is full' });
  });
  it("lists deferred, overdue, at-risk and protected items, and shows what is not in today's plan", () => {
    const items = computeSlipping(
      [c({ id: 'piqs', title: 'PIQs', due: '2026-10-21', targetMinutes: 180 }), c({ id: 'fine', title: 'Fine', due: '2026-12-01' }), c({ id: 'late', title: 'Late', due: '2026-10-16' })],
      [], log, new Set(['piqs']), '2026-10-18', new Set(['late']),
    );
    expect(items.map((i) => i.id)).toEqual(['piqs', 'late']);
    expect(items[0]).toMatchObject({ times_deferred: 2, protected: true, floor_needed: true, in_todays_plan: false });
    expect(slippingLines(items)[0]).toBe("- PIQs: due in 3 days, 0 of 180 min done, deferred 2 times, protected, NOT in today's plan");
  });
});

describe('through the server', () => {
  async function setup() {
    const store = new MemoryTaskStore();
    const tool = async (name: string, args: any) => {
      const res = await handleRequest(
        new Request('https://x/mcp', { method: 'POST', headers: auth, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) }),
        env, store, now,
      );
      const body: any = await res.json();
      const text = body.result.content[0].text;
      return { isError: !!body.result.isError, data: body.result.isError ? text : JSON.parse(text) };
    };
    await tool('set_commitments', {
      reviewed: true,
      commitments: [
        { id: 'piq-3', title: 'PIQ 3', due: '2026-10-21', target_minutes: 90, protected: true },
        { id: 'later', title: 'Later thing', due: '2026-11-20', target_minutes: 60 },
      ],
    });
    return { store, tool };
  }
  const apiDay = async (store: MemoryTaskStore, date: string) =>
    (await (await handleRequest(new Request(`https://x/api/tasks?date=${date}`, { headers: auth }), env, store, now)).json()) as any;

  it('refuses to defer a protected item and says what to do instead', async () => {
    const { tool } = await setup();
    const r = await tool('defer_commitment', { id: 'piq-3', until: '2026-10-20', reason: 'too busy today' });
    expect(r.isError).toBe(true);
    expect(r.data).toContain('protected');
    expect(r.data).toContain('floor block');
    const ok = await tool('defer_commitment', { id: 'piq-3', until: '2026-10-20', reason: 'he is sick', his_words: 'put the PIQs off, I am sick' });
    expect(ok.isError).toBe(false);
  });

  it('only he can unprotect, and it is logged', async () => {
    const { tool } = await setup();
    expect((await tool('set_commitments', { commitments: [{ id: 'piq-3', protected: false }] })).isError).toBe(true);
    expect((await tool('set_commitments', { commitments: [{ id: 'piq-3', protected: false, his_words: 'unprotect the PIQs please' }] })).isError).toBe(false);
    const f = (await tool('get_framework', {})).data;
    expect(f.protected).toEqual([]);
    expect(f.recent_choices[0].detail).toContain('unprotected (his words: "unprotect the PIQs please")');
  });

  it('counts deferrals, lists them in get_framework, and tells the planner when a floor block is missing', async () => {
    const { tool } = await setup();
    await tool('defer_commitment', { id: 'later', until: '2026-10-22', reason: 'first deferral is fine, far from due' });
    const f = (await tool('get_framework', {})).data;
    expect(f.slipping.map((s: any) => [s.id, s.times_deferred, s.floor_needed])).toEqual([['piq-3', 0, true], ['later', 1, false]]);
    expect(f.slipping_lines[0]).toContain('PIQ 3');
    const plan = (await tool('set_daily_plan', { date: '2026-10-18', tasks: [{ title: 'Calc', minutes: 30 }] })).data;
    expect(plan.framework_check.floor_blocks_missing.map((m: any) => m.id)).toEqual(['piq-3']);
    const covered = (await tool('set_daily_plan', { date: '2026-10-18', tasks: [{ title: 'PIQ 3 outline', minutes: 20, commitment: 'piq-3' }] })).data;
    expect(covered.framework_check?.floor_blocks_missing).toBeUndefined();
  });

  it("puts a Slipping section first on today's day in the app, and not on other days", async () => {
    const { store, tool } = await setup();
    await tool('set_day_info', { date: '2026-10-18', headline: 'Light day', sections: [{ title: 'Warnings', body: '- rest' }] });
    const today = await apiDay(store, '2026-10-18');
    expect(today.sections.map((s: any) => s.title)).toEqual(['Slipping', 'Warnings']);
    expect(today.sections[0].body).toContain("PIQ 3: due in 3 days, 0 of 90 min done, protected, NOT in today's plan");
    const other = await apiDay(store, '2026-10-19');
    expect(other.sections).toEqual([]);
  });
});
