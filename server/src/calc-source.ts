// The Calc 3 schedule, read from the progress site's own source (the public index.html of the college-plan repo).
//
// Why: Firebase only keeps which days he moved, not the schedule itself, and the site only writes that when he drags or skips something.
// After the site's plan is rewritten, Firebase still describes the OLD plan, so the planner used to have to download and parse the 1 MB page
// to find out which lesson belongs to which date. This does it once on the server and returns exact dates.
//
// It reads only the few pieces it needs by scanning the text (DAY_GRIDS, STATE_RESETS, each week's date range, the lesson titles) instead of
// parsing the whole page, and the result is cached for ten minutes.

export interface CalcWeek {
  id: string;
  start: [number, number, number] | null;
  days: { id: string; rest: boolean }[];
}

export interface CalcSource {
  weeks: CalcWeek[];
  titles: Record<string, string>;
  /** When the site's plan was last rewritten (its STATE_RESETS entry for calc3), epoch ms. */
  resetAt: number | null;
  resetToken: string | null;
  /** `<slots>x<rests>:<first lesson>..<last lesson>`, the same signature the site stores next to its saved rest days. */
  sig: string;
}

export interface CalcDay {
  date: string;
  id: string;
  rest: boolean;
  title: string | null;
  week: string;
}

const DEFAULT_URL = 'https://raw.githubusercontent.com/marioario5/college-plan/main/index.html';
const CACHE_MS = 10 * 60_000;

/** The JSON value that starts right after `marker` (an object or an array), found by balancing brackets, or null. */
function jsonAfter(html: string, marker: string): unknown {
  const at = html.indexOf(marker);
  if (at < 0) return null;
  let i = at + marker.length;
  while (html[i] === ' ') i++;
  const open = html[i];
  const close = open === '[' ? ']' : open === '{' ? '}' : null;
  if (!close) return null;
  let depth = 0;
  let inString = false;
  for (let j = i; j < html.length; j++) {
    const c = html[j];
    if (inString) {
      if (c === '\\') j++;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === open) depth++;
    else if (c === close && --depth === 0) {
      try {
        return JSON.parse(html.slice(i, j + 1));
      } catch {
        return null;
      }
    }
  }
  return null;
}

const decode = (s: string): string =>
  s.replace(/<[^>]+>/g, '').replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();

/** Reads the schedule out of the page. Null if the page does not look like the planner site. */
export function parseCalcSource(html: string): CalcSource | null {
  const grids = jsonAfter(html, '"DAY_GRIDS":') as { week: string; days: { id: string; rest: boolean }[] }[] | null;
  if (!Array.isArray(grids)) return null;
  const weeks: CalcWeek[] = grids
    .filter((g) => typeof g.week === 'string' && g.week.startsWith('calc3-') && Array.isArray(g.days))
    .map((g) => {
      const at = html.indexOf(`"id": "${g.week}"`);
      const m = at < 0 ? null : /"range":\s*\{[^}]*?"start":\s*\[(\d+),\s*(\d+),\s*(\d+)\]/.exec(html.slice(at, at + 12_000));
      return { id: g.week, start: m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null, days: g.days.map((d) => ({ id: d.id, rest: !!d.rest })) };
    });
  if (weeks.length === 0) return null;

  const titles: Record<string, string> = {};
  const re = /data-task-id="(calc3-t\d+)"[^>]*><span>(.*?)<\/span>/g;
  for (let m = re.exec(html); m; m = re.exec(html)) if (!(m[1] in titles)) titles[m[1]] = decode(m[2]);

  const resets = jsonAfter(html, '"STATE_RESETS":') as Record<string, { token?: string; at?: number }> | null;
  const slots = weeks.flatMap((w) => w.days);
  const lessons = slots.filter((d) => !d.rest).map((d) => d.id);
  return {
    weeks,
    titles,
    resetAt: typeof resets?.calc3?.at === 'number' ? resets.calc3.at : null,
    resetToken: typeof resets?.calc3?.token === 'string' ? resets.calc3.token : null,
    sig: `${slots.length}x${slots.length - lessons.length}:${lessons[0] ?? '-'}..${lessons[lessons.length - 1] ?? '-'}`,
  };
}

