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
1. **Classifier/ingest rules are still placeholders**, not confirmed
   business logic. Now a config edit (via `/finance/config` or the JSON
   files directly), not a code-writing task — see
   `BLOCKED-W5-classifier.md` / `BLOCKED-W5-ingest.md`.
2. **`CRON_SECRET` isn't set yet.** Scheduling is decided (GitHub Actions,
   `.github/workflows/finance-cron.yml`) and everything is built and
   tested, including a pre-auth status check
   (`GET /internal/cron/rollup/status`) and a dry-run mode
   (`?dry_run=true`) for verifying without writing. Full setup steps:
   `docs/RUNBOOK-finance-cron.md`. The rejected companion-Worker option is
   kept as a documented, unused alternative in `workers/finance-cron/`.
3. **Cross-database joins are stubbed at the boundary, not built.**
   `E2-unbilled` and job-costing's "hours vs estimate" both need data that
   lives in the CRM's own `DB` (invoices/receivables, job estimates) —
   Finance OS never got visibility into that schema, so both take
   pre-joined data as a plain input.
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
7. **`GET /api/work-orders`'s `?rep_id=` filter references a column that
   doesn't exist.** `src/index.tsx` (search `assigned_rep_id`) builds
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
8. **There is no way, anywhere in the product, to create a `labor_rate_profile`
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
9. **The Stripe webhook's payments-table insert references two columns
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
7. **`package.json`'s `dev:local`/`preview` scripts pass a `--d1=DB` flag
   to `wrangler pages dev` that silently binds to an empty, disconnected
   local D1 instead of the configured `avalon-sales-hub-production`
   database** — found while building the finance-spa-integration branch's
   real-browser test (`docs/STAGE-FINANCE-SPA-INTEGRATION-STATUS.md` has
   the full repro). Local dev via these scripts currently can't log in
   against a migrated local D1 at all. Not fixed here (out of scope for
   that branch) — dropping the `--d1=DB` override fixes it.
8. **`config-admin.tsx`'s config-JSON textarea is double HTML-escaped**
   (its own `escapeHtml()` plus Hono JSX's default escaping of the
   `{expression}` child) — reading the textarea's live value back in a
   real browser and resubmitting it verbatim fails `JSON.parse`. Found by
   the same branch's new test; not fixed there (out of scope). See that
   status doc for the repro and why the existing `config-admin.e2e.ts`
   suite never trips it.
