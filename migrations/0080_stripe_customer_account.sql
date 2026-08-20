-- Migration 0080: remember WHICH Stripe account a customer and card belong to.
--
-- clients.stripe_customer_id was created on the PLATFORM account — /v1/customers
-- with no Stripe-Account header — while chargeSavedPM and
-- POST /api/invoices/:id/charge send Stripe-Account and charge on the CONNECTED
-- account. A platform customer id does not exist there, so every saved-card
-- charge fails with "No such customer". Silent, because the failure surfaces as
-- a generic Stripe error on a path most tenants have never exercised.
--
-- Stripe customers and payment methods do not span accounts. A customer created
-- on the platform cannot be charged on a connected account, and a card attached
-- to one cannot be used by the other. So this is not a value to rewrite — it is
-- a value that belongs to an account, and the account has to be recorded
-- alongside it.
--
-- Deliberately NOT destructive. Nothing is nulled and nothing is deleted:
--
--   ''            legacy. Created before this migration, account unknown, and
--                 therefore assumed platform.
--   acct_...      created on that connected account and usable there.
--
-- The resolver treats a mismatch as "no customer" and creates a fresh one on
-- the right account, leaving the old row intact. A tenant that never connected
-- Stripe keeps working exactly as before.
--
-- The cost, stated plainly: a saved CARD cannot follow its customer to another
-- account. Cards on legacy platform customers have to be re-collected. That is
-- inherent to Stripe's model, not a choice made here — and it is why this
-- records the account rather than silently reusing an id that would fail.

ALTER TABLE clients ADD COLUMN stripe_customer_account_id TEXT NOT NULL DEFAULT '';

-- Same for a saved payment method: it is attached to a customer on one account.
ALTER TABLE client_autopay ADD COLUMN stripe_account_id TEXT NOT NULL DEFAULT '';

-- "Which customers still point at the platform" — the re-collection worklist.
CREATE INDEX IF NOT EXISTS idx_clients_stripe_customer_account
  ON clients(company_id, stripe_customer_account_id);
