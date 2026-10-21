import { bearerMatches, tokenConfigured, tokenMatches } from './auth';
import { D1TaskStore } from './d1-store';
import { plannerToday, resolveDate } from './dates';
import { FirebaseSite, parseResets } from './firebase';
import { handleMcpPost } from './mcp';
import { handleMusicMcpPost } from './music';
import { runningTask } from './running';
import { slippingSection } from './slipping';
import { parsePrefixes, reconcile, type SyncConfig } from './sync';
import { ValidationError, parseGym, parsePatch, parseRating, type Task, type TaskStore } from './tasks';

export interface Env {
  DB: D1Database;
  /** Shared secret. Set with `wrangler secret put API_TOKEN`. */
  API_TOKEN: string;
  /** Optional second secret that may only read GET /api/running (for a display that must not be able to change anything). Set with `wrangler secret put READ_TOKEN`. */
  READ_TOKEN?: string;
  /** Optional secret for the separate music experiment's MCP endpoint (/music/mcp). API_TOKEN also works there. `wrangler secret put MUSIC_TOKEN`. */
  MUSIC_TOKEN?: string;
  PLANNER_TZ?: string;
  /** The progress site's Firebase state URL. Set with `wrangler secret put FIREBASE_STATE_URL`; unset = no site sync. */
  FIREBASE_STATE_URL?: string;
  /** Comma-separated site task id prefixes to mirror. Default `calc3-`. */
  SYNC_PREFIXES?: string;
  /** Resets of the site's plan, "prefix:epochMs" comma separated, e.g. "calc3-:1792347017018". Older check marks under the prefix are ignored. */
  SYNC_RESET_BEFORE?: string;
  /** Comma-separated web origins allowed to call /api from a browser (the planner website). Default: the GitHub Pages site. */
  ALLOWED_ORIGINS?: string;
}

const DEFAULT_ALLOWED_ORIGINS = 'https://marioario5.github.io';

function allowedOrigins(env: Pick<Env, 'ALLOWED_ORIGINS'>): string[] {
  return (env.ALLOWED_ORIGINS ?? DEFAULT_ALLOWED_ORIGINS)
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
}

const isApiPath = (path: string) => path === '/api/rating' || path.startsWith('/api/music/') || path === '/api/running' || path.startsWith('/api/gym/') || path === '/api/tasks' || path.startsWith('/api/tasks/');

/**
 * Lets the planner website (a different origin) call the app API. Only origins on the allow list get CORS headers, so
 * any other site's browser is blocked from reading responses. The bearer token is still required for every real call.
 */
function withCors(request: Request, env: Pick<Env, 'ALLOWED_ORIGINS'>, response: Response): Response {
  const origin = request.headers.get('Origin');
  if (!origin || !allowedOrigins(env).includes(origin)) return response;
  const out = new Response(response.body, response);
  out.headers.set('Access-Control-Allow-Origin', origin);
  out.headers.set('Vary', 'Origin');
  return out;
}

const DEFAULT_TZ = 'America/Los_Angeles';

const json = (body: unknown, status = 200) => Response.json(body, { status });
const unauthorized = () =>
  Response.json({ error: 'unauthorized' }, { status: 401, headers: { 'WWW-Authenticate': 'Bearer' } });

const apiView = (t: Task) => ({
  id: t.id,
  date: t.date,
  plan: t.plan,
  title: t.title,
  tag: t.tag,
  start: t.start,
  minutes: t.minutes,
  notes: t.notes,
  done: t.done,
  /** ISO time he pressed Start, or null. */
  started: t.startedAt,
  /** ISO time he paused it (while paused), else null; `paused_ms` is the total already spent paused. */
  paused: t.pausedAt,
  paused_ms: t.pausedMs,
  /** ISO time it was checked off, or null; lets a client undo an accidental untick. */
  completed: t.done ? t.completedAt : null,
  /** He held the flag on it: its times are unreliable. */
  flagged: t.flaggedAt !== null,
  position: t.position,
});

