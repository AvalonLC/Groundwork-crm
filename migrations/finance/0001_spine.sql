-- Finance OS: event spine (tenant policy, time entries, work items, cost ledger)
-- Money: INTEGER cents. Hours: INTEGER hundredths (750 = 7.50h) — every value here
-- stays an integer type, consistent with the rate convention even though only money
-- is a hard requirement.
-- See docs/spec/SCHEMA.md.

CREATE TABLE tenant_finance_policy (
  tenant_id                   TEXT PRIMARY KEY,
  equipment_engine_active     INTEGER NOT NULL DEFAULT 0, -- 0/1 boolean
  materiality_threshold_cents INTEGER NOT NULL DEFAULT 0,
  restated_target_cents       INTEGER NOT NULL DEFAULT 0,
  black_friday_date           TEXT,                       -- YYYY-MM-DD
  created_at                  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at                  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE work_item (
  id           TEXT PRIMARY KEY,
  tenant_id    TEXT NOT NULL,
  job_id       TEXT NOT NULL,
  description  TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'open', -- open | complete
  estimate_cents INTEGER,
  completed_at TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_work_item_tenant_status ON work_item(tenant_id, status);
CREATE INDEX idx_work_item_job ON work_item(tenant_id, job_id);

CREATE TABLE time_entry (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id             TEXT NOT NULL,
  employee_id           TEXT NOT NULL,
  crew_id               TEXT,
  job_id                TEXT NOT NULL,
  work_date             TEXT NOT NULL,             -- YYYY-MM-DD
  hours_hundredths      INTEGER NOT NULL,           -- 750 = 7.50h
  ot_hours_hundredths   INTEGER NOT NULL DEFAULT 0,
  -- Written ONCE at posting by /internal/rates/resolve. Never recomputed on read.
  resolved_rate         INTEGER,                    -- ten-thousandths, e.g. 421002 = $42.1002
  resolved_rate_confidence TEXT,                     -- high | medium | low
  applied_overhead_cents INTEGER,
  posted_at             TEXT,                        -- NULL until posting writes the two ledger lines
  created_at            TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_time_entry_tenant_date ON time_entry(tenant_id, work_date);
CREATE INDEX idx_time_entry_employee ON time_entry(tenant_id, employee_id, work_date);
CREATE INDEX idx_time_entry_unposted ON time_entry(tenant_id, posted_at);

-- Two-line cost posting per time_entry (POSTING.md): one labor line, one overhead
-- line. Immutable once written.
CREATE TABLE job_cost_ledger (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id      TEXT NOT NULL,
  time_entry_id  INTEGER NOT NULL REFERENCES time_entry(id),
  job_id         TEXT NOT NULL,
  line_type      TEXT NOT NULL CHECK (line_type IN ('labor','overhead')),
  amount_cents   INTEGER NOT NULL,
  division       TEXT,
  posted_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_job_cost_ledger_job ON job_cost_ledger(tenant_id, job_id);
CREATE INDEX idx_job_cost_ledger_time_entry ON job_cost_ledger(time_entry_id);
