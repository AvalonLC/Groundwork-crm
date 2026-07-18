-- Migration 0040: Onboarding full build-out (T23)
-- Phase-structured sales playbook (16 steps), refined wizard questions,
-- expanded auto-detecting Getting Started checklist (11 items).
-- INSERT OR REPLACE keeps existing step ids so recorded progress stays valid.

-- ═══ SALES PLAYBOOK — 4 phases, 16 steps ═══════════════════════════════════
-- Phase 1 · Discovery & Demo
INSERT OR REPLACE INTO gw_onboarding_steps (id, template_id, title, description, fields, required, locked, active, sort) VALUES
  ('sp_prep',        'sales_default', 'Pre-demo research',              'Review their website, services, service area, review count, and team size. Note 2-3 specific pains Groundwork solves for THEIR trade — reference them in the demo.', '{"phase":"Discovery & Demo"}', 0, 0, 1, 1),
  ('sp_demo_sched',  'sales_default', 'Demo scheduled & confirmed',     'Calendar invite sent and confirmed. Send a 1-line agenda: "30 min — I''ll show you how [Company] would run leads → estimate → invoice → payment in Groundwork."', '{"phase":"Discovery & Demo"}', 1, 0, 1, 2),
  ('sp_demo_done',   'sales_default', 'Demo delivered',                 'Walk THEIR workflow: lead comes in → estimate on-site → client accepts online → job scheduled → invoice paid → review requested. Show AI features last as the wow-closer.', '{"phase":"Discovery & Demo"}', 1, 0, 1, 3),
  ('sp_needs',       'sales_default', 'Needs assessment complete',      'Record: team size & seat mix (rep/field/office), current tools, data to import, must-have features, decision timeline, who signs off.', '{"phase":"Discovery & Demo"}', 1, 0, 1, 4);

-- Phase 2 · Proposal & Close
INSERT OR REPLACE INTO gw_onboarding_steps (id, template_id, title, description, fields, required, locked, active, sort) VALUES
  ('sp_proposal',    'sales_default', 'Proposal & pricing sent',        'Recommend ONE plan (don''t make them choose from five). Itemize seats, AI package if needed, and volume discount for 6+ field seats. Include first-month expectations.', '{"phase":"Proposal & Close"}', 1, 0, 1, 5),
  ('sp_followup',    'sales_default', 'Follow-up within 48 hours',      'Call or email within 2 business days. Ask what questions came up when they discussed it internally — not "did you decide yet."', '{"phase":"Proposal & Close"}', 1, 0, 1, 6),
  ('sp_objections',  'sales_default', 'Objections resolved',            'Price → ROI per saved job. Switching pain → we do the import for you. Timing → trial starts when THEY''RE ready. Log each objection + answer in notes.', '{"phase":"Proposal & Close"}', 0, 0, 1, 7),
  ('sp_agreement',   'sales_default', 'Agreement signed',               'Terms accepted, billing details collected, start date set. Confirm plan + seat counts one final time in writing.', '{"phase":"Proposal & Close"}', 1, 0, 1, 8);

-- Phase 3 · Account Setup
INSERT OR REPLACE INTO gw_onboarding_steps (id, template_id, title, description, fields, required, locked, active, sort) VALUES
  ('sp_account',     'sales_default', 'Account created',                'They complete signup (or you create it for them). Convert this demo to mark it — the tenant appears in the Tenant Funnel from here.', '{"phase":"Account Setup"}', 1, 0, 1, 9),
  ('sp_plan_config', 'sales_default', 'Plan & seats configured',        'Set the agreed plan + AI package in Platform Settings → tenant row. Verify AI cap matches what they bought.', '{"phase":"Account Setup"}', 1, 0, 1, 10),
  ('sp_branding',    'sales_default', 'Branding & assets collected',    'Logo, brand colors, license #, insurance info entered. Their estimates and client portal should look like THEIR company on day one.', '{"phase":"Account Setup"}', 0, 0, 1, 11),
  ('sp_import',      'sales_default', 'Data import complete',           'Clients, price book, and open estimates imported and spot-checked WITH them — bad data on day one kills adoption.', '{"phase":"Account Setup"}', 0, 0, 1, 12),
  ('sp_google',      'sales_default', 'Google Workspace connected',     'Gmail + Calendar connected so AI email drafting and scheduling work from the first week.', '{"phase":"Account Setup"}', 0, 0, 1, 13);

