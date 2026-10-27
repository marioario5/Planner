import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildSchedule, clearCalcSourceCache, loadCalcSource, parseCalcSource } from '../src/calc-source';
import { handleRequest } from '../src/index';
import { FirebaseSite, parseEntries } from '../src/firebase';
import { MemoryTaskStore } from './memory-store';

// A small stand-in for the site's page: the same shapes the real one has, six days in two weeks.
const PAGE = `<html><script>const DATA = {"SECTIONS": [
{"doc": "calc3", "id": "calc3-s5", "level": 2, "title": "Week 1", "text": "Week 1 text with [brackets] and {braces}", "range": {"label": "Oct 19-21", "start": [2026, 10, 19], "end": [2026, 10, 21]}},
{"doc": "calc3", "id": "calc3-s6", "level": 2, "title": "Week 2", "text": "Week 2", "range": {"label": "Oct 22-24", "start": [2026, 10, 22], "end": [2026, 10, 24]}}
], "DAY_GRIDS": [
{"week": "calc3-s5", "days": [{"id": "calc3-t6", "rest": true}, {"id": "calc3-t7", "rest": false}, {"id": "calc3-t8", "rest": false}]},
{"week": "calc3-s6", "days": [{"id": "calc3-t9", "rest": false}, {"id": "calc3-t10", "rest": true}, {"id": "calc3-t11", "rest": false}]}
], "STATE_RESETS": {"calc3": {"token": "2026-10-19-plan", "at": 2000000}}};</script>
<ul><li><input type="checkbox" data-task-id="calc3-t6" ><span>Rest &#x27;n&#x27; recover</span></li>
<li><input type="checkbox" data-task-id="calc3-t7" ><span>6.6 learn</span></li>
<li><input type="checkbox" data-task-id="calc3-t8" ><span>6.6 quiz</span></li>
<li><input type="checkbox" data-task-id="calc3-t9" ><span><strong>Chapter 6 Test</strong></span></li>
<li><input type="checkbox" data-task-id="calc3-t10" ><span>Rest</span></li>
<li><input type="checkbox" data-task-id="calc3-t11" ><span>Ch. 1 review</span></li></ul></html>`;

afterEach(() => {
  vi.unstubAllGlobals();
  clearCalcSourceCache();
});

