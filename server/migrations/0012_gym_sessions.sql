-- Gym sessions from the phone app's gym switch. The app makes the id, so a retry after a dropped connection never duplicates one.
CREATE TABLE IF NOT EXISTS gym_sessions (
  id         TEXT PRIMARY KEY,
  started_at TEXT NOT NULL,  -- ISO time
  ended_at   TEXT,           -- ISO time; null while he is still there
  updated_at TEXT NOT NULL
);
