-- Migration 0025: Onboarding + Public Signup + Trial system

-- Onboarding state on companies
ALTER TABLE companies ADD COLUMN onboarding_completed  INTEGER DEFAULT 0;
ALTER TABLE companies ADD COLUMN onboarding_step       INTEGER DEFAULT 0;
ALTER TABLE companies ADD COLUMN onboarding_data       TEXT DEFAULT '{}';
-- JSON: answers from wizard (business_type, team_size, goals, etc.)
ALTER TABLE companies ADD COLUMN trial_started_at      TEXT DEFAULT '';
ALTER TABLE companies ADD COLUMN trial_expires_at      TEXT DEFAULT '';
ALTER TABLE companies ADD COLUMN trial_plan            TEXT DEFAULT 'growth';
ALTER TABLE companies ADD COLUMN subscription_status   TEXT DEFAULT 'trial';
-- statuses: trial | active | past_due | cancelled | suspended
ALTER TABLE companies ADD COLUMN subscription_plan     TEXT DEFAULT '';
ALTER TABLE companies ADD COLUMN stripe_customer_id    TEXT DEFAULT '';

-- Signup invitations / tokens for public signup flow
CREATE TABLE IF NOT EXISTS signup_tokens (
  id          TEXT PRIMARY KEY,
  email       TEXT NOT NULL,
  token       TEXT UNIQUE NOT NULL,
  company_name TEXT DEFAULT '',
  business_type TEXT DEFAULT '',
  used        INTEGER DEFAULT 0,
  expires_at  TEXT DEFAULT '',
  created_at  TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_signup_tokens_token ON signup_tokens(token);
CREATE INDEX IF NOT EXISTS idx_signup_tokens_email ON signup_tokens(email);

-- Onboarding wizard answers table (optional — for industry seeding logic)
CREATE TABLE IF NOT EXISTS onboarding_responses (
  id          TEXT PRIMARY KEY,
  company_id  TEXT NOT NULL,
  step        INTEGER NOT NULL,
  question    TEXT DEFAULT '',
  answer      TEXT DEFAULT '',
  created_at  TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_onboarding_company ON onboarding_responses(company_id);
