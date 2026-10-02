// Task types, input validation, and the storage interface.
// Validation lives here so the REST routes and the MCP tools reject the same things.

export const TAGS = ['school', 'calculus3', 'sat', 'pcb', 'photography'] as const;
export type Tag = (typeof TAGS)[number];

export interface Task {
  id: string;
  date: string; // planner day, YYYY-MM-DD
  title: string;
  tag: Tag;
  done: boolean;
  position: number;
  createdAt: string;
  completedAt: string | null;
}

export interface NewTask {
  title: string;
  tag: Tag;
}

export interface TaskPatch {
  title?: string;
  tag?: Tag;
  done?: boolean;
}

export interface TaskStore {
  list(date: string): Promise<Task[]>;
  add(date: string, task: NewTask): Promise<Task>;
  /** Replaces a day's list. Tasks whose title matches one already done stay done. */
  replaceDay(date: string, tasks: NewTask[]): Promise<Task[]>;
  update(id: string, patch: TaskPatch): Promise<Task | null>;
  remove(id: string): Promise<boolean>;
}

export class ValidationError extends Error {}

const MAX_TITLE = 200;
const MAX_TASKS_PER_DAY = 100;

export function parseTitle(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ValidationError('title must be a non-empty string');
  }
  const title = value.trim();
  if (title.length > MAX_TITLE) {
    throw new ValidationError(`title must be at most ${MAX_TITLE} characters`);
  }
  return title;
}

export function parseTag(value: unknown): Tag {
  if (value === undefined || value === null) return 'school'; // fallback when Claude doesn't pick a tag
  if (typeof value === 'string' && (TAGS as readonly string[]).includes(value)) {
    return value as Tag;
  }
  throw new ValidationError(`tag must be one of: ${TAGS.join(', ')}`);
}

export function parseNewTask(value: unknown): NewTask {
  if (typeof value !== 'object' || value === null) {
    throw new ValidationError('each task must be an object with a title');
  }
  const { title, tag } = value as Record<string, unknown>;
  return { title: parseTitle(title), tag: parseTag(tag) };
}

export function parseNewTasks(value: unknown): NewTask[] {
  if (!Array.isArray(value)) throw new ValidationError('tasks must be an array');
  if (value.length > MAX_TASKS_PER_DAY) {
    throw new ValidationError(`at most ${MAX_TASKS_PER_DAY} tasks per day`);
  }
  return value.map(parseNewTask);
}

export function parsePatch(value: unknown): TaskPatch {
  if (typeof value !== 'object' || value === null) {
    throw new ValidationError('patch must be an object');
  }
  const { title, tag, done } = value as Record<string, unknown>;
  const patch: TaskPatch = {};
  if (title !== undefined) patch.title = parseTitle(title);
  if (tag !== undefined) patch.tag = parseTag(tag);
  if (done !== undefined) {
    if (typeof done !== 'boolean') throw new ValidationError('done must be true or false');
    patch.done = done;
  }
  if (Object.keys(patch).length === 0) {
    throw new ValidationError('nothing to update: pass title, tag, or done');
  }
  return patch;
}

export function parseId(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ValidationError('id must be a non-empty string');
  }
  return value.trim();
}

export function normalizeTitle(title: string): string {
  return title.trim().toLowerCase();
}
