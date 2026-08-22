# Finance OS — Punch List

Written 2026-08-04, updated 2026-08-05 four times more (config-driven
classifier/ingest; live mounting + admin config UI + cron scaffolding;
scheduling finalized + verification tooling + guardrails; Groundwork-wide
platform defaults confirmed generic, not Avalon-specific). Honest
accounting of what's real, what's inferred, what's estimated, and exactly
what to review before deploying anything. **Nothing here was deployed** —
`npm run deploy` and `npm run db:migrate:prod` were never run, and no
`CRON_SECRET` was ever set, so the cron endpoint fails closed by default.

## What's actually done and gate-verified
All 23 original tasks (waves 0-5) plus a config layer, live-mounting, and
finalized scheduling beyond the original scope. 173 tests (140 vitest, 33
Playwright e2e against a real local D1 + real Chromium), typecheck clean,
real `vite build` succeeds (101 modules), preflight green. Every formula
in the engines is checked against `fixtures/golden.json` to its own stated
tolerance.

**Platform-default vs. tenant-override, confirmed:** a repo-wide audit found
zero hardcoded references to any specific tenant/company anywhere in the
Finance OS layer (config, code, or docs). `config/finance/*.json` are the
Groundwork-wide defaults; `/finance/config` edits only ever write to the
logged-in tenant's own DB-backed override (`finance_config_override`,
scoped by `tenant_id`) — there is no UI path for one tenant's edit to
change the platform default or another tenant's view, verified directly by
`UC-09` in `src/ui/config-admin.e2e.ts`.

**Live in the app now, behind real auth:** `/finance/money-loop`,
`/recovery`, `/budget`, `/queue`, `/job-costing`, `/config` (admin config
editor) — all gated by `requireAuth` + role mapped from the real CRM
session via `config/finance/role-map.json`. `/internal/rates`,
`/internal/actions`, `/internal/cron/rollup` are also mounted.

## Config-driven now (edit JSON — via the admin UI or the file directly)
Seven config files, each with a live admin editor at `/finance/config`
(owner-only) backed by `finance_config_override` — edits take effect
immediately, no deploy, and Reset reverts to the version-controlled default:
- `classifier.rules.json` — vendor patterns, keyword rules, forced-review
  categories, confidence thresholds. Seeded with 18 generic
  contractor/landscaping/service-business starter categories (fuel,
  materials, equipment rental, vehicle maintenance, office supplies,
  telecom, software subscriptions, payroll, insurance, bank fees, owner
  draw, subcontractor labor, utilities, rent, professional services,
  marketing, permits/licenses, uniforms/safety) — every one still marked
  `"placeholder": true`, and deliberately none resolve at "high"
  confidence except the two pre-existing examples, so nothing new
  auto-resolves without real data confirming it (`CL-10` in
  `src/ai/classify.test.ts` enforces this as a test, not just a
  convention).
- `ingest.sources.json` — 5 file-format detectors. Reasonable guesses,
  unconfirmed against a real Groundwork export.
- `division-map.json` — canonical divisions + aliases.
- `approval-thresholds.json` — materiality/variance/SLA thresholds
  (previously hardcoded in engine code; now actually wired through, not
  just present in a file nobody read).
- `automation-policy.json` — every automation's on/off switch.
- `tenant-defaults.json` — new-tenant policy seed values.
- `role-map.json` — CRM role string -> Finance OS role. `rep`->crew is
  **confirmed by Tyler** (2026-08-06, reviewed against Avalon's real role
  distribution — kept restrictive, no margin/wage/rate visibility for the
  customer-facing sales role). The rest (`admin`->owner,
  `office_manager`/`estimator`->office, `foreman`/`field_supervisor`
  ->crew_lead, `laborer`/`mechanic`/`view_only`->crew) is still
  **inferred**, not individually confirmed — Tyler reviewed the full
  table and had no changes, but those rows weren't checked against real
  headcount the way `rep` was.

