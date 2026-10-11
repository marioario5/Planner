-- A short log of every change to a task (who sent it and what it said), so an unexpected change can be traced.
CREATE TABLE IF NOT EXISTS task_events (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  at      TEXT NOT NULL,   -- ISO time
  task_id TEXT,
  title   TEXT,
  source  TEXT NOT NULL,   -- phone app, website, progress-site sync, planner tool...
  change  TEXT NOT NULL    -- what was asked, as JSON
);
