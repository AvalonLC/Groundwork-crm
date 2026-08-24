-- Migration 0084: literal status column on receipt / upload_batch
--
-- Finance OS Item 1 gap-fix (Tyler, 2026-08-22 decisions): "All new
-- documents should enter pending_review status; ingest never creates
-- posted ledger entries directly." Before this migration, `receipt` and
-- `upload_batch` had no status enum at all -- only a derived
-- needs_review boolean (upload_batch) or a field_confidence blob a page
-- had to re-parse to guess at review state (receipt, via
-- needsReviewFromConfidence in documents.tsx). Neither ever wrote a
-- literal lifecycle status, and neither could represent "reviewed and
-- approved" vs. "reviewed and rejected" at all.
--
-- This does NOT change what already existed: needs_review keeps working
-- exactly as before (still read by onboarding.tsx's confidence-gap
-- report), and nothing about receipt/upload_batch ever posts to
-- job_cost_ledger either before or after this migration -- that
-- invariant was already true (grep-confirmed, no receipt/upload_batch
-- code path touches job_cost_ledger) and this migration doesn't add one.
-- It only adds a queryable, literal lifecycle field so "pending_review"
-- is a real value instead of an implicit default nobody could ask for
-- directly.

ALTER TABLE receipt ADD COLUMN status TEXT NOT NULL DEFAULT 'pending_review'
  CHECK (status IN ('pending_review', 'approved', 'rejected'));
CREATE INDEX idx_receipt_status ON receipt(company_id, status);

-- Also Item 1 (Tyler, 2026-08-22): "duplicate detection: document hash +
-- vendor + date + receipt/invoice number + total". Content-hash dedupe
-- (idx_receipt_dedupe, migration 0057) only catches byte-for-byte
-- identical files -- a photo of the same paper receipt taken twice, or a
-- re-scanned copy, produces different bytes and was never caught before
-- this. receipt_number is nullable: not every receipt has one visible
-- (e.g. a handwritten slip), and its absence must not block upload --
-- see findLikelyDuplicateReceipt in src/ai/receipts.ts, which treats a
-- vendor+date+total match with no receipt_number on either side as a
-- WEAKER (still-surfaced, not silently blocking) signal than an exact
-- vendor+date+receipt_number+total match.
ALTER TABLE receipt ADD COLUMN receipt_number TEXT DEFAULT NULL;
CREATE INDEX idx_receipt_fuzzy_dedupe ON receipt(company_id, vendor, receipt_date, amount_cents);

ALTER TABLE upload_batch ADD COLUMN status TEXT NOT NULL DEFAULT 'pending_review'
  CHECK (status IN ('pending_review', 'approved', 'rejected'));
CREATE INDEX idx_upload_batch_status ON upload_batch(company_id, status);

-- No backfill UPDATE needed: SQLite's ADD COLUMN ... NOT NULL DEFAULT
-- already back-fills every existing row with 'pending_review' in place.
-- That's also the honest answer for pre-existing rows -- nothing ever
-- explicitly approved or rejected them through a status field that
-- didn't exist yet, so 'pending_review' (not 'approved') is correct,
-- not just convenient.
