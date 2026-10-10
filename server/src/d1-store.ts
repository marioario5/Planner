import {
  normalizeTitle,
  type Commitment,
  type Experiment,
  type ExperimentMeasure,
  type ExperimentStatus,
  type CommitmentStatus,
  type UserNote,
  type UserNoteKind,
  type UserNoteStatus,
  type CommitmentWork,
  type DayInfo,
  type FrameworkLogEntry,
  type HabitNotes,
  type HabitVersion,
  type NewTask,
  type Plan,
  type Tag,
  type Task,
  type TaskPatch,
  type TaskStore,
} from './tasks';

interface Row {
  id: string;
  date: string;
  plan: string;
  commitment_id: string | null;
  title: string;
  tag: string;
  start_time: string | null;
  minutes: number | null;
  notes: string | null;
  site_key: string | null;
  done: number;
  done_at: number | null;
  position: number;
  created_at: string;
  completed_at: string | null;
  started_at: string | null;
  flagged_at: string | null;
}

function toTask(row: Row): Task {
  return {
    id: row.id,
    date: row.date,
    plan: row.plan as Plan,
    commitmentId: row.commitment_id,
    title: row.title,
    tag: row.tag as Tag,
    start: row.start_time,
    minutes: row.minutes,
    notes: row.notes,
    siteKey: row.site_key,
    done: row.done === 1,
    doneAt: row.done_at,
    position: row.position,
    createdAt: row.created_at,
    completedAt: row.completed_at,
    startedAt: row.started_at ?? null,
    flaggedAt: row.flagged_at ?? null,
  };
}

const newId = () => crypto.randomUUID().slice(0, 8);

