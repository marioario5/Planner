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
  /** `state.tasks` parsed into key -> latest value + timestamp. */
  entries: Map<string, SiteEntry>;
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
  ) {}

  async read(): Promise<SiteSnapshot> {
    const res = await fetch(this.url, {
      headers: { 'X-Firebase-ETag': 'true' },
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) throw new Error(`firebase read failed: HTTP ${res.status}`);
    const body = (await res.json()) as Record<string, unknown> | null;
    const state = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
    return { etag: res.headers.get('ETag'), state, entries: parseEntries(state) };
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
