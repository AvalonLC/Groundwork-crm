-- Migration 0037: Platform internal ops — demo requests + pricing plans
-- gw_demos: demo requests coming from groundwork-crm.info (or added manually)
-- gw_pricing_plans: source of truth for plan pricing (replaces hardcoded MRR map)

CREATE TABLE IF NOT EXISTS gw_demos (
  id TEXT PRIMARY KEY,
  lead_id TEXT,                          -- optional link to gw_leads
  company_name TEXT NOT NULL DEFAULT '',
  contact_name TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  phone TEXT DEFAULT '',
  message TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'requested',  -- requested | scheduled | completed | no_show | converted | cancelled
  scheduled_at TEXT,                     -- ISO datetime when demo is booked
  source_page TEXT DEFAULT '',           -- page/url on groundwork-crm.info that submitted
  source TEXT NOT NULL DEFAULT 'website',-- website | manual | referral | other
  notes TEXT DEFAULT '',
  assigned_to TEXT DEFAULT 'gw_tyler',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_gw_demos_status ON gw_demos(status);
CREATE INDEX IF NOT EXISTS idx_gw_demos_created ON gw_demos(created_at);

CREATE TABLE IF NOT EXISTS gw_pricing_plans (
  id TEXT PRIMARY KEY,                   -- starter | pro | enterprise | custom ids
  name TEXT NOT NULL,
  monthly_price REAL NOT NULL DEFAULT 0,
  annual_price REAL NOT NULL DEFAULT 0,  -- per-month equivalent when billed annually (0 = n/a)
  ai_credits INTEGER NOT NULL DEFAULT 0, -- monthly AI action cap (0 = unlimited)
  max_reps INTEGER NOT NULL DEFAULT 0,   -- 0 = unlimited
  features TEXT DEFAULT '[]',            -- JSON array of feature strings
  highlight INTEGER NOT NULL DEFAULT 0,  -- 1 = "most popular" badge
  active INTEGER NOT NULL DEFAULT 1,
  sort INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Seed current pricing (matches previously hardcoded MRR map)
INSERT OR IGNORE INTO gw_pricing_plans (id, name, monthly_price, annual_price, ai_credits, max_reps, features, highlight, active, sort) VALUES
  ('starter',    'Starter',    99,  79,  200,  5,  '["Full CRM & pipeline","Estimates & invoicing","Calendar sync","200 AI actions/mo","5 team members"]', 0, 1, 1),
  ('pro',        'Pro',        249, 199, 1000, 15, '["Everything in Starter","AI follow-up engine","1,000 AI actions/mo","Commission tracking","15 team members","Priority support"]', 1, 1, 2),
  ('enterprise', 'Enterprise', 499, 399, 0,    0,  '["Everything in Pro","Unlimited AI actions","Unlimited team members","Dedicated onboarding","Custom integrations","SLA support"]', 0, 1, 3);
