import { bearerMatches, tokenConfigured, tokenMatches } from './auth';
import { D1TaskStore } from './d1-store';
import { resolveDate } from './dates';
import { FirebaseSite } from './firebase';
import { handleMcpPost } from './mcp';
import { parsePrefixes, reconcile, type SyncConfig } from './sync';
import { ValidationError, parsePatch, type Task, type TaskStore } from './tasks';

export interface Env {
  DB: D1Database;
  /** Shared secret. Set with `wrangler secret put API_TOKEN`. */
  API_TOKEN: string;
  PLANNER_TZ?: string;
  /** The progress site's Firebase state URL. Set with `wrangler secret put FIREBASE_STATE_URL`; unset = no site sync. */
  FIREBASE_STATE_URL?: string;
  /** Comma-separated site task id prefixes to mirror. Default `calc3-`. */
  SYNC_PREFIXES?: string;
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
  position: t.position,
});

/**
 * Routes:
 *   POST   /mcp            MCP endpoint (Authorization: Bearer <token>)
 *   POST   /mcp/<token>    MCP endpoint for clients that can't send headers (claude.ai connectors)
 *   GET    /api/tasks?date=YYYY-MM-DD
 *   PATCH  /api/tasks/:id  {done?, title?, tag?, start?, minutes?, notes?}
 *   DELETE /api/tasks/:id
 */
export async function handleRequest(
  request: Request,
  env: Pick<Env, 'API_TOKEN' | 'PLANNER_TZ'>,
  store: TaskStore,
  now?: Date,
  sync?: SyncConfig,
): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, '') || '/';
  const timeZone = env.PLANNER_TZ || DEFAULT_TZ;

  if (path === '/') return new Response('cozy-planner ok\n');

  const isMcp = path === '/mcp' || path.startsWith('/mcp/');
  const isApi = path === '/api/tasks' || path.startsWith('/api/tasks/');
  if (!isMcp && !isApi) return json({ error: 'not found' }, 404);

  if (!tokenConfigured(env.API_TOKEN)) {
    return json({ error: 'server is missing a valid API_TOKEN secret' }, 500);
  }

  try {
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

    if (!(await bearerMatches(request, env.API_TOKEN))) return unauthorized();

    if (path === '/api/tasks') {
      if (request.method !== 'GET') return json({ error: 'method not allowed' }, 405);
      const date = resolveDate(url.searchParams.get('date'), timeZone, now);
      const [tasks, info] = await Promise.all([store.list(date), store.getDayInfo(date)]);
      await reconcile(store, tasks, sync); // pull in anything he ticked on the site
      return json({
        date,
        headline: info.headline,
        sections: info.sections,
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

function syncFromEnv(env: Env): SyncConfig | undefined {
  if (!env.FIREBASE_STATE_URL) return undefined;
  return { site: new FirebaseSite(env.FIREBASE_STATE_URL), prefixes: parsePrefixes(env.SYNC_PREFIXES) };
}

export default {
  fetch: (request: Request, env: Env) =>
    handleRequest(request, env, new D1TaskStore(env.DB), undefined, syncFromEnv(env)),
};
