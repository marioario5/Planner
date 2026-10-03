import { beforeEach, describe, expect, it } from 'vitest';
import { todayIn } from '../src/dates';
import { handleRequest } from '../src/index';
import { MemoryTaskStore } from './memory-store';

const TOKEN = 'test-token-0123456789abcdef';
const BASE = 'https://planner.test';
// 2026-10-02 05:30 UTC is still the evening of 2026-10-01 in Los Angeles (PDT).
const NOW = new Date('2026-10-02T05:30:00Z');

let store: MemoryTaskStore;
const env = { API_TOKEN: TOKEN, PLANNER_TZ: 'America/Los_Angeles' };

beforeEach(() => {
  store = new MemoryTaskStore();
});

function call(path: string, init: RequestInit = {}, token: string | null = TOKEN) {
  const headers = new Headers(init.headers);
  if (token) headers.set('Authorization', `Bearer ${token}`);
  return handleRequest(new Request(BASE + path, { ...init, headers }), env, store, NOW);
}

let rpcId = 0;
async function rpc(method: string, params?: unknown, path = '/mcp') {
  const res = await call(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
  });
  return { status: res.status, body: (await res.json()) as any };
}

async function tool(name: string, args: unknown) {
  const { body } = await rpc('tools/call', { name, arguments: args });
  const text: string = body.result.content[0].text;
  return { isError: body.result.isError === true, text, data: body.result.isError ? null : JSON.parse(text) };
}

describe('dates', () => {
  it('uses the planner time zone, not UTC', () => {
    expect(todayIn('America/Los_Angeles', NOW)).toBe('2026-10-01');
    expect(todayIn('UTC', NOW)).toBe('2026-10-02');
  });
});

describe('auth', () => {
  it('rejects missing and wrong bearer tokens', async () => {
    expect((await call('/api/tasks', {}, null)).status).toBe(401);
    expect((await call('/api/tasks', {}, 'nope')).status).toBe(401);
    expect((await call('/mcp', { method: 'POST', body: '{}' }, null)).status).toBe(401);
  });

  it('accepts the token as an /mcp/<token> path segment for header-less clients', async () => {
    const { status } = await rpc('ping', undefined, `/mcp/${TOKEN}`);
    expect(status).toBe(200);
    const bad = await call('/mcp/wrong-token-wrong-token', { method: 'POST', body: '{}' }, null);
    expect(bad.status).toBe(401);
  });

  it('does not accept the path token on the REST API', async () => {
    expect((await call(`/api/tasks/${TOKEN}`, {}, null)).status).toBe(401);
  });

  it('refuses to run with a missing or weak secret', async () => {
    for (const secret of [undefined, '', 'short']) {
      const res = await handleRequest(
        new Request(`${BASE}/api/tasks`, { headers: { Authorization: `Bearer ${secret}` } }),
        { API_TOKEN: secret as string },
        store,
        NOW,
      );
      expect(res.status).toBe(500);
    }
  });
});

describe('mcp protocol', () => {
  it('negotiates the protocol version and advertises tools', async () => {
    const { body } = await rpc('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 't', version: '0' },
    });
    expect(body.result.protocolVersion).toBe('2025-06-18');
    expect(body.result.capabilities.tools).toBeDefined();

    const { body: future } = await rpc('initialize', { protocolVersion: '2099-01-01' });
    expect(future.result.protocolVersion).toBe('2025-11-25');
  });

  it('acknowledges notifications with 202 and no body', async () => {
    const res = await call('/mcp', {
      method: 'POST',
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    });
    expect(res.status).toBe(202);
    expect(await res.text()).toBe('');
  });

  it('lists the seven tools with schemas', async () => {
    const { body } = await rpc('tools/list');
    expect(body.result.tools.map((t: any) => t.name)).toEqual([
      'set_daily_plan',
      'set_day_info',
      'list_tasks',
      'get_history',
      'add_task',
      'update_task',
      'delete_task',
    ]);
    for (const t of body.result.tools) expect(t.inputSchema.type).toBe('object');
  });

  it('answers unknown methods and tools with JSON-RPC errors', async () => {
    expect((await rpc('nope')).body.error.code).toBe(-32601);
    expect((await rpc('tools/call', { name: 'nope', arguments: {} })).body.error.code).toBe(-32602);
  });

  it('rejects malformed JSON and non-POST methods', async () => {
    const bad = await call('/mcp', { method: 'POST', body: '{not json' });
    expect(bad.status).toBe(400);
    const get = await call('/mcp', { method: 'GET' });
    expect(get.status).toBe(405);
  });

  it('answers batches', async () => {
    const res = await call('/mcp', {
      method: 'POST',
      body: JSON.stringify([
        { jsonrpc: '2.0', id: 1, method: 'ping' },
        { jsonrpc: '2.0', method: 'notifications/initialized' },
        { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      ]),
    });
    const body = (await res.json()) as any[];
    expect(body.map((r) => r.id)).toEqual([1, 2]);
  });
});

