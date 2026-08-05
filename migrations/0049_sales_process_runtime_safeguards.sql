-- Additive runtime safeguards for the versioned sales-process model. Migration
-- 0048 remains unchanged because it may already have been applied.
CREATE TABLE IF NOT EXISTS sales_stage_transitions (
  id TEXT PRIMARY KEY, company_id TEXT NOT NULL, process_version_id TEXT NOT NULL,
  from_stage_id TEXT NOT NULL, to_stage_id TEXT NOT NULL,
  requires_override INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(company_id, process_version_id, from_stage_id, to_stage_id)
);
CREATE INDEX IF NOT EXISTS idx_sales_stage_transitions_version
  ON sales_stage_transitions(company_id, process_version_id, from_stage_id);

CREATE TABLE IF NOT EXISTS sales_stage_transition_events (
  id TEXT PRIMARY KEY, company_id TEXT NOT NULL, opportunity_id TEXT NOT NULL,
  process_version_id TEXT NOT NULL, from_stage_id TEXT DEFAULT '', to_stage_id TEXT NOT NULL,
  outcome_type TEXT DEFAULT '', actor_id TEXT NOT NULL, override_reason TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_sales_stage_transition_events_opportunity
  ON sales_stage_transition_events(company_id, opportunity_id, created_at);

-- Context owned by the immutable Groundwork template. Adoption remaps stage IDs
-- while copying these rows into the tenant draft.
INSERT OR IGNORE INTO sales_stage_requirements
  (id,company_id,process_version_id,stage_id,requirement_type,stable_key,label,description,required_level,display_order,config_json)
VALUES
('tpl_req_qualify_contact','__global__','tpl_groundwork_field_service_v1','tpl_gw_qualify','checklist','contact_confirmed','Confirm contact and decision-maker details','Verify who participates in the buying decision.','required',1,'{}'),
('tpl_req_qualify_next','__global__','tpl_groundwork_field_service_v1','tpl_gw_qualify','checklist','next_action','Record the next action and date','Every active opportunity must have a dated next action.','required',2,'{}'),
('tpl_req_consult_scope','__global__','tpl_groundwork_field_service_v1','tpl_gw_consult','qualification','desired_outcome','Document desired outcome','Capture what success looks like for the customer.','required',1,'{}'),
('tpl_req_estimate_scope','__global__','tpl_groundwork_field_service_v1','tpl_gw_estimate','checklist','scope_complete','Confirm scope is estimate-ready','Labor, materials, options, and exclusions are documented.','required',1,'{}'),
('tpl_req_decision_followup','__global__','tpl_groundwork_field_service_v1','tpl_gw_decision','checklist','decision_followup','Document decision follow-up','Record the objection, owner, action, and due date.','required',1,'{}');

INSERT OR IGNORE INTO sales_stage_guides
  (id,company_id,process_version_id,stage_id,guide_type,interaction_type,title,purpose,suggested_language,completion_guidance,display_order,config_json)
VALUES
('tpl_guide_new','__global__','tpl_groundwork_field_service_v1','tpl_gw_new','stage_guide','call','New inquiry response','Acknowledge the inquiry and establish ownership.','Thank the customer, confirm the request, and explain the immediate next step.','Contact details, owner, and next action are recorded.',1,'{"questions":["What prompted you to reach out today?","What outcome are you hoping to achieve?"]}'),
('tpl_guide_qualify','__global__','tpl_groundwork_field_service_v1','tpl_gw_qualify','call_guide','call','Connect and qualify','Determine fit and earn agreement for an on-site consultation.','Explore goals, timing, decision participants, investment expectations, and fit concerns conversationally.','A qualified consultation is scheduled or a clear terminal outcome is recorded.',1,'{"questions":["Why is this project important now?","Who else should be involved in the decision?","What timing are you working toward?"]}'),
('tpl_guide_consult','__global__','tpl_groundwork_field_service_v1','tpl_gw_consult','stage_guide','onsite','On-site consultation','Deepen discovery and define an estimate-ready project.','Walk the property, reflect the customer priorities, and confirm constraints before discussing solutions.','Desired outcome, scope, constraints, and next step are documented.',1,'{"questions":["What would make this project a success?","Are there site constraints we should plan around?"]}'),
('tpl_guide_estimate','__global__','tpl_groundwork_field_service_v1','tpl_gw_estimate','stage_guide','internal','Estimate development','Build a complete, review-ready solution.','Connect each scope choice to a stated customer priority.','Scope, price, options, exclusions, and presentation plan are complete.',1,'{"questions":["Does every recommendation connect to a stated buying reason?"]}'),
('tpl_guide_present','__global__','tpl_groundwork_field_service_v1','tpl_gw_present','call_guide','presentation','Estimate presentation','Present live, resolve concerns, and ask for a decision.','Reconfirm priorities, walk through the solution and investment, then ask directly for the sale.','The customer approves, declines, requests a material revision, or enters a dated decision period.',1,'{"questions":["How well does this solution match what you wanted to accomplish?","What would prevent us from moving forward today?"]}'),
('tpl_guide_decision','__global__','tpl_groundwork_field_service_v1','tpl_gw_decision','call_guide','follow_up','Decision follow-up','Help the customer reach a time-bound decision without losing context.','Name the open concern, agree on the next action, and set a specific date.','A final outcome or a documented nurture plan is recorded.',1,'{"questions":["What is the main question still preventing a decision?","What would be a useful next step and date?"]}'),
('tpl_guide_closed','__global__','tpl_groundwork_field_service_v1','tpl_gw_closed','stage_guide','handoff','Close and hand off','Capture a complete outcome and preserve operational context.','Confirm the outcome and set clear expectations for what happens next.','Outcome requirements and handoff notes are complete.',1,'{}');

INSERT OR IGNORE INTO sales_process_resources
  (id,company_id,process_version_id,stage_id,resource_type,stable_key,name,content_json)
VALUES
('tpl_resource_recap','__global__','tpl_groundwork_field_service_v1','','email_template','consultation_recap','Consultation recap','{"subject":"Your project recap and next steps","purpose":"Confirm priorities, scope, and the next action without inventing details."}'),
('tpl_resource_estimate','__global__','tpl_groundwork_field_service_v1','tpl_gw_present','email_template','estimate_follow_up','Estimate follow-up','{"subject":"Your estimate and next steps","purpose":"Recap the presented solution, open questions, owner, and decision date."}'),
('tpl_resource_nurture','__global__','tpl_groundwork_field_service_v1','tpl_gw_decision','email_template','decision_nurture','Decision nurture','{"subject":"Checking in on your project","purpose":"Reopen the agreed next action with useful context and no pressure."}');

INSERT OR IGNORE INTO sales_academy_skills
  (id,company_id,stable_key,title,content_json,is_global,active)
VALUES
('tpl_skill_discovery','__global__','field_service_discovery','Field-service discovery','{"stage_keys":["connect_qualify","onsite_consultation"],"outcomes":["Uncover goals, constraints, timing, and decision participants"]}',1,1),
('tpl_skill_estimate','__global__','value_based_estimate','Value-based estimate presentation','{"stage_keys":["estimate_development","estimate_presentation"],"outcomes":["Connect scope and investment to customer buying reasons"]}',1,1),
('tpl_skill_followup','__global__','decision_follow_up','Decision follow-up','{"stage_keys":["decision_pending"],"outcomes":["Maintain a dated next action and resolve the real open concern"]}',1,1),
('tpl_skill_handoff','__global__','sales_operations_handoff','Sales-to-operations handoff','{"stage_keys":["closed"],"outcomes":["Preserve scope, expectations, payment, and production context"]}',1,1);
