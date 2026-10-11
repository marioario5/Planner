// The website's pause button. The state table is in site/src/logic.mjs; each test below is one row or edge of it.

import { describe, expect, it } from 'vitest';
import {
  canFinish,
  canPause,
  canResume,
  canStart,
  canStop,
  clockOf,
  createApi,
  dropAction,
  normalizeTask,
  phase,
  pressPause,
  pressResume,
  pressStart,
  pressStop,
  tick,
  toggleDone,
  undoSnapshot,
  untick,
  workedMinutes,
} from '../../site/src/logic.mjs';

const task = (over = {}) =>
  normalizeTask({ id: 't1', plan: 'A', title: 'PIQ 6', tag: 'college', start: '13:35', minutes: 50, done: false, ...over });
const START = '2026-10-10T19:00:00.000Z';
const at = (min) => new Date(Date.parse(START) + min * 60_000).toISOString();
const running = () => pressStart(task(), START);
const paused = () => pressPause(running(), at(20));

describe('site: pause (state table)', () => {
  it('which controls each phase allows', () => {
    const rows = [
      ['idle', task(), [true, false, false, false, false]],
      ['running', running(), [false, true, false, true, true]],
      ['paused', paused(), [false, false, true, true, true]],
      ['done', tick(running()), [false, false, false, false, false]],
    ];
    for (const [name, t, expected] of rows) {
      expect(phase(t), name).toBe(name);
      expect([canStart(t), canPause(t), canResume(t), canFinish(t), canStop(t)], name).toEqual(expected);
    }
  });

  it('PAUSE only works while running, and pressing it twice keeps the first time', () => {
    expect(pressPause(task(), at(5))).toEqual(task()); // idle: nothing to pause
    const p = paused();
    expect(p.pausedAt).toBe(at(20));
    expect(pressPause(p, at(30)).pausedAt).toBe(at(20));
    const done = tick(running());
    expect(pressPause(done, at(30)).pausedAt).toBeNull(); // finished: nothing to pause
  });

  it('RESUME only works while paused, and adds the time paused to the total', () => {
    expect(pressResume(running(), at(30))).toEqual(running());
    const r = pressResume(paused(), at(35));
    expect(r).toMatchObject({ pausedAt: null, pausedMs: 15 * 60_000 });
    expect(phase(r)).toBe('running');
    const again = pressResume(pressPause(r, at(40)), at(45));
    expect(again.pausedMs).toBe(20 * 60_000); // several pauses add up
  });

  it('FINISH while paused ends the pause at the finish time', () => {
    const t = tick(paused(), at(50));
    expect(t).toMatchObject({ done: true, pausedAt: null, pausedMs: 30 * 60_000 });
    expect(toggleDone(paused()).done).toBe(true);
  });

  it('STOP (from running or paused) and untick start the task over, pauses included', () => {
    for (const t of [pressStop(paused()), pressStop(pressResume(paused(), at(30)))]) {
      expect(t).toMatchObject({ startedAt: null, pausedAt: null, pausedMs: 0, done: false });
      expect(phase(t)).toBe('idle');
    }
    const finished = tick(pressResume(paused(), at(30)));
    expect(finished.pausedMs).toBe(10 * 60_000);
    expect(untick(finished)).toMatchObject({ startedAt: null, pausedAt: null, pausedMs: 0 });
    expect(pressStop(finished).pausedMs).toBe(10 * 60_000); // no stop on a finished task
  });

  it('time worked stops counting while paused and excludes earlier pauses', () => {
    const t = running();
    expect(workedMinutes(t, Date.parse(START) + 20 * 60_000)).toBe(20);
    const p = paused(); // paused at +20
    expect(workedMinutes(p, Date.parse(START) + 90 * 60_000)).toBe(20); // frozen
    const r = pressResume(p, at(35)); // 15 minutes off
    expect(workedMinutes(r, Date.parse(START) + 50 * 60_000)).toBe(35);
    expect(workedMinutes(task(), Date.now())).toBeNull();
  });

  it('a paused slip is still running work: it cannot be dragged back or dropped into To do', () => {
    expect(dropAction(paused(), 'todo', new Set())).toBe('blocked-running');
    expect(dropAction(paused(), 'done', new Set())).toBe('finish');
  });

  it('reads the server fields, with safe defaults for an older server', () => {
    const t = normalizeTask({ id: 'a', title: 'x', started: START, paused: at(20), paused_ms: 300000 });
    expect(t).toMatchObject({ pausedAt: at(20), pausedMs: 300000 });
    expect(normalizeTask({ id: 'b', title: 'x' })).toMatchObject({ pausedAt: null, pausedMs: 0 });
  });

  it('an undo snapshot carries the paused time', () => {
    const t = { ...tick(pressResume(paused(), at(35))), completedAt: at(60) };
    expect(undoSnapshot(t, 123)).toEqual({ startedAt: START, completedAt: at(60), pausedMs: 15 * 60_000, at: 123 });
  });

  it('formats the pause time for the timer line', () => {
    expect(clockOf('not a time')).toBeNull();
    expect(clockOf(at(20))).toMatch(/^\d{1,2}:\d{2}(am|pm)$/);
  });
});

describe('site: pause server calls', () => {
  const fake = () => {
    const calls = [];
    const fetchImpl = async (url, init) => {
      calls.push({ url, method: init.method, body: init.body ? JSON.parse(init.body) : null });
      return { status: 200, json: async () => ({}) };
    };
    return { calls, api: createApi({ baseUrl: 'https://planner.example', token: 'secret-token-0123456789', fetchImpl }) };
  };

  it('pause and resume send paused true / false', async () => {
    const { api, calls } = fake();
    await api.setPaused('a', true);
    await api.setPaused('a', false);
    expect(calls.map((c) => [c.method, c.body])).toEqual([['PATCH', { paused: true }], ['PATCH', { paused: false }]]);
  });

  it('a re-tick that undoes an untick also sends the paused time', async () => {
    const { api, calls } = fake();
    await api.setDone('a', true, { startedAt: START, completedAt: at(60), pausedMs: 900000 });
    expect(calls[0].body).toEqual({ done: true, restoreStarted: START, restoreCompleted: at(60), restorePausedMs: 900000 });
  });
});
