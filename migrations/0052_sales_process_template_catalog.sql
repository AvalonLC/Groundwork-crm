-- Complete immutable template catalog. Existing immutable template rows are not
-- modified; Groundwork receives a new version and the four catalog templates
-- introduced in 0051 receive their first complete definitions.
CREATE TABLE IF NOT EXISTS sales_stage_transition_paths (
  id TEXT PRIMARY KEY, company_id TEXT NOT NULL, process_version_id TEXT NOT NULL,
  from_stage_id TEXT NOT NULL, to_stage_id TEXT NOT NULL, outcome_type TEXT DEFAULT '',
  display_label TEXT DEFAULT '', guidance TEXT DEFAULT '', active INTEGER NOT NULL DEFAULT 1,
  display_order INTEGER NOT NULL DEFAULT 0, override_policy TEXT NOT NULL DEFAULT 'stage_policy',
  requires_override INTEGER NOT NULL DEFAULT 0, created_by TEXT DEFAULT '', updated_by TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(company_id, process_version_id, id)
);
CREATE INDEX IF NOT EXISTS idx_sales_transition_paths_source
  ON sales_stage_transition_paths(company_id, process_version_id, from_stage_id, active);
CREATE INDEX IF NOT EXISTS idx_sales_transition_paths_destination
  ON sales_stage_transition_paths(company_id, process_version_id, to_stage_id, outcome_type);

INSERT OR IGNORE INTO sales_process_versions
  (id,company_id,process_id,version_number,lifecycle,based_on_version_id,created_by)
VALUES ('tpl_groundwork_field_service_v2','__global__','tpl_groundwork_field_service',2,'template','tpl_groundwork_field_service_v1','system');

INSERT OR IGNORE INTO sales_process_stages
  (id,company_id,process_version_id,stable_key,display_name,board_label,description,customer_milestone,semantic_type,display_order,state,expected_duration_days,entry_guidance,exit_guidance,manager_override_policy,created_by)
VALUES
('gw2_new','__global__','tpl_groundwork_field_service_v2','new_lead','New Lead','New Lead','Capture and route every inquiry for immediate attention.','The inquiry is acknowledged, assigned, and ready for contact.','intake',1,'active',1,'Capture source, owner, contact details, property address, service requested, response deadline, and acknowledgment.','The representative begins contact.','allowed_with_reason','system'),
('gw2_qualify','__global__','tpl_groundwork_field_service_v2','connect_qualify','Connect & Qualify','Qualify','Connect, determine fit, and schedule the on-site consultation.','The customer and representative agree on the appropriate next step.','active_qualification',2,'active',10,'Use the qualification call guide and finite contact sequence.','An on-site consultation is scheduled or an approved alternative outcome is selected.','allowed_with_reason','system'),
('gw2_consult','__global__','tpl_groundwork_field_service_v2','onsite_consultation','On-Site Consultation','Consultation','Walk the property, deepen discovery, define the project, and understand priorities.','The property, desired result, stakeholders, and constraints are documented.','consultation',3,'active',14,'Confirm the appointment and prepare known context.','The walkthrough is complete and sufficient information exists to develop an estimate.','allowed_with_reason','system'),
('gw2_estimate','__global__','tpl_groundwork_field_service_v2','estimate_development','Estimate Development','Estimate','Turn discovery and scope into an accurate estimate and proposal.','A complete and internally approved solution is ready for review.','estimate_development',4,'active',7,'Review scope, labor, materials, vendors, options, margin, and approvals.','The estimate is complete and an estimate-review meeting is scheduled.','allowed_with_reason','system'),
('gw2_present','__global__','tpl_groundwork_field_service_v2','estimate_presentation','Estimate Presentation','Presentation','Present the estimate live, connect it to buying reasons, address concerns, and request a decision.','The customer has reviewed the scope, options, and investment with a representative.','proposal_presentation',5,'active',5,'Require a ready estimate and presentation appointment.','The customer decides, requests a material revision, or agrees to a time-bound decision plan.','allowed_with_reason','system'),
('gw2_decision','__global__','tpl_groundwork_field_service_v2','decision_pending','Decision Pending','Decision','Manage an active, time-bound customer decision.','The open concern has an owner, action, and due date.','decision',6,'active',14,'Capture delay reason, primary objection, next action, date, and follow-up plan.','A final decision, material revision, or approved nurture path is selected.','manager_approval','system'),
('gw2_closed','__global__','tpl_groundwork_field_service_v2','closed','Closed','Closed','Record the conceptual terminal stage with a semantic outcome.','The final outcome and handoff or loss context are complete.','terminal',7,'active',0,'Select and complete a configured outcome.','Terminal stage.','manager_approval','system');

