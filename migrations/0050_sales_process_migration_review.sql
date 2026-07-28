-- Preserve the opportunity revision reviewed by each proposed mapping. These
-- additive columns let publication reject a proposal after its source changed.
ALTER TABLE sales_migration_mappings ADD COLUMN opportunity_updated_at TEXT DEFAULT '';
ALTER TABLE sales_migration_mappings ADD COLUMN assignment_snapshot TEXT DEFAULT '';