describe('mcp tools', () => {
  it('publishes a plan for today in the planner time zone and reads it back', async () => {
    const set = await tool('set_daily_plan', {
      tasks: [
        { title: 'Calc 3 problem set', tag: 'calculus3' },
        { title: 'Solder PCB', tag: 'pcb' },
        { title: 'Call grandma' },
      ],
    });
    expect(set.data.date).toBe('2026-10-01');
    expect(set.data.total).toBe(3);
    expect(set.data.tasks.map((t: any) => t.tag)).toEqual(['calculus3', 'pcb', 'school']);

    const list = await tool('list_tasks', {});
    expect(list.data.tasks.map((t: any) => t.title)).toEqual([
      'Calc 3 problem set',
      'Solder PCB',
      'Call grandma',
    ]);
  });

  it('keeps tasks checked off when the same plan is published again', async () => {
    const first = await tool('set_daily_plan', { tasks: [{ title: 'Practice scales' }, { title: 'Quiz' }] });
    await tool('update_task', { id: first.data.tasks[0].id, done: true });

    const again = await tool('set_daily_plan', {
      tasks: [{ title: 'Quiz' }, { title: ' practice SCALES ' }, { title: 'New thing' }],
    });
    expect(again.data.tasks.map((t: any) => [t.title, t.done])).toEqual([
      ['Quiz', false],
      ['practice SCALES', true],
      ['New thing', false],
    ]);
    expect(again.data.done).toBe(1);
  });

  it('keeps days separate and can clear one', async () => {
    await tool('set_daily_plan', { date: '2026-10-05', tasks: [{ title: 'Later' }] });
    await tool('set_daily_plan', { tasks: [{ title: 'Now' }] });
    expect((await tool('list_tasks', { date: '2026-10-05' })).data.total).toBe(1);
    await tool('set_daily_plan', { tasks: [] });
    expect((await tool('list_tasks', {})).data.total).toBe(0);
    expect((await tool('list_tasks', { date: '2026-10-05' })).data.total).toBe(1);
  });

  it('adds, updates and deletes single tasks', async () => {
    const added = await tool('add_task', { title: 'Water plants', tag: 'photography' });
    const id = added.data.added.id;
    const updated = await tool('update_task', { id, title: 'Water the cactus', done: true });
    expect(updated.data.updated).toMatchObject({ title: 'Water the cactus', done: true });
    expect((await tool('delete_task', { id })).data.deleted).toBe(id);
    expect((await tool('list_tasks', {})).data.total).toBe(0);
  });

  it('reports bad input as tool errors the model can act on', async () => {
    const badTag = await tool('set_daily_plan', { tasks: [{ title: 'x', tag: 'gardening' }] });
    expect(badTag.isError).toBe(true);
    expect(badTag.text).toContain('calculus3');

    expect((await tool('set_daily_plan', { tasks: [{ title: '   ' }] })).isError).toBe(true);
    expect((await tool('set_daily_plan', { tasks: 'oops' })).isError).toBe(true);
    expect((await tool('list_tasks', { date: '2026-02-31' })).isError).toBe(true);
    expect((await tool('list_tasks', { date: 'tomorrow' })).isError).toBe(true);
    expect((await tool('update_task', { id: 'missing', done: true })).isError).toBe(true);
    expect((await tool('update_task', { id: 'missing' })).isError).toBe(true);
    expect((await tool('delete_task', { id: 'missing' })).isError).toBe(true);
  });

  it('does not wipe the existing day when a replacement is invalid', async () => {
    await tool('set_daily_plan', { tasks: [{ title: 'Keep me' }] });
    await tool('set_daily_plan', { tasks: [{ title: 'ok' }, { title: '' }] });
    expect((await tool('list_tasks', {})).data.tasks.map((t: any) => t.title)).toEqual(['Keep me']);
  });
});

