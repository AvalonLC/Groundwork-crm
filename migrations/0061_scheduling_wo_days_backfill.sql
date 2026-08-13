-- Migration 0061: every scheduled work order gets a wo_days row
--
-- wo_days (0045, extended by 0046/0047) is the only place the schedule can hang
-- per-day clock times, a crew and a duration. Today only multi-day jobs have
-- rows, so a single-day job has nowhere to record "this crew, this day, these
-- hours" — the grid has to read work_orders directly and cannot express a job
-- that moves one day without moving the whole work order.
--
-- This backfills one row per scheduled work order that has none, so the Week
-- view has a uniform thing to render and drag.
--
-- SAFETY
-- Additive only. It alters no existing column and touches no existing row:
-- the NOT EXISTS guard skips any work order that already has hand-authored
-- day rows, so multi-day jobs come through untouched. Reversible in one
-- statement:
--
--     DELETE FROM wo_days WHERE is_primary = 1;
--
-- 0062's wo_day_employees cascades from wo_days, so that rollback leaves no
-- orphans.
--
-- Count the rows this will insert BEFORE merging (deploy.yml applies migrations
-- to production on push to main, so the merge is the migration):
--
--     SELECT COUNT(*) FROM work_orders wo
--      WHERE COALESCE(wo.scheduled_date,'') <> ''
--        AND NOT EXISTS (SELECT 1 FROM wo_days d WHERE d.work_order_id = wo.id);

ALTER TABLE wo_days ADD COLUMN is_primary INTEGER DEFAULT 0;

-- Marks rows this migration created, so they can be removed again without
-- disturbing day rows authored by the multi-day planner.
CREATE INDEX IF NOT EXISTS idx_wodays_is_primary ON wo_days(is_primary);

INSERT INTO wo_days (
  id, company_id, work_order_id, day_number, day_date,
  scope, questions, status,
  phase_name, phase_sequence, crew_id,
  start_time, end_time, scheduled_duration_minutes, schedule_locked,
  is_primary
)
SELECT
  -- Deterministic id: one row per work order, so this cannot collide and a
  -- re-run cannot double-insert.
  'wod_bf_' || wo.id,
  wo.company_id,
  wo.id,
  1,
  wo.scheduled_date,
  '',
  '[]',
  CASE wo.status
    WHEN 'completed'   THEN 'completed'
    WHEN 'in-progress' THEN 'in_progress'
    ELSE 'pending'
  END,
  '',
  1,
  COALESCE(wo.crew_id, ''),
  wo.scheduled_time,
  wo.scheduled_end_time,
  -- Mirrors what the grid already does when a job has no explicit duration
  -- (see _sbEventRange in public/js/app_premium.js): fall back to
  -- duration_hours. Note duration_hours is currently conflated — for jobs
  -- created from an estimate it holds the SOLD labor hours, not calendar
  -- duration. 0063 separates the two by snapshotting budget_minutes; this
  -- column stays the calendar figure.
  COALESCE(
    wo.scheduled_duration_minutes,
    CAST(ROUND(wo.duration_hours * 60) AS INTEGER)
  ),
  COALESCE(wo.schedule_locked, 0),
  1
FROM work_orders wo
WHERE COALESCE(wo.scheduled_date, '') <> ''
  AND NOT EXISTS (
    SELECT 1 FROM wo_days d WHERE d.work_order_id = wo.id
  );
