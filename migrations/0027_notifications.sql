-- Migration 0027: Notifications + Estimate Portal Tokens

-- In-app notifications per company
CREATE TABLE IF NOT EXISTS notifications (
  id          TEXT PRIMARY KEY,
  company_id  TEXT NOT NULL,
  rep_id      TEXT DEFAULT '',      -- target rep (empty = all admins)
  type        TEXT NOT NULL,        -- estimate_approved | estimate_declined | invoice_paid |
                                    -- wo_completed | new_lead | review_received | system
  title       TEXT NOT NULL,
  body        TEXT DEFAULT '',
  entity_type TEXT DEFAULT '',      -- estimate | invoice | work_order | lead | review
  entity_id   TEXT DEFAULT '',
  action_url  TEXT DEFAULT '',      -- hash-based navigation: #gwSales, #invoices etc.
  is_read     INTEGER DEFAULT 0,
  created_at  TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_notifications_company    ON notifications(company_id);
CREATE INDEX IF NOT EXISTS idx_notifications_rep        ON notifications(rep_id);
CREATE INDEX IF NOT EXISTS idx_notifications_unread     ON notifications(company_id, is_read);
CREATE INDEX IF NOT EXISTS idx_notifications_created    ON notifications(company_id, created_at DESC);

-- Estimate portal tokens (for client-facing approval links)
CREATE TABLE IF NOT EXISTS estimate_portal_tokens (
  token       TEXT PRIMARY KEY,
  company_id  TEXT NOT NULL,
  estimate_id TEXT NOT NULL,
  client_email TEXT DEFAULT '',
  expires_at  TEXT DEFAULT '',
  used_at     TEXT DEFAULT '',
  created_at  TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_est_portal_estimate ON estimate_portal_tokens(estimate_id);

-- Seed a welcome notification for Avalon
INSERT OR IGNORE INTO notifications (id, company_id, rep_id, type, title, body, entity_type, action_url)
VALUES (
  'notif_welcome_avalon',
  'avalon',
  '',
  'system',
  'Welcome to Groundwork CRM!',
  'Your account is set up and ready. Start by adding clients, creating estimates, and scheduling work orders.',
  '',
  '#gwDashboard'
);
