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
    expect(set.data.sections).toEqual([
      { title: 'Warnings', front: true },
      { title: 'Pre-start', front: true },
      { title: 'Next PCB work', front: false },
    ]);

    const rest = (await (await call('/api/tasks')).json()) as any;
    expect(rest.headline).toBe('Finish PLTW, then SAT practice');
    expect(rest.sections).toHaveLength(3);
    expect(rest.sections[0]).toEqual({ title: 'Warnings', body: '- SAT date mismatch\n- Dr Dish still blocked', front: true });
    expect(rest.sections[2].front).toBe(false);
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
      { sections: [{ title: 'T', body: 'x', front: 'yes' }] },
      { sections: [{ title: 'T'.repeat(61), body: 'x' }] },
      { sections: [{ title: 'T', body: 'x'.repeat(4001) }] },
      { sections: Array.from({ length: 13 }, () => ({ title: 'T', body: 'x' })) },
      { sections: [null] },
    ];
    for (const args of bad) expect((await tool('set_day_info', args)).isError).toBe(true);
    expect(((await (await call('/api/tasks')).json()) as any).headline).toBe('keep');
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
