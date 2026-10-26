import { describe, expect, it } from 'vitest';
import { dayTypeCheck, isCollegeDay } from '../src/daytype';
import { handleRequest } from '../src/index';
import { MemoryTaskStore } from './memory-store';

const t = (tag: string, minutes: number, title = tag) => ({ title, tag, minutes, commitmentId: null }) as any;

describe('the two kinds of day', () => {
  it('treats Saturday and Sunday as college days and the rest as normal', () => {
    expect(['2026-10-24', '2026-10-25'].map(isCollegeDay)).toEqual([true, true]);
    expect(['2026-10-26', '2026-10-27', '2026-10-30'].map(isCollegeDay)).toEqual([false, false, false]);
  });

  it('says nothing about a college day, however heavy', () => {
    expect(dayTypeCheck('2026-10-24', [t('college', 240), t('calculus3', 120)], 100)).toBeNull();
  });

  it('is quiet when a normal day is under the cap with no college work', () => {
    expect(dayTypeCheck('2026-10-27', [t('calculus3', 50), t('sat', 20), t('school', 40)], 150)).toBeNull();
  });

  it('names how much to cut over the cap, never counting Calc 3, SAT or assignments as cuttable', () => {
    const r = dayTypeCheck('2026-10-27', [t('calculus3', 60), t('sat', 20), t('pcb', 60), t('creative', 30)], 120) as any;
    expect(r.over_cap).toMatchObject({ planned_minutes: 170, cap_minutes: 120, over_by: 50, required_minutes: 80, cut_at_least: 50 });
    expect(r.over_cap.required_alone_exceeds_cap).toBeUndefined();
    const heavy = dayTypeCheck('2026-10-27', [t('calculus3', 90), t('school', 80), t('pcb', 30)], 120) as any;
    expect(heavy.over_cap).toMatchObject({ over_by: 80, cut_at_least: 30, required_alone_exceeds_cap: true });
  });

  it('flags college work on a normal day and marks one over the exception size', () => {
    const r = dayTypeCheck('2026-10-27', [t('calculus3', 50), t('college', 45, 'EA pass'), t('college', 15, 'Transcripts email')], 150) as any;
    expect(r.college_on_a_normal_day).toEqual([
      { title: 'EA pass', minutes: 45, commitment: null, too_long: true },
      { title: 'Transcripts email', minutes: 15, commitment: null },
    ]);
    expect(r.rule).toContain('too_long');
  });

  it('does not judge the cap when there is too little data to know it', () => {
    expect(dayTypeCheck('2026-10-27', [t('calculus3', 400)], null)).toBeNull();
  });
});

describe('set_daily_plan reports it', () => {
  const env = { API_TOKEN: 'a'.repeat(40), PLANNER_TZ: 'America/Los_Angeles' } as any;
  const auth = { Authorization: `Bearer ${env.API_TOKEN}`, 'Content-Type': 'application/json' };
  const now = new Date(Date.UTC(2026, 9, 26, 19, 0)); // Mon Oct 26, noon PDT

  const publish = async (date: string, tasks: any[]) => {
    const res = await handleRequest(
      new Request('https://x/mcp', { method: 'POST', headers: auth, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'set_daily_plan', arguments: { date, tasks } } }) }),
      env, new MemoryTaskStore(), now,
    );
    return JSON.parse(((await res.json()) as any).result.content[0].text);
  };

  it('flags college work on Monday but not on Saturday', async () => {
    const monday = await publish('2026-10-26', [{ title: 'Common App pass', tag: 'college', minutes: 45 }]);
    expect(monday.day_type_check.college_on_a_normal_day[0]).toMatchObject({ title: 'Common App pass', too_long: true });
    const saturday = await publish('2026-10-31', [{ title: 'Common App pass', tag: 'college', minutes: 45 }]);
    expect(saturday.day_type_check).toBeUndefined();
  });
});
