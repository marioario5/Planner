import { describe, expect, it } from 'vitest';
import { capFromOrders, checkDirectives, parseOrders } from '../src/directives';
import { handleRequest } from '../src/index';
import { MemoryTaskStore } from './memory-store';

const t = (title: string, tag: string, start: string | null, minutes: number | null) => ({ title, tag, start, minutes, commitmentId: null }) as any;
const order = (o: { id: string; [k: string]: unknown }): any => ({ text: 'x', applies: 'all', evidence: 'n=12 weekdays', review_by: '2026-11-17', ...o });

describe('standing orders: validation', () => {
  it('needs an id, text, evidence and a review date, and refuses more than fifteen or a bad check', () => {
    expect(parseOrders([order({ id: 'start-5pm', text: 'Weekday work starts 17:00', applies: 'weekday', check: { kind: 'start_not_before', time: '17:00' } })])).toHaveLength(1);
    expect(() => parseOrders([{ id: 'a', text: 'x', applies: 'all', evidence: 'e' }])).toThrow(/review_by/);
    expect(() => parseOrders([order({ id: 'a', evidence: '' })])).toThrow(/evidence/);
    expect(() => parseOrders([order({ id: 'Bad Id' })])).toThrow(/slug/);
    expect(() => parseOrders([order({ id: 'a' }), order({ id: 'a' })])).toThrow(/twice/);
    expect(() => parseOrders(Array.from({ length: 16 }, (_, i) => order({ id: `o${i}` })))).toThrow(/at most 15/);
    expect(() => parseOrders([order({ id: 'a', check: { kind: 'start_not_before', time: '5pm' } })])).toThrow(/HH:MM/);
    expect(() => parseOrders([order({ id: 'a', check: { kind: 'no_block_window', from: '20:30', to: '20:00' } })])).toThrow(/end after/);
    expect(() => parseOrders([order({ id: 'a', check: { kind: 'mystery' } })])).toThrow(/check.kind/);
    expect(parseOrders([order({ id: 'advice-only', check: null })])[0].check).toBeNull();
  });
});

describe('standing orders: the automatic checks', () => {
  const orders = parseOrders([
    order({ id: 'start', applies: 'weekday', check: { kind: 'start_not_before', time: '17:00' } }),
    order({ id: 'cap', applies: 'weekday', check: { kind: 'cap_minutes', minutes: 120 } }),
    order({ id: 'quiet', applies: 'all', check: { kind: 'no_block_window', from: '20:00', to: '20:30' } }),
    order({ id: 'calc-break', applies: 'all', check: { kind: 'min_gap_after_tag', tag: 'calculus3', minutes: 25 } }),
    order({ id: 'dinner', applies: 'all', check: { kind: 'dinner_at', time: '20:30' } }),
  ]);
  const good = [t('SAT', 'sat', '17:00', 20), t('Calc 3', 'calculus3', '17:30', 60), t('Stats', 'school', '18:55', 30), t('Dinner', 'other', '20:30', 30)];

  it('passes a plan that keeps every order', () => {
    expect(checkDirectives('2026-10-27', good, orders)).toEqual({ checked: 5, broken: [], notes: [] });
  });

  it('names each broken order and why', () => {
    const bad = [t('Early', 'school', '16:00', 30), t('Calc 3', 'calculus3', '17:00', 90), t('Stats', 'school', '18:40', 30), t('Late thing', 'pcb', '20:10', 20), t('Dinner', 'other', '21:30', 30)];
    const r = checkDirectives('2026-10-27', bad, orders);
    expect(r.broken.map((b) => b.id).sort()).toEqual(['calc-break', 'cap', 'dinner', 'quiet', 'start']);
    expect(r.broken.find((b) => b.id === 'cap')!.why).toContain('over by 50');
  });

  it('does not call it broken when Calc 3, SAT and assignments alone are over the cap, only notes it', () => {
    const heavy = [t('Calc 3', 'calculus3', '17:00', 80), t('SAT', 'sat', '18:25', 20), t('Stats', 'school', '18:55', 95), t('Dinner', 'other', '20:30', 30)];
    const r = checkDirectives('2026-10-27', heavy, parseOrders([order({ id: 'cap', applies: 'weekday', check: { kind: 'cap_minutes', minutes: 120 } })]));
    expect(r.broken).toEqual([]);
    expect(r.notes[0]).toContain('Over cap by 75');
  });

  it('applies weekday orders only on weekdays', () => {
    const early = [t('Early', 'pcb', '10:00', 200), t('Dinner', 'other', '20:30', 30)];
    expect(checkDirectives('2026-10-31', early, orders).broken).toEqual([]); // Saturday: only the "all" orders apply
    expect(checkDirectives('2026-10-27', early, orders).broken.map((b) => b.id).sort()).toEqual(['cap', 'start']);
  });

  it('takes the smallest cap the orders set for that day', () => {
    expect(capFromOrders(orders, '2026-10-27')).toBe(120);
    expect(capFromOrders(orders, '2026-10-31')).toBeNull();
  });
});

