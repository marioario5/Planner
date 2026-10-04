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

function describe(c: Commitment, work: CommitmentWork[], today: string): FrameworkItem {
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
  const open = commitments.filter((c) => c.status === 'open').map((c) => describe(c, work, today));
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

/** Flagged commitments that nothing in the given plan works on. */
export function unaddressed(framework: Framework, scheduledIds: Set<string>): FrameworkItem[] {
  return framework.worth_a_look.filter((i) => !scheduledIds.has(i.id));
}

