-- Migration 0074: who is allowed to see what people are paid
--
-- Tyler's rule: office staff see compensation only if granted
-- can_view_compensation. Owners and admins have it by default; crew members and
-- standard office roles do not.
--
-- A column on reps rather than a nav permission, because this is not a screen.
-- The existing permission system (DEFAULT_NAV_PERMS, _gwRoles.permissions.views)
-- answers "which pages can you open", and wages appear inside pages people are
-- otherwise entitled to open — the Budget screen, a crew card, a job's costing.
-- Gating the page would take away the whole screen; gating the field is the
-- actual requirement.
--
-- Default 0, deliberately. Every existing non-admin rep starts without it, which
-- is the safe direction to be wrong in: someone who should see rates and cannot
-- says so within the hour, whereas someone who should not and can says nothing
-- at all.
--
-- Admins are NOT backfilled to 1. Their access comes from their role at read
-- time, so it stays correct when a role changes — flipping someone from admin to
-- office_manager should remove the access, and a backfilled flag would silently
-- keep it.

ALTER TABLE reps ADD COLUMN can_view_compensation INTEGER NOT NULL DEFAULT 0;

-- Answers "who in this company can see pay", which is the question an audit
-- asks and the one the permission editor renders.
CREATE INDEX IF NOT EXISTS idx_reps_compensation
  ON reps(company_id, can_view_compensation);
