-- Migration 0044: Portal payments — client Stripe customers and autopay
-- Release 2 of the client portal: saved payment methods and autopay live at
-- the CLIENT level (one Stripe Customer per client on the platform account,
-- matching the existing saved-card charge flow in index.tsx).

-- Client-level Stripe customer (code referenced this column but no migration
-- ever created it — self-heal will add it everywhere).
ALTER TABLE clients ADD COLUMN stripe_customer_id TEXT DEFAULT '';

-- One autopay configuration per client. When enabled, invoices are charged
-- to stripe_pm_id automatically when staff sends them (capped by max_amount
-- when > 0).
CREATE TABLE IF NOT EXISTS client_autopay (
  id           TEXT PRIMARY KEY,
  company_id   TEXT NOT NULL,
  client_id    TEXT NOT NULL UNIQUE,
  enabled      INTEGER DEFAULT 0,
  stripe_pm_id TEXT DEFAULT '',
  pm_label     TEXT DEFAULT '',            -- display label, e.g. "Visa •••• 4242"
  max_amount   REAL DEFAULT 0,             -- 0 = no cap (dollars)
  updated_by   TEXT DEFAULT '',            -- portal_user_id or staff rep id
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_autopay_company ON client_autopay(company_id);
