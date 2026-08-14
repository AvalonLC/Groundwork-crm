-- Migration 0075: remember what an estimate was priced at
--
-- Tyler's rule: a sent or approved estimate keeps its original blended labor
-- rate. Customer pricing is never silently recalculated. Actual employee rates
-- drive INTERNAL job costing, and the variance between the two is displayed.
--
-- That rule needs something to compare against, and nothing stores it today.
-- estimates.cost_data holds the rollup the cost engine produced, but not the
-- RATE it used — so once a rate is recalibrated, the number the customer agreed
-- to and the number the job now costs are both knowable and the gap between them
-- is not attributable to anything.
--
-- Stored in TEN-THOUSANDTHS, the rate convention this codebase already uses
-- ($42.1002/hr -> 421002). Same reason money is cents: a rate that has to
-- reconcile to the cent cannot be a float.
--
-- Locked at TRANSITION, not at creation. A draft is still being priced and
-- should follow the current rates; the moment it goes to the customer it stops
-- moving. estimate_rate_locked_at records when that happened, so "why does this
-- job cost more than we sold it for" has a date attached to it.
--
-- Both nullable. Every estimate that already exists has no locked rate, which is
-- the honest answer — nobody recorded one — and variance for those reports as
-- unknown rather than as zero.

ALTER TABLE estimates ADD COLUMN locked_labor_rate INTEGER;
ALTER TABLE estimates ADD COLUMN estimate_rate_locked_at TEXT;

-- Answers "which estimates were priced at a rate we have since changed", which
-- is the report this whole mechanism exists to make possible.
CREATE INDEX IF NOT EXISTS idx_estimates_locked_rate
  ON estimates(company_id, locked_labor_rate);
