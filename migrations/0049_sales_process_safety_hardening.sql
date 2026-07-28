-- Additive safety hardening for version publication and opportunity migration.
-- This migration does not publish a process or modify any live stage assignment.

CREATE TABLE IF NOT EXISTS sales_process_company_state (
  company_id TEXT PRIMARY KEY,
  active_process_id TEXT DEFAULT '',
  active_version_id TEXT DEFAULT '',
  state_revision INTEGER NOT NULL DEFAULT 0,
  activated_by TEXT DEFAULT '',
  activated_at TEXT DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_process_company_state_version
  ON sales_process_company_state(company_id, active_version_id);

CREATE TABLE IF NOT EXISTS sales_migration_snapshots (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  process_version_id TEXT NOT NULL,
  captured_by TEXT NOT NULL,
  captured_at TEXT NOT NULL DEFAULT (datetime('now')),
  opportunity_count INTEGER NOT NULL DEFAULT 0,
  totals_json TEXT NOT NULL DEFAULT '{}',
  snapshot_hash TEXT NOT NULL,
  review_state TEXT NOT NULL DEFAULT 'captured',
  approved_by TEXT DEFAULT '',
  approved_at TEXT DEFAULT '',
  invalidated_at TEXT DEFAULT '',
  invalidation_reason TEXT DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_migration_snapshots_company_version
  ON sales_migration_snapshots(company_id, process_version_id, captured_at);

CREATE TABLE IF NOT EXISTS sales_migration_snapshot_items (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  snapshot_id TEXT NOT NULL,
  opportunity_id TEXT NOT NULL,
  opportunity_updated_at TEXT DEFAULT '',
  legacy_status TEXT DEFAULT '',
  legacy_pipeline_stage TEXT DEFAULT '',
  stable_stage_id TEXT DEFAULT '',
  owner_id TEXT DEFAULT '',
  assigned_rep_id TEXT DEFAULT '',
  opportunity_value REAL NOT NULL DEFAULT 0,
  sold_value REAL NOT NULL DEFAULT 0,
  next_follow_up TEXT DEFAULT '',
  task_count INTEGER NOT NULL DEFAULT 0,
  activity_count INTEGER NOT NULL DEFAULT 0,
  estimate_count INTEGER NOT NULL DEFAULT 0,
  appointment_count INTEGER NOT NULL DEFAULT 0,
  record_hash TEXT NOT NULL,
  record_json TEXT NOT NULL DEFAULT '{}',
  UNIQUE(company_id, snapshot_id, opportunity_id)
);
CREATE INDEX IF NOT EXISTS idx_snapshot_items_company_snapshot
  ON sales_migration_snapshot_items(company_id, snapshot_id, opportunity_id);

CREATE TABLE IF NOT EXISTS sales_stage_transition_log (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  opportunity_id TEXT NOT NULL,
  process_version_id TEXT NOT NULL,
  previous_stage_id TEXT DEFAULT '',
  new_stage_id TEXT NOT NULL,
  previous_outcome_type TEXT DEFAULT '',
  new_outcome_type TEXT DEFAULT '',
  actor_id TEXT NOT NULL,
  override_reason TEXT DEFAULT '',
  transition_source TEXT NOT NULL DEFAULT 'manual',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_stage_transition_company_opportunity
  ON sales_stage_transition_log(company_id, opportunity_id, created_at);
CREATE INDEX IF NOT EXISTS idx_stage_transition_company_version
  ON sales_stage_transition_log(company_id, process_version_id, created_at);

ALTER TABLE sales_process_versions ADD COLUMN content_revision INTEGER NOT NULL DEFAULT 1;
ALTER TABLE sales_migration_mappings ADD COLUMN snapshot_id TEXT DEFAULT '';
ALTER TABLE sales_migration_mappings ADD COLUMN opportunity_updated_at TEXT DEFAULT '';
ALTER TABLE sales_migration_history ADD COLUMN previous_outcome_type TEXT DEFAULT '';
ALTER TABLE sales_migration_history ADD COLUMN new_outcome_type TEXT DEFAULT '';

-- Closed is a conceptual stage. Won/Lost meaning comes from its required outcome.
UPDATE sales_process_stages
SET semantic_type = 'terminal', updated_at = datetime('now')
WHERE company_id = '__global__'
  AND process_version_id = 'tpl_groundwork_field_service_v1'
  AND stable_key = 'closed'
  AND semantic_type = 'won';

-- Stable global skill library. Company playbooks associate these IDs without
-- overwriting global content.
INSERT OR IGNORE INTO sales_academy_skills (id,company_id,stable_key,title,content_json,is_global,active)
VALUES
('skill_mutual_agreements','__global__','mutual_agreements','Mutual Agreements','{}',1,1),
('skill_core_buying_reasons','__global__','core_buying_reasons','Core Buying Reasons','{}',1,1),
('skill_budget_conversations','__global__','budget_conversations','Budget Conversations','{}',1,1),
('skill_decision_makers','__global__','decision_makers','Decision Makers','{}',1,1),
('skill_decision_process','__global__','decision_process','Decision Process','{}',1,1),
('skill_initial_qualification','__global__','initial_qualification','Initial Qualification','{}',1,1),
('skill_onsite_discovery','__global__','onsite_discovery','On-Site Discovery','{}',1,1),
('skill_scope_development','__global__','scope_development','Scope Development','{}',1,1),
('skill_estimate_creation','__global__','estimate_creation','Estimate Creation','{}',1,1),
('skill_estimate_presentation','__global__','estimate_presentation','Estimate Presentation','{}',1,1),
('skill_objection_handling','__global__','objection_handling','Objection Handling','{}',1,1),
('skill_follow_up','__global__','follow_up','Follow-Up','{}',1,1),
('skill_closing','__global__','closing','Closing','{}',1,1),
('skill_lost_review','__global__','lost_opportunity_review','Lost-Opportunity Review','{}',1,1),
('skill_nurture','__global__','nurture','Nurture','{}',1,1);

INSERT OR IGNORE INTO sales_process_blocks (id,company_id,stable_key,name,semantic_type,definition_json,is_global,immutable)
VALUES
('block_lead_intake','__global__','lead_intake','Lead Intake','intake','{}',1,1),
('block_contact_attempts','__global__','contact_attempts','Contact Attempts','active_qualification','{}',1,1),
('block_qualification_call','__global__','qualification_call','Qualification Call','active_qualification','{}',1,1),
('block_consultation','__global__','consultation','Consultation','consultation','{}',1,1),
('block_site_visit','__global__','site_visit','Site Visit','consultation','{}',1,1),
('block_needs_assessment','__global__','needs_assessment','Needs Assessment','active_qualification','{}',1,1),
('block_scope_discovery','__global__','scope_discovery','Scope Discovery','consultation','{}',1,1),
('block_estimate_development','__global__','estimate_development','Estimate Development','estimate_development','{}',1,1),
('block_proposal_preparation','__global__','proposal_preparation','Proposal Preparation','estimate_development','{}',1,1),
('block_estimate_presentation','__global__','estimate_presentation','Estimate Presentation','proposal_presentation','{}',1,1),
('block_negotiation','__global__','negotiation','Negotiation','decision','{}',1,1),
('block_decision_follow_up','__global__','decision_follow_up','Decision Follow-Up','decision','{}',1,1),
('block_contract','__global__','contract','Contract','decision','{}',1,1),
('block_deposit','__global__','deposit','Deposit','decision','{}',1,1),
('block_won','__global__','won','Won','won','{}',1,1),
('block_lost','__global__','lost','Lost','lost','{}',1,1),
('block_disqualified','__global__','disqualified','Disqualified','disqualified','{}',1,1),
('block_nurture','__global__','nurture','Nurture','nurture','{}',1,1);

-- Additional immutable workflow templates. Adoption always copies a version.
INSERT OR IGNORE INTO sales_processes (id,company_id,name,description,is_template,is_immutable,created_by) VALUES
('tpl_design_build','__global__','High-Ticket Design-Build','Discovery, design, pricing, presentation, and decision workflow',1,1,'system'),
('tpl_recurring_maintenance','__global__','Recurring Maintenance','Fast qualification and recurring-service agreement workflow',1,1,'system'),
('tpl_fast_turn_service','__global__','Fast-Turn Service Sales','Rapid intake, diagnosis, quote, and decision workflow',1,1,'system'),
('tpl_commercial_bid','__global__','Commercial Bid Work','Qualification, site review, bid development, submission, and award workflow',1,1,'system');
INSERT OR IGNORE INTO sales_process_versions (id,company_id,process_id,version_number,lifecycle,created_by) VALUES
('tpl_design_build_v1','__global__','tpl_design_build',1,'template','system'),
('tpl_recurring_maintenance_v1','__global__','tpl_recurring_maintenance',1,'template','system'),
('tpl_fast_turn_service_v1','__global__','tpl_fast_turn_service',1,'template','system'),
('tpl_commercial_bid_v1','__global__','tpl_commercial_bid',1,'template','system');

INSERT OR IGNORE INTO sales_process_stages
(id,company_id,process_version_id,stable_key,display_name,board_label,description,customer_milestone,semantic_type,display_order,entry_guidance,exit_guidance,created_by)
VALUES
('tdb_new','__global__','tpl_design_build_v1','new_lead','New Lead','New Lead','Capture and route the design-build inquiry.','The inquiry is owned.','intake',1,'Confirm fit basics.','Begin qualification.','system'),
('tdb_discovery','__global__','tpl_design_build_v1','discovery','Discovery & Fit','Discovery','Qualify investment, goals, stakeholders, and fit.','The customer commits to design discovery.','active_qualification',2,'Run discovery.','Discovery visit is scheduled.','system'),
('tdb_design','__global__','tpl_design_build_v1','design','Design Development','Design','Develop concept and scope.','The preferred design direction is documented.','consultation',3,'Complete site discovery.','Design is ready to price.','system'),
('tdb_price','__global__','tpl_design_build_v1','pricing','Pricing & Proposal','Pricing','Build scope, options, and investment.','A complete proposal is ready.','estimate_development',4,'Approve design basis.','Presentation is scheduled.','system'),
('tdb_present','__global__','tpl_design_build_v1','presentation','Proposal Presentation','Presentation','Present the solution live.','The customer understands the recommendation.','proposal_presentation',5,'Prepare presentation.','Obtain approval, decline, or a dated decision plan.','system'),
('tdb_decide','__global__','tpl_design_build_v1','decision','Decision Pending','Decision','Manage an active decision.','A final decision is received.','decision',6,'Capture objection and next action.','Close or nurture.','system'),
('tdb_closed','__global__','tpl_design_build_v1','closed','Closed','Closed','Record a final outcome.','The outcome is documented.','terminal',7,'Confirm outcome.','Terminal.','system'),
('trm_new','__global__','tpl_recurring_maintenance_v1','new_lead','New Inquiry','New','Capture recurring-service interest.','The inquiry is owned.','intake',1,'Capture property and service.','Begin qualification.','system'),
('trm_qualify','__global__','tpl_recurring_maintenance_v1','qualify','Qualify & Inspect','Qualify','Confirm service fit and inspect the property.','Service requirements are known.','active_qualification',2,'Confirm route and service fit.','Pricing inputs are complete.','system'),
('trm_quote','__global__','tpl_recurring_maintenance_v1','quote','Service Proposal','Proposal','Prepare and review the recurring plan.','The customer receives a clear service plan.','proposal_presentation',3,'Price the service plan.','Receive a dated decision.','system'),
('trm_decision','__global__','tpl_recurring_maintenance_v1','decision','Decision Pending','Decision','Follow an active buying decision.','A decision is received.','decision',4,'Set next action and date.','Close or nurture.','system'),
('trm_closed','__global__','tpl_recurring_maintenance_v1','closed','Closed','Closed','Record the agreement outcome.','The outcome is documented.','terminal',5,'Confirm outcome.','Terminal.','system'),
('tfs_new','__global__','tpl_fast_turn_service_v1','new_lead','Service Request','Request','Capture an urgent or routine service request.','The request is owned.','intake',1,'Capture issue and urgency.','Begin diagnosis.','system'),
('tfs_diagnose','__global__','tpl_fast_turn_service_v1','diagnose','Diagnose & Qualify','Diagnose','Understand the issue and service fit.','The required service is understood.','active_qualification',2,'Contact the customer.','Quote inputs are complete.','system'),
('tfs_quote','__global__','tpl_fast_turn_service_v1','quote','Quote','Quote','Prepare and communicate the service quote.','The customer understands price and timing.','estimate_development',3,'Confirm scope.','Ask for approval.','system'),
('tfs_decision','__global__','tpl_fast_turn_service_v1','decision','Approval Pending','Approval','Follow a short, dated decision.','Approval or decline is received.','decision',4,'Set a rapid follow-up.','Close or disqualify.','system'),
('tfs_closed','__global__','tpl_fast_turn_service_v1','closed','Closed','Closed','Record the service outcome.','The outcome is documented.','terminal',5,'Confirm outcome.','Terminal.','system'),
('tcb_new','__global__','tpl_commercial_bid_v1','new_lead','Bid Opportunity','Bid','Capture the commercial opportunity and deadline.','The bid is owned.','intake',1,'Capture due date and documents.','Begin qualification.','system'),
('tcb_qualify','__global__','tpl_commercial_bid_v1','qualify','Bid Qualification','Qualify','Evaluate fit, capacity, requirements, and decision process.','A bid/no-bid decision is made.','active_qualification',2,'Review requirements.','Approve pursuit.','system'),
('tcb_site','__global__','tpl_commercial_bid_v1','site_review','Site & Scope Review','Site Review','Validate site conditions and scope.','Bid inputs are complete.','consultation',3,'Schedule site review.','Release estimate development.','system'),
('tcb_develop','__global__','tpl_commercial_bid_v1','bid_development','Bid Development','Development','Develop pricing, alternates, compliance, and approvals.','The bid is submission-ready.','estimate_development',4,'Review bid package.','Complete internal approval.','system'),
('tcb_submit','__global__','tpl_commercial_bid_v1','submission','Bid Submitted','Submitted','Submit and confirm receipt.','The buyer has a compliant bid.','proposal_presentation',5,'Confirm submission rules.','Establish award timeline.','system'),
('tcb_award','__global__','tpl_commercial_bid_v1','award_pending','Award Pending','Award','Manage clarifications and award timing.','An award decision is received.','decision',6,'Track next action.','Close or nurture.','system'),
('tcb_closed','__global__','tpl_commercial_bid_v1','closed','Closed','Closed','Record award outcome.','The outcome is documented.','terminal',7,'Confirm outcome.','Terminal.','system');

-- Every immutable template receives the same configurable outcome vocabulary.
INSERT OR IGNORE INTO sales_stage_outcomes (id,company_id,process_version_id,stage_id,stable_key,display_name,semantic_type,config_json)
SELECT 'out_' || v.id || '_' || o.semantic_type, '__global__', v.id,
  (SELECT s.id FROM sales_process_stages s WHERE s.company_id='__global__' AND s.process_version_id=v.id AND s.semantic_type='terminal' LIMIT 1),
  'closed_' || o.semantic_type, o.display_name, o.semantic_type, '{}'
FROM sales_process_versions v
JOIN (SELECT 'won' semantic_type,'Closed — Won' display_name UNION ALL SELECT 'lost','Closed — Lost' UNION ALL SELECT 'disqualified','Disqualified' UNION ALL SELECT 'nurture','Long-Term Nurture') o
WHERE v.company_id='__global__' AND v.id IN ('tpl_design_build_v1','tpl_recurring_maintenance_v1','tpl_fast_turn_service_v1','tpl_commercial_bid_v1');

-- Groundwork field-service internal statuses remain coaching detail rather than
-- extra pipeline stages.
INSERT OR IGNORE INTO sales_stage_internal_statuses (id,company_id,process_version_id,stage_id,stable_key,display_name,display_order)
VALUES
('is_new_ack','__global__','tpl_groundwork_field_service_v1','tpl_gw_new','acknowledgment_pending','Acknowledgment Pending',1),
('is_new_routed','__global__','tpl_groundwork_field_service_v1','tpl_gw_new','routed','Routed',2),
('is_cq_attempt','__global__','tpl_groundwork_field_service_v1','tpl_gw_qualify','attempting_contact','Attempting Contact',1),
('is_cq_connected','__global__','tpl_groundwork_field_service_v1','tpl_gw_qualify','connected','Connected',2),
('is_cq_scheduled','__global__','tpl_groundwork_field_service_v1','tpl_gw_qualify','initial_call_scheduled','Initial Call Scheduled',3),
('is_cq_complete','__global__','tpl_groundwork_field_service_v1','tpl_gw_qualify','initial_call_completed','Initial Call Completed',4),
('is_cq_qualified','__global__','tpl_groundwork_field_service_v1','tpl_gw_qualify','qualified','Qualified',5),
('is_cq_link','__global__','tpl_groundwork_field_service_v1','tpl_gw_qualify','scheduling_link_sent','Scheduling Link Sent',6),
('is_cq_booked','__global__','tpl_groundwork_field_service_v1','tpl_gw_qualify','onsite_booked','On-Site Appointment Booked',7),
('is_oc_scheduled','__global__','tpl_groundwork_field_service_v1','tpl_gw_consult','scheduled','Scheduled',1),
('is_oc_confirmed','__global__','tpl_groundwork_field_service_v1','tpl_gw_consult','confirmed','Confirmed',2),
('is_oc_reschedule','__global__','tpl_groundwork_field_service_v1','tpl_gw_consult','reschedule_needed','Reschedule Needed',3),
('is_oc_no_show','__global__','tpl_groundwork_field_service_v1','tpl_gw_consult','no_show','No-Show',4),
('is_oc_complete','__global__','tpl_groundwork_field_service_v1','tpl_gw_consult','completed','Completed',5),
('is_oc_info','__global__','tpl_groundwork_field_service_v1','tpl_gw_consult','additional_information','Additional Information Needed',6),
('is_ed_scope','__global__','tpl_groundwork_field_service_v1','tpl_gw_estimate','scope_review','Scope Review',1),
('is_ed_pricing','__global__','tpl_groundwork_field_service_v1','tpl_gw_estimate','pricing_in_progress','Pricing in Progress',2),
('is_ed_vendor','__global__','tpl_groundwork_field_service_v1','tpl_gw_estimate','waiting_vendor','Waiting on Vendor',3),
('is_ed_review','__global__','tpl_groundwork_field_service_v1','tpl_gw_estimate','internal_review','Internal Review',4),
('is_ed_revision','__global__','tpl_groundwork_field_service_v1','tpl_gw_estimate','revision_needed','Revision Needed',5),
('is_ed_ready','__global__','tpl_groundwork_field_service_v1','tpl_gw_estimate','ready_to_present','Ready to Present',6),
('is_ep_scheduled','__global__','tpl_groundwork_field_service_v1','tpl_gw_present','presentation_scheduled','Presentation Scheduled',1),
('is_ep_complete','__global__','tpl_groundwork_field_service_v1','tpl_gw_present','presentation_completed','Presentation Completed',2),
('is_ep_revision','__global__','tpl_groundwork_field_service_v1','tpl_gw_present','revision_requested','Revision Requested',3),
('is_ep_approved','__global__','tpl_groundwork_field_service_v1','tpl_gw_present','approved','Approved',4),
('is_ep_declined','__global__','tpl_groundwork_field_service_v1','tpl_gw_present','declined','Declined',5),
('is_ep_followup','__global__','tpl_groundwork_field_service_v1','tpl_gw_present','follow_up_required','Follow-Up Required',6),
('is_dp_thinking','__global__','tpl_groundwork_field_service_v1','tpl_gw_decision','thinking','Thinking It Over',1),
('is_dp_compare','__global__','tpl_groundwork_field_service_v1','tpl_gw_decision','comparing','Comparing Estimates',2),
('is_dp_stakeholder','__global__','tpl_groundwork_field_service_v1','tpl_gw_decision','stakeholder','Waiting for Co-Decision-Maker',3),
('is_dp_finance','__global__','tpl_groundwork_field_service_v1','tpl_gw_decision','financing','Reviewing Financing',4),
('is_dp_timing','__global__','tpl_groundwork_field_service_v1','tpl_gw_decision','timing','Waiting on Timing',5),
('is_dp_followup','__global__','tpl_groundwork_field_service_v1','tpl_gw_decision','follow_up','Requested Follow-Up',6),
('is_dp_revision','__global__','tpl_groundwork_field_service_v1','tpl_gw_decision','revision','Requested Revision',7),
('is_dp_approval','__global__','tpl_groundwork_field_service_v1','tpl_gw_decision','internal_approval','Internal Approval',8);

INSERT OR IGNORE INTO sales_stage_requirements (id,company_id,process_version_id,stage_id,requirement_type,stable_key,label,required_level,display_order,config_json)
VALUES
('req_new_source','__global__','tpl_groundwork_field_service_v1','tpl_gw_new','field','lead_source','Lead source','required',1,'{"field":"source"}'),
('req_new_owner','__global__','tpl_groundwork_field_service_v1','tpl_gw_new','field','assigned_owner','Assigned representative','required',2,'{"field":"assigned_to_rep_id"}'),
('req_new_contact','__global__','tpl_groundwork_field_service_v1','tpl_gw_new','field','contact_details','Contact details','required',3,'{"anyOf":["phone","email"]}'),
('req_new_address','__global__','tpl_groundwork_field_service_v1','tpl_gw_new','field','property_address','Property address','recommended',4,'{"field":"address"}'),
('req_new_service','__global__','tpl_groundwork_field_service_v1','tpl_gw_new','field','service_requested','Service requested','required',5,'{"field":"service_line"}'),
('req_cq_agreement','__global__','tpl_groundwork_field_service_v1','tpl_gw_qualify','checklist','mutual_agreement','Mutual agreement or call agenda','required',1,'{}'),
('req_cq_cbr','__global__','tpl_groundwork_field_service_v1','tpl_gw_qualify','field','core_buying_reasons','Core buying reasons','required',2,'{"field":"desired_outcome"}'),
('req_cq_work','__global__','tpl_groundwork_field_service_v1','tpl_gw_qualify','field','requested_work','Requested work','required',3,'{"field":"project"}'),
('req_cq_timing','__global__','tpl_groundwork_field_service_v1','tpl_gw_qualify','field','timing','Timing and urgency','recommended',4,'{"field":"urgency"}'),
('req_cq_budget','__global__','tpl_groundwork_field_service_v1','tpl_gw_qualify','field','budget','Budget expectations','recommended',5,'{"field":"budget_range"}'),
('req_cq_dm','__global__','tpl_groundwork_field_service_v1','tpl_gw_qualify','field','decision_maker','Decision makers','recommended',6,'{"field":"decision_maker"}'),
('req_cq_appointment','__global__','tpl_groundwork_field_service_v1','tpl_gw_qualify','checklist','onsite_appointment','On-site appointment','required',7,'{}'),
('req_oc_photos','__global__','tpl_groundwork_field_service_v1','tpl_gw_consult','checklist','photos','Property photos','recommended',1,'{}'),
('req_oc_measure','__global__','tpl_groundwork_field_service_v1','tpl_gw_consult','checklist','measurements','Measurements','required',2,'{}'),
('req_oc_scope','__global__','tpl_groundwork_field_service_v1','tpl_gw_consult','checklist','scope','Defined scope','required',3,'{}'),
('req_oc_priorities','__global__','tpl_groundwork_field_service_v1','tpl_gw_consult','checklist','priorities','Customer priorities','required',4,'{}'),
('req_oc_constraints','__global__','tpl_groundwork_field_service_v1','tpl_gw_consult','checklist','constraints','Site constraints','recommended',5,'{}'),
('req_ed_labor','__global__','tpl_groundwork_field_service_v1','tpl_gw_estimate','checklist','labor_pricing','Labor pricing','required',1,'{}'),
('req_ed_material','__global__','tpl_groundwork_field_service_v1','tpl_gw_estimate','checklist','material_pricing','Material pricing','required',2,'{}'),
('req_ed_margin','__global__','tpl_groundwork_field_service_v1','tpl_gw_estimate','checklist','margin_review','Margin review','required',3,'{}'),
('req_ed_appointment','__global__','tpl_groundwork_field_service_v1','tpl_gw_estimate','checklist','presentation_appointment','Presentation appointment','required',4,'{}'),
('req_ep_live','__global__','tpl_groundwork_field_service_v1','tpl_gw_present','checklist','presented_live','Estimate presented live','required',1,'{}'),
('req_ep_scope','__global__','tpl_groundwork_field_service_v1','tpl_gw_present','checklist','scope_reviewed','Scope reviewed','required',2,'{}'),
('req_ep_questions','__global__','tpl_groundwork_field_service_v1','tpl_gw_present','checklist','questions_answered','Questions answered','recommended',3,'{}'),
('req_ep_decision','__global__','tpl_groundwork_field_service_v1','tpl_gw_present','checklist','decision_requested','Decision requested','required',4,'{}'),
('req_dp_reason','__global__','tpl_groundwork_field_service_v1','tpl_gw_decision','field','delay_reason','Delay reason','required',1,'{"field":"fit_concerns"}'),
('req_dp_action','__global__','tpl_groundwork_field_service_v1','tpl_gw_decision','field','next_action','Next action','required',2,'{"field":"next_follow_up"}'),
('req_dp_date','__global__','tpl_groundwork_field_service_v1','tpl_gw_decision','field','next_action_date','Next-action date','required',3,'{"field":"next_follow_up"}'),
('req_dp_plan','__global__','tpl_groundwork_field_service_v1','tpl_gw_decision','checklist','follow_up_plan','Follow-up plan','required',4,'{}');

INSERT OR IGNORE INTO sales_stage_guides (id,company_id,process_version_id,stage_id,guide_type,interaction_type,title,purpose,suggested_language,completion_guidance,display_order,config_json)
VALUES
('guide_cq_open','__global__','tpl_groundwork_field_service_v1','tpl_gw_qualify','call_section','qualification_call','Opening and Mutual Agreement','Set a collaborative agenda without making the call feel scripted.','Confirm time, purpose, and the customer agenda.','Both parties agree on the conversation.',1,'{"required_fields":[],"optional_questions":[]}'),
('guide_cq_cbr','__global__','tpl_groundwork_field_service_v1','tpl_gw_qualify','call_section','qualification_call','Core Buying Reasons','Understand why the customer wants change and why it matters.','Invite the customer to describe the desired change in their own words.','The underlying motivation is captured.',2,'{"required_fields":["desired_outcome"]}'),
('guide_cq_work','__global__','tpl_groundwork_field_service_v1','tpl_gw_qualify','call_section','qualification_call','Requested Work','Clarify the requested service and desired scope.','Explore the work conversationally before narrowing scope.','The requested work is summarized.',3,'{"required_fields":["project","service_line"]}'),
('guide_cq_timing','__global__','tpl_groundwork_field_service_v1','tpl_gw_qualify','call_section','qualification_call','Timing and Urgency','Understand deadlines and the reason behind them.','Ask what timing would be ideal and what drives it.','Timing is understood.',4,'{"required_fields":["urgency"]}'),
('guide_cq_budget','__global__','tpl_groundwork_field_service_v1','tpl_gw_qualify','call_section','qualification_call','Budget Comfort','Discuss investment expectations respectfully.','Frame budget as a way to recommend an appropriate solution.','Investment comfort is understood.',5,'{"required_fields":["budget_range"]}'),
('guide_cq_dm','__global__','tpl_groundwork_field_service_v1','tpl_gw_qualify','call_section','qualification_call','Decision Makers','Identify everyone who should participate.','Ask who else should be included in recommendations and decisions.','Stakeholders are identified.',6,'{"required_fields":["decision_maker"]}'),
('guide_cq_process','__global__','tpl_groundwork_field_service_v1','tpl_gw_qualify','call_section','qualification_call','Decision Process','Understand how the customer will reach a decision.','Ask what their decision process normally looks like.','Decision steps are understood.',7,'{}'),
('guide_cq_fit','__global__','tpl_groundwork_field_service_v1','tpl_gw_qualify','call_section','qualification_call','Fit Assessment','Confirm property, project, and company fit.','Summarize fit and surface concerns directly.','Fit concerns are documented.',8,'{"required_fields":["fit_concerns"]}'),
('guide_cq_recap','__global__','tpl_groundwork_field_service_v1','tpl_gw_qualify','call_section','qualification_call','Recap','Reflect back what was heard and correct misunderstandings.','Offer a concise summary and invite corrections.','The customer confirms the summary.',9,'{}'),
('guide_cq_schedule','__global__','tpl_groundwork_field_service_v1','tpl_gw_qualify','call_section','qualification_call','On-Site Scheduling','Agree on the next appointment.','Offer the scheduling action only after fit is confirmed.','An on-site appointment is confirmed.',10,'{}');

INSERT OR IGNORE INTO sales_process_resources (id,company_id,process_version_id,stage_id,resource_type,stable_key,name,content_json)
VALUES
('assoc_cq_mutual','__global__','tpl_groundwork_field_service_v1','tpl_gw_qualify','academy_skill','mutual_agreements','Mutual Agreements','{"skill_id":"skill_mutual_agreements"}'),
('assoc_cq_cbr','__global__','tpl_groundwork_field_service_v1','tpl_gw_qualify','academy_skill','core_buying_reasons','Core Buying Reasons','{"skill_id":"skill_core_buying_reasons"}'),
('assoc_cq_timing','__global__','tpl_groundwork_field_service_v1','tpl_gw_qualify','academy_skill','initial_qualification','Timing and Qualification','{"skill_id":"skill_initial_qualification"}'),
('assoc_cq_budget','__global__','tpl_groundwork_field_service_v1','tpl_gw_qualify','academy_skill','budget_conversations','Budget Conversations','{"skill_id":"skill_budget_conversations"}'),
('assoc_cq_dm','__global__','tpl_groundwork_field_service_v1','tpl_gw_qualify','academy_skill','decision_makers','Decision Makers','{"skill_id":"skill_decision_makers"}'),
('assoc_cq_process','__global__','tpl_groundwork_field_service_v1','tpl_gw_qualify','academy_skill','decision_process','Decision Process','{"skill_id":"skill_decision_process"}'),
('assoc_oc_discovery','__global__','tpl_groundwork_field_service_v1','tpl_gw_consult','academy_skill','onsite_discovery','On-Site Discovery','{"skill_id":"skill_onsite_discovery"}'),
('assoc_ed_estimate','__global__','tpl_groundwork_field_service_v1','tpl_gw_estimate','academy_skill','estimate_creation','Estimate Creation','{"skill_id":"skill_estimate_creation"}'),
('assoc_ep_present','__global__','tpl_groundwork_field_service_v1','tpl_gw_present','academy_skill','estimate_presentation','Estimate Presentation','{"skill_id":"skill_estimate_presentation"}'),
('assoc_dp_follow','__global__','tpl_groundwork_field_service_v1','tpl_gw_decision','academy_skill','follow_up','Follow-Up','{"skill_id":"skill_follow_up"}');
