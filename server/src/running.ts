// The task he is working on right now, in one small read-only answer (for a wall display that only needs to show it).
// No notes and nothing personal: just what the task is, how long it is meant to take, and how long it has really run.

import { plannerToday } from './dates';
import type { TaskStore } from './tasks';

export async function runningTask(store: TaskStore, timeZone: string, now?: Date) {
  const nowDate = now ?? new Date();
  const today = plannerToday(timeZone, nowDate);
  const tasks = await store.list(today);
  const base = { now: nowDate.toISOString(), planner_date: today };

  // Running = Start pressed and not finished. If there are several, the one started last.
  const running = tasks
    .filter((t) => t.startedAt && !t.done)
    .sort((a, b) => b.startedAt!.localeCompare(a.startedAt!))[0];
  if (!running) return { ...base, running: null };

  const startedMs = Date.parse(running.startedAt!);
  const openPauseMs = running.pausedAt ? Math.max(0, nowDate.getTime() - Date.parse(running.pausedAt)) : 0;
  const elapsedMs = Math.max(0, nowDate.getTime() - startedMs - running.pausedMs - openPauseMs);
  const plan = tasks.filter((t) => t.plan === running.plan);
  return {
    ...base,
    running: {
      id: running.id,
      title: running.title,
      tag: running.tag,
      planned_min: running.minutes,
      started_at: running.startedAt,
      /** Currently paused: the clock is not running. */
      paused: running.pausedAt !== null,
      paused_at: running.pausedAt,
      /** Time already spent paused, not counting a pause that is open right now. */
      paused_sec: Math.round(running.pausedMs / 1000),
      /** Worked time so far at `now`: since Start, minus every pause (an open pause counts up to now). */
      elapsed_sec: Math.round(elapsedMs / 1000),
    },
    day: { plan: running.plan, done: plan.filter((t) => t.done).length, total: plan.length },
  };
}
