import {
  normalizeTitle,
  type DayInfo,
  type NewTask,
  type Plan,
  type Task,
  type TaskPatch,
  type TaskStore,
} from '../src/tasks';

/** In-memory TaskStore mirroring D1TaskStore's behaviour, for tests. */
export class MemoryTaskStore implements TaskStore {
  private tasks: Task[] = [];
  private seq = 0;
  private info = new Map<string, DayInfo>();
  /** Tests can pin the clock that stamps check-offs. */
  clock: () => number = () => Date.now();

  async list(date: string): Promise<Task[]> {
    return this.tasks
      .filter((t) => t.date === date)
      .sort((a, b) => {
        if (a.plan !== b.plan) return a.plan < b.plan ? -1 : 1;
        if ((a.start === null) !== (b.start === null)) return a.start === null ? 1 : -1;
        if (a.start !== b.start) return (a.start ?? '') < (b.start ?? '') ? -1 : 1;
        return a.position - b.position;
      });
  }

  async listRange(from: string, to: string): Promise<Task[]> {
    const dates = [...new Set(this.tasks.map((t) => t.date))]
      .filter((d) => d >= from && d <= to)
      .sort();
    const days = await Promise.all(dates.map((d) => this.list(d)));
    return days.flat();
  }

  async add(date: string, plan: Plan, task: NewTask): Promise<Task> {
    const position = this.tasks.filter((t) => t.date === date && t.plan === plan).length;
    return this.insert(date, plan, task, position, false, null);
  }

  async replaceDay(date: string, plan: Plan, tasks: NewTask[]): Promise<Task[]> {
    const mine = (await this.list(date)).filter((t) => t.plan === plan);
    const previous = new Map(mine.map((t) => [normalizeTitle(t.title), t]));
    this.tasks = this.tasks.filter((t) => !(t.date === date && t.plan === plan));
    tasks.forEach((t, i) => {
      const old = previous.get(normalizeTitle(t.title));
      this.insert(date, plan, t, i, old?.done === true, old?.doneAt ?? null);
    });
    return (await this.list(date)).filter((t) => t.plan === plan);
  }

  async update(id: string, patch: TaskPatch): Promise<Task | null> {
    const task = this.tasks.find((t) => t.id === id);
    if (!task) return null;
    if (patch.title !== undefined) task.title = patch.title;
    if (patch.tag !== undefined) task.tag = patch.tag;
    if (patch.start !== undefined) task.start = patch.start;
    if (patch.minutes !== undefined) task.minutes = patch.minutes;
    if (patch.notes !== undefined) task.notes = patch.notes;
    if (patch.siteKey !== undefined) task.siteKey = patch.siteKey;
    if (patch.done !== undefined) {
      task.done = patch.done;
      task.doneAt = this.clock();
      task.completedAt = patch.done ? new Date(task.doneAt).toISOString() : null;
    }
    return task;
  }

  async remove(id: string): Promise<boolean> {
    const before = this.tasks.length;
    this.tasks = this.tasks.filter((t) => t.id !== id);
    return this.tasks.length < before;
  }

  async setDoneFromSite(id: string, done: boolean, atMs: number): Promise<void> {
    const task = this.tasks.find((t) => t.id === id);
    if (!task) return;
    task.done = done;
    task.doneAt = atMs;
    task.completedAt = done ? new Date(atMs).toISOString() : null;
  }

  async getDayInfo(date: string): Promise<DayInfo> {
    return this.info.get(date) ?? { headline: null, sections: [] };
  }

  async setDayInfo(date: string, info: DayInfo): Promise<void> {
    if (info.headline === null && info.sections.length === 0) this.info.delete(date);
    else this.info.set(date, info);
  }

  private insert(
    date: string,
    plan: Plan,
    task: NewTask,
    position: number,
    done: boolean,
    doneAt: number | null,
  ): Task {
    const row: Task = {
      id: `t${++this.seq}`,
      date,
      plan,
      title: task.title,
      tag: task.tag,
      start: task.start,
      minutes: task.minutes,
      notes: task.notes,
      siteKey: task.siteKey,
      done,
      doneAt,
      position,
      createdAt: new Date().toISOString(),
      completedAt: done ? new Date(doneAt ?? this.clock()).toISOString() : null,
    };
    this.tasks.push(row);
    return row;
  }
}
