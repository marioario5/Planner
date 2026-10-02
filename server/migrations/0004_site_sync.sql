-- Adds what the progress-site sync needs: which site task a task mirrors, and when it was last
-- checked/unchecked (so "newest change wins" can be decided per task).
-- Run once: npm run db:sync:remote   (errors with "duplicate column" if already applied)
ALTER TABLE tasks ADD COLUMN site_key TEXT;
ALTER TABLE tasks ADD COLUMN done_at INTEGER;