describe('times and notes', () => {
  it('orders timed tasks by clock, then untimed in the order given', async () => {
    const { data } = await tool('set_daily_plan', {
      tasks: [
        { title: 'Tonight wrap-up' },
        { title: 'SAT module', start: '16:30', minutes: 40, tag: 'sat' },
        { title: 'Ask teacher about quiz' },
        { title: 'Calc 3 problems', start: '15:30', minutes: 25, tag: 'calculus3', notes: 'Start: open Sec 6.2. If 3:30 and at desk, then go.' },
        { title: 'Photo walk', start: '17:35', minutes: 20, tag: 'photography' },
      ],
    });
    expect(data.tasks.map((t: any) => t.title)).toEqual([
      'Calc 3 problems',
      'SAT module',
      'Photo walk',
      'Tonight wrap-up',
      'Ask teacher about quiz',
    ]);
    expect(data.tasks[0]).toMatchObject({ start: '15:30', minutes: 25 });
    expect(data.tasks[0].notes).toContain('If 3:30');
    expect(data.tasks[3]).toMatchObject({ start: null, minutes: null, notes: null });
  });

  it('slots a newly added timed task into clock order', async () => {
    await tool('set_daily_plan', { tasks: [{ title: 'Early', start: '15:00' }, { title: 'Late', start: '18:00' }] });
    await tool('add_task', { title: 'Middle', start: '16:30', minutes: 30 });
    const list = await tool('list_tasks', {});
    expect(list.data.tasks.map((t: any) => t.title)).toEqual(['Early', 'Middle', 'Late']);
  });

  it('sets and clears time, length and notes with update_task', async () => {
    const { data } = await tool('add_task', { title: 'Essay' });
    const id = data.added.id;
    const set = await tool('update_task', { id, start: '19:00', minutes: 45, notes: 'Write the intro' });
    expect(set.data.updated).toMatchObject({ start: '19:00', minutes: 45, notes: 'Write the intro' });

    const cleared = await tool('update_task', { id, start: null, minutes: null, notes: null });
    expect(cleared.data.updated).toMatchObject({ start: null, minutes: null, notes: null });
    const titleOnly = await tool('update_task', { id, title: 'Essay v2' });
    expect(titleOnly.data.updated).toMatchObject({ title: 'Essay v2', start: null });
  });

  it('keeps time and notes when only done changes', async () => {
    const { data } = await tool('set_daily_plan', { tasks: [{ title: 'A', start: '15:30', minutes: 20, notes: 'n' }] });
    const done = await tool('update_task', { id: data.tasks[0].id, done: true });
    expect(done.data.updated).toMatchObject({ start: '15:30', minutes: 20, notes: 'n', done: true });
  });

  it('keeps done state across a re-publish even when times change', async () => {
    const first = await tool('set_daily_plan', { tasks: [{ title: 'Calc 3', start: '15:30' }] });
    await tool('update_task', { id: first.data.tasks[0].id, done: true });
    const again = await tool('set_daily_plan', { tasks: [{ title: 'Calc 3', start: '16:00', minutes: 30 }] });
    expect(again.data.tasks[0]).toMatchObject({ start: '16:00', minutes: 30, done: true });
  });

  it('rejects bad times, lengths and notes as tool errors', async () => {
    for (const bad of ['3:30pm', '24:00', '15:60', '1530', 1530]) {
      expect((await tool('add_task', { title: 'x', start: bad })).isError).toBe(true);
    }
    for (const bad of [0, -5, 1.5, 1441, '30']) {
      expect((await tool('add_task', { title: 'x', minutes: bad })).isError).toBe(true);
    }
    expect((await tool('add_task', { title: 'x', notes: 'n'.repeat(1001) })).isError).toBe(true);
    expect((await tool('add_task', { title: 'x', notes: 5 })).isError).toBe(true);
    const bad = await tool('set_daily_plan', { tasks: [{ title: 'ok', start: '99:99' }] });
    expect(bad.isError).toBe(true);
    expect(bad.text).toContain('HH:MM');
  });

  it('treats blank notes and start as absent', async () => {
    const { data } = await tool('add_task', { title: 'x', notes: '   ', start: '' });
    expect(data.added).toMatchObject({ notes: null, start: null });
  });

  it('exposes the new fields in tools/list', async () => {
    const { body } = await rpc('tools/list');
    const setPlan = body.result.tools.find((t: any) => t.name === 'set_daily_plan');
    expect(Object.keys(setPlan.inputSchema.properties.tasks.items.properties)).toEqual([
      'title', 'tag', 'start', 'minutes', 'notes', 'siteKey',
    ]);
  });

  it('serves and patches them over REST for the app', async () => {
    const { data } = await tool('set_daily_plan', { tasks: [{ title: 'A', start: '15:30', minutes: 25, notes: 'go' }] });
    const list = (await (await call('/api/tasks')).json()) as any;
    expect(list.tasks[0]).toMatchObject({ start: '15:30', minutes: 25, notes: 'go' });
    const patch = await call(`/api/tasks/${data.tasks[0].id}`, { method: 'PATCH', body: JSON.stringify({ start: '16:00' }) });
    expect(((await patch.json()) as any).start).toBe('16:00');
    const bad = await call(`/api/tasks/${data.tasks[0].id}`, { method: 'PATCH', body: JSON.stringify({ start: 'noon' }) });
    expect(bad.status).toBe(400);
  });
});

