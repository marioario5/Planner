// The Firefox extension reports each YouTube video while it plays. From that the server keeps YouTube mode on by itself: it opens a
// music session when the first video starts, picks the mode (lecture or browsing) from the title and channel, and closes the session
// when playback has stopped for a while. Kept with the music experiment: the planner never reads any of it.

import { localTime, plannerTimeToEpoch, shiftDate } from './dates';
import { parseWatch, type GymSession, type MusicMode, type TaskStore, type WatchRecord } from './tasks';

/** A session this module opened is called `yt-...`; a session he switched on in the app is never touched. */
export const AUTO_PREFIX = 'yt-';
/** Playback that stops for this long ends the session at the last moment a video was seen playing. */
export const IDLE_MS = 10 * 60_000;

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

/** PUT /api/watch/:id: save what the extension saw and keep the YouTube-mode session in step with it. */
export async function putWatch(store: TaskStore, id: string, body: unknown, nowMs: number): Promise<WatchRecord & { final: boolean }> {
  const { record, final } = parseWatch(id, body);
  await settleAutoSessions(store, nowMs);
  const mode = classifyVideo(record.title, record.channel);
  const watch: WatchRecord = { ...record, mode };
  await store.saveWatch(watch);

  const recent = await store.listMusic(new Date(nowMs - 3 * 86_400_000).toISOString());
  const manual = recent.find((s) => s.endedAt === null && !s.id.startsWith(AUTO_PREFIX));
  if (!manual && record.sessionId.startsWith(AUTO_PREFIX)) {
    const existing = recent.find((s) => s.id === record.sessionId);
    if (!existing || existing.endedAt === null) {
      const inSession = (await store.listWatch(new Date(Date.parse(existing?.startedAt ?? record.startedAt) - 1000).toISOString())).filter((w) => w.sessionId === record.sessionId);
      const session: GymSession = {
        id: record.sessionId,
        startedAt: existing?.startedAt ?? record.startedAt,
        endedAt: final ? record.endedAt : null,
        mode: inSession.some((w) => w.mode === 'lecture') ? 'lecture' : 'browsing',
      };
      await store.saveMusic(session);
    }
  }
  return { ...watch, final };
}

// ---------------------------------------------------------------- the analysis the music tools return

const localDate = (iso: string, timeZone: string): string =>
  new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));

const round1 = (n: number) => Math.round(n * 10) / 10;

/** What he watches: totals, favourite channels, the hours he watches, and the recent videos. */
export function summarizeWatch(all: WatchRecord[], timeZone: string, today: string, days: number) {
  const from = plannerTimeToEpoch(shiftDate(today, -days), '00:00', timeZone);
  const real = all.filter((w) => Date.parse(w.startedAt) >= from && w.watchedS >= 30);
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
    recent: real.slice(-40).reverse().map((w) => ({
      date: localDate(w.startedAt, timeZone),
      start: localTime(w.startedAt, timeZone),
      title: w.title,
      channel: w.channel,
      minutes: minutes(w.watchedS),
      mode: w.mode,
    })),
  };
}
