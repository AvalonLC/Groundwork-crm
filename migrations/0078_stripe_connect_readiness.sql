-- Migration 0078: full connected-account readiness, and fees in integer bps.
--
-- companies carried stripe_charges_enabled and stripe_onboarded and nothing
-- else, so the product could not tell these apart:
--
--   onboarding started but unfinished     details_submitted = 0
--   finished, awaiting Stripe review      charges_enabled = 0, requirements due
--   live                                  charges + payouts enabled
--   was live, now restricted              charges_enabled flipped back to 0
--
-- The last one was invisible twice over: nothing stored payouts_enabled or the
-- outstanding requirements, and the account.updated handler only ever SET the
-- flags — `if (acct.charges_enabled) UPDATE ... SET stripe_charges_enabled=1`.
-- An account that lost its capability stayed marked live forever, so the app
-- would keep sending customers to a Checkout that Stripe would refuse.
--
-- stripe_platform_fee_bps replaces a REAL percentage in fee arithmetic. 2.9%
-- stored as 2.9 and multiplied out is the float rule this schema exists to
-- avoid; 290 basis points is exact. The old column is left in place and
-- backfilled from, not dropped — every reader moves first, then it goes.

ALTER TABLE companies ADD COLUMN stripe_payouts_enabled   INTEGER NOT NULL DEFAULT 0;
ALTER TABLE companies ADD COLUMN stripe_details_submitted INTEGER NOT NULL DEFAULT 0;
-- Comma-separated Stripe requirement keys, e.g. "individual.id_number,tos_acceptance.date".
ALTER TABLE companies ADD COLUMN stripe_requirements_due  TEXT NOT NULL DEFAULT '';
-- Derived, not stored by Stripe: '' | 'pending' | 'active' | 'restricted'.
ALTER TABLE companies ADD COLUMN stripe_connection_status TEXT NOT NULL DEFAULT '';
ALTER TABLE companies ADD COLUMN stripe_platform_fee_bps  INTEGER NOT NULL DEFAULT 290;

-- Backfill bps from the existing percentage. ROUND before CAST: 2.9 * 100 is
-- 289.99999999999997 in IEEE754, and CAST truncates, so this would silently
-- become 289 bps — a tenth of a basis point lost on every fee, forever.
UPDATE companies
   SET stripe_platform_fee_bps = CAST(ROUND(COALESCE(stripe_platform_fee_pct, 2.9) * 100) AS INTEGER)
 WHERE stripe_platform_fee_pct IS NOT NULL;

-- One CRM company per Stripe account. Without this, two companies could point
-- at the same acct_ and a connected-account webhook would have no single
-- correct tenant to resolve to. Partial, because '' is the normal
-- not-yet-connected state and is not a duplicate.
CREATE UNIQUE INDEX IF NOT EXISTS idx_companies_stripe_account
  ON companies(stripe_account_id) WHERE stripe_account_id != '';
