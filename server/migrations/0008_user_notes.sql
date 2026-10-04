-- General notes about him that aren't tied to one date: short summaries of what he said, written by earlier agents.
-- Safe to run more than once. Run: npm run db:notes:remote
CREATE TABLE IF NOT EXISTS user_notes (
  id           TEXT PRIMARY KEY,           -- short slug, e.g. energy-late-night
  kind         TEXT NOT NULL,              -- fact | preference | pattern | idea
  text         TEXT NOT NULL,              -- a summary of what HE said, written by an earlier agent
  quote        TEXT,                       -- a short verbatim snippet of his own words
  noted_on     TEXT NOT NULL,
  confirmed_on TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'active',
  updated_at   TEXT NOT NULL
);
