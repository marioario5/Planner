-- Lets a day carry two complete lists: Plan A and Plan B. Existing tasks become Plan A.
-- Run once: npm run db:plans:remote   (errors with "duplicate column" if already applied)
-- If that script hits the /import auth error, run the same statement with --command (see README).
ALTER TABLE tasks ADD COLUMN plan TEXT NOT NULL DEFAULT 'A';
