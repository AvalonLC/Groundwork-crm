# Finance OS — Punch List

Written at the end of Waves 0-4 + Wave 5 (2026-08-04, updated same day after
moving classifier/ingest to a config-driven design). This is the honest
accounting GO-PROMPT.md asked for: what's real, what's inferred, what's
estimated, and exactly what to review before deploying anything. Nothing here
was deployed — `npm run deploy` and `npm run db:migrate:prod` were never run.

## What's actually done and gate-verified
- **Wave 0** (specs), **Wave 1** (schema + repos), **Wave 2** (all 5 engines),
  **Wave 3** (rate API, posting, actions, rollup), **Wave 4** (all 6: roles +
  5 UI pages), **Wave 5** (all 4: receipts, equipment capture, classifier,
  ingest — the last two now config-driven rather than blocked).
- 22 of 23 original tasks (only `W6-harden`'s original scope predates this
  update — regression/README/punchlist were already done once and are
  re-verified clean below). 113 tests (97 vitest, ~25 Playwright e2e against
  a real local D1 + real Chromium — one is a known-flaky parallel-worker
  race in the test infra itself, reproduced clean in isolation, not a code
  regression), typecheck clean.
- Every formula in the engines was checked against `fixtures/golden.json` to
  the fixture's own stated tolerance — not eyeballed.
- **New: `config/finance/*.json`** — six config files
  (`classifier.rules.json`, `ingest.sources.json`, `automation-policy.json`,
  `approval-thresholds.json`, `tenant-defaults.json`, `division-map.json`)
  moved business-tunable decisions out of code. See the "config-driven"
  section below for what that actually changes.

## Config-driven now (edit JSON, not code)
- **Classifier matching rules** (`classifier.rules.json`): vendor patterns,
  memo keywords, forced-review categories, confidence thresholds. Every
  shipped rule is marked `"placeholder": true` — generic examples (Shell/
  Chevron for "fuel", ADP/Gusto for "payroll"), not real Groundwork vendor
  data. The *mechanism* (deterministic-first, AI-fallback-only-after-
  failure, materiality override, never-auto-apply) is built and tested;
  the *rules* still need real business input.
- **Ingest source formats** (`ingest.sources.json`): which CSV header
  shapes map to which ingest target. Five formats configured (QBO P&L,
  class/division P&L, balance sheet, bank/CC CSV, payroll) as reasonable
  guesses at common export shapes — not confirmed against a real
  Groundwork export.
- **Division naming** (`division-map.json`): canonical divisions + aliases,
  used by both ingest and (potentially) future UI work.
- **Thresholds** (`approval-thresholds.json`): the equipment 20% materiality
  variance and recovery `confidence_days` default that were previously
  hardcoded in engine code are now here instead.
- **Feature flags** (`automation-policy.json`): every automation can be
  toggled off, degrading to a review queue rather than silently skipping
  work.

## Real gaps — not built, and why
1. **Nightly rollup has no scheduler.** Cloudflare Pages has no native Cron
   Trigger. `src/cron/rollup.ts` is built and tested but nothing invokes it
   on a schedule. Needs a companion Worker with its own Cron Trigger, or an
   external scheduled caller hitting an authenticated endpoint — undecided.
2. **UI pages aren't mounted into the live app.** They're real, server-
   rendered, and e2e-tested, but only reachable via a standalone dev-only
   Worker (`src/ui/dev-server.ts`) built specifically so Playwright didn't
   need the CRM's real auth/session stack. Wiring them into `src/index.tsx`
   for real, with real navigation and real auth (role/tenant currently come
   from query params — a testing convenience, not a security boundary), is
   unstarted.
3. **Cross-database joins are stubbed at the boundary, not built.**
   `E2-unbilled` and the job-costing page's "hours vs estimate" both need
   data that lives in the CRM's own `DB` (invoices/receivables, job
   estimates) — Finance OS never got visibility into that schema, so both
   take pre-joined data as a plain input rather than querying the CRM DB
   themselves. Whoever wires these up for real needs to write that query.
4. **Classifier/ingest rules are still placeholders**, not confirmed
   business logic — see "Config-driven now" above. This is a config-editing
   task now, not a code-writing one, but it's still unfilled.
5. **Live QuickBooks API integration** (as opposed to file upload) remains
   out of scope entirely — would need OAuth, a new Cloudflare binding/
   secret, and rate-limit handling. Not started, not config-driven either.

## Specs I derived rather than were given (confidence noted)
Every file in `docs/spec/` ends with its own "Derivation confidence"
section — read those before trusting any UI layout or field name over the
actual fixture-verified math. The highest-risk guesses, ranked:
1. **Three of the four user roles** (`crew_lead`, `office`, `owner`) —
   only `crew`'s restrictions are in CLAUDE.md. The other three names and
   their permission boundaries are invented (`docs/spec/ROLES.md`).
2. **The entire simple-mode vocabulary map** (`docs/dictionary.json`) — no
   copy/voice reference exists anywhere; every term mapping is a first draft.
3. **The 6-step Budget & Rates wizard** — I built a plain review page instead
   of guessing at wizard steps with zero evidence behind them
   (`docs/spec/UI-BUDGET.md`).
4. **The "runway hero" on Money Loop** — rendered as the recovery snapshot
   summary; the task title names it, nothing describes its content
   (`docs/spec/UI-MONEYLOOP.md`).
5. **Per-division recovery dates on the Recovery page don't exist** — the
   engine only computes tenant-level projections; the UI says so honestly
   instead of fabricating a breakdown (`docs/spec/UI-RECOVERY.md`).

## Numbers that are estimates, not verified figures
- **`confidence_days`** in every recovery projection is a caller-supplied
  input, not computed — a real confidence window needs trailing variance
  across multiple `recovery_snapshot` rows over time, which don't exist yet
  (one nightly rollup hasn't even run once for real). Don't treat the ±13
  used in tests as anything but a fixture value.
- **The 20% materiality threshold** in equipment meter reconciliation is my
  own default — now in `config/finance/approval-thresholds.json`
  (`equipment_meter_variance_pct`), not a number Tyler gave me, but at least
  a config edit away from being changed.
- Every dollar figure inside the engines themselves (burden rates, equipment
  rates, allocation, recovery) IS a verified figure — checked against
  `fixtures/golden.json` — this list is only what sits outside that
  fixture-verified core.

## What Tyler needs to review before deploying anything
1. **Read `docs/spec/ROLES.md` and `docs/dictionary.json` first** — these
   are guesses that touch every UI page. Wrong role boundaries are a real
   information-exposure risk, not just a copy nit.
2. **Decide the cron mechanism** for the nightly rollup before relying on
   `recovery_snapshot` for anything live.
3. **Decide the UI mounting/auth plan** — query-param role selection is a
   testing convenience that must not ship as-is.
4. **Edit `config/finance/classifier.rules.json` and `ingest.sources.json`**
   with real vendor/keyword rules and a real export file's header row before
   trusting the classifier or ingest to reduce review volume — the
   mechanism works today, the shipped rules are placeholders (see
   `BLOCKED-W5-classifier.md` / `BLOCKED-W5-ingest.md`, both updated to
   reflect this).
5. **Never run `npm run deploy` or `npm run db:migrate:prod` from an
   agent session** — both remain human-only, enforced by
   `.githooks/pre-push`, unchanged from day one of this build.
6. Local commit identity in this repo is auto-derived
   (`tylerjohnson@mac.mynetworksettings.com`) — worth setting explicitly
   if these commits are going to be pushed anywhere shared.
