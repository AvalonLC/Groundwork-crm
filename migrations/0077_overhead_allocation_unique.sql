-- Migration 0077: one allocation row per division per as_of.
--
-- overhead_allocation had a plain index on (company_id, division, as_of) and no
-- unique constraint. Nothing ever wrote the table, so it never mattered — but
-- the allocation run added alongside this migration writes one row per division
-- per run, and running it twice for the same date would insert a second full
-- set rather than replacing the first.
--
-- That is not a cosmetic duplicate. gather-inputs.ts SUMS allocated_overhead_cents
-- across the rows for a date:
--
--     SELECT SUM(allocated_overhead_cents) ... WHERE company_id = ? AND as_of = ?
--
-- so a second run would double the overhead feeding the nightly rollup, and the
-- blended rate with it. The failure would be silent and would look like the
-- business suddenly carrying twice the overhead.
--
-- Same reasoning as wo_day_equipment's UNIQUE index in 0071: make the bad state
-- impossible to represent rather than something every writer has to remember.
-- The run upserts on this constraint, so re-running a date corrects it instead
-- of compounding it.
--
-- Safe to apply: nothing has ever written this table, so there are no existing
-- duplicates for the index to reject.

CREATE UNIQUE INDEX IF NOT EXISTS idx_overhead_allocation_uniq
  ON overhead_allocation(company_id, division, as_of);
