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
- `role-map.json` — CRM role string -> Finance OS role. **Inferred**
  (`admin`->owner, `office_manager`/`estimator`->office,
  `foreman`/`field_supervisor`->crew_lead, `laborer`/`mechanic`/
  `view_only`/`rep`->crew) — ambiguous roles default to the MORE
  restrictive option, not confirmed by Tyler.

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
1. **`config/finance/role-map.json`** — confirm the CRM-role mapping before
   trusting real users see the right thing. This is the one piece of new
   work with real information-exposure risk if wrong.
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