INSERT OR IGNORE INTO sales_stage_outcomes
  (id,company_id,process_version_id,stage_id,stable_key,display_name,semantic_type,config_json)
VALUES
('gw2_won','__global__','tpl_groundwork_field_service_v2','gw2_closed','won','Won','won','{"required":["final_value","accepted_scope","contract_signature","deposit_status","production_handoff","customer_expectations","sales_to_operations_notes"]}'),
('gw2_lost','__global__','tpl_groundwork_field_service_v2','gw2_closed','lost','Lost','lost','{"required":["lost_reason"],"lost_reasons":["Price","Competitor selected","Timing","Project canceled","Scope mismatch","Not financially qualified","No response","Not the right customer","Customer decided not to proceed"]}'),
('gw2_disqualified','__global__','tpl_groundwork_field_service_v2','gw2_closed','disqualified','Disqualified','disqualified','{"required":["disqualification_reason"]}'),
('gw2_nurture','__global__','tpl_groundwork_field_service_v2','gw2_closed','long_term_nurture','Long-Term Nurture','nurture','{"required":["next_action","next_action_date","nurture_reason"]}');

INSERT OR IGNORE INTO sales_stage_internal_statuses
  (id,company_id,process_version_id,stage_id,stable_key,display_name,display_order,active)
VALUES
('gw2_q_attempt','__global__','tpl_groundwork_field_service_v2','gw2_qualify','attempting_contact','Attempting contact',1,1),
('gw2_q_connected','__global__','tpl_groundwork_field_service_v2','gw2_qualify','connected','Connected',2,1),
('gw2_q_call_scheduled','__global__','tpl_groundwork_field_service_v2','gw2_qualify','initial_call_scheduled','Initial call scheduled',3,1),
('gw2_q_call_complete','__global__','tpl_groundwork_field_service_v2','gw2_qualify','initial_call_completed','Initial call completed',4,1),
('gw2_q_qualified','__global__','tpl_groundwork_field_service_v2','gw2_qualify','qualified','Qualified',5,1),
('gw2_q_link','__global__','tpl_groundwork_field_service_v2','gw2_qualify','scheduling_link_sent','Scheduling link sent',6,1),
('gw2_q_booked','__global__','tpl_groundwork_field_service_v2','gw2_qualify','onsite_booked','On-site appointment booked',7,1),
('gw2_c_scheduled','__global__','tpl_groundwork_field_service_v2','gw2_consult','scheduled','Scheduled',1,1),
('gw2_c_confirmed','__global__','tpl_groundwork_field_service_v2','gw2_consult','confirmed','Confirmed',2,1),
('gw2_c_reschedule','__global__','tpl_groundwork_field_service_v2','gw2_consult','reschedule_needed','Reschedule needed',3,1),
('gw2_c_noshow','__global__','tpl_groundwork_field_service_v2','gw2_consult','no_show','No-show',4,1),
('gw2_c_complete','__global__','tpl_groundwork_field_service_v2','gw2_consult','completed','Completed',5,1),
('gw2_c_more','__global__','tpl_groundwork_field_service_v2','gw2_consult','additional_information','Additional information needed',6,1),
('gw2_e_scope','__global__','tpl_groundwork_field_service_v2','gw2_estimate','scope_review','Scope review',1,1),
('gw2_e_pricing','__global__','tpl_groundwork_field_service_v2','gw2_estimate','pricing_in_progress','Pricing in progress',2,1),
('gw2_e_vendor','__global__','tpl_groundwork_field_service_v2','gw2_estimate','waiting_on_vendor','Waiting on vendor',3,1),
('gw2_e_review','__global__','tpl_groundwork_field_service_v2','gw2_estimate','internal_review','Internal review',4,1),
('gw2_e_revision','__global__','tpl_groundwork_field_service_v2','gw2_estimate','revision_needed','Revision needed',5,1),
('gw2_e_ready','__global__','tpl_groundwork_field_service_v2','gw2_estimate','ready_to_present','Ready to present',6,1),
('gw2_p_scheduled','__global__','tpl_groundwork_field_service_v2','gw2_present','presentation_scheduled','Presentation scheduled',1,1),
('gw2_p_complete','__global__','tpl_groundwork_field_service_v2','gw2_present','presentation_completed','Presentation completed',2,1),
('gw2_p_revision','__global__','tpl_groundwork_field_service_v2','gw2_present','revision_requested','Revision requested',3,1),
('gw2_p_approved','__global__','tpl_groundwork_field_service_v2','gw2_present','approved','Approved',4,1),
('gw2_p_declined','__global__','tpl_groundwork_field_service_v2','gw2_present','declined','Declined',5,1),
('gw2_p_followup','__global__','tpl_groundwork_field_service_v2','gw2_present','follow_up_required','Follow-up required',6,1);