## Real gaps — not built, and why
0. ~~**Stripe customers are created on the PLATFORM account but charged on the
   CONNECTED account.**~~ — **FIXED** 2026-08-20. Migration 0080 records which
   account each customer and saved card belongs to; a mismatch is treated as
   "no customer" and a fresh one is created on the right account, leaving the
   old row intact. The charge model is now DIRECT everywhere — no
   `transfer_data[destination]` survives in `src/`.

   ~~OUTSTANDING: re-collection has no UI prompt.~~ — **DONE** 2026-08-20.
   `GET /api/portal/autopay` returns `needs_card_reauth` with a plain-language
   message, and `GET /api/stripe/cards-needing-reauth` gives the company the
   list of affected clients so they can chase. A saved card still cannot follow
   its customer between Stripe accounts — that is Stripe's model — but nobody
   now finds out by having an invoice quietly stop auto-paying.

   Original note follows.

   **Stripe customers are created on the PLATFORM account but charged on the
   CONNECTED account.** `src/portal.tsx` creates `/v1/customers` with no
   `Stripe-Account` header, so `clients.stripe_customer_id` is a platform
   customer — while `chargeSavedPM` (same file) and
   `POST /api/invoices/:id/charge` send `Stripe-Account`. A platform customer id
   does not exist on the connected account, so every saved-card charge fails
   with "No such customer".

   Found 2026-08-20 during the Connect audit. NOT fixed in that change: moving
   customers to connected accounts invalidates every stored
   `stripe_customer_id`, so it needs a migration and a re-collection path for
   saved cards, not an added header.

   Related: the charge model is split. Portal pay, payment link and portal
   deposit are DIRECT charges (company is merchant of record); invoice autopay
   and `/api/invoices/:id/charge` are DESTINATION charges (Groundwork is).
   Unifying on direct is approved but blocked behind this same customer
   migration.

1. **Classifier/ingest rules are still placeholders**, not confirmed
   business logic. Now a config edit (via `/finance/config` or the JSON
   files directly), not a code-writing task — see
   `BLOCKED-W5-classifier.md` / `BLOCKED-W5-ingest.md`.
2. ~~**`CRON_SECRET` is set on BOTH sides and they do not match**~~ — **FIXED
   2026-08-19 22:45 UTC.** Tyler reset both sides to one value; a
   `workflow_dispatch` dry run returned **200**. Seven consecutive 401s
   before it, one of them dispatched on demand rather than on schedule, so
   it was never a scheduling artefact.

   OUTSTANDING: six nights of `recovery_snapshot` rows were never written
   (2026-08-14 to 2026-08-19). The rollup takes `?as_of=YYYY-MM-DD` and is
   idempotent per date, so a backfill is six dispatches. Whether that matters
   depends on `confidence_days`, which needs trailing snapshot variance and
   has none yet either way.

   This entry has now been wrong in BOTH directions inside 24 hours — first
   claiming the secret was unset when it was set-but-mismatched, then
   claiming a mismatch after it was fixed. That is the argument for the
   dated audit header above rather than for trusting any line in this file.

   The original entry said the secret "isn't set yet". That was wrong, and
   wrong in a way that hid something worse: it is set, the cron IS firing
   daily at 07:00 UTC, and every run returns 401.

   Evidence (2026-08-19):
   - `GET /internal/cron/rollup/status` on production -> `{"cron_secret_configured":true}`
   - Cloudflare Pages -> Production has `CRON_SECRET` as an encrypted secret
   - `.github/workflows/finance-cron.yml` sends `secrets.CRON_SECRET`
   - four consecutive runs: 401 `{"error":"unauthorized"}`

   The guard in `src/api/cron-trigger.ts` returns 503 when no secret is
   configured and 401 only on a mismatch, so 401 proves both sides hold a
   value and the values differ.

   FIX: generate one value and set it in both places, then redeploy Pages
   (Workers read env at deploy time) and re-run the workflow.

   Worth recording why this went unnoticed: the entry said "not set yet",
   so nobody looked at the run history — a failing job and an unconfigured
   one look identical from a punchlist. I repeated the stale line to Tyler
   twice as fact before checking the config. Original note follows.

   **`CRON_SECRET` isn't set yet.** Scheduling is decided (GitHub Actions,
   `.github/workflows/finance-cron.yml`) and everything is built and
   tested, including a pre-auth status check
   (`GET /internal/cron/rollup/status`) and a dry-run mode
   (`?dry_run=true`) for verifying without writing. Full setup steps:
   `docs/RUNBOOK-finance-cron.md`. The rejected companion-Worker option is
   kept as a documented, unused alternative in `workers/finance-cron/`.

   **RESOLVED — drift-recurrence monitoring added:** the four-night 401
   outage above was fixed on the day (2026-08-19) but nothing at the time
   would have caught a repeat. Two independent signals now exist: (a) a
   `finance-cron.yml` step that opens/updates a GitHub issue automatically
   on a scheduled (never manual) run failure, using the workflow's own
   default `GITHUB_TOKEN` — no new secret; (b) an in-app "Last updated
   <date>" note on Money Loop's recovery hero that turns into a visible
   amber warning once the latest `recovery_snapshot.as_of` is more than a
   day old. See `docs/RUNBOOK-finance-cron.md`'s "How you find out a run
   failed, without watching the Actions tab" section for the full
   description, and `src/ui/money-loop.e2e.ts` (`UM-08`, `UM-09`) for
   coverage of the UI half.
