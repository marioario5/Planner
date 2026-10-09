import { beforeEach, describe, expect, it } from 'vitest';
import { plannerToday, todayIn } from '../src/dates';
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

describe('planner day rolls over at 4am', () => {
  const tz = 'America/Los_Angeles'; // PDT, UTC-7, on these dates
  const pdt = (day: number, h: number, m: number) => new Date(Date.UTC(2026, 9, day, h + 7, m));

  it('keeps the small hours on the previous day and flips at 04:00', () => {
    expect(plannerToday(tz, pdt(1, 23, 59))).toBe('2026-10-01');
    expect(plannerToday(tz, pdt(2, 0, 0))).toBe('2026-10-01'); // midnight
    expect(plannerToday(tz, pdt(2, 0, 30))).toBe('2026-10-01');
    expect(plannerToday(tz, pdt(2, 3, 59))).toBe('2026-10-01');
    expect(plannerToday(tz, pdt(2, 4, 0))).toBe('2026-10-02');
    expect(plannerToday(tz, pdt(2, 15, 0))).toBe('2026-10-02'); // the 3pm routine run
  });

  it('applies to the default date of the MCP tools and the app API', async () => {
    const at0030 = pdt(2, 0, 30);
    const send = (path: string, init: RequestInit = {}) =>
      handleRequest(
        new Request(BASE + path, { ...init, headers: { Authorization: `Bearer ${TOKEN}`, ...(init.headers as object) } }),
        env,
        store,
        at0030,
      );
    const mcp = async (name: string, args: object) => {
      const res = await send('/mcp', {
        method: 'POST',
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
      });
      return JSON.parse(((await res.json()) as any).result.content[0].text);
    };

    // At 00:30 on Oct 2, "today" is still Oct 1.
    expect((await mcp('set_daily_plan', { tasks: [{ title: 'Late night work' }] })).date).toBe('2026-10-01');
    expect((await mcp('list_tasks', {})).tasks[0].title).toBe('Late night work');
    expect(((await (await send('/api/tasks')).json()) as any).date).toBe('2026-10-01');
    expect((await mcp('list_tasks', { date: '2026-10-02' })).total).toBe(0);
    const history = await mcp('get_history', { days: 1 });
    expect(history.through).toBe('2026-10-01');
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

  it('lists the sixteen tools with schemas', async () => {
    const { body } = await rpc('tools/list');
    expect(body.result.tools.map((t: any) => t.name)).toEqual([
      'set_daily_plan',
      'set_day_info',
      'list_tasks',
      'get_history',
      'get_habits',
      'set_habits',
      'set_experiments',
      'get_framework',
      'set_commitments',
      'defer_commitment',
      'get_user_notes',
      'set_user_notes',
      'delete_user_note',
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
      'title', 'tag', 'start', 'minutes', 'notes', 'siteKey', 'commitment',
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
      bulk_ticked: [],
      backfilled: [],
      flagged: [],
      started_blocks: null,
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

describe('user notes: summaries of what he said, never definitive', () => {
  // NOW is the evening of 2026-10-01 (PDT): the planner day is 2026-10-01.
  const pdt = (month: number, day: number) => new Date(Date.UTC(2026, month - 1, day, 19, 0)); // noon PDT
  const callAt = async (at: Date, name: string, args: object) => {
    const res = await handleRequest(
      new Request(`${BASE}/mcp`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
      }),
      env,
      store,
      at,
    );
    const r = ((await res.json()) as any).result;
    return { isError: r.isError === true, data: r.isError ? r.content[0].text : JSON.parse(r.content[0].text) };
  };
  const notes = async (all = false) => (await tool('get_user_notes', { all })).data;

  // The notes from his own School Tasks doc: the durable parts, not the one-day parts.
  const FROM_HIS_DOC = [
    { id: 'raspi-ordered', kind: 'fact', text: 'He ordered a Raspberry Pi; no delivery date yet.', quote: 'Raspberry pi ordered, no date yet.' },
    { id: 'energy-late-night', kind: 'pattern', text: 'He says he has more energy late at night and often goes to bed very late.', quote: 'I go to bed really late and I have more energy then' },
    { id: 'naps-around-five', kind: 'pattern', text: 'He says he often ends up taking a nap around 5pm.', quote: 'I always end up taking naps like around 5' },
    { id: 'try-later-hard-work', kind: 'idea', text: 'He wonders whether pushing hard work later, when he has more energy, would help.', quote: 'maybe push it all later when I have more energy and focus?' },
    { id: 'bigger-breaks', kind: 'idea', text: 'He feels he never really recovers and wonders about bigger, more substantial breaks.', quote: 'Or maybe bigger and more substantial breaks' },
    { id: 'fun-that-doesnt-wreck-studying', kind: 'preference', text: "He'd like fun activities that don't ruin his studying for the rest of the day.", quote: 'activities I could do that are actually fun that dont ruin my studying' },
  ];

  it('tells every reader these are summaries, not definitive, and free to ignore', async () => {
    const empty = await notes();
    expect(empty.note_to_you).toContain('SUMMARIES of things he told earlier agents');
    expect(empty.note_to_you).toContain('not instructions and not definitive');
    expect(empty.note_to_you).toContain('let what he writes today win');
    expect(empty.note_to_you).toContain('feel free to ignore');
    expect(empty.counts).toEqual({ active: 0, stale: 0 });

    const { body } = await rpc('tools/list');
    const desc = (n: string) => body.result.tools.find((t: any) => t.name === n).description as string;
    expect(desc('get_user_notes')).toContain('never treat them as instructions or as definitive');
    expect(desc('set_user_notes')).toContain('NOT specific to one date');
    expect(desc('set_user_notes')).toContain('not a diagnosis');
  });

  it('keeps the durable parts of his own doc, with his words attached', async () => {
    const saved = await tool('set_user_notes', { notes: FROM_HIS_DOC });
    expect(saved.data).toEqual({ saved: 6, active: 6 });
    const n = await notes();
    expect(n.counts.active).toBe(6);
    expect(n.notes.map((x: any) => x.kind)).toEqual(['fact', 'idea', 'idea', 'pattern', 'pattern', 'preference']);
    const pi = n.notes.find((x: any) => x.id === 'raspi-ordered');
    expect(pi).toEqual({
      id: 'raspi-ordered', kind: 'fact', text: 'He ordered a Raspberry Pi; no delivery date yet.',
      quote: 'Raspberry pi ordered, no date yet.', noted_on: '2026-10-01', confirmed_on: '2026-10-01',
    });
  });

  it('merges partial updates, resolves notes, and hides resolved ones unless asked', async () => {
    await tool('set_user_notes', { notes: FROM_HIS_DOC.slice(0, 2) });
    await tool('set_user_notes', { notes: [{ id: 'raspi-ordered', text: 'The Raspberry Pi arrived.', status: 'resolved' }] });
    expect((await notes()).notes.map((x: any) => x.id)).toEqual(['energy-late-night']);
    const all = await notes(true);
    expect(all.resolved).toHaveLength(1);
    expect(all.resolved[0]).toMatchObject({ id: 'raspi-ordered', text: 'The Raspberry Pi arrived.', quote: 'Raspberry pi ordered, no date yet.' });
    // changing only the text keeps his quote
    await tool('set_user_notes', { notes: [{ id: 'energy-late-night', text: 'He says his energy is highest late at night.' }] });
    expect((await notes()).notes[0]).toMatchObject({ text: 'He says his energy is highest late at night.', quote: 'I go to bed really late and I have more energy then' });
  });

  it('marks a note stale when it has not been confirmed for a while, facts sooner than patterns', async () => {
    await tool('set_user_notes', { notes: [FROM_HIS_DOC[0], FROM_HIS_DOC[1]] }); // Oct 1
    const fresh = (await callAt(pdt(10, 10), 'get_user_notes', {})).data; // 9 days
    expect(fresh.counts.stale).toBe(0);
    const later = (await callAt(pdt(10, 20), 'get_user_notes', {})).data; // 19 days
    expect(later.notes.find((x: any) => x.id === 'raspi-ordered').stale).toContain('not confirmed for 19 days');
    expect(later.notes.find((x: any) => x.id === 'energy-late-night').stale).toBeUndefined();
    expect(later.counts.stale).toBe(1);
    const muchLater = (await callAt(pdt(11, 20), 'get_user_notes', {})).data; // 50 days
    expect(muchLater.counts.stale).toBe(2);
  });

  it('re-confirms a note he said again, without changing it', async () => {
    await tool('set_user_notes', { notes: [FROM_HIS_DOC[0]] });
    await callAt(pdt(10, 20), 'set_user_notes', { notes: [{ id: 'raspi-ordered', confirmed: true }] });
    const n = (await callAt(pdt(10, 21), 'get_user_notes', {})).data;
    expect(n.notes[0]).toMatchObject({ noted_on: '2026-10-01', confirmed_on: '2026-10-20', text: 'He ordered a Raspberry Pi; no delivery date yet.' });
    expect(n.notes[0].stale).toBeUndefined();
  });

  it('deletes a note when he asks to forget it', async () => {
    await tool('set_user_notes', { notes: FROM_HIS_DOC.slice(0, 2) });
    expect((await tool('delete_user_note', { id: 'raspi-ordered' })).data).toEqual({ deleted: 'raspi-ordered' });
    expect((await notes(true)).notes.map((x: any) => x.id)).toEqual(['energy-late-night']);
    expect((await tool('delete_user_note', { id: 'raspi-ordered' })).isError).toBe(true);
    expect((await tool('delete_user_note', { id: 'Bad Id' })).isError).toBe(true);
  });

  it('rejects bad input, validating the whole batch before saving anything', async () => {
    await tool('set_user_notes', { notes: [FROM_HIS_DOC[0]] });
    const bad: unknown[] = [
      [{ id: 'Bad Id', kind: 'fact', text: 'x' }],
      [{ id: 'new-one', text: 'no kind' }],
      [{ id: 'new-one', kind: 'fact' }],
      [{ id: 'new-one', kind: 'opinion', text: 'x' }],
      [{ id: 'new-one', kind: 'fact', text: 'x'.repeat(301) }],
      [{ id: 'new-one', kind: 'fact', text: 'x', quote: 'q'.repeat(201) }],
      [{ id: 'raspi-ordered', status: 'archived' }],
      [{ id: 'raspi-ordered', text: '   ' }],
      Array.from({ length: 21 }, (_, i) => ({ id: `n-${i}`, kind: 'fact', text: 'x' })),
      'nope',
    ];
    for (const notesArg of bad) expect((await tool('set_user_notes', { notes: notesArg })).isError, JSON.stringify(notesArg).slice(0, 40)).toBe(true);
    // a bad entry in a batch leaves the good one unsaved
    const mixed = await tool('set_user_notes', { notes: [{ id: 'good-one', kind: 'fact', text: 'fine' }, { id: 'Bad Id', kind: 'fact', text: 'x' }] });
    expect(mixed.isError).toBe(true);
    expect((await notes()).notes.map((x: any) => x.id)).toEqual(['raspi-ordered']);
  });

  it('keeps the notes light: at most 30 active, and old resolved notes are pruned', async () => {
    const make = (from: number, to: number) => Array.from({ length: to - from }, (_, i) => ({ id: `n-${from + i}`, kind: 'fact', text: `note ${from + i}` }));
    expect((await tool('set_user_notes', { notes: make(0, 20) })).isError).toBe(false);
    expect((await tool('set_user_notes', { notes: make(20, 30) })).data.active).toBe(30);
    const over = await tool('set_user_notes', { notes: make(30, 31) });
    expect(over.isError).toBe(true);
    expect(over.text).toContain('keep at most 30');
    // resolving frees room; only the newest 20 resolved are kept
    const resolveAll = (ids: number[]) => ids.map((i) => ({ id: `n-${i}`, status: 'resolved' }));
    await tool('set_user_notes', { notes: resolveAll(Array.from({ length: 20 }, (_, i) => i)) });
    await tool('set_user_notes', { notes: resolveAll(Array.from({ length: 5 }, (_, i) => 20 + i)) });
    const n = await notes(true);
    expect(n.counts.active).toBe(5);
    expect(n.resolved.length).toBe(20); // 25 resolved, oldest 5 pruned
  });
});

describe('framework: suggestions, deferrals and the publish check', () => {
  // NOW is the evening of 2026-10-01 (PDT): the planner day is 2026-10-01.
  const propose = (commitments: object[], extra: object = {}) => tool('set_commitments', { commitments, ...extra });
  const framework = async (all = false) => (await tool('get_framework', { all })).data;

  it('tells every reader these are suggestions it is free to ignore, even on an empty framework', async () => {
    const f = await framework();
    expect(f.note_to_you).toContain('SUGGESTIONS from earlier planning runs');
    expect(f.note_to_you).toContain('free to follow, resize, split, defer or drop');
    expect(f.counts.open).toBe(0);
    expect(f.review_due).toBe(true);
    expect(f.review_hint).toContain('your call how much');
  });

  it('says in its tool descriptions that these are suggestions and the agent has freedom', async () => {
    const { body } = await rpc('tools/list');
    const desc = (n: string) => body.result.tools.find((t: any) => t.name === n).description as string;
    expect(desc('get_framework')).toContain('SUGGESTIONS from earlier planning runs');
    expect(desc('get_framework')).toContain('free to');
    expect(desc('get_framework')).toContain('never WHEN');
    expect(desc('set_commitments')).toContain('disagree');
    expect(desc('defer_commitment')).toContain('normal, respected choice');
  });

  it('stores rough commitments with the proposing agent\'s reasoning, and merges partial updates', async () => {
    const saved = await propose([
      { id: 'piq-7', title: 'PIQ 7 draft', due: '2026-10-20', target_minutes: 180, note: 'assumed 3 sessions of ~60 min, outline first' },
      { id: 'common-app', title: 'Common App essay', due: '2026-11-01', target_minutes: 300 },
    ]);
    expect(saved.data).toMatchObject({ saved: 2, open: 2, reviewed_on: null });
    await propose([{ id: 'piq-7', target_minutes: 240, note: null }]); // partial: title and due stay
    const items = (await framework(true)).all_open;
    expect(items.find((i: any) => i.id === 'piq-7')).toMatchObject({
      title: 'PIQ 7 draft', due: '2026-10-20', target_minutes: 240, note: null, proposed_on: '2026-10-01',
    });
  });

  it('notices in plain words when a suggestion looks like it is slipping, without calling it a violation', async () => {
    await propose([{ id: 'common-app', title: 'Common App essay', due: '2026-10-15', target_minutes: 300, start: '2026-09-20' }]);
    const f = await framework();
    expect(f.worth_a_look).toHaveLength(1);
    expect(f.worth_a_look[0].signals.join(' | ')).toContain('on a steady pace about 132 min would be done by now; 0 logged');
    expect(JSON.stringify(f.worth_a_look[0].signals)).not.toMatch(/must|violat|failed|should have/i);
  });

  it('reports a flagged suggestion the plan left out, but never blocks publishing', async () => {
    await propose([{ id: 'piq-7', title: 'PIQ 7 draft', due: '2026-10-02', target_minutes: 180 }]); // 180 min in 1 day: tight
    const left = await tool('set_daily_plan', { tasks: [{ title: 'Calc', minutes: 30, start: '15:30' }] });
    expect(left.isError).toBe(false); // published regardless
    expect(left.data.framework_check.not_in_todays_plan.map((i: any) => i.id)).toEqual(['piq-7']);
    expect(left.data.framework_check.hint).toContain('no penalty for disagreeing');
    expect(left.data.framework_check.hint).toContain("earlier agents' suggestions");

    const covered = await tool('set_daily_plan', { tasks: [{ title: 'PIQ 7 outline', minutes: 45, start: '15:30', commitment: 'piq-7' }] });
    expect(covered.data.framework_check?.not_in_todays_plan).toBeUndefined();
  });

  it('lets an agent leave something out on purpose, and keeps the reason for the next one', async () => {
    await propose([{ id: 'sat-prep', title: 'SAT prep push', due: '2026-10-03', target_minutes: 300 }], { reviewed: true });
    const deferred = await tool('defer_commitment', { id: 'sat-prep', until: '2026-10-05', reason: 'SAT taper: nothing new before the test' });
    expect(deferred.data).toMatchObject({ id: 'sat-prep', deferred_until: '2026-10-05' });

    const f = await framework();
    expect(f.worth_a_look).toEqual([]);
    expect(f.deferred[0]).toMatchObject({ id: 'sat-prep', deferred_until: '2026-10-05', deferred_reason: 'SAT taper: nothing new before the test' });
    expect(f.recent_choices[0]).toMatchObject({ commitment: 'sat-prep', action: 'defer', detail: 'until 2026-10-05: SAT taper: nothing new before the test' });
    const quiet = await tool('set_daily_plan', { tasks: [{ title: 'Calc' }] });
    expect(quiet.data.framework_check).toBeUndefined(); // deferred on purpose and reviewed: nothing to report

    expect((await tool('defer_commitment', { id: 'sat-prep', until: null, reason: 'plans changed' })).data.deferred_until).toBeNull();
    expect((await framework()).worth_a_look.map((i: any) => i.id)).toEqual(['sat-prep']);
  });

  it('limits deferrals to 14 days and requires a reason, so choices stay deliberate', async () => {
    await propose([{ id: 'a', title: 'A', due: '2026-10-20' }]);
    expect((await tool('defer_commitment', { id: 'a', until: '2026-10-20', reason: 'x' })).isError).toBe(true); // 19 days
    expect((await tool('defer_commitment', { id: 'a', until: '2026-10-15', reason: 'x' })).isError).toBe(false); // exactly 14
    expect((await tool('defer_commitment', { id: 'a', until: '2026-10-01', reason: 'x' })).isError).toBe(true); // not after today
    expect((await tool('defer_commitment', { id: 'a', until: '2026-10-05', reason: '   ' })).isError).toBe(true);
    expect((await tool('defer_commitment', { id: 'ghost', until: '2026-10-05', reason: 'x' })).isError).toBe(true);
    expect((await tool('defer_commitment', { id: 'a', until: 'soon', reason: 'x' })).isError).toBe(true);
  });

  it('lets the current agent close, resize or drop suggestions, and records closings', async () => {
    await propose([{ id: 'a', title: 'A', due: '2026-10-20' }, { id: 'b', title: 'B', due: '2026-10-21' }]);
    await propose([{ id: 'a', status: 'done', note: 'finished early' }, { id: 'b', status: 'dropped', note: 'no longer relevant' }], { reviewed: true });
    const f = await framework(true);
    expect(f.counts.open).toBe(0);
    expect(f.recent_choices.map((c: any) => `${c.action}:${c.commitment}`)).toEqual(['review:null', 'dropped:b', 'done:a']);
    expect(f.review_due).toBe(false);
    expect(f.reviewed_on).toBe('2026-10-01');
  });

  it('keeps the framework light: at most 25 open, validated as a whole before anything is saved', async () => {
    const many = Array.from({ length: 26 }, (_, i) => ({ id: `item-${i}`, title: `Item ${i}` }));
    expect((await propose(many.slice(0, 25))).isError).toBe(false);
    const over = await propose([{ id: 'one-more', title: 'One more' }]);
    expect(over.isError).toBe(true);
    expect(over.text).toContain('keep at most 25');
    // a bad entry in a batch leaves everything untouched
    const mixed = await propose([{ id: 'item-0', title: 'Renamed' }, { id: 'Bad Id', title: 'x' }]);
    expect(mixed.isError).toBe(true);
    expect((await framework(true)).all_open.find((i: any) => i.id === 'item-0').title).toBe('Item 0');
    for (const bad of [
      [{ id: 'new-one' }], // no title
      [{ id: 'x', title: 'x', due: '2026-02-31' }],
      [{ id: 'x', title: 'x', target_minutes: 2 }],
      [{ id: 'x', title: 'x', status: 'paused' }],
      [{ id: 'x', title: 'x', note: 'n'.repeat(301) }],
      'nope',
    ]) expect((await tool('set_commitments', { commitments: bad })).isError, JSON.stringify(bad)).toBe(true);
  });

  it('only lets tasks point at a commitment that exists and is open', async () => {
    await propose([{ id: 'real', title: 'Real' }, { id: 'gone', title: 'Gone', status: 'dropped' }]);
    const unknown = await tool('set_daily_plan', { tasks: [{ title: 'x', commitment: 'nope' }] });
    expect(unknown.isError).toBe(true);
    expect(unknown.text).toContain('create it first with set_commitments');
    expect((await tool('set_daily_plan', { tasks: [{ title: 'x', commitment: 'gone' }] })).isError).toBe(true);
    expect((await tool('add_task', { title: 'x', commitment: 'nope' })).isError).toBe(true);
    expect((await tool('set_daily_plan', { tasks: [{ title: 'x', commitment: 'Bad Id' }] })).isError).toBe(true);
    const ok = await tool('set_daily_plan', { tasks: [{ title: 'x', commitment: 'real' }] });
    expect(ok.data.tasks[0].commitment).toBe('real');
  });

  it('counts real progress from check-offs on linked tasks', async () => {
    await propose([{ id: 'piq-7', title: 'PIQ 7 draft', due: '2026-10-20', target_minutes: 180 }]);
    const plan = await tool('set_daily_plan', { tasks: [{ title: 'PIQ 7 outline', minutes: 45, commitment: 'piq-7' }, { title: 'PIQ 7 write', minutes: 60, commitment: 'piq-7' }] });
    await tool('update_task', { id: plan.data.tasks[0].id, done: true });
    const item = (await framework(true)).all_open[0];
    expect(item).toMatchObject({ done_minutes: 45, remaining_minutes: 135 });
  });

  it('does not nag about the framework when publishing a day that is not today', async () => {
    await propose([{ id: 'a', title: 'A', due: '2026-10-05' }]);
    const other = await tool('set_daily_plan', { date: '2026-10-09', tasks: [{ title: 'later' }] });
    expect(other.data.framework_check).toBeUndefined();
  });
});

describe('habits: statistics and notes', () => {
  // NOW is the evening of 2026-10-01 (PDT), so the planner day is Oct 1 and finished days are earlier.
  const tickedAt = (date: string, hhmm: string) => {
    const [y, mo, d] = date.split('-').map(Number);
    const [h, m] = hhmm.split(':').map(Number);
    return Date.UTC(y, mo - 1, d, h + 7, m);
  };
  const seedDay = async (date: string, tickCalc: string | null) => {
    const { data } = await tool('set_daily_plan', {
      date,
      tasks: [
        { title: 'Calc', tag: 'calculus3', start: '15:30', minutes: 25 },
        { title: 'SAT', tag: 'sat', start: '16:30', minutes: 30 }, // never ticked
      ],
    });
    if (tickCalc) {
      store.clock = () => tickedAt(date, tickCalc);
      await tool('update_task', { id: data.tasks[0].id, done: true });
    }
  };

  it('is honest when there is no data and no notes yet', async () => {
    const { data } = await tool('get_habits', {});
    expect(data.notes).toBeNull();
    expect(data.versions).toEqual([]);
    expect(data.stats).toMatchObject({ confidence: 'low', lateness_by_tag: {}, best_times: { weekday: null, weekend: null } });
    expect(data.stats.window.through).toBe('2026-09-30'); // finished days only: today (Oct 1) is excluded
  });

  it('computes statistics from the check-offs of finished days', async () => {
    for (const d of ['21', '22', '23', '24', '25']) await seedDay(`2026-09-${d}`, '16:05'); // Calc 10 min late
    await seedDay('2026-10-01', '16:05'); // today: not finished, must not count
    const { data } = await tool('get_habits', {});
    expect(data.stats.confidence).toBe('ok');
    expect(data.stats.window.days_with_tasks).toBe(5);
    expect(data.stats.lateness_by_tag.calculus3).toEqual({ n: 5, median_late_min: 10, avg_late_min: 10, on_time_pct: 100 });
    expect(data.stats.carry_over.by_tag.sat).toMatchObject({ planned: 5, missed: 5, done_on_day_pct: 0 });
    expect(data.stats.best_times.weekday).toMatchObject({ days: 5, median_first_done: '16:05' });
    // a shorter window drops the older days
    const recent = await tool('get_habits', { days: 7 });
    expect(recent.data.stats.window).toEqual({ from: '2026-09-24', through: '2026-09-30', days_with_tasks: 2 });
    expect(recent.data.stats.confidence).toBe('low');
  });

  it('keeps versions of the notes, newest first, and can read an old one', async () => {
    const first = await tool('set_habits', { notes: 'SAT blocks run ~30 min late (n=5, Sep 21-25).' });
    expect(first.data).toMatchObject({ version: 1, chars: 'SAT blocks run ~30 min late (n=5, Sep 21-25).'.length });
    await tool('set_habits', { notes: 'Second draft.' });
    const { data } = await tool('get_habits', {});
    expect(data.notes).toMatchObject({ version: 2, text: 'Second draft.' });
    expect(data.versions.map((v: any) => v.version)).toEqual([2, 1]);
    const old = await tool('get_habits', { version: 1 });
    expect(old.data).toEqual({ notes: expect.objectContaining({ version: 1, text: 'SAT blocks run ~30 min late (n=5, Sep 21-25).' }) });
  });

  it('keeps only the last 10 versions', async () => {
    for (let i = 1; i <= 12; i++) await tool('set_habits', { notes: `draft ${i}` });
    const { data } = await tool('get_habits', {});
    expect(data.versions.map((v: any) => v.version)).toEqual([12, 11, 10, 9, 8, 7, 6, 5, 4, 3]);
    expect((await tool('get_habits', { version: 1 })).isError).toBe(true);
    expect(data.notes.text).toBe('draft 12');
  });

  it('rejects bad input without saving anything', async () => {
    await tool('set_habits', { notes: 'keep me' });
    for (const notes of ['', '   ', 5, null, 'x'.repeat(6001)]) {
      expect((await tool('set_habits', { notes })).isError, String(notes).slice(0, 10)).toBe(true);
    }
    expect((await tool('set_habits', { notes: 'x'.repeat(6000) })).isError).toBe(false); // exactly at the limit
    for (const days of [3, 91, 7.5, '28']) expect((await tool('get_habits', { days })).isError, String(days)).toBe(true);
    for (const version of [0, -1, 1.5, 'one', 99]) expect((await tool('get_habits', { version })).isError, String(version)).toBe(true);
    expect((await tool('get_habits', {})).data.versions.map((v: any) => v.version)).toEqual([2, 1]);
  });

  it('advertises read-only get_habits and a notes limit on set_habits', async () => {
    const { body } = await rpc('tools/list');
    const tools = Object.fromEntries(body.result.tools.map((t: any) => [t.name, t]));
    expect(tools.get_habits.annotations.readOnlyHint).toBe(true);
    expect(tools.set_habits.inputSchema.properties.notes.maxLength).toBe(6000);
    expect(tools.set_habits.inputSchema.required).toEqual(['notes']);
  });
});

describe('batch ticks: only the batch is withheld', () => {
  // 2026-10-01 is PDT (UTC-7): local h:m on that day as epoch ms.
  const at = (h: number, m: number) => Date.UTC(2026, 9, 1, h + 7, m);
  const tickAt = async (id: string, ms: number) => {
    store.clock = () => ms;
    await tool('update_task', { id, done: true });
  };
  const day = async () => (await tool('get_history', { days: 1 })).data.days[0];

  // The shape of a real day: a few ticks made as the work happened, and four ticked together at 20:55.
  const realisticDay = async () => {
    const { data } = await tool('set_daily_plan', {
      tasks: [
        { title: 'SAT test', start: '10:00', minutes: 145 }, // ends 12:25
        { title: 'Lunch', start: '12:25', minutes: 65 }, // ends 13:30
        { title: 'Gov', start: '13:30', minutes: 35 }, // ends 14:05
        { title: 'Calc learn', start: '14:15', minutes: 30 }, // ends 14:45
        { title: 'Bench', start: '15:45', minutes: 120 }, // ends 17:45
        { title: 'Photo', start: '17:50', minutes: 20 }, // ends 18:10
        { title: 'Dinner', start: '19:30', minutes: 30 }, // ends 20:00
      ],
    });
    const id = (t: string) => data.tasks.find((x: any) => x.title === t).id;
    await tickAt(id('Bench'), at(17, 50)); // 5 min late
    await tickAt(id('Photo'), at(18, 47)); // 37 min late
    for (const t of ['SAT test', 'Lunch', 'Gov', 'Dinner']) await tickAt(id(t), at(20, 55)); // a batch
    await tickAt(id('Calc learn'), at(23, 11)); // 506 min late, but ticked alone
  };

  it('withholds lateness and order for the batch but keeps every other tick that day', async () => {
    await realisticDay();
    const d = await day();
    const byTitle = Object.fromEntries(d.tasks.map((t: any) => [t.title, t]));
    for (const t of ['SAT test', 'Lunch', 'Gov', 'Dinner']) {
      expect(byTitle[t], t).toMatchObject({ late_min: null, bulk_ticked: true, completed: '20:55' });
    }
    expect(byTitle.Bench).toMatchObject({ late_min: 5, bulk_ticked: false });
    expect(byTitle.Photo).toMatchObject({ late_min: 37, bulk_ticked: false });
    expect(byTitle['Calc learn']).toMatchObject({ late_min: 506, bulk_ticked: false });

    expect(d.timing).toEqual({
      first_done: '17:50',
      last_done: '23:11',
      avg_late_min: 183, // (506 + 5 + 37) / 3, the three trustworthy ticks
      max_late_min: 506,
      // order among the trustworthy ticks only: planned Calc, Bench, Photo; done Bench, Photo, Calc
      out_of_order: [
        { title: 'Calc learn', planned_position: 1, done_position: 3 },
        { title: 'Bench', planned_position: 2, done_position: 1 },
        { title: 'Photo', planned_position: 3, done_position: 2 },
      ],
      ticked_in_bulk: true,
      bulk_ticked: ['SAT test', 'Lunch', 'Gov', 'Dinner'],
      backfilled: [],
      flagged: [],
      started_blocks: null,
      note: 'Left out of the figures above: 4 ticked in a batch (their times show when he ticked, not when he worked).',
    });
  });

  it('shows the same on list_tasks', async () => {
    await realisticDay();
    const list = (await tool('list_tasks', {})).data;
    expect(list.timing.bulk_ticked).toHaveLength(4);
    expect(list.tasks.find((t: any) => t.title === 'Dinner')).toMatchObject({ late_min: null, bulk_ticked: true });
    expect(list.tasks.find((t: any) => t.title === 'Photo')).toMatchObject({ late_min: 37, bulk_ticked: false });
  });

  it('does not call two ticks a batch, but does call three', async () => {
    const { data } = await tool('set_daily_plan', {
      tasks: [
        { title: 'A', start: '15:00', minutes: 30 },
        { title: 'B', start: '15:30', minutes: 30 },
        { title: 'C', start: '16:00', minutes: 30 },
      ],
    });
    await tickAt(data.tasks[0].id, at(16, 30));
    await tickAt(data.tasks[1].id, at(16, 30));
    let d = await day();
    expect(d.tasks.map((t: any) => t.bulk_ticked)).toEqual([false, false, false]);
    expect(d.timing.ticked_in_bulk).toBe(false);
    expect(d.tasks[0].late_min).toBe(60);

    await tickAt(data.tasks[2].id, at(16, 35));
    d = await day();
    expect(d.tasks.map((t: any) => [t.bulk_ticked, t.late_min])).toEqual([[true, null], [true, null], [true, null]]);
    expect(d.timing).toMatchObject({
      first_done: null, last_done: null, avg_late_min: null, max_late_min: null, out_of_order: [],
      ticked_in_bulk: true, bulk_ticked: ['A', 'B', 'C'],
    });
  });

  it('does not treat ticks spread more than 10 minutes apart as a batch', async () => {
    const { data } = await tool('set_daily_plan', { tasks: [{ title: 'A', start: '15:00', minutes: 30 }, { title: 'B', start: '15:30', minutes: 30 }, { title: 'C', start: '16:00', minutes: 30 }] });
    await tickAt(data.tasks[0].id, at(22, 0));
    await tickAt(data.tasks[1].id, at(22, 6));
    await tickAt(data.tasks[2].id, at(22, 12)); // 12 minutes from the first
    expect((await day()).timing.ticked_in_bulk).toBe(false);
  });

  it('leaves a lone tick the same day untouched when a batch happens around it', async () => {
    const { data } = await tool('set_daily_plan', { tasks: Array.from({ length: 5 }, (_, i) => ({ title: `T${i}`, start: `1${i}:00`, minutes: 30 })) });
    await tickAt(data.tasks[0].id, at(10, 40)); // alone, 10 min late
    for (const i of [1, 2, 3]) await tickAt(data.tasks[i].id, at(21, i)); // a batch
    const d = await day();
    expect(d.tasks[0]).toMatchObject({ late_min: 10, bulk_ticked: false });
    expect(d.timing).toMatchObject({ first_done: '10:40', last_done: '10:40', avg_late_min: 10, bulk_ticked: ['T1', 'T2', 'T3'] });
  });
});

describe('backfilled ticks and reported finish times', () => {
  // 2026-10-01 is PDT (UTC-7): local h:m on that day (+ dayOffset) as epoch ms.
  const at = (h: number, m: number, dayOffset = 0) => Date.UTC(2026, 9, 1 + dayOffset, h + 7, m);
  const plan = (tasks: object[]) => tool('set_daily_plan', { tasks });
  const blocks = () =>
    plan([
      { title: 'A', start: '15:30', minutes: 25 }, // ends 15:55
      { title: 'B', start: '16:00', minutes: 30 },
      { title: 'C', start: '17:00', minutes: 20 },
    ]);
  const tickAt = async (id: string, ms: number, extra: object = {}) => {
    store.clock = () => ms;
    return tool('update_task', { id, done: true, ...extra });
  };
  const firstDay = async () => (await tool('get_history', { days: 1 })).data.days[0];

  it('treats a tick after the planner day ended (04:00) as a backfill, not a late finish', async () => {
    const { data } = await blocks();
    await tickAt(data.tasks[0].id, at(10, 0, 1)); // 10am the next morning
    const day = await firstDay();
    expect(day.tasks[0]).toMatchObject({ completed_at: '2026-10-02 10:00', late_min: null, backfilled: true });
    expect(day.timing).toEqual({
      first_done: null,
      last_done: null,
      avg_late_min: null,
      max_late_min: null,
      out_of_order: [],
      ticked_in_bulk: false,
      bulk_ticked: [],
      backfilled: ['A'],
      flagged: [],
      started_blocks: null,
      note: 'Left out of the figures above: 1 ticked after the day ended.',
    });
  });

  it('uses 04:00 as the exact boundary', async () => {
    const { data } = await blocks();
    await tickAt(data.tasks[0].id, at(3, 59, 1));
    await tickAt(data.tasks[1].id, at(4, 0, 1));
    const byTitle = Object.fromEntries((await firstDay()).tasks.map((t: any) => [t.title, t]));
    expect(byTitle.A).toMatchObject({ backfilled: false, late_min: 1440 + 239 - 955 });
    expect(byTitle.B).toMatchObject({ backfilled: true, late_min: null });
  });

  it('keeps backfills out of the statistics but still lists them', async () => {
    const { data } = await blocks();
    await tickAt(data.tasks[0].id, at(16, 0)); // 5 min late
    await tickAt(data.tasks[1].id, at(10, 0, 1)); // backfilled
    await tickAt(data.tasks[2].id, at(17, 30)); // 10 min late
    const { timing } = await firstDay();
    expect(timing).toMatchObject({
      first_done: '16:00',
      last_done: '17:30',
      avg_late_min: 8, // (5 + 10) / 2, rounded
      max_late_min: 10,
      out_of_order: [],
      backfilled: ['B'],
    });
  });

  it('records the finish time he reports, not the moment of ticking', async () => {
    const { data } = await blocks();
    const res = await tickAt(data.tasks[0].id, at(10, 0, 1), { completed: '18:15' }); // ticked next morning
    expect(res.data.updated).toMatchObject({ completed: '18:15', completed_at: '2026-10-01 18:15', late_min: 140, backfilled: false });
    const day = await firstDay();
    expect(day.timing).toMatchObject({ first_done: '18:15', last_done: '18:15', avg_late_min: 140, backfilled: [] });
  });

  it('reads reported times before 04:00 as after midnight on that planner day', async () => {
    const { data } = await blocks();
    // Run the request at 10am the next morning, so 01:30 has already happened.
    store.clock = () => at(10, 0, 1);
    const res = await handleRequest(
      new Request(`${BASE}/mcp`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'update_task', arguments: { id: data.tasks[0].id, done: true, completed: '01:30' } },
        }),
      }),
      env,
      store,
      new Date(at(10, 0, 1)),
    );
    const updated = JSON.parse(((await res.json()) as any).result.content[0].text).updated;
    expect(updated).toMatchObject({ completed_at: '2026-10-02 01:30', backfilled: false });
  });

  it('rejects a bad, future, or misused finish time without changing the task', async () => {
    const { data } = await blocks();
    const id = data.tasks[0].id;
    // "now" for these requests is 22:30 on Oct 1
    for (const completed of ['6:15pm', '25:00', '18:75']) {
      expect((await tool('update_task', { id, done: true, completed })).isError, completed).toBe(true);
    }
    const future = await tool('update_task', { id, done: true, completed: '23:45' });
    expect(future.isError).toBe(true);
    expect(future.text).toContain("hasn't happened yet");
    expect((await tool('update_task', { id, completed: '18:00' })).isError).toBe(true); // no done
    expect((await tool('update_task', { id, done: false, completed: '18:00' })).isError).toBe(true);
    expect((await tool('update_task', { id: 'ghost', done: true, completed: '18:00' })).isError).toBe(true);
    expect((await tool('list_tasks', {})).data.done).toBe(0); // nothing got ticked
  });

  it('shows the new fields on list_tasks and advertises the argument', async () => {
    const { data } = await blocks();
    await tickAt(data.tasks[0].id, at(16, 0));
    expect((await tool('list_tasks', {})).data.tasks[0]).toMatchObject({ backfilled: false, late_min: 5 });
    const { body } = await rpc('tools/list');
    const props = body.result.tools.find((t: any) => t.name === 'update_task').inputSchema.properties;
    expect(new RegExp(props.completed.pattern).test('18:15')).toBe(true);
    expect(new RegExp(props.completed.pattern).test('6:15pm')).toBe(false);
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
    // no plan asked for: the one he followed (B has the tick); A explicitly still has none
    expect((await tool('list_tasks', {})).data.plan).toBe('B');
    expect((await tool('list_tasks', { plan: 'A' })).data.done).toBe(0);
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
        started: null,
        flagged: false,
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

describe('start button, flag and day rating (app API)', () => {
  const at = (h: number, m: number) => Date.UTC(2026, 9, 1, h + 7, m); // PDT, 2026-10-01
  const patch = async (id: string, body: object) => {
    const res = await call(`/api/tasks/${id}`, { method: 'PATCH', body: JSON.stringify(body) });
    return { status: res.status, data: (await res.json()) as any };
  };
  const makeTask = async () =>
    (await tool('set_daily_plan', { tasks: [{ title: 'Calc', start: '16:00', minutes: 40, tag: 'calculus3' }] })).data.tasks[0].id as string;

  it('records Start, keeps the first press, and clears it on request', async () => {
    const id = await makeTask();
    store.clock = () => at(16, 20);
    const first = await patch(id, { started: true });
    expect(first.data).toMatchObject({ started: '2026-10-01T23:20:00.000Z', flagged: false });
    store.clock = () => at(16, 50);
    expect((await patch(id, { started: true })).data.started).toBe('2026-10-01T23:20:00.000Z'); // unchanged
    expect((await patch(id, { started: false })).data.started).toBeNull();
  });

  it('turns Start + finish into a real duration, and a flag hides the timing', async () => {
    const id = await makeTask();
    store.clock = () => at(16, 20);
    await patch(id, { started: true });
    store.clock = () => at(17, 20);
    await patch(id, { done: true });
    let task = (await tool('list_tasks', {})).data.tasks[0];
    expect(task).toMatchObject({ started: '16:20', actual_min: 60, start_delay_min: 20, late_min: 40, flagged: false });

    await patch(id, { flagged: true });
    task = (await tool('list_tasks', {})).data.tasks[0];
    expect(task).toMatchObject({ flagged: true, started: null, actual_min: null, start_delay_min: null, late_min: null });
    expect((await tool('list_tasks', {})).data.timing.flagged).toEqual(['Calc']);

    await patch(id, { flagged: false });
    expect((await tool('list_tasks', {})).data.tasks[0]).toMatchObject({ flagged: false, actual_min: 60 });
  });

  it('keeps Start and flag when the day is re-published with the same title', async () => {
    const id = await makeTask();
    await patch(id, { started: true });
    await patch(id, { flagged: true });
    await makeTask();
    expect((await tool('list_tasks', {})).data.tasks[0]).toMatchObject({ flagged: true });
    const api = await (await call('/api/tasks')).json();
    expect((api as any).tasks[0]).toMatchObject({ flagged: true, started: expect.any(String) });
  });

  it('unticking a task starts it over: the Start press is cleared, a flag stays', async () => {
    const id = await makeTask();
    store.clock = () => at(16, 20);
    await patch(id, { started: true });
    await patch(id, { flagged: true });
    store.clock = () => at(17, 0);
    await patch(id, { done: true });
    expect((await tool('list_tasks', {})).data.tasks[0].done).toBe(true);
    const undone = await patch(id, { done: false });
    expect(undone.data).toMatchObject({ done: false, started: null, flagged: true });
    // pressing Start again after that begins a fresh timer
    store.clock = () => at(18, 0);
    expect((await patch(id, { started: true })).data.started).toBe('2026-10-02T01:00:00.000Z');
  });

  it('rejects a non-boolean started or flagged', async () => {
    const id = await makeTask();
    expect((await patch(id, { started: 'yes' })).status).toBe(400);
    expect((await patch(id, { flagged: 1 })).status).toBe(400);
  });

  it('stores one rating per day (1 to 5), returns it, and shows it in history', async () => {
    await makeTask();
    const put = (body: object) => call('/api/rating', { method: 'PUT', body: JSON.stringify(body) });
    expect(await (await put({ rating: 4 })).json()).toEqual({ date: '2026-10-01', rating: 4 });
    expect(((await (await call('/api/tasks')).json()) as any).rating).toBe(4);
    expect((await tool('get_history', { days: 1 })).data.days[0].rating).toBe(4);
    expect((await put({ rating: 6 })).status).toBe(400);
    expect((await put({ rating: 'great' })).status).toBe(400);
    expect((await put({})).status).toBe(400);
    expect(await (await put({ rating: null })).json()).toEqual({ date: '2026-10-01', rating: null });
    expect(((await (await call('/api/tasks')).json()) as any).rating).toBeNull();
  });
});

describe('experiments tool', () => {
  const set = (experiments: object[]) => tool('set_experiments', { experiments });
  const base = { id: 'calc-late', title: 'Calc 3 at 8pm', change: 'Move Calc 3 from 4pm to 8pm', measure: 'done_pct', tag: 'calculus3' };

  it('creates an experiment starting today and shows it in get_habits', async () => {
    expect((await set([base])).data).toEqual({ saved: 1, running: 1 });
    const h = (await tool('get_habits', {})).data;
    expect(h.experiments).toHaveLength(1);
    expect(h.experiments[0]).toMatchObject({ id: 'calc-late', status: 'running', started_on: '2026-10-01', tag: 'calculus3' });
    expect(h.experiments[0].note).toContain('Too early');
  });

  it('needs title, change and measure when new, and a result to close', async () => {
    expect((await set([{ id: 'x' }])).isError).toBe(true);
    await set([base]);
    expect((await set([{ id: 'calc-late', status: 'kept' }])).text).toContain('result');
    expect((await set([{ id: 'calc-late', status: 'kept', result: 'done 0% -> 80%' }])).data).toEqual({ saved: 1, running: 0 });
    expect((await tool('get_habits', {})).data.experiments[0]).toMatchObject({ status: 'kept', result: 'done 0% -> 80%' });
  });

  it('allows at most three running experiments, and validates fields', async () => {
    for (const id of ['a', 'b', 'c']) await set([{ ...base, id }]);
    const fourth = await set([{ ...base, id: 'd' }]);
    expect(fourth.isError).toBe(true);
    expect(fourth.text).toContain('one thing at a time');
    expect((await set([{ ...base, id: 'e', measure: 'vibes' }])).isError).toBe(true);
    expect((await set([{ ...base, id: 'f', tag: 'gym' }])).isError).toBe(true);
  });
});

describe('CORS for the planner website', () => {
  const SITE = 'https://marioario5.github.io';
  const send = (path: string, init: RequestInit = {}, withToken = true) => {
    const headers = new Headers(init.headers);
    if (withToken) headers.set('Authorization', `Bearer ${TOKEN}`);
    return handleRequest(new Request(BASE + path, { ...init, headers }), env, store, NOW);
  };

  it('answers a preflight from the site without a token, and lists what it allows', async () => {
    const res = await send('/api/tasks/abc', { method: 'OPTIONS', headers: { Origin: SITE, 'Access-Control-Request-Method': 'PATCH' } }, false);
    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe(SITE);
    expect(res.headers.get('Access-Control-Allow-Methods')).toContain('PATCH');
    expect(res.headers.get('Access-Control-Allow-Headers')).toContain('Authorization');
  });

  it('adds the origin header to real responses (also errors) for the site, and not for other sites', async () => {
    const ok = await send('/api/tasks', { headers: { Origin: SITE } });
    expect(ok.status).toBe(200);
    expect(ok.headers.get('Access-Control-Allow-Origin')).toBe(SITE);
    const denied = await send('/api/tasks', { headers: { Origin: SITE } }, false);
    expect(denied.status).toBe(401);
    expect(denied.headers.get('Access-Control-Allow-Origin')).toBe(SITE);

    const other = await send('/api/tasks', { headers: { Origin: 'https://evil.example' } });
    expect(other.headers.get('Access-Control-Allow-Origin')).toBeNull();
    const otherPre = await send('/api/tasks', { method: 'OPTIONS', headers: { Origin: 'https://evil.example' } }, false);
    expect(otherPre.headers.get('Access-Control-Allow-Origin')).toBeNull();
    expect((await send('/api/tasks')).headers.get('Access-Control-Allow-Origin')).toBeNull(); // no Origin: the phone app
  });

  it('keeps the rating endpoint and MCP out of the open: rating gets CORS, the token is still required', async () => {
    const res = await send('/api/rating', { method: 'PUT', headers: { Origin: SITE }, body: JSON.stringify({ rating: 3 }) });
    expect(res.status).toBe(200);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe(SITE);
    const noToken = await send('/api/rating', { method: 'PUT', headers: { Origin: SITE }, body: '{}' }, false);
    expect(noToken.status).toBe(401);
    const mcp = await send('/mcp', { method: 'OPTIONS', headers: { Origin: SITE } }, false);
    expect(mcp.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });

  it('can be pointed at other origins with ALLOWED_ORIGINS', async () => {
    const res = await handleRequest(
      new Request(BASE + '/api/tasks', { headers: { Authorization: `Bearer ${TOKEN}`, Origin: 'http://127.0.0.1:8080' } }),
      { ...env, ALLOWED_ORIGINS: 'http://127.0.0.1:8080, https://marioario5.github.io' },
      store,
      NOW,
    );
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('http://127.0.0.1:8080');
  });
});
