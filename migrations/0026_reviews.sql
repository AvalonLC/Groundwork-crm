-- Migration 0026: Review / Referral Engine

-- Review requests log
CREATE TABLE IF NOT EXISTS review_requests (
  id              TEXT PRIMARY KEY,
  company_id      TEXT NOT NULL,
  client_id       TEXT NOT NULL,
  client_name     TEXT DEFAULT '',
  client_email    TEXT DEFAULT '',
  client_phone    TEXT DEFAULT '',
  trigger_type    TEXT DEFAULT 'work_order_close',
  -- trigger_type: work_order_close | invoice_paid | manual
  trigger_id      TEXT DEFAULT '',
  -- ID of the WO or invoice that triggered it
  channel         TEXT DEFAULT 'email',
  -- channel: email | sms | both
  status          TEXT DEFAULT 'pending',
  -- statuses: pending | sent | opened | clicked | reviewed | declined | failed
  sent_at         TEXT DEFAULT '',
  opened_at       TEXT DEFAULT '',
  clicked_at      TEXT DEFAULT '',
  review_platform TEXT DEFAULT '',
  -- e.g. google | facebook | yelp | homeadvisor | custom
  review_url      TEXT DEFAULT '',
  rating          INTEGER DEFAULT 0,
  review_text     TEXT DEFAULT '',
  reviewed_at     TEXT DEFAULT '',
  delay_hours     INTEGER DEFAULT 24,
  scheduled_for   TEXT DEFAULT '',
  created_at      TEXT DEFAULT (datetime('now'))
);

-- Review settings per company
CREATE TABLE IF NOT EXISTS review_settings (
  company_id        TEXT PRIMARY KEY,
  enabled           INTEGER DEFAULT 1,
  trigger_on_wo     INTEGER DEFAULT 1,
  trigger_on_invoice INTEGER DEFAULT 1,
  delay_hours       INTEGER DEFAULT 24,
  channel           TEXT DEFAULT 'email',
  google_review_url TEXT DEFAULT '',
  facebook_url      TEXT DEFAULT '',
  yelp_url          TEXT DEFAULT '',
  homeadvisor_url   TEXT DEFAULT '',
  custom_url        TEXT DEFAULT '',
  email_subject     TEXT DEFAULT 'How did we do?',
  email_body        TEXT DEFAULT 'We hope you were happy with our service! Would you mind leaving us a quick review?',
  sms_body          TEXT DEFAULT 'Hi {client_name}! Thanks for choosing {company_name}. Leave us a review: {review_link}',
  created_at        TEXT DEFAULT (datetime('now')),
  updated_at        TEXT DEFAULT (datetime('now'))
);

-- Referral tracking
CREATE TABLE IF NOT EXISTS referrals (
  id              TEXT PRIMARY KEY,
  company_id      TEXT NOT NULL,
  referrer_client_id TEXT DEFAULT '',
  referrer_name   TEXT DEFAULT '',
  referred_client_id TEXT DEFAULT '',
  referred_name   TEXT DEFAULT '',
  referred_email  TEXT DEFAULT '',
  status          TEXT DEFAULT 'pending',
  -- pending | converted | rewarded | expired
  reward_type     TEXT DEFAULT 'none',
  -- none | discount | credit | cash | gift
  reward_value    REAL DEFAULT 0,
  reward_applied  INTEGER DEFAULT 0,
  source          TEXT DEFAULT 'manual',
  notes           TEXT DEFAULT '',
  created_at      TEXT DEFAULT (datetime('now'))
);

INSERT OR IGNORE INTO review_settings (company_id, google_review_url)
VALUES ('avalon', 'https://g.page/r/your-google-review-link');

CREATE INDEX IF NOT EXISTS idx_review_requests_company ON review_requests(company_id);
CREATE INDEX IF NOT EXISTS idx_review_requests_client  ON review_requests(client_id);
CREATE INDEX IF NOT EXISTS idx_review_requests_status  ON review_requests(status);
CREATE INDEX IF NOT EXISTS idx_referrals_company       ON referrals(company_id);
