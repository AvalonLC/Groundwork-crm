-- ── Estimates v2 ────────────────────────────────────────────────────────────
-- Dedicated estimates table with full estimate lifecycle support.
-- Linked to opportunities (opp_id) when created from a lead, but can also
-- stand alone as client-direct estimates.

CREATE TABLE IF NOT EXISTS estimates (
  id                TEXT PRIMARY KEY,
  company_id        TEXT NOT NULL,
  est_number        TEXT NOT NULL DEFAULT '',      -- e.g. "EST-0042"
  title             TEXT NOT NULL DEFAULT '',
  scope_of_work     TEXT DEFAULT '',               -- rich scope textarea
  client_id         TEXT DEFAULT '',               -- link to clients table
  client_name       TEXT NOT NULL DEFAULT '',
  client_email      TEXT DEFAULT '',
  client_phone      TEXT DEFAULT '',
  client_address    TEXT DEFAULT '',
  property_id       TEXT DEFAULT '',
  property_addr     TEXT DEFAULT '',
  opp_id            TEXT DEFAULT '',               -- linked opportunity if any
  rep_id            TEXT DEFAULT '',               -- owner/creator
  assigned_to       TEXT DEFAULT '',

  -- Status lifecycle: draft → sent → viewed → accepted | declined | changes_requested
  -- | expired | invoiced
  status            TEXT NOT NULL DEFAULT 'draft', -- draft|sent|viewed|accepted|declined|changes_requested|expired|invoiced

  -- Engagement signals
  sent_at           TEXT DEFAULT '',
  viewed_at         TEXT DEFAULT '',
  accepted_at       TEXT DEFAULT '',
  declined_at       TEXT DEFAULT '',
  changes_at        TEXT DEFAULT '',
  last_followed_up  TEXT DEFAULT '',
  send_method       TEXT DEFAULT '',               -- email|sms|both

  -- Financial
  subtotal          REAL DEFAULT 0,
  discount_pct      REAL DEFAULT 0,
  discount_amt      REAL DEFAULT 0,
  tax_pct           REAL DEFAULT 0,
  tax_amt           REAL DEFAULT 0,
  total             REAL DEFAULT 0,
  deposit_pct       REAL DEFAULT 30,
  deposit_amt       REAL DEFAULT 0,
  deposit_paid      INTEGER DEFAULT 0,

  -- Structured data (JSON)
  line_items        TEXT DEFAULT '[]',             -- [{id,name,desc,qty,unit,rate,total}]
  attachments       TEXT DEFAULT '[]',             -- [{id,name,url,type,size}]
  internal_notes    TEXT DEFAULT '',
  customer_notes    TEXT DEFAULT '',
  terms             TEXT DEFAULT '',

  -- Portal / invoice
  portal_token      TEXT DEFAULT '',               -- public share token
  invoice_id        TEXT DEFAULT '',               -- set when converted to invoice
  decline_reason    TEXT DEFAULT '',
  change_request    TEXT DEFAULT '',

  -- Dates
  estimate_date     TEXT DEFAULT '',
  expiry_date       TEXT DEFAULT '',
  created_at        TEXT DEFAULT (datetime('now')),
  updated_at        TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_estimates_company   ON estimates(company_id);
CREATE INDEX IF NOT EXISTS idx_estimates_client    ON estimates(client_id);
CREATE INDEX IF NOT EXISTS idx_estimates_opp       ON estimates(opp_id);
CREATE INDEX IF NOT EXISTS idx_estimates_status    ON estimates(company_id, status);
CREATE INDEX IF NOT EXISTS idx_estimates_rep       ON estimates(rep_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_estimates_portal ON estimates(portal_token) WHERE portal_token != '';
