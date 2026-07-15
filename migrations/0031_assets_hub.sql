-- ============================================================
-- Groundwork CRM — Migration 0031
-- Unified Assets Hub: assets, service plans, service log, stock
--
-- Replaces the localStorage-only assets/maintenance/inventory/
-- tools pages with proper multi-tenant D1 tables so mechanics,
-- foremen, and managers all see the same live equipment data.
-- Modeled on the Avalon Asset Maintenance spreadsheet.
-- ============================================================

-- ── Assets (vehicles, trailers, equipment, mowers, attachments) ──
CREATE TABLE IF NOT EXISTS assets (
  id            TEXT PRIMARY KEY,
  company_id    TEXT NOT NULL,
  asset_tag     TEXT DEFAULT '',            -- e.g. "#01"
  name          TEXT NOT NULL,
  category      TEXT DEFAULT 'equipment',   -- vehicle|trailer|equipment|mower|attachment|tool|tech|other
  year          INTEGER,
  make          TEXT DEFAULT '',
  model         TEXT DEFAULT '',
  vin           TEXT DEFAULT '',            -- VIN / SKU / Serial
  engine_notes  TEXT DEFAULT '',            -- engine spec / general service notes
  meter_type    TEXT DEFAULT 'hours',       -- miles|hours
  current_meter REAL,
  meter_updated_at TEXT,
  status        TEXT DEFAULT 'active',      -- active|idle|maintenance|retired|rented|out-of-service
  assigned_to   TEXT DEFAULT '',
  location      TEXT DEFAULT '',
  notes         TEXT DEFAULT '',
  active        INTEGER DEFAULT 1,
  created_at    TEXT DEFAULT (datetime('now')),
  updated_at    TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_assets_company ON assets(company_id, active);

-- ── Service plans (one row per service type per asset) ────────
CREATE TABLE IF NOT EXISTS asset_service_plans (
  id              TEXT PRIMARY KEY,
  company_id      TEXT NOT NULL,
  asset_id        TEXT NOT NULL,
  service_type    TEXT NOT NULL,            -- oil|air|fuel|brakes|rotors|blades|custom
  label           TEXT DEFAULT '',          -- display label e.g. "Oil & Filter"
  material_spec   TEXT DEFAULT '',          -- e.g. "SAE 5W-30 + ACDelco PF46E, 6 qt"
  interval_meter  REAL,                     -- service every N miles/hours
  interval_months REAL,                     -- service every N months
  last_date       TEXT,
  last_meter      REAL,
  next_date       TEXT,
  next_meter      REAL,
  sort_order      INTEGER DEFAULT 0,
  created_at      TEXT DEFAULT (datetime('now')),
  updated_at      TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_asset_plans_asset ON asset_service_plans(asset_id);
CREATE INDEX IF NOT EXISTS idx_asset_plans_company ON asset_service_plans(company_id);

-- ── Service log (history of completed services) ───────────────
CREATE TABLE IF NOT EXISTS asset_service_log (
  id             TEXT PRIMARY KEY,
  company_id     TEXT NOT NULL,
  asset_id       TEXT NOT NULL,
  plan_id        TEXT,
  service_type   TEXT DEFAULT '',
  performed_date TEXT,
  performed_meter REAL,
  performed_by   TEXT DEFAULT '',
  cost           REAL,
  notes          TEXT DEFAULT '',
  created_at     TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_asset_log_asset ON asset_service_log(asset_id);
CREATE INDEX IF NOT EXISTS idx_asset_log_company ON asset_service_log(company_id);

-- ── Stock items (unified inventory + tools + consumables) ─────
CREATE TABLE IF NOT EXISTS stock_items (
  id          TEXT PRIMARY KEY,
  company_id  TEXT NOT NULL,
  name        TEXT NOT NULL,
  item_type   TEXT DEFAULT 'material',      -- material|part|supply|tool|consumable|safety|chemical|other
  on_hand     REAL DEFAULT 0,
  unit        TEXT DEFAULT 'ea',
  reorder_at  REAL DEFAULT 0,
  vendor      TEXT DEFAULT '',
  location    TEXT DEFAULT '',
  unit_cost   REAL,
  notes       TEXT DEFAULT '',
  active      INTEGER DEFAULT 1,
  created_at  TEXT DEFAULT (datetime('now')),
  updated_at  TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_stock_company ON stock_items(company_id, active);
