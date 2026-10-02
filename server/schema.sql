-- Full current schema, for a brand-new database.
-- An existing database needs migrations/ instead (see README).
CREATE TABLE IF NOT EXISTS tasks (
  id           TEXT PRIMARY KEY,
  date         TEXT NOT NULL,                 -- planner day, YYYY-MM-DD
  plan         TEXT NOT NULL DEFAULT 'A',     -- 'A' (normal day) or 'B' (backup plan)
  title        TEXT NOT NULL,
  tag          TEXT NOT NULL DEFAULT 'school',
  start_time   TEXT,                          -- 24-hour HH:MM, NULL = untimed
  minutes      INTEGER,
  notes        TEXT,
  site_key     TEXT,                          -- progress-site task id this mirrors, e.g. calc3-t12
  done         INTEGER NOT NULL DEFAULT 0,
  done_at      INTEGER,                       -- epoch ms of the last done toggle (either way)
  position     INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL,
  completed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_tasks_date ON tasks (date, position);

CREATE TABLE IF NOT EXISTS day_info (
  date       TEXT PRIMARY KEY,           -- planner day, YYYY-MM-DD
  headline   TEXT,
  sections   TEXT NOT NULL DEFAULT '[]', -- JSON: [{title, body, front}]
  updated_at TEXT NOT NULL
);