-- Phase 4 · Launch & Success
INSERT OR REPLACE INTO gw_onboarding_steps (id, template_id, title, description, fields, required, locked, active, sort) VALUES
  ('sp_kickoff',     'sales_default', 'Kickoff call & training',        'Train admin + office staff (45 min), then a separate 15-min field-crew walkthrough on their phones. Leave them with ONE goal: send a real estimate this week.', '{"phase":"Launch & Success"}', 1, 0, 1, 14),
  ('sp_golive',      'sales_default', 'Go-live confirmed',              'First REAL estimate or invoice sent to a REAL client. Check their Getting Started progress in the Tenant Funnel — nudge on stalled items.', '{"phase":"Launch & Success"}', 1, 0, 1, 15),
  ('sp_checkin',     'sales_default', '1-week check-in',                'Quick call: what''s working, what''s confusing, any team pushback? Fix friction NOW — week one determines whether they stick.', '{"phase":"Launch & Success"}', 1, 0, 1, 16),
  ('sp_review30',    'sales_default', '30-day success review',          'Review usage together: estimates sent, invoices paid, AI actions used. Right-size seats/AI package. Ask for a referral if they''re happy.', '{"phase":"Launch & Success"}', 0, 0, 1, 17);

-- ═══ WIZARD — refined custom questions (fast, high-signal, all selects) ═════
INSERT OR REPLACE INTO gw_onboarding_steps (id, template_id, title, description, fields, required, locked, active, sort) VALUES
  ('wz_custom', 'wizard_default', 'Quick Questions', 'Four fast questions so we can set your account up right — takes 20 seconds.',
   '[{"key":"heard_about","label":"How did you hear about Groundwork?","type":"select","options":["Google search","Referral from another contractor","Social media","Saw a demo","Other"]},{"key":"current_tools","label":"What are you running the business on today?","type":"select","options":["Pen & paper / texts","Spreadsheets","QuickBooks only","Jobber","Housecall Pro","ServiceTitan","Another CRM","Nothing yet — just starting"]},{"key":"biggest_pain","label":"What''s the #1 thing you want fixed?","type":"select","options":["Leads slipping through the cracks","Estimates take too long","Getting paid faster","Scheduling chaos","No visibility into the business","Look more professional to clients"]},{"key":"data_import","label":"Do you have client or pricing data to bring over?","type":"select","options":["No — fresh start","Yes — a spreadsheet","Yes — from another CRM (we''ll import it for you)"]}]',
   0, 0, 1, 6);

-- ═══ GETTING STARTED CHECKLIST — 11 items, 9 auto-detecting ═════════════════
INSERT OR REPLACE INTO gw_onboarding_steps (id, template_id, title, description, fields, required, locked, active, sort) VALUES
  ('cl_wizard',    'checklist_default', 'Complete the setup wizard',      'Company profile, industry, and team basics — done in about 3 minutes.', '{"auto":"wizard","view":"gwDashboard","cta":"Open"}', 0, 0, 1, 1),
  ('cl_branding',  'checklist_default', 'Add your logo & brand colors',   'Your estimates, invoices, and client portal will carry YOUR brand — not ours.', '{"auto":"branding","view":"settings","cta":"Add Branding"}', 0, 0, 1, 2),
  ('cl_client',    'checklist_default', 'Add your first client',          'Everything starts here — estimates, jobs, and invoices all hang off the client.', '{"auto":"clients","view":"clients","cta":"Add Client"}', 0, 0, 1, 3),
  ('cl_pricebook', 'checklist_default', 'Build your price book',          'Add your services and rates once — then build estimates with one-click line items.', '{"auto":"price_items","view":"pricing","cta":"Price Book"}', 0, 0, 1, 4),
  ('cl_estimate',  'checklist_default', 'Send your first estimate',       'Professional, branded, and your client can accept it online from their phone.', '{"auto":"estimates","view":"estimates","cta":"New Estimate"}', 0, 0, 1, 5),
  ('cl_workorder', 'checklist_default', 'Schedule your first job',        'Turn an accepted estimate into a scheduled job your crew can see in the field.', '{"auto":"work_orders","view":"dispatchBoard","cta":"Schedule"}', 0, 0, 1, 6),
  ('cl_invoice',   'checklist_default', 'Send your first invoice',        'Invoice from the job in two clicks — clients pay online, you get paid faster.', '{"auto":"invoices","view":"invoices","cta":"Invoices"}', 0, 0, 1, 7),
  ('cl_payments',  'checklist_default', 'Connect online payments',        'Hook up Stripe so clients can pay invoices by card the moment they get them.', '{"auto":"stripe","view":"integrations","cta":"Connect"}', 0, 0, 1, 8),
  ('cl_team',      'checklist_default', 'Invite your team',               'Reps, field crew, and office staff — everyone gets the right access for their role.', '{"auto":"reps","view":"userManagement","cta":"Invite"}', 0, 0, 1, 9),
  ('cl_google',    'checklist_default', 'Connect Google Workspace',       'Sync Gmail and Calendar — unlocks AI email drafting and calendar scheduling.', '{"auto":"google","view":"integrations","cta":"Connect"}', 0, 0, 1, 10),
  ('cl_reviews',   'checklist_default', 'Turn on review requests',        'Auto-ask happy clients for a Google review when the job wraps — reviews win the next job.', '{"auto":"manual","view":"reviews","cta":"Set Up"}', 0, 0, 1, 11);