/**
 * Routes:
 *   POST   /mcp            MCP endpoint (Authorization: Bearer <token>)
 *   POST   /mcp/<token>    MCP endpoint for clients that can't send headers (claude.ai connectors)
 *   GET    /api/tasks?date=YYYY-MM-DD
 *   PATCH  /api/tasks/:id  {done?, started?, paused?, flagged?, title?, tag?, start?, minutes?, notes?, restoreStarted?, restoreCompleted?, restorePausedMs?}
 *   PUT    /api/music/:id  {started, ended?}  YouTube-mode switch (the music experiment; idempotent)
 *   POST   /music/mcp[/<token>]  the music experiment's own MCP endpoint (MUSIC_TOKEN or API_TOKEN)
 *   PUT    /api/gym/:id    {started, ended?}  gym switch (idempotent; the id is made by the app)
 *   GET    /api/running    the task in progress (title, tag, planned minutes, worked time); READ_TOKEN may call only this
 *   PUT    /api/rating     {date?, rating: 1-5 | null}  how the day felt
 *   DELETE /api/tasks/:id
 */
export async function handleRequest(
  request: Request,
  env: Pick<Env, 'API_TOKEN' | 'PLANNER_TZ' | 'ALLOWED_ORIGINS'> & Partial<Pick<Env, 'READ_TOKEN' | 'MUSIC_TOKEN'>>,
  store: TaskStore,
  now?: Date,
  sync?: SyncConfig,
): Promise<Response> {
  const path = new URL(request.url).pathname.replace(/\/+$/, '') || '/';
  if (!isApiPath(path)) return handleInner(request, env, store, now, sync);

  if (request.method === 'OPTIONS') {
    // Browser preflight: no credentials are sent on it, so it is answered before authentication.
    const preflight = new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Methods': 'GET, PATCH, PUT, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Authorization, Content-Type',
        'Access-Control-Max-Age': '86400',
      },
    });
    return withCors(request, env, preflight);
  }
  return withCors(request, env, await handleInner(request, env, store, now, sync));
}

