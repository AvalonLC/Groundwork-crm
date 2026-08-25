-- Migration 0085: Item 4 Stage 2 — job-level budgets, change orders,
-- completion/progress tracking, direct-cost ledger categories, ledger
-- adjustments, and the receipt-posting columns needed for the non-labor
-- cost-to-ledger pipeline.
--
-- Full design: docs/spec/ITEM4-JOBCOST.md (Stage 1, approved). This
-- migration implements §4.1-§4.5 verbatim, plus a small number of
-- additions (marked "STAGE 2 ADDITION" below) discovered while building
-- the receipt-to-ledger posting pipeline that §3's "full scope" decision
-- requires — Tyler's 2026-08-25 autonomy mandate resolved §3 in favor of
-- building the posting pipeline in this same effort, not as a deferred
-- follow-up, so those additions are in scope here rather than a separate
-- migration.
--
-- Following this repo's established pattern (0016/0017, 0083): additive
-- CREATE TABLE / ALTER TABLE ... ADD COLUMN wherever possible, no DROP/
-- data-loss steps except the one CHECK-widening recreate in §4.4, which
-- follows the exact precedent already used in migrations/0003_add_company_id.sql
-- (revenue_actuals_new) — every existing row is copied through unchanged.

-- ── 4.1 change_orders ────────────────────────────────────────────────────────
-- Only status='approved' rows ever feed a formula — enforced in application
-- code (every read helper filters WHERE status='approved'), matching how
-- this codebase already gates by status everywhere else (estimates.status,
-- invoices status filters), not by a trigger.
CREATE TABLE change_orders (
  id                          TEXT PRIMARY KEY,
  company_id                  TEXT NOT NULL,
  job_id                      TEXT NOT NULL REFERENCES work_orders(id),
  estimate_id                 TEXT REFERENCES estimates(id),      -- nullable: a CO can exist before/without a fresh estimate revision
  customer_id                 TEXT,                                -- denormalized for reporting; not authoritative (clients.id is)
  status                      TEXT NOT NULL DEFAULT 'draft'
                                CHECK (status IN ('draft','pending','approved','rejected','void')),
  revenue_adjustment_cents    INTEGER NOT NULL DEFAULT 0,          -- signed: + adds revenue, - reduces it
  direct_cost_adjustment_cents INTEGER NOT NULL DEFAULT 0,         -- signed
  labor_hours_adjustment_hundredths INTEGER NOT NULL DEFAULT 0,    -- signed, HoursHundredths-shaped
  overhead_rate_snapshot      INTEGER,                             -- TenThousandths $/hr, the division overhead rate effective at approval — NULL until approved
  approved_at                 TEXT,                                -- NULL until status='approved'
  approved_by                 TEXT,                                -- reps.id; NULL until approved
  effective_date              TEXT,                                -- date the adjustment takes effect for formula purposes (may differ from approved_at)
  description                 TEXT NOT NULL DEFAULT '',
  reason                      TEXT DEFAULT '',
  created_by                  TEXT NOT NULL,
  created_at                  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at                  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_change_orders_job ON change_orders(company_id, job_id);
CREATE INDEX idx_change_orders_status ON change_orders(company_id, status);

-- ── 4.2 job_budget_versions ("approved budget versions") ────────────────────
-- One row per approved baseline or approved-change-order revision. Never
-- updated in place — a new revision is a new row, same immutability
-- convention as labor_rate_profile/equipment_rate_profile.
--
-- STAGE 2 ADDITION: needs_review (Bool01, DEFAULT 0) — per §10 step 2, the
-- existing-record migration script must flag a baseline row whose direct-
-- cost budget couldn't be attributed to a clean category split, rather
-- than inventing one. Same convention as upload_batch.needs_review.
CREATE TABLE job_budget_versions (
  id                              TEXT PRIMARY KEY,
  company_id                      TEXT NOT NULL,
  job_id                          TEXT NOT NULL REFERENCES work_orders(id),
  source_type                     TEXT NOT NULL CHECK (source_type IN ('estimate','change_order')),
  source_id                       TEXT NOT NULL,               -- estimates.id or change_orders.id
  revision_seq                    INTEGER NOT NULL,            -- 0 = original baseline, 1,2,3... = each approved revision in order
  contract_value_cents            INTEGER NOT NULL,            -- cumulative, i.e. already includes this and all prior revisions
  -- Direct-cost budget, broken out by category (cumulative, same convention):
  labor_hours_budgeted_hundredths INTEGER NOT NULL DEFAULT 0,
  labor_rate_used                 INTEGER,                     -- TenThousandths $/hr, burdened rate used for this budget
  materials_budget_cents          INTEGER NOT NULL DEFAULT 0,
  subcontractor_budget_cents      INTEGER NOT NULL DEFAULT 0,
  equipment_budget_cents          INTEGER NOT NULL DEFAULT 0,
  disposal_budget_cents           INTEGER NOT NULL DEFAULT 0,
  permits_budget_cents            INTEGER NOT NULL DEFAULT 0,
  other_direct_budget_cents       INTEGER NOT NULL DEFAULT 0,
  direct_cost_budget_cents        INTEGER NOT NULL,            -- = labor $ (hours*rate) + materials + subs + equipment + disposal + permits + other; stored, not recomputed, so a later rate-table change never silently reshapes an old budget
  division                        TEXT NOT NULL,               -- crews.division at time of approval, drives the overhead-rate lookup below
  overhead_rate_used              INTEGER NOT NULL,            -- TenThousandths $/hr, the division rate effective on approved_at — frozen, per Tyler's "store the rate used" requirement
  budgeted_overhead_cents         INTEGER NOT NULL,            -- labor_hours_budgeted x overhead_rate_used, stored
  target_margin_millionths        INTEGER,                     -- Millionths, nullable (not every job has one set)
  completion_method               TEXT NOT NULL DEFAULT 'cost_to_cost'
                                     CHECK (completion_method IN ('cost_to_cost','service_units','manual','completed')),
  service_units_planned           REAL,                        -- only meaningful when completion_method='service_units'
  needs_review                    INTEGER NOT NULL DEFAULT 0,  -- Bool01. Set by the backfill script (§10) when a category split couldn't be attributed cleanly from source data
  approved_at                     TEXT NOT NULL,
  approved_by                     TEXT NOT NULL,
  created_at                      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX idx_job_budget_versions_seq ON job_budget_versions(company_id, job_id, revision_seq);
CREATE INDEX idx_job_budget_versions_job ON job_budget_versions(company_id, job_id);

-- ── 4.3 Completion/progress tracking on work_orders ─────────────────────────
ALTER TABLE work_orders ADD COLUMN completion_pct_millionths INTEGER DEFAULT NULL;
-- Manual override only (completion_method='manual'). NULL means "compute it",
-- a value means "trust this instead" — same NULL-means-compute convention
-- used elsewhere in this schema.

ALTER TABLE work_orders ADD COLUMN service_units_completed REAL DEFAULT NULL;
-- Only meaningful when the active job_budget_versions row has
-- completion_method='service_units'. Planned units live on the budget
-- version (service_units_planned); completed units live here because they
-- change continuously as work happens, unlike a budget figure.

ALTER TABLE work_orders ADD COLUMN financially_closed_at TEXT DEFAULT NULL;
-- Distinct from work_orders.status='completed' and finance_completed_at
-- (migrations/0057_finance_merge.sql) — those mark the *work* done.
-- financially_closed_at marks the *cost side* closed (no more direct-cost
-- postings expected), which is what forces completion to 1.00. A job can
-- be work-completed but not yet financially closed (late vendor bills
-- still expected).

-- ── 4.4 job_cost_ledger — direct-cost category + progress eligibility +
--        change-order/receipt linkage ──────────────────────────────────────
-- SQLite has no ALTER TABLE ... ADD CONSTRAINT; widening the line_type CHECK
-- requires the same recreate-and-copy pattern already used in this repo
-- (migrations/0003_add_company_id.sql, revenue_actuals_new). No data is
-- dropped; every existing row is copied through unchanged.
CREATE TABLE job_cost_ledger_new (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id            TEXT NOT NULL,
  time_entry_id         TEXT REFERENCES time_entries(id),      -- now nullable: non-labor postings (materials, subs, ...) have no time_entry
  job_id                TEXT NOT NULL REFERENCES work_orders(id),
  line_type             TEXT NOT NULL CHECK (line_type IN ('labor','overhead','direct_cost')),
  -- 'direct_cost' is the new bucket for materials/subs/equipment/disposal/
  -- permits/other; labor/overhead keep meaning exactly what they mean today
  -- (the two-line time-entry post). cost_category further classifies
  -- direct_cost rows; labor/overhead rows leave it NULL.
  cost_category         TEXT CHECK (cost_category IS NULL OR cost_category IN
                           ('materials','subcontractor','equipment','disposal','permits','other')),
  amount_cents          INTEGER NOT NULL,
  division               TEXT,
  progress_eligible     INTEGER NOT NULL DEFAULT 1,            -- Bool01. 0 = posted but excluded from earned-completion cost-to-cost math
  -- Deposits, prepaid vendor amounts, and purchased-but-not-yet-installed
  -- materials should not advance completion. Rather than guess at that from
  -- amount/category, this is an explicit flag set by whoever posts the line
  -- (the receipt-approval/posting UI, for direct_cost lines). Defaults to 1
  -- (eligible) so today's labor/overhead postings are unaffected.
  change_order_id       TEXT REFERENCES change_orders(id),      -- NULL for lines not tied to a specific approved CO
  source_receipt_id     TEXT REFERENCES receipt(id),             -- NULL for labor/overhead lines; set for a direct_cost line posted from an approved receipt
  posted_at             TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT INTO job_cost_ledger_new
  (id, company_id, time_entry_id, job_id, line_type, amount_cents, division, posted_at)
  SELECT id, company_id, time_entry_id, job_id, line_type, amount_cents, division, posted_at
  FROM job_cost_ledger;
DROP TABLE job_cost_ledger;
ALTER TABLE job_cost_ledger_new RENAME TO job_cost_ledger;
CREATE INDEX idx_job_cost_ledger_job ON job_cost_ledger(company_id, job_id);
CREATE INDEX idx_job_cost_ledger_time_entry ON job_cost_ledger(time_entry_id);
CREATE INDEX idx_job_cost_ledger_change_order ON job_cost_ledger(change_order_id);
CREATE INDEX idx_job_cost_ledger_source_receipt ON job_cost_ledger(source_receipt_id);

-- Every existing row survives with cost_category=NULL, progress_eligible=1,
-- change_order_id=NULL, source_receipt_id=NULL — behaviorally identical to
-- today until new columns get populated by new code paths.

-- ── 4.5 job_cost_ledger_adjustments (generalizing migration 0083's pattern) ──
-- A credit/refund/correction posts a reversal job_cost_ledger row (negative
-- amount_cents, same job_id/category) plus, if it's a correction rather
-- than a pure credit, a replacement row — exactly time_entry_adjustments'
-- shape, applied to any ledger line instead of only time-entry-sourced ones.
CREATE TABLE job_cost_ledger_adjustments (
  id                    TEXT PRIMARY KEY,
  company_id            TEXT NOT NULL,
  original_line_id      INTEGER NOT NULL REFERENCES job_cost_ledger(id),
  reversal_line_id      INTEGER NOT NULL REFERENCES job_cost_ledger(id),
  replacement_line_id   INTEGER REFERENCES job_cost_ledger(id),  -- NULL for a pure reversal/credit
  reason                TEXT NOT NULL,
  created_by            TEXT NOT NULL,
  created_at            TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_jcl_adjustments_original ON job_cost_ledger_adjustments(company_id, original_line_id);

-- ── STAGE 2 ADDITION: receipt columns for the non-labor posting pipeline ────
-- documents.tsx's Approve action changes receipt.status but has never
-- posted anything to job_cost_ledger (see that file's explicit comment).
-- Closing that gap (required by Tyler's 2026-08-25 mandate: "non-labor
-- costs can enter the ledger through human approval") needs three things
-- a receipt row doesn't have yet:
--   1. cost_category — which of the 6 non-labor buckets this receipt is
--      (job_cost_ledger's own cost_category CHECK, mirrored here). Set by
--      the approver, not guessed from vendor name/amount.
--   2. progress_eligible — same not-yet-earned flag as job_cost_ledger,
--      set by the approver (deposit/prepaid/purchased-but-uninstalled -> 0).
--   3. posted_at — write-once guard so a receipt can only ever produce ONE
--      job_cost_ledger line, mirroring time_entries.posted_at's exact
--      "WHERE posted_at IS NULL" guard pattern (src/db/repos.ts's
--      postTimeEntry). Posting requires status='approved' AND job_id NOT
--      NULL AND posted_at IS NULL, enforced in application code — never
--      automatic, always a distinct explicit action from Approve itself.
ALTER TABLE receipt ADD COLUMN cost_category TEXT DEFAULT NULL
  CHECK (cost_category IS NULL OR cost_category IN
    ('materials','subcontractor','equipment','disposal','permits','other'));
ALTER TABLE receipt ADD COLUMN progress_eligible INTEGER NOT NULL DEFAULT 1;
ALTER TABLE receipt ADD COLUMN posted_at TEXT DEFAULT NULL;
CREATE INDEX idx_receipt_posted ON receipt(company_id, posted_at);
