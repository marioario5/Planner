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

/** How far ahead of UTC a time zone is at a given instant, in ms (negative for the Americas). */
function zoneOffsetMs(instantMs: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(instantMs));
  const get = (type: string) => Number(parts.find((p) => p.type === type)!.value);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return asUtc - Math.floor(instantMs / 1000) * 1000;
}

/**
 * The moment a wall-clock time falls on a planner day. Times before 04:00 belong to the
 * next calendar morning (00:30 on planner day Oct 1 is Oct 2, 00:30). DST-aware.
 */
export function plannerTimeToEpoch(plannerDate: string, hhmm: string, timeZone: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  const calendarDate = h < DAY_START_HOUR ? shiftDate(plannerDate, 1) : plannerDate;
  const [y, mo, d] = calendarDate.split('-').map(Number);
  const wall = Date.UTC(y, mo - 1, d, h, m);
  let epoch = wall - zoneOffsetMs(wall, timeZone);
  epoch = wall - zoneOffsetMs(epoch, timeZone); // settle across a DST change
  return epoch;
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