3. ~~**Cross-database joins are stubbed at the boundary, not built.**~~
   **RESOLVED for `E2-unbilled` (2026-08-21):** since Finance OS and CRM tables now
   share one D1 database (`migrations/0057_finance_merge.sql`), the unbilled-work
   detector's invoice join is implemented in `src/db/repos.ts`'s
   `listBilledWorkOrderIds()` and wired into the nightly rollup via
   `src/cron/unbilled-sweep.ts` — see `docs/spec/UNBILLED.md` for the full join
   description and `src/cron/unbilled-sweep.test.ts` for coverage.
   Job-costing's "hours vs estimate" half of this item remains **unresolved** —
   still a separate, not-yet-scoped gap.
4. **Live QuickBooks API integration** (vs. file upload) remains out of
   scope — would need OAuth, a new binding/secret, rate-limit handling.
5. **`gather-inputs.ts`'s rollup-input derivations are inferred proxies**
   (recovered_to_date from posted overhead ledger lines, budgeted/absorbed
   from weekly allocation shares) — reasonable, not confirmed formulas.
6. **Receipt upload (`/finance/upload`) has no AI/OCR extraction.**
   `processReceiptUpload` (`src/ai/receipts.ts`) takes an injected `extract`
   callback by design; the UI built for it (2026-08-06) passes through
   whatever the uploader types for vendor/amount/date rather than reading
   them off the image. This is a real gap, not a permanent design choice —
   deferred because it needs a real model choice + prompt design, would
   incur actual Workers AI usage cost, and there was no real receipt image
   to verify accuracy against. The rest of the pipeline (hash dedupe, R2
   storage, confidence scoring, review routing) is real and works today
   regardless of what fills in `extract`.
7. ~~**`GET /api/work-orders`'s `?rep_id=` filter references a column that
   doesn't exist.**~~ **FIXED 2026-08-13** (scheduling Phase 0). The entry
   below understated it: this was not a latent trap waiting for a first
   caller, it was firing on every page load. `public/js/app_premium.js` sets
   `?rep_id=` for foreman, laborer and field_supervisor, so **the schedule
   board had been returning 500 to the entire field crew** while working
   normally for anyone in the office — which is why it went unnoticed.

   Resolved by dropping the `assigned_rep_id` branch, per the second of the
   two options below. A rep is on a job three ways and all three are real:
   `work_order_employees` (the job list), `wo_day_employees` (a specific day —
   someone added to Thursday only), or `crew_members` (the crew running it).
   No single "assigned rep" column could have expressed the middle case.
   Covered by `src/scheduling/field-scoping.test.ts` (FS-01…FS-07); six of the
   seven fail against the previous code with the production error.

   <details><summary>original entry</summary>

   `src/index.tsx` (search `assigned_rep_id`) builds
   `... AND (wo.assigned_rep_id = ? OR ...)` when `rep_id` is passed as a
   query param, but no migration ever adds `assigned_rep_id` to
   `work_orders` — only `crew_id` and the `work_order_employees` join table
   exist. Any caller passing `?rep_id=` will get a SQL error
   (`no such column: wo.assigned_rep_id`) instead of results. Found while
   researching the CRM→Finance OS write-through connectors (2026-08-07);
   marked with a `TODO(bug)` at the call site but not fixed there — needs a
   real decision (add the column and a writer for it, or drop the OR-branch
   in favor of the existing `work_order_employees` join) rather than a
   drive-by patch.
   </details>