INSERT OR IGNORE INTO sales_stage_requirements
  (id,company_id,process_version_id,stage_id,requirement_type,stable_key,label,description,required_level,display_order,config_json)
VALUES
('gw2_r_source','__global__','tpl_groundwork_field_service_v2','gw2_new','field','lead_source','Lead source','Capture where the inquiry originated.','required',1,'{"phase":"general"}'),
('gw2_r_owner','__global__','tpl_groundwork_field_service_v2','gw2_new','field','assigned_owner','Assigned representative','Every inquiry requires ownership.','required',2,'{"phase":"general"}'),
('gw2_r_contact','__global__','tpl_groundwork_field_service_v2','gw2_new','field','contact_details','Contact details','Capture reachable contact information.','required',3,'{"phase":"general"}'),
('gw2_r_address','__global__','tpl_groundwork_field_service_v2','gw2_new','field','property_address','Property address','Capture the service location.','required',4,'{"phase":"general"}'),
('gw2_r_service','__global__','tpl_groundwork_field_service_v2','gw2_new','field','service_requested','Service requested','Describe the requested work.','required',5,'{"phase":"general"}'),
('gw2_r_deadline','__global__','tpl_groundwork_field_service_v2','gw2_new','field','first_response_deadline','First-response deadline','Set prompt response ownership.','required',6,'{"phase":"general"}'),
('gw2_r_ack','__global__','tpl_groundwork_field_service_v2','gw2_new','checklist','initial_acknowledgment','Initial acknowledgment','Acknowledge the inquiry.','required',7,'{"phase":"exit"}'),
('gw2_r_agreement','__global__','tpl_groundwork_field_service_v2','gw2_qualify','checklist','mutual_agreement','Mutual agreement','Set a mutual agenda for the conversation.','required',1,'{"phase":"general"}'),
('gw2_r_reasons','__global__','tpl_groundwork_field_service_v2','gw2_qualify','field','core_buying_reasons','Core buying reasons','Capture why the project matters.','required',2,'{"phase":"general"}'),
('gw2_r_timing','__global__','tpl_groundwork_field_service_v2','gw2_qualify','field','timing_urgency','Timing and urgency','Capture desired timing and urgency.','required',3,'{"phase":"general"}'),
('gw2_r_budget','__global__','tpl_groundwork_field_service_v2','gw2_qualify','field','budget_comfort','Budget comfort','Explore investment expectations.','recommended',4,'{"phase":"general"}'),
('gw2_r_deciders','__global__','tpl_groundwork_field_service_v2','gw2_qualify','field','decision_makers','Decision makers','Identify decision participants.','required',5,'{"phase":"general"}'),
('gw2_r_process','__global__','tpl_groundwork_field_service_v2','gw2_qualify','field','decision_process','Decision process','Understand how the customer will decide.','recommended',6,'{"phase":"general"}'),
('gw2_r_appointment','__global__','tpl_groundwork_field_service_v2','gw2_qualify','appointment','onsite_appointment','On-site appointment','Schedule the consultation.','required',7,'{"phase":"exit"}'),
('gw2_r_walk','__global__','tpl_groundwork_field_service_v2','gw2_consult','appointment','completed_walkthrough','Property walkthrough','Complete the on-site walkthrough.','required',1,'{"phase":"exit"}'),
('gw2_r_photos','__global__','tpl_groundwork_field_service_v2','gw2_consult','checklist','photos','Photos','Capture relevant property photos.','required',2,'{"phase":"general"}'),
('gw2_r_measure','__global__','tpl_groundwork_field_service_v2','gw2_consult','checklist','measurements','Measurements','Capture estimate-ready measurements.','required',3,'{"phase":"general"}'),
('gw2_r_scope','__global__','tpl_groundwork_field_service_v2','gw2_consult','field','scope','Scope','Document the requested scope.','required',4,'{"phase":"exit"}'),
('gw2_r_priorities','__global__','tpl_groundwork_field_service_v2','gw2_consult','field','customer_priorities','Customer priorities','Record desired outcomes and tradeoffs.','required',5,'{"phase":"general"}'),
('gw2_r_constraints','__global__','tpl_groundwork_field_service_v2','gw2_consult','field','site_constraints','Site constraints','Record access, site, and material constraints.','required',6,'{"phase":"general"}'),
('gw2_r_labor','__global__','tpl_groundwork_field_service_v2','gw2_estimate','estimate','labor_pricing','Labor pricing','Complete labor pricing.','required',1,'{"phase":"exit"}'),
('gw2_r_material','__global__','tpl_groundwork_field_service_v2','gw2_estimate','estimate','material_pricing','Material pricing','Complete material and vendor pricing.','required',2,'{"phase":"exit"}'),
('gw2_r_margin','__global__','tpl_groundwork_field_service_v2','gw2_estimate','estimate','margin_review','Margin review','Complete margin review and approval.','required',3,'{"phase":"exit","manager_only":true}'),
('gw2_r_ready','__global__','tpl_groundwork_field_service_v2','gw2_estimate','estimate','estimate_ready','Estimate readiness','Mark the estimate ready.','required',4,'{"phase":"exit"}'),
('gw2_r_presented','__global__','tpl_groundwork_field_service_v2','gw2_present','estimate','presented_live','Estimate presented live','An emailed but unreviewed estimate does not qualify.','required',1,'{"phase":"exit"}'),
('gw2_r_questions','__global__','tpl_groundwork_field_service_v2','gw2_present','checklist','questions_answered','Questions answered','Answer and record customer questions.','required',2,'{"phase":"exit"}'),
('gw2_r_decision','__global__','tpl_groundwork_field_service_v2','gw2_present','checklist','decision_requested','Decision requested','Explicitly request the decision.','required',3,'{"phase":"exit"}'),
('gw2_r_delay','__global__','tpl_groundwork_field_service_v2','gw2_decision','field','delay_reason','Delay reason','Record why the decision is pending.','required',1,'{"phase":"entry"}'),
('gw2_r_objection','__global__','tpl_groundwork_field_service_v2','gw2_decision','field','primary_objection','Primary objection','Record the real open concern.','required',2,'{"phase":"general"}'),
('gw2_r_next','__global__','tpl_groundwork_field_service_v2','gw2_decision','field','next_action','Next action','Assign a clear next action.','required',3,'{"phase":"general"}'),
('gw2_r_next_date','__global__','tpl_groundwork_field_service_v2','gw2_decision','field','next_action_date','Next-action date','Keep the decision time-bound.','required',4,'{"phase":"general"}'),
('gw2_r_followup','__global__','tpl_groundwork_field_service_v2','gw2_decision','checklist','follow_up_plan','Follow-up plan','Document the agreed follow-up plan.','required',5,'{"phase":"general"}');

