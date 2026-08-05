-- Normalized, tenant-isolated sales process model. Existing text stages remain
-- in place during the compatibility period; no opportunity is remapped here.
ALTER TABLE opportunities ADD COLUMN sales_process_stage_id TEXT DEFAULT '';

CREATE TABLE IF NOT EXISTS sales_processes (
  id TEXT PRIMARY KEY, company_id TEXT NOT NULL, name TEXT NOT NULL,
  description TEXT DEFAULT '', source_template_id TEXT DEFAULT '',
  is_template INTEGER NOT NULL DEFAULT 0, is_immutable INTEGER NOT NULL DEFAULT 0,
  created_by TEXT DEFAULT '', created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_sales_processes_company ON sales_processes(company_id, id);

CREATE TABLE IF NOT EXISTS sales_process_versions (
  id TEXT PRIMARY KEY, company_id TEXT NOT NULL, process_id TEXT NOT NULL,
  version_number INTEGER NOT NULL, lifecycle TEXT NOT NULL DEFAULT 'draft',
  based_on_version_id TEXT DEFAULT '', published_at TEXT DEFAULT '', published_by TEXT DEFAULT '',
  validation_json TEXT DEFAULT '{}', created_by TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(company_id, process_id, version_number)
);
CREATE INDEX IF NOT EXISTS idx_process_versions_company_process ON sales_process_versions(company_id, process_id);
CREATE INDEX IF NOT EXISTS idx_process_versions_company_state ON sales_process_versions(company_id, lifecycle);

CREATE TABLE IF NOT EXISTS sales_process_stages (
  id TEXT PRIMARY KEY, company_id TEXT NOT NULL, process_version_id TEXT NOT NULL,
  stable_key TEXT NOT NULL, display_name TEXT NOT NULL, board_label TEXT DEFAULT '',
  description TEXT DEFAULT '', customer_milestone TEXT DEFAULT '', semantic_type TEXT NOT NULL,
  display_order INTEGER NOT NULL, state TEXT NOT NULL DEFAULT 'active', expected_duration_days INTEGER DEFAULT 0,
  entry_guidance TEXT DEFAULT '', exit_guidance TEXT DEFAULT '', manager_override_policy TEXT DEFAULT 'allowed_with_reason',
  created_by TEXT DEFAULT '', created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(company_id, process_version_id, stable_key)
);
CREATE INDEX IF NOT EXISTS idx_process_stages_company_version ON sales_process_stages(company_id, process_version_id, display_order);
CREATE INDEX IF NOT EXISTS idx_process_stages_company_stage ON sales_process_stages(company_id, id);
CREATE INDEX IF NOT EXISTS idx_process_stages_company_semantic ON sales_process_stages(company_id, semantic_type);

CREATE TABLE IF NOT EXISTS sales_stage_outcomes (
  id TEXT PRIMARY KEY, company_id TEXT NOT NULL, process_version_id TEXT NOT NULL, stage_id TEXT NOT NULL,
  stable_key TEXT NOT NULL, display_name TEXT NOT NULL, semantic_type TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1, config_json TEXT DEFAULT '{}',
  created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(company_id, process_version_id, stable_key)
);
CREATE INDEX IF NOT EXISTS idx_stage_outcomes_company_version ON sales_stage_outcomes(company_id, process_version_id, semantic_type);

CREATE TABLE IF NOT EXISTS sales_stage_internal_statuses (
  id TEXT PRIMARY KEY, company_id TEXT NOT NULL, process_version_id TEXT NOT NULL, stage_id TEXT NOT NULL,
  stable_key TEXT NOT NULL, display_name TEXT NOT NULL, display_order INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_internal_status_company_stage ON sales_stage_internal_statuses(company_id, stage_id);

CREATE TABLE IF NOT EXISTS sales_stage_requirements (
  id TEXT PRIMARY KEY, company_id TEXT NOT NULL, process_version_id TEXT NOT NULL, stage_id TEXT NOT NULL,
  requirement_type TEXT NOT NULL, stable_key TEXT NOT NULL, label TEXT NOT NULL, description TEXT DEFAULT '',
  required_level TEXT NOT NULL DEFAULT 'recommended', display_order INTEGER NOT NULL DEFAULT 0,
  config_json TEXT DEFAULT '{}', created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_stage_requirements_company_stage ON sales_stage_requirements(company_id, stage_id, requirement_type);

CREATE TABLE IF NOT EXISTS sales_stage_guides (
  id TEXT PRIMARY KEY, company_id TEXT NOT NULL, process_version_id TEXT NOT NULL, stage_id TEXT NOT NULL,
  guide_type TEXT NOT NULL, interaction_type TEXT DEFAULT '', title TEXT NOT NULL, purpose TEXT DEFAULT '',
  suggested_language TEXT DEFAULT '', completion_guidance TEXT DEFAULT '', display_order INTEGER DEFAULT 0,
  config_json TEXT DEFAULT '{}', created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_stage_guides_company_stage ON sales_stage_guides(company_id, stage_id, guide_type);

CREATE TABLE IF NOT EXISTS sales_process_resources (
  id TEXT PRIMARY KEY, company_id TEXT NOT NULL, process_version_id TEXT NOT NULL, stage_id TEXT DEFAULT '',
  resource_type TEXT NOT NULL, stable_key TEXT NOT NULL, name TEXT NOT NULL, content_json TEXT DEFAULT '{}',
  active INTEGER NOT NULL DEFAULT 1, created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_process_resources_company_version ON sales_process_resources(company_id, process_version_id, resource_type);

CREATE TABLE IF NOT EXISTS sales_process_automations (
  id TEXT PRIMARY KEY, company_id TEXT NOT NULL, process_version_id TEXT NOT NULL, stage_id TEXT DEFAULT '',
  name TEXT NOT NULL, trigger_type TEXT NOT NULL, action_type TEXT NOT NULL, config_json TEXT DEFAULT '{}',
  active INTEGER NOT NULL DEFAULT 1, created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_process_automations_company_version ON sales_process_automations(company_id, process_version_id);

CREATE TABLE IF NOT EXISTS sales_stage_assignments (
  id TEXT PRIMARY KEY, company_id TEXT NOT NULL, opportunity_id TEXT NOT NULL,
  process_version_id TEXT NOT NULL, stage_id TEXT DEFAULT '', classification TEXT NOT NULL DEFAULT 'mapped',
  outcome_type TEXT DEFAULT '',
  internal_status_id TEXT DEFAULT '', assigned_at TEXT DEFAULT (datetime('now')), assigned_by TEXT DEFAULT '',
  UNIQUE(company_id, opportunity_id, process_version_id)
);
CREATE INDEX IF NOT EXISTS idx_stage_assignments_company_opportunity ON sales_stage_assignments(company_id, opportunity_id);
CREATE INDEX IF NOT EXISTS idx_stage_assignments_company_stage ON sales_stage_assignments(company_id, stage_id);

CREATE TABLE IF NOT EXISTS sales_migration_mappings (
  id TEXT PRIMARY KEY, company_id TEXT NOT NULL, opportunity_id TEXT NOT NULL, migration_batch_id TEXT NOT NULL,
  previous_stage_id TEXT DEFAULT '', previous_label TEXT DEFAULT '', proposed_stage_id TEXT DEFAULT '', final_stage_id TEXT DEFAULT '',
  proposed_outcome_type TEXT DEFAULT '', final_outcome_type TEXT DEFAULT '',
  mapping_method TEXT NOT NULL, mapping_confidence REAL NOT NULL DEFAULT 0, suggestion_reason TEXT DEFAULT '',
  review_state TEXT NOT NULL DEFAULT 'pending', reviewer_id TEXT DEFAULT '', reviewed_at TEXT DEFAULT '',
  process_version_id TEXT NOT NULL, rollback_value TEXT DEFAULT '', created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(company_id, opportunity_id, migration_batch_id)
);
CREATE INDEX IF NOT EXISTS idx_migration_mappings_company_batch ON sales_migration_mappings(company_id, migration_batch_id, review_state);
CREATE INDEX IF NOT EXISTS idx_migration_mappings_company_opportunity ON sales_migration_mappings(company_id, opportunity_id);

CREATE TABLE IF NOT EXISTS sales_migration_history (
  id TEXT PRIMARY KEY, company_id TEXT NOT NULL, migration_batch_id TEXT NOT NULL, opportunity_id TEXT NOT NULL,
  previous_process_version_id TEXT DEFAULT '', new_process_version_id TEXT NOT NULL,
  previous_stage_id TEXT DEFAULT '', previous_label TEXT DEFAULT '', new_stage_id TEXT NOT NULL,
  mapping_id TEXT DEFAULT '', actor_id TEXT NOT NULL, event_type TEXT NOT NULL,
  event_json TEXT DEFAULT '{}', created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_migration_history_company_batch ON sales_migration_history(company_id, migration_batch_id);
CREATE INDEX IF NOT EXISTS idx_migration_history_company_opportunity ON sales_migration_history(company_id, opportunity_id);

CREATE TABLE IF NOT EXISTS sales_process_publications (
  id TEXT PRIMARY KEY, company_id TEXT NOT NULL, process_id TEXT NOT NULL, process_version_id TEXT NOT NULL,
  previous_version_id TEXT DEFAULT '', migration_batch_id TEXT DEFAULT '', action TEXT NOT NULL,
  actor_id TEXT NOT NULL, impact_json TEXT DEFAULT '{}', created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_process_publications_company_process ON sales_process_publications(company_id, process_id, created_at);

CREATE TABLE IF NOT EXISTS sales_ai_suggestions (
  id TEXT PRIMARY KEY, company_id TEXT NOT NULL, process_version_id TEXT NOT NULL, user_id TEXT NOT NULL,
  suggestion_type TEXT NOT NULL, current_json TEXT DEFAULT '{}', proposed_json TEXT NOT NULL, reason TEXT DEFAULT '',
  decision TEXT NOT NULL DEFAULT 'pending', decided_by TEXT DEFAULT '', decided_at TEXT DEFAULT '', created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_ai_suggestions_company_version ON sales_ai_suggestions(company_id, process_version_id);

CREATE TABLE IF NOT EXISTS sales_academy_skills (
  id TEXT PRIMARY KEY, company_id TEXT NOT NULL, stable_key TEXT NOT NULL, title TEXT NOT NULL,
  content_json TEXT DEFAULT '{}', is_global INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(company_id, stable_key)
);
CREATE INDEX IF NOT EXISTS idx_academy_skills_company ON sales_academy_skills(company_id, stable_key);

CREATE TABLE IF NOT EXISTS sales_process_blocks (
  id TEXT PRIMARY KEY, company_id TEXT NOT NULL, stable_key TEXT NOT NULL, name TEXT NOT NULL,
  semantic_type TEXT NOT NULL, definition_json TEXT NOT NULL, is_global INTEGER NOT NULL DEFAULT 0,
  immutable INTEGER NOT NULL DEFAULT 0, created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(company_id, stable_key)
);
CREATE INDEX IF NOT EXISTS idx_process_blocks_company ON sales_process_blocks(company_id, stable_key);

-- Global starter is immutable. Adoption always copies it into tenant-owned rows.
INSERT OR IGNORE INTO sales_processes (id, company_id, name, description, is_template, is_immutable, created_by)
VALUES ('tpl_groundwork_field_service', '__global__', 'Groundwork Field-Service Sales', 'Seven-stage field-service customer journey', 1, 1, 'system');
INSERT OR IGNORE INTO sales_process_versions (id, company_id, process_id, version_number, lifecycle, created_by)
VALUES ('tpl_groundwork_field_service_v1', '__global__', 'tpl_groundwork_field_service', 1, 'template', 'system');

INSERT OR IGNORE INTO sales_process_stages
(id,company_id,process_version_id,stable_key,display_name,board_label,description,customer_milestone,semantic_type,display_order,expected_duration_days,entry_guidance,exit_guidance,manager_override_policy,created_by)
VALUES
('tpl_gw_new','__global__','tpl_groundwork_field_service_v1','new_lead','New Lead','New Lead','Capture and route every new inquiry for immediate attention.','The inquiry is acknowledged and owned.','intake',1,1,'Capture source, owner, contact details, property, service, and response deadline.','The representative begins the contact process.','allowed_with_reason','system'),
('tpl_gw_qualify','__global__','tpl_groundwork_field_service_v1','connect_qualify','Connect & Qualify','Connect & Qualify','Connect, determine fit, and schedule the on-site consultation.','The customer and company agree an on-site consultation is worthwhile.','active_qualification',2,10,'Run a conversational qualification call and active contact sequence.','The on-site consultation is scheduled.','allowed_with_reason','system'),
('tpl_gw_consult','__global__','tpl_groundwork_field_service_v1','onsite_consultation','On-Site Consultation','Consultation','Walk the property, deepen discovery, and define the project.','The property and desired outcome are understood.','consultation',3,14,'Confirm the appointment and prepare known customer context.','The walkthrough is complete and sufficient information exists to estimate.','allowed_with_reason','system'),
('tpl_gw_estimate','__global__','tpl_groundwork_field_service_v1','estimate_development','Estimate Development','Estimate','Turn discovery and scope into an accurate estimate.','A review-ready solution and price are prepared.','estimate_development',4,7,'Review scope, labor, materials, options, margin, and approvals.','The estimate is complete and a review meeting is scheduled.','allowed_with_reason','system'),
('tpl_gw_present','__global__','tpl_groundwork_field_service_v1','estimate_presentation','Estimate Presentation','Presentation','Present live, connect recommendations to buying reasons, address concerns, and ask for the sale.','The customer understands the proposed solution and price.','proposal_presentation',5,5,'A complete estimate and presentation appointment are required.','Approval closes Won; decline closes Lost; delay moves to Decision Pending; material revision returns to Estimate Development.','allowed_with_reason','system'),
('tpl_gw_decision','__global__','tpl_groundwork_field_service_v1','decision_pending','Decision Pending','Decision','Manage an active, time-bound customer decision.','The customer reaches a final decision.','decision',6,14,'Capture delay reason, objection, next action, next-action date, and follow-up plan.','A final yes or no is received; inactive timelines move to Long-Term Nurture.','allowed_with_reason','system'),
('tpl_gw_closed','__global__','tpl_groundwork_field_service_v1','closed','Closed','Closed','Record the conceptual final stage with separate Won and Lost outcomes.','The opportunity has a documented final outcome.','won',7,0,'Confirm the final outcome and completion information.','Terminal stage.','manager_approval','system');

INSERT OR IGNORE INTO sales_stage_outcomes
(id,company_id,process_version_id,stage_id,stable_key,display_name,semantic_type,config_json)
VALUES
('tpl_gw_outcome_won','__global__','tpl_groundwork_field_service_v1','tpl_gw_closed','closed_won','Closed — Won','won','{"required":["final_value","accepted_scope","contract_signature","deposit_status","production_handoff","customer_expectations","sales_to_operations_notes"]}'),
('tpl_gw_outcome_lost','__global__','tpl_groundwork_field_service_v1','tpl_gw_closed','closed_lost','Closed — Lost','lost','{"lost_reasons":["Price","Competitor selected","Timing","Project canceled","Scope mismatch","Not financially qualified","No response","Not the right customer","Customer decided not to proceed"]}'),
('tpl_gw_outcome_disqualified','__global__','tpl_groundwork_field_service_v1','tpl_gw_closed','disqualified','Disqualified','disqualified','{}'),
('tpl_gw_outcome_nurture','__global__','tpl_groundwork_field_service_v1','tpl_gw_closed','long_term_nurture','Long-Term Nurture','nurture','{"requires_next_action":true,"requires_next_action_date":true}');
