-- Migration 0046: Add phase and dependency metadata to multi-day work order days.

ALTER TABLE wo_days ADD COLUMN phase_name TEXT DEFAULT '';
ALTER TABLE wo_days ADD COLUMN phase_sequence INTEGER DEFAULT 1;
ALTER TABLE wo_days ADD COLUMN crew_id TEXT DEFAULT '';
ALTER TABLE wo_days ADD COLUMN depends_on_day_number INTEGER DEFAULT NULL;
ALTER TABLE wo_days ADD COLUMN dependency_type TEXT DEFAULT 'finish_to_start';
ALTER TABLE wo_days ADD COLUMN dependency_lag_days INTEGER DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_wodays_company_date ON wo_days(company_id, day_date);
CREATE INDEX IF NOT EXISTS idx_wodays_wo_phase ON wo_days(work_order_id, phase_sequence, day_date);
