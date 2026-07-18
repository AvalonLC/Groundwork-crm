-- Migration 0038: Import real Groundwork CRM pricing (seat-based model)
-- Extends gw_pricing_plans with per-seat pricing, adds gw_ai_packages,
-- and replaces placeholder seed data with the real plan lineup.

-- Per-seat pricing columns (0 = not available / n-a)
ALTER TABLE gw_pricing_plans ADD COLUMN tagline TEXT DEFAULT '';
ALTER TABLE gw_pricing_plans ADD COLUMN seat_rep REAL NOT NULL DEFAULT 0;
ALTER TABLE gw_pricing_plans ADD COLUMN seat_field REAL NOT NULL DEFAULT 0;
ALTER TABLE gw_pricing_plans ADD COLUMN seat_office REAL NOT NULL DEFAULT 0;
ALTER TABLE gw_pricing_plans ADD COLUMN seat_viewonly REAL NOT NULL DEFAULT 0;
ALTER TABLE gw_pricing_plans ADD COLUMN viewonly_included INTEGER NOT NULL DEFAULT 0;
ALTER TABLE gw_pricing_plans ADD COLUMN extra_seats_available INTEGER NOT NULL DEFAULT 1;
ALTER TABLE gw_pricing_plans ADD COLUMN is_custom INTEGER NOT NULL DEFAULT 0;

-- Company-wide AI add-on packages
CREATE TABLE IF NOT EXISTS gw_ai_packages (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  monthly_price REAL NOT NULL DEFAULT 0,
  ai_actions INTEGER NOT NULL DEFAULT 0,   -- total monthly allowance (0 = custom/n-a)
  description TEXT DEFAULT '',
  features TEXT DEFAULT '[]',
  highlight INTEGER NOT NULL DEFAULT 0,
  is_custom INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  sort INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Replace placeholder plans with the real lineup
DELETE FROM gw_pricing_plans WHERE id IN ('starter','pro','enterprise');

INSERT OR IGNORE INTO gw_pricing_plans (id, name, monthly_price, annual_price, ai_credits, max_reps, features, highlight, active, sort, tagline, seat_rep, seat_field, seat_office, seat_viewonly, viewonly_included, extra_seats_available, is_custom) VALUES
  ('starter', 'Starter', 29, 0, 50, 1,
   '["1 Rep/Estimator seat included","50 AI actions per month","Lead and customer management","Estimates and proposals","Basic scheduling","Basic reporting","Email support"]',
   0, 1, 1, 'For solo operators testing Groundwork.', 0, 0, 0, 0, 0, 0, 0),
  ('core', 'Core', 49, 0, 100, 0,
   '["1 Rep/Estimator seat","100 AI actions per month","CRM and lead management","Estimates and proposals","Scheduling and job management","Customer communication","Basic reporting","Mobile field access"]',
   0, 1, 2, 'For small contractors building a more organized sales and production process.', 49, 25, 89, 10, 1, 1, 0),
  ('growth', 'Growth', 65, 0, 250, 0,
   '["1 Rep/Estimator seat","250 AI actions per month","Everything in Core","Advanced scheduling","Sales pipeline management","Enhanced reporting","Automations","Client portal","Advanced AI drafting tools","Priority support"]',
   1, 1, 3, 'For established contractors managing multiple crews and a growing sales pipeline.', 65, 30, 105, 10, 3, 1, 0),
  ('pro', 'Pro', 85, 0, 500, 0,
   '["1 Rep/Estimator seat","500 AI actions per month","Everything in Growth","Advanced financial reporting","Custom workflows","API access","Advanced permissions","Multi-division reporting","Priority onboarding and support"]',
   0, 1, 4, 'For larger contractors that need advanced controls, reporting and integrations.', 85, 35, 135, 10, 5, 1, 0),
  ('enterprise', 'Enterprise', 0, 0, 0, 0,
   '["Custom user pricing","Custom AI allowance","Dedicated onboarding","Custom permissions and workflows","Advanced integrations","Account management","Volume pricing"]',
   0, 1, 5, 'For multi-location, franchise or high-volume organizations.', 0, 0, 0, 0, 0, 1, 1);

-- Seed AI packages
INSERT OR IGNORE INTO gw_ai_packages (id, name, monthly_price, ai_actions, description, features, highlight, is_custom, active, sort) VALUES
  ('essentials', 'AI Essentials', 12, 500, 'Shared across the company.',
   '["500 total AI actions","Shared across the company","Proposal drafting","Quote descriptions","Scope-of-work drafting","Follow-up emails","Live usage tracking","No automatic overages"]', 0, 0, 1, 1),
  ('plus', 'AI Plus', 29, 1500, 'Shared across the company.',
   '["1,500 total AI actions","Shared across the company","All Groundwork AI tools","Usage warnings at 80%","Live usage reporting","No automatic overages"]', 1, 0, 1, 2),
  ('max', 'AI Max', 59, 5000, 'Shared across the company.',
   '["5,000 total AI actions","Shared across the company","All Groundwork AI tools","High-volume usage","Detailed usage reporting","Custom allowances available","No automatic overages"]', 0, 0, 1, 3),
  ('custom_ai', 'Custom AI', 0, 0, 'Custom allowance — contact sales.',
   '["Custom allowance","Volume pricing","Dedicated support"]', 0, 1, 1, 4),
  ('byok', 'Bring Your Own Key', 0, 0, 'Customer-funded usage — no Groundwork AI charge.',
   '["Use your own OpenAI API key","Customer-funded usage","No Groundwork AI charge","No caps from Groundwork"]', 0, 0, 1, 5);

-- Field-seat volume discount rules (JSON in settings; UI + billing read this)
INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES
  ('gw_field_seat_discounts', '[{"min":1,"max":5,"discount":0,"label":"Standard rate"},{"min":6,"max":10,"discount":10,"label":"10% off field seats"},{"min":11,"max":null,"discount":15,"label":"15% off field seats or custom pricing"}]', datetime('now'));