describe('reading the Calc 3 schedule from the site page', () => {
  it('finds the weeks with their dates, the titles (bold stripped, entities decoded), the reset time and the signature', () => {
    const src = parseCalcSource(PAGE)!;
    expect(src.weeks.map((w) => [w.id, w.start])).toEqual([['calc3-s5', [2026, 10, 19]], ['calc3-s6', [2026, 10, 22]]]);
    expect(src.titles['calc3-t9']).toBe('Chapter 6 Test');
    expect(src.titles['calc3-t6']).toBe("Rest 'n' recover");
    expect(src.resetAt).toBe(2_000_000);
    expect(src.resetToken).toBe('2026-10-19-plan');
    expect(src.sig).toBe('6x2:calc3-t7..calc3-t11');
    expect(parseCalcSource('<html>nothing</html>')).toBeNull();
  });

  it('gives each day its real date, lesson and rest rows as the plan wrote them', () => {
    const { days, rest_days_from } = buildSchedule(parseCalcSource(PAGE)!, undefined);
    expect(rest_days_from).toBe('the plan as written');
    expect(days.map((d) => [d.date, d.id, d.rest])).toEqual([
      ['2026-10-19', 'calc3-t6', true],
      ['2026-10-20', 'calc3-t7', false],
      ['2026-10-21', 'calc3-t8', false],
      ['2026-10-22', 'calc3-t9', false],
      ['2026-10-23', 'calc3-t10', true],
      ['2026-10-24', 'calc3-t11', false],
    ]);
  });

  it('uses the rest days he saved only when they belong to this plan and were saved after it was written', () => {
    const src = parseCalcSource(PAGE)!;
    const moved = buildSchedule(src, { sig: src.sig, rest: [1, 4], t: 3_000_000 }); // rest moved from Oct 19 to Oct 20
    expect(moved.rest_days_from).toBe('his saved changes');
    expect(moved.days.map((d) => [d.date, d.id, d.rest]).slice(0, 3)).toEqual([['2026-10-19', 'calc3-t7', false], ['2026-10-20', 'calc3-t6', true], ['2026-10-21', 'calc3-t8', false]]);
    expect(buildSchedule(src, { sig: src.sig, rest: [1, 4], t: 1_000_000 }).rest_days_from).toBe('the plan as written'); // older than the plan
    expect(buildSchedule(src, { sig: '59x24:calc3-t5..calc3-t63', rest: [1, 4], t: 3_000_000 }).rest_days_from).toBe('the plan as written'); // another plan's
    expect(buildSchedule(src, { sig: src.sig, rest: [1], t: 3_000_000 }).rest_days_from).toBe('the plan as written'); // does not balance
  });

  // The site leaves a pinned rest day (the SAT) out of its movable rests and lessons, so its signature counts one rest fewer than the grid has.
  const PINNED_PAGE = PAGE.replace('{"id": "calc3-t11", "rest": false}', '{"id": "calc3-t11", "rest": true, "pinned": true}');

  it('computes the same signature as the site: a pinned rest day counts as neither a movable rest nor a lesson', () => {
    expect(parseCalcSource(PINNED_PAGE)!.sig).toBe('6x2:calc3-t7..calc3-t9'); // t6 and t10 are movable rests; t11 is pinned; the lessons are t7 to t9
  });

  it('ignores a saved layout made for a different shape of plan, and keeps a pinned day where it is', () => {
    const src = parseCalcSource(PINNED_PAGE)!;
    const stale = buildSchedule(src, { sig: '6x3:calc3-t7..calc3-t9', rest: [0, 3, 4], t: 3_000_000 }); // saved before the SAT was pinned
    expect(stale.rest_days_from).toBe('the plan as written');
    const day = (r: ReturnType<typeof buildSchedule>, date: string) => r.days.find((d) => d.date === date)!;
    expect(day(stale, '2026-10-24')).toMatchObject({ id: 'calc3-t11', rest: true }); // the pinned day is rest whatever else happens
    const moved = buildSchedule(src, { sig: src.sig, rest: [1, 3], t: 3_000_000 }); // movable rests moved to Oct 20 and Oct 22
    expect(moved.rest_days_from).toBe('his saved changes');
    expect(moved.days.map((d) => [d.date, d.rest])).toEqual([['2026-10-19', false], ['2026-10-20', true], ['2026-10-21', false], ['2026-10-22', true], ['2026-10-23', false], ['2026-10-24', true]]);
    expect(buildSchedule(src, { sig: src.sig, rest: [1, 5], t: 3_000_000 }).rest_days_from).toBe('the plan as written'); // a rest slot on the pinned day is not a valid layout
  });

  it("uses the site's own published schedule when its signature matches, and not when it does not", () => {
    const src = parseCalcSource(PAGE)!;
    const live = [
      { date: '2026-10-19', id: 'calc3-t7', rest: false },
      { date: '2026-10-20', id: 'calc3-t6', rest: true },
      { date: '2026-10-21', id: 'calc3-t8', rest: false },
      { date: '2026-10-22', id: 'calc3-t9', rest: false },
      { date: '2026-10-23', id: 'calc3-t10', rest: true },
      { date: '2026-10-24', id: 'calc3-t11', rest: false },
    ];
    const r = buildSchedule(src, { sig: src.sig, live, t: 3_000_000 });
    expect(r.rest_days_from).toBe("the site's own saved schedule");
    expect(r.days.map((d) => [d.date, d.id, d.rest])).toEqual(live.map((d) => [d.date, d.id, d.rest]));
    expect(buildSchedule(src, { sig: '59x24:old', live, t: 3_000_000 }).rest_days_from).toBe('the plan as written');
    expect(buildSchedule(src, { sig: src.sig, live: live.slice(0, 3), t: 3_000_000 }).rest_days_from).toBe('the plan as written'); // wrong length
  });

  it('is cached for ten minutes and keeps the last good copy if a later fetch fails', async () => {
    let calls = 0;
    let fail = false;
    const fetchImpl = (async () => {
      calls++;
      return fail ? new Response('nope', { status: 500 }) : new Response(PAGE);
    }) as unknown as typeof fetch;
    const first = await loadCalcSource('https://x/page', 1_000, fetchImpl);
    await loadCalcSource('https://x/page', 60_000, fetchImpl);
    expect(calls).toBe(1);
    fail = true;
    const later = await loadCalcSource('https://x/page', 700_000, fetchImpl);
    expect(calls).toBe(2);
    expect(later?.sig).toBe(first?.sig);
  });
});