const env = { API_TOKEN: 'a'.repeat(40), PLANNER_TZ: 'America/Los_Angeles' } as any;
const auth = { Authorization: `Bearer ${env.API_TOKEN}`, 'Content-Type': 'application/json' };
const now = new Date(Date.UTC(2026, 9, 27, 19, 0)); // Tue Oct 27, noon PDT
const call = async (store: MemoryTaskStore, name: string, args: any = {}) => {
  const res = await handleRequest(
    new Request('https://x/mcp', { method: 'POST', headers: auth, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) }),
    env, store, now,
  );
  const r = ((await res.json()) as any).result;
  return { isError: !!r.isError, data: r.isError ? r.content[0].text : JSON.parse(r.content[0].text) };
};

describe('standing orders through the MCP endpoint', () => {
  it('saves a version, keeps the history, and flags orders past their review date', async () => {
    const store = new MemoryTaskStore();
    expect((await call(store, 'get_directives')).data).toMatchObject({ version: 0, orders: [] });
    const dinner = order({ id: 'dinner', check: { kind: 'dinner_at', time: '20:30' }, review_by: '2026-10-01' });
    await call(store, 'set_directives', { orders: [dinner], note: 'first' });
    await call(store, 'set_directives', { orders: [dinner, order({ id: 'start', applies: 'weekday', check: { kind: 'start_not_before', time: '17:00' } })] });
    const r = (await call(store, 'get_directives', { history: true })).data;
    expect(r.version).toBe(2);
    expect(r.orders).toHaveLength(2);
    expect(r.review_overdue).toEqual(['dinner']);
    expect(r.history.map((h: any) => h.version)).toEqual([1, 2]);
    expect((await call(store, 'set_directives', { orders: [{ id: 'x' }] })).isError).toBe(true);
  });

  it('reports a broken order on set_daily_plan and uses the cap an order sets in the day-type check', async () => {
    const store = new MemoryTaskStore();
    await call(store, 'set_directives', {
      orders: [order({ id: 'start', applies: 'weekday', check: { kind: 'start_not_before', time: '17:00' } }), order({ id: 'cap', applies: 'weekday', check: { kind: 'cap_minutes', minutes: 60 } })],
    });
    const r = (await call(store, 'set_daily_plan', { date: '2026-10-27', tasks: [{ title: 'Early PCB', tag: 'pcb', start: '16:00', minutes: 90 }] })).data;
    expect(r.directive_check.broken.map((b: any) => b.id).sort()).toEqual(['cap', 'start']);
    expect(r.day_type_check.over_cap).toMatchObject({ cap_minutes: 60, over_by: 30 });
    const ok = (await call(store, 'set_daily_plan', { date: '2026-10-27', tasks: [{ title: 'SAT', tag: 'sat', start: '17:00', minutes: 30 }] })).data;
    expect(ok.directive_check).toBeUndefined();
  });
});

describe('get_week_export', () => {
  it('returns the followed plan with every timing field, the rating, the other plan totals and the headline, and refuses a range over 90 days', async () => {
    const store = new MemoryTaskStore();
    await call(store, 'set_daily_plan', { date: '2026-10-26', plan: 'A', tasks: [{ title: 'SAT', tag: 'sat', start: '17:00', minutes: 20 }] });
    await call(store, 'set_daily_plan', { date: '2026-10-26', plan: 'B', tasks: [{ title: 'SAT', tag: 'sat', start: '17:30', minutes: 20 }] });
    await call(store, 'set_day_info', { date: '2026-10-26', headline: 'Minimum day' });
    const r = (await call(store, 'get_week_export')).data;
    expect(r.through).toBe('2026-10-26');
    const day = r.days.find((d: any) => d.date === '2026-10-26');
    expect(day).toMatchObject({ weekday: 'Mon', plan: 'A', headline: 'Minimum day', other_plan: { plan: 'B', total: 1 } });
    expect(day.tasks[0]).toMatchObject({ title: 'SAT', tag: 'sat', start: '17:00', minutes: 20 });
    expect(Object.keys(day.tasks[0])).toEqual(expect.arrayContaining(['started', 'actual_min', 'start_delay_min', 'flagged', 'bulk_ticked', 'backfilled', 'late_min']));
    expect((await call(store, 'get_week_export', { from: '2026-01-01', to: '2026-10-26' })).isError).toBe(true);
  });
});
