import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FirebaseSite, parseEntries, rowsOf } from '../src/firebase';
import { handleRequest } from '../src/index';
import { parsePrefixes, type SyncConfig } from '../src/sync';
import { FakeSite } from './fake-site';
import { MemoryTaskStore } from './memory-store';

const TOKEN = 'test-token-0123456789abcdef';
const NOW = new Date('2026-10-02T05:30:00Z'); // evening of 2026-10-01 in Los Angeles
const env = { API_TOKEN: TOKEN, PLANNER_TZ: 'America/Los_Angeles' };

const DAYS = { t: 7, value: { calc3: { rest: [1, 2], sig: '59x24:calc3-t5..calc3-t63' } } };
const initialState = () => ({
  tasks: [
    ['calc3-t5', 1, 1000],
    ['calc3-t6', 0, 1000],
    ['master-t1', 1, 1000],
  ],
  cal: [['2026-8-26|Some calendar item', 1, 5]],
  days: DAYS,
  at: 1,
});

let store: MemoryTaskStore;
let site: FakeSite;
let sync: SyncConfig;

beforeEach(() => {
  store = new MemoryTaskStore();
  site = new FakeSite(initialState());
  sync = { site, prefixes: ['calc3-'] };
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

// Pass `null` to run with site sync switched off (undefined would pick the default).
function api(path: string, init: RequestInit = {}, cfg: SyncConfig | null = sync) {
  const headers = new Headers(init.headers);
  headers.set('Authorization', `Bearer ${TOKEN}`);
  return handleRequest(new Request(`https://planner.test${path}`, { ...init, headers }), env, store, NOW, cfg ?? undefined);
}

let rpcId = 0;
async function tool(name: string, args: unknown, cfg: SyncConfig | null = sync) {
  const res = await api('/mcp', { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name, arguments: args } }) }, cfg);
  const body = (await res.json()) as any;
  const text: string = body.result.content[0].text;
  const isError = body.result.isError === true;
  return { isError, text, data: isError ? null : JSON.parse(text) };
}

const patch = (id: string, body: unknown) => api(`/api/tasks/${id}`, { method: 'PATCH', body: JSON.stringify(body) });
const publish = (tasks: unknown[]) => tool('set_daily_plan', { tasks });
const rest = async () => ((await (await api('/api/tasks')).json()) as any).tasks;

describe('site -> planner', () => {
  it('a lesson already ticked on the site arrives ticked, without writing to the site', async () => {
    const { data } = await publish([{ title: 'Calc 3 lesson', tag: 'calculus3', siteKey: 'calc3-t5' }]);
    expect(data.tasks[0]).toMatchObject({ done: true, siteKey: 'calc3-t5' });
    expect(data.tasks[0].completed).toMatch(/^\d{2}:\d{2}$/);
    expect(site.writes).toBe(0);
  });

  it('a newer site change wins over an older planner change, both ways', async () => {
    store.clock = () => 5000;
    const { data } = await publish([{ title: 'Calc 3 lesson', siteKey: 'calc3-t6' }]);
    await patch(data.tasks[0].id, { done: true }); // planner ticks at t=5000, pushed
    expect(site.entry('calc3-t6')).toEqual(['calc3-t6', 1, 5000]);

    site.siteSets('calc3-t6', false, 6000); // later, he unticks it on the site
    const list = await tool('list_tasks', {});
    expect(list.data.tasks[0].done).toBe(false);

    site.siteSets('calc3-t6', true, 7000); // and ticks it again there
    expect((await rest())[0].done).toBe(true);
    expect(site.entry('calc3-t6')).toEqual(['calc3-t6', 1, 7000]); // site's own stamp kept
  });

  it('get_history sees ticks made on the site', async () => {
    await tool('set_daily_plan', { date: '2026-09-30', tasks: [{ title: 'Old lesson', siteKey: 'calc3-t6' }] });
    expect((await tool('get_history', { days: 3 })).data.done).toBe(0);
    site.siteSets('calc3-t6', true, 9000);
    const history = await tool('get_history', { days: 3 });
    expect(history.data).toMatchObject({ done: 1, total: 1 });
  });
});

