-- Adds first-class time and notes to a database created from the original schema.
-- Run once: npm run db:migrate:remote
ALTER TABLE tasks ADD COLUMN start_time TEXT;
ALTER TABLE tasks ADD COLUMN minutes INTEGER;
ALTER TABLE tasks ADD COLUMN notes TEXT;
