// Tests for the planner website (site/): the task rules, the server calls, the lock, and the locked page itself.

import { describe, expect, it } from 'vitest';
import vm from 'node:vm';
import { buildSite, validateConfig } from '../../site/build-lib.mjs';
import { decryptBlob, fromBase64, IV_BYTES, PBKDF2_ITERATIONS, SALT_BYTES } from '../../site/src/crypto.mjs';
import { encryptBlob } from '../../site/encrypt.mjs';
import {
  canFinish,
  canStart,
  canStop,
  choosePlan,
  createApi,
  formatClock,
  mergeServerDay,
  normalizeTask,
  parseSectionBody,
  phase,
  pressStart,
  pressStop,
  progressMessage,
  tick,
  timeLabel,
  toggleDone,
  toggleFlag,
  untick,
} from '../../site/src/logic.mjs';

const task = (over = {}) =>
  normalizeTask({ id: 't1', plan: 'A', title: 'Calc 3 practice', tag: 'calculus3', start: '16:00', minutes: 40, done: false, ...over });
const T0 = '2026-10-08T23:20:00.000Z';

describe('site: task rules (same as the phone app)', () => {
  it('idle -> running -> done, and which controls each phase allows', () => {
    let t = task();
    expect(phase(t)).toBe('idle');
    expect([canStart(t), canFinish(t), canStop(t)]).toEqual([true, false, false]);
    t = pressStart(t, T0);
    expect(phase(t)).toBe('running');
    expect([canStart(t), canFinish(t), canStop(t)]).toEqual([false, true, true]);
    t = tick(t);
    expect(phase(t)).toBe('done');
    expect([canStart(t), canFinish(t), canStop(t)]).toEqual([false, false, false]);
    expect(t.startedAt).toBe(T0); // finishing keeps the Start press
  });

  it('keeps the first Start press and ignores Start on a finished task', () => {
    const running = pressStart(task(), T0);
    expect(pressStart(running, '2026-10-09T01:00:00.000Z').startedAt).toBe(T0);
    expect(pressStart(task({ done: true }), T0).startedAt).toBeNull();
  });

  it('a tick with no Start press is allowed and has no timer', () => {
    const t = toggleDone(task());
    expect(phase(t)).toBe('done');
    expect(t.startedAt).toBeNull();
  });

  it('Stop only works while running, forgets the start, and never ticks', () => {
    const stopped = pressStop(pressStart(task(), T0));
    expect(phase(stopped)).toBe('idle');
    expect(stopped.done).toBe(false);
    expect(phase(pressStop(task()))).toBe('idle');
    const finished = { ...task({ done: true }), startedAt: T0 };
    expect(pressStop(finished).startedAt).toBe(T0); // no stop on a finished task
  });

  it('unticking starts the task over (no start, START available, no stop)', () => {
    const t = toggleDone({ ...tick(pressStart(task(), T0)) });
    expect(t.done).toBe(false);
    expect(t.startedAt).toBeNull();
    expect([canStart(t), canStop(t)]).toEqual([true, false]);
    expect(untick(task({ done: true })).startedAt).toBeNull();
  });

  it('the flag survives every transition, and a second round records a fresh start', () => {
    let t = task({ flagged: true });
    t = pressStart(t, T0);
    t = tick(t);
    t = untick(t);
    t = pressStart(t, '2026-10-09T02:00:00.000Z');
    t = pressStop(t);
    expect(t.flagged).toBe(true);
    expect(toggleFlag(t).flagged).toBe(false);
    expect(pressStart(untick(tick(pressStart(task(), T0))), '2026-10-09T03:00:00.000Z').startedAt).toBe('2026-10-09T03:00:00.000Z');
  });
});