describe('history', () => {
  async function plan(date: string, titles: string[], doneTitles: string[] = []) {
    const { data } = await tool('set_daily_plan', {
      date,
      tasks: titles.map((title, i) => ({ title, tag: 'sat', start: `1${5 + i}:00`, minutes: 30 })),
    });
    for (const t of data.tasks) {
      if (doneTitles.includes(t.title)) await tool('update_task', { id: t.id, done: true });
    }
  }

  beforeEach(async () => {
    await plan('2026-09-28', ['Mon A', 'Mon B'], ['Mon A', 'Mon B']);
    await plan('2026-09-30', ['Wed A', 'Wed B', 'Wed C'], ['Wed A']);
    await plan('2026-10-01', ['Thu A'], []);
    await plan('2026-10-05', ['Future A'], []); // after "today": never shown
  });

  it('shows what was done and missed, oldest first, skipping empty days', async () => {
    const { data } = await tool('get_history', {});
    expect(data).toMatchObject({ from: '2026-09-25', through: '2026-10-01', done: 3, total: 6 });
    expect(data.days.map((d: any) => [d.date, d.done, d.total])).toEqual([
      ['2026-09-28', 2, 2],
      ['2026-09-30', 1, 3],
      ['2026-10-01', 0, 1],
    ]);
    const wed = data.days[1].tasks;
    expect(wed.map((t: any) => [t.title, t.done])).toEqual([['Wed A', true], ['Wed B', false], ['Wed C', false]]);
    expect(wed[0].completed).toMatch(/^\d{2}:\d{2}$/);
    expect(wed[1].completed).toBeNull();
    expect(wed[0]).toMatchObject({ tag: 'sat', start: '15:00', minutes: 30 });
    expect(JSON.stringify(data)).not.toContain('Future A');
  });

  it('honours days and through', async () => {
    const two = await tool('get_history', { days: 2 });
    expect(two.data.days.map((d: any) => d.date)).toEqual(['2026-09-30', '2026-10-01']);
    expect(two.data.from).toBe('2026-09-30');

    const later = await tool('get_history', { days: 3, through: '2026-10-05' });
    expect(later.data.days.map((d: any) => d.date)).toEqual(['2026-10-05']);
    const none = await tool('get_history', { days: 1, through: '2026-09-29' });
    expect(none.data).toMatchObject({ done: 0, total: 0, days: [] });
  });

  it('rejects bad arguments as tool errors', async () => {
    for (const args of [{ days: 0 }, { days: 32 }, { days: 1.5 }, { days: '7' }, { through: 'yesterday' }, { through: '2026-02-31' }]) {
      expect((await tool('get_history', args)).isError).toBe(true);
    }
  });

  it('puts the check-off time on list_tasks too', async () => {
    const day = await tool('list_tasks', { date: '2026-09-28' });
    expect(day.data.tasks[0].completed).toMatch(/^\d{2}:\d{2}$/);
    const undone = await tool('list_tasks', { date: '2026-10-01' });
    expect(undone.data.tasks[0].completed).toBeNull();
  });
});

