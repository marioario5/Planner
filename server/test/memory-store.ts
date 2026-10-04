import {
  normalizeTitle,
  type Commitment,
  type CommitmentWork,
  type UserNote,
  type DayInfo,
  type FrameworkLogEntry,
  type HabitNotes,
  type HabitVersion,
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
  private habits: HabitNotes[] = [];
  private habitSeq = 0;
  private commitments = new Map<string, Commitment>();
  private userNotes = new Map<string, UserNote>();
  private log: FrameworkLogEntry[] = [];
  private meta = new Map<string, string>();
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

  async get(id: string): Promise<Task | null> {
    return this.tasks.find((t) => t.id === id) ?? null;
  }

  async setCompletedAt(id: string, atMs: number): Promise<void> {
    const task = this.tasks.find((t) => t.id === id);
    if (task?.done) task.completedAt = new Date(atMs).toISOString();
  }

  async setDoneFromSite(id: string, done: boolean, atMs: number): Promise<void> {
    const task = this.tasks.find((t) => t.id === id);
    if (!task) return;
    task.done = done;
    task.doneAt = atMs;
    task.completedAt = done ? new Date(atMs).toISOString() : null;
  }

  async listUserNotes(): Promise<UserNote[]> {
    return [...this.userNotes.values()].sort((a, b) =>
      a.kind === b.kind ? (a.notedOn === b.notedOn ? (a.id < b.id ? -1 : 1) : a.notedOn < b.notedOn ? -1 : 1) : a.kind < b.kind ? -1 : 1,
    );
  }

  async saveUserNote(n: UserNote): Promise<void> {
    this.userNotes.set(n.id, { ...n });
  }

  async deleteUserNote(id: string): Promise<boolean> {
    return this.userNotes.delete(id);
  }

  async listCommitments(): Promise<Commitment[]> {
    const key = (c: Commitment) => c.due ?? '9999-99-99';
    return [...this.commitments.values()].sort((a, b) => (key(a) === key(b) ? (a.id < b.id ? -1 : 1) : key(a) < key(b) ? -1 : 1));
  }

  async saveCommitment(c: Commitment): Promise<void> {
    this.commitments.set(c.id, { ...c });
  }

  async commitmentWork(): Promise<CommitmentWork[]> {
    return this.tasks
      .filter((t) => t.commitmentId !== null)
      .map((t) => ({ commitmentId: t.commitmentId!, date: t.date, minutes: t.minutes, done: t.done }));
  }

  async addFrameworkLog(entry: FrameworkLogEntry): Promise<void> {
    this.log.unshift(entry);
  }

  async listFrameworkLog(limit: number): Promise<FrameworkLogEntry[]> {
    return this.log.slice(0, limit);
  }

  async getMeta(key: string): Promise<string | null> {
    return this.meta.get(key) ?? null;
  }

  async setMeta(key: string, value: string): Promise<void> {
    this.meta.set(key, value);
  }

  async saveHabitNotes(text: string): Promise<HabitNotes> {
    const saved = { version: ++this.habitSeq, text, updatedAt: new Date(this.clock()).toISOString() };
    this.habits = [saved, ...this.habits].slice(0, 10);
    return saved;
  }

  async getHabitNotes(version?: number): Promise<HabitNotes | null> {
    return (version === undefined ? this.habits[0] : this.habits.find((h) => h.version === version)) ?? null;
  }

  async listHabitVersions(): Promise<HabitVersion[]> {
    return this.habits.map((h) => ({ version: h.version, updatedAt: h.updatedAt, chars: h.text.length }));
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
      commitmentId: task.commitment,
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
