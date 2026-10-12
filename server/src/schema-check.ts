// Which database migrations the live database is missing. A missing migration used to fail silently (the change log just came
// back empty); this turns it into a plain list with the exact command to run.

export interface SchemaProblem {
  what: string;
  /** The migration file that adds it. */
  migration: string;
  /** The npm script to run in server/ (the remote one). */
  run: string;
}

export interface SchemaReport {
  ok: boolean;
  missing: SchemaProblem[];
  /** The commands to run, once each, oldest migration first. */
  run_in_order: string[];
}

interface Step {
  migration: string;
  script: string;
  tables?: string[];
  taskColumns?: string[];
}

// Oldest first. The base schema (the `tasks` table with id/date/title/tag/done/position/created_at/completed_at) is db:init.
const STEPS: Step[] = [
  { migration: '0002_time_and_notes', script: 'db:migrate:remote', taskColumns: ['start_time', 'minutes', 'notes'] },
  { migration: '0003_day_info', script: 'db:info:remote', tables: ['day_info'] },
  { migration: '0004_site_sync', script: 'db:sync:remote', taskColumns: ['site_key', 'done_at'] },
  { migration: '0005_plans', script: 'db:plans:remote', taskColumns: ['plan'] },
  { migration: '0006_habit_notes', script: 'db:habits:remote', tables: ['habit_notes'] },
  { migration: '0007_framework', script: 'db:framework:remote', tables: ['commitments', 'framework_log', 'framework_meta'], taskColumns: ['commitment_id'] },
  { migration: '0008_user_notes', script: 'db:notes:remote', tables: ['user_notes'] },
  {
    migration: '0009_start_flag_rating_experiments',
    script: 'db:start:remote',
    tables: ['day_ratings', 'experiments'],
    taskColumns: ['started_at', 'flagged_at'],
  },
  { migration: '0010_pause', script: 'db:pause:remote', taskColumns: ['paused_at', 'paused_ms'] },
  { migration: '0011_task_events', script: 'db:log:remote', tables: ['task_events'] },
  { migration: '0012_gym_sessions', script: 'db:gym:remote', tables: ['gym_sessions'] },
];

/** `tables` = every table in the database; `taskColumns` = every column of `tasks`. */
export function checkSchema(tables: Set<string>, taskColumns: Set<string>): SchemaReport {
  const missing: SchemaProblem[] = [];
  const scripts: string[] = [];
  for (const step of STEPS) {
    const gaps = [
      ...(step.tables ?? []).filter((t) => !tables.has(t)).map((t) => `table ${t}`),
      ...(step.taskColumns ?? []).filter((c) => !taskColumns.has(c)).map((c) => `column tasks.${c}`),
    ];
    for (const what of gaps) missing.push({ what, migration: step.migration, run: `npm run ${step.script}` });
    if (gaps.length > 0) scripts.push(`npm run ${step.script}`);
  }
  return { ok: missing.length === 0, missing, run_in_order: scripts };
}

export const SCHEMA_OK: SchemaReport = { ok: true, missing: [], run_in_order: [] };
