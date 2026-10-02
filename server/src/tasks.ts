// Task types, input validation, and the storage interface.
// Validation lives here so the REST routes and the MCP tools reject the same things.

export const TAGS = ['school', 'calculus3', 'sat', 'pcb', 'photography'] as const;
export type Tag = (typeof TAGS)[number];

export interface Task {
  id: string;
  date: string; // planner day, YYYY-MM-DD
  title: string;
  tag: Tag;
  /** 24-hour "HH:MM" in the planner's time zone, or null for untimed tasks. */
  start: string | null;
  minutes: number | null;
  notes: string | null;
  done: boolean;
  position: number;
  createdAt: string;
  completedAt: string | null;
}

export interface NewTask {
  title: string;
  tag: Tag;
  start: string | null;
  minutes: number | null;
  notes: string | null;
}

/** For start/minutes/notes: undefined = leave alone, null = clear. */
export interface TaskPatch {
  title?: string;
  tag?: Tag;
  start?: string | null;
  minutes?: number | null;
  notes?: string | null;
  done?: boolean;
}

/** A titled block of text Claude writes for the day (warnings, pre-start, next PCB work...). */
export interface InfoSection {
  title: string;
  body: string;
  /** true = printed on the front "briefing" side; false = opened from a button. */
  front: boolean;
}

export interface DayInfo {
  headline: string | null;
  sections: InfoSection[];
}

export interface TaskStore {
  /** Timed tasks in clock order, then untimed tasks in the order they were given. */
  list(date: string): Promise<Task[]>;
  add(date: string, task: NewTask): Promise<Task>;
  /** Replaces a day's list. Tasks whose title matches one already done stay done. */
  replaceDay(date: string, tasks: NewTask[]): Promise<Task[]>;
  update(id: string, patch: TaskPatch): Promise<Task | null>;
  remove(id: string): Promise<boolean>;
  /** Empty (no headline, no sections) when nothing was written for the day. */
  getDayInfo(date: string): Promise<DayInfo>;
  /** Replaces the day's info. An empty DayInfo clears it. */
  setDayInfo(date: string, info: DayInfo): Promise<void>;
}

export class ValidationError extends Error {}

const MAX_TITLE = 200;
const MAX_NOTES = 1000;
const MAX_TASKS_PER_DAY = 100;
const MAX_HEADLINE = 300;
const MAX_SECTIONS = 12;
const MAX_SECTION_TITLE = 60;
const MAX_SECTION_BODY = 4000;

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

export function parseStart(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) {
    throw new ValidationError('start must be 24-hour HH:MM, like 15:30');
  }
  return value;
}

export function parseMinutes(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 1440) {
    throw new ValidationError('minutes must be a whole number from 1 to 1440');
  }
  return value;
}

export function parseNotes(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new ValidationError('notes must be a string');
  const notes = value.trim();
  if (notes.length > MAX_NOTES) {
    throw new ValidationError(`notes must be at most ${MAX_NOTES} characters`);
  }
  return notes === '' ? null : notes;
}

export function parseNewTask(value: unknown): NewTask {
  if (typeof value !== 'object' || value === null) {
    throw new ValidationError('each task must be an object with a title');
  }
  const { title, tag, start, minutes, notes } = value as Record<string, unknown>;
  return {
    title: parseTitle(title),
    tag: parseTag(tag),
    start: parseStart(start),
    minutes: parseMinutes(minutes),
    notes: parseNotes(notes),
  };
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
  const { title, tag, done, start, minutes, notes } = value as Record<string, unknown>;
  const patch: TaskPatch = {};
  if (title !== undefined) patch.title = parseTitle(title);
  if (tag !== undefined) patch.tag = parseTag(tag);
  if (start !== undefined) patch.start = parseStart(start);
  if (minutes !== undefined) patch.minutes = parseMinutes(minutes);
  if (notes !== undefined) patch.notes = parseNotes(notes);
  if (done !== undefined) {
    if (typeof done !== 'boolean') throw new ValidationError('done must be true or false');
    patch.done = done;
  }
  if (Object.keys(patch).length === 0) {
    throw new ValidationError('nothing to update: pass title, tag, start, minutes, notes, or done');
  }
  return patch;
}

function parseSection(value: unknown): InfoSection {
  if (typeof value !== 'object' || value === null) {
    throw new ValidationError('each section must be an object with a title and body');
  }
  const { title, body, front } = value as Record<string, unknown>;
  if (typeof title !== 'string' || title.trim() === '') {
    throw new ValidationError('section title must be a non-empty string');
  }
  if (title.trim().length > MAX_SECTION_TITLE) {
    throw new ValidationError(`section title must be at most ${MAX_SECTION_TITLE} characters`);
  }
  if (typeof body !== 'string' || body.trim() === '') {
    throw new ValidationError(`section "${title.trim()}" needs a non-empty body`);
  }
  if (body.trim().length > MAX_SECTION_BODY) {
    throw new ValidationError(`section body must be at most ${MAX_SECTION_BODY} characters`);
  }
  if (front !== undefined && front !== null && typeof front !== 'boolean') {
    throw new ValidationError('section front must be true or false');
  }
  return { title: title.trim(), body: body.trim(), front: front === true };
}

export function parseDayInfo(args: Record<string, unknown>): DayInfo {
  const { headline, sections } = args;
  let cleanHeadline: string | null = null;
  if (headline !== undefined && headline !== null) {
    if (typeof headline !== 'string') throw new ValidationError('headline must be a string');
    cleanHeadline = headline.trim() === '' ? null : headline.trim();
    if (cleanHeadline && cleanHeadline.length > MAX_HEADLINE) {
      throw new ValidationError(`headline must be at most ${MAX_HEADLINE} characters`);
    }
  }
  if (sections !== undefined && sections !== null && !Array.isArray(sections)) {
    throw new ValidationError('sections must be an array');
  }
  const list = (sections as unknown[] | undefined | null) ?? [];
  if (list.length > MAX_SECTIONS) throw new ValidationError(`at most ${MAX_SECTIONS} sections`);
  return { headline: cleanHeadline, sections: list.map(parseSection) };
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