describe('check-off timing', () => {
  // 2026-10-01 is PDT (UTC-7): local h:m on that day (+ dayOffset) as epoch ms.
  const at = (h: number, m: number, dayOffset = 0) => Date.UTC(2026, 9, 1 + dayOffset, h + 7, m);
  const plan = (tasks: object[]) => tool('set_daily_plan', { tasks });
  const tick = async (id: string, ms: number) => {
    store.clock = () => ms;
    await tool('update_task', { id, done: true });
  };
  const hist = async () => (await tool('get_history', { days: 1 })).data.days[0];

  const threeBlocks = () =>
    plan([
      { title: 'A', start: '15:30', minutes: 25 }, // ends 15:55
      { title: 'B', start: '16:00', minutes: 30 }, // ends 16:30
      { title: 'C', start: '17:00', minutes: 20 }, // ends 17:20
    ]);

  it('reports lateness per task and a day summary, flagging out-of-order work', async () => {
    const { data } = await threeBlocks();
    const id = (t: string) => data.tasks.find((x: any) => x.title === t).id;
    await tick(id('B'), at(16, 50)); // 20 min after B's planned end
    await tick(id('A'), at(17, 10)); // 75 min after A's planned end, and after B

    const day = await hist();
    const byTitle = Object.fromEntries(day.tasks.map((t: any) => [t.title, t]));
    expect(byTitle.B).toMatchObject({ completed: '16:50', completed_at: '2026-10-01 16:50', late_min: 20 });
    expect(byTitle.A).toMatchObject({ completed: '17:10', completed_at: '2026-10-01 17:10', late_min: 75 });
    expect(byTitle.C).toMatchObject({ completed: null, completed_at: null, late_min: null });
    expect(day.timing).toEqual({
      first_done: '16:50',
      last_done: '17:10',
      avg_late_min: 48, // (20 + 75) / 2, rounded
      max_late_min: 75,
      out_of_order: [
        { title: 'A', planned_position: 1, done_position: 2 },
        { title: 'B', planned_position: 2, done_position: 1 },
      ],
      ticked_in_bulk: false,
    });

    // list_tasks carries the same facts for the plan
    const list = (await tool('list_tasks', {})).data;
    expect(list.timing).toEqual(day.timing);
    expect(list.tasks.find((t: any) => t.title === 'A')).toMatchObject({ completed_at: '2026-10-01 17:10', late_min: 75 });
  });

  it('shows early check-offs as negative and in-order work as clean', async () => {
    const { data } = await threeBlocks();
    await tick(data.tasks[0].id, at(15, 45)); // 10 min before A's planned end
    await tick(data.tasks[1].id, at(16, 30)); // exactly on time
    const day = await hist();
    expect(day.tasks.map((t: any) => t.late_min)).toEqual([-10, 0, null]);
    expect(day.timing).toMatchObject({ avg_late_min: -5, max_late_min: 0, out_of_order: [], ticked_in_bulk: false });
  });

  it('keeps a tick after midnight tied to the plan day', async () => {
    const { data } = await plan([{ title: 'Late night', start: '22:00', minutes: 30 }]);
    await tick(data.tasks[0].id, at(0, 30, 1)); // 00:30 the next morning
    const t = (await hist()).tasks[0];
    expect(t).toMatchObject({ completed: '00:30', completed_at: '2026-10-02 00:30', late_min: 120 });
  });

  it('flags bulk ticking: 3+ check-offs within 10 minutes', async () => {
    const { data } = await plan([{ title: 'A' }, { title: 'B' }, { title: 'C' }, { title: 'D' }]);
    const ids = data.tasks.map((t: any) => t.id);
    await tick(ids[0], at(22, 0));
    await tick(ids[1], at(22, 3));
    expect((await hist()).timing.ticked_in_bulk).toBe(false); // two is not a batch
    await tick(ids[2], at(22, 6));
    expect((await hist()).timing.ticked_in_bulk).toBe(true);
  });

  it('does not call spread-out ticks a batch', async () => {
    const { data } = await plan([{ title: 'A' }, { title: 'B' }, { title: 'C' }]);
    await tick(data.tasks[0].id, at(16, 0));
    await tick(data.tasks[1].id, at(16, 30));
    await tick(data.tasks[2].id, at(17, 0));
    expect((await hist()).timing.ticked_in_bulk).toBe(false);
  });

  it('has no lateness for tasks without a start and length, but still gives the order and span', async () => {
    const { data } = await plan([{ title: 'Untimed' }, { title: 'No length', start: '16:00' }]);
    await tick(data.tasks[1].id, at(16, 40));
    const day = await hist();
    expect(day.tasks.map((t: any) => t.late_min)).toEqual([null, null]);
    expect(day.timing).toMatchObject({ first_done: '16:40', last_done: '16:40', avg_late_min: null, max_late_min: null });
  });

  it('leaves timing out until something is done, and clears it when unticked', async () => {
    const { data } = await threeBlocks();
    expect((await hist()).timing).toBeUndefined();
    expect((await tool('list_tasks', {})).data.timing).toBeUndefined();
    await tick(data.tasks[0].id, at(16, 0));
    expect((await hist()).timing).toBeDefined();
    await tool('update_task', { id: data.tasks[0].id, done: false });
    const day = await hist();
    expect(day.timing).toBeUndefined();
    expect(day.tasks[0]).toMatchObject({ completed_at: null, late_min: null });
  });

  it('measures each plan separately', async () => {
    const a = await tool('set_daily_plan', { plan: 'A', tasks: [{ title: 'A1', start: '15:30', minutes: 20 }] });
    const b = await tool('set_daily_plan', { plan: 'B', tasks: [{ title: 'B1', start: '16:30', minutes: 20 }] });
    await tick(b.data.tasks[0].id, at(17, 0)); // 10 min late against B's own times
    const day = await hist();
    expect(day).toMatchObject({ plan: 'B' });
    expect(day.tasks[0].late_min).toBe(10);
    expect((await tool('list_tasks', { plan: 'A' })).data.timing).toBeUndefined();
    expect(a.data.plan).toBe('A');
  });
});

