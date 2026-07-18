-- Migration 0039: Platform Onboarding System (T22)
-- Three template types managed from Platform Admin → Onboarding:
--   sales           → internal sales-onboarding playbook (attached to gw_demos)
--   customer_wizard → config layer over the tenant signup wizard (custom questions)
--   tenant_checklist→ "Getting Started" checklist shown inside new tenant accounts

CREATE TABLE IF NOT EXISTS gw_onboarding_templates (
  id          TEXT PRIMARY KEY,
  type        TEXT NOT NULL DEFAULT 'sales',   -- sales | customer_wizard | tenant_checklist
  name        TEXT NOT NULL,
  description TEXT DEFAULT '',
  active      INTEGER NOT NULL DEFAULT 1,
  sort        INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS gw_onboarding_steps (
  id          TEXT PRIMARY KEY,
  template_id TEXT NOT NULL,
  title       TEXT NOT NULL,
  description TEXT DEFAULT '',
  fields      TEXT DEFAULT '[]',   -- JSON: wizard custom questions OR checklist meta {"auto":"clients","view":"clients","cta":"..."}
  required    INTEGER NOT NULL DEFAULT 0,
  locked      INTEGER NOT NULL DEFAULT 0,  -- 1 = built-in wizard step (not deletable)
  active      INTEGER NOT NULL DEFAULT 1,
  sort        INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_gw_onb_steps_tpl ON gw_onboarding_steps(template_id);

CREATE TABLE IF NOT EXISTS gw_onboarding_progress (
  id           TEXT PRIMARY KEY,
  template_id  TEXT NOT NULL,
  step_id      TEXT NOT NULL,
  subject_type TEXT NOT NULL DEFAULT 'demo',  -- demo | company
  subject_id   TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'done',  -- done | skipped
  completed_by TEXT DEFAULT '',
  notes        TEXT DEFAULT '',
  completed_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_gw_onb_prog_uniq ON gw_onboarding_progress(step_id, subject_type, subject_id);
CREATE INDEX IF NOT EXISTS idx_gw_onb_prog_subject ON gw_onboarding_progress(subject_type, subject_id);

-- ── Seed: templates ─────────────────────────────────────────────────────────
INSERT OR IGNORE INTO gw_onboarding_templates (id, type, name, description, sort) VALUES
  ('sales_default', 'sales', 'Sales Onboarding Playbook', 'Internal checklist from demo to go-live. Attached to every demo request.', 1),
  ('wizard_default', 'customer_wizard', 'New Company Signup Wizard', 'The first-login setup wizard every new tenant admin sees. Built-in steps are locked; add custom questions below.', 2),
  ('checklist_default', 'tenant_checklist', 'Getting Started Checklist', 'Shown inside every new tenant account after the wizard. Auto-detects completion where possible.', 3);

-- ── Seed: sales playbook steps ──────────────────────────────────────────────
INSERT OR IGNORE INTO gw_onboarding_steps (id, template_id, title, description, required, sort) VALUES
  ('sp_demo_sched',   'sales_default', 'Demo scheduled & confirmed',        'Calendar invite sent and confirmed by prospect.', 1, 1),
  ('sp_demo_done',    'sales_default', 'Demo delivered',                    'Walk through pipeline, estimates, invoicing, scheduling, AI features.', 1, 2),
  ('sp_needs',        'sales_default', 'Needs assessment',                  'Team size, seat counts (rep/field/office), must-have features, current tools, data to import.', 1, 3),
  ('sp_proposal',     'sales_default', 'Proposal & pricing sent',           'Plan recommendation + seat pricing + AI package if needed. Volume discounts for 6+ field seats.', 1, 4),
  ('sp_agreement',    'sales_default', 'Agreement signed',                  'Terms accepted; billing details collected.', 1, 5),
  ('sp_account',      'sales_default', 'Account created',                   'Signup completed (or created for them) — convert the demo to mark it.', 1, 6),
  ('sp_plan_config',  'sales_default', 'Plan & seats configured',           'Set the correct plan and AI package in Platform Settings → tenant row.', 1, 7),
  ('sp_branding',     'sales_default', 'Branding & assets collected',       'Logo, brand colors, license/insurance info entered in their account.', 0, 8),
  ('sp_import',       'sales_default', 'Data import complete',              'Clients, price book, and open estimates imported.', 0, 9),
  ('sp_kickoff',      'sales_default', 'Kickoff call & training',           'Admin + office staff trained; field crew app walkthrough scheduled.', 1, 10),
  ('sp_golive',       'sales_default', 'Go-live confirmed',                 'First real estimate/invoice sent. Schedule 1-week check-in.', 1, 11);

-- ── Seed: wizard steps (built-ins locked, one custom-questions slot) ───────
INSERT OR IGNORE INTO gw_onboarding_steps (id, template_id, title, description, fields, locked, sort) VALUES
  ('wz_welcome',   'wizard_default', 'Welcome',           'Intro screen with industry tip. (Built-in)', '[]', 1, 1),
  ('wz_profile',   'wizard_default', 'Business Profile',  'Company name, industry, phone, address. Drives industry seeding. (Built-in)', '[]', 1, 2),
  ('wz_client',    'wizard_default', 'First Client',      'Prompts admin to add their first client. (Built-in)', '[]', 1, 3),
  ('wz_estimate',  'wizard_default', 'First Estimate',    'Creates a sample estimate from industry template. (Built-in)', '[]', 1, 4),
  ('wz_team',      'wizard_default', 'Team Setup',        'Crew count & divisions. (Built-in)', '[]', 1, 5),
  ('wz_custom',    'wizard_default', 'Custom Questions',  'Your own intake questions — answers saved to onboarding responses, visible in the Tenant Funnel.', '[{"key":"current_tools","label":"What are you using to run your business today?","type":"text"},{"key":"biggest_pain","label":"What is the #1 thing you want Groundwork to fix?","type":"text"},{"key":"data_import","label":"Do you have client/price data to import?","type":"select","options":["No","Yes — spreadsheet","Yes — from another CRM"]}]', 0, 6);

-- ── Seed: tenant Getting Started checklist ──────────────────────────────────
INSERT OR IGNORE INTO gw_onboarding_steps (id, template_id, title, description, fields, sort) VALUES
  ('cl_wizard',    'checklist_default', 'Complete the setup wizard',   'Company profile, industry, and team basics.', '{"auto":"wizard","view":"gwDashboard","cta":"Open"}', 1),
  ('cl_client',    'checklist_default', 'Add your first client',       'Your client list powers estimates, invoices, and scheduling.', '{"auto":"clients","view":"clients","cta":"Add Client"}', 2),
  ('cl_pricebook', 'checklist_default', 'Set up your price book',      'Add your services and rates for one-click estimate line items.', '{"auto":"price_items","view":"priceBook","cta":"Price Book"}', 3),
  ('cl_estimate',  'checklist_default', 'Create your first estimate',  'Send a professional estimate your client can accept online.', '{"auto":"estimates","view":"estimates","cta":"New Estimate"}', 4),
  ('cl_invoice',   'checklist_default', 'Send your first invoice',     'Get paid — invoices support online payment via Stripe.', '{"auto":"invoices","view":"invoices","cta":"Invoices"}', 5),
  ('cl_team',      'checklist_default', 'Invite your team',            'Add reps, field crew, and office staff with role-based access.', '{"auto":"reps","view":"userManagement","cta":"Invite"}', 6),
  ('cl_google',    'checklist_default', 'Connect Google Workspace',    'Sync Gmail and Calendar for AI email drafting and scheduling.', '{"auto":"google","view":"integrations","cta":"Connect"}', 7),
  ('cl_reviews',   'checklist_default', 'Turn on review requests',     'Auto-request Google reviews when jobs complete.', '{"auto":"manual","view":"reviewEngine","cta":"Set Up"}', 8);