INSERT OR IGNORE INTO sales_stage_guides
  (id,company_id,process_version_id,stage_id,guide_type,interaction_type,title,purpose,suggested_language,completion_guidance,display_order,config_json)
VALUES
('gw2_g_first','__global__','tpl_groundwork_field_service_v2','gw2_new','call_guide','first_contact','First contact','Acknowledge and establish ownership.','Confirm the request, thank the customer, and explain the immediate next step.','Owner, contact details, and next action are captured.',1,'{"sections":["opening","requested_work","timing","next_step"]}'),
('gw2_g_qualify','__global__','tpl_groundwork_field_service_v2','gw2_qualify','call_guide','qualification_call','Connect and qualify','Determine fit and schedule the consultation.','Use conversational questions rather than an interrogation.','Fit and next destination are confirmed.',1,'{"sections":["opening_and_mutual_agreement","core_buying_reasons","requested_work","timing_and_urgency","budget_comfort","decision_makers","decision_process","fit_assessment","recap","onsite_scheduling"]}'),
('gw2_g_onsite','__global__','tpl_groundwork_field_service_v2','gw2_consult','call_guide','onsite_consultation','On-site consultation','Deepen discovery and define an estimate-ready project.','Walk the property and connect constraints to customer priorities.','Scope, evidence, stakeholders, and presentation appointment are documented.',1,'{"sections":["confirmation","walkthrough","priorities","scope","constraints","stakeholders","recap"]}'),
('gw2_g_present','__global__','tpl_groundwork_field_service_v2','gw2_present','call_guide','estimate_presentation','Estimate presentation','Review the estimate live and request a decision.','Connect each recommendation to a buying reason, address concerns, and agree on the next step.','Presentation evidence, objections, and decision are recorded.',1,'{"sections":["agenda","buying_reasons","scope","options","investment","questions","decision_request","next_step"]}'),
('gw2_g_follow','__global__','tpl_groundwork_field_service_v2','gw2_decision','call_guide','decision_follow_up','Decision follow-up','Resolve the open concern through a dated next step.','Revisit the agreed concern and ask what has changed.','Reason, objection, action, owner, and date are recorded.',1,'{"sections":["context","open_concern","warning_signs","next_action","completion"]}');

