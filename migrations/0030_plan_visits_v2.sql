-- Migration 0025: Expand plan_visits + subscription for full recurring service ops
-- Adds: crew/employee assignment, priority note (per-visit), photo storage,
--       budgeted hours, address override, acknowledgement tracking

-- ── Expand plan_visits ────────────────────────────────────────────────────────
ALTER TABLE plan_visits ADD COLUMN crew_id       TEXT    DEFAULT '';
ALTER TABLE plan_visits ADD COLUMN crew_name     TEXT    DEFAULT '';
ALTER TABLE plan_visits ADD COLUMN employee_ids  TEXT    DEFAULT '[]';
-- JSON: ["empId1","empId2"]
ALTER TABLE plan_visits ADD COLUMN employee_names TEXT   DEFAULT '[]';
-- JSON: ["Name1","Name2"] (denormalized for display speed)
ALTER TABLE plan_visits ADD COLUMN budgeted_hours REAL   DEFAULT 0;
ALTER TABLE plan_visits ADD COLUMN actual_hours   REAL   DEFAULT 0;
ALTER TABLE plan_visits ADD COLUMN address        TEXT   DEFAULT '';
-- Override service address for this specific visit
ALTER TABLE plan_visits ADD COLUMN priority_note  TEXT   DEFAULT '';
-- Highlighted note crew MUST acknowledge before marking complete
ALTER TABLE plan_visits ADD COLUMN priority_ack   INTEGER DEFAULT 0;
-- 1 = crew acknowledged the priority note
ALTER TABLE plan_visits ADD COLUMN priority_ack_by TEXT  DEFAULT '';
-- Employee name who acknowledged
ALTER TABLE plan_visits ADD COLUMN priority_ack_at TEXT  DEFAULT '';
-- ISO timestamp of acknowledgement
ALTER TABLE plan_visits ADD COLUMN photos         TEXT   DEFAULT '[]';
-- JSON: [{url, caption, uploaded_at}]
ALTER TABLE plan_visits ADD COLUMN checklist_state TEXT  DEFAULT '{}';
-- JSON: {taskId: true/false} — per-visit task completion state
ALTER TABLE plan_visits ADD COLUMN visit_notes    TEXT   DEFAULT '';
-- General notes for this specific visit occurrence
ALTER TABLE plan_visits ADD COLUMN updated_at     TEXT   DEFAULT (datetime('now'));

-- ── Expand client_plan_subscriptions ─────────────────────────────────────────
ALTER TABLE client_plan_subscriptions ADD COLUMN default_crew_id    TEXT DEFAULT '';
ALTER TABLE client_plan_subscriptions ADD COLUMN default_crew_name  TEXT DEFAULT '';
ALTER TABLE client_plan_subscriptions ADD COLUMN default_employees  TEXT DEFAULT '[]';
-- JSON: [{id, name}]
ALTER TABLE client_plan_subscriptions ADD COLUMN service_address    TEXT DEFAULT '';
-- Default service address for this client's subscription
ALTER TABLE client_plan_subscriptions ADD COLUMN property_access    TEXT DEFAULT '';
-- Gate codes, entry instructions etc.

-- ── New index for fast crew lookup ────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_plan_visits_crew   ON plan_visits(crew_id);
CREATE INDEX IF NOT EXISTS idx_plan_visits_status ON plan_visits(status);