8. ~~**There is no way, anywhere in the product, to create a `labor_rate_profile`
   row.**~~ — **FIXED** on `labor-rate-entry`: `/finance/budget` now carries a
   create/recalibrate form (owner-only) that writes through
   `recalibrateLaborRate`, so the prior row is closed rather than edited.
   Verified end to end: a rate entered through the form resolves at
   `/internal/rates/resolve` as `421002` with `confidence: high`. Original
   note follows.

   **There is no way, anywhere in the product, to create a `labor_rate_profile`
   row.** `/finance/budget` (`src/ui/budget.tsx`) is read-only — three review
   tables, no form, no POST route. `insertLaborRateProfile` (`src/db/repos.ts`)
   is called from exactly two places in the whole repo, both test files
   (`src/api/rates.test.ts`, `src/api/posting.test.ts`) — never from a real
   route. This is stronger than "Specs I derived" item 4 below ("built as a
   plain review page instead of a wizard") lets on: it's not that the entry
   flow is a simpler shape than planned, it's that no entry flow exists at
   all. Until one is built (or rows are inserted directly), job costing and
   overhead recovery cannot produce a real number for any tenant — confirmed
   while investigating why `postTimeEntryToLedger` was hitting
   `no_rate_resolves` in production (2026-08-09).
9. ~~**The Stripe webhook's payments-table insert references two columns
   that don't exist.**~~ — **FIXED** on `stripe-payments`, along with a
   worse defect it was hiding: because the invoice UPDATE ran before the
   throw and Stripe retries a 400, every retry credited the invoice again.
   Three deliveries of one $500 payment left `amount_paid_cents` at 150000
   with zero payments rows. The handler is now idempotent on the payment
   intent. Original note follows.

   **The Stripe webhook's payments-table insert references two columns
   that don't exist.** `src/index.tsx`, `checkout.session.completed`
   handler (search `INSERT OR IGNORE INTO payments`) writes `method` and
   `paid_at` — the real columns are `payment_method` (no `paid_at` at all).
   `INSERT OR IGNORE` only suppresses constraint violations, not "no such
   column" errors, so this throws every time the webhook fires with a
   valid invoice, propagating out as a 400 from the handler's own
   try/catch. Found while dual-writing `*_cents` columns onto this same
   statement for Stage 2 of the money-representation migration
   (2026-08-10); not fixed here — unrelated to that task, and the
   `amount_cents` column was still added alongside the existing `amount`
   so the statement is at least no more broken than it already was.
10. **`POST/PUT /api/recurring-subscriptions` wrote to `price_override`,
    which isn't a real column** on `client_plan_subscriptions` (the real
    one is `custom_price`) — every create/update of a subscription's
    price override has always failed with a SQL error. Unlike item 9,
    this one WAS fixed (both call sites now write `custom_price`), because
    Stage 2 of the money-representation migration (2026-08-10) needed a
    real `custom_price` write to dual-write `custom_price_cents`
    alongside — there was no working write to leave alone.
