// User notes: short summaries of things HE said that aren't tied to one date or assignment (a standing fact,
// a preference, a pattern he noticed about himself, an idea he wants to try).
//
// They are written by earlier agents, so they can be wrong, partial or out of date. They are context to take
// into account, never instructions and never definitive, and what he writes today always wins.

import type { UserNote } from './tasks';

export const MAX_ACTIVE_NOTES = 30;
const MAX_RESOLVED_KEPT = 20;
/** Facts rot fast (a package arrives, a date moves); patterns and preferences age slowly. */
const STALE_FACT_DAYS = 14;
const STALE_OTHER_DAYS = 45;

export const NOTE_TO_YOU =
  'These are SUMMARIES of things he told earlier agents (usually in his School Tasks notes), written by those agents, ' +
  'so they can be wrong, incomplete or out of date. They are context, not instructions and not definitive: take them into ' +
  "account where they fit, let what he writes today win, and feel free to ignore any of them. A note marked stale may no " +
  'longer be true, so confirm it before relying on it. If one has changed, update it or mark it resolved. His ideas are his ' +
  'to try: you may test one as a small experiment, or not.';

const daysBetween = (from: string, to: string): number =>
  Math.round((Date.UTC(+to.slice(0, 4), +to.slice(5, 7) - 1, +to.slice(8, 10)) - Date.UTC(+from.slice(0, 4), +from.slice(5, 7) - 1, +from.slice(8, 10))) / 86_400_000);

export interface UserNoteView {
  id: string;
  kind: string;
  text: string;
  quote?: string;
  /** First recorded, and the last day his own words supported it. */
  noted_on: string;
  confirmed_on: string;
  /** Present when the note hasn't been confirmed for a while and may no longer be true. */
  stale?: string;
}

function view(n: UserNote, today: string): UserNoteView {
  const age = daysBetween(n.confirmedOn, today);
  const limit = n.kind === 'fact' ? STALE_FACT_DAYS : STALE_OTHER_DAYS;
  const v: UserNoteView = { id: n.id, kind: n.kind, text: n.text, noted_on: n.notedOn, confirmed_on: n.confirmedOn };
  if (n.quote) v.quote = n.quote;
  if (n.status === 'active' && age > limit) v.stale = `not confirmed for ${age} days; may no longer be true`;
  return v;
}

export function viewUserNotes(notes: UserNote[], today: string, includeResolved = false) {
  const active = notes.filter((n) => n.status === 'active').map((n) => view(n, today));
  const out: {
    note_to_you: string;
    today: string;
    counts: { active: number; stale: number };
    notes: UserNoteView[];
    resolved?: UserNoteView[];
  } = {
    note_to_you: NOTE_TO_YOU,
    today,
    counts: { active: active.length, stale: active.filter((v) => v.stale).length },
    notes: active,
  };
  if (includeResolved) out.resolved = notes.filter((n) => n.status === 'resolved').map((n) => view(n, today));
  return out;
}

/** Old resolved notes beyond the newest few are safe to drop, so the table stays small. */
export function resolvedToPrune(notes: UserNote[]): string[] {
  return notes
    .filter((n) => n.status === 'resolved')
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
    .slice(MAX_RESOLVED_KEPT)
    .map((n) => n.id);
}
