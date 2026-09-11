-- Invoice lifecycle: why a record was voided or archived, and by whom.
--
-- An invoice that has touched money cannot be returned to draft and cannot be
-- hard-deleted (src/api/invoice-lifecycle.ts). What it CAN do is be voided or
-- archived — and that has to leave a record, or "we voided it" becomes an
-- unattributable status change months later.
--
-- Strictly additive: two nullable columns and one new table, all
-- IF NOT EXISTS / nullable, so applying this to a populated database changes no
-- existing row and breaks no existing query. There is deliberately NO foreign
-- key added to payments.invoice_id in this migration — see
-- scripts/reconcile-orphan-payments.mjs for why: orphaned references already
-- exist, and a RESTRICT constraint would fail to apply. That reconciliation is
-- report-only and must be run, and its findings resolved, before any such
-- constraint is considered.

ALTER TABLE invoices ADD COLUMN void_reason TEXT;
ALTER TABLE invoices ADD COLUMN archived_at TEXT;

CREATE TABLE IF NOT EXISTS invoice_lifecycle_events (
  id           TEXT PRIMARY KEY,
  company_id   TEXT NOT NULL,
  invoice_id   TEXT NOT NULL,
  -- 'void' | 'archive' | 'unarchive' | 'delete_refused' | 'draft_refused'
  event        TEXT NOT NULL,
  reason       TEXT,
  -- The lifecycle refusal code when the event records a blocked attempt, so a
  -- pattern of refusals is queryable rather than only readable in prose.
  refusal_code TEXT,
  actor_id     TEXT,
  actor_role   TEXT,
  -- UTC, space-separated, like every other timestamp in this schema.
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_inv_lifecycle_invoice ON invoice_lifecycle_events(company_id, invoice_id);
CREATE INDEX IF NOT EXISTS idx_inv_lifecycle_event   ON invoice_lifecycle_events(company_id, event, created_at);