11. ~~**`POST /api/invoices/from-estimate/:estimateId` builds its invoice
    title from two `estimates` columns that don't exist.**~~ — **FIXED**
    2026-08-19. `est.estimate_number` -> `est.est_number` (with a literal
    fallback, so an untitled estimate can no longer produce the customer-
    facing string "Invoice for undefined" — measured on the old code), and
    `est.notes` -> `est.customer_notes`. Deliberately NOT internal_notes:
    only the customer-facing note belongs on an invoice. Original follows.

11. **`POST /api/invoices/from-estimate/:estimateId` builds its invoice
    title from two `estimates` columns that don't exist.** `src/index.tsx`
    (search `Invoice for ${est.title`) reads `est.notes` (real columns are
    `internal_notes`/`customer_notes`) and `est.estimate_number` (real
    column is `est_number`) — both always silently resolve to `undefined`/
    `''`, so the fallback title text and the notes field on the resulting
    invoice are quietly blank instead of carrying the estimate's real
    number/notes. Non-crashing, not money-affecting (unlike the sibling
    bug below, which was in the same function and got fixed), just a
    cosmetic data-loss gap. Found while independently re-verifying the
    rest of this function during the Stage 3a review that fixed item
    below (2026-08-10); flagged as out of scope for that fix and logged
    here instead, same treatment as item 9.
    - **Sibling bug in the same function, already fixed on
      `stage-3a-cents-cutover` (commit `4ba147d`) before merge to `main`:**
      the same handler read `est.tax_amount`/`est.tax_amount_cents`/
      `est.tax_rate`, none of which exist on `estimates` (real columns:
      `tax_amt`/`tax_amt_cents`/`tax_pct`) — every estimate-to-invoice
      conversion had always silently written `tax_amount = 0` and
      `tax_rate = 0` regardless of the estimate's real tax, a genuine
      revenue-affecting bug, pre-dating Stage 2/3a and merely carried
      forward uncaught by Stage 3a's cents-cutover rewrite of this exact
      function. Caught during independent review of that branch, fixed
      on the branch itself (field names corrected, `MC3A-01` extended
      with a real-tax scenario + float-corruption + tax-field
      assertions) before merge — this half was NOT deferred, unlike the
      title/notes issue above.

## Specs I derived rather than were given (confidence noted)
Every file in `docs/spec/` ends with its own "Derivation confidence"
section. Highest-risk guesses, ranked:
1. **`role-map.json`** (new) — the CRM-role -> Finance-role mapping this
   whole live-auth wiring depends on. Wrong here means wrong visibility
   for real users, not a cosmetic issue.
2. **Three of the four Finance OS roles** (`crew_lead`, `office`, `owner`)
   — only `crew`'s restrictions are in CLAUDE.md (`docs/spec/ROLES.md`).
3. **The entire simple-mode vocabulary map** (`docs/dictionary.json`) —
   first draft, no copy/voice reference existed anywhere.
4. **The 6-step Budget & Rates wizard** — built as a plain review page
   instead of guessing at wizard steps with zero evidence.
5. **Per-division recovery dates don't exist** — the engine is
   tenant-level only; the UI says so rather than fabricating a breakdown.

## Numbers that are estimates, not verified figures
- **`confidence_days`** — a caller-supplied input, not computed (needs
  trailing `recovery_snapshot` variance that won't exist until the rollup
  has actually run for weeks). Config default: `approval-thresholds.json`.
- **The 20% equipment materiality threshold** — now genuinely wired to
  `approval-thresholds.json` (verified: `equip-capture.ts` reads it, not
  just present in the file — this was a real gap in the previous version
  of this punchlist, since fixed).
- Every dollar figure inside the engines themselves IS a verified figure —
  this list is only what sits outside that fixture-verified core.

## Bugs found and fixed while building this pass (not hidden, not left)
- `equip-capture.ts` had a hardcoded `0.20` local constant despite an
  earlier version of this punchlist already claiming it read from config —
  it didn't. Fixed and verified.
- `detectSource` (ingest) matched the first source whose headers were a
  *subset* match, so a class/division P&L file matched the plain P&L
  export first. Fixed to prefer the most specific match.