INSERT OR IGNORE INTO sales_process_resources
  (id,company_id,process_version_id,stage_id,resource_type,stable_key,name,content_json)
VALUES
('gw2_email_ack','__global__','tpl_groundwork_field_service_v2','gw2_new','email_template','initial_acknowledgment','Initial acknowledgment','{"subject":"We received your request","requires_confirmation":true}'),
('gw2_email_recap','__global__','tpl_groundwork_field_service_v2','gw2_qualify','email_template','qualification_recap','Qualification recap','{"subject":"Your project recap and consultation","requires_confirmation":true}'),
('gw2_email_visit','__global__','tpl_groundwork_field_service_v2','gw2_consult','email_template','consultation_recap','Consultation recap','{"subject":"Your consultation recap and next steps","requires_confirmation":true}'),
('gw2_email_estimate','__global__','tpl_groundwork_field_service_v2','gw2_present','email_template','estimate_follow_up','Estimate follow-up','{"subject":"Your estimate and agreed next step","requires_confirmation":true}'),
('gw2_task_response','__global__','tpl_groundwork_field_service_v2','gw2_new','task_action','first_response','First-response task','{"due":"first_response_deadline","requires_confirmation":true}'),
('gw2_task_decision','__global__','tpl_groundwork_field_service_v2','gw2_decision','task_action','decision_follow_up','Decision follow-up task','{"due":"next_action_date","requires_confirmation":true}');

INSERT OR IGNORE INTO sales_process_automations
  (id,company_id,process_version_id,stage_id,name,trigger_type,action_type,config_json,active)
VALUES
('gw2_auto_response','__global__','tpl_groundwork_field_service_v2','gw2_new','First-response reminder','aging_warning','suggest_task','{"requires_representative_confirmation":true}',1),
('gw2_auto_decision','__global__','tpl_groundwork_field_service_v2','gw2_decision','Decision aging review','aging_warning','suggest_manager_review','{"requires_representative_confirmation":true}',1);

INSERT OR IGNORE INTO sales_academy_associations
  (id,company_id,process_version_id,stage_id,skill_id,visibility,display_order)
VALUES
('gw2_a_agreement','__global__','tpl_groundwork_field_service_v2','gw2_qualify','skill_mutual_agreements','representative',1),
('gw2_a_reasons','__global__','tpl_groundwork_field_service_v2','gw2_qualify','skill_buying_reasons','representative',2),
('gw2_a_budget','__global__','tpl_groundwork_field_service_v2','gw2_qualify','skill_budget','representative',3),
('gw2_a_onsite','__global__','tpl_groundwork_field_service_v2','gw2_consult','skill_onsite_discovery','representative',1),
('gw2_a_estimate','__global__','tpl_groundwork_field_service_v2','gw2_estimate','skill_estimate_creation','representative',1),
('gw2_a_present','__global__','tpl_groundwork_field_service_v2','gw2_present','skill_estimate_presentation','representative',1),
('gw2_a_follow','__global__','tpl_groundwork_field_service_v2','gw2_decision','skill_follow_up','representative',1),
('gw2_a_close','__global__','tpl_groundwork_field_service_v2','gw2_closed','skill_closing','representative',1);

INSERT OR IGNORE INTO sales_stage_transition_paths
  (id,company_id,process_version_id,from_stage_id,to_stage_id,requires_override,active,outcome_type,display_label,guidance,display_order,override_policy,created_by)
