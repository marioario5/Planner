// Two-way mirror of check-offs between the planner and the progress site.
//
// A task opts in by carrying a `siteKey` (the site's task id, e.g. "calc3-t12").
// For each such task the newest change wins, the same rule the site uses between
// its own devices: the planner stamps every toggle (`doneAt`), the site stamps
// every entry, and whichever timestamp is strictly newer is applied to the other
// side. Unticking syncs too. Everything here is best effort: if the site can't be
// reached the planner keeps working, and the next reconcile catches up.

import { rowsOf, type SiteClient } from './firebase';
import type { Task, TaskStore } from './tasks';

export const DEFAULT_PREFIXES = ['calc3-'];

export interface SyncConfig {
  site: SiteClient;
  prefixes: string[];
}

export function parsePrefixes(value: string | undefined): string[] {
  const list = (value ?? '')
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);
  return list.length ? list : DEFAULT_PREFIXES;
}

export function isSyncable(siteKey: string | null, prefixes: string[]): siteKey is string {
  return siteKey !== null && prefixes.some((p) => siteKey.startsWith(p));
}

const MAX_ATTEMPTS = 3;

/**
 * Brings the given tasks and the site into agreement. Mutates `tasks` in place so
 * callers can return them straight away. Never throws.
 */
export async function reconcile(
  store: TaskStore,
  tasks: Task[],
  sync: SyncConfig | undefined,
  nowMs: number = Date.now(),
): Promise<void> {
  if (!sync) return;
  const byKey = new Map<string, Task[]>();
  for (const t of tasks) {
    if (isSyncable(t.siteKey, sync.prefixes)) byKey.set(t.siteKey, [...(byKey.get(t.siteKey) ?? []), t]);
  }
  if (byKey.size === 0) return;

  try {
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const snap = await sync.site.read();
      const pushes = new Map<string, { v: boolean; t: number }>();

      for (const [key, group] of byKey) {
        const site = snap.entries.get(key);
        const freshest = group.reduce((a, b) => ((b.doneAt ?? 0) > (a.doneAt ?? 0) ? b : a));
        const localT = freshest.doneAt ?? 0;

        if (site && site.t > localT) {
          await applyToAll(store, group, site.v, site.t); // the site changed last
        } else if (localT > (site?.t ?? 0)) {
          // The planner changed last. Only write if it actually disagrees with the site.
          if ((site ? site.v : false) !== freshest.done) pushes.set(key, { v: freshest.done, t: localT });
          await applyToAll(store, group, freshest.done, localT); // keep duplicates of one key aligned
        }
      }

      if (pushes.size === 0) return;

      const rows = rowsOf(snap.state.tasks).map((r) => (Array.isArray(r) ? [...r] : r));
      for (const [key, { v, t }] of pushes) {
        const next = [key, v ? 1 : 0, t];
        const i = rows.findIndex((r) => Array.isArray(r) && r[0] === key);
        if (i >= 0) rows[i] = next;
        else rows.push(next);
      }
      const written = await sync.site.write({ ...snap.state, tasks: rows, at: nowMs }, snap.etag);
      if (written) return;
      // The site wrote while we were working: re-read and recompute against its newest state.
    }
    console.error('site sync gave up after repeated write conflicts; will retry next time');
  } catch (err) {
    console.error('site sync failed; continuing without it', err);
  }
}

async function applyToAll(store: TaskStore, group: Task[], done: boolean, atMs: number): Promise<void> {
  for (const t of group) {
    if (t.done === done && t.doneAt === atMs) continue;
    await store.setDoneFromSite(t.id, done, atMs);
    t.done = done;
    t.doneAt = atMs;
    t.completedAt = done ? new Date(atMs).toISOString() : null;
  }
}
