-- Finance OS: action queue + AI layer (classification findings, receipts).
-- See docs/spec/ACTIONS.md, CLASSIFIER.md, RECEIPTS.md.

CREATE TABLE action_item (
  id                TEXT PRIMARY KEY,
  tenant_id         TEXT NOT NULL,
  -- Closed enum, no free-text verb — CLAUDE.md architecture invariant.
  verb              TEXT NOT NULL CHECK (verb IN ('collect','bill','pay','fix','decide')),
  owner_id          TEXT NOT NULL,
  sla_due           TEXT NOT NULL,
  amount_cents      INTEGER, -- nullable: not every action has a dollar figure
  confidence        TEXT NOT NULL, -- high | medium | low
  stale_components  TEXT,    -- JSON array of strings; must render in the UI
  status            TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved','dismissed')),
  source_type       TEXT,    -- work_item | classification_finding | receipt | ingest
  source_id         TEXT,
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at       TEXT
);
CREATE INDEX idx_action_item_open ON action_item(tenant_id, status, sla_due);
CREATE INDEX idx_action_item_owner ON action_item(tenant_id, owner_id, status);
CREATE INDEX idx_action_item_verb ON action_item(tenant_id, verb, status);

-- Classifier stages 1-3 (deterministic) + stage 4 (LLM) output. Never auto-posts
-- above tenant_finance_policy.materiality_threshold_cents or on model confidence
-- alone — always lands as an action_item(verb='decide') for review.
CREATE TABLE classification_finding (
  id                TEXT PRIMARY KEY,
  tenant_id         TEXT NOT NULL,
  subject_type      TEXT NOT NULL, -- e.g. 'pnl_line', 'receipt', 'equipment_meter'
  subject_id        TEXT NOT NULL,
  stage_reached     INTEGER NOT NULL CHECK (stage_reached BETWEEN 1 AND 4),
  confidence        TEXT NOT NULL, -- high | medium | low
  materiality_cents INTEGER NOT NULL DEFAULT 0,
  proposed_change   TEXT,          -- JSON
  action_item_id    TEXT REFERENCES action_item(id),
  created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_classification_finding_tenant ON classification_finding(tenant_id, subject_type, subject_id);

CREATE TABLE receipt (
  id                TEXT PRIMARY KEY,
  tenant_id         TEXT NOT NULL,
  job_id            TEXT,
  r2_key            TEXT NOT NULL,
  content_hash      TEXT NOT NULL, -- dedupe key
  vendor            TEXT,
  amount_cents      INTEGER,
  receipt_date      TEXT,
  -- Field-level, not receipt-level: {"amount_cents":"high","receipt_date":"low",...}
  field_confidence  TEXT,          -- JSON
  action_item_id    TEXT REFERENCES action_item(id),
  created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX idx_receipt_dedupe ON receipt(tenant_id, content_hash);
CREATE INDEX idx_receipt_job ON receipt(tenant_id, job_id);
