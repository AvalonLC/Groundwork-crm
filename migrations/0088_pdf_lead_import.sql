-- Migration 0088: PDF-to-lead import — documents, imports, document links, batches
--
-- Extends the existing "Import from Email (AI)" flow (public/js/app_premium.js
-- _gwAiLeadImport / /api/ai/parse-lead) to accept uploaded PDFs (proposals,
-- work orders, estimates from other systems) in addition to pasted email text.
--
-- Why new tables instead of reusing `receipt`/`upload_batch` (Finance OS,
-- src/ai/receipts.ts): those tables are purpose-built for a single
-- vendor/amount/date receipt image tied to one job_id, posted (eventually) to
-- job_cost_ledger. A lead-import PDF has a materially different shape (many
-- proposed CRM fields, multiple possible properties, division suggestions,
-- pricing OPTIONS rather than one amount) and must NEVER be posted to the
-- ledger — conflating the two schemas would make it easy to accidentally
-- wire a lead-import row into ledger-posting code that assumes a receipt.
-- The confidence-scoring / hash-dedupe / write-once-guard *patterns* from
-- receipts.ts are reused in TypeScript (src/ai/pdf-lead-import.ts), just not
-- the tables.
--
-- Why new tables instead of reusing `project_media` (migrations/0043): that
-- table has no hash column, no lifecycle beyond a single publish flag, and
-- is scoped to work_orders — this feature needs a document to exist BEFORE
-- any CRM record does (upload happens first, confirmation happens later,
-- and may never happen at all), which project_media's model does not
-- support.
--
-- Lifecycle (see src/ai/pdf-lead-import.ts's LifecycleState type for the
-- authoritative state machine): temporary -> uploaded -> extracting ->
-- parsing -> needs_review -> ready -> creating -> finalized
--                                            \-> failed (retryable)
-- temporary rows that are never confirmed become 'abandoned' after a
-- retention window (see ABANDONED_RETENTION_HOURS) and are eligible for
-- (never-auto-run) cleanup. Cleanup NEVER deletes a 'finalized' document —
-- see cleanupAbandonedImports()'s own guard and its tests.

