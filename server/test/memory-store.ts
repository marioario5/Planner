import {
  normalizeTitle,
  type DayInfo,
  type NewTask,
  type Task,
  type TaskPatch,
  type TaskStore,
} from '../src/tasks';

/** In-memory TaskStore mirroring D1TaskStore's behaviour, for tests. */
export class MemoryTaskStore implements TaskStore {
  private tasks: Task[] = [];
  private seq = 0;
  private info = new Map<string, DayInfo>();

  async list(date: string): Promise<Task[]> {
    return this.tasks
      .filter((t) => t.date === date)
      .sort((a, b) => {
        if ((a.start === null) !== (b.start === null)) return a.start === null ? 1 : -1;
        if (a.start !== b.start) return (a.start ?? '') < (b.start ?? '') ? -1 : 1;
        return a.position - b.position;
      });
  }

  async add(date: string, task: NewTask): Promise<Task> {
    const position = this.tasks.filter((t) => t.date === date).length;
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
    if (patch.start !== undefined) task.start = patch.start;
    if (patch.minutes !== undefined) task.minutes = patch.minutes;
    if (patch.notes !== undefined) task.notes = patch.notes;
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

  async getDayInfo(date: string): Promise<DayInfo> {
    return this.info.get(date) ?? { headline: null, sections: [] };
  }

  async setDayInfo(date: string, info: DayInfo): Promise<void> {
    if (info.headline === null && info.sections.length === 0) this.info.delete(date);
    else this.info.set(date, info);
  }

  private insert(date: string, task: NewTask, position: number, done: boolean): Task {
    const row: Task = {
      id: `t${++this.seq}`,
      date,
      title: task.title,
      tag: task.tag,
      start: task.start,
      minutes: task.minutes,
      notes: task.notes,
      done,
      position,
      createdAt: new Date().toISOString(),
      completedAt: done ? new Date().toISOString() : null,
    };
    this.tasks.push(row);
    return row;
  }
}
