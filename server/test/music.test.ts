import { describe, expect, it } from 'vitest';
import { handleRequest } from '../src/index';
import { computeMusicStats, sessionSpans } from '../src/music';
import { bulkTickedIds } from '../src/timing';
import { MemoryTaskStore } from './memory-store';
import type { GymSession, Task } from '../src/tasks';

const env = { API_TOKEN: 'a'.repeat(40), MUSIC_TOKEN: 'm'.repeat(40), PLANNER_TZ: 'America/Los_Angeles' } as any;
const planner = { Authorization: `Bearer ${env.API_TOKEN}`, 'Content-Type': 'application/json' };
const music = { Authorization: `Bearer ${env.MUSIC_TOKEN}`, 'Content-Type': 'application/json' };
const now = new Date(Date.UTC(2026, 9, 21, 3, 0)); // Tue Oct 20, 8pm PDT

function rpc(store: MemoryTaskStore, path: string, headers: Record<string, string>) {
  return async (method: string, params?: any) => {
    const res = await handleRequest(
      new Request(`https://x${path}`, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) }),
      env, store, now,
    );
    return { status: res.status, body: res.status === 200 ? ((await res.json()) as any) : null };
  };
}
const callTool = async (store: MemoryTaskStore, path: string, headers: Record<string, string>, name: string, args: any = {}) => {
  const { body } = await rpc(store, path, headers)('tools/call', { name, arguments: args });
  const r = body.result;
  return { isError: !!r.isError, data: r.isError ? r.content[0].text : JSON.parse(r.content[0].text) };
};

describe('the YouTube-mode switch (PUT /api/music/:id)', () => {
  const put = (store: MemoryTaskStore, id: string, body: unknown, headers = planner) =>
    handleRequest(new Request(`https://x/api/music/${id}`, { method: 'PUT', headers, body: JSON.stringify(body) }), env, store, now);

  it('records a start and then the end under one id, and a late retry does not erase the end', async () => {
    const store = new MemoryTaskStore();
    expect((await put(store, 'm1', { started: '2026-10-20T22:00:00Z' })).status).toBe(200);
    await put(store, 'm1', { started: '2026-10-20T22:00:00Z', ended: '2026-10-20T23:00:00Z' });
    await put(store, 'm1', { started: '2026-10-20T22:00:00Z' }); // the first message, retried late
    expect(store.music).toEqual([{ id: 'm1', startedAt: '2026-10-20T22:00:00.000Z', endedAt: '2026-10-20T23:00:00.000Z', mode: 'browsing' }]);
    expect(store.gym).toEqual([]); // never mixed with the gym
  });

  it('keeps the mode (lecture or browsing), defaults to browsing, and rejects an unknown one', async () => {
    const store = new MemoryTaskStore();
    await put(store, 'l1', { started: '2026-10-20T22:00:00Z', mode: 'lecture' });
    await put(store, 'b1', { started: '2026-10-20T23:00:00Z' });
    expect(store.music.map((s) => [s.id, s.mode])).toEqual([['l1', 'lecture'], ['b1', 'browsing']]);
    expect((await put(store, 'x1', { started: '2026-10-20T22:00:00Z', mode: 'podcast' })).status).toBe(400);
  });

  it('rejects bad input and unknown tokens (the music token cannot write sessions)', async () => {
    const store = new MemoryTaskStore();
    expect((await put(store, 'm1', { started: 'nope' })).status).toBe(400);
    expect((await put(store, 'm1', { started: '2026-10-20T22:00:00Z' }, music)).status).toBe(401);
  });
});

