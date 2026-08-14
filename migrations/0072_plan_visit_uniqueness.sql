-- Migration 0072: one visit per subscription per day, as a database rule
--
-- Visit generation has to be safe to re-run. It will be run on a schedule, by
-- hand from the UI, and again the moment anyone suspects it did not work — and
-- a generator that double-creates on a retry is worse than one that never runs,
-- because the duplicates land on the calendar as real work with real crews.
--
-- plan_visits has indexes on subscription_id, scheduled_date, crew_id and
-- status, and no UNIQUE constraint anywhere. Idempotency was therefore
-- application logic that could be got wrong. This makes it a rule the database
-- enforces, which lets the generator use INSERT ... ON CONFLICT DO NOTHING —
-- the same pattern already proven in wo_day_employees.
--
-- Deliberately (subscription_id, scheduled_date) and NOT the id: the id is
-- derived from exactly those two values, so keying on it would guard the same
-- thing indirectly while leaving a hand-inserted row free to collide.
--
-- Safe to add: production has zero plan_visits rows. The DELETE below is
-- therefore a no-op there, and exists so this migration is also applicable to a
-- local database that has been used for testing — without it, a single stray
-- duplicate would make the index creation fail and block every later migration.
-- It keeps the OLDEST row of any duplicate set, which is the one anything else
-- is most likely to already reference.

DELETE FROM plan_visits
 WHERE rowid NOT IN (
   SELECT MIN(rowid) FROM plan_visits GROUP BY subscription_id, scheduled_date
 );

CREATE UNIQUE INDEX IF NOT EXISTS idx_plan_visits_sub_date
  ON plan_visits(subscription_id, scheduled_date);

-- The generator's other hot path: "which visits in this window still need a
-- work order". Without it that is a scan of every visit for the company.
CREATE INDEX IF NOT EXISTS idx_plan_visits_pending_wo
  ON plan_visits(company_id, scheduled_date, work_order_id);
