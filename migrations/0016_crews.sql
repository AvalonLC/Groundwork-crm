-- Migration 0016: Crew Management + Schedule Events + Work Orders D1

-- ── CREWS ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS crews (
  id          TEXT PRIMARY KEY,
  company_id  TEXT NOT NULL,
  name        TEXT NOT NULL,
  color       TEXT NOT NULL DEFAULT '#22c55e',  -- crew color hex
  active      INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_crews_company ON crews(company_id, active);

-- ── CREW MEMBERS ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS crew_members (
  id          TEXT PRIMARY KEY,
  crew_id     TEXT NOT NULL,
  rep_id      TEXT NOT NULL,
  company_id  TEXT NOT NULL,
  crew_role   TEXT NOT NULL DEFAULT 'laborer',  -- 'foreman' | 'laborer'
  joined_at   TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (crew_id) REFERENCES crews(id) ON DELETE CASCADE,
  FOREIGN KEY (rep_id)  REFERENCES reps(id)
);
CREATE INDEX IF NOT EXISTS idx_crew_members_crew    ON crew_members(crew_id);
CREATE INDEX IF NOT EXISTS idx_crew_members_rep     ON crew_members(rep_id, company_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_crew_members_uniq ON crew_members(crew_id, rep_id);

-- ── WORK ORDERS (D1-backed, replaces localStorage) ────────────────────────────
CREATE TABLE IF NOT EXISTS work_orders (
  id              TEXT PRIMARY KEY,
  company_id      TEXT NOT NULL,
  wo_number       TEXT NOT NULL,          -- 'WO-00001'
  opp_id          TEXT DEFAULT NULL,      -- FK → opportunities.id (created from estimate)
  estimate_id     TEXT DEFAULT NULL,      -- local reference to estimate
  crew_id         TEXT DEFAULT NULL,      -- FK → crews.id
  client_name     TEXT DEFAULT '',
  client_id       TEXT DEFAULT NULL,      -- FK → clients.id
  property_addr   TEXT DEFAULT '',
  title           TEXT DEFAULT '',        -- job description / estimate title
  type            TEXT DEFAULT 'Service', -- 'Service' | 'Install' | 'Maintenance' | etc.
  status          TEXT DEFAULT 'scheduled', -- scheduled | in-progress | completed | on-hold | cancelled
  readiness       TEXT DEFAULT 'ready',
  scheduled_date  TEXT DEFAULT NULL,      -- ISO date YYYY-MM-DD
  scheduled_time  TEXT DEFAULT NULL,      -- HH:MM
  duration_hours  REAL DEFAULT NULL,      -- estimated hours
  actual_hours    REAL DEFAULT NULL,      -- from time tracking
  notes           TEXT DEFAULT '',        -- scope / crew notes
  completion_notes TEXT DEFAULT '',
  invoice_id      TEXT DEFAULT NULL,      -- after invoiced
  amount_est      REAL DEFAULT 0,
  amount_actual   REAL DEFAULT 0,
  before_photos   TEXT DEFAULT '[]',      -- JSON array of URLs
  after_photos    TEXT DEFAULT '[]',
  checklist       TEXT DEFAULT '[]',      -- JSON array {text, done}
  materials       TEXT DEFAULT '[]',      -- JSON array {name, qty, unit}
  timeline        TEXT DEFAULT '[]',      -- JSON array of timeline events
  created_by      TEXT DEFAULT NULL,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (crew_id) REFERENCES crews(id)
);
CREATE INDEX IF NOT EXISTS idx_wo_company    ON work_orders(company_id, status);
CREATE INDEX IF NOT EXISTS idx_wo_crew       ON work_orders(crew_id, scheduled_date);
CREATE INDEX IF NOT EXISTS idx_wo_date       ON work_orders(company_id, scheduled_date);
CREATE INDEX IF NOT EXISTS idx_wo_opp        ON work_orders(opp_id);

-- ── WORK ORDER EMPLOYEES (many crew members assigned per visit) ───────────────
CREATE TABLE IF NOT EXISTS work_order_employees (
  id          TEXT PRIMARY KEY,
  wo_id       TEXT NOT NULL,
  rep_id      TEXT NOT NULL,
  company_id  TEXT NOT NULL,
  FOREIGN KEY (wo_id) REFERENCES work_orders(id) ON DELETE CASCADE,
  FOREIGN KEY (rep_id) REFERENCES reps(id)
);
CREATE INDEX IF NOT EXISTS idx_woe_wo  ON work_order_employees(wo_id);
CREATE INDEX IF NOT EXISTS idx_woe_rep ON work_order_employees(rep_id, company_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_woe_uniq ON work_order_employees(wo_id, rep_id);
