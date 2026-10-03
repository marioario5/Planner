import { ValidationError } from './tasks';

/** Today's date (YYYY-MM-DD) in the given IANA time zone, DST-aware. */
export function todayIn(timeZone: string, now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

/**
 * The planner's day starts at 04:00, not midnight, because he works past midnight:
 * a task ticked at 00:30 still belongs to the day that's ending. The app uses the same hour.
 */
export const DAY_START_HOUR = 4;

/** The planner day (YYYY-MM-DD) that `now` falls in, in the given IANA time zone. */
export function plannerToday(timeZone: string, now: Date = new Date()): string {
  return todayIn(timeZone, new Date(now.getTime() - DAY_START_HOUR * 3_600_000));
}

/** The date `days` days after (or before, if negative) a YYYY-MM-DD date. */
export function shiftDate(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** "HH:MM" (24-hour) of an ISO timestamp in the given IANA time zone. */
export function localTime(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(new Date(iso));
}

/** Validates an optional `date` input; falls back to the current planner day (rolls over at 04:00). */
export function resolveDate(value: unknown, timeZone: string, now?: Date): string {
  if (value === undefined || value === null || value === '') {
    return plannerToday(timeZone, now);
  }
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new ValidationError('date must look like YYYY-MM-DD');
  }
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new ValidationError(`${value} is not a real calendar date`);
  }
  return value;
}
