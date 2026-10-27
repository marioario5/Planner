// Standing orders: concrete, decided instructions the weekly review issues and the daily scheduler follows as fact.
//
// The weekly analyzer (the only writer) turns solid findings into orders; the daily run reads them and applies them without reasoning.
// Orders with a machine-checkable shape are checked on every set_daily_plan (`directive_check`), so the scheduler does not have to verify them itself.
// Stored as JSON in the server's key/value store (no migration), every version kept (the newest MAX_VERSIONS) so the analyzer can see its own past decisions.

import { isCollegeDay } from './daytype';
import { ValidationError, type Task, type TaskStore } from './tasks';

export const DIRECTIVES_KEY = 'directives';
export const DIRECTIVES_VERSIONS_KEY = 'directives_versions';
export const MAX_ORDERS = 15;
const MAX_VERSIONS = 60;
const TEXT_MAX = 240;
const TAGS = ['school', 'calculus3', 'sat', 'pcb', 'creative', 'college', 'other'];
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export type OrderCheck =
  | { kind: 'start_not_before'; time: string }
  | { kind: 'cap_minutes'; minutes: number }
  | { kind: 'no_block_window'; from: string; to: string }
  | { kind: 'min_gap_after_tag'; tag: string; minutes: number }
  | { kind: 'dinner_at'; time: string; tolerance_min: number };

export interface Order {
  id: string;
  text: string;
  applies: 'weekday' | 'weekend' | 'all';
  check: OrderCheck | null;
  evidence: string;
  review_by: string;
}

export interface DirectiveSet {
  version: number;
  updated_at: string | null;
  note: string | null;
  orders: Order[];
}

const toMin = (hhmm: string): number => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

function parseCheck(raw: unknown, id: string): OrderCheck | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'object') throw new ValidationError(`order "${id}": check must be an object`);
  const c = raw as Record<string, unknown>;
  const time = (v: unknown, what: string): string => {
    if (typeof v !== 'string' || !HHMM.test(v)) throw new ValidationError(`order "${id}": ${what} must be a 24-hour HH:MM time`);
    return v;
  };
  const minutes = (v: unknown, what: string): number => {
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > 1440) throw new ValidationError(`order "${id}": ${what} must be a whole number of minutes from 1 to 1440`);
    return v;
  };
  switch (c.kind) {
    case 'start_not_before':
      return { kind: 'start_not_before', time: time(c.time, 'time') };
    case 'cap_minutes':
      return { kind: 'cap_minutes', minutes: minutes(c.minutes, 'minutes') };
    case 'no_block_window': {
      const from = time(c.from, 'from');
      const to = time(c.to, 'to');
      if (toMin(to) <= toMin(from)) throw new ValidationError(`order "${id}": the window must end after it starts`);
      return { kind: 'no_block_window', from, to };
    }
    case 'min_gap_after_tag': {
      if (typeof c.tag !== 'string' || !TAGS.includes(c.tag)) throw new ValidationError(`order "${id}": tag must be one of ${TAGS.join(', ')}`);
      return { kind: 'min_gap_after_tag', tag: c.tag, minutes: minutes(c.minutes, 'minutes') };
    }
    case 'dinner_at':
      return { kind: 'dinner_at', time: time(c.time, 'time'), tolerance_min: c.tolerance_min === undefined ? 15 : minutes(c.tolerance_min, 'tolerance_min') };
    default:
      throw new ValidationError(`order "${id}": check.kind must be one of start_not_before, cap_minutes, no_block_window, min_gap_after_tag, dinner_at (or leave check out for advice with no automatic check)`);
  }
}

export function parseOrders(raw: unknown): Order[] {
  if (!Array.isArray(raw)) throw new ValidationError('orders must be an array');
  if (raw.length > MAX_ORDERS) throw new ValidationError(`at most ${MAX_ORDERS} standing orders (this has ${raw.length}): keep only the ones that earn their place`);
  const seen = new Set<string>();
  return raw.map((r): Order => {
    if (typeof r !== 'object' || r === null) throw new ValidationError('each order must be an object');
    const o = r as Record<string, unknown>;
    const id = typeof o.id === 'string' ? o.id : '';
    if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(id)) throw new ValidationError('each order needs an id: a short slug (lowercase letters, digits, dashes)');
    if (seen.has(id)) throw new ValidationError(`order id "${id}" appears twice`);
    seen.add(id);
    const text = typeof o.text === 'string' ? o.text.trim() : '';
    if (!text || text.length > TEXT_MAX) throw new ValidationError(`order "${id}": text is required and at most ${TEXT_MAX} characters`);
    const applies = o.applies === undefined ? 'all' : o.applies;
    if (applies !== 'weekday' && applies !== 'weekend' && applies !== 'all') throw new ValidationError(`order "${id}": applies must be weekday, weekend or all`);
    const evidence = typeof o.evidence === 'string' ? o.evidence.trim() : '';
    if (!evidence || evidence.length > TEXT_MAX) throw new ValidationError(`order "${id}": evidence is required (one line with the n) and at most ${TEXT_MAX} characters`);
    const review_by = typeof o.review_by === 'string' ? o.review_by : '';
    if (!DATE.test(review_by)) throw new ValidationError(`order "${id}": review_by must be a date (YYYY-MM-DD), so no order lives forever without a look`);
    return { id, text, applies, check: parseCheck(o.check, id), evidence, review_by };
  });
}

const empty = (): DirectiveSet => ({ version: 0, updated_at: null, note: null, orders: [] });

