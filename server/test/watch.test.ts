import { describe, expect, it } from 'vitest';
import { handleRequest } from '../src/index';
import { classifyVideo, expandAutoSessions, sessionMakeup } from '../src/watch';
import { MemoryTaskStore } from './memory-store';

const env = { API_TOKEN: 'a'.repeat(40), MUSIC_TOKEN: 'm'.repeat(40), PLANNER_TZ: 'America/Los_Angeles' } as any;
const planner = { Authorization: `Bearer ${env.API_TOKEN}`, 'Content-Type': 'application/json' };
const music = { Authorization: `Bearer ${env.MUSIC_TOKEN}`, 'Content-Type': 'application/json' };
const now = new Date(Date.UTC(2026, 9, 21, 3, 0)); // Tue Oct 20, 8pm PDT

const put = (store: MemoryTaskStore, id: string, body: unknown, headers = planner) =>
  handleRequest(new Request(`https://x/api/watch/${id}`, { method: 'PUT', headers, body: JSON.stringify(body) }), env, store, now);
const current = async (store: MemoryTaskStore) =>
  ((await (await handleRequest(new Request('https://x/api/music/current', { headers: planner }), env, store, now)).json()) as any).current;
const video = (o: Record<string, unknown> = {}) => ({
  session: 'yt-1', video: 'abc123', title: 'Funny cat compilation', channel: 'Cats Inc',
  started: '2026-10-21T02:40:00Z', ended: '2026-10-21T02:59:50Z', watched: 900, ...o,
});

describe('classifyVideo: lecture or browsing, guessed from the title and channel', () => {
  it('knows study channels and study words, and leaves the rest as browsing', () => {
    expect(classifyVideo('Surface integrals, Stokes theorem', 'Some Channel')).toBe('lecture');
    expect(classifyVideo('Anything', 'Khan Academy')).toBe('lecture');
    expect(classifyVideo('AP Stats unit 5 review', 'x')).toBe('lecture');
    expect(classifyVideo('Eagles vs Cowboys highlights', 'NFL')).toBe('browsing');
    expect(classifyVideo('Calculator tricks you did not know', 'x')).toBe('browsing');
  });
});

describe('PUT /api/watch/:id keeps YouTube mode on by itself', () => {
  it('opens a session when the first video plays, and the app sees YouTube mode on', async () => {
    const store = new MemoryTaskStore();
    expect(await current(store)).toBeNull();
    const res = await put(store, 'w1', video());
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id: 'w1', session: 'yt-1', mode: 'browsing', final: false });
    expect(await current(store)).toMatchObject({ id: 'yt-1', mode: 'browsing' });
    expect(store.music).toEqual([{ id: 'yt-1', startedAt: '2026-10-21T02:40:00.000Z', endedAt: null, mode: 'browsing' }]);
  });

  it('switches to lecture when a lecture plays, and closes the session on final', async () => {
    const store = new MemoryTaskStore();
    await put(store, 'w1', video());
    await put(store, 'w2', video({ video: 'zzz', title: 'Calc 3: surface integrals', started: '2026-10-21T02:50:00Z', ended: '2026-10-21T02:59:55Z', watched: 400 }));
    expect(await current(store)).toMatchObject({ id: 'yt-1', mode: 'lecture' });
    await put(store, 'w2', video({ video: 'zzz', title: 'Calc 3: surface integrals', started: '2026-10-21T02:50:00Z', ended: '2026-10-21T02:58:30Z', watched: 430, final: true }));
    expect(await current(store)).toBeNull();
    expect(store.music[0]).toMatchObject({ id: 'yt-1', endedAt: '2026-10-21T02:58:30.000Z', mode: 'lecture' });
    expect(store.watches).toHaveLength(2); // the second report updated its row, it did not add one
  });

  it('closes a session that went quiet at the last moment a video was seen, even without a final report', async () => {
    const store = new MemoryTaskStore();
    await put(store, 'w1', video({ started: '2026-10-21T02:10:00Z', ended: '2026-10-21T02:20:00Z', watched: 600 })); // 7:20pm; it is 8pm now
    expect(await current(store)).toBeNull();
    expect(store.music[0]).toMatchObject({ id: 'yt-1', endedAt: '2026-10-21T02:20:00.000Z' });
  });

  it('never touches a session he switched on himself, but still logs the video', async () => {
    const store = new MemoryTaskStore();
    await store.saveMusic({ id: 'manual1', startedAt: '2026-10-21T01:00:00.000Z', endedAt: null, mode: 'browsing' });
    await put(store, 'w1', video());
    expect(store.music).toEqual([{ id: 'manual1', startedAt: '2026-10-21T01:00:00.000Z', endedAt: null, mode: 'browsing' }]);
    expect(store.watches).toHaveLength(1);
  });

  it('still shows the open session when a short closed stretch started after it, and ignores one left on for half a day', async () => {
    const store = new MemoryTaskStore();
    await put(store, 'w1', video());
    await store.saveMusic({ id: 'blip', startedAt: '2026-10-21T02:50:00.000Z', endedAt: '2026-10-21T02:50:01.000Z', mode: 'lecture' }); // tapping through the colors
    expect(await current(store)).toMatchObject({ id: 'yt-1' });
    const hours7 = new MemoryTaskStore();
    await hours7.saveMusic({ id: 'seven-hours', startedAt: '2026-10-20T20:00:00.000Z', endedAt: null, mode: 'browsing' });
    expect(await current(hours7)).toMatchObject({ id: 'seven-hours' });
    const stale = new MemoryTaskStore();
    await stale.saveMusic({ id: 'ancient', startedAt: '2026-10-20T10:00:00.000Z', endedAt: null, mode: 'browsing' }); // 17 hours
    expect(await current(stale)).toBeNull();
  });

  it('turns the light off 30 seconds after the last report, while the session carries on for up to 15 minutes', async () => {
    const store = new MemoryTaskStore();
    await put(store, 'w1', video({ ended: '2026-10-21T02:59:40Z' })); // 20 seconds ago: playing
    expect(await current(store)).toMatchObject({ id: 'yt-1' });
    const paused = new MemoryTaskStore();
    await put(paused, 'w1', video({ ended: '2026-10-21T02:59:10Z' })); // 50 seconds ago: paused
    expect(await current(paused)).toBeNull();
    expect(paused.music[0]).toMatchObject({ id: 'yt-1', endedAt: null }); // still the same sitting
    const gone = new MemoryTaskStore();
    await put(gone, 'w1', video({ started: '2026-10-21T02:30:00Z', ended: '2026-10-21T02:40:00Z' })); // 20 minutes ago: the sitting is over
    expect(await current(gone)).toBeNull();
    expect(gone.music[0].endedAt).toBe('2026-10-21T02:40:00.000Z');
  });

  it('shows the mode of the video playing now, not of the whole session', async () => {
    const store = new MemoryTaskStore();
    await put(store, 'w1', video({ title: 'Calc 3: Stokes theorem', started: '2026-10-21T02:30:00Z', ended: '2026-10-21T02:45:00Z' }));
    await put(store, 'w2', video({ video: 'v2' })); // a cat video now
    expect(await current(store)).toMatchObject({ id: 'yt-1', mode: 'browsing' });
    expect(store.music[0].mode).toBe('lecture'); // the session as a whole had a lecture in it
  });

  it('rejects bad input and the music token (only the planner token may write)', async () => {
    const store = new MemoryTaskStore();
    expect((await put(store, 'w1', video({ started: 'nope' }))).status).toBe(400);
    expect((await put(store, 'w1', video({ title: '' }))).status).toBe(400);
    expect((await put(store, 'bad id!', video())).status).toBe(400);
    expect((await put(store, 'w1', video({ ended: '2026-10-21T02:00:00Z' }))).status).toBe(400); // ends before it starts
    expect((await put(store, 'w1', video(), music)).status).toBe(401);
    expect(store.watches).toHaveLength(0);
  });
});

