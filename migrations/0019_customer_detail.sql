-- Migration 0019: Customer detail enhancements
-- • Extend clients table with richer fields (safe - use IF NOT EXISTS pattern via separate ALTER)
-- • Add customer_notes table
-- • Add attachments column to work_orders
-- • Add client_id index to work_orders

-- Extend clients table (each column wrapped so failures on existing are ignorable)
ALTER TABLE clients ADD COLUMN street TEXT DEFAULT '';
ALTER TABLE clients ADD COLUMN street2 TEXT DEFAULT '';
ALTER TABLE clients ADD COLUMN city TEXT DEFAULT '';
ALTER TABLE clients ADD COLUMN state TEXT DEFAULT '';
ALTER TABLE clients ADD COLUMN zip TEXT DEFAULT '';
ALTER TABLE clients ADD COLUMN mobile TEXT DEFAULT '';
ALTER TABLE clients ADD COLUMN email2 TEXT DEFAULT '';
ALTER TABLE clients ADD COLUMN since TEXT DEFAULT NULL;
ALTER TABLE clients ADD COLUMN tags TEXT DEFAULT '[]';
ALTER TABLE clients ADD COLUMN properties TEXT DEFAULT '[]';
ALTER TABLE clients ADD COLUMN status TEXT DEFAULT 'Active';

-- Customer notes (internal, not visible to customer)
CREATE TABLE IF NOT EXISTS customer_notes (
  id          TEXT PRIMARY KEY,
  client_id   TEXT NOT NULL,
  company_id  TEXT NOT NULL,
  note        TEXT NOT NULL DEFAULT '',
  type        TEXT DEFAULT 'customer',
  created_by  TEXT DEFAULT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_cnotes_client ON customer_notes(client_id, company_id);

-- Add attachments column to work_orders (JSON array of {name, url, type})
ALTER TABLE work_orders ADD COLUMN attachments TEXT DEFAULT '[]';

-- Index for filtering work orders by client
CREATE INDEX IF NOT EXISTS idx_wo_client ON work_orders(client_id, company_id);
