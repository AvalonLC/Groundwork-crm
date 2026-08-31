-- Migration 0086: §10 writing-backfill guard rails — durable manifest-
-- execution ledger + audit attribution for the row-creating script
-- (docs/spec/ITEM4-JOBCOST.md §10 steps 1-5; Item 4 Stage 2 Phase 2).
--
-- Why a table, not just an in-memory/log-file check: the mandate requires
-- "refusal of reused/altered/stale/mismatched/consumed manifests" and
-- "idempotency"/"duplicate prevention" to be real guarantees, not merely
-- documented intentions. already_has_budget_version (the existing Phase 3
-- classifier bucket) already prevents a second baseline row for the same
-- JOB — but it says nothing about a second EXECUTION of the same MANIFEST
-- (e.g. two operators independently kicking off --apply with the same
-- generated manifest file, or one operator re-running the same manifest
-- after a partial network failure, before checking whether the first
-- attempt actually finished). This table is the single source of truth
-- for "has manifest X already been (fully or partially) executed," queried
-- and written inside the same transaction as the job_budget_versions rows
-- it produces, so the two can never disagree.
--
-- One row per manifest EXECUTION ATTEMPT (not per manifest — a manifest
-- that failed validation and was regenerated is a different manifest with
-- a different hash, per src/engines/backfill-write.ts's deterministic
-- hashing). A manifest hash can appear at most once in this table with
-- status='completed' (enforced by application code checking before
-- executing, not a UNIQUE constraint, since a 'failed' or 'in_progress'
-- row for the same hash legitimately needs to exist alongside a later
-- retry's own row for audit-trail completeness — see
-- backfill-write-repos.ts's executeBackfillManifest doc comment).
CREATE TABLE IF NOT EXISTS backfill_manifest_execution (
  id                   TEXT PRIMARY KEY,
  company_id           TEXT NOT NULL,
  manifest_hash        TEXT NOT NULL,   -- sha256 of the canonical manifest JSON (src/engines/backfill-write.ts's hashManifest)
  schema_version        INTEGER NOT NULL, -- must equal BACKFILL_MANIFEST_SCHEMA_VERSION at execution time — a manifest generated under an older/newer schema version is refused, never coerced
  environment          TEXT NOT NULL,   -- 'local' | 'remote' — must match the D1 binding actually being written to; refuses a manifest generated for one environment being applied against the other
  as_of                TEXT NOT NULL,   -- the backfill analysis as_of date the manifest was generated from
  generated_at         TEXT NOT NULL,   -- manifest's own generation timestamp (for staleness checks — see MAX_MANIFEST_AGE_MS)
  job_count             INTEGER NOT NULL, -- number of job rows the manifest proposes to write — compared against a fresh recount at execution time (expected-counts protection)
  status                TEXT NOT NULL CHECK (status IN ('in_progress','completed','failed')),
  rows_written          INTEGER NOT NULL DEFAULT 0,
  error_message        TEXT,
  approved_by           TEXT NOT NULL,  -- the human who supplied the confirmation token — never blank; audit attribution requirement
  confirmation_token_hash TEXT NOT NULL, -- sha256 of the confirmation token actually presented (never the raw token — same "never store the secret itself" discipline as everywhere else in this codebase), so a completed execution's audit row provably required a real token without persisting it in cleartext
  started_at           TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at          TEXT
);

CREATE INDEX IF NOT EXISTS idx_backfill_manifest_exec_hash ON backfill_manifest_execution(manifest_hash);
CREATE INDEX IF NOT EXISTS idx_backfill_manifest_exec_company ON backfill_manifest_execution(company_id, started_at DESC);
