-- ══════════════════════════════════════════════════════════════════════════════
-- Migration 0028 — Field Operations: Equipment Reports, After Action Reports,
--                   Division Manager Role
-- ══════════════════════════════════════════════════════════════════════════════

-- ── 1. Equipment / Field Reports ─────────────────────────────────────────────
-- Submitted by laborers/foremen when something is broken, needs supplies, etc.
-- Visible to owner, admin, office_manager, division_manager.
CREATE TABLE IF NOT EXISTS field_reports (
  id            TEXT PRIMARY KEY,
  company_id    TEXT NOT NULL,
  rep_id        TEXT NOT NULL,          -- who submitted
  crew_id       TEXT,                   -- their crew (optional)
  report_type   TEXT NOT NULL DEFAULT 'equipment',  -- 'equipment' | 'supplies' | 'vehicle' | 'safety' | 'other'
  title         TEXT NOT NULL,
  description   TEXT NOT NULL,
  priority      TEXT NOT NULL DEFAULT 'normal',     -- 'low' | 'normal' | 'urgent'
  status        TEXT NOT NULL DEFAULT 'open',       -- 'open' | 'in_review' | 'resolved'
  resolved_by   TEXT,
  resolved_note TEXT,
  asset_id      TEXT,                   -- linked asset/tool (optional)
  photo_url     TEXT,                   -- optional photo
  work_order_id TEXT,                   -- linked WO if relevant
  created_at    DATETIME DEFAULT (datetime('now')),
  updated_at    DATETIME DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_field_reports_company ON field_reports(company_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_field_reports_rep     ON field_reports(rep_id, company_id);
CREATE INDEX IF NOT EXISTS idx_field_reports_status  ON field_reports(status, company_id);

-- ── 2. AAR Templates ─────────────────────────────────────────────────────────
-- Owner/OM/division_manager configures questions field workers answer before
-- they can clock out. One active template per company at a time.
CREATE TABLE IF NOT EXISTS aar_templates (
  id            TEXT PRIMARY KEY,
  company_id    TEXT NOT NULL UNIQUE,    -- one active template per company
  title         TEXT NOT NULL DEFAULT 'End-of-Day Field Report',
  intro_text    TEXT DEFAULT 'Please complete this quick report before clocking out.',
  questions     TEXT NOT NULL DEFAULT '[]',   -- JSON array of question objects
  -- question shape: { id, type, label, required, options? }
  -- types: 'yesno' | 'text' | 'rating' | 'checklist' | 'select'
  require_before_clockout  INTEGER NOT NULL DEFAULT 1,
  created_by    TEXT,
  created_at    DATETIME DEFAULT (datetime('now')),
  updated_at    DATETIME DEFAULT (datetime('now'))
);

-- ── 3. AAR Submissions ────────────────────────────────────────────────────────
-- One row per field worker per shift (linked to their time_entry).
CREATE TABLE IF NOT EXISTS aar_submissions (
  id            TEXT PRIMARY KEY,
  company_id    TEXT NOT NULL,
  rep_id        TEXT NOT NULL,
  time_entry_id TEXT,                    -- the shift this AAR closes out
  work_date     TEXT NOT NULL,           -- YYYY-MM-DD
  answers       TEXT NOT NULL DEFAULT '{}',  -- JSON: { question_id: answer_value }
  submitted_at  DATETIME DEFAULT (datetime('now')),
  reviewed_by   TEXT,
  reviewed_at   DATETIME,
  review_note   TEXT,
  flagged       INTEGER NOT NULL DEFAULT 0   -- 1 = manager flagged for follow-up
);
CREATE INDEX IF NOT EXISTS idx_aar_submissions_company ON aar_submissions(company_id, work_date DESC);
CREATE INDEX IF NOT EXISTS idx_aar_submissions_rep     ON aar_submissions(rep_id, work_date DESC);

-- ── 4. Division Manager Role ──────────────────────────────────────────────────
-- Sees all crews/assets/jobs in their division regardless of assignment.
-- Can still work in the field. Does NOT see company-wide financials or other
-- divisions (those stay with owner/admin/OM).
INSERT OR IGNORE INTO roles (id, company_id, label, color, description, permissions, is_system, sort_order)
SELECT
  'division_manager', id,
  'Division Manager',
  '#4D8A86',
  'Oversees all crews, assets, jobs, and personnel in their division. Full operations visibility (not just assigned). Can manage field ops, approve time, submit and review field reports. No cross-division financials or admin settings.',
  '{"views":["gwDashboard","gwOperations","gwAdmin","fieldDashboard","today","scheduleBoard","dispatchBoard","recurringServices","gwRecurringPlans","crewView","workOrderList","workOrderDetail","assetList","assetDetail","maintenanceQueue","inventoryList","toolsConsumables","timeTracker","gwTimesheetAdmin","opsReports","teamReports","approvalQueue","fieldMode","userManagement"],"can_assign_schedule":true,"can_dispatch_crews":true,"can_edit_work_order":true,"can_mark_work_order_complete":true,"can_edit_time":true,"can_approve_time":true,"can_manage_assets":true,"can_manage_inventory":true,"can_approve_requests":true,"can_view_all_division":true,"can_review_aar":true,"can_review_field_reports":true}',
  1, 4
FROM companies
WHERE active = 1;

-- ── 5. Seed default AAR template for existing companies ───────────────────────
INSERT OR IGNORE INTO aar_templates (id, company_id, title, intro_text, questions, require_before_clockout)
SELECT
  'aar-' || id, id,
  'End-of-Day Field Report',
  'Quick check before you clock out — takes about 2 minutes.',
  '[
    {"id":"q1","type":"yesno","label":"Did you complete all assigned work orders for today?","required":true},
    {"id":"q2","type":"yesno","label":"Did any equipment break or require service today?","required":true},
    {"id":"q3","type":"yesno","label":"Were there any safety incidents or near-misses?","required":true},
    {"id":"q4","type":"yesno","label":"Do you need any supplies or materials restocked?","required":false},
    {"id":"q5","type":"text","label":"Any notes for tomorrows crew or manager?","required":false},
    {"id":"q6","type":"rating","label":"How did the day go overall? (1 = rough, 5 = great)","required":false}
  ]',
  1
FROM companies
WHERE active = 1;
