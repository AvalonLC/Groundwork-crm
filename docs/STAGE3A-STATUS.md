# Stage 3a status — merged, soak period in progress

Branch `stage-3a-cents-cutover` merged to `main` (fast-forward) at commit
`4ba147d`, deployed to production via `deploy.yml` on 2026-08-10. No
migration file in this stage — pure reader cutover, no schema/data change.

## What this stage did
Switched every reader (API responses + internal arithmetic) across
opportunities, estimates, invoices, payments, work_orders,
recurring_plans/client_plan_subscriptions, proposals, price_items,
client_autopay, and the 3 Finance OS UI pages (`collections.tsx`,
`invoices-payments.tsx`, `ledger.tsx`) to compute from the `*_cents`
integer columns added in Stage 2, instead of the float columns. Float
columns are still dual-written (Stage 2's code, untouched) — nothing was
removed, nothing is irreversible. A plain `git revert` of this merge is a
safe rollback if anything surfaces during the soak period below.

## Pre-merge review (independent, this session)
- Full diff read (`src/index.tsx`, `src/portal.tsx`, 3 UI `.tsx` files +
  their `.e2e.ts` tests, `src/money-cents.test.ts`'s new `MC3A-*` tests).
- Confirmed Finance OS engine files (`allocation.ts`, `burden.ts`,
  `recovery.ts`) correctly excluded — they already run on Stage 1's
  cents-native Finance tables, not the CRM's float columns.
- Independently re-ran typecheck (clean), full unit suite (166/166),
  Playwright e2e (87/87) in an isolated worktree — twice: once against
  the initial `000beb3`, again against the tax-fix commit `4ba147d`.
- **Found and got fixed before merge**: `POST
  /api/invoices/from-estimate/:estimateId` read `est.tax_amount_cents`/
  `est.tax_rate`, columns that don't exist on `estimates` (real names:
  `tax_amt_cents`/`tax_pct`) — every estimate-to-invoice conversion had
  silently zeroed tax, pre-existing bug carried forward uncaught by this
  stage's own rewrite of the function. Fixed on the branch (`4ba147d`)
  with an extended `MC3A-01` test asserting real tax carries through
  before the branch was merged. See `docs/PUNCHLIST.md` item 11 for the
  sibling issue in the same function (invoice title/notes field names)
  that was deliberately left out of scope and logged instead.
- Confirmed via `wrangler d1 migrations list --remote`: no pending
  migrations, production D1 schema unchanged by this stage as expected.

## Soak period — in progress, started 2026-08-10
Per the 3-stage plan, Stage 3b (stop dual-writing floats, then drop the
old float columns — irreversible) does not start until real production
usage has run for a few days on this cutover with no issues. This stage
carries a different, quieter failure class than Stages 1/2: a logic bug
here (wrong rounding order, missed aggregate, percentage-calc error)
shows wrong numbers to real users despite the underlying data being
completely fine — nothing here can be caught by comparing float vs.
cents columns, since the whole point is that floats keep being written
correctly and reads simply switch source.

**What to watch for during the soak period:**
- Invoice/estimate totals, balances, and tax amounts that don't match
  what the source estimate/invoice actually specifies.
- Autopay charges and Stripe webhook payment amounts that look off by a
  cent (rounding) or wildly wrong (unit conversion error).
- Recurring subscription pricing (with or without `price_override`)
  landing on an unexpected number.
- Any of the 3 Finance OS UI pages (collections, invoices-payments,
  ledger) showing totals that don't reconcile with the individual rows
  underneath them.

**Do not start Stage 3b until:**
1. Several days of real usage have passed with no discrepancies
   reported.
2. A fresh production backup is taken immediately before Stage 3b's
   migration runs (in addition to D1's own point-in-time recovery).
3. Explicit go-ahead is given — Stage 3b's migration (dropping the old
   float columns) is irreversible.