describe('day info (headline + sections)', () => {
  const sections = [
    { title: 'Warnings', body: '- SAT date mismatch\n- Dr Dish still blocked', front: true },
    { title: 'Pre-start', body: '- phone away\n- water', front: true },
    { title: 'Next PCB work', body: 'Sun: Dr Dish bench session' },
  ];

  it('publishes info and the app sees it next to the tasks', async () => {
    await tool('set_daily_plan', { tasks: [{ title: 'Calc 3', start: '15:30' }] });
    const set = await tool('set_day_info', { headline: 'Finish PLTW, then SAT practice', sections });
    expect(set.data.date).toBe('2026-10-01');
    expect(set.data.sections).toEqual([{ title: 'Warnings' }, { title: 'Pre-start' }, { title: 'Next PCB work' }]);

    const rest = (await (await call('/api/tasks')).json()) as any;
    expect(rest.headline).toBe('Finish PLTW, then SAT practice');
    expect(rest.sections).toHaveLength(3);
    // `front` from older callers is accepted but dropped: every section is a button now.
    expect(rest.sections[0]).toEqual({ title: 'Warnings', body: '- SAT date mismatch\n- Dr Dish still blocked' });
    expect(rest.sections.map((s: any) => s.front)).toEqual([undefined, undefined, undefined]);
    expect(rest.tasks).toHaveLength(1);
  });

  it('replaces the previous info and keeps days separate', async () => {
    await tool('set_day_info', { headline: 'old', sections });
    await tool('set_day_info', { date: '2026-10-05', headline: 'other day' });
    await tool('set_day_info', { headline: 'new' });
    const today = (await (await call('/api/tasks')).json()) as any;
    expect(today.headline).toBe('new');
    expect(today.sections).toEqual([]);
    const other = (await (await call('/api/tasks?date=2026-10-05')).json()) as any;
    expect(other.headline).toBe('other day');
  });

  it('clears the day when called with nothing', async () => {
    await tool('set_day_info', { headline: 'x', sections });
    await tool('set_day_info', {});
    const rest = (await (await call('/api/tasks')).json()) as any;
    expect(rest).toMatchObject({ headline: null, sections: [] });
  });

  it('is independent of set_daily_plan', async () => {
    await tool('set_day_info', { headline: 'keep me', sections });
    await tool('set_daily_plan', { tasks: [{ title: 'A' }] });
    await tool('set_daily_plan', { tasks: [] });
    expect(((await (await call('/api/tasks')).json()) as any).headline).toBe('keep me');
  });

  it('returns null headline and no sections when nothing was written', async () => {
    const rest = (await (await call('/api/tasks')).json()) as any;
    expect(rest).toMatchObject({ headline: null, sections: [] });
  });

  it('rejects bad input as tool errors and leaves the old info alone', async () => {
    await tool('set_day_info', { headline: 'keep', sections });
    const bad: unknown[] = [
      { headline: 5 },
      { headline: 'h'.repeat(301) },
      { sections: 'nope' },
      { sections: [{ title: '', body: 'x' }] },
      { sections: [{ title: 'T', body: '   ' }] },
      { sections: [{ title: 'T'.repeat(61), body: 'x' }] },
      { sections: [{ title: 'T', body: 'x'.repeat(4001) }] },
      { sections: Array.from({ length: 13 }, () => ({ title: 'T', body: 'x' })) },
      { sections: [null] },
    ];
    for (const args of bad) expect((await tool('set_day_info', args)).isError).toBe(true);
    expect(((await (await call('/api/tasks')).json()) as any).headline).toBe('keep');
  });
});

