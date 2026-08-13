-- Migration 0069: distinguish roster-derived assignments from hand-added ones
--
-- Dragging a job to a different crew lane changed wo_days.crew_id but left
-- wo_day_employees untouched, so the card moved while the labor stayed
-- attributed to the crew it came from. Fixing that means re-deriving a day's
-- people when its crew changes — which needs a way to tell apart:
--
--   'roster'  this person is here because they are on the day's crew. When the
--             crew changes they are replaced by the new crew's roster.
--   'manual'  someone put this person on this day deliberately, and they are
--             not on the day's crew. A crew change must not silently drop them.
--
-- Without the distinction, re-deriving would either wipe deliberate assignments
-- or accumulate people from every crew a job ever passed through.
--
-- Existing rows were all created by the roster-derivation pass in
-- syncDayEmployees, so 'roster' is the correct default for them.

ALTER TABLE wo_day_employees ADD COLUMN source TEXT NOT NULL DEFAULT 'roster';

CREATE INDEX IF NOT EXISTS idx_wo_day_employees_source
  ON wo_day_employees(wo_day_id, source);
