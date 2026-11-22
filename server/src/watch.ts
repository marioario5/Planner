// The Firefox extension reports each YouTube video while it plays. From that the server keeps YouTube mode on by itself: it opens a
// music session when the first video starts, picks the mode (lecture or browsing) from the title and channel, and closes the session
// when playback has stopped for a while. Kept with the music experiment: the planner never reads any of it.

import { localTime, plannerTimeToEpoch, shiftDate } from './dates';
import { parseWatch, type GymSession, type MusicMode, type TaskStore, type WatchRecord } from './tasks';

/** A session this module opened is called `yt-...`; a session he switched on in the app is never touched. */
export const AUTO_PREFIX = 'yt-';
/** A session spans pauses: playback that stops for this long ends it, at the last moment a video was seen playing. */
export const IDLE_MS = 15 * 60_000;
/** The light (YouTube mode on right now) goes off this long after the last report; a playing video reports every 10 seconds. */
export const LIVE_MS = 30_000;

const LECTURE_CHANNELS = [
  'khan academy', 'professor leonard', 'the organic chemistry tutor', '3blue1brown', 'patrickjmt', 'mit opencourseware',
  'mathispower4u', 'dr. trefor bazett', 'michel van biezen', 'blackpenredpen', 'the bright side of mathematics', 'crash course',
];
const LECTURE_WORDS =
  /\b(calc(ulus)?(\s*(3|iii))?|multivariable|vector calculus|surface integrals?|line integrals?|stokes|divergence theorem|green'?s theorem|lecture|worked example|tutorial|sat (math|reading|writing|prep)|ap (stats|statistics|gov|government|chem|chemistry|calc|calculus)|organic chemistry|differential equations|linear algebra)\b/i;

/** lecture = following along with something he is learning; anything else is browsing. A guess from words, so it is easy to tune here. */
export function classifyVideo(title: string, channel: string): MusicMode {
  const c = channel.toLowerCase();
  if (LECTURE_CHANNELS.some((name) => c.includes(name))) return 'lecture';
  return LECTURE_WORDS.test(title) ? 'lecture' : 'browsing';
}

/** Closes any session this module opened that has been quiet for IDLE_MS, ending it where the last video was seen. */
export async function settleAutoSessions(store: TaskStore, nowMs: number): Promise<void> {
  const from = new Date(nowMs - 3 * 86_400_000).toISOString();
  const open = (await store.listMusic(from)).filter((s) => s.endedAt === null && s.id.startsWith(AUTO_PREFIX));
  if (open.length === 0) return;
  const watches = await store.listWatch(from);
  for (const s of open) {
    const last = watches.filter((w) => w.sessionId === s.id).reduce((m, w) => (w.endedAt > m ? w.endedAt : m), s.startedAt);
    if (nowMs - Date.parse(last) > IDLE_MS) await store.saveMusic({ ...s, endedAt: last });
  }
}

/**
 * What YouTube mode is right now, for the light. A session he switched on by hand is on until he switches it off. A session the
 * extension opened is on only while a video was seen playing in the last LIVE_MS (a pause turns the light off within 30 seconds,
 * though the session itself carries on for up to IDLE_MS so one sitting stays one session), and shows the mode of the video playing.
 */
export async function currentMode(store: TaskStore, nowMs: number): Promise<{ id: string; started: string; mode: MusicMode } | null> {
  await settleAutoSessions(store, nowMs);
  const recent = await store.listMusic(new Date(nowMs - 3 * 86_400_000).toISOString());
  // the latest session still open: a short closed stretch must not hide an older one that is on; one left on for half a day is a forgotten switch
  const open = [...recent].reverse().find((s) => s.endedAt === null && nowMs - Date.parse(s.startedAt) < 12 * 3_600_000);
  if (!open) return null;
  if (!open.id.startsWith(AUTO_PREFIX)) return { id: open.id, started: open.startedAt, mode: open.mode ?? 'browsing' };
  const watches = (await store.listWatch(new Date(Date.parse(open.startedAt) - 1000).toISOString())).filter((w) => w.sessionId === open.id);
  const last = watches.reduce<WatchRecord | null>((m, w) => (!m || w.endedAt > m.endedAt ? w : m), null);
  if (!last || nowMs - Date.parse(last.endedAt) > LIVE_MS) return null;
  return { id: open.id, started: open.startedAt, mode: last.mode };
}

/** PUT /api/watch/:id: save what the extension saw and keep the YouTube-mode session in step with it. */
export async function putWatch(store: TaskStore, id: string, body: unknown, nowMs: number): Promise<WatchRecord & { final: boolean }> {
  const { record, final } = parseWatch(id, body);
  await settleAutoSessions(store, nowMs);
  const mode = classifyVideo(record.title, record.channel);
  const recent = await store.listMusic(new Date(nowMs - 3 * 86_400_000).toISOString());
  const manual = recent.find((s) => s.endedAt === null && !s.id.startsWith(AUTO_PREFIX));
  const openAuto = [...recent].reverse().find((s) => s.endedAt === null && s.id.startsWith(AUTO_PREFIX));

  // The server owns which session a report belongs to (the extension's id is only a hint): the one still open, else a new one.
  // A closed session is never reopened, so a report that names one starts a new session instead of playing on with the light off.
  let sessionId = record.sessionId;
  if (!manual) {
    if (openAuto) sessionId = openAuto.id;
    else if (!record.sessionId.startsWith(AUTO_PREFIX) || recent.some((s) => s.id === record.sessionId)) sessionId = `${AUTO_PREFIX}${id}`;
  }
  const watch: WatchRecord = { ...record, sessionId, mode };
  await store.saveWatch(watch);

  if (!manual && sessionId.startsWith(AUTO_PREFIX)) {
    const existing = recent.find((s) => s.id === sessionId);
    // a new session starts when this report's video started, but never before the previous session ended
    const previousEnd = recent.filter((s) => s.id.startsWith(AUTO_PREFIX) && s.endedAt !== null).reduce((m, s) => (s.endedAt! > m ? s.endedAt! : m), '');
    const startedAt = existing?.startedAt ?? (record.startedAt > previousEnd ? record.startedAt : previousEnd);
    const inSession = (await store.listWatch(new Date(Date.parse(startedAt) - 1000).toISOString())).filter((w) => w.sessionId === sessionId);
    await store.saveMusic({
      id: sessionId,
      startedAt,
      endedAt: final ? record.endedAt : null,
      mode: inSession.some((w) => w.mode === 'lecture') ? 'lecture' : 'browsing',
    });
  }
  return { ...watch, final };
}

/**
 * For the stats: a session the extension opened counts as YouTube on only while a video was playing. Its watch rows are the
 * stretches of playing (a pause of 30 seconds or more ends one), so the pauses inside the session are not counted as on.
 * Sessions he switched on by hand stay as they are.
 */
export function expandAutoSessions(sessions: GymSession[], watches: WatchRecord[]): GymSession[] {
  const out: GymSession[] = [];
  for (const s of sessions) {
    if (!s.id.startsWith(AUTO_PREFIX)) {
      out.push(s);
      continue;
    }
    for (const w of watches) if (w.sessionId === s.id) out.push({ id: w.id, startedAt: w.startedAt, endedAt: w.endedAt, mode: w.mode });
  }
  return out;
}

/** What a session was made of: the minutes a video really played, and the pauses of 30 seconds or more inside it. */
export function sessionMakeup(sessionId: string, watches: WatchRecord[]): { playing_minutes: number; pauses: number; paused_minutes: number } {
  const rows = watches.filter((w) => w.sessionId === sessionId).sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  let paused = 0;
  let pauses = 0;
  for (let i = 1; i < rows.length; i++) {
    const gap = Date.parse(rows[i].startedAt) - Date.parse(rows[i - 1].endedAt);
    if (gap >= 30_000) {
      pauses++;
      paused += gap;
    }
  }
  return {
    playing_minutes: round1(rows.reduce((n, w) => n + w.watchedS, 0) / 60),
    pauses,
    paused_minutes: round1(paused / 60_000),
  };
}

// ---------------------------------------------------------------- the analysis the music tools return

const localDate = (iso: string, timeZone: string): string =>
  new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));