VALUES
('gw2_t_1','__global__','tpl_groundwork_field_service_v2','gw2_new','gw2_qualify',0,1,'','Begin contact','Begin the contact process.',1,'stage_policy','system'),
('gw2_t_2','__global__','tpl_groundwork_field_service_v2','gw2_qualify','gw2_consult',0,1,'','Consultation booked','Continue to the scheduled consultation.',1,'stage_policy','system'),
('gw2_t_3','__global__','tpl_groundwork_field_service_v2','gw2_consult','gw2_estimate',0,1,'','Develop estimate','Use completed discovery to build the estimate.',1,'stage_policy','system'),
('gw2_t_4','__global__','tpl_groundwork_field_service_v2','gw2_estimate','gw2_present',0,1,'','Present estimate','The estimate is ready and a presentation is scheduled.',1,'stage_policy','system'),
('gw2_t_5','__global__','tpl_groundwork_field_service_v2','gw2_present','gw2_closed',0,1,'won','Close Won','Record complete Won evidence.',1,'stage_policy','system'),
('gw2_t_6','__global__','tpl_groundwork_field_service_v2','gw2_present','gw2_closed',0,1,'lost','Close Lost','Record a configured loss reason.',2,'stage_policy','system'),
('gw2_t_7','__global__','tpl_groundwork_field_service_v2','gw2_present','gw2_decision',0,1,'','Decision pending','Create a time-bound decision plan.',3,'stage_policy','system'),
('gw2_t_8','__global__','tpl_groundwork_field_service_v2','gw2_present','gw2_estimate',0,1,'','Material revision','Return for a material estimate revision.',4,'stage_policy','system'),
('gw2_t_9','__global__','tpl_groundwork_field_service_v2','gw2_decision','gw2_closed',0,1,'won','Close Won','Record complete Won evidence.',1,'stage_policy','system'),
('gw2_t_10','__global__','tpl_groundwork_field_service_v2','gw2_decision','gw2_closed',0,1,'lost','Close Lost','Record a configured loss reason.',2,'stage_policy','system'),
('gw2_t_11','__global__','tpl_groundwork_field_service_v2','gw2_decision','gw2_estimate',0,1,'','Material revision','Return for a material revision.',3,'stage_policy','system'),
('gw2_t_12','__global__','tpl_groundwork_field_service_v2','gw2_decision','gw2_closed',0,1,'nurture','Long-Term Nurture','Record the reason and dated nurture action.',4,'manager_approval','system'),
('gw2_t_13','__global__','tpl_groundwork_field_service_v2','gw2_qualify','gw2_closed',0,1,'lost','No response','Record No Response as the loss reason.',2,'stage_policy','system'),
('gw2_t_14','__global__','tpl_groundwork_field_service_v2','gw2_qualify','gw2_closed',0,1,'nurture','Long-Term Nurture','Record a dated nurture plan.',3,'manager_approval','system'),
('gw2_t_15','__global__','tpl_groundwork_field_service_v2','gw2_qualify','gw2_closed',0,1,'disqualified','Disqualified','Record the disqualification reason.',4,'stage_policy','system');

-- Meaningfully different catalog stage graphs. Their shared terminal outcomes
-- remain semantic, while their active work reflects each selling motion.
INSERT OR IGNORE INTO sales_process_stages
  (id,company_id,process_version_id,stable_key,display_name,board_label,description,customer_milestone,semantic_type,display_order,state,expected_duration_days,entry_guidance,exit_guidance,manager_override_policy,created_by)
