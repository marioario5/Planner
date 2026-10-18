// The month-ahead framework: a short list of SUGGESTIONS from earlier planning runs about what must not be
// forgotten, with the server noticing (in plain words) when one seems to be slipping.
//
// Principles, kept deliberately light:
//  - It says WHAT, never WHEN. Each day's planner decides placement.
//  - Everything here is a forecast made with less information than today's planner has. The planner is free
//    to follow, resize, split, defer or drop any of it, and to disagree with the whole framework.
//  - The only ask: nothing flagged disappears by accident. It's in today's plan, or it was left out on purpose.
//  - Signals are observations, never verdicts.

import type { Commitment, CommitmentWork, FrameworkLogEntry } from './tasks';

export const MAX_OPEN_COMMITMENTS = 25;
export const MAX_DEFER_DAYS = 14;
const HORIZON_DAYS = 35;
const MAX_DAILY_MIN = 60; // more than this per day just to finish = "at risk"
const BEHIND_MIN = 45;
const NOT_STARTED_GRACE_DAYS = 3;
const STALL_DAYS = 7;
const STALL_WINDOW_DAYS = 21;
const DUE_SOON_DAYS = 7;
const REVIEW_EVERY_DAYS = 7;
const RECENT_CHOICES = 10;

export const NOTE_TO_YOU =
  'These are SUGGESTIONS from earlier planning runs about how they thought the coming month might play out, ' +
  'made with less information than you have today. You are free to follow, resize, split, defer or drop any of them, ' +
  'and to disagree with the whole framework (then change it with set_commitments so the next planner inherits your view). ' +
  "The only ask: don't let a flagged item vanish by accident. Either it's in today's plan, or you left it out on purpose " +
  '(defer_commitment with a one-line reason, or drop/resize it). Signals are observations, not verdicts.';

const daysBetween = (from: string, to: string): number =>
  Math.round((Date.UTC(+to.slice(0, 4), +to.slice(5, 7) - 1, +to.slice(8, 10)) - Date.UTC(+from.slice(0, 4), +from.slice(5, 7) - 1, +from.slice(8, 10))) / 86_400_000);

export interface FrameworkItem {
  id: string;
  title: string;
  due: string | null;
  days_left: number | null;
  target_minutes: number | null;
  done_minutes: number;
  remaining_minutes: number | null;
  last_worked: string | null;
  /** The planner day an earlier run proposed it, so you can see how old the thinking is. */
  proposed_on: string;
  /** The proposing agent's reasoning and assumptions. */
  note: string | null;
  /** Plain-language observations about why it might be slipping; empty if nothing stands out. */
  signals: string[];
  deferred_until?: string;
  deferred_reason?: string;
}

export interface Framework {
  note_to_you: string;
  today: string;
  reviewed_on: string | null;
  review_due: boolean;
  review_hint?: string;
  counts: { open: number; worth_a_look: number; deferred: number; due_within_7_days: number };
  /** Open, not set aside, with at least one signal. These are the ones not to lose by accident. */
  worth_a_look: FrameworkItem[];
  /** Due within a week with no signals: just keeping them in view. */
  due_soon: FrameworkItem[];
  /** Consciously set aside by an earlier run, with the reason. */
  deferred: FrameworkItem[];
  /** The last few choices earlier runs made, newest first. */
  recent_choices: { on: string; commitment: string | null; action: string; detail: string }[];
  all_open?: FrameworkItem[];
}

