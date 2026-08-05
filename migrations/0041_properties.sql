-- Migration 0041: First-class properties table
-- Promotes the clients.properties JSON blob to a real table so estimates,
-- invoices, projects, and portal access can be property-scoped.

CREATE TABLE IF NOT EXISTS properties (
  id          TEXT PRIMARY KEY,
  company_id  TEXT NOT NULL,
  client_id   TEXT NOT NULL,
  label       TEXT NOT NULL DEFAULT 'Primary Property',
  street      TEXT DEFAULT '',
  street2     TEXT DEFAULT '',
  city        TEXT DEFAULT '',
  state       TEXT DEFAULT '',
  zip         TEXT DEFAULT '',
  notes       TEXT DEFAULT '',            -- internal only, never shown in portal
  is_primary  INTEGER DEFAULT 0,
  active      INTEGER DEFAULT 1,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_properties_client  ON properties(client_id);
CREATE INDEX IF NOT EXISTS idx_properties_company ON properties(company_id);

-- Backfill: one primary property per existing client, carrying over address data.
-- Uses a deterministic id (prop_ + client id) so re-running is idempotent.
INSERT OR IGNORE INTO properties (id, company_id, client_id, label, street, street2, city, state, zip, is_primary)
SELECT 'prop_' || id, company_id, id, 'Primary Property',
       COALESCE(NULLIF(street,''), address, ''), COALESCE(street2,''),
       COALESCE(city,''), COALESCE(state,''), COALESCE(zip,''), 1
FROM clients;

-- Property links on financial/work records (nullable — legacy rows stay unlinked
-- and are treated as belonging to the client's primary property).
-- NOTE: estimates.property_id already exists from an earlier migration.
ALTER TABLE invoices    ADD COLUMN property_id TEXT DEFAULT '';
ALTER TABLE work_orders ADD COLUMN property_id TEXT DEFAULT '';
ALTER TABLE proposals   ADD COLUMN property_id TEXT DEFAULT '';
