// The planner website's logic, with no DOM in it so it can be tested on its own.
// It mirrors the phone app (lib/task_model.dart, lib/tasks_service.dart): the same task rules and the same server calls.
//
//   phase    visible controls               tap START     tap FINISH / row    tap STOP   untick
//   idle     START                          -> running    -> done (no timer)  -         -
//   running  FINISH + stop (under flag)     -             -> done             -> idle    -
//   done     (just "started 4:20pm")        -             -                   -          -> idle
//
// - Ticking the row is the same as FINISH, and works from idle (a tick with no Start press has no real duration).
// - Unticking always starts the task over: the Start press goes with it, so START shows again.
// - STOP only exists while running. It forgets the Start press; it never ticks or unticks.
// - The flag is separate: it survives every transition above.

export const TAGS = ['school', 'calculus3', 'sat', 'pcb', 'photography', 'college', 'other'];

export const TAG_LABEL = {
  school: 'school',
  calculus3: 'calc 3',
  sat: 'sat',
  pcb: 'pcb',
  photography: 'photo',
  college: 'college',
  other: 'other',
};

export const TAG_COLOR = {
  school: '#D4A843',
  calculus3: '#E8A0A0',
  sat: '#9C7BBC',
  pcb: '#6C8EBF',
  photography: '#8BAF7C',
  college: '#B5838D',
  other: '#A39A8B',
};

export const HOLD_FLAG_MS = 2000;

/** Normalizes one task from GET /api/tasks. Fields absent on an older server get safe defaults. */
export function normalizeTask(t) {
  return {
    id: String(t.id),
    plan: t.plan === 'B' ? 'B' : 'A',
    title: String(t.title),
    tag: TAGS.includes(t.tag) ? t.tag : 'school',
    start: typeof t.start === 'string' ? t.start : null,
    minutes: Number.isInteger(t.minutes) ? t.minutes : null,
    notes: typeof t.notes === 'string' && t.notes !== '' ? t.notes : null,
    done: t.done === true,
    startedAt: typeof t.started === 'string' ? t.started : null,
    flagged: t.flagged === true,
  };
}

export function phase(task) {
  if (task.done) return 'done';
  return task.startedAt ? 'running' : 'idle';
}

export const canStart = (task) => phase(task) === 'idle';
export const canFinish = (task) => phase(task) === 'running';
export const canStop = (task) => phase(task) === 'running';

/** START: only from idle. Pressing it again while running keeps the first press. */
export function pressStart(task, nowIso) {
  return phase(task) === 'idle' ? { ...task, startedAt: nowIso } : task;
}

/** STOP: only while running; forgets the Start press. */
export function pressStop(task) {
  return phase(task) === 'running' ? { ...task, startedAt: null } : task;
}

/** FINISH, or ticking the row. Keeps the Start press so the server can work out the real duration. */
export function tick(task) {
  return { ...task, done: true };
}

/** Unticking starts the task over. */
export function untick(task) {
  return { ...task, done: false, startedAt: null };
}

export function toggleDone(task) {
  return task.done ? untick(task) : tick(task);
}

export function toggleFlag(task) {
  return { ...task, flagged: !task.flagged };
}

