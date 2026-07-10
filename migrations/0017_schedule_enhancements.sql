-- Migration 0017: Schedule enhancements
-- • Add division to crews
-- • Add equipment/materials_crew column to work_orders (crew-visible gear list)
-- • Add end_time computed column support (stored)

ALTER TABLE crews ADD COLUMN division TEXT DEFAULT NULL;

ALTER TABLE work_orders ADD COLUMN equipment TEXT DEFAULT '[]';
ALTER TABLE work_orders ADD COLUMN scheduled_end_time TEXT DEFAULT NULL;