-- ── lead_import_document ──────────────────────────────────────────────────
-- One row per unique uploaded PDF (by SHA-256 hash, per tenant). The R2
-- object itself is never duplicated for multiple links — see
-- lead_import_document_link below for the many-to-many fan-out to CRM
-- records. `status` here tracks the DOCUMENT's own lifecycle (its R2 object
-- existing and being readable), which is deliberately a *coarser*, mostly-
-- monotonic subset of the IMPORT's lifecycle (see lead_import.status) --
-- multiple imports could theoretically reference one finalized document
-- (e.g. "link this already-imported PDF to a second opportunity"), so the
-- document's own state must not be forced backward by a second import.
CREATE TABLE IF NOT EXISTS lead_import_document (
  id                 TEXT NOT NULL PRIMARY KEY,
  company_id         TEXT NOT NULL,
  uploaded_by_rep_id TEXT NOT NULL DEFAULT '',
  original_filename  TEXT NOT NULL DEFAULT '',   -- as supplied by the browser, untrusted
  safe_filename      TEXT NOT NULL DEFAULT '',    -- sanitized, used in headers/HTML
  r2_key             TEXT NOT NULL,               -- never derived from raw filename
  mime_type          TEXT NOT NULL DEFAULT 'application/pdf',
  byte_size          INTEGER NOT NULL DEFAULT 0,
  sha256_hash        TEXT NOT NULL,               -- hex, 64 chars
  upload_source      TEXT NOT NULL DEFAULT 'pdf_single'
                        CHECK (upload_source IN ('pdf_single','pdf_bulk')),
  document_kind      TEXT NOT NULL DEFAULT 'unknown'
                        CHECK (document_kind IN ('proposal','work_order','estimate','unknown')),
  -- Coarse object-availability lifecycle -- see doc comment above for why
  -- this differs from lead_import.status.
  status             TEXT NOT NULL DEFAULT 'uploaded'
                        CHECK (status IN ('uploaded','finalized','abandoned','expired')),
  finalized_at       TEXT,
  -- The import that FIRST created this document row. Later imports that
  -- link to an existing finalized document (duplicate-hash reuse) do not
  -- change this -- it is provenance, not "current owner".
  import_id          TEXT NOT NULL DEFAULT '',
  created_at         TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at         TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Duplicate/idempotency protection: one hash per tenant maps to one document.
-- This is the exact lookup the spec requires before starting a new import.
CREATE UNIQUE INDEX IF NOT EXISTS idx_lid_company_hash
  ON lead_import_document(company_id, sha256_hash);
CREATE INDEX IF NOT EXISTS idx_lid_company_status
  ON lead_import_document(company_id, status);

-- ── lead_import ────────────────────────────────────────────────────────────
-- One row per import ATTEMPT (not per document -- a document can be
-- re-linked by a later, separate import). Tracks the full
-- upload -> extract -> parse -> review -> confirm lifecycle for a single
-- PDF within a (possibly bulk) batch.
CREATE TABLE IF NOT EXISTS lead_import (
  id                   TEXT NOT NULL PRIMARY KEY,
  company_id           TEXT NOT NULL,
  document_id          TEXT NOT NULL,             -- FK -> lead_import_document.id
  batch_id             TEXT NOT NULL DEFAULT '',   -- FK -> lead_import_batch.id, '' for single-file imports
  -- Server-generated, never client-supplied -- see spec's "stable
  -- server-generated import ID and idempotency token" requirement. Used as
  -- the idempotency key for the confirm step: repeated/concurrent confirms
  -- with the same token must yield exactly one logical record set.
  idempotency_token    TEXT NOT NULL,
  status               TEXT NOT NULL DEFAULT 'temporary'
                          CHECK (status IN (
                            'temporary','uploaded','extracting','parsing',
                            'needs_review','ready','creating','finalized',
                            'failed','abandoned','expired'
                          )),
  -- Model/parser provenance -- required by the audit section of the spec.
  parser_name          TEXT NOT NULL DEFAULT 'unpdf',
  parser_version       TEXT NOT NULL DEFAULT '',
  ai_model             TEXT NOT NULL DEFAULT '',
  schema_version       TEXT NOT NULL DEFAULT 'v1',
  -- Extracted text is retained only up to MAX_EXTRACTED_TEXT_CHARS and only
  -- through the review window -- see src/ai/pdf-lead-import.ts's retention
  -- policy notes. Not indefinitely retained per the spec's "do not retain
  -- complete extracted text indefinitely" instruction; a future cleanup
  -- pass may null this out after finalization (implemented, never
  -- auto-executed against production -- see cleanupAbandonedImports).
  extracted_text       TEXT NOT NULL DEFAULT '',
  extracted_page_count INTEGER NOT NULL DEFAULT 0,
  -- Proposed (AI-suggested, unreviewed) structured draft as JSON --
  -- ParsedLeadDraft shape. Never used to create/alter CRM records directly.
  proposed_json        TEXT NOT NULL DEFAULT '',
  -- User-edited/approved values as JSON, saved only at confirm time.
  -- ParsedLeadDraft shape, but this is what actually gets written to CRM
  -- tables -- "save reviewed values, not raw AI output" (pricing rule 12).
  approved_json        TEXT NOT NULL DEFAULT '',
  -- Warnings/ambiguities surfaced during parsing (JSON array of strings).
  warnings_json        TEXT NOT NULL DEFAULT '[]',
  error_message        TEXT NOT NULL DEFAULT '',
  -- Set only by the confirm step, once, guarded by idempotency_token --
  -- see confirmLeadImport()'s write-once-guard-first ordering (mirrors
  -- postApprovedReceiptToLedger's documented race-safety pattern).
  confirmed_by_rep_id  TEXT NOT NULL DEFAULT '',
  confirmed_at         TEXT,
  -- Result references, populated only after successful confirmation.
  result_client_id     TEXT NOT NULL DEFAULT '',
  result_opportunity_ids_json TEXT NOT NULL DEFAULT '[]',
  created_at           TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at           TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_lead_import_idem
  ON lead_import(company_id, idempotency_token);
CREATE INDEX IF NOT EXISTS idx_lead_import_company_status
  ON lead_import(company_id, status);
CREATE INDEX IF NOT EXISTS idx_lead_import_document
  ON lead_import(document_id);
CREATE INDEX IF NOT EXISTS idx_lead_import_batch
  ON lead_import(batch_id);

-- ── lead_import_document_link ────────────────────────────────────────────
-- Many-to-many: one document can be linked to a client, and to MULTIPLE
-- opportunities (one PDF describing several properties -> several
-- opportunities, all sharing the same source document -- the spec's "link
-- it to every resulting opportunity" requirement). Unlinking one entity
-- (DELETE one row) never deletes the document or its other links.
CREATE TABLE IF NOT EXISTS lead_import_document_link (
  id            TEXT NOT NULL PRIMARY KEY,
  company_id    TEXT NOT NULL,
  document_id   TEXT NOT NULL,             -- FK -> lead_import_document.id
  import_id     TEXT NOT NULL DEFAULT '',  -- which import created this link
  entity_type   TEXT NOT NULL CHECK (entity_type IN ('client','opportunity','property')),
  entity_id     TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_lidl_unique
  ON lead_import_document_link(document_id, entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_lidl_entity
  ON lead_import_document_link(company_id, entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_lidl_document
  ON lead_import_document_link(document_id);

-- ── lead_import_batch ────────────────────────────────────────────────────
-- Bulk-import queue header (PR2 / bulk-import PR). One row per "Upload
-- Multiple PDFs" action; lead_import rows reference it via batch_id.
-- Present in this foundation migration (rather than a later one) so the
-- lead_import.batch_id FK target always exists, even though the bulk
-- endpoints themselves land in the follow-up PR.
CREATE TABLE IF NOT EXISTS lead_import_batch (
  id             TEXT NOT NULL PRIMARY KEY,
  company_id     TEXT NOT NULL,
  created_by_rep_id TEXT NOT NULL DEFAULT '',
  status         TEXT NOT NULL DEFAULT 'queued'
                    CHECK (status IN ('queued','processing','ready','completed','failed','expired')),
  file_count     INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_lead_import_batch_company
  ON lead_import_batch(company_id, status);
