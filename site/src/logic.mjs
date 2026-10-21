// The planner website's logic, with no DOM in it so it can be tested on its own.
// It mirrors the phone app (lib/task_model.dart, lib/tasks_service.dart): the same task rules and the same server calls.
//
//   phase    visible controls                   START      PAUSE      RESUME     FINISH / row         STOP     untick
//   idle     START                              -> running -          -          -> done (no timer)   -        -
//   running  PAUSE + FINISH + stop (by flag)    -          -> paused  -          -> done              -> idle  -
//   paused   RESUME + FINISH + stop (by flag)   -          -          -> running -> done (pause ends) -> idle  -
//   done     (just "started 4:20pm")            -          -          -          -                    -        -> idle
//
// - Ticking the row is the same as FINISH, and works from idle (a tick with no Start press has no real duration).
// - Unticking always starts the task over: the Start press and pauses go with it, so START shows again
//   (ticking again within 10 seconds undoes that; see undoSnapshot).
// - PAUSE records when; the time until RESUME is not counted in the block's real duration. A finished task never pauses.
// - STOP only exists while running or paused. It forgets the Start press and any pauses; it never ticks or unticks.
// - The flag is separate: it survives every transition above.

export const TAGS = ['school', 'calculus3', 'sat', 'pcb', 'creative', 'college', 'other'];

export const TAG_LABEL = {
  school: 'school',
  calculus3: 'calc 3',
  sat: 'sat',
  pcb: 'pcb',
  creative: 'creative',
  college: 'college',
  other: 'other',
};

export const TAG_COLOR = {
  school: '#D4A843',
  calculus3: '#E8A0A0',
  sat: '#9C7BBC',
  pcb: '#6C8EBF',
  creative: '#8BAF7C',
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
    pausedAt: typeof t.paused === 'string' ? t.paused : null,
    pausedMs: Number.isFinite(t.paused_ms) && t.paused_ms > 0 ? t.paused_ms : 0,
    completedAt: typeof t.completed === 'string' ? t.completed : null,
    flagged: t.flagged === true,
  };
}

export function phase(task) {
  if (task.done) return 'done';
  if (!task.startedAt) return 'idle';
  return task.pausedAt ? 'paused' : 'running';
}

export const canStart = (task) => phase(task) === 'idle';
export const canPause = (task) => phase(task) === 'running';
export const canResume = (task) => phase(task) === 'paused';
export const canFinish = (task) => phase(task) === 'running' || phase(task) === 'paused';
export const canStop = (task) => phase(task) === 'running' || phase(task) === 'paused';

/** START: only from idle. Pressing it again while running keeps the first press. */
export function pressStart(task, nowIso) {
  return phase(task) === 'idle' ? { ...task, startedAt: nowIso } : task;
}

/** STOP: only while running or paused; forgets the Start press and any pauses. */
export function pressStop(task) {
  return canStop(task) ? { ...task, startedAt: null, pausedAt: null, pausedMs: 0 } : task;
}

/** PAUSE: only while running. Pressing it again changes nothing. */
export function pressPause(task, nowIso) {
  return phase(task) === 'running' ? { ...task, pausedAt: nowIso } : task;
}

const pauseGap = (fromIso, toIso) => Math.max(0, new Date(toIso).getTime() - new Date(fromIso).getTime());

/** RESUME: only while paused; the time paused is added to the total. */
export function pressResume(task, nowIso) {
  if (phase(task) !== 'paused') return task;
  return { ...task, pausedAt: null, pausedMs: task.pausedMs + pauseGap(task.pausedAt, nowIso) };
}

/** FINISH, or ticking the row. Keeps the Start press so the server can work out the real duration; ends a pause. */
export function tick(task, nowIso = new Date().toISOString()) {
  const closed = phase(task) === 'paused' ? pressResume(task, nowIso) : task;
  return { ...closed, done: true };
}

/** Unticking starts the task over. */
export function untick(task) {
  return { ...task, done: false, startedAt: null, pausedAt: null, pausedMs: 0 };
}

/** How long after an untick a re-tick puts the old Start press and finish time back (an accidental untick). */
export const UNDO_UNTICK_MS = 10000;

/** What an untick of `task` can undo: its Start press, finish time and paused time, stamped with when the untick happened. */
export function undoSnapshot(task, nowMs) {
  return { startedAt: task.startedAt, completedAt: task.completedAt, pausedMs: task.pausedMs, at: nowMs };
}

