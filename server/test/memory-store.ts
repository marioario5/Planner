import {
  normalizeTitle,
  type NewTask,
  type Task,
  type TaskPatch,
  type TaskStore,
} from '../src/tasks';

/** In-memory TaskStore mirroring D1TaskStore's behaviour, for tests. */
export class MemoryTaskStore implements TaskStore {
  private tasks: Task[] = [];
  private seq = 0;

  async list(date: string): Promise<Task[]> {
    return this.tasks.filter((t) => t.date === date).sort((a, b) => a.position - b.position);
  }

  async add(date: string, task: NewTask): Promise<Task> {
    const position = (await this.list(date)).length;
    return this.insert(date, task, position, false);
  }

  async replaceDay(date: string, tasks: NewTask[]): Promise<Task[]> {
    const done = new Set((await this.list(date)).filter((t) => t.done).map((t) => normalizeTitle(t.title)));
    this.tasks = this.tasks.filter((t) => t.date !== date);
    tasks.forEach((t, i) => this.insert(date, t, i, done.has(normalizeTitle(t.title))));
    return this.list(date);
  }

  async update(id: string, patch: TaskPatch): Promise<Task | null> {
    const task = this.tasks.find((t) => t.id === id);
    if (!task) return null;
    if (patch.title !== undefined) task.title = patch.title;
    if (patch.tag !== undefined) task.tag = patch.tag;
    if (patch.done !== undefined) {
      task.done = patch.done;
      task.completedAt = patch.done ? new Date().toISOString() : null;
    }
    return task;
  }

  async remove(id: string): Promise<boolean> {
    const before = this.tasks.length;
    this.tasks = this.tasks.filter((t) => t.id !== id);
    return this.tasks.length < before;
  }

  private insert(date: string, task: NewTask, position: number, done: boolean): Task {
    const row: Task = {
      id: `t${++this.seq}`,
      date,
      title: task.title,
      tag: task.tag,
      done,
      position,
      createdAt: new Date().toISOString(),
      completedAt: done ? new Date().toISOString() : null,
    };
    this.tasks.push(row);
    return row;
  }
}
