-- Migration 0023: Invoices table + line items
-- Full invoice system with Stripe payment tracking

CREATE TABLE IF NOT EXISTS invoices (
  id                TEXT PRIMARY KEY,
  company_id        TEXT NOT NULL,
  invoice_number    TEXT NOT NULL DEFAULT '',
  estimate_id       TEXT DEFAULT '',
  client_id         TEXT DEFAULT '',
  client_name       TEXT DEFAULT '',
  client_email      TEXT DEFAULT '',
  client_phone      TEXT DEFAULT '',
  client_address    TEXT DEFAULT '',
  title             TEXT DEFAULT '',
  status            TEXT DEFAULT 'draft',
  -- statuses: draft | sent | viewed | partial | paid | overdue | void | written_off
  subtotal          REAL DEFAULT 0,
  tax_rate          REAL DEFAULT 0,
  tax_amount        REAL DEFAULT 0,
  discount_amount   REAL DEFAULT 0,
  total             REAL DEFAULT 0,
  amount_paid       REAL DEFAULT 0,
  balance_due       REAL DEFAULT 0,
  currency          TEXT DEFAULT 'usd',
  due_date          TEXT DEFAULT '',
  sent_at           TEXT DEFAULT '',
  viewed_at         TEXT DEFAULT '',
  paid_at           TEXT DEFAULT '',
  voided_at         TEXT DEFAULT '',
  portal_token      TEXT DEFAULT '',
  payment_intent_id TEXT DEFAULT '',
  stripe_payment_status TEXT DEFAULT '',
  notes             TEXT DEFAULT '',
  internal_notes    TEXT DEFAULT '',
  line_items        TEXT DEFAULT '[]',
  -- JSON: [{id, description, qty, unit, unit_price, total, taxable}]
  terms             TEXT DEFAULT 'Net 30',
  footer_note       TEXT DEFAULT '',
  created_at        TEXT DEFAULT (datetime('now')),
  updated_at        TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_invoices_company  ON invoices(company_id);
CREATE INDEX IF NOT EXISTS idx_invoices_client   ON invoices(client_id);
CREATE INDEX IF NOT EXISTS idx_invoices_estimate ON invoices(estimate_id);
CREATE INDEX IF NOT EXISTS idx_invoices_status   ON invoices(status);
CREATE INDEX IF NOT EXISTS idx_invoices_due_date ON invoices(due_date);
CREATE INDEX IF NOT EXISTS idx_invoices_portal   ON invoices(portal_token);

-- Add invoice_id to payments (reference link)
ALTER TABLE payments ADD COLUMN invoice_number TEXT DEFAULT '';

-- Seed: auto-increment counter per company
CREATE TABLE IF NOT EXISTS invoice_counters (
  company_id TEXT PRIMARY KEY,
  last_number INTEGER DEFAULT 0
);

INSERT OR IGNORE INTO invoice_counters (company_id, last_number) VALUES ('avalon', 0);
