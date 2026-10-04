-- The month-ahead framework: suggestions from earlier planning runs (commitments), a small log of choices,
-- and a link from tasks to the commitment they work on.
-- Run once: npm run db:framework:remote  (the ALTER errors with "duplicate column" if already applied)
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

ALTER TABLE tasks ADD COLUMN commitment_id TEXT;
