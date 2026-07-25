-- Add independent phase timing and scheduling controls for the dispatch timeline.

ALTER TABLE wo_days ADD COLUMN start_time TEXT DEFAULT NULL;
ALTER TABLE wo_days ADD COLUMN end_time TEXT DEFAULT NULL;
ALTER TABLE wo_days ADD COLUMN scheduled_duration_minutes INTEGER DEFAULT NULL;
ALTER TABLE wo_days ADD COLUMN schedule_locked INTEGER DEFAULT 0;

ALTER TABLE work_orders ADD COLUMN scheduled_duration_minutes INTEGER DEFAULT NULL;
ALTER TABLE work_orders ADD COLUMN schedule_locked INTEGER DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_wodays_company_timeline ON wo_days(company_id, day_date, start_time, crew_id);
CREATE INDEX IF NOT EXISTS idx_workorders_company_timeline ON work_orders(company_id, scheduled_date, scheduled_time, crew_id);