const INSERT = `INSERT INTO tasks
  (id, date, plan, commitment_id, title, tag, start_time, minutes, notes, site_key, done, done_at, position, created_at, completed_at, started_at, flagged_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

export class D1TaskStore implements TaskStore {
  constructor(private readonly db: D1Database) {}

  async list(date: string): Promise<Task[]> {
    const { results } = await this.db
      .prepare(
        // Timed tasks in clock order, untimed last, then the order Claude listed them.
        `SELECT * FROM tasks WHERE date = ?
         ORDER BY plan, start_time IS NULL, start_time, position, created_at`,
      )
      .bind(date)
      .all<Row>();
    return results.map(toTask);
  }

  async listRange(from: string, to: string): Promise<Task[]> {
    const { results } = await this.db
      .prepare(
        `SELECT * FROM tasks WHERE date >= ? AND date <= ?
         ORDER BY date, plan, start_time IS NULL, start_time, position, created_at`,
      )
      .bind(from, to)
      .all<Row>();
    return results.map(toTask);
  }

  async add(date: string, plan: Plan, task: NewTask): Promise<Task> {
    const id = newId();
    const position = (
      await this.db
        .prepare('SELECT COALESCE(MAX(position), -1) + 1 AS next FROM tasks WHERE date = ? AND plan = ?')
        .bind(date, plan)
        .first<{ next: number }>()
    )?.next ?? 0;
    await this.db
      .prepare(INSERT)
      .bind(
        id,
        date,
        plan,
        task.commitment,
        task.title,
        task.tag,
        task.start,
        task.minutes,
        task.notes,
        task.siteKey,
        0,
        null,
        position,
        new Date().toISOString(),
        null,
        null,
        null,
      )
      .run();
    return (await this.get(id))!;
  }

  async replaceDay(date: string, plan: Plan, tasks: NewTask[]): Promise<Task[]> {
    // Carry check-offs across a re-publish by title, plus when they were toggled,
    // so the site sync can still tell which side changed last.
    const previous = new Map<string, Task>();
    for (const t of await this.list(date)) {
      if (t.plan === plan) previous.set(normalizeTitle(t.title), t);
    }

    const now = new Date().toISOString();
    const statements = [this.db.prepare('DELETE FROM tasks WHERE date = ? AND plan = ?').bind(date, plan)];
    tasks.forEach((task, position) => {
      const old = previous.get(normalizeTitle(task.title));
      const done = old?.done === true;
      statements.push(
        this.db
          .prepare(INSERT)
          .bind(
            newId(),
            date,
            plan,
            task.commitment,
            task.title,
            task.tag,
            task.start,
            task.minutes,
            task.notes,
            task.siteKey,
            done ? 1 : 0,
            old?.doneAt ?? null,
            position,
            now,
            done ? (old?.completedAt ?? now) : null,
            old?.startedAt ?? null,
            old?.flaggedAt ?? null,
          ),
      );
    });
    await this.db.batch(statements); // one transaction: no half-replaced day
    return (await this.list(date)).filter((t) => t.plan === plan);
  }

  async update(id: string, patch: TaskPatch): Promise<Task | null> {
    const sets: string[] = [];
    const values: unknown[] = [];
    if (patch.title !== undefined) {
      sets.push('title = ?');
      values.push(patch.title);
    }
    if (patch.tag !== undefined) {
      sets.push('tag = ?');
      values.push(patch.tag);
    }
    if (patch.start !== undefined) {
      sets.push('start_time = ?');
      values.push(patch.start);
    }
    if (patch.minutes !== undefined) {
      sets.push('minutes = ?');
      values.push(patch.minutes);
    }
    if (patch.notes !== undefined) {
      sets.push('notes = ?');
      values.push(patch.notes);
    }
    if (patch.siteKey !== undefined) {
      sets.push('site_key = ?');
      values.push(patch.siteKey);
    }
    if (patch.done !== undefined) {
      sets.push('done = ?', 'completed_at = ?', 'done_at = ?');
      values.push(patch.done ? 1 : 0, patch.done ? patch.restoreCompleted ?? new Date().toISOString() : null, Date.now());
      if (patch.done && patch.restoreStarted) {
        sets.push('started_at = ?');
        values.push(patch.restoreStarted);
      }
      // Unticking starts the task over: forget the Start press (unless the same patch sets one).
      if (!patch.done && patch.started === undefined) sets.push('started_at = NULL');
    }
    if (patch.started !== undefined) {
      // Keep the first press: starting twice does not move the start.
      if (patch.started) {
        sets.push('started_at = COALESCE(started_at, ?)');
        values.push(new Date().toISOString());
      } else {
        sets.push('started_at = NULL');
      }
    }
    if (patch.flagged !== undefined) {
      if (patch.flagged) {
        sets.push('flagged_at = COALESCE(flagged_at, ?)');
        values.push(new Date().toISOString());
      } else {
        sets.push('flagged_at = NULL');
      }
    }
    if (sets.length === 0) return this.get(id);

    const result = await this.db
      .prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ?`)
      .bind(...values, id)
      .run();
    if (result.meta.changes === 0) return null;
    return this.get(id);
  }

  async remove(id: string): Promise<boolean> {
    const result = await this.db.prepare('DELETE FROM tasks WHERE id = ?').bind(id).run();
    return result.meta.changes > 0;
  }

  async setDoneFromSite(id: string, done: boolean, atMs: number): Promise<void> {
    await this.db
      .prepare(`UPDATE tasks SET done = ?, done_at = ?, completed_at = ?${done ? '' : ', started_at = NULL'} WHERE id = ?`)
      .bind(done ? 1 : 0, atMs, done ? new Date(atMs).toISOString() : null, id)
      .run();
  }

  async listUserNotes(): Promise<UserNote[]> {
    const { results } = await this.db
      .prepare('SELECT id, kind, text, quote, noted_on, confirmed_on, status, updated_at FROM user_notes ORDER BY kind, noted_on, id')
      .all<{
        id: string; kind: string; text: string; quote: string | null; noted_on: string;
        confirmed_on: string; status: string; updated_at: string;
      }>();
    return results.map((r) => ({
      id: r.id,
      kind: r.kind as UserNoteKind,
      text: r.text,
      quote: r.quote,
      notedOn: r.noted_on,
      confirmedOn: r.confirmed_on,
      status: r.status as UserNoteStatus,
      updatedAt: r.updated_at,
    }));
  }

  async saveUserNote(n: UserNote): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO user_notes (id, kind, text, quote, noted_on, confirmed_on, status, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           kind = excluded.kind, text = excluded.text, quote = excluded.quote, confirmed_on = excluded.confirmed_on,
           status = excluded.status, updated_at = excluded.updated_at`,
      )
      .bind(n.id, n.kind, n.text, n.quote, n.notedOn, n.confirmedOn, n.status, n.updatedAt)
      .run();
  }

  async deleteUserNote(id: string): Promise<boolean> {
    const result = await this.db.prepare('DELETE FROM user_notes WHERE id = ?').bind(id).run();
    return result.meta.changes > 0;
  }

  async listCommitments(): Promise<Commitment[]> {
    const { results } = await this.db
      .prepare('SELECT * FROM commitments ORDER BY due IS NULL, due, id')
      .all<{
        id: string; title: string; due: string | null; start_date: string | null; target_minutes: number | null;
        status: string; note: string | null; defer_until: string | null; defer_reason: string | null;
        created_on: string; updated_at: string;
      }>();
    return results.map((r) => ({
      id: r.id,
      title: r.title,
      due: r.due,
      start: r.start_date,
      targetMinutes: r.target_minutes,
      status: r.status as CommitmentStatus,
      note: r.note,
      deferUntil: r.defer_until,
      deferReason: r.defer_reason,
      createdOn: r.created_on,
      updatedAt: r.updated_at,
    }));
  }

  async saveCommitment(c: Commitment): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO commitments
           (id, title, due, start_date, target_minutes, status, note, defer_until, defer_reason, created_on, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           title = excluded.title, due = excluded.due, start_date = excluded.start_date,
           target_minutes = excluded.target_minutes, status = excluded.status, note = excluded.note,
           defer_until = excluded.defer_until, defer_reason = excluded.defer_reason, updated_at = excluded.updated_at`,
      )
      .bind(c.id, c.title, c.due, c.start, c.targetMinutes, c.status, c.note, c.deferUntil, c.deferReason, c.createdOn, c.updatedAt)
      .run();
  }

  async commitmentWork(): Promise<CommitmentWork[]> {
    const { results } = await this.db
      .prepare('SELECT commitment_id, date, minutes, done FROM tasks WHERE commitment_id IS NOT NULL')
      .all<{ commitment_id: string; date: string; minutes: number | null; done: number }>();
    return results.map((r) => ({ commitmentId: r.commitment_id, date: r.date, minutes: r.minutes, done: r.done === 1 }));
  }

  async addFrameworkLog(entry: FrameworkLogEntry): Promise<void> {
    await this.db
      .prepare('INSERT INTO framework_log (on_date, commitment_id, action, detail) VALUES (?, ?, ?, ?)')
      .bind(entry.onDate, entry.commitmentId, entry.action, entry.detail)
      .run();
    // Keep the log small: the newest 200 entries.
    await this.db
      .prepare('DELETE FROM framework_log WHERE id NOT IN (SELECT id FROM framework_log ORDER BY id DESC LIMIT 200)')
      .run();
  }

  async listFrameworkLog(limit: number): Promise<FrameworkLogEntry[]> {
    const { results } = await this.db
      .prepare('SELECT on_date, commitment_id, action, detail FROM framework_log ORDER BY id DESC LIMIT ?')
      .bind(limit)
      .all<{ on_date: string; commitment_id: string | null; action: string; detail: string }>();
    return results.map((r) => ({
      onDate: r.on_date,
      commitmentId: r.commitment_id,
      action: r.action as FrameworkLogEntry['action'],
      detail: r.detail,
    }));
  }

  async getMeta(key: string): Promise<string | null> {
    const row = await this.db.prepare('SELECT value FROM framework_meta WHERE key = ?').bind(key).first<{ value: string }>();
    return row?.value ?? null;
  }

  async setMeta(key: string, value: string): Promise<void> {
    await this.db
      .prepare('INSERT INTO framework_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .bind(key, value)
      .run();
  }

  async saveHabitNotes(text: string): Promise<HabitNotes> {
    const updatedAt = new Date().toISOString();
    const result = await this.db
      .prepare('INSERT INTO habit_notes (notes, created_at) VALUES (?, ?)')
      .bind(text, updatedAt)
      .run();
    // Keep only the newest 10 versions.
    await this.db
      .prepare('DELETE FROM habit_notes WHERE id NOT IN (SELECT id FROM habit_notes ORDER BY id DESC LIMIT 10)')
      .run();
    return { version: Number(result.meta.last_row_id), text, updatedAt };
  }

  async getHabitNotes(version?: number): Promise<HabitNotes | null> {
    const row = await (version === undefined
      ? this.db.prepare('SELECT id, notes, created_at FROM habit_notes ORDER BY id DESC LIMIT 1')
      : this.db.prepare('SELECT id, notes, created_at FROM habit_notes WHERE id = ?').bind(version)
    ).first<{ id: number; notes: string; created_at: string }>();
    return row ? { version: row.id, text: row.notes, updatedAt: row.created_at } : null;
  }

  async listHabitVersions(): Promise<HabitVersion[]> {
    const { results } = await this.db
      .prepare('SELECT id, created_at, LENGTH(notes) AS chars FROM habit_notes ORDER BY id DESC')
      .all<{ id: number; created_at: string; chars: number }>();
    return results.map((r) => ({ version: r.id, updatedAt: r.created_at, chars: r.chars }));
  }

  async getRating(date: string): Promise<number | null> {
    const row = await this.db.prepare('SELECT rating FROM day_ratings WHERE date = ?').bind(date).first<{ rating: number }>();
    return row?.rating ?? null;
  }

  async setRating(date: string, rating: number | null): Promise<void> {
    if (rating === null) {
      await this.db.prepare('DELETE FROM day_ratings WHERE date = ?').bind(date).run();
      return;
    }
    await this.db
      .prepare(
        `INSERT INTO day_ratings (date, rating, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(date) DO UPDATE SET rating = excluded.rating, updated_at = excluded.updated_at`,
      )
      .bind(date, rating, new Date().toISOString())
      .run();
  }

  async listRatings(from: string, to: string): Promise<Map<string, number>> {
    const { results } = await this.db
      .prepare('SELECT date, rating FROM day_ratings WHERE date >= ? AND date <= ?')
      .bind(from, to)
      .all<{ date: string; rating: number }>();
    return new Map(results.map((r) => [r.date, r.rating]));
  }

  async listExperiments(): Promise<Experiment[]> {
    const { results } = await this.db
      .prepare('SELECT * FROM experiments ORDER BY started_on DESC, id')
      .all<{
        id: string; title: string; change: string; measure: string; tag: string | null; started_on: string;
        status: string; result: string | null; updated_at: string;
      }>();
    return results.map((r) => ({
      id: r.id,
      title: r.title,
      change: r.change,
      measure: r.measure as ExperimentMeasure,
      tag: r.tag as Tag | null,
      startedOn: r.started_on,
      status: r.status as ExperimentStatus,
      result: r.result,
      updatedAt: r.updated_at,
    }));
  }

  async saveExperiment(e: Experiment): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO experiments (id, title, change, measure, tag, started_on, status, result, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           title = excluded.title, change = excluded.change, measure = excluded.measure, tag = excluded.tag,
           started_on = excluded.started_on, status = excluded.status, result = excluded.result,
           updated_at = excluded.updated_at`,
      )
      .bind(e.id, e.title, e.change, e.measure, e.tag, e.startedOn, e.status, e.result, e.updatedAt)
      .run();
  }

  async deleteExperiment(id: string): Promise<boolean> {
    const result = await this.db.prepare('DELETE FROM experiments WHERE id = ?').bind(id).run();
    return result.meta.changes > 0;
  }

  async getDayInfo(date: string): Promise<DayInfo> {
    const row = await this.db
      .prepare('SELECT headline, sections FROM day_info WHERE date = ?')
      .bind(date)
      .first<{ headline: string | null; sections: string }>();
    if (!row) return { headline: null, sections: [] };
    let sections: DayInfo['sections'] = [];
    try {
      const parsed = JSON.parse(row.sections);
      if (Array.isArray(parsed)) sections = parsed;
    } catch {
      // A corrupt row shouldn't take the whole day down; show the tasks without info.
    }
    return { headline: row.headline, sections };
  }

  async setDayInfo(date: string, info: DayInfo): Promise<void> {
    if (info.headline === null && info.sections.length === 0) {
      await this.db.prepare('DELETE FROM day_info WHERE date = ?').bind(date).run();
      return;
    }
    await this.db
      .prepare(
        `INSERT INTO day_info (date, headline, sections, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(date) DO UPDATE SET
           headline = excluded.headline, sections = excluded.sections, updated_at = excluded.updated_at`,
      )
      .bind(date, info.headline, JSON.stringify(info.sections), new Date().toISOString())
      .run();
  }

  async setCompletedAt(id: string, atMs: number): Promise<void> {
    await this.db
      .prepare('UPDATE tasks SET completed_at = ? WHERE id = ? AND done = 1')
      .bind(new Date(atMs).toISOString(), id)
      .run();
  }

  async get(id: string): Promise<Task | null> {
    const row = await this.db.prepare('SELECT * FROM tasks WHERE id = ?').bind(id).first<Row>();
    return row ? toTask(row) : null;
  }
}
