import { describe, expect, it } from 'vitest';
import { handleRequest } from '../src/index';
import { MemoryTaskStore } from './memory-store';

const env = { API_TOKEN: 'a'.repeat(40), READ_TOKEN: 'r'.repeat(40), PLANNER_TZ: 'America/Los_Angeles' } as any;
const full = { Authorization: `Bearer ${env.API_TOKEN}`, 'Content-Type': 'application/json' };
const readOnly = { Authorization: `Bearer ${env.READ_TOKEN}` };
const now = new Date(Date.UTC(2026, 9, 19, 3, 30)); // Sun Oct 18, 8:30pm PDT

async function setup() {
  const store = new MemoryTaskStore();
  const tool = async (name: string, args: any) => {
    const res = await handleRequest(
      new Request('https://x/mcp', { method: 'POST', headers: full, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) }),
      env, store, now,
    );
    return JSON.parse(((await res.json()) as any).result.content[0].text);
  };
  const running = (headers: Record<string, string>, path = '/api/running') => handleRequest(new Request(`https://x${path}`, { headers }), env, store, now);
  const plan = await tool('set_daily_plan', {
    date: '2026-10-18',
    tasks: [
      { title: 'Calc 3: 6.6 practice', tag: 'calculus3', start: '19:00', minutes: 45, notes: 'private detail about a head injury' },
      { title: 'PIQ 6', tag: 'college', start: '20:00', minutes: 20 },
    ],
  });
  return { store, tool, running, ids: plan.tasks.map((t: any) => t.id) as string[] };
}

describe('GET /api/running', () => {
  it('says nothing is running until Start is pressed', async () => {
    const { running } = await setup();
    const body: any = await (await running(readOnly)).json();
    expect(body.running).toBeNull();
    expect(body.planner_date).toBe('2026-10-18');
  });

  it('shows the running task with worked time, and never its notes', async () => {
    const { tool, running, ids } = await setup();
    await tool('update_task', { id: ids[0], started_at: '19:00' });
    const res = await running(readOnly);
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.running).toMatchObject({ id: ids[0], title: 'Calc 3: 6.6 practice', tag: 'calculus3', planned_min: 45, paused: false, paused_sec: 0, elapsed_sec: 5400 });
    expect(body.day).toEqual({ plan: 'A', done: 0, total: 2 });
    expect(JSON.stringify(body)).not.toContain('head injury');
  });

  it('stops the clock during an open pause and subtracts finished pauses', async () => {
    const { tool, running, ids } = await setup();
    await tool('update_task', { id: ids[0], started_at: '19:00' });
    await tool('update_task', { id: ids[0], paused_at: '20:00' }); // paused for the last 30 minutes
    const paused: any = await (await running(readOnly)).json();
    expect(paused.running).toMatchObject({ paused: true, elapsed_sec: 3600 });
    await tool('update_task', { id: ids[0], paused_min: 10 });
    const after: any = await (await running(readOnly)).json();
    expect(after.running.paused_sec).toBe(600);
  });

  it('drops out once the task is finished', async () => {
    const { tool, running, ids } = await setup();
    await tool('update_task', { id: ids[0], started_at: '19:00' });
    await tool('update_task', { id: ids[0], done: true, completed: '19:40' });
    expect(((await (await running(readOnly)).json()) as any).running).toBeNull();
  });

  it('the read-only token can only read this one endpoint; the full token works too; others are refused', async () => {
    const { running } = await setup();
    expect((await running(readOnly)).status).toBe(200);
    expect((await running(full)).status).toBe(200);
    expect((await running({ Authorization: 'Bearer wrong-token-wrong-token' })).status).toBe(401);
    expect((await running({})).status).toBe(401);
    expect((await running(readOnly, '/api/tasks?date=2026-10-18')).status).toBe(401);
    const post = await handleRequest(new Request('https://x/api/running', { method: 'POST', headers: readOnly }), env, new MemoryTaskStore(), now);
    expect(post.status).toBe(405);
  });

  it('without a READ_TOKEN configured, only the full token reads it', async () => {
    const res = await handleRequest(new Request('https://x/api/running', { headers: { Authorization: 'Bearer ' + 'x'.repeat(40) } }), { ...env, READ_TOKEN: undefined }, new MemoryTaskStore(), now);
    expect(res.status).toBe(401);
  });
});