export function describeItem(c: Commitment, work: CommitmentWork[], today: string): FrameworkItem {
  const mine = work.filter((w) => w.commitmentId === c.id && w.done);
  const done = mine.reduce((sum, w) => sum + (w.minutes ?? 0), 0);
  const lastWorked = mine.length ? mine.map((w) => w.date).sort().at(-1)! : null;
  const target = c.targetMinutes;
  const remaining = target === null ? null : Math.max(0, target - done);
  const daysLeft = c.due ? daysBetween(today, c.due) : null;
  const unfinished = remaining === null || remaining > 0;

  const signals: string[] = [];
  if (c.due && daysLeft !== null && unfinished) {
    if (daysLeft < 0) {
      signals.push(`was due ${c.due} (${-daysLeft} day${daysLeft === -1 ? '' : 's'} ago) and isn't marked done`);
    } else {
      if (remaining !== null && remaining > 0 && remaining > Math.max(daysLeft, 1) * MAX_DAILY_MIN) {
        signals.push(`${remaining} min left and ${daysLeft} day${daysLeft === 1 ? '' : 's'} to go: finishing would take over ${MAX_DAILY_MIN} min a day`);
      }
      const start = c.start ?? c.createdOn;
      const span = daysBetween(start, c.due);
      if (target !== null && span > 0) {
        const elapsed = Math.min(Math.max(daysBetween(start, today), 0), span);
        const expected = Math.round((target * elapsed) / span);
        if (expected - done >= BEHIND_MIN && done < 0.6 * expected) {
          signals.push(`on a steady pace about ${expected} min would be done by now; ${done} logged`);
        }
      }
      if (done === 0 && daysLeft <= HORIZON_DAYS && daysBetween(c.createdOn, today) >= NOT_STARTED_GRACE_DAYS) {
        signals.push(`no work logged yet and it is due in ${daysLeft} day${daysLeft === 1 ? '' : 's'}`);
      } else if (lastWorked && done > 0 && daysLeft <= STALL_WINDOW_DAYS && daysBetween(lastWorked, today) >= STALL_DAYS) {
        signals.push(`last worked ${daysBetween(lastWorked, today)} days ago and it is due in ${daysLeft} day${daysLeft === 1 ? '' : 's'}`);
      }
    }
  }

  const item: FrameworkItem = {
    id: c.id,
    title: c.title,
    due: c.due,
    days_left: daysLeft,
    target_minutes: target,
    done_minutes: done,
    remaining_minutes: remaining,
    last_worked: lastWorked,
    proposed_on: c.createdOn,
    note: c.note,
    signals,
  };
  if (c.deferUntil && today < c.deferUntil) {
    item.deferred_until = c.deferUntil;
    if (c.deferReason) item.deferred_reason = c.deferReason;
  }
  return item;
}

export function computeFramework(
  commitments: Commitment[],
  work: CommitmentWork[],
  log: FrameworkLogEntry[],
  reviewedOn: string | null,
  today: string,
  includeAll = false,
): Framework {
  const open = commitments.filter((c) => c.status === 'open').map((c) => describeItem(c, work, today));
  const deferred = open.filter((i) => i.deferred_until);
  const active = open.filter((i) => !i.deferred_until);
  const worthALook = active.filter((i) => i.signals.length > 0);
  const dueSoon = active.filter(
    (i) => i.signals.length === 0 && i.days_left !== null && i.days_left >= 0 && i.days_left <= DUE_SOON_DAYS,
  );

  const reviewDue = reviewedOn === null || daysBetween(reviewedOn, today) >= REVIEW_EVERY_DAYS;
  const framework: Framework = {
    note_to_you: NOTE_TO_YOU,
    today,
    reviewed_on: reviewedOn,
    review_due: reviewDue,
    counts: {
      open: open.length,
      worth_a_look: worthALook.length,
      deferred: deferred.length,
      due_within_7_days: open.filter((i) => i.days_left !== null && i.days_left >= 0 && i.days_left <= DUE_SOON_DAYS).length,
    },
    worth_a_look: worthALook,
    due_soon: dueSoon,
    deferred,
    recent_choices: log.slice(0, RECENT_CHOICES).map((l) => ({ on: l.onDate, commitment: l.commitmentId, action: l.action, detail: l.detail })),
  };
  if (reviewDue) {
    framework.review_hint =
      (reviewedOn === null ? 'No review has been done yet. ' : `Last reviewed ${reviewedOn}. `) +
      `A light review is due (your call how much): add anything that matters in the next ~${HORIZON_DAYS} days that is missing ` +
      '(for example the deadline ledger and application pieces), close what is finished, adjust sizes, then call set_commitments with reviewed: true. ' +
      `Keep at most ${MAX_OPEN_COMMITMENTS} open items and keep each one rough; a precise plan is not the point.`;
  }
  if (includeAll) framework.all_open = open;
  return framework;
}

