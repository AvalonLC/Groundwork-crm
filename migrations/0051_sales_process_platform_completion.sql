-- Additive completion primitives for immutable process publication. No live
-- opportunity data or legacy pipeline settings are changed by this migration.
ALTER TABLE sales_process_versions ADD COLUMN content_revision INTEGER NOT NULL DEFAULT 1;
ALTER TABLE sales_process_versions ADD COLUMN approved_snapshot_id TEXT DEFAULT '';
ALTER TABLE sales_process_versions ADD COLUMN approved_at TEXT DEFAULT '';
ALTER TABLE sales_process_versions ADD COLUMN approved_by TEXT DEFAULT '';

ALTER TABLE sales_stage_transitions ADD COLUMN outcome_type TEXT DEFAULT '';
ALTER TABLE sales_stage_transitions ADD COLUMN display_label TEXT DEFAULT '';
ALTER TABLE sales_stage_transitions ADD COLUMN guidance TEXT DEFAULT '';
ALTER TABLE sales_stage_transitions ADD COLUMN display_order INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sales_stage_transitions ADD COLUMN override_policy TEXT NOT NULL DEFAULT 'stage_policy';
ALTER TABLE sales_stage_transitions ADD COLUMN created_by TEXT DEFAULT '';
ALTER TABLE sales_stage_transitions ADD COLUMN updated_by TEXT DEFAULT '';
ALTER TABLE sales_stage_transitions ADD COLUMN updated_at TEXT DEFAULT '';

CREATE INDEX IF NOT EXISTS idx_sales_transition_company
  ON sales_stage_transitions(company_id, id, process_version_id);
CREATE INDEX IF NOT EXISTS idx_sales_publication_company
  ON sales_process_publications(company_id, id, process_version_id);

