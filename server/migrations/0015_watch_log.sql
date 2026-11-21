-- The videos the Firefox extension saw playing, for the music experiment. The planner never reads this table.
-- One row per stretch of one video (the extension updates it while the video plays). Run once: npm run db:watch:remote
CREATE TABLE IF NOT EXISTS watch_log (
  id         TEXT PRIMARY KEY,   -- made by the extension, so a retry never duplicates a row
  session_id TEXT NOT NULL,      -- the YouTube-mode session (music_sessions.id) this belongs to
  video_id   TEXT NOT NULL,
  title      TEXT NOT NULL,
  channel    TEXT NOT NULL,
  duration_s INTEGER,
  started_at TEXT NOT NULL,      -- ISO time
  ended_at   TEXT NOT NULL,      -- ISO time: the last moment it was seen playing
  watched_s  INTEGER NOT NULL DEFAULT 0,
  mode       TEXT NOT NULL DEFAULT 'browsing',
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS watch_log_started ON watch_log (started_at);
