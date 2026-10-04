-- The living habit notes Claude keeps about how he works, one row per saved version.
-- Safe to run more than once. Run: npm run db:habits:remote
CREATE TABLE IF NOT EXISTS habit_notes (
  id         INTEGER PRIMARY KEY AUTOINCREMENT, -- the version number
  notes      TEXT NOT NULL,
  created_at TEXT NOT NULL
);
