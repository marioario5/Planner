import { describe, expect, it } from 'vitest';
import { checkSchema } from '../src/schema-check';

const ALL_TABLES = [
  'tasks', 'day_info', 'habit_notes', 'commitments', 'framework_log', 'framework_meta', 'user_notes', 'day_ratings', 'experiments', 'task_events',
];
const ALL_COLUMNS = [
  'id', 'date', 'title', 'tag', 'done', 'position', 'created_at', 'completed_at', 'start_time', 'minutes', 'notes', 'site_key', 'done_at', 'plan',
  'commitment_id', 'started_at', 'flagged_at', 'paused_at', 'paused_ms',
];

describe('schema check: which migrations are missing', () => {
  it('a fully migrated database is ok', () => {
    expect(checkSchema(new Set(ALL_TABLES), new Set(ALL_COLUMNS))).toEqual({ ok: true, missing: [], run_in_order: [] });
  });

  it('a missing table names its migration and the command', () => {
    const report = checkSchema(new Set(ALL_TABLES.filter((t) => t !== 'task_events')), new Set(ALL_COLUMNS));
    expect(report.ok).toBe(false);
    expect(report.missing).toEqual([{ what: 'table task_events', migration: '0011_task_events', run: 'npm run db:log:remote' }]);
    expect(report.run_in_order).toEqual(['npm run db:log:remote']);
  });

  it('several gaps give each command once, oldest migration first', () => {
    const report = checkSchema(
      new Set(ALL_TABLES.filter((t) => t !== 'task_events' && t !== 'experiments')),
      new Set(ALL_COLUMNS.filter((c) => c !== 'paused_at' && c !== 'paused_ms' && c !== 'started_at')),
    );
    expect(report.run_in_order).toEqual(['npm run db:start:remote', 'npm run db:pause:remote', 'npm run db:log:remote']);
    expect(report.missing.map((m) => m.what)).toEqual([
      'table experiments', 'column tasks.started_at', 'column tasks.paused_at', 'column tasks.paused_ms', 'table task_events',
    ]);
  });
});
