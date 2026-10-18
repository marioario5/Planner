import { afterEach, describe, expect, it, vi } from 'vitest';
import { handleRequest } from '../src/index';
import { FirebaseSite, parseResets } from '../src/firebase';
import { MemoryTaskStore } from './memory-store';

const env = { API_TOKEN: 'a'.repeat(40), PLANNER_TZ: 'America/Los_Angeles' } as any;
const auth = { Authorization: `Bearer ${env.API_TOKEN}`, 'Content-Type': 'application/json' };
const now = new Date(Date.UTC(2026, 9, 18, 19, 0)); // Sun Oct 18, noon PDT
const RESET = 1792347017018; // the site's plan rewrite, Oct 18 2026 ~11:10 PDT

afterEach(() => vi.unstubAllGlobals());

function rpc(store: MemoryTaskStore, sync?: any) {
  return async (name: string, args: any) => {
    const res = await handleRequest(
      new Request('https://x/mcp', { method: 'POST', headers: auth, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) }),
      env, store, now, sync,
    );
    const body: any = await res.json();
    const text = body.result.content[0].text;
    return { isError: !!body.result.isError, data: body.result.isError ? text : JSON.parse(text) };
  };
}

describe('a daily item (Calc 3)', () => {
  async function setup() {
    const store = new MemoryTaskStore();
    const tool = rpc(store);
    await tool('set_commitments', {
      reviewed: true,
      commitments: [{ id: 'calc3-daily', title: 'Calc 3: every day', due: '2026-11-06', target_minutes: 1200, daily: true }],
    });
    return { store, tool };
  }

  it('is protected too, and can never be deferred, not even on his word', async () => {
    const { tool } = await setup();
    const f = (await tool('get_framework', {})).data;
    expect(f.daily).toEqual(['calc3-daily']);
    expect(f.protected).toEqual(['calc3-daily']);
    const r = await tool('defer_commitment', { id: 'calc3-daily', until: '2026-10-20', reason: 'he is tired today, really', his_words: 'skip Calc today please' });
    expect(r.isError).toBe(true);
    expect(r.data).toContain('never deferred');
  });

  it('needs a block in every plan, and says so when the plan has none', async () => {
    const { tool } = await setup();
    const miss = (await tool('set_daily_plan', { date: '2026-10-18', tasks: [{ title: 'Homework', minutes: 30 }] })).data;
    expect(miss.framework_check.floor_blocks_missing).toEqual([expect.objectContaining({ id: 'calc3-daily', daily: true })]);
    const ok = (await tool('set_daily_plan', { date: '2026-10-18', tasks: [{ title: 'Calc 3: 6.6 more practice', minutes: 40, commitment: 'calc3-daily' }] })).data;
    expect(ok.framework_check?.floor_blocks_missing).toBeUndefined();
  });

  it('only he can make it stop being daily or unprotect it', async () => {
    const { tool } = await setup();
    expect((await tool('set_commitments', { commitments: [{ id: 'calc3-daily', protected: false, his_words: 'unprotect Calc please' }] })).isError).toBe(true);
    expect((await tool('set_commitments', { commitments: [{ id: 'calc3-daily', daily: false }] })).isError).toBe(true);
    expect((await tool('set_commitments', { commitments: [{ id: 'calc3-daily', daily: false, his_words: 'Calc is not daily any more' }] })).isError).toBe(false);
  });
});

describe('check marks that predate a rewrite of the site plan', () => {
  it('parses resets and ignores bad pieces', () => {
    expect(parseResets('calc3-:1792347017018, junk ,x-:abc')).toEqual([{ prefix: 'calc3-', ms: 1792347017018 }]);
    expect(parseResets(undefined)).toEqual([]);
  });

  const state = {
    at: RESET - 1000,
    tasks: [['calc3-t5', 1, RESET - 5_000_000], ['calc3-t6', 0, RESET - 4_000_000], ['calc3-t7', 1, RESET + 60_000], ['master-t1', 1, RESET - 9_000_000]],
    days: { t: RESET - 100_000, value: { calc3: { rest: [1, 2, 3], sig: '59x24:calc3-t5..calc3-t63' } } },
    cal: [],
  };
  const site = () => new FirebaseSite('https://firebase.example/state.json', 5000, parseResets(`calc3-:${RESET}`));
  const stubFetch = () => vi.stubGlobal('fetch', async () => new Response(JSON.stringify(state), { headers: { ETag: 'e1' } }));

  it('drops old entries under the prefix only, keeping newer ones and other prefixes', async () => {
    stubFetch();
    const snap = await site().read();
    expect([...snap.entries.keys()].sort()).toEqual(['calc3-t7', 'master-t1']);
    expect(snap.ignored).toBe(2);
  });

  it('get_site_progress reports stale state and gives no rest slots', async () => {
    stubFetch();
    const tool = rpc(new MemoryTaskStore(), { site: site(), prefixes: ['calc3-'], resets: parseResets(`calc3-:${RESET}`) });
    const r = (await tool('get_site_progress', {})).data;
    expect(r.tasks.map((t: any) => t.id)).toEqual(['calc3-t7']);
    expect(r.calc3_rest).toEqual([]);
    expect(r.calc3_sig).toBe('59x24:calc3-t5..calc3-t63');
    expect(r.stale_state).toMatchObject({ ignored_entries: 2, rest_slots_ignored: true });
    expect(r.stale_state.why).toContain('opens the progress site');
  });

  it("an old check mark no longer marks today's new lesson done", async () => {
    stubFetch();
    const store = new MemoryTaskStore();
    const tool = rpc(store, { site: site(), prefixes: ['calc3-'], resets: parseResets(`calc3-:${RESET}`) });
    const plan = (await tool('set_daily_plan', { date: '2026-10-18', tasks: [{ title: 'Calc 3: 6.6 more practice', minutes: 40, siteKey: 'calc3-t5' }] })).data;
    expect(plan.tasks[0].done).toBe(false); // the old plan's t5 was ticked on Oct 1
  });
});
