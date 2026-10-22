// Client for the progress site's Firebase state (a single JSON node).
//
// The site stores check-offs as [key, 0|1, epochMs] triples in `tasks` and merges
// them per key, newest timestamp wins, so writing the same triples makes this
// server behave like one more device. Every write is conditional on an ETag, so
// it can never overwrite an edit the site made in between.

export interface SiteEntry {
  v: boolean;
  t: number;
}

export interface SiteSnapshot {
  etag: string | null;
  /** The whole state node, untouched, so unknown keys survive a write-back. */
  state: Record<string, unknown>;
  /** `state.tasks` parsed into key -> latest value + timestamp, without entries that predate a reset (see SiteReset). */
  entries: Map<string, SiteEntry>;
  /** How many entries were dropped because they predate a reset. */
  ignored?: number;
}

/**
 * The site's plan was rewritten at `ms` (its STATE_RESETS token): entries under `prefix` stamped before that describe the OLD plan
 * (the same task ids now mean other lessons), so they must never count as done. The site clears them itself the next time it is
 * opened; until then this keeps a stale check mark from marking today's lesson done.
 */
export interface SiteReset {
  prefix: string;
  ms: number;
}

/** "calc3-:1792347017018,other-:123" -> resets. Bad pieces are ignored. */
export function parseResets(value: string | undefined): SiteReset[] {
  return (value ?? '')
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => {
      const i = p.lastIndexOf(':');
      return { prefix: p.slice(0, i), ms: Number(p.slice(i + 1)) };
    })
    .filter((r) => r.prefix !== '' && Number.isFinite(r.ms) && r.ms > 0);
}

export interface SiteClient {
  read(): Promise<SiteSnapshot>;
  /** Writes the whole state only if it is unchanged since `etag`. false = someone else wrote first. */
  write(state: Record<string, unknown>, etag: string | null): Promise<boolean>;
}

/** Firebase hands back arrays as arrays, or as {"0":..,"1":..} objects when they're sparse. */
export function rowsOf(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object') return Object.values(value as Record<string, unknown>);
  return [];
}

export function parseEntries(state: Record<string, unknown>): Map<string, SiteEntry> {
  const entries = new Map<string, SiteEntry>();
  for (const row of rowsOf(state.tasks)) {
    if (Array.isArray(row) && typeof row[0] === 'string') {
      entries.set(row[0], { v: row[1] === 1 || row[1] === true, t: Number(row[2]) || 0 });
    }
  }
  return entries;
}

export class FirebaseSite implements SiteClient {
  constructor(
    private readonly url: string,
    private readonly timeoutMs = 5000,
    readonly resets: SiteReset[] = [],
    /** More resets, looked up on every read (the site's own STATE_RESETS, so nobody has to keep a number up to date). A failure is ignored. */
    private readonly moreResets?: () => Promise<SiteReset[]>,
  ) {}

  async read(): Promise<SiteSnapshot> {
    const res = await fetch(this.url, {
      headers: { 'X-Firebase-ETag': 'true' },
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) throw new Error(`firebase read failed: HTTP ${res.status}`);
    const body = (await res.json()) as Record<string, unknown> | null;
    const state = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
    const all = parseEntries(state);
    const entries = new Map<string, SiteEntry>();
    let ignored = 0;
    let resets = this.resets;
    if (this.moreResets) {
      try {
        resets = [...resets, ...(await this.moreResets())];
      } catch {
        // keep the fixed ones
      }
    }
    for (const [key, e] of all) {
      if (resets.some((r) => key.startsWith(r.prefix) && e.t < r.ms)) ignored++;
      else entries.set(key, e);
    }
    return { etag: res.headers.get('ETag'), state, entries, ignored };
  }

  async write(state: Record<string, unknown>, etag: string | null): Promise<boolean> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (etag) headers['if-match'] = etag;
    const res = await fetch(this.url, {
      method: 'PUT',
      headers,
      body: JSON.stringify(state),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (res.status === 412) return false;
    if (!res.ok) throw new Error(`firebase write failed: HTTP ${res.status}`);
    return true;
  }
}
