// His own checklist items. A task whose notes start with `[kept until YYYY-MM-DD]` is never removed when a plan is
// re-published, and it follows him from day to day until that date. Checked off, it is shown for the rest of the planner
// day it was checked on and then disappears (the planner day ends at 4am).

import { plannerToday, shiftDate } from './dates';
import type { Task, TaskStore } from './tasks';

const UNTIL = /^\[kept until (\d{4}-\d{2}-\d{2})\]/;

/** The last day a kept task is shown while unchecked, or null if it has no date (it then stays on its own day only). */
export function keptUntil(task: { notes: string | null }): string | null {
  return UNTIL.exec(task.notes ?? '')?.[1] ?? null;
}

const LOOKBACK_DAYS = 60;

/** Kept tasks from earlier days that belong on `date`: not past their last day, and either unchecked or checked on `date`. */
export async function carriedKept(store: TaskStore, date: string, timeZone: string): Promise<Task[]> {
  const earlier = await store.listRange(shiftDate(date, -LOOKBACK_DAYS), shiftDate(date, -1));
  return earlier.filter((t) => {
    const until = keptUntil(t);
    if (!until || until < date) return false;
    if (!t.done) return true;
    const at = t.completedAt ?? t.doneAt;
    return !!at && plannerToday(timeZone, new Date(at)) === date;
  });
}
