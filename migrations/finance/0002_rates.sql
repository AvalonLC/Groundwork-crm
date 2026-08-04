-- Finance OS: rate profiles, overhead allocation, recovery snapshots.
-- Rate columns: INTEGER ten-thousandths (0.0865 -> 865). Money: INTEGER cents.
-- *_rate_profile tables are immutable + effective-dated — INSERT only, never UPDATE.
-- See docs/spec/SCHEMA.md, ALLOCATION.md, RECOVERY.md.

CREATE TABLE labor_rate_profile (
  id                              INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id                       TEXT NOT NULL,
  scope                           TEXT NOT NULL CHECK (scope IN ('employee','crew','role','tenant')),
  scope_id                        TEXT NOT NULL, -- employee_id / crew_id / role name / tenant_id
  wage_cents                      INTEGER NOT NULL,
  paid_hours                      INTEGER NOT NULL,
  pto_hours                       INTEGER NOT NULL DEFAULT 0,
  shop_hours                      INTEGER NOT NULL DEFAULT 0,
  idle_hours                      INTEGER NOT NULL DEFAULT 0,
  tax_rate                        INTEGER NOT NULL, -- ten-thousandths, 0.0865 -> 865
  comp_rate                       INTEGER NOT NULL, -- ten-thousandths, 0.07 -> 700
  benefits_monthly_cents          INTEGER NOT NULL DEFAULT 0,
  support_truck_annual_cents      INTEGER NOT NULL DEFAULT 0,
  support_tools_annual_cents      INTEGER NOT NULL DEFAULT 0,
  -- MUST be 0 when tenant_finance_policy.equipment_engine_active = true (BH-13 guard).
  support_equipment_annual_cents  INTEGER NOT NULL DEFAULT 0,
  require_rate_approval           INTEGER NOT NULL DEFAULT 0, -- 0/1
  effective_from                  TEXT NOT NULL,
  effective_to                    TEXT, -- NULL = currently in effect
  created_at                      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_labor_rate_scope ON labor_rate_profile(tenant_id, scope, scope_id, effective_from);
CREATE INDEX idx_labor_rate_open ON labor_rate_profile(tenant_id, scope, scope_id, effective_to);

CREATE TABLE equipment_rate_profile (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id             TEXT NOT NULL,
  equipment_id          TEXT NOT NULL,
  purchase_price_cents  INTEGER NOT NULL,
  salvage_cents         INTEGER NOT NULL,
  life_years            INTEGER NOT NULL,
  annual_machine_hours  INTEGER NOT NULL,
  finance_rate          INTEGER NOT NULL, -- ten-thousandths, 0.075 -> 750
  insurance_annual_cents INTEGER NOT NULL DEFAULT 0,
  storage_annual_cents  INTEGER NOT NULL DEFAULT 0,
  fuel_gal_per_hr       INTEGER NOT NULL, -- ten-thousandths, 2.4 -> 24000
  fuel_price_cents      INTEGER NOT NULL, -- cents per gallon, $4.05 -> 405
  repairs_annual_cents  INTEGER NOT NULL DEFAULT 0,
  wear_annual_cents     INTEGER NOT NULL DEFAULT 0,
  lube_pct_of_fuel      INTEGER NOT NULL, -- ten-thousandths, 0.12 -> 1200
  effective_from        TEXT NOT NULL,
  effective_to          TEXT,
  created_at            TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_equipment_rate_scope ON equipment_rate_profile(tenant_id, equipment_id, effective_from);
CREATE INDEX idx_equipment_rate_open ON equipment_rate_profile(tenant_id, equipment_id, effective_to);

CREATE TABLE overhead_pool (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id        TEXT NOT NULL,
  division         TEXT NOT NULL,
  pool_type        TEXT NOT NULL,
  annual_cost_cents INTEGER NOT NULL,
  -- "driver" is the allocation basis (e.g. sellable_hours, revenue). Revenue-driven
  -- pools may never exceed 10% of the tenant's total pool (ALLOCATION.md forbidden rule)
  -- — enforced in application code (src/engines/allocation.ts), not the schema.
  driver           TEXT NOT NULL,
  as_of            TEXT NOT NULL,
  created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_overhead_pool_tenant ON overhead_pool(tenant_id, division, as_of);

CREATE TABLE overhead_allocation (
  id                       INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id                TEXT NOT NULL,
  division                 TEXT NOT NULL,
  as_of                    TEXT NOT NULL,
  sellable_hours           INTEGER NOT NULL,
  allocated_overhead_cents INTEGER NOT NULL,
  weighted_labor_rate_cents INTEGER NOT NULL, -- per hour
  overhead_rate            INTEGER NOT NULL,  -- ten-thousandths, per hour
  absorbed_cost_cents       INTEGER NOT NULL, -- per hour
  target_margin             INTEGER NOT NULL, -- ten-thousandths, 0.40 -> 4000
  required_bill_rate_cents  INTEGER NOT NULL, -- per hour
  created_at                TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_overhead_allocation_tenant ON overhead_allocation(tenant_id, division, as_of);

-- Written ONLY by the nightly rollup (W3-rollup), incrementing ONLY from time_entry
-- hours — never from invoice/deposit/payment events (CLAUDE.md hard rule 3).
CREATE TABLE recovery_snapshot (
  id                       INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id                TEXT NOT NULL,
  as_of                    TEXT NOT NULL,
  restated_target_cents    INTEGER NOT NULL,
  recovered_to_date_cents  INTEGER NOT NULL,
  hours_per_week_hundredths INTEGER NOT NULL,
  blended_overhead_rate    INTEGER NOT NULL, -- ten-thousandths, per hour
  weekly_recovery_cents    INTEGER NOT NULL,
  -- Millionths, not ten-thousandths: the fixture (0.646193) needs 6-decimal
  -- fidelity, more precise than the rate convention's 4 decimals.
  pct_recovered_millionths INTEGER NOT NULL,
  projected_black_friday   TEXT,
  confidence_days          INTEGER NOT NULL,
  created_at               TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX idx_recovery_snapshot_tenant_date ON recovery_snapshot(tenant_id, as_of);
