-- Migration 0024: Recurring Service Plans
-- Plan definitions + client subscriptions + schedule tracking

CREATE TABLE IF NOT EXISTS recurring_plans (
  id              TEXT PRIMARY KEY,
  company_id      TEXT NOT NULL,
  name            TEXT NOT NULL DEFAULT '',
  description     TEXT DEFAULT '',
  service_type    TEXT DEFAULT '',
  frequency       TEXT DEFAULT 'monthly',
  -- frequencies: weekly | biweekly | monthly | bimonthly | quarterly | semiannual | annual | custom
  frequency_days  INTEGER DEFAULT 30,
  -- for custom: interval in days
  price           REAL DEFAULT 0,
  price_type      TEXT DEFAULT 'flat',
  -- price_type: flat | per_visit | per_unit
  unit_label      TEXT DEFAULT 'visit',
  estimated_hours REAL DEFAULT 0,
  crew_size       INTEGER DEFAULT 1,
  tasks           TEXT DEFAULT '[]',
  -- JSON: [{title, description}]
  is_active       INTEGER DEFAULT 1,
  created_at      TEXT DEFAULT (datetime('now')),
  updated_at      TEXT DEFAULT (datetime('now'))
);

-- Client subscriptions to plans
CREATE TABLE IF NOT EXISTS client_plan_subscriptions (
  id              TEXT PRIMARY KEY,
  company_id      TEXT NOT NULL,
  plan_id         TEXT NOT NULL,
  client_id       TEXT NOT NULL,
  client_name     TEXT DEFAULT '',
  status          TEXT DEFAULT 'active',
  -- statuses: active | paused | cancelled | completed
  start_date      TEXT DEFAULT '',
  end_date        TEXT DEFAULT '',
  next_visit_date TEXT DEFAULT '',
  last_visit_date TEXT DEFAULT '',
  visit_count     INTEGER DEFAULT 0,
  notes           TEXT DEFAULT '',
  custom_price    REAL DEFAULT 0,
  -- 0 = use plan price
  auto_invoice    INTEGER DEFAULT 0,
  created_at      TEXT DEFAULT (datetime('now')),
  updated_at      TEXT DEFAULT (datetime('now'))
);

-- Visit log for each subscription occurrence
CREATE TABLE IF NOT EXISTS plan_visits (
  id                TEXT PRIMARY KEY,
  company_id        TEXT NOT NULL,
  subscription_id   TEXT NOT NULL,
  plan_id           TEXT NOT NULL,
  client_id         TEXT NOT NULL,
  scheduled_date    TEXT DEFAULT '',
  completed_date    TEXT DEFAULT '',
  work_order_id     TEXT DEFAULT '',
  invoice_id        TEXT DEFAULT '',
  status            TEXT DEFAULT 'scheduled',
  -- statuses: scheduled | in_progress | completed | skipped | cancelled
  notes             TEXT DEFAULT '',
  created_at        TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_plans_company      ON recurring_plans(company_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_co   ON client_plan_subscriptions(company_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_cl   ON client_plan_subscriptions(client_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_plan ON client_plan_subscriptions(plan_id);
CREATE INDEX IF NOT EXISTS idx_plan_visits_sub    ON plan_visits(subscription_id);
CREATE INDEX IF NOT EXISTS idx_plan_visits_client ON plan_visits(client_id);
CREATE INDEX IF NOT EXISTS idx_plan_visits_date   ON plan_visits(scheduled_date);