async function handleInner(
  request: Request,
  env: Pick<Env, 'API_TOKEN' | 'PLANNER_TZ'> & Partial<Pick<Env, 'READ_TOKEN' | 'MUSIC_TOKEN'>>,
  store: TaskStore,
  now?: Date,
  sync?: SyncConfig,
): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, '') || '/';
  const timeZone = env.PLANNER_TZ || DEFAULT_TZ;

  if (path === '/') return new Response('cozy-planner ok\n');

  const isMcp = path === '/mcp' || path.startsWith('/mcp/');
  const isMusicMcp = path === '/music/mcp' || path.startsWith('/music/mcp/');
  const isApi = path === '/api/tasks' || path.startsWith('/api/tasks/') || path === '/api/rating' || path.startsWith('/api/gym/') || path === '/api/running' || path.startsWith('/api/music/');
  if (!isMcp && !isMusicMcp && !isApi) return json({ error: 'not found' }, 404);

  if (!tokenConfigured(env.API_TOKEN)) {
    return json({ error: 'server is missing a valid API_TOKEN secret' }, 500);
  }

  try {
    if (isMusicMcp) {
      // A separate endpoint for the music experiment: its own tools, its own optional token (the planner token works too).
      const secrets = [env.MUSIC_TOKEN, env.API_TOKEN].filter(tokenConfigured);
      const pathToken = path.startsWith('/music/mcp/') ? decodeURIComponent(path.slice('/music/mcp/'.length)) : null;
      let ok = false;
      for (const secret of secrets) {
        if (pathToken ? await tokenMatches(pathToken, secret) : await bearerMatches(request, secret)) ok = true;
      }
      if (!ok) return unauthorized();
      if (request.method !== 'POST') return new Response(null, { status: 405, headers: { Allow: 'POST' } });
      return await handleMusicMcpPost(request, { store, timeZone, now, sync });
    }
    if (isMcp) {
      const pathToken = path.startsWith('/mcp/') ? decodeURIComponent(path.slice('/mcp/'.length)) : null;
      const ok = pathToken
        ? await tokenMatches(pathToken, env.API_TOKEN)
        : await bearerMatches(request, env.API_TOKEN);
      if (!ok) return unauthorized();
      if (request.method !== 'POST') {
        // No server-initiated stream and no sessions to terminate.
        return new Response(null, { status: 405, headers: { Allow: 'POST' } });
      }
      return await handleMcpPost(request, { store, timeZone, now, sync });
    }

    if (path === '/api/running') {
      if (request.method !== 'GET') return json({ error: 'method not allowed' }, 405);
      const full = await bearerMatches(request, env.API_TOKEN);
      const readOnly = !full && tokenConfigured(env.READ_TOKEN) && (await bearerMatches(request, env.READ_TOKEN));
      if (!full && !readOnly) return unauthorized();
      return json(await runningTask(store, timeZone, now));
    }

    if (!(await bearerMatches(request, env.API_TOKEN))) return unauthorized();

    if (path.startsWith('/api/music/')) {
      if (request.method !== 'PUT') return json({ error: 'method not allowed' }, 405);
      const body = await request.json().catch(() => {
        throw new ValidationError('body must be JSON');
      });
      const session = parseGym(decodeURIComponent(path.slice('/api/music/'.length)), body);
      await store.saveMusic(session);
      return json(session);
    }

    if (path.startsWith('/api/gym/')) {
      if (request.method !== 'PUT') return json({ error: 'method not allowed' }, 405);
      const body = await request.json().catch(() => {
        throw new ValidationError('body must be JSON');
      });
      const session = parseGym(decodeURIComponent(path.slice('/api/gym/'.length)), body);
      await store.saveGym(session);
      return json(session);
    }

    if (path === '/api/rating') {
      if (request.method !== 'PUT') return json({ error: 'method not allowed' }, 405);
      const body = (await request.json().catch(() => {
        throw new ValidationError('body must be JSON');
      })) as Record<string, unknown>;
      const date = resolveDate(typeof body?.date === 'string' ? body.date : null, timeZone, now);
      if (!body || !('rating' in body)) throw new ValidationError('rating is required: 1 to 5, or null to clear');
      const rating = parseRating(body.rating);
      await store.setRating(date, rating);
      return json({ date, rating });
    }

    if (path === '/api/tasks') {
      if (request.method !== 'GET') return json({ error: 'method not allowed' }, 405);
      const date = resolveDate(url.searchParams.get('date'), timeZone, now);
      const [tasks, info, rating] = await Promise.all([store.list(date), store.getDayInfo(date), store.getRating(date)]);
      await reconcile(store, tasks, sync); // pull in anything he ticked on the site
      const slip = date === plannerToday(timeZone, now) ? await slippingSection(store, date, tasks) : null;
      return json({
        date,
        headline: info.headline,
        sections: slip ? [slip, ...info.sections] : info.sections,
        rating,
        tasks: tasks.map(apiView),
      });
    }

    const id = decodeURIComponent(path.slice('/api/tasks/'.length));
    if (request.method === 'PATCH') {
      const body = await request.json().catch(() => {
        throw new ValidationError('body must be JSON');
      });
      const patch = parsePatch(body);
      if (patch.siteKey !== undefined) throw new ValidationError('siteKey can only be set through MCP');
      const task = await store.update(id, patch);
      if (!task) return json({ error: 'no such task' }, 404);
      await store.logEvent({ taskId: id, title: task.title, source: sourceOf(request), change: JSON.stringify(body) });
      if (patch.done !== undefined) await reconcile(store, [task], sync); // mirror the tick to the site
      return json(apiView(task));
    }
    if (request.method === 'DELETE') {
      return (await store.remove(id)) ? json({ deleted: id }) : json({ error: 'no such task' }, 404);
    }
    return json({ error: 'method not allowed' }, 405);
  } catch (err) {
    if (err instanceof ValidationError) return json({ error: err.message }, 400);
    console.error('request failed', err);
    return json({ error: 'internal error' }, 500);
  }
}

/** Where a REST change came from: the website sends an Origin header, the phone app's HTTP client says Dart. */
export function sourceOf(request: Request): string {
  const origin = request.headers.get('Origin');
  if (origin) return `website (${origin.replace(/^https?:\/\//, '')})`;
  const ua = request.headers.get('User-Agent') ?? '';
  if (/dart/i.test(ua)) return 'phone app';
  return ua ? `other (${ua.slice(0, 40)})` : 'unknown';
}

function syncFromEnv(env: Env): SyncConfig | undefined {
  if (!env.FIREBASE_STATE_URL) return undefined;
  const resets = parseResets(env.SYNC_RESET_BEFORE);
  return { site: new FirebaseSite(env.FIREBASE_STATE_URL, 5000, resets), prefixes: parsePrefixes(env.SYNC_PREFIXES), resets };
}

export default {
  fetch: (request: Request, env: Env) =>
    handleRequest(request, env, new D1TaskStore(env.DB), undefined, syncFromEnv(env)),
};
