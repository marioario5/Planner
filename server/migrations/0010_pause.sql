-- Pause button: when a started task is paused, and the total time already paused (ms).
ALTER TABLE tasks ADD COLUMN paused_at TEXT;
ALTER TABLE tasks ADD COLUMN paused_ms INTEGER NOT NULL DEFAULT 0;
