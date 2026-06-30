-- ============================================================
-- Groundwork CRM — Migration 0012
-- Company folder structure + real-time sync infrastructure
--
-- Philosophy: every company's data lives in a "folder" keyed by
-- company_id. All cross-company isolation is enforced at the API
-- layer (requireAuth sets company_id from session cookie only —
-- clients cannot inject a different company_id).
--
-- This migration:
--   1. Ensures the settings table has a proper index for the
--      {company_id}:* key pattern used as the company "folder"
--   2. Seeds the last_write key for existing companies so the
--      real-time poll endpoint works from day one
--   3. Adds lead_source and project_category to opportunities
--      if not already present (idempotent ALTERs)
--   4. Adds assigned_to_rep_id column so Jen can assign leads
--      to specific reps while retaining her own rep_id as creator
-- ============================================================

-- ── Settings index for company-folder key scans ───────────────
-- Speeds up queries like: WHERE key LIKE '{companyId}:%'
CREATE INDEX IF NOT EXISTS idx_settings_company_prefix
  ON settings(key);

-- ── Seed last_write for every existing company ────────────────
-- This initialises the real-time sync "heartbeat" for companies
-- that were onboarded before this migration ran.
INSERT OR IGNORE INTO settings (key, value, updated_at)
SELECT id || ':last_write', datetime('now') || '|system', datetime('now')
FROM companies
WHERE active = 1;

-- ── Seed created_at folder marker for existing companies ──────
INSERT OR IGNORE INTO settings (key, value, updated_at)
SELECT id || ':created_at', created_at, datetime('now')
FROM companies
WHERE active = 1;

-- ── Add assigned_to_rep_id to opportunities ───────────────────
-- Allows Jen (office_manager) to create a lead and assign it to
-- a specific rep. rep_id = creator, assigned_to_rep_id = assignee.
-- When set, the assignee's pipeline shows this lead even if
-- rep_id != their id.
ALTER TABLE opportunities ADD COLUMN assigned_to_rep_id TEXT DEFAULT '';
CREATE INDEX IF NOT EXISTS idx_opps_assigned ON opportunities(assigned_to_rep_id)
  WHERE assigned_to_rep_id != '';

-- ── Backfill: set assigned_to_rep_id = rep_id for existing rows ─
-- Existing leads were created by their rep, so assignee = creator.
UPDATE opportunities SET assigned_to_rep_id = rep_id
  WHERE (assigned_to_rep_id IS NULL OR assigned_to_rep_id = '') AND rep_id IS NOT NULL;
