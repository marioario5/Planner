import {
  normalizeTitle,
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
      .prepare('SELECT * FROM tasks WHERE date = ? ORDER BY position, created_at')
      .bind(date)
      .all<Row>();
    return results.map(toTask);
  }

  async add(date: string, task: NewTask): Promise<Task> {
    const id = newId();
    await this.db
      .prepare(
        `INSERT INTO tasks (id, date, title, tag, done, position, created_at)
         VALUES (?, ?, ?, ?, 0,
                 (SELECT COALESCE(MAX(position), -1) + 1 FROM tasks WHERE date = ?), ?)`,
      )
      .bind(id, date, task.title, task.tag, date, new Date().toISOString())
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
            `INSERT INTO tasks (id, date, title, tag, done, position, created_at, completed_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            newId(),
            date,
            task.title,
            task.tag,
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

  private async get(id: string): Promise<Task | null> {
    const row = await this.db.prepare('SELECT * FROM tasks WHERE id = ?').bind(id).first<Row>();
    return row ? toTask(row) : null;
  }
}