describe('site: helpers', () => {
  it('formats clocks, time labels and progress messages', () => {
    expect(formatClock('15:30')).toBe('3:30pm');
    expect(formatClock('00:05')).toBe('12:05am');
    expect(formatClock('12:00')).toBe('12:00pm');
    expect(formatClock('oops')).toBe('oops');
    expect(timeLabel(task())).toBe('4:00pm · 40m');
    expect(timeLabel(task({ start: null, minutes: null }))).toBeNull();
    expect(progressMessage(0, 4)).toBe('');
    expect(progressMessage(4, 4)).toContain('YOU DID IT');
    expect(progressMessage(2, 4)).toContain('halfway');
  });

  it('normalizes tasks from an older server (no started or flagged) and drops bad tags', () => {
    const t = normalizeTask({ id: 'x', title: 'A', tag: 'weird', done: true });
    expect(t).toMatchObject({ plan: 'A', tag: 'school', startedAt: null, flagged: false, done: true, notes: null });
  });

  it('opens the plan he is following; keeps the current plan on a tie', () => {
    const mk = (plan, done) => task({ id: plan + done + Math.random(), plan, done });
    expect(choosePlan([mk('A', false), mk('B', true)], 'A')).toBe('B');
    expect(choosePlan([mk('A', true), mk('B', false)], 'B')).toBe('A');
    expect(choosePlan([mk('A', false), mk('B', false)], 'B')).toBe('B');
    expect(choosePlan([mk('B', false)], 'A')).toBe('B');
    expect(choosePlan([], 'A')).toBe('A');
  });

  it('keeps local copies of tasks with a change in flight when merging a refresh', () => {
    const local = [task({ id: 'a', done: true }), task({ id: 'b', done: false })];
    const server = [task({ id: 'a', done: false }), task({ id: 'b', done: false }), task({ id: 'c' })];
    const merged = mergeServerDay(local, server, new Set(['a']));
    expect(merged.map((t) => [t.id, t.done])).toEqual([['a', true], ['b', false], ['c', false]]);
  });

  it('turns an info section body into text and checklist lines', () => {
    expect(parseSectionBody('- [ ] phone away\nplain line\n[ ] water')).toEqual([
      { kind: 'check', text: 'phone away' },
      { kind: 'text', text: 'plain line' },
      { kind: 'check', text: 'water' },
    ]);
  });
});

describe('site: server calls', () => {
  const fake = (responder) => {
    const calls = [];
    const fetchImpl = async (url, init) => {
      calls.push({ url, method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : null, auth: init.headers.Authorization });
      return responder(url, init);
    };
    return { calls, api: createApi({ baseUrl: 'https://planner.example/', token: 'secret-token-0123456789', fetchImpl }) };
  };
  const json = (status, body) => ({ status, json: async () => body });

  it('reads the day, sending the token, with no date (the server decides the planner day)', async () => {
    const { api, calls } = fake(() =>
      json(200, { date: '2026-10-08', headline: 'Hi', sections: [{ title: 'Warnings', body: '- x' }], rating: 4, tasks: [{ id: 'a', plan: 'B', title: 'T', tag: 'sat', done: false, started: T0, flagged: true }] }),
    );
    const day = await api.getDay();
    expect(calls[0]).toMatchObject({ url: 'https://planner.example/api/tasks', method: 'GET', auth: 'Bearer secret-token-0123456789' });
    expect(day).toMatchObject({ date: '2026-10-08', headline: 'Hi', rating: 4 });
    expect(day.tasks[0]).toMatchObject({ plan: 'B', startedAt: T0, flagged: true });
  });

  it('reports a wrong token, a server error and an unreachable server in plain words', async () => {
    await expect(fake(() => json(401, {})).api.getDay()).rejects.toThrow('wrong token');
    await expect(fake(() => json(500, {})).api.getDay()).rejects.toThrow('server error (500)');
    await expect(fake(() => { throw new Error('boom'); }).api.getDay()).rejects.toThrow("can't reach server");
  });

  it('ticking sends done; unticking also clears the start; start/flag/rating go to the right places', async () => {
    const { api, calls } = fake(() => json(200, {}));
    expect(await api.setDone('a b', true)).toBe(true);
    await api.setDone('a b', false);
    await api.setStarted('a b', true);
    await api.setFlagged('a b', true);
    await api.setRating(null);
    expect(calls.map((c) => [c.method, c.url.replace('https://planner.example', ''), c.body])).toEqual([
      ['PATCH', '/api/tasks/a%20b', { done: true }],
      ['PATCH', '/api/tasks/a%20b', { done: false, started: false }],
      ['PATCH', '/api/tasks/a%20b', { started: true }],
      ['PATCH', '/api/tasks/a%20b', { flagged: true }],
      ['PUT', '/api/rating', { rating: null }],
    ]);
  });

  it('returns false (so the screen reverts) when the server refuses or is unreachable', async () => {
    expect(await fake(() => json(500, {})).api.setDone('a', true)).toBe(false);
    expect(await fake(() => { throw new Error('offline'); }).api.setStarted('a', true)).toBe(false);
    expect(await fake(() => json(400, {})).api.setRating(9)).toBe(false);
  });
});