describe('planner -> site', () => {
  it('ticking pushes a triple with the planner timestamp and leaves the rest of the state untouched', async () => {
    store.clock = () => 5000;
    const { data } = await publish([{ title: 'Calc 3 lesson', siteKey: 'calc3-t6' }]);
    const before = structuredClone(site.state) as any;

    const res = await patch(data.tasks[0].id, { done: true });
    expect(res.status).toBe(200);

    const after = site.state as any;
    expect(site.entry('calc3-t6')).toEqual(['calc3-t6', 1, 5000]);
    expect(after.tasks.map((r: any[]) => r[0])).toEqual(before.tasks.map((r: any[]) => r[0])); // order kept
    expect(after.tasks[0]).toEqual(before.tasks[0]);
    expect(after.tasks[2]).toEqual(before.tasks[2]);
    expect(after.cal).toEqual(before.cal);
    expect(after.days).toEqual(before.days); // rest arrangement and sig never touched
    expect(after.at).toBeGreaterThan(before.at);
  });

  it('unticking pushes an explicit 0 so the site unticks too', async () => {
    store.clock = () => 5000;
    const { data } = await publish([{ title: 'Calc 3 lesson', siteKey: 'calc3-t5' }]); // site says done @1000
    store.clock = () => 8000;
    await patch(data.tasks[0].id, { done: false });
    expect(site.entry('calc3-t5')).toEqual(['calc3-t5', 0, 8000]);
  });

  it('appends an entry for a site key the site has not stored yet', async () => {
    store.clock = () => 5000;
    const { data } = await publish([{ title: 'Late lesson', siteKey: 'calc3-t99' }]);
    await patch(data.tasks[0].id, { done: true });
    expect(site.entry('calc3-t99')).toEqual(['calc3-t99', 1, 5000]);
    expect((site.state.tasks as unknown[]).length).toBe(4);
  });

  it('rest-day rows sync like any other calc3 task', async () => {
    store.clock = () => 5000;
    const { data } = await publish([{ title: 'Rest day', tag: 'calculus3', siteKey: 'calc3-t6' }]);
    await patch(data.tasks[0].id, { done: true });
    expect(site.entry('calc3-t6')?.[1]).toBe(1);
  });

  it('keeps two tasks that share one site key in step', async () => {
    store.clock = () => 5000;
    await tool('set_daily_plan', { date: '2026-09-30', tasks: [{ title: 'Calc 3 lesson', siteKey: 'calc3-t6' }] });
    const { data } = await publish([{ title: 'Calc 3 lesson (again)', siteKey: 'calc3-t6' }]);
    await patch(data.tasks[0].id, { done: true });
    const yesterday = (await tool('list_tasks', { date: '2026-09-30' })).data;
    expect(yesterday.tasks[0].done).toBe(true);
  });
});

describe('what never syncs', () => {
  it('tasks without a siteKey never touch the site', async () => {
    const { data } = await publish([{ title: 'SAT set', tag: 'sat' }]);
    await patch(data.tasks[0].id, { done: true });
    await rest();
    await tool('list_tasks', {});
    await tool('get_history', {});
    expect(site.reads).toBe(0);
    expect(site.writes).toBe(0);
  });

  it('rejects site keys outside the mirrored prefixes', async () => {
    const bad = await publish([{ title: 'x', siteKey: 'master-t1' }]);
    expect(bad.isError).toBe(true);
    expect(bad.text).toContain('calc3-');
    expect((await tool('add_task', { title: 'x', siteKey: 'master-t1' })).isError).toBe(true);
    const { data } = await publish([{ title: 'ok' }]);
    expect((await tool('update_task', { id: data.tasks[0].id, siteKey: 'master-t1' })).isError).toBe(true);
    expect((await publish([{ title: 'x', siteKey: 'has spaces' }])).isError).toBe(true);
    expect(site.writes).toBe(0);
  });

  it('refuses to set a siteKey through the app API', async () => {
    const { data } = await publish([{ title: 'x' }]);
    expect((await patch(data.tasks[0].id, { siteKey: 'calc3-t6' })).status).toBe(400);
  });

  it('can attach and clear a siteKey with update_task', async () => {
    const { data } = await publish([{ title: 'x' }]);
    const set = await tool('update_task', { id: data.tasks[0].id, siteKey: 'calc3-t5' });
    expect(set.data.updated.siteKey).toBe('calc3-t5');
    expect(set.data.updated.done).toBe(true); // site already had it ticked
    const cleared = await tool('update_task', { id: data.tasks[0].id, siteKey: null });
    expect(cleared.data.updated.siteKey).toBeNull();
  });

  it('keeps working with sync turned off', async () => {
    const { data } = await tool('set_daily_plan', { tasks: [{ title: 'x', siteKey: 'calc3-t5' }] }, null);
    expect(data.tasks[0]).toMatchObject({ siteKey: 'calc3-t5', done: false });
    const res = await api(`/api/tasks/${data.tasks[0].id}`, { method: 'PATCH', body: JSON.stringify({ done: true }) }, null);
    expect(res.status).toBe(200);
    expect(((await api('/api/tasks', {}, null).then((r) => r.json())) as any).tasks[0].done).toBe(true);
    expect(site.reads).toBe(0);
    expect(site.writes).toBe(0);
  });
});

