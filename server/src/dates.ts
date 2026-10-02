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

/** Validates an optional `date` input; falls back to today in the planner time zone. */
export function resolveDate(value: unknown, timeZone: string, now?: Date): string {
  if (value === undefined || value === null || value === '') {
    return todayIn(timeZone, now);
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
