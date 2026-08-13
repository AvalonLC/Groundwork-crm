-- Migration 0060: productive hours — the capacity denominator
--
-- The Week view currently divides scheduled hours by a hardcoded 40
-- (public/js/app_premium.js, the crew-lane metric), so the "%" it shows is
-- meaningless for any crew that is not exactly one person on a 40-hour week.
-- Real capacity is: people on the crew x productive minutes per working day.
--
-- workday_settings (0014) already knows shift_start/shift_end, lunch_minutes and
-- working_days. What it cannot express is that a shift is not all productive
-- time: 07:00-17:00 less a 30-minute lunch is 570 minutes on the clock, but
-- drive time, shop time, fuelling and morning huddle are not hours you can sell
-- against a job. Scheduling against the on-clock number over-books every crew.
--
-- Stored as INTEGER minutes, not REAL hours, to match this repo's integer
-- discipline for anything that gets multiplied or compared.

ALTER TABLE workday_settings ADD COLUMN productive_minutes_per_day INTEGER DEFAULT 450;

-- Existing rows get the column default from the ALTER above, but be explicit:
-- a NULL here would silently make crew capacity 0 and every crew read 0%.
UPDATE workday_settings
   SET productive_minutes_per_day = 450
 WHERE productive_minutes_per_day IS NULL;