describe('plan A and plan B', () => {
  const plan = (p: 'A' | 'B', titles: string[]) =>
    tool('set_daily_plan', { plan: p, tasks: titles.map((title, i) => ({ title, start: `1${5 + i}:30` })) });

  it('keeps two complete lists for one day and replaces them independently', async () => {
    await plan('A', ['A1', 'A2']);
    await plan('B', ['B1']);
    const a = await tool('list_tasks', {});
    expect(a.data).toMatchObject({ plan: 'A', total: 2 });
    expect(a.data.tasks.map((t: any) => t.title)).toEqual(['A1', 'A2']);
    expect(a.data.plans).toEqual([{ plan: 'A', done: 0, total: 2 }, { plan: 'B', done: 0, total: 1 }]);

    const b = await tool('list_tasks', { plan: 'B' });
    expect(b.data.tasks.map((t: any) => [t.title, t.plan])).toEqual([['B1', 'B']]);

    await plan('A', ['A3']); // replacing A leaves B alone
    expect((await tool('list_tasks', { plan: 'B' })).data.total).toBe(1);
    expect((await tool('list_tasks', {})).data.tasks.map((t: any) => t.title)).toEqual(['A3']);
    await plan('B', []); // clearing B leaves A alone
    expect((await tool('list_tasks', {})).data.total).toBe(1);
    expect((await tool('list_tasks', {})).data.plans).toEqual([{ plan: 'A', done: 0, total: 1 }]);
  });

  it('defaults to plan A, so single-plan days behave as before', async () => {
    const { data } = await tool('set_daily_plan', { tasks: [{ title: 'Only' }] });
    expect(data.plan).toBe('A');
    expect(data.tasks[0].plan).toBe('A');
    expect((await tool('add_task', { title: 'Extra' })).data.added.plan).toBe('A');
  });

  it('adds to a chosen plan and keeps check-offs per plan', async () => {
    await plan('A', ['Same title']);
    const b = await plan('B', ['Same title']);
    await tool('update_task', { id: b.data.tasks[0].id, done: true });
    expect((await tool('list_tasks', {})).data.done).toBe(0);
    expect((await tool('list_tasks', { plan: 'B' })).data.done).toBe(1);
    await tool('add_task', { plan: 'B', title: 'B extra' });
    expect((await tool('list_tasks', { plan: 'B' })).data.total).toBe(2);
    const again = await plan('B', ['Same title', 'New']); // B keeps its own check-off
    expect(again.data.tasks.map((t: any) => [t.title, t.done])).toEqual([['Same title', true], ['New', false]]);
  });

  it('rejects an unknown plan', async () => {
    expect((await tool('set_daily_plan', { plan: 'C', tasks: [] })).isError).toBe(true);
    expect((await tool('list_tasks', { plan: 'b' })).isError).toBe(true);
    expect((await tool('add_task', { plan: 'X', title: 'x' })).isError).toBe(true);
  });

  it('serves both plans to the app, A first, and lets a B task be checked off', async () => {
    await plan('B', ['B1']);
    await plan('A', ['A1']);
    const rest = (await (await call('/api/tasks')).json()) as any;
    expect(rest.tasks.map((t: any) => [t.plan, t.title])).toEqual([['A', 'A1'], ['B', 'B1']]);
    const res = await call(`/api/tasks/${rest.tasks[1].id}`, { method: 'PATCH', body: JSON.stringify({ done: true }) });
    expect((await res.json()) as any).toMatchObject({ plan: 'B', done: true });
    expect((await tool('list_tasks', { plan: 'A' })).data.done).toBe(0);
  });

  it('advertises the plan option on the tools that take it', async () => {
    const { body } = await rpc('tools/list');
    for (const name of ['set_daily_plan', 'list_tasks', 'add_task']) {
      const tool = body.result.tools.find((t: any) => t.name === name);
      expect(tool.inputSchema.properties.plan.enum, name).toEqual(['A', 'B']);
    }
  });

  describe('history follows the plan he worked', () => {
    const tick = async (p: 'A' | 'B', title: string) => {
      const { data } = await tool('list_tasks', { plan: p });
      await tool('update_task', { id: data.tasks.find((t: any) => t.title === title).id, done: true });
    };

    it('picks the plan with more check-offs and reports the other', async () => {
      await plan('A', ['A1', 'A2']);
      await plan('B', ['B1', 'B2', 'B3']);
      await tick('B', 'B1');
      await tick('B', 'B2');
      await tick('A', 'A1');
      const { data } = await tool('get_history', { days: 1 });
      expect(data.days[0]).toMatchObject({ plan: 'B', done: 2, total: 3, other_plan: { plan: 'A', done: 1, total: 2 } });
      expect(data.days[0].tasks.map((t: any) => t.title)).toEqual(['B1', 'B2', 'B3']);
      expect(data).toMatchObject({ done: 2, total: 3 }); // never double-counted
    });

    it('prefers A on a tie, and handles B-only days', async () => {
      await plan('A', ['A1']);
      await plan('B', ['B1']);
      expect((await tool('get_history', { days: 1 })).data.days[0]).toMatchObject({ plan: 'A', done: 0, total: 1 });
      await tool('set_daily_plan', { date: '2026-09-30', plan: 'B', tasks: [{ title: 'Only B' }] });
      const old = (await tool('get_history', { days: 2 })).data.days[0];
      expect(old).toMatchObject({ date: '2026-09-30', plan: 'B', total: 1 });
      expect(old.other_plan).toBeUndefined();
    });
  });
});

