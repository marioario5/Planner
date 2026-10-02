-- Headline + info sections per day. Safe to run more than once.
-- Run: npm run db:info:remote
CREATE TABLE IF NOT EXISTS day_info (
  date       TEXT PRIMARY KEY,           -- planner day, YYYY-MM-DD
  headline   TEXT,
  sections   TEXT NOT NULL DEFAULT '[]', -- JSON: [{title, body, front}]
  updated_at TEXT NOT NULL
);
