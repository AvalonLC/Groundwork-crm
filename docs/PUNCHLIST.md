# Finance OS — Punch List

Written at the end of Waves 0-4 + partial Wave 5 (2026-08-04). This is the
honest accounting GO-PROMPT.md asked for: what's real, what's inferred, what's
estimated, and exactly what to review before deploying anything. Nothing here
was deployed — `npm run deploy` and `npm run db:migrate:prod` were never run.

## What's actually done and gate-verified
- **Wave 0** (specs), **Wave 1** (schema + repos), **Wave 2** (all 5 engines),
  **Wave 3** (rate API, posting, actions, rollup), **Wave 4** (all 6: roles +
  5 UI pages), **Wave 5 partial** (receipts, equipment capture).
- 18 of 23 original tasks. 96 tests (71 vitest, 25 Playwright e2e against a
  real local D1 + real Chromium), full regression clean, typecheck clean.
- Every formula in the engines was checked against `fixtures/golden.json` to
  the fixture's own stated tolerance — not eyeballed.

## Real gaps — not built, and why
1. **`W5-classifier`** — stages 1-3 need deterministic matching rules
   (vendor patterns, amount thresholds, what's actually in the
   `gw-tenant-history` Vectorize index) that aren't in evidence anywhere in
   this repo. Building it without those rules means guessing at business
   logic I don't have. See `BLOCKED-W5-classifier.md`.
2. **`W5-ingest`** — needs to know the actual P&L source (file format? QBO
   API?) — not specified anywhere. If it's a live QBO connection, that's a
   bigger task than this one's scope implies (OAuth, a new binding/secret).
   See `BLOCKED-W5-ingest.md`.
3. **Nightly rollup has no scheduler.** Cloudflare Pages has no native Cron
   Trigger. `src/cron/rollup.ts` is built and tested but nothing invokes it
   on a schedule. Needs a companion Worker with its own Cron Trigger, or an
   external scheduled caller hitting an authenticated endpoint — undecided.
4. **UI pages aren't mounted into the live app.** They're real, server-
   rendered, and e2e-tested, but only reachable via a standalone dev-only
   Worker (`src/ui/dev-server.ts`) built specifically so Playwright didn't
   need the CRM's real auth/session stack. Wiring them into `src/index.tsx`
   for real, with real navigation and real auth (role/tenant currently come
   from query params — a testing convenience, not a security boundary), is
   unstarted.
5. **Cross-database joins are stubbed at the boundary, not built.**
   `E2-unbilled` and the job-costing page's "hours vs estimate" both need
   data that lives in the CRM's own `DB` (invoices/receivables, job
   estimates) — Finance OS never got visibility into that schema, so both
   take pre-joined data as a plain input rather than querying the CRM DB
   themselves. Whoever wires these up for real needs to write that query.

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
- **The 20% materiality threshold** in equipment meter reconciliation
  (`src/ai/equip-capture.ts`) is my own default, not a number Tyler gave me.
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
4. **Answer the two BLOCKED items** (classifier rules, P&L source) before
   anyone attempts `W5-classifier`/`W5-ingest`.
5. **Never run `npm run deploy` or `npm run db:migrate:prod` from an
   agent session** — both remain human-only, enforced by
   `.githooks/pre-push`, unchanged from day one of this build.
6. Local commit identity in this repo is auto-derived
   (`tylerjohnson@mac.mynetworksettings.com`) — worth setting explicitly
   if these commits are going to be pushed anywhere shared.
