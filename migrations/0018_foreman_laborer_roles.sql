-- ══════════════════════════════════════════════════════════════════════════════
-- Migration 0018 — Promote Foreman & Laborer as First-Class Roles
-- ══════════════════════════════════════════════════════════════════════════════
-- WHAT:
--   1. Rename existing `field_supervisor` rows in the `roles` table → `foreman`
--      (update both the PK id and the label/description/sort_order).
--   2. Insert the `foreman` role for any company that doesn't have it yet.
--   3. Insert the `laborer` role for any company that doesn't have it yet.
--   4. Migrate any reps whose role = 'field_supervisor' → 'foreman'.
--   5. Update the per-company nav_perms JSON in settings to add foreman/laborer
--      keys alongside (or replacing) field_supervisor.
--
-- SAFE TO RE-RUN: All inserts use INSERT OR IGNORE / INSERT OR REPLACE.
--   The UPDATE for reps is idempotent (field_supervisor rows become foreman;
--   re-running finds no field_supervisor rows so is a no-op).
-- ══════════════════════════════════════════════════════════════════════════════

-- ── 1. RENAME field_supervisor → foreman in `roles` table ────────────────────
-- Step 1a: Insert foreman from existing field_supervisor rows (carry permissions)
INSERT OR IGNORE INTO roles (id, company_id, label, color, description, permissions, is_system, sort_order)
SELECT
  'foreman',
  company_id,
  'Foreman',
  '#6B5EA8',
  'Field lead for daily operations, crew execution, work orders, dispatch, and crew time visibility. No Sales or Financial access.',
  COALESCE(
    -- Carry over any custom permissions the company had for field_supervisor
    (SELECT permissions FROM roles r2
      WHERE r2.id = 'field_supervisor' AND r2.company_id = roles.company_id
      LIMIT 1),
    '{"views":["today","myDashboard","scheduleBoard","dispatchBoard","recurringServices","crewView","workOrderList","workOrderDetail","assetList","assetDetail","maintenanceQueue","inventoryList","toolsConsumables","timeTracker","opsReports","teamReports","approvalQueue","fieldMode"],"can_assign_schedule":true,"can_dispatch_crews":true,"can_edit_work_order":true,"can_mark_work_order_complete":true,"can_edit_time":true,"can_approve_time":true,"can_manage_assets":true,"can_manage_inventory":true,"can_approve_requests":true}'
  ),
  1,
  5
FROM roles
WHERE id = 'field_supervisor'
ON CONFLICT(id, company_id) DO NOTHING;

-- Step 1b: For companies that never had field_supervisor, seed foreman from scratch
INSERT OR IGNORE INTO roles (id, company_id, label, color, description, permissions, is_system, sort_order)
SELECT
  'foreman', id,
  'Foreman',
  '#6B5EA8',
  'Field lead for daily operations, crew execution, work orders, dispatch, and crew time visibility. No Sales or Financial access.',
  '{"views":["today","myDashboard","scheduleBoard","dispatchBoard","recurringServices","crewView","workOrderList","workOrderDetail","assetList","assetDetail","maintenanceQueue","inventoryList","toolsConsumables","timeTracker","opsReports","teamReports","approvalQueue","fieldMode"],"can_assign_schedule":true,"can_dispatch_crews":true,"can_edit_work_order":true,"can_mark_work_order_complete":true,"can_edit_time":true,"can_approve_time":true,"can_manage_assets":true,"can_manage_inventory":true,"can_approve_requests":true}',
  1, 5
FROM companies
WHERE active = 1;

-- ── 2. SEED laborer role for all active companies ─────────────────────────────
INSERT OR IGNORE INTO roles (id, company_id, label, color, description, permissions, is_system, sort_order)
SELECT
  'laborer', id,
  'Laborer',
  '#7A7A6E',
  'Self-service field role for assigned jobs, personal schedule, own time tracking, and simple field updates. No dispatch, financial, or admin access.',
  '{"views":["today","scheduleBoard","workOrderList","timeTracker","fieldMode"],"can_mark_work_order_complete":true,"can_edit_time":true}',
  1, 6
FROM companies
WHERE active = 1;

-- ── 3. MIGRATE reps: field_supervisor → foreman ───────────────────────────────
-- Any rep currently stored with role='field_supervisor' becomes 'foreman'.
UPDATE reps
SET role = 'foreman', updated_at = datetime('now')
WHERE role = 'field_supervisor';

-- ── 4. UPDATE nav_perms JSON in settings ─────────────────────────────────────
-- The nav_perms value is a JSON object keyed by role id.
-- We need to add "foreman" and "laborer" keys to any company's stored nav_perms
-- that doesn't already have them, and carry over field_supervisor's value for
-- foreman where one existed.
--
-- SQLite doesn't have built-in JSON object key manipulation, so we handle this
-- at the application layer (bootstrap already falls back to defaultNavPerms for
-- missing keys). The migration below simply updates rows that still have a
-- field_supervisor key but not a foreman key — replacing the full JSON value
-- with a corrected one is safest done via app re-save. We instead clear the
-- stale nav_perms cache so the next bootstrap re-seeds clean defaults.
--
-- Strategy: delete the old nav_perms row so the next login re-bootstraps from
-- the updated defaultNavPerms (which now contains foreman + laborer keys).
-- Companies with custom per-role overrides should re-save from Settings → Roles
-- after logging in. This is the safest path given SQLite's limited JSON ops.
DELETE FROM settings
WHERE key LIKE '%:nav_perms'
  AND (
    value LIKE '%"field_supervisor"%'
    OR value NOT LIKE '%"foreman"%'
    OR value NOT LIKE '%"laborer"%'
  );

-- ── 5. REMOVE field_supervisor system role rows (now superseded by foreman) ───
-- Only removes the system-seeded row. Companies that created a custom
-- field_supervisor role (is_system = 0) keep it — those are intentional.
DELETE FROM roles
WHERE id = 'field_supervisor'
  AND is_system = 1;
