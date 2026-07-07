-- Migration 0014: Phase 9 — Field Time / Workday Clock

-- 9B: Add work_order_id linkage to time entries
ALTER TABLE time_entries ADD COLUMN work_order_id TEXT DEFAULT NULL;
ALTER TABLE time_entries ADD COLUMN break_minutes INTEGER DEFAULT 0;

-- 9A/9B: Break entries (separate records per break so 9C can report net time)
CREATE TABLE IF NOT EXISTS break_entries (
  id           TEXT PRIMARY KEY,
  time_entry_id TEXT NOT NULL,
  rep_id       TEXT NOT NULL,
  company_id   TEXT NOT NULL,
  break_start  TEXT NOT NULL,
  break_end    TEXT DEFAULT NULL,
  duration_min INTEGER DEFAULT NULL,
  notes        TEXT DEFAULT '',
  created_at   TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_breaks_entry   ON break_entries(time_entry_id);
CREATE INDEX IF NOT EXISTS idx_breaks_rep     ON break_entries(rep_id, company_id);
CREATE INDEX IF NOT EXISTS idx_breaks_open    ON break_entries(rep_id, break_end) WHERE break_end IS NULL;

-- 9C: Workday settings per company (drives prompting + payroll logic)
CREATE TABLE IF NOT EXISTS workday_settings (
  id                    TEXT PRIMARY KEY DEFAULT 'default',
  company_id            TEXT NOT NULL UNIQUE,
  working_days          TEXT DEFAULT '1,2,3,4,5',   -- CSV of JS day-of-week (0=Sun)
  shift_start           TEXT DEFAULT '07:00',        -- HH:MM local
  shift_end             TEXT DEFAULT '17:00',
  lunch_minutes         INTEGER DEFAULT 30,
  grace_period_minutes  INTEGER DEFAULT 10,
  late_threshold_minutes INTEGER DEFAULT 15,
  overtime_threshold_hours REAL DEFAULT 8.0,
  missed_punch_flag     INTEGER DEFAULT 1,           -- 1=enabled
  prompt_clock_in       INTEGER DEFAULT 1,           -- 1=enabled
  created_at            TEXT DEFAULT (datetime('now')),
  updated_at            TEXT DEFAULT (datetime('now'))
);