// ---- Deferrals are hard to do and impossible to miss ----
// A deferral used to be free, silent and repeatable, so an item could slide day after day with nobody noticing. Now:
//  - protected items (the ones he named: PIQs, SAT...) can't be deferred by the planner at all, only shrunk to a small floor block;
//  - an item due within a week with nothing done, an overdue one, or a deferral past the due date needs his own words;
//  - the second deferral needs a new reason, the third needs his words;
//  - every item that is slipping is listed at the top of the day (the Slipping section) and in get_framework.

/** Where the protected ids live (framework_meta), as a JSON list. */
export const PROTECTED_KEY = 'protected_commitments';
/** Daily items (Calc 3): never deferred, not even with his words, and a block in every single plan. They are protected too. */
export const DAILY_KEY = 'daily_commitments';
export const AT_RISK_DAYS = 7;
export const MIN_SECOND_REASON = 30;

export function parseProtected(raw: string | null): Set<string> {
  if (!raw) return new Set();
  try {
    const list = JSON.parse(raw);
    return new Set(Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string') : []);
  } catch {
    return new Set();
  }
}

export interface DeferHistory {
  n: number;
  lastReason: string | null;
}

/** How many times each commitment has been deferred (from the newest log entries) and the latest reason. `log` is newest first. */
export function deferHistory(log: FrameworkLogEntry[]): Map<string, DeferHistory> {
  const out = new Map<string, DeferHistory>();
  for (const e of log) {
    if (e.action !== 'defer' || !e.commitmentId) continue;
    const cur = out.get(e.commitmentId) ?? { n: 0, lastReason: null };
    if (cur.n === 0) cur.lastReason = e.detail.replace(/^until \d{4}-\d{2}-\d{2}: /, '').replace(/ \(his words: .*\)$/, '');
    cur.n += 1;
    out.set(e.commitmentId, cur);
  }
  return out;
}

const FLOOR_HINT =
  'Give it a small floor block (15 to 25 minutes) in today\'s plan instead, or shrink or re-date it with set_commitments, or ask him. ' +
  'Only if he told you to defer it, call defer_commitment again with his_words set to what he said.';

/** Why a deferral must not go through, or null if it may. `hisWords` = a quote of him asking for it. */
export function deferRefusal(p: {
  c: Commitment;
  item: FrameworkItem;
  isProtected: boolean;
  isDaily?: boolean;
  history: DeferHistory;
  until: string;
  reason: string;
  hisWords: string | null;
}): string | null {
  if (p.isDaily) return `"${p.c.id}" is a daily item: it is never deferred, not even on his word, and every plan must hold a block for it. ${FLOOR_HINT.split(' Only if')[0]}`;
  if (p.hisWords) return null;
  const { c, item, history } = p;
  if (p.isProtected) return `"${c.id}" is protected: the planner may not defer it. ${FLOOR_HINT}`;
  if (item.days_left !== null && item.days_left < 0) return `"${c.id}" is overdue (it was due ${c.due}): deferring doesn't help. Finish it, re-date it with set_commitments, or drop it. ${FLOOR_HINT}`;
  if (c.due && p.until > c.due) return `deferring "${c.id}" until ${p.until} would put it past its due date (${c.due}). ${FLOOR_HINT}`;
  const unfinished = item.remaining_minutes === null || item.remaining_minutes > 0;
  if (item.days_left !== null && item.days_left <= AT_RISK_DAYS && unfinished && item.done_minutes === 0) {
    return `"${c.id}" is due in ${item.days_left} day${item.days_left === 1 ? '' : 's'} with nothing done: it can't be deferred. ${FLOOR_HINT}`;
  }
  if (history.n >= 2) return `"${c.id}" has already been deferred ${history.n} times; a third deferral needs his words. ${FLOOR_HINT}`;
  if (history.n === 1 && (p.reason.length < MIN_SECOND_REASON || p.reason === history.lastReason)) {
    return `"${c.id}" was deferred before ("${history.lastReason ?? ''}"). A second deferral needs a new reason of at least ${MIN_SECOND_REASON} characters that says what changed.`;
  }
  return null;
}

export interface SlipItem {
  id: string;
  title: string;
  due: string | null;
  days_left: number | null;
  done_minutes: number;
  target_minutes: number | null;
  times_deferred: number;
  protected: boolean;
  /** A daily item (Calc 3): a block in every plan, no deferral at all. */
  daily: boolean;
  deferred_until: string | null;
  in_todays_plan: boolean;
  /** Protected and still at risk: today's plan must hold a small block for it. */
  floor_needed: boolean;
}

/** Everything that is slipping: deferred at least once, overdue, due within a week with nothing done, or protected and behind. */
export function computeSlipping(
  commitments: Commitment[],
  work: CommitmentWork[],
  log: FrameworkLogEntry[],
  protectedIds: Set<string>,
  today: string,
  plannedIds: Set<string>,
  dailyIds: Set<string> = new Set(),
): SlipItem[] {
  const history = deferHistory(log);
  const out: SlipItem[] = [];
  for (const c of commitments) {
    if (c.status !== 'open') continue;
    const item = describeItem(c, work, today);
    const n = history.get(c.id)?.n ?? 0;
    const isProtected = protectedIds.has(c.id);
    const unfinished = item.remaining_minutes === null || item.remaining_minutes > 0;
    const overdue = item.days_left !== null && item.days_left < 0 && unfinished;
    const atRisk = item.days_left !== null && item.days_left >= 0 && item.days_left <= AT_RISK_DAYS && unfinished && item.done_minutes === 0;
    const isDaily = dailyIds.has(c.id);
    const floorNeeded = isDaily || (isProtected && unfinished && ((item.days_left !== null && item.days_left <= AT_RISK_DAYS) || item.signals.length > 0));
    if (!(n >= 1 || overdue || atRisk || floorNeeded) || (isDaily && plannedIds.has(c.id) && n === 0 && !overdue)) continue;
    out.push({
      id: c.id,
      title: c.title,
      due: c.due,
      days_left: item.days_left,
      done_minutes: item.done_minutes,
      target_minutes: item.target_minutes,
      times_deferred: n,
      protected: isProtected || isDaily,
      daily: isDaily,
      deferred_until: item.deferred_until ?? null,
      in_todays_plan: plannedIds.has(c.id),
      floor_needed: floorNeeded,
    });
  }
  return out.sort((a, b) => Number(b.floor_needed) - Number(a.floor_needed) || (a.days_left ?? 999) - (b.days_left ?? 999));
}

/** One plain line per slipping item, for the top of the day. */
export function slippingLines(items: SlipItem[]): string[] {
  return items.map((i) => {
    const when = i.days_left === null ? 'no due date' : i.days_left < 0 ? `overdue by ${-i.days_left} day${i.days_left === -1 ? '' : 's'}` : i.days_left === 0 ? 'due today' : `due in ${i.days_left} day${i.days_left === 1 ? '' : 's'}`;
    const size = i.target_minutes === null ? `${i.done_minutes} min done` : `${i.done_minutes} of ${i.target_minutes} min done`;
    const bits = [when, size];
    if (i.times_deferred > 0) bits.push(`deferred ${i.times_deferred} time${i.times_deferred === 1 ? '' : 's'}`);
    if (i.deferred_until) bits.push(`set aside until ${i.deferred_until}`);
    if (i.daily) bits.push('DAILY, never deferred');
    else if (i.protected) bits.push('protected');
    if (!i.in_todays_plan) bits.push("NOT in today's plan");
    return `- ${i.title}: ${bits.join(', ')}`;
  });
}

/** Flagged commitments that nothing in the given plan works on. */
export function unaddressed(framework: Framework, scheduledIds: Set<string>): FrameworkItem[] {
  return framework.worth_a_look.filter((i) => !scheduledIds.has(i.id));
}