describe('when the site misbehaves', () => {
  it('retries after the site wrote at the same moment, keeping both edits', async () => {
    store.clock = () => 5000;
    const { data } = await publish([{ title: 'Calc 3 lesson', siteKey: 'calc3-t6' }]);
    site.beforeWrite = () => site.siteSets('calc3-t7', true, 5500); // site edits mid-flight
    await patch(data.tasks[0].id, { done: true });
    expect(site.entry('calc3-t6')).toEqual(['calc3-t6', 1, 5000]);
    expect(site.entry('calc3-t7')).toEqual(['calc3-t7', 1, 5500]);
  });

  it('gives up quietly after repeated conflicts and heals on the next sync', async () => {
    store.clock = () => 5000;
    const { data } = await publish([{ title: 'Calc 3 lesson', siteKey: 'calc3-t6' }]);
    site.alwaysConflict = true;
    const res = await patch(data.tasks[0].id, { done: true });
    expect(res.status).toBe(200); // the app is never blocked by the site
    expect(site.entry('calc3-t6')?.[1]).toBe(0);

    site.alwaysConflict = false;
    await rest(); // next print retries
    expect(site.entry('calc3-t6')).toEqual(['calc3-t6', 1, 5000]);
  });

  it('keeps working while the site is unreachable, then catches up', async () => {
    store.clock = () => 5000;
    const { data } = await publish([{ title: 'Calc 3 lesson', siteKey: 'calc3-t6' }]);
    site.down = true;
    expect((await patch(data.tasks[0].id, { done: true })).status).toBe(200);
    expect(((await (await api('/api/tasks')).json()) as any).tasks[0].done).toBe(true);
    expect((await tool('list_tasks', {})).isError).toBe(false);

    site.down = false;
    await rest();
    expect(site.entry('calc3-t6')).toEqual(['calc3-t6', 1, 5000]);
  });
});

describe('FirebaseSite client', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('reads with an ETag request and parses triples, including the sparse-object form', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ tasks: { '0': ['a', 1, 10], '2': ['b', 0, 20] }, extra: 1 }), {
        headers: { ETag: 'abc' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const snap = await new FirebaseSite('https://fb.test/state.json').read();
    expect(snap.etag).toBe('abc');
    expect(snap.entries.get('a')).toEqual({ v: true, t: 10 });
    expect(snap.entries.get('b')).toEqual({ v: false, t: 20 });
    expect(snap.state.extra).toBe(1);
    expect((fetchMock.mock.calls[0] as any)[1].headers['X-Firebase-ETag']).toBe('true');
  });

  it('treats an empty node as an empty state', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('null', { headers: { ETag: 'null_etag' } })));
    const snap = await new FirebaseSite('https://fb.test/state.json').read();
    expect(snap.state).toEqual({});
    expect(snap.entries.size).toBe(0);
  });

  it('writes conditionally: false on 412, throws on other errors', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 412 }));
    vi.stubGlobal('fetch', fetchMock);
    const client = new FirebaseSite('https://fb.test/state.json');
    expect(await client.write({ a: 1 }, 'abc')).toBe(false);
    const init = (fetchMock.mock.calls[0] as any)[1];
    expect(init.method).toBe('PUT');
    expect(init.headers['if-match']).toBe('abc');

    vi.stubGlobal('fetch', vi.fn(async () => new Response('no', { status: 500 })));
    await expect(client.write({}, 'abc')).rejects.toThrow('HTTP 500');
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 200 })));
    expect(await client.write({}, 'abc')).toBe(true);
  });

  it('read errors surface so sync can back off', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 503 })));
    await expect(new FirebaseSite('https://fb.test/state.json').read()).rejects.toThrow('HTTP 503');
  });

  it('helpers tolerate junk', () => {
    expect(rowsOf(undefined)).toEqual([]);
    expect(parseEntries({ tasks: [['ok', 1, 5], 'junk', [3, 1, 1]] }).size).toBe(1);
    expect(parsePrefixes(undefined)).toEqual(['calc3-']);
    expect(parsePrefixes(' calc3-, sat- ')).toEqual(['calc3-', 'sat-']);
  });
});

describe('advertised tool schemas', () => {
  it('start and siteKey patterns accept real values and reject bad ones', async () => {
    const res = await api('/mcp', { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
    const tools = ((await res.json()) as any).result.tools;
    const props = tools.find((t: any) => t.name === 'set_daily_plan').inputSchema.properties.tasks.items.properties;
    const start = new RegExp(props.start.pattern);
    for (const ok of ['00:00', '09:05', '15:30', '23:59']) expect(start.test(ok), ok).toBe(true);
    for (const bad of ['3:30pm', '24:00', '15:60', '1530', '15:3']) expect(start.test(bad), bad).toBe(false);
    const key = new RegExp(props.siteKey.pattern);
    expect(key.test('calc3-t12')).toBe(true);
    expect(key.test('has space')).toBe(false);
  });
});
