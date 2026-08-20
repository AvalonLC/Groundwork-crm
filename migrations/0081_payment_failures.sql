-- Migration 0081: record that a payment failed, and why.
--
-- payment_intent.payment_failed was acknowledged and logged and nothing else.
-- The company found out by noticing an invoice was still unpaid — which is not
-- a signal, it is the absence of one.
--
-- Deliberately NOT a status value. A failed payment does not change what the
-- invoice IS: it is still sent, still owed, still the same amount. Overloading
-- `status` would mean every existing query that filters on 'sent' silently stops
-- seeing it, and the invoice would need un-failing on the next attempt. These
-- are attempt metadata, and they sit beside the status rather than inside it.

ALTER TABLE invoices ADD COLUMN payment_failed_at     TEXT;
-- Stripe's own decline message, shown to whoever has to chase it. Not a code:
-- "Your card was declined" is actionable, "card_declined" is not.
ALTER TABLE invoices ADD COLUMN payment_failed_reason TEXT NOT NULL DEFAULT '';
-- Cleared on success, so an invoice that failed and then paid does not keep
-- wearing the flag.
ALTER TABLE invoices ADD COLUMN payment_failed_count  INTEGER NOT NULL DEFAULT 0;

-- "Which invoices had a payment fail" — the dunning worklist.
CREATE INDEX IF NOT EXISTS idx_invoices_payment_failed
  ON invoices(company_id, payment_failed_at);