const pad = (n: number) => String(n).padStart(2, '0');
function addDays(start: [number, number, number], days: number): string {
  const d = new Date(Date.UTC(start[0], start[1] - 1, start[2] + days));
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/** What the site stored for itself (`state.days.value.calc3` and the time it was written). */
export interface StoredDays {
  sig?: unknown;
  rest?: unknown;
  t?: number | null;
}

/**
 * The schedule, day by day. Slot i is the i-th day of the plan (weeks in order, one slot per day); a rest slot takes the next "Rest" row and every
 * other slot the next lesson in document order, exactly as the site does. The rest days are the ones he saved (if what he saved belongs to this
 * plan: same signature and written after the plan was rewritten), otherwise the ones the plan itself authored.
 */
export function buildSchedule(src: CalcSource, stored: StoredDays | undefined): { days: CalcDay[]; rest_days_from: 'his saved changes' | 'the plan as written' } {
  const slots = src.weeks.flatMap((w) => w.days.map((d, i) => ({ week: w, dayIdx: i, authoredRest: d.rest })));
  let restSlots = new Set(slots.map((s, i) => (s.authoredRest ? i : -1)).filter((i) => i >= 0));
  let from: 'his saved changes' | 'the plan as written' = 'the plan as written';
  const restCount = restSlots.size;
  const saved = Array.isArray(stored?.rest) ? (stored!.rest as unknown[]).filter((i): i is number => Number.isInteger(i) && (i as number) >= 0 && (i as number) < slots.length) : null;
  const fresh = src.resetAt === null || (typeof stored?.t === 'number' && stored.t >= src.resetAt);
  if (saved && stored?.sig === src.sig && fresh && new Set(saved).size === restCount) {
    restSlots = new Set(saved);
    from = 'his saved changes';
  }

  const lessons = src.weeks.flatMap((w) => w.days).filter((d) => !d.rest).map((d) => d.id);
  const rests = src.weeks.flatMap((w) => w.days).filter((d) => d.rest).map((d) => d.id);
  let lp = 0;
  let rp = 0;
  const days = slots.map((s, i) => {
    const rest = restSlots.has(i);
    const id = (rest ? rests[rp++] : lessons[lp++]) ?? `calc3-slot-${i}`;
    return { date: s.week.start ? addDays(s.week.start, s.dayIdx) : '', id, rest, title: src.titles[id] ?? null, week: s.week.id };
  });
  return { days, rest_days_from: from };
}

/** True when `today` is a rest day in the site's current Calc 3 plan (so no Calc block is due). False when unknown or when the site cannot be read. */
export async function isCalcRestDay(
  sync: { site: { read(): Promise<{ state: Record<string, unknown> }> }; calcSource?: () => Promise<CalcSource | null> } | undefined,
  today: string,
): Promise<boolean> {
  if (!sync?.calcSource) return false;
  try {
    const src = await sync.calcSource();
    if (!src) return false;
    const snap = await sync.site.read();
    const dn = snap.state.days as { t?: unknown; value?: { calc3?: { sig?: unknown; rest?: unknown } } } | undefined;
    const plan = buildSchedule(src, { sig: dn?.value?.calc3?.sig, rest: dn?.value?.calc3?.rest, t: typeof dn?.t === 'number' ? dn.t : null });
    return plan.days.find((d) => d.date === today)?.rest === true;
  } catch {
    return false;
  }
}

let cache: { url: string; at: number; source: CalcSource | null } | null = null;

/** The parsed schedule, cached for ten minutes. Null if the page cannot be fetched or does not parse (callers carry on without it). */
export async function loadCalcSource(url: string = DEFAULT_URL, nowMs: number = Date.now(), fetchImpl: typeof fetch = fetch): Promise<CalcSource | null> {
  if (cache && cache.url === url && nowMs - cache.at < CACHE_MS) return cache.source;
  let source: CalcSource | null = null;
  try {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(6000) });
    if (res.ok) source = parseCalcSource(await res.text());
  } catch {
    source = null;
  }
  if (source || !cache) cache = { url, at: nowMs, source };
  else cache = { ...cache, at: nowMs }; // keep the last good copy for another ten minutes rather than hammering a failing fetch
  return cache.source;
}

export function clearCalcSourceCache(): void {
  cache = null;
}