VALUES
('db_intake','__global__','tpl_design_build_v1','project_inquiry','Project Inquiry','Inquiry','Capture design-build goals and feasibility context.','The project has an owner and initial fit context.','intake',1,'active',2,'Capture site, goals, and likely investment range.','Begin feasibility qualification.','allowed_with_reason','system'),
('db_feas','__global__','tpl_design_build_v1','feasibility','Feasibility & Budget','Feasibility','Qualify site, budget, decision team, and design engagement.','The customer approves the design pathway.','active_qualification',2,'active',14,'Assess fit and decision process.','Approve discovery and design engagement.','manager_approval','system'),
('db_design','__global__','tpl_design_build_v1','concept_design','Concept & Scope','Design','Develop concept, scope, selections, and alternates.','A presentation-ready concept is complete.','consultation',3,'active',30,'Complete paid discovery where configured.','Concept and price are ready for presentation.','manager_approval','system'),
('db_present','__global__','tpl_design_build_v1','investment_presentation','Investment Presentation','Presentation','Present design, scope, options, and investment.','The decision team reviews the complete solution.','proposal_presentation',4,'active',14,'Confirm all decision participants.','Record a decision or dated next step.','manager_approval','system'),
('db_close','__global__','tpl_design_build_v1','closed','Closed','Closed','Record contract or loss outcome.','The project has a documented final outcome.','terminal',5,'active',0,'Complete outcome evidence.','Terminal.','manager_approval','system'),
('rm_intake','__global__','tpl_maintenance_v1','service_inquiry','Service Inquiry','Inquiry','Capture property and recurring-service needs.','The property is ready for route-fit assessment.','intake',1,'active',1,'Capture address, frequency, and service needs.','Begin route and property assessment.','allowed_with_reason','system'),
('rm_assess','__global__','tpl_maintenance_v1','property_assessment','Property & Route Fit','Assessment','Assess property scope, frequency, and route fit.','A serviceable recurring scope is documented.','consultation',2,'active',5,'Review route capacity and property needs.','Prepare recurring-service options.','allowed_with_reason','system'),
('rm_quote','__global__','tpl_maintenance_v1','service_options','Service Options','Options','Present frequency, inclusions, and price options.','The customer selects or declines a recurring plan.','proposal_presentation',3,'active',5,'Prepare clear recurring options.','Record selection, follow-up, or loss.','allowed_with_reason','system'),
('rm_activate','__global__','tpl_maintenance_v1','activation','Activation','Activation','Confirm agreement, billing, route, and start date.','Recurring service is ready to begin.','decision',4,'active',7,'Confirm operational capacity.','Complete activation or final outcome.','manager_approval','system'),
('rm_close','__global__','tpl_maintenance_v1','closed','Closed','Closed','Record activation or loss outcome.','The recurring opportunity has a final outcome.','terminal',5,'active',0,'Complete outcome evidence.','Terminal.','manager_approval','system'),
('ft_intake','__global__','tpl_fast_turn_v1','request','Service Request','Request','Capture a time-sensitive service request.','The request is owned and contactable.','intake',1,'active',1,'Capture service, location, and timing.','Begin rapid qualification.','allowed_with_reason','system'),
('ft_qualify','__global__','tpl_fast_turn_v1','rapid_qualification','Rapid Qualification','Qualify','Confirm fit and collect remote pricing evidence.','The request is ready to price.','active_qualification',2,'active',1,'Collect photos and essential scope.','Sufficient information exists to quote.','allowed_with_reason','system'),
('ft_quote','__global__','tpl_fast_turn_v1','quote_approval','Quote & Approval','Quote','Deliver and review a fast-turn quote.','The customer approves or declines the quote.','proposal_presentation',3,'active',2,'Confirm price and availability.','Record approval or loss.','allowed_with_reason','system'),
('ft_schedule','__global__','tpl_fast_turn_v1','scheduling','Scheduling','Schedule','Convert approval into a scheduled service.','The approved work is scheduled.','decision',4,'active',2,'Confirm crew and customer availability.','Complete handoff.','manager_approval','system'),
('ft_close','__global__','tpl_fast_turn_v1','closed','Closed','Closed','Record scheduled Won or Lost.','The service request has a final outcome.','terminal',5,'active',0,'Complete outcome evidence.','Terminal.','manager_approval','system'),
('cb_intake','__global__','tpl_commercial_bid_v1','bid_invitation','Bid Invitation','Invitation','Capture bid documents, dates, and stakeholders.','The bid has an owner and compliance calendar.','intake',1,'active',2,'Capture submission requirements and dates.','Begin bid qualification.','allowed_with_reason','system'),
('cb_qualify','__global__','tpl_commercial_bid_v1','bid_qualification','Bid Qualification','Qualify','Make a deliberate bid or no-bid decision.','The opportunity is approved for pursuit.','active_qualification',2,'active',5,'Assess fit, capacity, competition, and requirements.','Approve pursuit or disqualify.','manager_approval','system'),
('cb_site','__global__','tpl_commercial_bid_v1','site_scope_review','Site & Scope Review','Site Review','Complete site, document, and risk review.','Bid scope and risks are documented.','consultation',3,'active',14,'Review documents and attend required meetings.','Scope is ready for pricing.','manager_approval','system'),
('cb_bid','__global__','tpl_commercial_bid_v1','bid_development','Bid Development','Bid','Build pricing, compliance, alternates, and approvals.','An approved compliant bid is ready.','estimate_development',4,'active',21,'Coordinate pricing and compliance.','Approve the complete submission.','manager_approval','system'),
('cb_submit','__global__','tpl_commercial_bid_v1','submission_award','Submission & Award','Award','Submit compliantly and manage award communication.','The buyer records an award decision.','decision',5,'active',45,'Verify deadline and submission method.','Record award, loss, or withdrawal.','manager_approval','system'),
('cb_close','__global__','tpl_commercial_bid_v1','closed','Closed','Closed','Record award or loss outcome.','The bid has a documented final outcome.','terminal',6,'active',0,'Complete outcome evidence.','Terminal.','manager_approval','system');

INSERT OR IGNORE INTO sales_stage_outcomes
  (id,company_id,process_version_id,stage_id,stable_key,display_name,semantic_type,config_json)
