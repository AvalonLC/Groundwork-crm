-- Migration 0083: work order archive/soft-delete + time entry adjustments
--
-- Finance OS fix plan items 4 and 5.
--
-- ITEM 4 — work-order delete vs Finance data:
-- DELETE /api/work-orders/:id previously left open action_item rows
-- (verb='collect' etc, source_type='work_order') pointing at nothing once
-- the work order was gone, and never checked whether the job had posted
-- financial activity (job_cost_ledger rows, posted time_entries) before
-- deleting it. job_cost_ledger.job_id is NOT NULL REFERENCES
-- work_orders(id) with no ON DELETE clause (migrations/0057_finance_merge.sql)
-- — that FK is being kept exactly as-is, on purpose: financial rows must
-- never be allowed to go orphaned. So hard deletion of a work order with
-- posted costs has to be refused outright rather than "fixed" by loosening
-- the FK. Completed/unwanted jobs that already have real cost history still
-- need a way to leave the active views, hence an archive (soft-delete) path
-- that carries no FK implications at all.
ALTER TABLE work_orders ADD COLUMN archived_at TEXT DEFAULT NULL;
ALTER TABLE work_orders ADD COLUMN archived_by TEXT DEFAULT NULL;
CREATE INDEX IF NOT EXISTS idx_work_orders_archived ON work_orders(company_id, archived_at);

-- ITEM 5 — posted time entries must not be edited or deleted in place:
-- PUT /api/time/entries/:id and DELETE /api/time/entries/:id used to allow
-- changing or removing an entry after src/api/posting.ts had already posted
-- its two job_cost_ledger lines (labor + overhead), silently corrupting job
-- costing with no record that a correction ever happened. POSTING.md's
-- immutability rule ("time_entry.resolved_rate and .applied_overhead are
-- written ONCE at posting and never recomputed") already covers the ledger
-- lines and the posting fields themselves; this table is what lets a
-- correction happen anyway, without mutating either: a reversal row that
-- negates the original entry's posted ledger impact, paired with a
-- corrected replacement entry, both referencing the original for audit
-- trail. Nothing about an already-posted time_entries row or its
-- job_cost_ledger lines is ever UPDATEd or DELETEd by this mechanism.
CREATE TABLE time_entry_adjustments (
  id                    TEXT PRIMARY KEY,
  company_id            TEXT NOT NULL,
  original_entry_id     TEXT NOT NULL REFERENCES time_entries(id),
  reversal_entry_id     TEXT NOT NULL REFERENCES time_entries(id),
  replacement_entry_id  TEXT REFERENCES time_entries(id), -- NULL if this was a pure reversal (e.g. entry logged in error), not a correction
  reason                TEXT NOT NULL,
  created_by            TEXT NOT NULL,
  created_at            TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_time_entry_adjustments_original ON time_entry_adjustments(company_id, original_entry_id);