const round1 = (n: number) => Math.round(n * 10) / 10;

/** The latest 40 videos, each stretch of the same video within a session merged into one line. */
function recentVideos(rows: WatchRecord[], timeZone: string) {
  const merged = new Map<string, { date: string; start: string; title: string; channel: string; seconds: number; mode: MusicMode; at: string }>();
  for (const w of rows) {
    const key = `${w.sessionId}|${w.videoId}`;
    const cur = merged.get(key);
    if (cur) cur.seconds += w.watchedS;
    else merged.set(key, { date: localDate(w.startedAt, timeZone), start: localTime(w.startedAt, timeZone), title: w.title, channel: w.channel, seconds: w.watchedS, mode: w.mode, at: w.startedAt });
  }
  return [...merged.values()].sort((a, b) => (a.at < b.at ? 1 : -1)).slice(0, 40).map(({ at, ...v }) => v);
}

/** What he watches: totals, favourite channels, the hours he watches, and the recent videos. */
export function summarizeWatch(all: WatchRecord[], timeZone: string, today: string, days: number) {
  const from = plannerTimeToEpoch(shiftDate(today, -days), '00:00', timeZone);
  const inWindow = all.filter((w) => Date.parse(w.startedAt) >= from);
  // one video can be several stretches (he paused it): it counts once it has played 30 seconds in all
  const playedIn = new Map<string, number>();
  for (const w of inWindow) playedIn.set(w.videoId, (playedIn.get(w.videoId) ?? 0) + w.watchedS);
  const real = inWindow.filter((w) => (playedIn.get(w.videoId) ?? 0) >= 30);
  const minutes = (secs: number) => round1(secs / 60);

  const byMode: Record<string, number> = {};
  const byChannel = new Map<string, { s: number; videos: Set<string>; lecture: number }>();
  const byHour: Record<string, number> = {};
  for (const w of real) {
    byMode[w.mode] = (byMode[w.mode] ?? 0) + w.watchedS;
    const c = byChannel.get(w.channel) ?? { s: 0, videos: new Set<string>(), lecture: 0 };
    c.s += w.watchedS;
    c.videos.add(w.videoId);
    if (w.mode === 'lecture') c.lecture += w.watchedS;
    byChannel.set(w.channel, c);
    const hour = localTime(w.startedAt, timeZone).slice(0, 2);
    byHour[hour] = (byHour[hour] ?? 0) + w.watchedS;
  }
  const total = real.reduce((n, w) => n + w.watchedS, 0);
  return {
    window_days: days,
    note: 'Seconds actually played, from the Firefox extension. A video counts once it has played 30 seconds. `mode` is a guess from the title and channel.',
    videos_logged: new Set(real.map((w) => w.videoId)).size,
    total_minutes: minutes(total),
    minutes_by_mode: Object.fromEntries(Object.entries(byMode).map(([k, v]) => [k, minutes(v)])),
    top_channels: [...byChannel.entries()]
      .sort((a, b) => b[1].s - a[1].s)
      .slice(0, 15)
      .map(([channel, c]) => ({ channel, minutes: minutes(c.s), videos: c.videos.size, mostly: c.lecture * 2 >= c.s ? 'lecture' : 'browsing' })),
    minutes_by_start_hour: Object.fromEntries(Object.entries(byHour).sort().map(([k, v]) => [k, minutes(v)])),
    recent: recentVideos(real, timeZone).map(({ seconds, ...v }) => ({ ...v, minutes: minutes(seconds) })),
  };
}
