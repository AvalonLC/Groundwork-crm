-- ══════════════════════════════════════════════════════════════════════════════
-- Migration 0013 — Generic Role System + Append-Only Activity Log
-- ══════════════════════════════════════════════════════════════════════════════
-- WHY: The static REPS array in reps.js was hardcoded to tyler/ryan/jen.
-- Any company onboarding needed the same user set. This migration:
--   1. Creates a per-company `roles` table so each company can define their
--      own role hierarchy (admin, office_manager, rep, estimator, view_only,
--      or any custom role they want).
--   2. Creates an append-only `activity_log` table for auditing all mutations
--      (lead created/updated/deleted, note added, status changed, login, etc.)
--   3. Seeds the 5 default roles for every existing company.
--   4. Stores pipeline stages per company in settings so data.js can be
--      dynamically populated rather than hardcoded to Avalon's workflow.
-- ══════════════════════════════════════════════════════════════════════════════

-- ── 1. ROLES TABLE ────────────────────────────────────────────────────────────
-- Each company has its own role set. Built-in role IDs: admin, office_manager,
-- rep, estimator, view_only. Companies can add custom roles (e.g. 'field_tech').
-- `permissions` is a JSON string: { "views": [...], "can_see_all_leads": bool,
--   "can_manage_users": bool, "can_view_financials": bool, ... }
-- `is_system` = 1 means the role was seeded by Groundwork and shouldn't be
-- deleted, but its permissions CAN be edited by the company admin.

CREATE TABLE IF NOT EXISTS roles (
  id            TEXT    NOT NULL,  -- 'admin', 'rep', 'office_manager', custom
  company_id    TEXT    NOT NULL,
  label         TEXT    NOT NULL,
  color         TEXT    NOT NULL DEFAULT '#6F7E6A',
  description   TEXT    NOT NULL DEFAULT '',
  permissions   TEXT    NOT NULL DEFAULT '{}',  -- JSON
  is_system     INTEGER NOT NULL DEFAULT 0,
  sort_order    INTEGER NOT NULL DEFAULT 99,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (id, company_id)
);

CREATE INDEX IF NOT EXISTS idx_roles_company ON roles(company_id);

-- ── 2. ACTIVITY LOG TABLE ─────────────────────────────────────────────────────
-- Append-only audit log. NEVER UPDATE OR DELETE rows in this table.
-- Every create/update/delete/login/stage-change is logged here.
-- `before_json` and `after_json` store the relevant fields (not full objects).
-- `entity_type`: 'opportunity' | 'client' | 'note' | 'rep' | 'company' |
--                'role' | 'session' | 'commission' | 'pipeline_stage'
-- `action`:      'created' | 'updated' | 'deleted' | 'login' | 'logout' |
--                'status_changed' | 'assigned' | 'invited' | 'password_reset'

