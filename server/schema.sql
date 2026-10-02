-- Full current schema, for a brand-new database.
-- An existing database needs migrations/ instead (see README).
CREATE TABLE IF NOT EXISTS tasks (
  id           TEXT PRIMARY KEY,
  date         TEXT NOT NULL,                 -- planner day, YYYY-MM-DD
  title        TEXT NOT NULL,
  tag          TEXT NOT NULL DEFAULT 'school',
  start_time   TEXT,                          -- 24-hour HH:MM, NULL = untimed
  minutes      INTEGER,
  notes        TEXT,
  done         INTEGER NOT NULL DEFAULT 0,
  position     INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL,
  completed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_tasks_date ON tasks (date, position);
