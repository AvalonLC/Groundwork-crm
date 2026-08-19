-- Migration 0076: somewhere to record a chargeback.
--
-- The Stripe webhook handled two event types and neither of them was a dispute,
-- so a chargeback did nothing at all: the invoice kept reading "paid" while
-- Stripe had pulled the money back and opened a case with a deadline on it.
--
-- Refunds deliberately do NOT get columns here. A refund is a money movement and
-- already has a home — a payments row with a negative amount — and
-- invoices.amount_paid_cents is recomputed from that. Adding a refunded_cents
-- column would be a second, derivable source of the same fact, and the two would
-- disagree the first time one write path was missed.
--
-- A dispute is different: it is a state with a deadline, not a movement. The
-- money leaves and may come back, and until it resolves the invoice is neither
-- paid nor unpaid. That has nowhere else to live.

ALTER TABLE invoices ADD COLUMN dispute_status TEXT NOT NULL DEFAULT '';
-- When the case opened, so "how long have we had to respond" is answerable.
ALTER TABLE invoices ADD COLUMN disputed_at TEXT;
-- Stripe's dispute id, so a later dispute.closed finds the same invoice.
ALTER TABLE invoices ADD COLUMN dispute_id TEXT NOT NULL DEFAULT '';
-- Cents, like every other money column here.
ALTER TABLE invoices ADD COLUMN disputed_amount_cents INTEGER NOT NULL DEFAULT 0;

-- "Which invoices have an open case" is the question this gets asked.
CREATE INDEX IF NOT EXISTS idx_invoices_dispute
  ON invoices(company_id, dispute_status);
