-- Merge Finance OS's separate `groundwork` D1 database into this one.
-- See docs/spec/SCHEMA.md and the finance-merge project notes (2026-08-09).
--
-- SCHEMA ONLY. This file cannot move data -- D1/SQLite has no cross-database
-- query, and the existing Finance OS rows live in a completely separate D1
-- instance (`groundwork`). Copying that data into the tables/columns this
-- migration creates is a separate, out-of-band step: scripts/migrate-finance-data.mjs,
-- which Tyler runs himself against both databases' --remote endpoints after
-- this migration has been applied to production. Do not assume the new
-- columns/tables are populated just because this migration ran.
--
-- Fold 1: work_item -> work_orders (work_item.id/.job_id were already the
-- same value as work_orders.id -- same row, not a join).
ALTER TABLE work_orders ADD COLUMN estimate_cents INTEGER;
ALTER TABLE work_orders ADD COLUMN finance_completed_at TEXT;

-- Fold 2: time_entry -> time_entries. hours_hundredths and ot_hours_hundredths
-- are NOT duplicated here -- redundant with time_entries.duration_min, computed
-- at posting time instead (see src/api/posting.ts). crew_id and work_date are
-- also not duplicated -- derived via time_entries.work_order_id and clock_in
-- at read time.
ALTER TABLE time_entries ADD COLUMN resolved_rate INTEGER;
ALTER TABLE time_entries ADD COLUMN resolved_rate_confidence TEXT;
ALTER TABLE time_entries ADD COLUMN applied_overhead_cents INTEGER;
ALTER TABLE time_entries ADD COLUMN posted_at TEXT;

-- Everything below has no CRM counterpart -- moved as-is, with tenant_id
-- renamed to company_id (verified safe: production tenant_id values are
-- either empty or exactly 'avalon', which matches companies.id -- checked
-- 2026-08-09, zero mismatches) and real foreign keys added where a bare
-- job_id actually meant work_orders.id / time_entry_id meant time_entries.id.
-- company_id is NOT a FOREIGN KEY to companies(id) -- confirmed D1 enforces
-- FK constraints (SQLITE_CONSTRAINT_FOREIGNKEY on violation), and no
-- existing CRM table (57 prior migrations) FKs its own company_id/tenant_id
-- column to companies either; adding one here would be a stricter, new
-- convention, not matching what already exists.

