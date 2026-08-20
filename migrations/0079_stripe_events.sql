-- Migration 0079: remember which Stripe events have been processed.
--
-- The webhook is idempotent per payment ROW — py_<payment_intent> means a
-- redelivered capture updates rather than duplicates (#64). That is not the
-- same as event-level idempotency, and the gap shows on anything whose effect
-- is not a single upsertable row:
--
--   charge.dispute.created   sets disputed_at via COALESCE, so a redelivery is
--                            harmless by luck rather than by design
--   payment_intent.succeeded arrives alongside checkout.session.completed for
--                            the same money, from two different objects
--
-- Stripe redelivers on any non-2xx and also replays old events after new ones.
-- Recording the event id and refusing the second sighting makes "processed
-- exactly once" a property of the table instead of something each handler has
-- to re-derive.
--
-- account_id is stored alongside so a quarantined event from an unrecognised
-- connected account is still recorded, and answerable later.

CREATE TABLE IF NOT EXISTS stripe_event (
  id          TEXT PRIMARY KEY,          -- Stripe's evt_...
  company_id  TEXT NOT NULL DEFAULT '',  -- '' when it could not be resolved
  account_id  TEXT NOT NULL DEFAULT '',  -- acct_... for connected-account events
  type        TEXT NOT NULL,
  received_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_stripe_event_company ON stripe_event(company_id, received_at);
-- "which events came from an account we do not recognise" — the quarantine read.
CREATE INDEX IF NOT EXISTS idx_stripe_event_account ON stripe_event(account_id, received_at);