describe('the separate music MCP endpoint', () => {
  it('has its own four tools, and the planner endpoint has none of them', async () => {
    const store = new MemoryTaskStore();
    const m = (await rpc(store, '/music/mcp', music)('tools/list')).body.result.tools.map((t: any) => t.name);
    expect(m).toEqual(['get_music_sessions', 'get_music_stats', 'get_music_experiments', 'set_music_experiments']);
    const p = (await rpc(store, '/mcp', planner)('tools/list')).body.result.tools.map((t: any) => t.name);
    expect(p.filter((n: string) => n.includes('music'))).toEqual([]);
    const info = (await rpc(store, '/music/mcp', music)('initialize', { protocolVersion: '2025-06-18' })).body.result;
    expect(info.instructions).toContain('separate experiment from the daily planner');
  });

  it('accepts the music token, the planner token, or a path token; refuses everything else', async () => {
    const store = new MemoryTaskStore();
    expect((await rpc(store, '/music/mcp', music)('ping')).status).toBe(200);
    expect((await rpc(store, '/music/mcp', planner)('ping')).status).toBe(200);
    expect((await rpc(store, `/music/mcp/${env.MUSIC_TOKEN}`, {})('ping')).status).toBe(200);
    expect((await rpc(store, '/music/mcp', { Authorization: 'Bearer wrong-token-wrong-token' })('ping')).status).toBe(401);
    expect((await rpc(store, '/music/mcp', {})('ping')).status).toBe(401);
  });

  it('the music token opens nothing else: not the planner MCP, not the task API', async () => {
    const store = new MemoryTaskStore();
    expect((await rpc(store, '/mcp', music)('ping')).status).toBe(401);
    const tasks = await handleRequest(new Request('https://x/api/tasks?date=2026-10-20', { headers: music }), env, store, now);
    expect(tasks.status).toBe(401);
  });

  it('lists sessions with local times and marks an open one', async () => {
    const store = new MemoryTaskStore();
    await store.saveMusic({ id: 'a', startedAt: '2026-10-19T23:00:00Z', endedAt: '2026-10-20T00:30:00Z' }); // 4:00-5:30pm Oct 19
    await store.saveMusic({ id: 'b', startedAt: '2026-10-21T02:00:00Z', endedAt: null, mode: 'lecture' }); // 7:00pm Oct 20, still on
    const r = (await callTool(store, '/music/mcp', music, 'get_music_sessions')).data;
    expect(r.sessions).toEqual([
      { date: '2026-10-19', start: '16:00', mode: 'browsing', end: '17:30', minutes: 90, open: false },
      { date: '2026-10-20', start: '19:00', mode: 'lecture', end: null, minutes: null, open: true },
    ]);
  });

  it('leaves out the under-a-minute blips from tapping through the colors, and says how many', async () => {
    const store = new MemoryTaskStore();
    await store.saveMusic({ id: 'a', startedAt: '2026-10-19T23:00:00Z', endedAt: '2026-10-20T00:30:00Z' });
    await store.saveMusic({ id: 'blip', startedAt: '2026-10-20T00:30:00Z', endedAt: '2026-10-20T00:30:10Z', mode: 'lecture' });
    const r = (await callTool(store, '/music/mcp', music, 'get_music_sessions')).data;
    expect(r.sessions.map((s: any) => s.start)).toEqual(['16:00']);
    expect(r.left_out_blips).toBe(1);
  });
});

describe('experiments: the same machinery, kept apart', () => {
  it('stores music experiments in their own table, invisible to the planner', async () => {
    const store = new MemoryTaskStore();
    const set = await callTool(store, '/music/mcp', music, 'set_music_experiments', {
      experiments: [{ id: 'silent-calc', title: 'Silence during Calc 3', change: 'No YouTube while a Calc 3 block runs', measure: 'lateness', tag: 'calculus3' }],
    });
    expect(set.isError).toBe(false);
    const got = (await callTool(store, '/music/mcp', music, 'get_music_experiments')).data;
    expect(got.experiments).toHaveLength(1);
    expect(got.experiments[0]).toMatchObject({ id: 'silent-calc', measure: 'lateness', tag: 'calculus3', status: 'running' });
    // the planner never sees it
    expect(await store.listExperiments()).toEqual([]);
    const habits = (await callTool(store, '/mcp', planner, 'get_habits')).data;
    expect(habits.experiments).toEqual([]);
  });

  it('closing one needs a result, and a fourth running experiment is refused', async () => {
    const store = new MemoryTaskStore();
    const exp = (id: string) => ({ id, title: id, change: 'one change', measure: 'done_pct' });
    expect((await callTool(store, '/music/mcp', music, 'set_music_experiments', { experiments: ['a', 'b', 'c'].map(exp) })).isError).toBe(false);
    expect((await callTool(store, '/music/mcp', music, 'set_music_experiments', { experiments: [exp('d')] })).isError).toBe(true);
    expect((await callTool(store, '/music/mcp', music, 'set_music_experiments', { experiments: [{ id: 'a', status: 'kept' }] })).isError).toBe(true);
    expect((await callTool(store, '/music/mcp', music, 'set_music_experiments', { experiments: [{ id: 'a', status: 'kept', result: 'no difference' }] })).isError).toBe(false);
  });
});

