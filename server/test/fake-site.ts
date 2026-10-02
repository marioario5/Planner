import { parseEntries, type SiteClient, type SiteSnapshot } from '../src/firebase';

/** In-memory stand-in for the site's Firebase node, with ETag-conditional writes like the real one. */
export class FakeSite implements SiteClient {
  state: Record<string, unknown>;
  private version = 1;
  reads = 0;
  writes = 0;
  /** Make every read fail, as if Firebase were unreachable. */
  down = false;
  /** Runs once, between a read and the next write: simulates the site editing at the same moment. */
  beforeWrite: (() => void) | null = null;
  /** Keep conflicting on every write. */
  alwaysConflict = false;

  constructor(initial: Record<string, unknown>) {
    this.state = structuredClone(initial);
  }

  async read(): Promise<SiteSnapshot> {
    this.reads++;
    if (this.down) throw new Error('firebase unreachable');
    const state = structuredClone(this.state);
    return { etag: `v${this.version}`, state, entries: parseEntries(state) };
  }

  async write(state: Record<string, unknown>, etag: string | null): Promise<boolean> {
    if (this.beforeWrite) {
      const hook = this.beforeWrite;
      this.beforeWrite = null;
      hook();
    }
    if (this.alwaysConflict) this.version++;
    if (etag !== `v${this.version}`) return false;
    this.writes++;
    this.state = structuredClone(state);
    this.version++;
    return true;
  }

  /** The website ticking/unticking a box: same triple format the real site writes. */
  siteSets(key: string, v: boolean, t: number): void {
    const rows = (this.state.tasks as unknown[][]).map((r) => [...r]);
    const i = rows.findIndex((r) => r[0] === key);
    const row = [key, v ? 1 : 0, t];
    if (i >= 0) rows[i] = row;
    else rows.push(row);
    this.state = { ...this.state, tasks: rows };
    this.version++;
  }

  entry(key: string): [string, number, number] | undefined {
    return (this.state.tasks as [string, number, number][]).find((r) => r[0] === key);
  }
}