CREATE TABLE IF NOT EXISTS activity_log (
  id            TEXT    NOT NULL PRIMARY KEY,
  company_id    TEXT    NOT NULL,
  actor_id      TEXT    NOT NULL DEFAULT '',  -- rep_id who performed the action
  actor_name    TEXT    NOT NULL DEFAULT '',  -- denormalized for fast display
  entity_type   TEXT    NOT NULL,
  entity_id     TEXT    NOT NULL DEFAULT '',
  entity_label  TEXT    NOT NULL DEFAULT '',  -- e.g. client name for quick display
  action        TEXT    NOT NULL,
  before_json   TEXT    NOT NULL DEFAULT '',  -- JSON snapshot before change
  after_json    TEXT    NOT NULL DEFAULT '',  -- JSON snapshot after change
  ip_address    TEXT    NOT NULL DEFAULT '',
  user_agent    TEXT    NOT NULL DEFAULT '',
  created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_activity_company    ON activity_log(company_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_activity_entity     ON activity_log(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_activity_actor      ON activity_log(actor_id, created_at DESC);

-- ── 3. SEED DEFAULT ROLES FOR ALL EXISTING COMPANIES ─────────────────────────
-- Uses INSERT OR IGNORE so re-running the migration is safe.
-- permissions JSON encodes: views (nav tabs accessible), plus booleans for
-- cross-cutting capabilities like seeing all leads, managing users, etc.

-- ─── admin (Owner/Admin) ────────────────────────────────────────────────────
INSERT OR IGNORE INTO roles (id, company_id, label, color, description, permissions, is_system, sort_order)
SELECT
  'admin', id,
  'Owner / Admin',
  '#4D8A86',
  'Full access to all sections including financial data, user management, and settings.',
  '{"views":["today","myDashboard","pipeline","lead","clients","process","forms","scripts","templates","objections","calculator","academy","manager","revenueAdmin","integrations","userManagement","settings","ai","timeTracker"],"can_see_all_leads":true,"can_manage_users":true,"can_view_financials":true,"can_edit_roles":true,"can_export":true}',
  1, 1
FROM companies WHERE active = 1;

-- ─── office_manager ─────────────────────────────────────────────────────────
INSERT OR IGNORE INTO roles (id, company_id, label, color, description, permissions, is_system, sort_order)
SELECT
  'office_manager', id,
  'Office Manager',
  '#8B6914',
  'Operations and admin access. Sees ALL leads across all reps. Can manage most settings.',
  '{"views":["today","myDashboard","pipeline","lead","clients","process","forms","scripts","templates","objections","calculator","academy","manager","integrations","settings","ai","timeTracker"],"can_see_all_leads":true,"can_manage_users":false,"can_view_financials":false,"can_edit_roles":false,"can_export":true}',
  1, 2
FROM companies WHERE active = 1;

-- ─── rep (Sales Rep) ────────────────────────────────────────────────────────
INSERT OR IGNORE INTO roles (id, company_id, label, color, description, permissions, is_system, sort_order)
SELECT
  'rep', id,
  'Sales Rep',
  '#2D7A55',
  'Standard rep access. Today, pipeline (own leads), clients, and full sales toolkit.',
  '{"views":["today","myDashboard","pipeline","lead","clients","process","forms","scripts","templates","objections","calculator","academy","settings","ai","timeTracker"],"can_see_all_leads":false,"can_manage_users":false,"can_view_financials":false,"can_edit_roles":false,"can_export":false}',
  1, 3
FROM companies WHERE active = 1;

-- ─── estimator ──────────────────────────────────────────────────────────────
INSERT OR IGNORE INTO roles (id, company_id, label, color, description, permissions, is_system, sort_order)
SELECT
  'estimator', id,
  'Estimator',
  '#4D8A86',
  'Access to pipeline, pricing tools, forms, and process docs. Cannot create or close leads.',
  '{"views":["today","pipeline","clients","process","forms","calculator","settings"],"can_see_all_leads":false,"can_manage_users":false,"can_view_financials":false,"can_edit_roles":false,"can_export":false}',
  1, 4
FROM companies WHERE active = 1;

-- ─── view_only ──────────────────────────────────────────────────────────────
INSERT OR IGNORE INTO roles (id, company_id, label, color, description, permissions, is_system, sort_order)
SELECT
  'view_only', id,
  'View Only',
  '#6F7E6A',
  'Read-only access to Today dashboard and Pipeline. Cannot create or edit any records.',
  '{"views":["today","pipeline","settings"],"can_see_all_leads":false,"can_manage_users":false,"can_view_financials":false,"can_edit_roles":false,"can_export":false}',
  1, 5
FROM companies WHERE active = 1;

-- ── 4. SEED DEFAULT PIPELINE STAGES PER COMPANY ──────────────────────────────
-- Stored as {companyId}:pipeline_stages in settings (JSON array of strings).
-- This allows each company to customize their pipeline without changing code.
-- Groundwork ships with the 9-stage lawn/landscape default; companies can
-- add/remove/rename stages from Settings → Pipeline Config.

INSERT OR IGNORE INTO settings (key, value, updated_at)
SELECT
  id || ':pipeline_stages',
  '["Lead Intake / Rapport","Mutual Agreement Set","Discovery / CBR Uncovered","Budget & Investment Qualified","Decision Process Qualified","Presentation & SOW Pitch","Deal Closed / Won","On Hold","Closed Lost"]',
  datetime('now')
FROM companies WHERE active = 1;

-- ── 5. NAV_PERMS MIGRATION ────────────────────────────────────────────────────
-- Store nav permissions per company in settings as {companyId}:nav_perms.
-- The value is JSON mirroring DEFAULT_NAV_PERMS shape:
--   { "admin": [...views], "office_manager": [...views], "rep": [...views], ... }
-- This replaces the localStorage 'avalonNavPermissions' key as source of truth.
-- Frontend reads this from the login response and caches locally.

INSERT OR IGNORE INTO settings (key, value, updated_at)
SELECT
  id || ':nav_perms',
  '{"admin":["today","myDashboard","pipeline","lead","clients","process","forms","scripts","templates","objections","calculator","academy","manager","revenueAdmin","integrations","userManagement","settings","ai","timeTracker"],"office_manager":["today","myDashboard","pipeline","lead","clients","process","forms","scripts","templates","objections","calculator","academy","manager","integrations","settings","ai","timeTracker"],"rep":["today","myDashboard","pipeline","lead","clients","process","forms","scripts","templates","objections","calculator","academy","settings","ai","timeTracker"],"estimator":["today","pipeline","clients","process","forms","calculator","settings"],"view_only":["today","pipeline","settings"]}',
  datetime('now')
FROM companies WHERE active = 1;
