-- SMS platform: per-company two-way texting via Twilio.
-- Conversations thread by (company, phone). Messages carry full delivery
-- lifecycle (queued -> sent -> delivered / undelivered / failed) plus
-- Twilio SIDs and carrier error codes for the error log.

CREATE TABLE IF NOT EXISTS sms_conversations (
  id                    TEXT PRIMARY KEY,
  company_id            TEXT NOT NULL,
  phone_e164            TEXT NOT NULL,
  display_name          TEXT DEFAULT '',
  client_id             TEXT DEFAULT '',
  opp_id                TEXT DEFAULT '',
  last_message_at       TEXT DEFAULT '',
  last_message_preview  TEXT DEFAULT '',
  last_direction        TEXT DEFAULT '',
  unread_count          INTEGER NOT NULL DEFAULT 0,
  status                TEXT NOT NULL DEFAULT 'active',   -- active | archived
  created_at            TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_sms_conv_company_phone ON sms_conversations(company_id, phone_e164);
CREATE INDEX IF NOT EXISTS idx_sms_conv_company_last ON sms_conversations(company_id, last_message_at);

CREATE TABLE IF NOT EXISTS sms_messages (
  id               TEXT PRIMARY KEY,
  company_id       TEXT NOT NULL,
  conversation_id  TEXT NOT NULL,
  direction        TEXT NOT NULL DEFAULT 'out',           -- out | in
  body             TEXT NOT NULL DEFAULT '',
  from_number      TEXT DEFAULT '',
  to_number        TEXT DEFAULT '',
  status           TEXT NOT NULL DEFAULT 'queued',        -- queued|sent|delivered|undelivered|failed|received
  twilio_sid       TEXT DEFAULT '',
  error_code       TEXT DEFAULT '',
  error_message    TEXT DEFAULT '',
  rep_id           TEXT DEFAULT '',
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_sms_msg_conv ON sms_messages(conversation_id, created_at);
CREATE INDEX IF NOT EXISTS idx_sms_msg_company_status ON sms_messages(company_id, status);
CREATE INDEX IF NOT EXISTS idx_sms_msg_twilio_sid ON sms_messages(twilio_sid);

CREATE TABLE IF NOT EXISTS sms_templates (
  id          TEXT PRIMARY KEY,
  company_id  TEXT NOT NULL,
  name        TEXT NOT NULL DEFAULT '',
  body        TEXT NOT NULL DEFAULT '',
  category    TEXT DEFAULT 'general',
  created_by  TEXT DEFAULT '',
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_sms_tpl_company ON sms_templates(company_id, name);
