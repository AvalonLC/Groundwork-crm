-- 0034: Price Book + Estimate/Proposal merge + Job Cost Engine
-- Replaces the owner's pricing spreadsheets:
--   * price_items        = "Service Data" master sheet (Service/Material, Unit, Unit Cost, Unit Time)
--   * pricing settings   = labor rate, OHR, profit %, tax %, warranty %, non-productive, etc. (stored in settings KV)
--   * estimates ext cols = advanced mode (proposal layers), tiers, cost engine data, recurring contracts, job link

-- ── Price Book ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS price_items (
  id           TEXT PRIMARY KEY,
  company_id   TEXT NOT NULL,
  category     TEXT DEFAULT 'General',      -- e.g. Landscaping | Hardscaping/Drainage | Planting | custom
  name         TEXT NOT NULL,               -- Service / Material name
  unit         TEXT DEFAULT '',             -- cubic yard | per sqft | Labor | each | ...
  unit_cost    REAL DEFAULT 0,              -- direct cost per unit
  unit_time    REAL DEFAULT 0,              -- man-hours per unit
  item_type    TEXT DEFAULT 'material',     -- material | labor | service | equipment | plant
  sku          TEXT DEFAULT '',
  vendor       TEXT DEFAULT '',
  notes        TEXT DEFAULT '',
  active       INTEGER DEFAULT 1,
  sort_order   INTEGER DEFAULT 0,
  created_at   TEXT DEFAULT (datetime('now')),
  updated_at   TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_price_items_company  ON price_items(company_id);
CREATE INDEX IF NOT EXISTS idx_price_items_category ON price_items(company_id, category);
CREATE INDEX IF NOT EXISTS idx_price_items_name     ON price_items(company_id, name);

-- ── Estimates: merge + engine extensions ────────────────────────────────────
-- mode: 'simple' (line items only) | 'advanced' (adds overview, sections, tiers, payment schedule)
ALTER TABLE estimates ADD COLUMN mode            TEXT DEFAULT 'simple';
-- doc_type: 'onetime' | 'recurring' (maintenance contract calculator)
ALTER TABLE estimates ADD COLUMN doc_type        TEXT DEFAULT 'onetime';
-- Advanced/proposal layers (ported from proposals table)
ALTER TABLE estimates ADD COLUMN overview        TEXT DEFAULT '';
ALTER TABLE estimates ADD COLUMN sections        TEXT DEFAULT '[]';   -- narrative/scope sections
ALTER TABLE estimates ADD COLUMN tiers           TEXT DEFAULT '[]';   -- [{id,name,desc,line_items:[],total,recommended}]
ALTER TABLE estimates ADD COLUMN accepted_tier   TEXT DEFAULT '';
-- Job Cost Engine (internal; mirrors the owner's spreadsheet TEMPLATE math)
-- {sections:[{name,rows:[{qty,item_id,name,unit,unit_cost,unit_time,total_cost,total_time,taxable}] ,tax_pct,warranty_pct}],
--  labor:{rate,ohr_rate,setup_pay,crew_size,days,nonprod_per_person_day},
--  rollup:{materials,tax,warranty,labor,nonprod_hours,budgeted_hours,direct_expense,ohr,bep,profit_pct,profit,selling_price,rev_per_hour}}
ALTER TABLE estimates ADD COLUMN cost_data       TEXT DEFAULT '{}';
-- Recurring contract calculator (mirrors RESIDENTIAL/COMMERCIAL maintenance templates)
-- {property:{lawn_sqft,bed_sqft,flower_sqft,...},services:[{name,occurrences,materials:[...],man_hours,charge,total}],
--  years:[{year,months,escalation_pct,total,per_month}]}
ALTER TABLE estimates ADD COLUMN recurring_data  TEXT DEFAULT '{}';
-- Convert-to-job link
ALTER TABLE estimates ADD COLUMN work_order_id   TEXT DEFAULT '';
-- AI generation audit
ALTER TABLE estimates ADD COLUMN ai_meta         TEXT DEFAULT '{}';

CREATE INDEX IF NOT EXISTS idx_estimates_portal ON estimates(portal_token);