/** The snapshot if it is still fresh enough to restore, else null. */
export function freshUndo(snapshot, nowMs) {
  return snapshot && nowMs - snapshot.at <= UNDO_UNTICK_MS ? snapshot : null;
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

// ---- trays ----------------------------------------------------------------------------------------------------
// A task sits in one of three trays: To do, Current or Done.
//   done                                   -> done
//   started (running)                      -> current
//   pulled into Current but not started    -> current (the "focus" list, kept on this device)
//   anything else                          -> todo
// Pulling a slip into Current only expands it; START is a separate press, FINISH moves it to Done by itself.

export function trayOf(task, focusIds) {
  if (task.done) return 'done';
  if (task.startedAt) return 'current';
  return focusIds.has(task.id) ? 'current' : 'todo';
}

/**
 * Splits one plan's tasks into the three trays. To do and Done keep the planned order; Current lists running tasks first
 * (earliest start first), then the ones pulled in but not started, in the order they were pulled.
 */
export function splitTrays(tasks, focusOrder) {
  const focusIds = new Set(focusOrder);
  const out = { todo: [], current: [], done: [] };
  for (const t of tasks) out[trayOf(t, focusIds)].push(t);
  const running = out.current.filter((t) => t.startedAt).sort((a, b) => (a.startedAt < b.startedAt ? -1 : 1));
  const waiting = focusOrder.map((id) => out.current.find((t) => t.id === id && !t.startedAt)).filter(Boolean);
  out.current = [...running, ...waiting];
  return out;
}

/** The next thing: the first task in planned order that is still in To do. Not the one for the time of day. */
export function nextUp(tasks, focusOrder) {
  const focusIds = new Set(focusOrder);
  return tasks.find((t) => trayOf(t, focusIds) === 'todo') ?? null;
}

/**
 * What dropping a slip on a tray does, or null for nothing. 'blocked-running' means the slip is running and must be
 * stopped with its stop button first (so a drag can't throw away a start time).
 *   pull        To do -> Current: expands it, no start
 *   putback     Current (not started) -> To do
 *   finish      anything not done -> Done: ticks it (from Current with a timer if it was started)
 *   redo        Done -> To do: unticks it, so it starts over
 *   redo-focus  Done -> Current: unticks it and puts it up for starting
 */
export function dropAction(task, toTray, focusIds) {
  const from = trayOf(task, focusIds);
  if (toTray === from) return null;
  const running = canStop(task); // running or paused
  if (toTray === 'current') return from === 'done' ? 'redo-focus' : running ? null : 'pull';
  if (toTray === 'todo') return from === 'done' ? 'redo' : running ? 'blocked-running' : 'putback';
  if (toTray === 'done') return 'finish';
  return null;
}

/** Splits a block's notes into labelled rows: "Start: ...", "If-then: ...", "Method: ...", "Stop: ...", "Why: ...". */
const NOTE_LABEL_RE = /^(Start|If-then|Method|Stop|Why):\s*(.*)$/;
export function parseNotes(notes) {
  if (!notes) return [];
  return notes
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => {
      const m = NOTE_LABEL_RE.exec(line.trim());
      return m ? { label: m[1], text: m[2] } : { label: null, text: line.trim() };
    });
}

/** Minutes since an ISO time, or null. */
export function minutesSince(iso, now = Date.now()) {
  const t = new Date(iso).getTime();
  return Number.isNaN(t) ? null : Math.max(0, Math.floor((now - t) / 60000));
}

/** Minutes actually worked on a started task: since Start, not counting time paused (a pause in progress stops the clock). */
export function workedMinutes(task, now = Date.now()) {
  if (!task.startedAt) return null;
  const began = new Date(task.startedAt).getTime();
  if (Number.isNaN(began)) return null;
  const until = task.pausedAt ? new Date(task.pausedAt).getTime() : now;
  return Math.max(0, Math.floor((until - began - task.pausedMs) / 60000));
}

/**
 * Today's verse: the same one on the phone app and the website, because both pick from the same list with the same
 * rule from the same day (the planner day, "YYYY-MM-DD"). lib/verse.dart has the identical rule; keep them in step.
 */