describe('get_watch_log on the music endpoint', () => {
  it('summarizes what he watched: top channels, modes and hours, and leaves out blips', async () => {
    const store = new MemoryTaskStore();
    await put(store, 'a', video({ session: 'yt-1', channel: 'Cats Inc', watched: 900 }));
    await put(store, 'b', video({ video: 'v2', session: 'yt-1', channel: 'Cats Inc', started: '2026-10-21T02:56:00Z', ended: '2026-10-21T02:59:00Z', watched: 120 }));
    await put(store, 'c', video({ video: 'v3', session: 'yt-1', title: 'Stokes theorem lecture', channel: 'Prof X', started: '2026-10-21T02:50:00Z', ended: '2026-10-21T02:58:00Z', watched: 300 }));
    await put(store, 'blip', video({ video: 'v4', session: 'yt-1', started: '2026-10-21T02:59:00Z', ended: '2026-10-21T02:59:10Z', watched: 8 }));
    const res = await handleRequest(
      new Request('https://x/music/mcp', { method: 'POST', headers: music, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_watch_log', arguments: { days: 7 } } }) }),
      env, store, now,
    );
    const data = JSON.parse(((await res.json()) as any).result.content[0].text);
    expect(data.videos_logged).toBe(3);
    expect(data.total_minutes).toBe(22);
    expect(data.minutes_by_mode).toEqual({ browsing: 17, lecture: 5 });
    expect(data.top_channels[0]).toMatchObject({ channel: 'Cats Inc', minutes: 17, videos: 2, mostly: 'browsing' });
    expect(data.minutes_by_start_hour).toEqual({ '19': 22 });
    expect(data.recent[0].title).toBe('Funny cat compilation');
  });
});

describe('pauses inside a session', () => {
  const row = (id: string, started: string, ended: string, watchedS: number) => ({
    id, sessionId: 'yt-1', videoId: 'v', title: 't', channel: 'c', durationS: null, startedAt: started, endedAt: ended, watchedS, mode: 'browsing' as const,
  });
  const watches = [
    row('a', '2026-10-21T01:00:00.000Z', '2026-10-21T01:10:00.000Z', 600),
    row('b', '2026-10-21T01:12:00.000Z', '2026-10-21T01:20:00.000Z', 480), // a 2-minute pause
    row('c', '2026-10-21T01:20:10.000Z', '2026-10-21T01:25:00.000Z', 290), // a 10-second gap: not a pause
  ];
  it('counts the pauses of 30 seconds or more, and the minutes really played', () => {
    expect(sessionMakeup('yt-1', watches)).toEqual({ playing_minutes: 22.8, pauses: 1, paused_minutes: 2 });
  });
  it('counts YouTube as on only while a video played: one span per stretch, hand-made sessions untouched', () => {
    const sessions = [
      { id: 'yt-1', startedAt: '2026-10-21T01:00:00.000Z', endedAt: '2026-10-21T01:25:00.000Z', mode: 'browsing' as const },
      { id: 'w1', startedAt: '2026-10-20T10:00:00.000Z', endedAt: '2026-10-20T11:00:00.000Z', mode: 'lecture' as const },
    ];
    const spans = expandAutoSessions(sessions, watches);
    expect(spans.map((x) => x.id)).toEqual(['a', 'b', 'c', 'w1']);
  });
});
