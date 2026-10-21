-- Each YouTube-mode stretch now has a mode: browsing (just watching videos) or lecture (following along, e.g. a Calc 3 video).
-- Run once: npm run db:musicmode:remote  (the ALTER errors with "duplicate column" if already applied)
ALTER TABLE music_sessions ADD COLUMN mode TEXT NOT NULL DEFAULT 'browsing';
