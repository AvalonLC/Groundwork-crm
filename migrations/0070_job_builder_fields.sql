-- Migration 0070: the four job fields the Job Builder actually needs
--
-- The scheduling revamp brief asks the Job Builder to collect a long list:
-- division, project manager, salesperson, priority, promised start, required
-- completion, target crew size, gate code, pets, parking, communication
-- preferences. work_orders has columns for none of them.
--
-- Building inputs for all of them would repeat the recurring-services mistake
-- this project just finished cleaning up: a form that collects a field, posts
-- it, and drops it on the floor because no column was ever added. So this adds
-- only the fields with a REAL consumer already designed, and the rest wait
-- until something needs them.
--
--   priority                 the Job Pool sorts and filters on it. Without a
--                            column the filter would be decorative.
--   required_completion_date the "deadline risk" warning needs a deadline. Also
--                            the only thing that makes "promised start" more
--                            than a note.
--   target_crew_size         the Labor Plan derives expected production days
--                            from sold labor / crew size / productive hours.
--                            Storing it is what lets that survive a reload.
--   access_notes             gate codes, dogs, where to park. Belongs to the
--                            job's SITE, and the crew reads it on the day
--                            drawer. Deliberately not on the client record:
--                            a client can have several properties, and the
--                            code for the back gate is a property fact.
--
-- Deliberately NOT added: division, project_manager_id, salesperson_id. The
-- brief asks for them and nothing in the product would read them yet, which is
-- how dead columns are born. They are a small migration away whenever a screen
-- genuinely needs them.
--
-- All nullable, no backfill, no default that changes behaviour: existing rows
-- keep reading exactly as they do today.

ALTER TABLE work_orders ADD COLUMN priority TEXT;
ALTER TABLE work_orders ADD COLUMN required_completion_date TEXT;
ALTER TABLE work_orders ADD COLUMN target_crew_size INTEGER;
ALTER TABLE work_orders ADD COLUMN access_notes TEXT;

-- The Job Pool reads open work ordered by urgency. Without this the pool's
-- default sort is a full scan of every non-completed job for the company.
CREATE INDEX IF NOT EXISTS idx_wo_priority
  ON work_orders(company_id, priority, required_completion_date);
