-- Migration 0010: Time Tracking / Payroll
-- Tracks clock-in/out entries per rep with admin approval workflow

CREATE TABLE IF NOT EXISTS time_entries (
  id            TEXT PRIMARY KEY,
  rep_id        TEXT NOT NULL,
  company_id    TEXT NOT NULL,
  clock_in      TEXT NOT NULL,               -- ISO datetime
  clock_out     TEXT DEFAULT NULL,           -- NULL = currently clocked in
  duration_min  INTEGER DEFAULT NULL,        -- computed on clock-out (minutes)
  job_type      TEXT DEFAULT 'General Work', -- e.g. General Work, Sales Visit, Admin
  notes         TEXT DEFAULT '',
  approved      INTEGER DEFAULT 0,           -- 0=pending, 1=approved, 2=rejected
  approved_by   TEXT DEFAULT '',
  approved_at   TEXT DEFAULT NULL,
  created_at    TEXT DEFAULT (datetime('now')),
  updated_at    TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_time_entries_rep     ON time_entries(rep_id, company_id);
CREATE INDEX IF NOT EXISTS idx_time_entries_company ON time_entries(company_id, clock_in);
CREATE INDEX IF NOT EXISTS idx_time_entries_open    ON time_entries(rep_id, clock_out) WHERE clock_out IS NULL;
