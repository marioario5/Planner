import type { Task } from './tasks';

/** Saturday and Sunday are the college days: heavy is fine there. Every other day is a normal day with a cap. */
export function isCollegeDay(date: string): boolean {
  const dow = new Date(`${date}T00:00:00Z`).getUTCDay();
  return dow === 0 || dow === 6;
}

/** Calc 3, SAT and listed assignments are never cut for the cap; everything else gives way first. */
const REQUIRED_TAGS = new Set(['calculus3', 'sat', 'school']);
/** A college block this short on a normal day counts as the allowed exception for a deadline a college day cannot reach. */
const EXCEPTION_MAX_MINUTES = 20;

const isWork = (t: Task) => t.tag !== 'other';
const minutesOf = (t: Task) => t.minutes ?? 0;

/**
 * Checks one plan against the two kinds of day (see the planner rules). Reported, never enforced: it names what to cut, and the planner decides.
 * `cap` is his typical finished work minutes on a weekday (null when there is too little data to say).
 */
export function dayTypeCheck(date: string, planTasks: Task[], cap: number | null): Record<string, unknown> | null {
  if (isCollegeDay(date)) return null;
  const work = planTasks.filter(isWork);
  const planned = work.reduce((n, t) => n + minutesOf(t), 0);
  const required = work.filter((t) => REQUIRED_TAGS.has(t.tag)).reduce((n, t) => n + minutesOf(t), 0);
  const college = work.filter((t) => t.tag === 'college');
  const flags: Record<string, unknown> = {};

  if (cap !== null && planned > cap) {
    const over = planned - cap;
    const cuttable = planned - required;
    flags.over_cap = {
      planned_minutes: planned,
      cap_minutes: cap,
      over_by: over,
      required_minutes: required,
      cut_at_least: Math.min(over, cuttable),
      ...(required > cap ? { required_alone_exceeds_cap: true } : {}),
    };
  }
  const tooBig = college.filter((t) => minutesOf(t) > EXCEPTION_MAX_MINUTES);
  if (college.length > 0) {
    flags.college_on_a_normal_day = college.map((t) => ({ title: t.title, minutes: minutesOf(t), commitment: t.commitmentId ?? null, ...(minutesOf(t) > EXCEPTION_MAX_MINUTES ? { too_long: true } : {}) }));
  }
  if (Object.keys(flags).length === 0) return null;
  return {
    ...flags,
    rule:
      'This is a normal day (not Sat or Sun). It holds only Calc 3, SAT and his listed assignments, up to his typical finished minutes, with no Bonus block. ' +
      'Cut what is over the cap, never Calc 3, SAT or a listed assignment; if those alone are over, say "Over cap by N min because X" in Warnings. ' +
      `College work belongs on Sat or Sun. The only exception is one block of at most ${EXCEPTION_MAX_MINUTES} minutes for a deadline the next college day cannot reach: label it an exception and say why. ` +
      (tooBig.length ? 'Move the college blocks marked too_long to Sat or Sun, or shrink them to the exception size. ' : '') +
      'If he wrote that he is exhausted or wants a minimum day, plan only the Calc 3 and SAT floors.',
  };
}
