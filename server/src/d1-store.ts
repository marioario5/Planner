import {
  normalizeTitle,
  type DayInfo,
  type NewTask,
  type Tag,
  type Task,
  type TaskPatch,
  type TaskStore,
} from './tasks';

interface Row {
  id: string;
  date: string;
  title: string;
  tag: string;
  start_time: string | null;
  minutes: number | null;
  notes: string | null;
  done: number;
  position: number;
  created_at: string;
  completed_at: string | null;
}

function toTask(row: Row): Task {
  return {
    id: row.id,
    date: row.date,
    title: row.title,
    tag: row.tag as Tag,
    start: row.start_time,
    minutes: row.minutes,
    notes: row.notes,
    done: row.done === 1,
    position: row.position,
    createdAt: row.created_at,
    completedAt: row.completed_at,
  };
}

const newId = () => crypto.randomUUID().slice(0, 8);

export class D1TaskStore implements TaskStore {
  constructor(private readonly db: D1Database) {}

  async list(date: string): Promise<Task[]> {
    const { results } = await this.db
      .prepare(
        // Timed tasks in clock order, untimed last, then the order Claude listed them.
        `SELECT * FROM tasks WHERE date = ?
         ORDER BY start_time IS NULL, start_time, position, created_at`,
      )
      .bind(date)
      .all<Row>();
    return results.map(toTask);
  }

  async add(date: string, task: NewTask): Promise<Task> {
    const id = newId();
    await this.db
      .prepare(
        `INSERT INTO tasks (id, date, title, tag, start_time, minutes, notes, done, position, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0,
                 (SELECT COALESCE(MAX(position), -1) + 1 FROM tasks WHERE date = ?), ?)`,
      )
      .bind(
        id,
        date,
        task.title,
        task.tag,
        task.start,
        task.minutes,
        task.notes,
        date,
        new Date().toISOString(),
      )
      .run();
    return (await this.get(id))!;
  }

  async replaceDay(date: string, tasks: NewTask[]): Promise<Task[]> {
    const existing = await this.list(date);
    const doneAt = new Map<string, string | null>();
    for (const t of existing) {
      if (t.done) doneAt.set(normalizeTitle(t.title), t.completedAt);
    }

    const now = new Date().toISOString();
    const statements = [this.db.prepare('DELETE FROM tasks WHERE date = ?').bind(date)];
    tasks.forEach((task, position) => {
      const key = normalizeTitle(task.title);
      const wasDone = doneAt.has(key);
      statements.push(
        this.db
          .prepare(
            `INSERT INTO tasks (id, date, title, tag, start_time, minutes, notes, done, position, created_at, completed_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            newId(),
            date,
            task.title,
            task.tag,
            task.start,
            task.minutes,
            task.notes,
            wasDone ? 1 : 0,
            position,
            now,
            wasDone ? (doneAt.get(key) ?? now) : null,
          ),
      );
    });
    await this.db.batch(statements); // one transaction: no half-replaced day
    return this.list(date);
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
    if (patch.done !== undefined) {
      sets.push('done = ?', 'completed_at = ?');
      values.push(patch.done ? 1 : 0, patch.done ? new Date().toISOString() : null);
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

  private async get(id: string): Promise<Task | null> {
    const row = await this.db.prepare('SELECT * FROM tasks WHERE id = ?').bind(id).first<Row>();
    return row ? toTask(row) : null;
  }
}