/** "15:30" -> "3:30pm". Returns the input unchanged if it isn't HH:MM. */
export function formatClock(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm);
  if (!m) return hhmm;
  const h = Number(m[1]);
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${m[2]}${h >= 12 ? 'pm' : 'am'}`;
}

/** "3:30pm · 25m"; null when the task has no time. */
export function timeLabel(task) {
  if (!task.start) return null;
  const time = formatClock(task.start);
  return task.minutes ? `${time} · ${task.minutes}m` : time;
}

/** "4:20pm" for when he pressed Start (local time of this device), or null. */
export function startedLabel(task) {
  if (!task.startedAt) return null;
  const d = new Date(task.startedAt);
  if (Number.isNaN(d.getTime())) return null;
  return formatClock(`${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`);
}

export function progressMessage(done, total) {
  if (done === 0 || total === 0) return '';
  if (done === total) return '✦✦ YOU DID IT! ✦✦';
  if (done >= Math.ceil(total * 0.85)) return '✦ one more!';
  if (done >= Math.ceil(total * 0.7)) return '✦ almost done!';
  if (done >= Math.ceil(total * 0.5)) return '✦ halfway there!';
  return '';
}

/**
 * Which plan to show: the one he is following (more check-offs). On a tie (including nothing ticked) keep the plan he
 * was on if it still exists, otherwise A, or B if A is empty. Same rule as the phone app.
 */
export function choosePlan(tasks, current) {
  const done = (p) => tasks.filter((t) => t.plan === p && t.done).length;
  const a = done('A');
  const b = done('B');
  if (a !== b) return b > a ? 'B' : 'A';
  if (tasks.some((t) => t.plan === current)) return current;
  const hasA = tasks.some((t) => t.plan === 'A');
  const hasB = tasks.some((t) => t.plan === 'B');
  return hasA || !hasB ? 'A' : 'B';
}

/**
 * Takes the server's tasks, but keeps the local copy of any task with a change still on its way to the server, so a
 * refresh in the middle of a tap can't flicker the screen back.
 */
export function mergeServerDay(localTasks, serverTasks, pendingIds) {
  const local = new Map(localTasks.map((t) => [t.id, t]));
  return serverTasks.map((t) => (pendingIds.has(t.id) && local.has(t.id) ? local.get(t.id) : t));
}

/** Checklist lines in an info section: "[ ] item", "- [ ] item" or "* [ ] item". */
const CHECK_RE = /^\s*(?:[-*]\s*)?\[[ xX]?\]\s+(.*)$/;
export function parseSectionBody(body) {
  return body.split('\n').map((line) => {
    const m = CHECK_RE.exec(line);
    return m ? { kind: 'check', text: m[1].trim() } : { kind: 'text', text: line };
  });
}

/** The server calls. `fetchImpl` is injected so tests can fake the network. */
export function createApi({ baseUrl, token, fetchImpl, timeoutMs = 15000 }) {
  const root = baseUrl.replace(/\/+$/, '');
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

  async function call(path, init = {}) {
    const ctl = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = ctl ? setTimeout(() => ctl.abort(), timeoutMs) : null;
    try {
      return await fetchImpl(root + path, { ...init, headers, signal: ctl ? ctl.signal : undefined });
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async function patch(id, body) {
    try {
      const res = await call(`/api/tasks/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(body) });
      return res.status === 200;
    } catch {
      return false;
    }
  }

  return {
    /** Today's plan (the server's planner day, 04:00 rollover). Throws an Error with a short message. */
    async getDay() {
      let res;
      try {
        res = await call('/api/tasks');
      } catch {
        throw new Error("can't reach server");
      }
      if (res.status === 401) throw new Error('wrong token');
      if (res.status !== 200) throw new Error(`server error (${res.status})`);
      const body = await res.json();
      return {
        date: body.date,
        headline: typeof body.headline === 'string' ? body.headline : null,
        sections: Array.isArray(body.sections) ? body.sections.map((s) => ({ title: String(s.title), body: String(s.body) })) : [],
        rating: Number.isInteger(body.rating) ? body.rating : null,
        tasks: (body.tasks || []).map(normalizeTask),
      };
    },
    /** Unticking also clears the Start press, so the task starts over (same as the phone app). */
    setDone: (id, done) => patch(id, done ? { done: true } : { done: false, started: false }),
    setStarted: (id, started) => patch(id, { started }),
    setFlagged: (id, flagged) => patch(id, { flagged }),
    async setRating(rating) {
      try {
        const res = await call('/api/rating', { method: 'PUT', body: JSON.stringify({ rating }) });
        return res.status === 200;
      } catch {
        return false;
      }
    },
  };
}
