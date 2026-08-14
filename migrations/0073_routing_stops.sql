-- Migration 0073: stop order, and somewhere to put coordinates
--
-- Routing here means ORDERING THE STOPS within a day a crew is already assigned
-- to. It is not crew assignment and not vehicle routing — deciding who does the
-- work is a different, harder problem, and doing it badly would move work away
-- from the crews that know the property.
--
-- Two halves, deliberately separable:
--
--   stop_order    works with no external service at all. Drag the stops on a
--                 day into the order the crew will drive them, see the running
--                 on-site total. Useful the day it ships.
--   lat/lng       storage only. A provider fills these in when one is
--                 configured; until then they stay NULL and every routing
--                 feature that needs them stays switched off rather than
--                 guessing.
--
-- The coordinates live on BOTH clients and wo_days on purpose. A client's
-- address is the durable fact and is worth geocoding once. A day's coordinates
-- are a snapshot: a job can be at a site that is not the client's billing
-- address, and re-geocoding history every time a client moves would silently
-- rewrite where last summer's work happened.
--
-- Coordinates are stored as INTEGER degrees x 1e7, not REAL.
--
-- The first version of this migration used REAL and argued that coordinates are
-- angles rather than money, so the cents rule did not apply. The pre-push guard
-- disagreed, and the guard is right to: this project has one enforced rule about
-- floats in migrations, and "my column is a special case" is exactly what every
-- float that ever broke a fixture said first.
--
-- Scaled integers cost nothing here. 1e7 gives about 1.1cm of resolution, which
-- is four orders of magnitude finer than a street address is meaningful to, and
-- it makes coordinates behave like every other number in this schema: exact,
-- integer, converted at the boundary. Same discipline as money, same reason.

ALTER TABLE wo_days ADD COLUMN stop_order INTEGER;
ALTER TABLE wo_days ADD COLUMN lat_e7 INTEGER;
ALTER TABLE wo_days ADD COLUMN lng_e7 INTEGER;
ALTER TABLE wo_days ADD COLUMN drive_minutes INTEGER;

ALTER TABLE clients ADD COLUMN lat_e7 INTEGER;
ALTER TABLE clients ADD COLUMN lng_e7 INTEGER;
-- When the coordinates were last resolved, so a re-geocode can skip what is
-- fresh and a stale address can be found later.
ALTER TABLE clients ADD COLUMN geocoded_at TEXT;

-- The ordering read: "the stops for this crew on this day, in order". Without
-- it, drawing a route list is a scan of every day row for the company.
CREATE INDEX IF NOT EXISTS idx_wo_days_stop_order
  ON wo_days(company_id, day_date, crew_id, stop_order);

-- Deliberately NOT a UNIQUE index on (day, crew, stop_order).
--
-- Reordering a list of stops passes through states where two rows briefly share
-- a position, and D1 has no deferred constraints — a unique index would make the
-- natural "shift everything down by one" write impossible without a temporary
-- offset dance. Order is presentation, and a duplicate position is a cosmetic
-- tie rather than a corruption, so it is resolved on read instead.