CREATE TABLE tenant_finance_policy (
  company_id                  TEXT PRIMARY KEY,
  equipment_engine_active     INTEGER NOT NULL DEFAULT 0,
  materiality_threshold_cents INTEGER NOT NULL DEFAULT 0,
  restated_target_cents       INTEGER NOT NULL DEFAULT 0,
  black_friday_date           TEXT,
  created_at                  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at                  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE labor_rate_profile (
  id                              INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id                      TEXT NOT NULL,
  scope                           TEXT NOT NULL CHECK (scope IN ('employee','crew','role','tenant')),
  scope_id                        TEXT NOT NULL,
  wage_cents                      INTEGER NOT NULL,
  paid_hours                      INTEGER NOT NULL,
  pto_hours                       INTEGER NOT NULL DEFAULT 0,
  shop_hours                      INTEGER NOT NULL DEFAULT 0,
  idle_hours                      INTEGER NOT NULL DEFAULT 0,
  tax_rate                        INTEGER NOT NULL,
  comp_rate                       INTEGER NOT NULL,
  benefits_monthly_cents          INTEGER NOT NULL DEFAULT 0,
  support_truck_annual_cents      INTEGER NOT NULL DEFAULT 0,
  support_tools_annual_cents      INTEGER NOT NULL DEFAULT 0,
  support_equipment_annual_cents  INTEGER NOT NULL DEFAULT 0,
  require_rate_approval           INTEGER NOT NULL DEFAULT 0,
  effective_from                  TEXT NOT NULL,
  effective_to                    TEXT,
  created_at                      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_labor_rate_scope ON labor_rate_profile(company_id, scope, scope_id, effective_from);
CREATE INDEX idx_labor_rate_open ON labor_rate_profile(company_id, scope, scope_id, effective_to);

CREATE TABLE equipment_rate_profile (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id            TEXT NOT NULL,
  equipment_id          TEXT NOT NULL,
  purchase_price_cents  INTEGER NOT NULL,
  salvage_cents         INTEGER NOT NULL,
  life_years            INTEGER NOT NULL,
  annual_machine_hours  INTEGER NOT NULL,
  finance_rate          INTEGER NOT NULL,
  insurance_annual_cents INTEGER NOT NULL DEFAULT 0,
  storage_annual_cents  INTEGER NOT NULL DEFAULT 0,
  fuel_gal_per_hr       INTEGER NOT NULL,
  fuel_price_cents      INTEGER NOT NULL,
  repairs_annual_cents  INTEGER NOT NULL DEFAULT 0,
  wear_annual_cents     INTEGER NOT NULL DEFAULT 0,
  lube_pct_of_fuel      INTEGER NOT NULL,
  effective_from        TEXT NOT NULL,
  effective_to          TEXT,
  created_at            TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_equipment_rate_scope ON equipment_rate_profile(company_id, equipment_id, effective_from);
CREATE INDEX idx_equipment_rate_open ON equipment_rate_profile(company_id, equipment_id, effective_to);

CREATE TABLE overhead_pool (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id        TEXT NOT NULL,
  division          TEXT NOT NULL,
  pool_type         TEXT NOT NULL,
  annual_cost_cents INTEGER NOT NULL,
  driver            TEXT NOT NULL,
  as_of             TEXT NOT NULL,
  created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_overhead_pool_company ON overhead_pool(company_id, division, as_of);

CREATE TABLE overhead_allocation (
  id                        INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id                TEXT NOT NULL,
  division                  TEXT NOT NULL,
  as_of                     TEXT NOT NULL,
  sellable_hours            INTEGER NOT NULL,
  allocated_overhead_cents  INTEGER NOT NULL,
  weighted_labor_rate_cents INTEGER NOT NULL,
  overhead_rate             INTEGER NOT NULL,
  absorbed_cost_cents       INTEGER NOT NULL,
  target_margin             INTEGER NOT NULL,
  required_bill_rate_cents  INTEGER NOT NULL,
  created_at                TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_overhead_allocation_company ON overhead_allocation(company_id, division, as_of);

CREATE TABLE recovery_snapshot (
  id                         INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id                 TEXT NOT NULL,
  as_of                      TEXT NOT NULL,
  restated_target_cents      INTEGER NOT NULL,
  recovered_to_date_cents    INTEGER NOT NULL,
  hours_per_week_hundredths  INTEGER NOT NULL,
  blended_overhead_rate      INTEGER NOT NULL,
  weekly_recovery_cents      INTEGER NOT NULL,
  pct_recovered_millionths   INTEGER NOT NULL,
  projected_black_friday     TEXT,
  confidence_days            INTEGER NOT NULL,
  created_at                 TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX idx_recovery_snapshot_company_date ON recovery_snapshot(company_id, as_of);

-- job_cost_ledger: job_id now a real FK (it always meant work_orders.id);
-- time_entry_id is now TEXT, referencing the merged time_entries.id, not the
-- old integer-autoincrement time_entry.id.
CREATE TABLE job_cost_ledger (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id     TEXT NOT NULL,
  time_entry_id  TEXT NOT NULL REFERENCES time_entries(id),
  job_id         TEXT NOT NULL REFERENCES work_orders(id),
  line_type      TEXT NOT NULL CHECK (line_type IN ('labor','overhead')),
  amount_cents   INTEGER NOT NULL,
  division       TEXT,
  posted_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_job_cost_ledger_job ON job_cost_ledger(company_id, job_id);
CREATE INDEX idx_job_cost_ledger_time_entry ON job_cost_ledger(time_entry_id);

-- action_item / classification_finding: source_type/subject_type's 'work_item'
-- literal renamed to 'work_order' -- the table it referred to no longer
-- exists under that name, and both tables are empty in production (2026-08-09),
-- so this is a zero-risk rename, not a live data migration.
CREATE TABLE action_item (
  id                TEXT PRIMARY KEY,
  company_id        TEXT NOT NULL,
  verb              TEXT NOT NULL CHECK (verb IN ('collect','bill','pay','fix','decide')),
  owner_id          TEXT NOT NULL,
  sla_due           TEXT NOT NULL,
  amount_cents      INTEGER,
  confidence        TEXT NOT NULL,
  stale_components  TEXT,
  status            TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved','dismissed')),
  source_type       TEXT CHECK (source_type IS NULL OR source_type IN ('work_order','classification_finding','receipt','ingest')),
  source_id         TEXT,
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at       TEXT
);
CREATE INDEX idx_action_item_open ON action_item(company_id, status, sla_due);
CREATE INDEX idx_action_item_owner ON action_item(company_id, owner_id, status);
CREATE INDEX idx_action_item_verb ON action_item(company_id, verb, status);

CREATE TABLE classification_finding (
  id                TEXT PRIMARY KEY,
  company_id        TEXT NOT NULL,
  subject_type      TEXT NOT NULL,
  subject_id        TEXT NOT NULL,
  stage_reached     INTEGER NOT NULL CHECK (stage_reached BETWEEN 1 AND 4),
  confidence        TEXT NOT NULL,
  materiality_cents INTEGER NOT NULL DEFAULT 0,
  proposed_change   TEXT,
  action_item_id    TEXT REFERENCES action_item(id),
  created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_classification_finding_company ON classification_finding(company_id, subject_type, subject_id);

CREATE TABLE receipt (
  id                TEXT PRIMARY KEY,
  company_id        TEXT NOT NULL,
  job_id            TEXT REFERENCES work_orders(id),
  r2_key            TEXT NOT NULL,
  content_hash      TEXT NOT NULL,
  vendor            TEXT,
  amount_cents      INTEGER,
  receipt_date      TEXT,
  field_confidence  TEXT,
  action_item_id    TEXT REFERENCES action_item(id),
  created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX idx_receipt_dedupe ON receipt(company_id, content_hash);
CREATE INDEX idx_receipt_job ON receipt(company_id, job_id);

CREATE TABLE finance_config_override (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id   TEXT NOT NULL DEFAULT '__global__',
  config_name  TEXT NOT NULL,
  config_json  TEXT NOT NULL,
  updated_by   TEXT,
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX idx_finance_config_override_scope ON finance_config_override(company_id, config_name);

CREATE TABLE upload_batch (
  id                  TEXT PRIMARY KEY,
  company_id          TEXT NOT NULL,
  filename            TEXT NOT NULL,
  domain              TEXT NOT NULL CHECK (domain IN ('financial_export','receipt','unrecognized')),
  detected_source_id  TEXT,
  needs_review        INTEGER NOT NULL DEFAULT 0,
  row_count           INTEGER,
  created_at          TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_upload_batch_company ON upload_batch(company_id, domain, created_at);