describe('site: the lock', () => {
  const PASSWORD = 'Test!pass-9876-xyz';

  it('round-trips with the exact layout: salt | iv | ciphertext + 16-byte tag, AES-256-GCM, PBKDF2-SHA256', async () => {
    const blob = encryptBlob(PASSWORD, 'hello planner');
    const raw = fromBase64(blob);
    expect(raw.length).toBe(SALT_BYTES + IV_BYTES + Buffer.byteLength('hello planner') + 16);
    expect(PBKDF2_ITERATIONS).toBeGreaterThanOrEqual(600000);
    expect(await decryptBlob(PASSWORD, blob)).toBe('hello planner');
  });

  it('a wrong password, a nearly right one, or a damaged blob all give null, never an error', async () => {
    const blob = encryptBlob(PASSWORD, 'secret');
    expect(await decryptBlob('wrong', blob)).toBeNull();
    expect(await decryptBlob('test!pass-9876-xyz', blob)).toBeNull(); // case matters
    expect(await decryptBlob(PASSWORD + ' ', blob)).toBeNull(); // exact: no trimming
    expect(await decryptBlob('', blob)).toBeNull();
    const raw = Buffer.from(blob, 'base64');
    raw[raw.length - 1] ^= 1; // flip one bit in the tag
    expect(await decryptBlob(PASSWORD, raw.toString('base64'))).toBeNull();
    expect(await decryptBlob(PASSWORD, 'not base64 !!')).toBeNull();
  });

  it('each encryption uses a fresh salt and IV', () => {
    expect(encryptBlob(PASSWORD, 'same')).not.toBe(encryptBlob(PASSWORD, 'same'));
  });
});

describe('site: the build and the locked page', () => {
  const PASSWORD = 'Test!pass-9876-xyz';
  const URL_ = 'https://cozy-planner.example.workers.dev';
  const TOKEN = 'tok-abcdef0123456789-SECRET';
  let built;
  const getBuilt = async () => (built ??= await buildSite({ url: URL_, token: TOKEN, password: PASSWORD }));

  it('refuses bad settings', () => {
    expect(validateConfig({ url: 'not a url', token: TOKEN, password: PASSWORD })).toHaveLength(1);
    expect(validateConfig({ url: 'http://planner.example', token: TOKEN, password: PASSWORD })[0]).toContain('https://');
    expect(validateConfig({ url: 'http://127.0.0.1:8799', token: TOKEN, password: PASSWORD })).toEqual([]);
    expect(validateConfig({ url: URL_, token: 'short', password: PASSWORD })).toHaveLength(1);
    expect(validateConfig({ url: URL_, token: TOKEN, password: '' })).toHaveLength(1);
  });

  it('the served page contains no planner code, address or token, and no unlock hint', async () => {
    const { html } = await getBuilt();
    for (const secret of [TOKEN, URL_, PASSWORD, 'createApi', 'FINISH', 'planner', 'api/tasks', 'workers.dev']) {
      expect(html, secret).not.toContain(secret);
    }
    const visible = html.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<style[\s\S]*?<\/style>/g, '');
    expect(visible).not.toMatch(/unlock|password|login|sign in|secret/i);
    expect(html).toContain('<title>Search</title>');
    expect(html).not.toMatch(/<!--/);
  });

  it('the encrypted app page carries the settings and the whole app', async () => {
    const { appHtml } = await getBuilt();
    expect(appHtml).toContain(TOKEN);
    expect(appHtml).toContain('HOW DID TODAY FEEL?');
    expect(appHtml).toContain('function createApi');
    expect(appHtml).not.toMatch(/^export /m);
  });

  /** Runs the served page's own script against a tiny fake document, like a browser would. */
  async function runPage(html, typed) {
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
    const els = {
      f: { listeners: {}, addEventListener(t, fn) { this.listeners[t] = fn; } },
      q: { value: '' },
      r: { textContent: '' },
    };
    const written = [];
    const document = {
      getElementById: (id) => els[id],
      open: () => written.push('open'),
      write: (s) => written.push(s),
      close: () => written.push('close'),
    };
    const ctx = vm.createContext({ document, crypto: globalThis.crypto, atob, TextEncoder, TextDecoder, Uint8Array, Promise });
    for (const s of scripts) vm.runInContext(s, ctx);
    els.q.value = typed;
    els.f.listeners.submit({ preventDefault() {} });
    await new Promise((r) => setTimeout(r, 1500)); // PBKDF2 takes a moment
    return { out: els.r.textContent, written };
  }

  it('a wrong guess behaves like an ordinary empty search: no error, no hint, nothing written', async () => {
    const { html } = await getBuilt();
    const { out, written } = await runPage(html, 'hello');
    expect(out).toBe('No results for “hello”');
    expect(written).toEqual([]);
  });

  it('an empty search does nothing', async () => {
    const { html } = await getBuilt();
    const { out, written } = await runPage(html, '');
    expect(out).toBe('');
    expect(written).toEqual([]);
  });

  it('the exact password swaps the page for the app', async () => {
    const { html, appHtml } = await getBuilt();
    const { written } = await runPage(html, PASSWORD);
    expect(written).toEqual(['open', appHtml, 'close']);
  });
});
