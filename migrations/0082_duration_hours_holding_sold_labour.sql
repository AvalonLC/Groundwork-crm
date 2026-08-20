-- Migration 0082: work_orders.duration_hours rows that are holding SOLD LABOUR
--
-- Finishes what 0063 started.
--
-- 0063 identified the conflation exactly: src/index.tsx wrote the cost engine's
-- budgeted hours into work_orders.duration_hours, and duration_hours is ALSO
-- what the schedule reads to decide how long a job blocks the calendar. One
-- column, two meanings. It added budget_minutes to hold the sold figure and
-- documented that duration_hours keeps its calendar meaning.
--
-- What it did not do was stop the write, or clean up what was already there.
-- The writer was fixed later (src/index.tsx: "budgetHours is no longer pushed
-- into duration_hours as well"), so new jobs are correct. The rows created
-- before that fix still carry sold labour hours in a calendar column.
--
-- WHY IT MATTERS NOW, not just in theory:
-- The schedule board reads duration_hours * 60 as a day's calendar duration and
-- then plans that much labour for EVERY person on the crew. WO-00003 carries
-- 106.75 — the sold labour on the estimate — so the board shows Green Crew at
-- 320.3 planned hours for a single Monday: 106.75 x 3 people. Against a 90-hour
-- week that reads as 356% booked, and against one 22.5-hour day, 1423%. Both
-- percentages are arithmetically correct; the input is not.
--
-- 106.75 hours is not a duration a single day can have. scheduled_duration_minutes
-- is clamped to 1440 for exactly that reason (src/index.tsx). duration_hours
-- never was, which is how an impossible day got in and stayed.
--
-- THE DETECTION RULE, and why it is deliberately narrow:
--   duration_hours > 24
-- A calendar day cannot be longer than a day, so anything above 24 is
-- definitionally not calendar time. That is a fact about the column, not a
-- guess about intent.
--
-- Rows at or below 24 are LEFT ALONE even though some of them are certainly
-- sold labour too — a 12-hour sold job with three people on it is
-- indistinguishable, in this column, from a genuine 12-hour calendar day. There
-- is no evidence in the data to tell them apart, so this migration does not
-- pretend there is. Fixing the definitely-broken rows and leaving the ambiguous
-- ones is the honest split; the ambiguous ones are also, by construction, the
-- ones whose error is small.
--
-- WHAT HAPPENS TO THE SOLD FIGURE:
-- Nothing is destroyed. Where budget_minutes is still NULL the value moves
-- there first, so what was sold survives in the column 0063 created for it.
-- Where budget_minutes is already populated the estimate has already been
-- snapshotted and duration_hours is simply the stale duplicate.
--
-- ROUND before CAST, per 0078: CAST alone truncates, and binary floating point
-- makes that a real loss rather than a theoretical one (106.75 * 60 is fine,
-- but 2.9 * 100 is 289.99999999999997 and would land as 289).

-- 1. Preserve the sold figure where it was never snapshotted.
UPDATE work_orders
   SET budget_minutes = CAST(ROUND(duration_hours * 60) AS INTEGER)
 WHERE duration_hours IS NOT NULL
   AND duration_hours > 24
   AND budget_minutes IS NULL;

-- 2. Then clear the calendar column. NULL, not 0: "nobody has said how long this
--    blocks" is the truth, and it is what the scheduler already falls back on
--    (src/scheduling/api.ts uses the company productive day when duration is
--    absent). 0 would claim the crew is on site doing nothing.
UPDATE work_orders
   SET duration_hours = NULL
 WHERE duration_hours IS NOT NULL
   AND duration_hours > 24;
