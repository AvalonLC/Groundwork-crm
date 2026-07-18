-- ============================================================
-- Groundwork CRM — Migration 0006
-- Platform Owner Identity Separation
--
-- Creates the "Groundwork Platform" company and the
-- tyler@groundwork-crm.com rep with is_super_admin=1.
-- This identity is completely separate from tyler@avalon-lc.com
-- (Tyler Jones, Owner of the Avalon Landscaping tenant).
--
-- Login flow: /platform-login (dedicated URL, email + PIN)
-- Cookie: avalon_session  (same cookie name, separate token)
-- Post-login: auto-navigates to superAdmin() dashboard
-- ============================================================

-- ── Groundwork Platform "company" ────────────────────────────
-- This is NOT a customer tenant — it is the platform owner's
-- anchor record so company_id NOT NULL constraint is satisfied.
-- It will never appear in the /api/admin/companies customer list
-- because we filter WHERE id != 'groundwork_platform' there.
INSERT OR IGNORE INTO companies (
  id, name, slug, plan, owner_email, website, active
) VALUES (
  'groundwork_platform',
  'Groundwork CRM (Platform)',
  'groundwork',
  'enterprise',
  'tyler@groundwork-crm.com',
  'groundwork-crm.com',
  1
);

-- ── Platform owner rep ────────────────────────────────────────
-- id         : 'gw_tyler'   (distinct from Avalon 'tyler')
-- company_id : 'groundwork_platform'
-- role       : 'admin'
-- is_super_admin : 1
-- email      : tyler@groundwork-crm.com  (used for /platform-login)
-- pin        : '0000' placeholder — replaced immediately via /api/auth/set-platform-pin
--              or via the PIN-reset flow once email is confirmed
-- NOTE: Default PIN set to '1234' for initial setup.
--       CHANGE THIS immediately after first login via Settings → Change PIN,
--       or run:
--         wrangler d1 execute webapp-production --command \
--           "UPDATE reps SET pin='',pin_hash='<hash>' WHERE id='gw_tyler'"
INSERT OR IGNORE INTO reps (
  id, name, title, role, pin, color,
  base_rate, commission_plan, active,
  company_id, is_super_admin, email
) VALUES (
  'gw_tyler',
  'Tyler Johnson',
  'Platform Owner',
  'admin',
  '1234',
  '#204A43',
  0,
  'standard',
  1,
  'groundwork_platform',
  1,
  'tyler@groundwork-crm.com'
);