VALUES
('db_won','__global__','tpl_design_build_v1','db_close','won','Won','won','{"required":["contract_signature","deposit_status"]}'),('db_lost','__global__','tpl_design_build_v1','db_close','lost','Lost','lost','{"required":["lost_reason"]}'),
('rm_won','__global__','tpl_maintenance_v1','rm_close','won','Won','won','{"required":["agreement","start_date"]}'),('rm_lost','__global__','tpl_maintenance_v1','rm_close','lost','Lost','lost','{"required":["lost_reason"]}'),
('ft_won','__global__','tpl_fast_turn_v1','ft_close','won','Won','won','{"required":["approved_quote","scheduled_date"]}'),('ft_lost','__global__','tpl_fast_turn_v1','ft_close','lost','Lost','lost','{"required":["lost_reason"]}'),
('cb_won','__global__','tpl_commercial_bid_v1','cb_close','won','Awarded','won','{"required":["award_notice","handoff"]}'),('cb_lost','__global__','tpl_commercial_bid_v1','cb_close','lost','Not Awarded','lost','{"required":["lost_reason"]}');

INSERT OR IGNORE INTO sales_stage_transition_paths
  (id,company_id,process_version_id,from_stage_id,to_stage_id,requires_override,active,outcome_type,display_label,guidance,display_order,override_policy,created_by)
VALUES
('db_t1','__global__','tpl_design_build_v1','db_intake','db_feas',0,1,'','Qualify feasibility','',1,'stage_policy','system'),('db_t2','__global__','tpl_design_build_v1','db_feas','db_design',0,1,'','Begin design','',1,'stage_policy','system'),('db_t3','__global__','tpl_design_build_v1','db_design','db_present',0,1,'','Present investment','',1,'stage_policy','system'),('db_t4','__global__','tpl_design_build_v1','db_present','db_close',0,1,'won','Close Won','',1,'stage_policy','system'),('db_t5','__global__','tpl_design_build_v1','db_present','db_close',0,1,'lost','Close Lost','',2,'stage_policy','system'),('db_t6','__global__','tpl_design_build_v1','db_present','db_design',0,1,'','Revise design','',3,'stage_policy','system'),
('rm_t1','__global__','tpl_maintenance_v1','rm_intake','rm_assess',0,1,'','Assess property','',1,'stage_policy','system'),('rm_t2','__global__','tpl_maintenance_v1','rm_assess','rm_quote',0,1,'','Prepare options','',1,'stage_policy','system'),('rm_t3','__global__','tpl_maintenance_v1','rm_quote','rm_activate',0,1,'','Activate service','',1,'stage_policy','system'),('rm_t4','__global__','tpl_maintenance_v1','rm_activate','rm_close',0,1,'won','Close Won','',1,'stage_policy','system'),('rm_t5','__global__','tpl_maintenance_v1','rm_quote','rm_close',0,1,'lost','Close Lost','',2,'stage_policy','system'),
('ft_t1','__global__','tpl_fast_turn_v1','ft_intake','ft_qualify',0,1,'','Qualify request','',1,'stage_policy','system'),('ft_t2','__global__','tpl_fast_turn_v1','ft_qualify','ft_quote',0,1,'','Prepare quote','',1,'stage_policy','system'),('ft_t3','__global__','tpl_fast_turn_v1','ft_quote','ft_schedule',0,1,'','Schedule work','',1,'stage_policy','system'),('ft_t4','__global__','tpl_fast_turn_v1','ft_schedule','ft_close',0,1,'won','Close Won','',1,'stage_policy','system'),('ft_t5','__global__','tpl_fast_turn_v1','ft_quote','ft_close',0,1,'lost','Close Lost','',2,'stage_policy','system'),
('cb_t1','__global__','tpl_commercial_bid_v1','cb_intake','cb_qualify',0,1,'','Qualify bid','',1,'stage_policy','system'),('cb_t2','__global__','tpl_commercial_bid_v1','cb_qualify','cb_site',0,1,'','Review site','',1,'stage_policy','system'),('cb_t3','__global__','tpl_commercial_bid_v1','cb_site','cb_bid',0,1,'','Develop bid','',1,'stage_policy','system'),('cb_t4','__global__','tpl_commercial_bid_v1','cb_bid','cb_submit',0,1,'','Submit bid','',1,'stage_policy','system'),('cb_t5','__global__','tpl_commercial_bid_v1','cb_submit','cb_close',0,1,'won','Awarded','',1,'stage_policy','system'),('cb_t6','__global__','tpl_commercial_bid_v1','cb_submit','cb_close',0,1,'lost','Not Awarded','',2,'stage_policy','system');