export async function loadDirectives(store: TaskStore): Promise<DirectiveSet> {
  try {
    const raw = await store.getMeta(DIRECTIVES_KEY);
    if (!raw) return empty();
    const v = JSON.parse(raw) as DirectiveSet;
    return typeof v?.version === 'number' && Array.isArray(v.orders) ? { version: v.version, updated_at: v.updated_at ?? null, note: v.note ?? null, orders: v.orders } : empty();
  } catch {
    return empty();
  }
}

export async function loadDirectiveHistory(store: TaskStore): Promise<DirectiveSet[]> {
  try {
    const raw = await store.getMeta(DIRECTIVES_VERSIONS_KEY);
    const list = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(list) ? (list as DirectiveSet[]) : [];
  } catch {
    return [];
  }
}

/** Replaces the whole set of orders (the analyzer passes everything it wants kept) and records it as a new version. */
export async function saveDirectives(store: TaskStore, orders: Order[], note: string | null, nowIso: string): Promise<DirectiveSet> {
  const current = await loadDirectives(store);
  const next: DirectiveSet = { version: current.version + 1, updated_at: nowIso, note, orders };
  const history = [...(await loadDirectiveHistory(store)), next].slice(-MAX_VERSIONS);
  await store.setMeta(DIRECTIVES_KEY, JSON.stringify(next));
  await store.setMeta(DIRECTIVES_VERSIONS_KEY, JSON.stringify(history));
  return next;
}

export const orderApplies = (o: Order, date: string): boolean => o.applies === 'all' || (o.applies === 'weekend') === isCollegeDay(date);

/** The cap in minutes the orders set for that date, if any (the smallest wins). */
export function capFromOrders(orders: Order[], date: string): number | null {
  const caps = orders.filter((o) => orderApplies(o, date) && o.check?.kind === 'cap_minutes').map((o) => (o.check as { minutes: number }).minutes);
  return caps.length ? Math.min(...caps) : null;
}

const isWork = (t: Task) => t.tag !== 'other';
/** Never cut for the cap: Calc 3, SAT and listed assignments (school). */
const REQUIRED_TAGS = new Set(['calculus3', 'sat', 'school']);

/** Checks one plan against the orders that apply to its date and have an automatic check. Reported, never enforced. */
export function checkDirectives(date: string, planTasks: Task[], orders: Order[]): { checked: number; broken: { id: string; text: string; why: string }[]; notes: string[] } {
  const broken: { id: string; text: string; why: string }[] = [];
  const notes: string[] = [];
  let checked = 0;
  const timed = planTasks.filter((t) => t.start).sort((a, b) => toMin(a.start!) - toMin(b.start!));
  for (const o of orders) {
    if (!orderApplies(o, date) || !o.check) continue;
    checked++;
    const c = o.check;
    const fail = (why: string) => broken.push({ id: o.id, text: o.text, why });
    switch (c.kind) {
      case 'start_not_before': {
        const early = timed.filter((t) => isWork(t) && toMin(t.start!) < toMin(c.time));
        if (early.length) fail(`${early.map((t) => `"${t.title}" starts ${t.start}`).join(', ')}; no work block before ${c.time}`);
        break;
      }
      case 'cap_minutes': {
        // Calc 3, SAT and listed assignments are never cut for the cap, so only the rest can be a broken order; when required work alone is over, it is a note.
        const work = planTasks.filter(isWork);
        const total = work.reduce((n, t) => n + (t.minutes ?? 0), 0);
        const required = work.filter((t) => REQUIRED_TAGS.has(t.tag)).reduce((n, t) => n + (t.minutes ?? 0), 0);
        const over = total - c.minutes;
        if (over > 0 && total - required > 0 && over > Math.max(0, required - c.minutes)) {
          const cut = Math.min(over, total - required);
          fail(`${total} work minutes planned, the cap is ${c.minutes} (over by ${over}); cut at least ${cut} of the work that is not Calc 3, SAT or a listed assignment`);
        } else if (over > 0) {
          notes.push(`${o.id}: Calc 3, SAT and listed assignments alone are ${required} minutes against the cap of ${c.minutes}; keep them and say "Over cap by ${over} min because X" in Warnings`);
        }
        break;
      }
      case 'no_block_window': {
        const inside = timed.filter((t) => toMin(t.start!) >= toMin(c.from) && toMin(t.start!) < toMin(c.to));
        if (inside.length) fail(`${inside.map((t) => `"${t.title}" starts ${t.start}`).join(', ')}; nothing may start from ${c.from} to ${c.to}`);
        break;
      }
      case 'min_gap_after_tag': {
        for (let i = 0; i < timed.length; i++) {
          const t = timed[i];
          const next = timed[i + 1];
          if (t.tag !== c.tag || !next || t.minutes === null) continue;
          const gap = toMin(next.start!) - (toMin(t.start!) + t.minutes);
          if (gap < c.minutes) fail(`after "${t.title}" the next block ("${next.title}") starts ${gap} minutes later; the break must be at least ${c.minutes}`);
        }
        break;
      }
      case 'dinner_at': {
        const dinner = timed.find((t) => /dinner/i.test(t.title));
        if (!dinner) fail('there is no Dinner block');
        else if (Math.abs(toMin(dinner.start!) - toMin(c.time)) > c.tolerance_min) fail(`Dinner starts ${dinner.start}; it must be within ${c.tolerance_min} minutes of ${c.time}`);
        break;
      }
    }
  }
  return { checked, broken, notes };
}