describe('YouTube versus silence over finished blocks', () => {
  let seq = 0;
  const block = (date: string, tag: string, from: string, to: string, planned = 30): Task =>
    ({
      id: `t${++seq}`, date, plan: 'A', commitment: null, title: `${tag} block`, tag, start: from, minutes: planned,
      notes: null, siteKey: null, done: true, doneAt: 0, position: 0, createdAt: `${date}T00:00:00Z`,
      completedAt: `${date}T${to}:00-07:00`, startedAt: `${date}T${from}:00-07:00`, flaggedAt: null, pausedAt: null, pausedMs: 0,
    }) as unknown as Task;

  // three Calc blocks with YouTube on (35 min each for 30 planned), three in silence (24 min each)
  const yt = ['2026-10-12', '2026-10-13', '2026-10-14'];
  const quiet = ['2026-10-15', '2026-10-16', '2026-10-17'];
  const tasks = [...yt.map((d) => block(d, 'calculus3', '17:00', '17:35')), ...quiet.map((d) => block(d, 'calculus3', '17:00', '17:24'))];
  const sessions: GymSession[] = yt.map((d, i) => ({ id: `s${i}`, startedAt: `${d}T16:30:00-07:00`, endedAt: `${d}T18:00:00-07:00`, mode: 'browsing' as const }));

  it('groups blocks by overlap and compares real time with planned', () => {
    const nowMs = Date.parse('2026-10-20T12:00:00-07:00');
    const r = computeMusicStats(tasks, sessions, 'America/Los_Angeles', '2026-10-20', 28, nowMs);
    expect(r.blocks_used).toBe(6);
    expect(r.by_mode.browsing).toMatchObject({ n: 3, median_ratio_of_planned: 1.17, median_actual_min: 35 });
    expect(r.by_mode.lecture.n).toBe(0);
    expect(r.by_mode.silence).toMatchObject({ n: 3, median_ratio_of_planned: 0.8, median_actual_min: 24 });
    expect(r.by_mode.mixed.n).toBe(0);
    expect(Object.keys(r.by_tag)).toEqual(['calculus3']);
    expect(Object.keys(r.by_tag.calculus3)).toEqual(['silence', 'browsing']);
    expect(r.whole_days.youtube_days.days).toBe(3);
    expect(r.whole_days.quiet_days.days).toBeGreaterThanOrEqual(3);
  });

  it('a block half-covered by a session is mixed, and a subject with too few blocks is not split', () => {
    const half = block('2026-10-18', 'sat', '17:00', '17:40');
    const s: GymSession[] = [{ id: 'h', startedAt: '2026-10-18T17:20:00-07:00', endedAt: '2026-10-18T18:00:00-07:00' }];
    const r = computeMusicStats([half], s, 'America/Los_Angeles', '2026-10-20', 28, Date.parse('2026-10-20T12:00:00-07:00'));
    expect(r.by_mode.mixed.n).toBe(1);
    expect(r.too_few_to_split.join()).toContain('sat');
  });

  it('a lecture session makes its blocks lecture blocks, kept apart from browsing', () => {
    const lec = ['2026-10-12', '2026-10-13', '2026-10-14'].map((d) => block(d, 'calculus3', '17:00', '17:40'));
    const lecSessions: GymSession[] = lec.map((t, i) => ({ id: `l${i}`, startedAt: `${t.date}T16:50:00-07:00`, endedAt: `${t.date}T17:45:00-07:00`, mode: 'lecture' as const }));
    const r = computeMusicStats([...lec, ...tasks.slice(3)], lecSessions, 'America/Los_Angeles', '2026-10-20', 28, Date.parse('2026-10-20T12:00:00-07:00'));
    expect(r.by_mode.lecture.n).toBe(3);
    expect(r.by_mode.browsing.n).toBe(0);
    expect(r.by_mode.silence.n).toBe(3);
    expect(r.sessions).toMatchObject({ count: 3, lecture: 3, browsing: 0 });
    expect(Object.keys(r.by_tag.calculus3)).toEqual(['silence', 'lecture']);
  });

  it('flagged blocks and batch ticks are left out, and a forgotten open session is capped', () => {
    const flagged = { ...block('2026-10-18', 'pcb', '17:00', '17:30'), flaggedAt: '2026-10-18T00:00:00Z' } as Task;
    const r = computeMusicStats([flagged], [], 'America/Los_Angeles', '2026-10-20', 28, Date.parse('2026-10-20T12:00:00-07:00'));
    expect(r.blocks_used).toBe(0);
    const { spans, open } = sessionSpans([{ id: 'o', startedAt: '2026-10-19T08:00:00Z', endedAt: null }], Date.parse('2026-10-20T08:00:00Z'));
    expect(open).toBe(true);
    expect(spans[0].end - spans[0].start).toBe(6 * 3_600_000);
    expect(bulkTickedIds([], 'America/Los_Angeles').size).toBe(0);
  });
});

describe('GET /api/music/current (so the phone and the website agree)', () => {
  const get = (store: MemoryTaskStore, headers = planner) => handleRequest(new Request('https://x/api/music/current', { headers }), env, store, now);

  it('is null when nothing is on, and shows the open stretch with its mode otherwise', async () => {
    const store = new MemoryTaskStore();
    expect(((await (await get(store)).json()) as any).current).toBeNull();
    await store.saveMusic({ id: 'a', startedAt: '2026-10-21T01:00:00Z', endedAt: '2026-10-21T01:30:00Z', mode: 'browsing' });
    expect(((await (await get(store)).json()) as any).current).toBeNull(); // the last one ended
    await store.saveMusic({ id: 'b', startedAt: '2026-10-21T01:30:00Z', endedAt: null, mode: 'lecture' });
    expect(((await (await get(store)).json()) as any).current).toEqual({ id: 'b', started: '2026-10-21T01:30:00Z', mode: 'lecture' });
  });

  it('needs the planner token, and "current" can not be written as a session id', async () => {
    const store = new MemoryTaskStore();
    expect((await get(store, music)).status).toBe(401);
    const put = await handleRequest(new Request('https://x/api/music/current', { method: 'PUT', headers: planner, body: JSON.stringify({ started: '2026-10-20T22:00:00Z' }) }), env, store, now);
    expect(put.status).toBe(405); // the path is reserved for reading
  });
});