- `config-admin.tsx`'s form actions were hardcoded to `/finance/config/...`
  — 404'd against the dev-server's actual `/config` mount. Fixed to derive
  the base path from the real request path.
- `computeRecoveryProjection` threw `RangeError: Invalid time value` on a
  tenant with zero weekly recovery (division by zero -> Infinity -> Invalid
  Date) — found while testing the cron-trigger endpoint against a
  zero-activity tenant, a real state new tenants start in. Fixed with an
  explicit `indeterminate_reason` instead of crashing.
- A local `/test/reset` endpoint originally wiped ALL tenants globally,
  racing against parallel Playwright workers seeding different tenants.
  Scoped to `tenant_id`.

## Guardrails added this pass
- `scripts/validate-finance-config.js` (`npm run validate:finance-config`,
  also wired into `npm run preflight` and CI) — catches a broken hand-edit
  to any `config/finance/*.json` file before it ships, using the same
  structural checks the admin UI already enforces on save.
- `config/finance/README.md` — what each config file controls and whether
  it's safe to leave untouched (all but `role-map.json` degrade safely).

## What Tyler needs to review before trusting any of this live
1. ~~**`config/finance/role-map.json`**~~ — reviewed and confirmed 2026-08-06.
   `rep`->crew checked against real headcount and kept; the rest of the
   table reviewed and approved as-is, no changes.
2. **`docs/spec/ROLES.md` and `docs/dictionary.json`** — same category,
   pre-existing guesses that now actually matter since pages are live.
3. **Edit `classifier.rules.json` / `ingest.sources.json`** (via
   `/finance/config` or the file directly) with real vendor/keyword data
   and a real export's header row.
4. **Set `CRON_SECRET`** in GitHub Actions (repo secret) and Cloudflare
   Pages (`wrangler pages secret put`) — exact steps in
   `docs/RUNBOOK-finance-cron.md`. Scheduling itself is already decided
   and built.
5. **Never run `npm run deploy` / `npm run db:migrate:prod` from an agent
   session** — human-only, enforced by `.githooks/pre-push`, unchanged.
6. Local commit identity in this repo is auto-derived
   (`tylerjohnson@mac.mynetworksettings.com`) — worth setting explicitly
   before pushing anywhere shared.
7. ~~**`package.json`'s `dev:local` script passes a `--d1=DB` flag to
   `wrangler pages dev` that silently binds to an empty, disconnected
   local D1 instead of the configured `avalon-sales-hub-production`
   database**~~ — **FIXED** on `schedule-workstation`: the `--d1=DB`
   override is gone, so the binding resolves from `wrangler.jsonc` and
   reaches the same local D1 that `npm run db:migrate:local` migrates.

   Originally found while building the finance-spa-integration branch's
   real-browser test (`docs/STAGE-FINANCE-SPA-INTEGRATION-STATUS.md` has
   the full repro) and left unfixed as out of scope; hit again while
   verifying the equipment-booking endpoints, which is what finally paid
   for fixing it. Note the entry used to name `preview` as well — that
   script never carried the flag, so only `dev:local` was ever affected.
8. ~~**`config-admin.tsx`'s config-JSON textarea is double HTML-escaped**~~
   — **FIXED** 2026-08-19. The local `escapeHtml()` is gone; Hono JSX
   already escapes a `{expression}` child, and escaping first produced
   `&amp;quot;` where the browser needed `&quot;`. Guarded by UC-08 and
   UC-09, both verified to fail on the pre-fix code. The note below was
   right that the existing suite never tripped it: every other test
   `.fill()`s the editor before reading it, so none of them ever looked at
   what was rendered INTO it. Original follows.

8. **`config-admin.tsx`'s config-JSON textarea is double HTML-escaped**
   (its own `escapeHtml()` plus Hono JSX's default escaping of the
   `{expression}` child) — reading the textarea's live value back in a
   real browser and resubmitting it verbatim fails `JSON.parse`. Found by
   the same branch's new test; not fixed there (out of scope). See that
   status doc for the repro and why the existing `config-admin.e2e.ts`
   suite never trips it.
