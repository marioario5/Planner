-- The music experiment, kept apart from the planner: stretches of "YouTube mode" (the pink printer button in the phone app)
-- and the experiments run on them. The planner never reads these tables.
CREATE TABLE IF NOT EXISTS music_sessions (
  id         TEXT PRIMARY KEY,   -- made by the app, so a retry never duplicates a session
  started_at TEXT NOT NULL,      -- ISO time
  ended_at   TEXT,               -- ISO time; null while it is still on
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS music_experiments (
  id         TEXT PRIMARY KEY,
  title      TEXT NOT NULL,
  change     TEXT NOT NULL,
  measure    TEXT NOT NULL,
  tag        TEXT,
  started_on TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'running',
  result     TEXT,
  updated_at TEXT NOT NULL
);
