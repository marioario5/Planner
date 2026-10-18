import { describe, expect, it } from 'vitest';
import { handleRequest } from '../src/index';
import { MemoryTaskStore } from './memory-store';

const env = { API_TOKEN: 'a'.repeat(40), PLANNER_TZ: 'America/Los_Angeles' } as any;
const auth = { Authorization: `Bearer ${env.API_TOKEN}`, 'Content-Type': 'application/json' };
const now = new Date(Date.UTC(2026, 9, 12, 3, 0)); // Oct 11, 8pm PDT

function setup() {
  const store = new MemoryTaskStore();
  const put = (id: string, body: unknown) =>
    handleRequest(new Request(`https://x/api/gym/${id}`, { method: 'PUT', headers: auth, body: JSON.stringify(body) }), env, store, now);
  const tool = async () => {
    const res = await handleRequest(
      new Request('https://x/mcp', {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_gym_sessions', arguments: {} } }),
      }),
      env,
      store,
      now,
    );
    return JSON.parse(((await res.json()) as any).result.content[0].text);
  };
  return { store, put, tool };
}

describe('gym sessions', () => {
  it('records a start, then the end, under the same id', async () => {
    const { put, tool } = setup();
    expect((await put('g1', { started: '2026-10-11T23:00:00Z' })).status).toBe(200);
    expect((await tool()).sessions).toEqual([{ date: '2026-10-11', start: '16:00', end: null, minutes: null, open: true }]);
    await put('g1', { started: '2026-10-11T23:00:00Z', ended: '2026-10-12T00:10:00Z' });
    expect((await tool()).sessions).toEqual([{ date: '2026-10-11', start: '16:00', end: '17:10', minutes: 70, open: false }]);
  });

  it('a retried start does not erase the end, and a repeat does not duplicate', async () => {
    const { put, store } = setup();
    await put('g1', { started: '2026-10-11T23:00:00Z', ended: '2026-10-12T00:00:00Z' });
    await put('g1', { started: '2026-10-11T23:00:00Z' }); // late retry of the first message
    await put('g1', { started: '2026-10-11T23:00:00Z', ended: null });
    expect(store.gym).toEqual([{ id: 'g1', startedAt: '2026-10-11T23:00:00.000Z', endedAt: '2026-10-12T00:00:00.000Z' }]);
  });

  it('rejects bad input and needs the token', async () => {
    const { put } = setup();
    expect((await put('g1', { started: 'nope' })).status).toBe(400);
    expect((await put('g1', { started: '2026-10-11T23:00:00Z', ended: '2026-10-11T22:00:00Z' })).status).toBe(400);
    expect((await put('bad id!', { started: '2026-10-11T23:00:00Z' })).status).toBe(400);
    const anon = await handleRequest(new Request('https://x/api/gym/g1', { method: 'PUT', body: '{}' }), env, new MemoryTaskStore(), now);
    expect(anon.status).toBe(401);
  });
});

describe('get_history latest_day_info', () => {
  it("returns yesterday's notes (such as Next PCB work), and null when there are none", async () => {
    const store = new MemoryTaskStore();
    const call = async (name: string, args: any) => {
      const res = await handleRequest(
        new Request('https://x/mcp', { method: 'POST', headers: auth, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) }),
        env, store, now,
      );
      return JSON.parse(((await res.json()) as any).result.content[0].text);
    };
    expect((await call('get_history', {})).latest_day_info).toBeNull();
    await call('set_day_info', { date: '2026-10-10', headline: 'Sat', sections: [{ title: 'Next PCB work', body: '- Dr Dish bench Sunday, first step: power check' }] });
    const h = await call('get_history', {});
    expect(h.latest_day_info).toEqual({ date: '2026-10-10', headline: 'Sat', sections: [{ title: 'Next PCB work', body: '- Dr Dish bench Sunday, first step: power check' }] });
    expect(h.last_next_pcb_work).toEqual({ date: '2026-10-10', body: '- Dr Dish bench Sunday, first step: power check' });
    // a later chat update replaces the newer day's notes: the promise is still found on the earlier day
    await call('set_day_info', { date: '2026-10-11', headline: 'Rest', sections: [{ title: 'Warnings', body: '- rest' }] });
    const h2 = await call('get_history', {});
    expect(h2.latest_day_info.date).toBe('2026-10-11');
    expect(h2.last_next_pcb_work.date).toBe('2026-10-10');
  });
});
