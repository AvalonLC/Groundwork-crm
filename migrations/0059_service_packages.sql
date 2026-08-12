-- Saved service packages (per-company reusable materials/equipment/checklist
-- bundles for the Schedule board's visit editor "Add Package" picker)
CREATE TABLE IF NOT EXISTS service_packages (
  id           TEXT PRIMARY KEY,
  company_id   TEXT NOT NULL,
  name         TEXT NOT NULL DEFAULT '',
  category     TEXT DEFAULT 'My Packages',
  materials    TEXT DEFAULT '[]',
  equipment    TEXT DEFAULT '[]',
  checklist    TEXT DEFAULT '[]',
  created_by   TEXT DEFAULT '',
  created_at   TEXT DEFAULT (datetime('now')),
  updated_at   TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_service_packages_company ON service_packages(company_id);