describe('rest api for the app', () => {
  it('lists tasks for a date and defaults to today', async () => {
    await tool('set_daily_plan', { tasks: [{ title: 'A', tag: 'sat' }] });
    const res = await call('/api/tasks?date=2026-10-01');
    const body = (await res.json()) as any;
    expect(body.date).toBe('2026-10-01');
    expect(body.tasks).toEqual([
      {
        id: expect.any(String),
        date: '2026-10-01',
        plan: 'A',
        title: 'A',
        tag: 'sat',
        start: null,
        minutes: null,
        notes: null,
        done: false,
        position: 0,
      },
    ]);
    expect(((await (await call('/api/tasks')).json()) as any).tasks).toHaveLength(1);
  });

  it('toggles completion and shows up in MCP list_tasks', async () => {
    const { data } = await tool('set_daily_plan', { tasks: [{ title: 'A' }] });
    const id = data.tasks[0].id;
    const patch = await call(`/api/tasks/${id}`, { method: 'PATCH', body: JSON.stringify({ done: true }) });
    expect(patch.status).toBe(200);
    expect(((await patch.json()) as any).done).toBe(true);
    expect((await tool('list_tasks', {})).data.done).toBe(1);

    await call(`/api/tasks/${id}`, { method: 'PATCH', body: JSON.stringify({ done: false }) });
    expect((await tool('list_tasks', {})).data.done).toBe(0);
  });

  it('validates input and handles unknown ids', async () => {
    expect((await call('/api/tasks?date=bad')).status).toBe(400);
    const badBody = await call('/api/tasks/x', { method: 'PATCH', body: JSON.stringify({ done: 'yes' }) });
    expect(badBody.status).toBe(400);
    const notJson = await call('/api/tasks/x', { method: 'PATCH', body: 'nope' });
    expect(notJson.status).toBe(400);
    const missing = await call('/api/tasks/ghost', { method: 'PATCH', body: JSON.stringify({ done: true }) });
    expect(missing.status).toBe(404);
    expect((await call('/api/tasks/ghost', { method: 'DELETE' })).status).toBe(404);
  });

  it('deletes tasks', async () => {
    const { data } = await tool('set_daily_plan', { tasks: [{ title: 'A' }] });
    const res = await call(`/api/tasks/${data.tasks[0].id}`, { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect((await tool('list_tasks', {})).data.total).toBe(0);
  });

  it('404s unknown routes without requiring auth', async () => {
    expect((await call('/nope', {}, null)).status).toBe(404);
  });
});
