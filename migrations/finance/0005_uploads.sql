-- Financial Setup & AI Onboarding (Part 2, 2026-08-06): tracks every file
-- uploaded through /finance/onboarding so the confidence-gap report can
-- answer "any financial exports / receipts ever, and were they clean?"
-- persistently — nothing else durably records that a financial export was
-- ever ingested (ingestFile only leaves per-line action_items behind).
CREATE TABLE upload_batch (
  id                  TEXT PRIMARY KEY,
  tenant_id           TEXT NOT NULL,
  filename            TEXT NOT NULL,
  domain              TEXT NOT NULL CHECK (domain IN ('financial_export','receipt','unrecognized')),
  detected_source_id  TEXT,          -- ingest.sources.json id, when domain='financial_export' and matched
  needs_review        INTEGER NOT NULL DEFAULT 0, -- 0/1 boolean
  row_count           INTEGER,       -- financial_export: total_rows; null otherwise
  created_at          TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_upload_batch_tenant ON upload_batch(tenant_id, domain, created_at);
