-- Full current schema, for a brand-new database.
-- An existing database needs migrations/ instead (see README).
CREATE TABLE IF NOT EXISTS tasks (
  id           TEXT PRIMARY KEY,
  date         TEXT NOT NULL,                 -- planner day, YYYY-MM-DD
  plan         TEXT NOT NULL DEFAULT 'A',     -- 'A' (normal day) or 'B' (backup plan)
  commitment_id TEXT,                         -- the framework commitment this task works on
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
  completed_at TEXT,
  started_at   TEXT,                          -- when he pressed Start
  flagged_at   TEXT                           -- he flagged this task's times as unreliable
);

CREATE INDEX IF NOT EXISTS idx_tasks_date ON tasks (date, position);

CREATE TABLE IF NOT EXISTS day_info (
  date       TEXT PRIMARY KEY,           -- planner day, YYYY-MM-DD
  headline   TEXT,
  sections   TEXT NOT NULL DEFAULT '[]', -- JSON: [{title, body, front}]
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS habit_notes (
  id         INTEGER PRIMARY KEY AUTOINCREMENT, -- the version number
  notes      TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS commitments (
  id             TEXT PRIMARY KEY,           -- short slug, e.g. piq-7
  title          TEXT NOT NULL,
  due            TEXT,                       -- YYYY-MM-DD
  start_date     TEXT,
  target_minutes INTEGER,                    -- rough size
  status         TEXT NOT NULL DEFAULT 'open',
  note           TEXT,                       -- the proposing agent's reasoning / assumptions
  defer_until    TEXT,
  defer_reason   TEXT,
  created_on     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS framework_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  on_date       TEXT NOT NULL,
  commitment_id TEXT,
  action        TEXT NOT NULL,
  detail        TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS framework_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS user_notes (
  id           TEXT PRIMARY KEY,           -- short slug, e.g. energy-late-night
  kind         TEXT NOT NULL,              -- fact | preference | pattern | idea
  text         TEXT NOT NULL,              -- a summary of what HE said, written by an earlier agent
  quote        TEXT,                       -- a short verbatim snippet of his own words
  noted_on     TEXT NOT NULL,
  confirmed_on TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'active',
  updated_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS day_ratings (
  date       TEXT PRIMARY KEY,
  rating     INTEGER NOT NULL,                -- 1 (rough) to 5 (great)
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS experiments (
  id         TEXT PRIMARY KEY,
  title      TEXT NOT NULL,
  change     TEXT NOT NULL,
  measure    TEXT NOT NULL,                   -- done_pct | lateness | blocks_done | rating
  tag        TEXT,
  started_on TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'running', -- running | kept | dropped
  result     TEXT,
  updated_at TEXT NOT NULL
);
