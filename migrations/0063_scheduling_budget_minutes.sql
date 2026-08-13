-- Migration 0063: snapshot budgeted hours, separate from calendar duration
--
-- THE CONFLATION THIS FIXES
-- When a work order is created from an estimate, src/index.tsx writes the cost
-- engine's budgeted hours straight into work_orders.duration_hours:
--
--     budgetHours || Number(b.duration_hours || 0) || null
--
-- but duration_hours is ALSO what the Week view reads to decide how long a job
-- blocks on the calendar (_sbEventRange in public/js/app_premium.js falls back
-- to duration_hours * 60). So one column is carrying two different meanings:
-- "how many labor hours did we sell" and "how long does this occupy the grid".
--
-- They are not the same number. Three people on a four-hour job is twelve
-- budgeted hours but a four-hour block. Every budget-vs-actual comparison built
-- on duration_hours is wrong for any job with more than one person on it.
--
-- budget_minutes is the SOLD figure, snapshotted at migration time from the
-- estimate that produced the job. duration_hours keeps its calendar meaning.
--
-- Scheduling must never write this column: moving a job or changing who is on
-- it changes wo_day_employees.planned_minutes, not what we sold. The estimate
-- is the source of truth, and re-deriving it later would silently rewrite
-- history after the fact.
--
-- INTEGER minutes rather than REAL hours, matching 0060 and this repo's
-- integer discipline for anything that gets multiplied or compared.

ALTER TABLE work_orders ADD COLUMN budget_minutes INTEGER DEFAULT NULL;

UPDATE work_orders
   SET budget_minutes = (
     SELECT CAST(
              ROUND(
                CAST(json_extract(e.cost_data, '$.rollup.budgeted_hours') AS REAL) * 60
              ) AS INTEGER
            )
       FROM estimates e
      WHERE e.id = work_orders.estimate_id
        -- json_extract RAISES on malformed input rather than returning NULL, and
        -- cost_data is a free-form TEXT column defaulting to '{}'. Without this
        -- guard a single bad row would abort the migration — and since
        -- deploy.yml applies migrations on push to main, that would fail a
        -- production deploy part-way through. CASE/AND short-circuit in SQLite,
        -- so json_valid() is checked before json_extract() ever runs.
        AND json_valid(e.cost_data)
        AND json_extract(e.cost_data, '$.rollup.budgeted_hours') IS NOT NULL
        AND CAST(json_extract(e.cost_data, '$.rollup.budgeted_hours') AS REAL) > 0
   )
 WHERE COALESCE(work_orders.estimate_id, '') <> ''
   AND EXISTS (
     SELECT 1 FROM estimates e
      WHERE e.id = work_orders.estimate_id
        AND json_valid(e.cost_data)
        AND json_extract(e.cost_data, '$.rollup.budgeted_hours') IS NOT NULL
        AND CAST(json_extract(e.cost_data, '$.rollup.budgeted_hours') AS REAL) > 0
   );

-- Everything else stays NULL on purpose. A job with no estimate rollup has no
-- budget to compare against, and that is different from a budget of zero —
-- budgetVariance() in src/scheduling/capacity.ts returns null rather than
-- reporting the job as exactly on target.

CREATE INDEX IF NOT EXISTS idx_work_orders_budget_minutes
  ON work_orders(company_id, budget_minutes);