CREATE TABLE IF NOT EXISTS sales_process_company_state (
  company_id TEXT PRIMARY KEY, active_process_id TEXT NOT NULL,
  active_process_version_id TEXT NOT NULL, activated_publication_id TEXT NOT NULL,
  updated_by TEXT NOT NULL, updated_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_sales_company_active_version
  ON sales_process_company_state(company_id, active_process_version_id);

CREATE TABLE IF NOT EXISTS sales_migration_snapshots (
  id TEXT PRIMARY KEY, company_id TEXT NOT NULL, process_version_id TEXT NOT NULL,
  migration_batch_id TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'captured',
  source_revision TEXT NOT NULL, reconciliation_json TEXT NOT NULL DEFAULT '{}',
  approved_by TEXT DEFAULT '', approved_at TEXT DEFAULT '', created_by TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_sales_snapshot_company
  ON sales_migration_snapshots(company_id, id, process_version_id);
CREATE INDEX IF NOT EXISTS idx_sales_snapshot_batch
  ON sales_migration_snapshots(company_id, migration_batch_id);

CREATE TABLE IF NOT EXISTS sales_migration_snapshot_items (
  id TEXT PRIMARY KEY, company_id TEXT NOT NULL, snapshot_id TEXT NOT NULL,
  opportunity_id TEXT NOT NULL, source_updated_at TEXT NOT NULL,
  original_status TEXT DEFAULT '', original_pipeline_stage TEXT DEFAULT '',
  original_stage_id TEXT DEFAULT '', snapshot_json TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(company_id, snapshot_id, opportunity_id)
);
CREATE INDEX IF NOT EXISTS idx_sales_snapshot_items_opportunity
  ON sales_migration_snapshot_items(company_id, opportunity_id, snapshot_id);

CREATE TABLE IF NOT EXISTS sales_stage_checklist_evidence (
  id TEXT PRIMARY KEY, company_id TEXT NOT NULL, opportunity_id TEXT NOT NULL,
  process_version_id TEXT NOT NULL, stage_id TEXT NOT NULL, requirement_id TEXT NOT NULL,
  completed INTEGER NOT NULL DEFAULT 0, evidence_json TEXT NOT NULL DEFAULT '{}',
  completed_by TEXT DEFAULT '', completed_at TEXT DEFAULT '', updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(company_id, opportunity_id, process_version_id, requirement_id)
);
CREATE INDEX IF NOT EXISTS idx_sales_checklist_opportunity
  ON sales_stage_checklist_evidence(company_id, opportunity_id, process_version_id);

CREATE TABLE IF NOT EXISTS sales_academy_associations (
  id TEXT PRIMARY KEY, company_id TEXT NOT NULL, process_version_id TEXT NOT NULL,
  stage_id TEXT DEFAULT '', internal_status_id TEXT DEFAULT '', skill_id TEXT NOT NULL,
  visibility TEXT NOT NULL DEFAULT 'representative', display_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_sales_academy_association_version
  ON sales_academy_associations(company_id, process_version_id, stage_id);

-- Reusable global building blocks. They are immutable sources and are copied,
-- with fresh stable IDs, whenever a tenant adopts them.
INSERT OR IGNORE INTO sales_process_blocks
  (id,company_id,stable_key,name,semantic_type,definition_json,is_global,immutable)
VALUES
('block_lead_intake','__global__','lead_intake','Lead intake','intake','{"purpose":"Capture, acknowledge, assign, and route an inquiry"}',1,1),
('block_contact_attempts','__global__','contact_attempts','Contact attempts','active_qualification','{"purpose":"Run a prompt, finite contact sequence"}',1,1),
('block_qualification','__global__','qualification_call','Qualification call','active_qualification','{"purpose":"Determine fit, urgency, budget comfort, and decision process"}',1,1),
('block_consultation','__global__','consultation','Consultation','consultation','{"purpose":"Deepen discovery with the customer"}',1,1),
('block_site_visit','__global__','site_visit','Site visit','consultation','{"purpose":"Document property conditions, measurements, and constraints"}',1,1),
('block_needs','__global__','needs_assessment','Needs assessment','consultation','{"purpose":"Capture priorities and buying reasons"}',1,1),
('block_scope','__global__','scope_discovery','Scope discovery','consultation','{"purpose":"Define an estimate-ready scope"}',1,1),
('block_estimate','__global__','estimate_development','Estimate development','estimate_development','{"purpose":"Price labor, materials, options, and margin"}',1,1),
('block_proposal','__global__','proposal_preparation','Proposal preparation','estimate_development','{"purpose":"Prepare a customer-ready proposal"}',1,1),
('block_presentation','__global__','estimate_presentation','Estimate presentation','proposal_presentation','{"purpose":"Review the estimate live and request a decision"}',1,1),
('block_negotiation','__global__','negotiation','Negotiation','decision','{"purpose":"Resolve material concerns without losing next-step ownership"}',1,1),
('block_followup','__global__','decision_follow_up','Decision follow-up','decision','{"purpose":"Maintain a time-bound decision plan"}',1,1),
('block_contract','__global__','contract','Contract','won','{"purpose":"Capture accepted scope and signature"}',1,1),
('block_deposit','__global__','deposit','Deposit','won','{"purpose":"Capture deposit state and handoff readiness"}',1,1),
('block_won','__global__','won','Won','won','{"outcome":"won"}',1,1),
('block_lost','__global__','lost','Lost','lost','{"outcome":"lost","requires_lost_reason":true}',1,1),
('block_disqualified','__global__','disqualified','Disqualified','disqualified','{"outcome":"disqualified"}',1,1),
('block_nurture','__global__','nurture','Nurture','nurture','{"outcome":"nurture","requires_next_action_date":true}',1,1);

INSERT OR IGNORE INTO sales_academy_skills
  (id,company_id,stable_key,title,content_json,is_global,active)
VALUES
('skill_mutual_agreements','__global__','mutual_agreements','Mutual agreements','{}',1,1),
('skill_buying_reasons','__global__','core_buying_reasons','Core buying reasons','{}',1,1),
('skill_budget','__global__','budget_conversations','Budget conversations','{}',1,1),
('skill_decision_makers','__global__','decision_makers','Decision makers','{}',1,1),
('skill_decision_process','__global__','decision_process','Decision process','{}',1,1),
('skill_initial_qualification','__global__','initial_qualification','Initial qualification','{}',1,1),
('skill_onsite_discovery','__global__','onsite_discovery','On-site discovery','{}',1,1),
('skill_scope_development','__global__','scope_development','Scope development','{}',1,1),
('skill_estimate_creation','__global__','estimate_creation','Estimate creation','{}',1,1),
('skill_estimate_presentation','__global__','estimate_presentation','Estimate presentation','{}',1,1),
('skill_objection_handling','__global__','objection_handling','Objection handling','{}',1,1),
('skill_follow_up','__global__','follow_up','Follow-up','{}',1,1),
('skill_closing','__global__','closing','Closing','{}',1,1),
('skill_lost_review','__global__','lost_opportunity_review','Lost-opportunity review','{}',1,1),
('skill_nurture','__global__','nurture','Nurture','{}',1,1);

-- Additional templates are intentionally different starting points. Publication
-- never activates them; adoption creates tenant-owned draft content.
INSERT OR IGNORE INTO sales_processes
  (id,company_id,name,description,is_template,is_immutable,created_by)
VALUES
('tpl_design_build','__global__','High-Ticket Design-Build','Long-cycle design, feasibility, presentation, and contract process',1,1,'system'),
('tpl_maintenance','__global__','Recurring Maintenance','Route, assess, quote, activate, and renew recurring service',1,1,'system'),
('tpl_fast_turn','__global__','Fast-Turn Service Sales','Rapid qualification, remote estimate, approval, and scheduling',1,1,'system'),
('tpl_commercial_bid','__global__','Commercial Bid Work','Qualification, site review, bid development, submission, and award',1,1,'system');
INSERT OR IGNORE INTO sales_process_versions
  (id,company_id,process_id,version_number,lifecycle,created_by)
VALUES
('tpl_design_build_v1','__global__','tpl_design_build',1,'template','system'),
('tpl_maintenance_v1','__global__','tpl_maintenance',1,'template','system'),
('tpl_fast_turn_v1','__global__','tpl_fast_turn',1,'template','system'),
('tpl_commercial_bid_v1','__global__','tpl_commercial_bid',1,'template','system');