export function verseFor(dateKey, list) {
  if (!list || list.length === 0) return 'Matthew 11:29';
  let h = 0x811c9dc5; // FNV-1a over the date's characters
  for (let i = 0; i < dateKey.length; i++) {
    h ^= dateKey.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return list[h % list.length];
}

/** "12:40pm" for a time on this device, or null. */
export function clockOf(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return formatClock(`${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`);
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
    setDone: (id, done, restore) =>
      patch(id, done ? { done: true, ...(restore ? { restoreStarted: restore.startedAt, restoreCompleted: restore.completedAt, restorePausedMs: restore.pausedMs } : {}) } : { done: false, started: false }),
    setPaused: (id, paused) => patch(id, { paused }),
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
    /** Sends one YouTube-mode stretch (the music experiment). Safe to repeat: the server keeps it by id. True once the server has it. */
    async putMusic(id, started, ended, mode) {
      try {
        const res = await call(`/api/music/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify({ started, ended: ended || null, mode: mode || 'browsing' }) });
        return res.status === 200;
      } catch {
        return false;
      }
    },
    /** What YouTube mode is right now: { reachable, current: { id, started, mode } | null }. */
    async getMusicCurrent() {
      try {
        const res = await call('/api/music/current');
        if (res.status !== 200) return { reachable: false, current: null };
        const body = await res.json();
        return { reachable: true, current: body.current || null };
      } catch {
        return { reachable: false, current: null };
      }
    },
  };
}

// ---- YouTube mode (the music experiment): the printer's button ----
// Pink = nothing, blue = YouTube browsing (just watching videos), green = YouTube lecture (following along). Each tap steps to the next one.
// It is recorded here first (so it works with no connection) and sent whenever the server can be reached; the same rules as the phone app.

export const MUSIC_ORDER = ['browsing', 'lecture'];

// the pink button on the 320 x 108 printer canvas, in canvas pixels
export const PINK_BUTTON = { x: 24, y: 28, w: 28, h: 16 };

export function hitsPinkButton(x, y, margin = 16) {
  return x >= PINK_BUTTON.x - margin && x <= PINK_BUTTON.x + PINK_BUTTON.w + margin && y >= PINK_BUTTON.y - margin && y <= PINK_BUTTON.y + PINK_BUTTON.h + margin;
}

/**
 * Keeps the YouTube-mode state on this device. `storage` is localStorage-like (getItem/setItem, may throw); `send(id, started, ended, mode)`
 * resolves true once the server has the stretch; `fetchCurrent()` resolves { reachable, current } (what the server says is on right now).
 */
export function createMusicTracker({ storage, send, fetchCurrent, clock = () => new Date().toISOString() }) {
  const KEY = 'planner-music';
  let open = null; // { id, started, mode }
  let pending = {}; // id -> { started, ended, mode }
  let seq = 0;
  let flushing = false;
  try {
    const saved = JSON.parse(storage.getItem(KEY) || 'null');
    if (saved) {
      open = saved.open || null;
      pending = saved.pending || {};
    }
  } catch {
    // nothing saved yet, or storage is blocked: start clean
  }

  function save() {
    try {
      storage.setItem(KEY, JSON.stringify({ open, pending }));
    } catch {
      // storage may be blocked; it still works until the page is closed
    }
  }
  function start(now, mode) {
    open = { id: 'w' + Date.parse(now) + '-' + seq++, started: now, mode };
    pending[open.id] = { started: now, ended: null, mode };
  }
  function end(now) {
    pending[open.id] = { started: open.started, ended: now, mode: open.mode };
    open = null;
  }

  async function flush() {
    if (flushing) return;
    flushing = true;
    try {
      for (const id of Object.keys(pending)) {
        const sent = pending[id];
        let ok = false;
        try {
          ok = await send(id, sent.started, sent.ended, sent.mode);
        } catch {
          ok = false;
        }
        if (!ok) break; // no connection: the rest would fail too
        // if it changed while sending (it was switched off mid-flight), keep it for another send
        if (pending[id] && pending[id].ended === sent.ended) delete pending[id];
      }
      save();
    } finally {
      flushing = false;
    }
  }

  return {
    /** The mode on right now, or null when off. */
    mode: () => (open ? open.mode : null),
    unsynced: () => Object.keys(pending).length,
    /** Steps off -> order[0] -> order[1] -> ... -> off. Changing mode ends one stretch and starts the next at the same instant. */
    async advance(order = MUSIC_ORDER) {
      const now = clock();
      if (!open) start(now, order[0]);
      else {
        const next = order.indexOf(open.mode) + 1;
        end(now);
        if (next < order.length) start(now, order[next]);
      }
      save();
      await flush();
    },
    flush,
    /** Takes over what the server says is on (another device may have changed it), but only when nothing here is waiting to be sent. */
    async sync() {
      await flush();
      if (Object.keys(pending).length > 0) return false;
      const remote = await fetchCurrent();
      if (!remote || !remote.reachable) return false;
      const before = open ? open.id + open.mode : '';
      open = remote.current ? { id: remote.current.id, started: remote.current.started, mode: remote.current.mode } : null;
      save();
      return before !== (open ? open.id + open.mode : '');
    },
  };
}
