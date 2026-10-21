// The website's YouTube-mode button: the same recorder as the phone app, and it agrees with the phone through the server.

import { describe, expect, it } from 'vitest';
import { MUSIC_ORDER, createApi, createMusicTracker, hitsPinkButton } from '../../site/src/logic.mjs';

function memoryStorage(initial = {}) {
  const data = { ...initial };
  return { getItem: (k) => (k in data ? data[k] : null), setItem: (k, v) => { data[k] = v; }, data };
}

function setup({ online = true, remote = { reachable: true, current: null } } = {}) {
  const sent = [];
  const env = { online, remote, now: '2026-10-20T22:00:00.000Z', storage: memoryStorage() };
  const make = () =>
    createMusicTracker({
      storage: env.storage,
      send: async (id, started, ended, mode) => {
        if (!env.online) return false;
        sent.push({ id, started, ended, mode });
        return true;
      },
      fetchCurrent: async () => env.remote,
      clock: () => env.now,
    });
  return { env, sent, make };
}

describe('the printer button on the website', () => {
  it('steps off -> browsing -> lecture -> off, each change sent', async () => {
    const { env, sent, make } = setup();
    const m = make();
    expect(m.mode()).toBeNull();
    await m.advance(MUSIC_ORDER);
    expect(m.mode()).toBe('browsing');
    env.now = '2026-10-20T22:20:00.000Z';
    await m.advance(MUSIC_ORDER);
    expect(m.mode()).toBe('lecture');
    env.now = '2026-10-20T23:00:00.000Z';
    await m.advance(MUSIC_ORDER);
    expect(m.mode()).toBeNull();
    const closed = sent.filter((s) => s.ended);
    expect(closed.map((s) => [s.mode, s.started, s.ended])).toEqual([
      ['browsing', '2026-10-20T22:00:00.000Z', '2026-10-20T22:20:00.000Z'],
      ['lecture', '2026-10-20T22:20:00.000Z', '2026-10-20T23:00:00.000Z'],
    ]);
    expect(new Set(sent.map((s) => s.id)).size).toBe(2);
    expect(m.unsynced()).toBe(0);
  });

  it('offline: kept and sent later with the real times, and it survives a reload', async () => {
    const { env, sent, make } = setup({ online: false });
    const first = make();
    await first.advance(MUSIC_ORDER);
    env.now = '2026-10-20T22:30:00.000Z';
    await first.advance(MUSIC_ORDER); // lecture, left on
    const reloaded = make(); // same storage, a new page
    expect(reloaded.mode()).toBe('lecture');
    expect(reloaded.unsynced()).toBe(2);
    env.online = true;
    env.now = '2026-10-21T05:00:00.000Z'; // sent hours later
    await reloaded.flush();
    expect(sent.find((s) => s.mode === 'browsing')).toMatchObject({ started: '2026-10-20T22:00:00.000Z', ended: '2026-10-20T22:30:00.000Z' });
    expect(reloaded.unsynced()).toBe(0);
  });

  it('takes over what the server says is on (the phone changed it), only when nothing is waiting', async () => {
    const { env, make } = setup({ remote: { reachable: true, current: { id: 'm123', started: '2026-10-20T21:00:00.000Z', mode: 'lecture' } } });
    const m = make();
    expect(await m.sync()).toBe(true);
    expect(m.mode()).toBe('lecture');
    env.remote = { reachable: true, current: null }; // switched off on the phone
    expect(await m.sync()).toBe(true);
    expect(m.mode()).toBeNull();
    env.remote = { reachable: false, current: null }; // cannot ask: says nothing
    await m.advance(MUSIC_ORDER);
    expect(await m.sync()).toBe(false);
    expect(m.mode()).toBe('browsing');
  });

  it('does not overwrite its own unsent changes with an older server state', async () => {
    const { env, make } = setup({ online: false, remote: { reachable: true, current: null } });
    const m = make();
    await m.advance(MUSIC_ORDER); // turned on while offline
    expect(await m.sync()).toBe(false);
    expect(m.mode()).toBe('browsing');
  });

  it('ending a stretch that the phone started sends it under the phone\'s id with the right start', async () => {
    const { env, sent, make } = setup({ remote: { reachable: true, current: { id: 'm999', started: '2026-10-20T21:00:00.000Z', mode: 'browsing' } } });
    const m = make();
    await m.sync();
    env.now = '2026-10-20T21:45:00.000Z';
    await m.advance(MUSIC_ORDER); // browsing -> lecture
    expect(sent[0]).toEqual({ id: 'm999', started: '2026-10-20T21:00:00.000Z', ended: '2026-10-20T21:45:00.000Z', mode: 'browsing' });
  });

  it('the pink button is hit on and a little around it, not elsewhere on the printer', () => {
    expect(hitsPinkButton(38, 36)).toBe(true);
    expect(hitsPinkButton(16, 22)).toBe(true); // a near miss
    expect(hitsPinkButton(160, 60)).toBe(false);
    expect(hitsPinkButton(280, 30)).toBe(false);
  });
});

describe('the website API for it', () => {
  it('sends a stretch with its mode and reads what is on', async () => {
    const calls = [];
    const api = createApi({
      baseUrl: 'https://planner.example',
      token: 't'.repeat(20),
      fetchImpl: async (url, init) => {
        calls.push({ url, method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : null });
        return url.endsWith('/current')
          ? new Response(JSON.stringify({ current: { id: 'm1', started: '2026-10-20T22:00:00Z', mode: 'lecture' } }), { status: 200 })
          : new Response('{}', { status: 200 });
      },
    });
    expect(await api.putMusic('w1', '2026-10-20T22:00:00Z', null, 'lecture')).toBe(true);
    expect(calls[0]).toMatchObject({ url: 'https://planner.example/api/music/w1', method: 'PUT', body: { started: '2026-10-20T22:00:00Z', ended: null, mode: 'lecture' } });
    expect(await api.getMusicCurrent()).toEqual({ reachable: true, current: { id: 'm1', started: '2026-10-20T22:00:00Z', mode: 'lecture' } });
  });
});
