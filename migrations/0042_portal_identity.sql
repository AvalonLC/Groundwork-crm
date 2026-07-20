-- Migration 0042: Client portal identity and access model
-- ClientContact, PortalUser, PortalMembership, PropertyAccess, portal sessions,
-- password-reset tokens, and audit-log extensions for portal actors.

-- ── Client contacts — people under a client account ─────────────────────────
CREATE TABLE IF NOT EXISTS client_contacts (
  id          TEXT PRIMARY KEY,
  company_id  TEXT NOT NULL,
  client_id   TEXT NOT NULL,
  name        TEXT NOT NULL DEFAULT '',
  email       TEXT DEFAULT '',
  phone       TEXT DEFAULT '',
  title       TEXT DEFAULT '',            -- e.g. Owner, Property Manager, AP
  is_primary  INTEGER DEFAULT 0,
  active      INTEGER DEFAULT 1,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_ccontacts_client  ON client_contacts(client_id);
CREATE INDEX IF NOT EXISTS idx_ccontacts_company ON client_contacts(company_id);
CREATE INDEX IF NOT EXISTS idx_ccontacts_email   ON client_contacts(email);

-- ── Portal users — a contact with (invited or active) portal login ───────────
CREATE TABLE IF NOT EXISTS portal_users (
  id             TEXT PRIMARY KEY,
  company_id     TEXT NOT NULL,            -- owning contractor company
  contact_id     TEXT DEFAULT '',          -- client_contacts.id
  email          TEXT NOT NULL,            -- login identity (unique per company)
  name           TEXT NOT NULL DEFAULT '',
  phone          TEXT DEFAULT '',
  password_hash  TEXT DEFAULT '',          -- pbkdf2:... ; empty until activated
  status         TEXT NOT NULL DEFAULT 'invited',  -- invited | active | disabled
  invite_token   TEXT DEFAULT '',
  invite_sent_at TEXT DEFAULT '',
  invite_expires_at TEXT DEFAULT '',
  activated_at   TEXT DEFAULT '',
  last_login_at  TEXT DEFAULT '',
  reset_token    TEXT DEFAULT '',
  reset_expires_at TEXT DEFAULT '',
  failed_logins  INTEGER DEFAULT 0,
  locked_until   TEXT DEFAULT '',
  created_by     TEXT DEFAULT '',          -- rep id who invited
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_pusers_email_co ON portal_users(company_id, email);
CREATE INDEX IF NOT EXISTS idx_pusers_invite ON portal_users(invite_token) WHERE invite_token != '';
CREATE INDEX IF NOT EXISTS idx_pusers_reset  ON portal_users(reset_token)  WHERE reset_token  != '';

-- ── Portal memberships — user ↔ client account with role + permissions ──────
CREATE TABLE IF NOT EXISTS portal_memberships (
  id           TEXT PRIMARY KEY,
  company_id   TEXT NOT NULL,
  portal_user_id TEXT NOT NULL,
  client_id    TEXT NOT NULL,
  role         TEXT NOT NULL DEFAULT 'read_only',
  -- role presets: account_admin | billing | project | approver | read_only | custom
  permissions  TEXT NOT NULL DEFAULT '{}',
  -- JSON: {view_projects,view_estimates,approve_estimates,view_billing,
  --        make_payments,view_payment_history,manage_payment_methods,
  --        manage_autopay,view_documents,manage_contacts}
  all_properties INTEGER DEFAULT 1,        -- 1 = all client properties; 0 = via property_access
  active       INTEGER DEFAULT 1,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_pmem_user_client ON portal_memberships(portal_user_id, client_id);
CREATE INDEX IF NOT EXISTS idx_pmem_client ON portal_memberships(client_id);
CREATE INDEX IF NOT EXISTS idx_pmem_user   ON portal_memberships(portal_user_id);

-- ── Property access — explicit per-property grants (when all_properties = 0) ─
CREATE TABLE IF NOT EXISTS property_access (
  id            TEXT PRIMARY KEY,
  membership_id TEXT NOT NULL,
  property_id   TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_pacc_mem_prop ON property_access(membership_id, property_id);

-- ── Portal sessions — dedicated table (separate world from staff sessions) ───
CREATE TABLE IF NOT EXISTS portal_sessions (
  token          TEXT PRIMARY KEY,
  portal_user_id TEXT NOT NULL,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at   TEXT NOT NULL DEFAULT (datetime('now')),
  ip             TEXT DEFAULT '',
  user_agent     TEXT DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_psess_user ON portal_sessions(portal_user_id);

-- ── Audit log extensions — portal actors and request context ────────────────
ALTER TABLE audit_log ADD COLUMN actor_type     TEXT DEFAULT 'staff';  -- staff | portal | system
ALTER TABLE audit_log ADD COLUMN portal_user_id TEXT DEFAULT '';
ALTER TABLE audit_log ADD COLUMN client_id      TEXT DEFAULT '';
ALTER TABLE audit_log ADD COLUMN ip             TEXT DEFAULT '';
