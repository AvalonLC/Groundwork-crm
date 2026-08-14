-- Migration 0071: equipment booked to a specific day
--
-- Equipment scheduling had no data model at all. `assets` (migration 0031) has
-- a free-text `assigned_to` column and there is no link to work_orders, wo_days
-- or crews anywhere. So "the skid steer is on the Miller job Tuesday" could be
-- typed into a notes field and nothing could ever read it back — which is why
-- the Job Builder's equipment box says, in the UI, that it is a note and not a
-- booking.
--
-- This is the table that makes it a booking, and it hangs off the DAY rather
-- than the job for the same reason wo_day_employees does: a four-day job might
-- need the excavator on Tuesday and Wednesday only. Booking it to the job would
-- either over-reserve it for four days or under-describe what is happening.
--
-- The UNIQUE index is the point. It makes "this machine is on two jobs at once"
-- impossible to represent per (asset, day) rather than something the
-- application has to remember to check — the same reasoning as
-- wo_day_employees' (wo_day_id, rep_id). Double-booking across two DIFFERENT
-- days of the same date is still possible and is caught as a warning, because
-- that one is a scheduling judgement rather than a data error: a machine really
-- can do two jobs in a day if they are close enough together.

CREATE TABLE IF NOT EXISTS wo_day_equipment (
  id          TEXT PRIMARY KEY,
  company_id  TEXT NOT NULL,
  wo_day_id   TEXT NOT NULL,
  asset_id    TEXT NOT NULL,
  -- 'needed' the job wants it · 'loaded' it is on the trailer · 'on_site' it is there
  status      TEXT NOT NULL DEFAULT 'needed',
  notes       TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
  -- Cascade for the same reason 0062 gives: removing a day takes its bookings
  -- with it and leaves no orphans behind.
  FOREIGN KEY (wo_day_id) REFERENCES wo_days(id) ON DELETE CASCADE,
  FOREIGN KEY (asset_id)  REFERENCES assets(id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_wo_day_equipment_uniq
  ON wo_day_equipment(wo_day_id, asset_id);
CREATE INDEX IF NOT EXISTS idx_wo_day_equipment_day
  ON wo_day_equipment(wo_day_id);
-- Answers "where is this machine this week", which is the double-booking check.
CREATE INDEX IF NOT EXISTS idx_wo_day_equipment_asset
  ON wo_day_equipment(asset_id, company_id);
