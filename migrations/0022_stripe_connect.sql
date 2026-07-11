-- Migration 0022: Stripe Connect Platform fields
-- Adds Stripe Connect fields to companies, estimates, and a new payments table

-- Company-level Stripe Connect
ALTER TABLE companies ADD COLUMN stripe_account_id     TEXT DEFAULT '';
ALTER TABLE companies ADD COLUMN stripe_onboarded      INTEGER DEFAULT 0;
ALTER TABLE companies ADD COLUMN stripe_charges_enabled INTEGER DEFAULT 0;
ALTER TABLE companies ADD COLUMN stripe_platform_fee_pct REAL DEFAULT 2.9;

-- Stripe fields on estimates (for deposit payment intents)
ALTER TABLE estimates ADD COLUMN payment_intent_id     TEXT DEFAULT '';
ALTER TABLE estimates ADD COLUMN stripe_payment_status TEXT DEFAULT '';
ALTER TABLE estimates ADD COLUMN deposit_paid_at       TEXT DEFAULT '';
ALTER TABLE estimates ADD COLUMN deposit_paid_amount   REAL DEFAULT 0;

-- Standalone payments log table
CREATE TABLE IF NOT EXISTS payments (
  id                TEXT PRIMARY KEY,
  company_id        TEXT NOT NULL,
  estimate_id       TEXT,
  invoice_id        TEXT,
  client_id         TEXT,
  amount            REAL NOT NULL DEFAULT 0,
  fee_amount        REAL NOT NULL DEFAULT 0,
  net_amount        REAL NOT NULL DEFAULT 0,
  currency          TEXT DEFAULT 'usd',
  stripe_payment_intent_id TEXT DEFAULT '',
  stripe_charge_id  TEXT DEFAULT '',
  status            TEXT DEFAULT 'pending',
  payment_method    TEXT DEFAULT 'card',
  description       TEXT DEFAULT '',
  metadata          TEXT DEFAULT '{}',
  created_at        TEXT DEFAULT (datetime('now')),
  updated_at        TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_payments_company ON payments(company_id);
CREATE INDEX IF NOT EXISTS idx_payments_estimate ON payments(estimate_id);
CREATE INDEX IF NOT EXISTS idx_payments_invoice  ON payments(invoice_id);
CREATE INDEX IF NOT EXISTS idx_payments_client   ON payments(client_id);
CREATE INDEX IF NOT EXISTS idx_payments_status   ON payments(status);
