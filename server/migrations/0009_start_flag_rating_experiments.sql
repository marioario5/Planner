-- Start button, flag, day rating, experiments.
ALTER TABLE tasks ADD COLUMN started_at TEXT;
ALTER TABLE tasks ADD COLUMN flagged_at TEXT;

CREATE TABLE IF NOT EXISTS day_ratings (
  date       TEXT PRIMARY KEY,
  rating     INTEGER NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS experiments (
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