describe('get_site_progress with the schedule', () => {
  const env = { API_TOKEN: 'a'.repeat(40), PLANNER_TZ: 'America/Los_Angeles' } as any;
  const auth = { Authorization: `Bearer ${env.API_TOKEN}`, 'Content-Type': 'application/json' };
  const now = new Date(Date.UTC(2026, 9, 21, 19, 0)); // Wed Oct 21, noon PDT

  const siteWith = (state: Record<string, unknown>) => ({
    read: async () => ({ etag: null, state, entries: parseEntries(state) }),
    write: async () => true,
  });
  const call = async (sync: any) => {
    const res = await handleRequest(
      new Request('https://x/mcp', { method: 'POST', headers: auth, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_site_progress', arguments: {} } }) }),
      env, new MemoryTaskStore(), now, sync,
    );
    return JSON.parse(((await res.json()) as any).result.content[0].text);
  };

  it("gives today's lesson and the whole plan, counts only check marks made after the plan was written, and reports the old state as stale", async () => {
    const state = {
      at: 5_000_000,
      tasks: [['calc3-t7', 1, 4_000_000], ['calc3-t8', 1, 500_000], ['calc3-t9', 0, 4_000_000]], // t8 was ticked under an older plan
      days: { t: 100, value: { calc3: { sig: '59x24:calc3-t5..calc3-t63', rest: [1, 2, 3] } } },
      cal: [],
    };
    const r = await call({ site: siteWith(state), prefixes: ['calc3-'], calcSource: async () => parseCalcSource(PAGE) });
    expect(r.calc3_schedule.plan).toBe('2026-10-19-plan');
    expect(r.calc3_schedule.rest_days_from).toBe('the plan as written');
    expect(r.calc3_schedule.today).toMatchObject({ date: '2026-10-21', id: 'calc3-t8', rest: false, title: '6.6 quiz', done: false });
    expect(r.calc3_schedule.days.find((d: any) => d.id === 'calc3-t7').done).toBe(true);
    expect(r.calc3_schedule.remaining_lessons).toBe(3); // t8, t9, t11 are from today on and not done
    expect(r.tasks.map((t: any) => t.id)).toEqual(['calc3-t7', 'calc3-t9']); // the old t8 is left out
    expect(r.calc3_rest).toEqual([]);
    expect(r.stale_state).toMatchObject({ ignored_entries: 1, rest_slots_ignored: true });
    expect(r.stale_state.why).toContain('calc3_schedule');
  });

  it('still answers when the page cannot be read', async () => {
    const state = { at: 1, tasks: [], days: { t: 100, value: { calc3: { sig: 'x', rest: [] } } }, cal: [] };
    const r = await call({ site: siteWith(state), prefixes: ['calc3-'], calcSource: async () => null });
    expect(r.calc3_schedule).toBeUndefined();
    expect(r.tasks).toEqual([]);
  });
});

describe("the old-plan guard follows the site's own reset time", () => {
  const state = { tasks: [['calc3-t6', 1, 1_000], ['calc3-t7', 1, 3_000], ['master-t1', 1, 1_000]] };
  const stub = () => vi.stubGlobal('fetch', async () => new Response(JSON.stringify(state), { headers: { ETag: 'e' } }));

  it('drops check marks older than the reset it is told about, and ignores a failing lookup', async () => {
    stub();
    const withReset = new FirebaseSite('https://f/state.json', 5000, [], async () => [{ prefix: 'calc3-', ms: 2_000 }]);
    expect([...(await withReset.read()).entries.keys()].sort()).toEqual(['calc3-t7', 'master-t1']);
    const broken = new FirebaseSite('https://f/state.json', 5000, [], async () => {
      throw new Error('page unreachable');
    });
    expect((await broken.read()).entries.size).toBe(3);
  });
});

describe('the daily Calc item on a rest day', () => {
  const env = { API_TOKEN: 'a'.repeat(40), PLANNER_TZ: 'America/Los_Angeles' } as any;
  const auth = { Authorization: `Bearer ${env.API_TOKEN}`, 'Content-Type': 'application/json' };
  const state = { at: 5_000_000, tasks: [], days: { t: 100, value: { calc3: { sig: 'old', rest: [] } } }, cal: [] };
  const sync = { site: { read: async () => ({ etag: null, state, entries: parseEntries(state) }), write: async () => true }, prefixes: ['calc3-'], calcSource: async () => parseCalcSource(PAGE) };

  async function setup(nowDate: Date) {
    const store = new MemoryTaskStore();
    const tool = async (name: string, args: any) => {
      const res = await handleRequest(
        new Request('https://x/mcp', { method: 'POST', headers: auth, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) }),
        env, store, nowDate, sync as any,
      );
      return JSON.parse(((await res.json()) as any).result.content[0].text);
    };
    await tool('set_commitments', { reviewed: true, commitments: [{ id: 'calc3-daily', title: 'Calc 3 every day', due: '2026-11-16', target_minutes: 900, daily: true }] });
    return tool;
  }

  it('asks for a Calc block on a lesson day, and not on a rest day the plan declares', async () => {
    const lessonDay = await setup(new Date(Date.UTC(2026, 9, 21, 19, 0))); // Wed Oct 21: lesson t8
    const missing = await lessonDay('set_daily_plan', { date: '2026-10-21', tasks: [{ title: 'Homework', minutes: 30 }] });
    expect(missing.framework_check.floor_blocks_missing.map((m: any) => m.id)).toEqual(['calc3-daily']);

    const restDay = await setup(new Date(Date.UTC(2026, 9, 23, 19, 0))); // Fri Oct 23: rest (calc3-t10)
    const quiet = await restDay('set_daily_plan', { date: '2026-10-23', tasks: [{ title: 'Homework', minutes: 30 }] });
    expect(quiet.framework_check?.floor_blocks_missing).toBeUndefined();
  });
});
