import {
  normalizeTitle,
  type DayInfo,
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
}

function toTask(row: Row): Task {
  return {
    id: row.id,
    date: row.date,
    plan: row.plan as Plan,
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
  };
}

const newId = () => crypto.randomUUID().slice(0, 8);

const INSERT = `INSERT INTO tasks
  (id, date, plan, title, tag, start_time, minutes, notes, site_key, done, done_at, position, created_at, completed_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

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
      values.push(patch.done ? 1 : 0, patch.done ? new Date().toISOString() : null, Date.now());
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
      .prepare('UPDATE tasks SET done = ?, done_at = ?, completed_at = ? WHERE id = ?')
      .bind(done ? 1 : 0, atMs, done ? new Date(atMs).toISOString() : null, id)
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
