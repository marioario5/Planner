// What he does BETWEEN blocks: how long he rests before and after each subject, which subject tends to follow which, and how
// often the day's order changes. This is the holistic view the per-subject lateness figures cannot give ("he always takes a big
// break before Calc 3", "after PCB he goes straight into the next block").
//
// The gap is the time from finishing one work block to pressing Start on the next, in the order he really did them. A meal or
// errand in between counts as part of the gap (that is what a break is). Only blocks with a trustworthy tick and a Start press on
// the next block are used; flagged, backfilled and batch-ticked blocks are left out like everywhere else.

import { completedMinutes, dayTiming, isBackfilled, isFlagged, startedMinutes } from './timing';
import type { Task } from './tasks';

const MIN_SAMPLES = 3;
const MAX_GAP_MIN = 600; // a longer gap is another part of the day, not a break between two blocks

export interface TransitionDay {
  date: string;
  tasks: Task[];
  bulkIds: Set<string>;
}

export interface GapStat {
  n: number;
  median_gap_min: number;
  avg_gap_min: number;
}

export interface Transitions {
  note: string;
  overall: GapStat | null;
  /** The gap BEFORE a subject: how long he rests before starting it. */
  before_tag: Record<string, GapStat>;
  /** The gap AFTER a subject: how long he rests once it is done. */
  after_tag: Record<string, GapStat>;
  /** Which subject follows which (previous -> next), most common first. */
  pairs: { from: string; to: string; n: number; median_gap_min: number }[];
  /** The subject he did first and last on each day (counts of days). */
  first_of_day: Record<string, number>;
  last_of_day: Record<string, number>;
  /** Days he did blocks in a different order than planned, out of the days with two or more finished blocks. */
  reordered_days: { days: number; of: number };
  /** The latest transitions with titles, newest first, so the pattern can be read at the level of the actual work (topic, difficulty). */
  recent: { date: string; from: string; to: string; gap_min: number }[];
  /** Subjects with too few samples to summarise. */
  too_few: string[];
}

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
};
const stat = (xs: number[]): GapStat => ({
  n: xs.length,
  median_gap_min: median(xs),
  avg_gap_min: Math.round(xs.reduce((a, b) => a + b, 0) / xs.length),
});

function group(map: Map<string, number[]>, key: string, gap: number): void {
  map.set(key, [...(map.get(key) ?? []), gap]);
}

/** Null when there are no usable transitions yet. */
export function computeTransitions(days: TransitionDay[], timeZone: string): Transitions | null {
  const all: number[] = [];
  const before = new Map<string, number[]>();
  const after = new Map<string, number[]>();
  const pairs = new Map<string, number[]>();
  const first: Record<string, number> = {};
  const last: Record<string, number> = {};
  const recent: Transitions['recent'] = [];
  let reorderedDays = 0;
  let daysWithTwo = 0;

  for (const day of days) {
    const trusted = day.tasks
      .filter((t) => t.tag !== 'other' && t.done && t.completedAt && !isFlagged(t) && !isBackfilled(t, timeZone) && !day.bulkIds.has(t.id))
      .sort((a, b) => Date.parse(a.completedAt!) - Date.parse(b.completedAt!));
    if (trusted.length >= 2) {
      daysWithTwo++;
      if ((dayTiming(day.tasks, timeZone)?.out_of_order.length ?? 0) > 0) reorderedDays++;
    }
    if (trusted.length >= 1) {
      first[trusted[0].tag] = (first[trusted[0].tag] ?? 0) + 1;
      const end = trusted[trusted.length - 1].tag;
      last[end] = (last[end] ?? 0) + 1;
    }
    for (let i = 1; i < trusted.length; i++) {
      const prev = trusted[i - 1];
      const next = trusted[i];
      const finished = completedMinutes(prev, timeZone);
      const began = startedMinutes(next, timeZone);
      if (finished === null || began === null) continue;
      const gap = began - finished;
      if (gap < 0 || gap > MAX_GAP_MIN) continue;
      all.push(gap);
      group(before, next.tag, gap);
      group(after, prev.tag, gap);
      group(pairs, `${prev.tag}>${next.tag}`, gap);
      recent.push({ date: day.date, from: prev.title, to: next.title, gap_min: gap });
    }
  }
  if (all.length === 0) return null;

  const tooFew = new Set<string>();
  const summarise = (m: Map<string, number[]>): Record<string, GapStat> => {
    const out: Record<string, GapStat> = {};
    for (const [tag, gaps] of [...m.entries()].sort()) {
      if (gaps.length >= MIN_SAMPLES) out[tag] = stat(gaps);
      else tooFew.add(tag);
    }
    return out;
  };

  return {
    note:
      'Minutes between finishing one work block and pressing Start on the next, in the order he really did them (a meal in between counts). ' +
      'before_tag = the rest before a subject; after_tag = the rest after it. Read them with the titles in `recent`, not as a rule for the whole subject.',
    overall: all.length >= MIN_SAMPLES ? stat(all) : null,
    before_tag: summarise(before),
    after_tag: summarise(after),
    pairs: [...pairs.entries()]
      .filter(([, gaps]) => gaps.length >= 2)
      .map(([key, gaps]) => ({ from: key.split('>')[0], to: key.split('>')[1], n: gaps.length, median_gap_min: median(gaps) }))
      .sort((a, b) => b.n - a.n || a.from.localeCompare(b.from))
      .slice(0, 10),
    first_of_day: first,
    last_of_day: last,
    reordered_days: { days: reorderedDays, of: daysWithTwo },
    recent: recent.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0)).slice(0, 20),
    too_few: [...tooFew].sort(),
  };
}
