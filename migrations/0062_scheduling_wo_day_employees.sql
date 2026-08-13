-- Migration 0062: who is on the job, and for how long
--
-- Assigning a crew to a day is not the same as assigning people to a day. A
-- three-person crew where one person is only there for the morning is four
-- hours of capacity, not a full day's worth, and today there is nowhere to say
-- so — work_orders.crew_id is the whole vocabulary.
--
-- This is the row the capacity denominator is actually built from: sum
-- planned_minutes per day per person, compare against
-- crewDailyCapacityMinutes() from src/scheduling/capacity.ts.
--
-- planned_minutes is what we INTEND someone to spend. It is not the budget
-- (work_orders.budget_minutes, snapshotted in 0063 and never written by
-- scheduling) and it is not the actual (time_entries, read-only). Keeping the
-- three apart is the entire point of this stack of migrations.

CREATE TABLE IF NOT EXISTS wo_day_employees (
  id              TEXT PRIMARY KEY,
  company_id      TEXT NOT NULL,
  wo_day_id       TEXT NOT NULL,
  rep_id          TEXT NOT NULL,
  planned_minutes INTEGER NOT NULL DEFAULT 0,
  -- Denormalised so the Week view can colour a person by their role on that
  -- crew without a second join. Mirrors crew_members.crew_role.
  crew_role       TEXT NOT NULL DEFAULT 'laborer',
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
  -- ON DELETE CASCADE is what makes 0061 reversible: removing the backfilled
  -- day rows takes their assignments with them and leaves no orphans.
  FOREIGN KEY (wo_day_id) REFERENCES wo_days(id) ON DELETE CASCADE,
  FOREIGN KEY (rep_id)    REFERENCES reps(id)
);

-- One assignment per person per day. Re-assigning updates minutes rather than
-- stacking a second row, which would silently double that person's capacity.
CREATE UNIQUE INDEX IF NOT EXISTS idx_wo_day_employees_uniq
  ON wo_day_employees(wo_day_id, rep_id);

-- The Week view's two access patterns: everyone on a day, and everywhere one
-- person is booked across a week.
CREATE INDEX IF NOT EXISTS idx_wo_day_employees_day
  ON wo_day_employees(wo_day_id);
CREATE INDEX IF NOT EXISTS idx_wo_day_employees_rep
  ON wo_day_employees(rep_id, company_id);
