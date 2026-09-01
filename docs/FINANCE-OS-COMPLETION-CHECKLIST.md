# Finance OS Completion Checklist

**Purpose:** a repository-backed record of what's done, what's outstanding,
and what's been conclusively classified as obsolete — so progress survives
across invocation limits without re-deriving it from scratch each time.
Update this file as each subsequent phase closes, rather than replacing it.

Last updated: 2026-08-31 (autonomous Finance OS continuation session —
full-auto-build mode, user directive: "remove the constraints and go full
auto build mode and complete everything").

**Status as of this update: Phase 2 closed. Phase 6 items 1 and 2 closed.
See §8 for this session's changes and §9 for the current next-action
priority list (supersedes §7 below, which is kept for historical record).**

---

## 1. Baseline (confirmed this session)

- `main == origin/main == fde34d7` at session start, clean working tree.
- PRs #100–#107 (Item 4 Stage 2) all merged. No open PRs.
- PRs #88–#98 (the earlier `docs/FINANCE-OS-FIX-PLAN.md` punch-list, items
  0–7) all merged. See §3 below for the item-by-item mapping.
- No GitHub issues exist in this repo (`gh issue list` returns empty,
  both `--state open` and `--state all`).

## 2. Item 4 Stage 2 (the completed mandate) — status

Fully complete. PR D (#103), PR E (#104), Phase 3 report-only backfill
analysis (#105), Phase 4 docs cross-link (#106), Phase 5 production
runbook (#107). Not re-verified in detail this session (no code changed);
re-verify with the full suite before the next code change that touches
`job_budget_versions`/`job_progress`/`backfill-analysis` paths.

**Update: Phase 2 is now closed** (PR #110, #111 — see §7a below). The
row-creating §10 migration/backfill script (`docs/spec/ITEM4-JOBCOST.md`
§10 steps 1–5) is built, tested, and CLI-wrapped. It has been smoke-tested
against local D1 only; it has never been run with `--remote --apply`
against `avalon-sales-hub-production`, and per the standing hard
constraint, will not be without separate explicit human sign-off.

## 3. `docs/FINANCE-OS-FIX-PLAN.md` items — resolution status

| # | Item | Status | Evidence |
|---|---|---|---|
| 0 | (intro/context) | n/a | — |
| 1a | Ingest: XLSX format for QuickBooks Class P&L | ✅ Done | PR #88 (`src/ai/xlsx.ts`, real Avalon fixture) |
| 1a (fix-plan sub-item) | Ingest diagnostics: make an unrecognized-format failure diagnosable (thread real parsed headers through `IngestResult`, render in UI) | ✅ Done | PR #112 (`detected_headers` field, `describeExpectedCsvFormats`/`unrecognizedCsvReason`/`firstNonEmptyRowPreview` in `src/ai/ingest.ts`, rendered in `src/ui/document-upload.tsx`) |
| 1b (fix-plan sub-item) | Ingest diagnostics: get real export headers from the business owner and extend `config/finance/ingest.sources.json` | ⚠️ **Still open — requires a real file sample from Tyler, out of scope for autonomous execution** | `docs/FINANCE-OS-FIX-PLAN.md` lines 40-100 |
| 2 | Gate raw JSON config editors behind `isSuperAdmin` | ✅ Done | PR #90 (`src/ui/config-admin.tsx`) |
| 3 | Wire unbilled-work detector into nightly rollup cron | ✅ Done | PR #91 (`src/cron/unbilled-sweep.ts`, `src/api/cron-trigger.ts`) |
| 4 | Work-order delete guard (never destroy financial history) | ✅ Done | PR #92 (`workOrderHasPostedFinancialActivity`, 409 gate, archive/unarchive path) |
| 5 | Posted time-entry immutability + adjustment/reversal workflow | ✅ Done | PR #92 (`POST /api/time/entries/:id/adjust`, `time_entry_adjustments` table) |
| 6 | Prevent silent `CRON_SECRET` drift from recurring jobs | ✅ Done | PR #93 |
| 7 | Observability (Cloudflare Workers Logs) | ✅ Done | PR #94 (standing note) + PR #95 (`observability.enabled: true` in `wrangler.jsonc`) |

Only item 1b remains open from this earlier punch-list. It is folded into
Phase 6 below rather than tracked as its own phase.

## 4. WIP branch classification (Phase 1/3 investigation, this session)

Method used for each branch: `git merge-base main <branch>` to find the
fork point, then `git diff <branch-tip> main -- <branch's own touched
files>` to check whether main already contains equivalent-or-superior
content. An empty (or purely-unrelated-file) diff on the branch's own
touched files is treated as full supersession. **No WIP branch was
deleted, reset, rebased, or force-pushed** — every branch listed below
still exists exactly as it did before this session, per the standing
"never destroy WIP without explicit authorization" rule.

| Branch | Verdict | Evidence |
|---|---|---|
| `finance-os-item4-wo-delete-wip` (tip `f902016`) | **Superseded** | Its own commit (read in full via `git show`) documents an unresolved FK-constraint blocker and lists 3 options it hadn't picked between. PR #92 (already on main) implements a strictly more complete solution: 409 block on delete, archive/unarchive path, AND posted-time-entry immutability — none of which the WIP branch had finished. |
| `finance-os-xlsx-ingest` (tip `0e50d4c`) | **Obsolete (stale, not ahead)** | Diff vs. main: branch is missing ~12,486 lines main already has vs. only ~1,811 lines of its own not on main — i.e. the branch is far *behind* main, not ahead of it. Forked before PR #88 independently and completely shipped XLSX ingest. |
| `finance-os-config-admin-gate` (tip `4dc33f1`) | **Superseded** | All 3 files the branch itself touches (`config-admin.tsx`, `config-admin.e2e.ts`, `layout.tsx`) — diffed directly against main — show main already contains equivalent-or-newer content: `isSuperAdmin` gating (PR #90) plus the division-gap banner UI, which this WIP branch was itself in the middle of adding but which is now fully present and tested on main (`getCrewsMissingDivisionWithUnpostedTime`, `division-gap-banner` test ids all confirmed present). |
| `finance-os-queue-actions` (tip `5d18a82`) | **Superseded** | Every function the branch's `src/db/repos.ts` diff introduces (`listBilledWorkOrderIds`, `getCrewsMissingDivisionWithUnpostedTime`, `getDefaultActionOwner`, `insertReversalTimeEntry`, `insertTimeEntryAdjustment`, `getTimeEntryAdjustmentsForEntry`, `getOpenActionItemSourceIds`, `resolveActionItemsBySource`, `getJobCostLedgerLinesForTimeEntry`) confirmed **present verbatim on main** via direct grep. `src/ui/queue.tsx` diffed directly against main returns **empty** (fully superseded). |
| `finance-os-unbilled-cron` (tip `bd4f002`) | **Superseded** | Diff of the branch's own touched files (`unbilled-sweep.ts`, `cron-trigger.ts`, `unbilled-sweep.test.ts`, `docs/spec/UNBILLED.md`, `docs/PUNCHLIST.md`) against main returns empty/equivalent; `src/cron/unbilled-sweep.ts` exists and is wired on main (PR #91). |
| `backup-local-main-finance-os-invoices` | **Stale backup, unrelated to current Finance OS scope** | Its own log shows an Invoices-role-gate feature branch (Steps 2–6) from a much earlier point (merge-base predates 155 files / ~25k lines of since-landed work). Not a Finance-OS-Item-4-Stage-2-relevant WIP; no action needed. |
| `fix/dedupe-script-tags` | Not investigated — not Finance-OS-named, out of scope per mandate. | — |
| `mobile-revamp` | Explicitly excluded per mandate; not investigated. | — |

**Net effect: every Finance-OS-relevant WIP branch's real work has already
landed on `main` through independently-authored commits that either match
or exceed what the WIP branch itself was attempting.** No branch requires
porting, reimplementing, or a new PR. Phase 4 (XLSX ingestion) and Phase 5
(work-order deletion / financial-history protection) of the active mandate
are therefore **already satisfied on main** — see §5 below for the
specific verification each one still needs before being marked fully
closed.

## 5. Phase 4 / Phase 5 (WIP-branch-driven phases) — status

- **Phase 4 (XLSX ingestion):** appears fully done via PR #88. Confirmed:
  `src/ai/xlsx.ts`, `src/ai/xlsx.test.ts`, real Avalon fixture
  (`fixtures/ingest/qbo-class-pnl-wide-avalon.xlsx`), `docs/spec/INGEST.md`
  documents the design. **Not yet individually re-verified against every
  item in the mandate's Phase 4 checklist** (partial-failure policy,
  cross-tenant rejection tests, safe-cancellation, checksum) — likely
  already covered by the existing test suite (`src/ai/xlsx.test.ts`,
  `src/ai/ingest.test.ts`) but this file-by-file cross-check has not been
  done. Low priority given the WIP branch itself was strictly behind main.
- **Phase 5 (work-order deletion):** appears fully done via PR #92.
  Confirmed: `workOrderHasPostedFinancialActivity`, 409 block, archive/
  unarchive routes, `time_entries` posted-immutability + adjustment
  workflow, test suite (`src/money-cents.test.ts`'s FIN4-01..07+ series).
  **Not yet individually cross-checked** against the mandate's specific
  test-matrix line items (duplicate/concurrent-request handling,
  archived/voided reporting behavior specifically) — likely covered but
  unconfirmed line-by-line.

Neither phase requires new implementation on current evidence. Both would
benefit from a short, dedicated verification pass (re-reading the existing
test files against the mandate's exact checklist wording) before being
marked fully closed — this is lower priority than Phase 2's genuinely
missing tool, per the mandate's own priority ordering.

## 6. Phase 6 candidates (production-readiness gaps found so far)

- **✅ Closed:** ingest format-detection diagnostics (fix-plan item 1a).
  See §7a below — PR #112.
- **✅ Closed:** receipt-posting concurrent-duplicate-ledger race. Not
  originally on this list (discovered during Phase 6 verification, not
  predicted in advance) — see §7a below, PR #113. This is the item that
  the "duplicate/concurrent-mutation risk audit beyond what Phase 4/5
  tests already cover" bullet (previously "not yet investigated") was
  pointing at; it has now had one concrete finding, fixed.
- **Checked and found already resolved:** `STRIPE_WEBHOOK_SECRET`,
  `CRON_SECRET`, `STRIPE_CONNECT_WEBHOOK_SECRET` all have handling code
  present (`src/env.ts`, `src/api/stripe_signature.ts`,
  `src/api/cron-trigger.ts`, `docs/RUNBOOK-finance-cron.md`,
  `docs/spec/RECOVERY.md`). Sellable hours / weighted labor rate / target
  margin all implemented in `src/engines/allocation.ts` +
  `src/api/allocation_run.ts` + `docs/spec/ALLOCATION.md`. Receipt
  classification/OCR-adjacent config present in `src/ai/classify.ts`,
  `src/ai/receipts.ts`, `docs/spec/RECEIPTS.md`. QuickBooks integration
  boundary documented in `docs/spec/INGEST.md`/`docs/spec/UNBILLED.md`.
  **None of these appear to need a Tyler decision beyond what's already
  documented** — no further action identified yet, but a config-validation
  pass (missing-env-var startup checks, health-check endpoint coverage)
  has not been done and is still a legitimate Phase 6 candidate.
- **Still open / not yet investigated:** fix-plan item 1b (real QuickBooks
  export headers from Tyler — blocked on a human-provided file sample,
  not autonomously executable), missing route mounts/nav audit,
  config-validation pass (missing-env-var startup checks, health-check
  endpoint coverage), further duplicate/concurrent-mutation risk audit
  beyond the one race just fixed (e.g. invoice/payment posting paths,
  time-entry adjustment paths — not yet swept the same way receipt-posting
  was), stale-doc sweep beyond this checklist itself.

## 7. Next executable action — historical record (superseded by §9)

**This section reflects the plan as of the previous update (2026-08-28),
before Phase 2 and the two Phase 6 items below were completed. Kept
verbatim for historical record; §9 is the current priority list.**

**Priority 1 — Phase 2: build the guarded §10 writing-backfill package.**
This is the single largest remaining piece of real Finance OS work and
ranks above further WIP-branch archaeology per the mandate's own priority
order (reconciling/migrating existing records outranks completing WIP
branches, and the WIP-branch investigation above is now conclusively
finished with no further branch work required).

Concrete shape already researched and ready to implement against:
- `insertJobBudgetVersion(db, row)` (`src/db/repos.ts`) is the existing,
  tested, single-row-INSERT primitive to reuse for each baseline row —
  do not reinvent it.
- `runBackfillAnalysis(db, companyId, asOf)` is the exact pre-mutation
  classification gate to consume: only jobs landing in
  `would_create_needs_review_cost_to_cost` /
  `would_create_needs_review_service_units` are eligible to have a row
  created; every other bucket must be skipped, never mutated.
- Every created row must set `needs_review: 1` (per §10 step 2 — no
  code path in the current classifier produces a legitimate
  `needs_review: 0` baseline row) and `source_type: 'estimate'`,
  `revision_seq: 0`.
- `docs/RUNBOOK-item4-stage2-backfill.md` already specifies the expected
  CLI shape (`scripts/backfill-job-budget-versions.mjs --remote` /
  `--apply`), reconciliation invariants (§7/§8), and rollback strategy
  (§10) — build to match that runbook, then update it with the *actual*
  commands once the script exists (it currently documents them as
  illustrative/not-yet-real).
- Precedent to follow for script structure/safety conventions:
  `scripts/migrate-finance-data.mjs` (dry-run-by-default, `--local`/
  `--remote` explicit, `--apply` explicit, never invoked by CI/agent
  automation per `.githooks/pre-push`'s existing guard rules).
- The two-step manifest workflow (generate → hash/age/tenant/environment/
  count-verify → execute-only-that-manifest) is not yet designed in
  detail; this is the first real design decision for the next session.

**Priority 2 (much smaller, can be done first if a quick win is wanted):**
the item 1b ingest-diagnostics gap in §6 above — small, well-scoped,
no ambiguity, good candidate for a short focused PR before or after
Phase 2.

**Priority 3:** the Phase 4/5 line-by-line checklist cross-check in §5
(verification only, no new code expected).

## 7a. Phase 2 + Phase 6 items 1-2 — closure record (this update)

**Phase 2 (§10 writing-backfill package) — ✅ closed:**
- PR #110: `src/db/backfill-write-repos.ts`'s `generateBackfillManifest`/
  `executeBackfillManifest` — the two-step manifest workflow (generate →
  verify → execute-only-that-manifest) designed and built exactly per the
  runbook's shape. 98 tests (pure-engine + DB-backed).
- PR #111: `scripts/backfill-job-budget-versions.mjs` — the CLI wrapper,
  smoke-tested end-to-end against local D1 (dry run, wildcard-tenant
  refusal, missing-safety-flag refusal). `docs/RUNBOOK-item4-stage2-
  backfill.md` updated to reflect these commands are now real, not
  illustrative. **Never run with `--remote --apply` against
  `avalon-sales-hub-production`** — that step remains explicitly gated on
  separate human sign-off per the standing hard constraint, and nothing
  in this closure changes that.

**Phase 6 item 1 (fix-plan 1a, ingest diagnostics) — ✅ closed:**
- PR #112: `IngestResult.detected_headers` field added to
  `src/ai/ingest.ts`; `describeExpectedCsvFormats()` builds the expected-
  format message dynamically from `config/finance/ingest.sources.json`
  (never hardcoded, can't go stale); `unrecognizedCsvReason()` and
  `firstNonEmptyRowPreview()` cover the CSV and xlsx unrecognized-format
  paths respectively; `src/ui/document-upload.tsx` renders the detected
  headers in the review card. 3 new tests (IG-07/08/09), 18/18 passing in
  `src/ai/ingest.test.ts`.
- Fix-plan item 1b (real QuickBooks export headers, config extension)
  remains explicitly open — it requires a real file sample from Tyler and
  is not something that can be produced autonomously; see §6.

**Phase 6 item 2 (receipt-posting concurrency race) — ✅ closed, not
originally predicted, found during verification:**
- Root cause: `src/api/receipt-posting.ts`'s `postApprovedReceiptToLedger`
  batched an *unconditional* ledger `INSERT` (`postDirectCostLedgerLine-
  Statement`) together with a *guarded* receipt `posted_at` `UPDATE`
  (`markReceiptPostedStatement`) via `db.batch()`. The INSERT itself had
  no write-once guard, so under real concurrency multiple requests'
  INSERTs could land before their UPDATEs were rejected — producing
  duplicate `job_cost_ledger` rows for one receipt. Caught via the
  `PC-11` e2e test (`src/ui/receipt-posting.e2e.ts`) failing intermittently
  in CI on both PR #111 and PR #112's first CI runs (`Received: 5` instead
  of `1`) — this repeated, diff-unrelated CI failure is what escalated it
  from assumed flakiness to a root-caused bug.
- Fix (PR #113): reordered to call the write-once guard
  (`markReceiptPosted`) first as a standalone awaited call; only proceed
  to the ledger insert (`postDirectCostLedgerLine`) if it returns true.
  Mirrors the already-proven-correct `postTimeEntryToLedger` pattern in
  `src/api/posting.ts` exactly. A losing concurrent request now never
  reaches the ledger INSERT — no duplicate row can be created, by
  construction.
- A schema-level fix (unique index on `job_cost_ledger.source_receipt_id`)
  was drafted, then rejected and deleted: `reverseJobCostLedgerLine`
  (`src/db/repos.ts` lines ~1600-1645) legitimately reuses
  `source_receipt_id` for reversal/replacement rows, so a unique
  constraint there would break already-shipped functionality.
- Verified: typecheck clean, full vitest 1033/1033, full Playwright
  147/147 including PC-11 passing on a clean local run, CI gate passed on
  PR #113. A dedicated concurrency stress-test harness (unique per-
  iteration fixture IDs against a standalone dev server) was attempted for
  extra empirical confidence beyond CI, but hit local sandbox port-binding
  instability with backgrounded wrangler processes and was abandoned in
  favor of relying on the structural correctness argument (duplication is
  now impossible by construction, not just less likely) plus CI, which
  had already caught the original bug twice and is the more reliable
  race-detector in this repo's history.

**§9 Priority 2 (further duplicate/concurrent-mutation risk audit) — ✅
closed, PR #115:**
- **Real bug found and fixed:** `POST /api/time/entries/:id/adjust`
  (`src/index.tsx`) only checked `original.posted_at` before calling
  `insertReversalTimeEntry` — nothing marked the original entry as
  "already adjusted," so a SECOND call against the same `:id` (sequential
  double-click/retry, or genuine concurrency — didn't even need real
  concurrency to trigger) posted a second full reversal, silently
  doubling the negative `job_cost_ledger` impact with every repeat call.
  Fix (migration 0087): `time_entries.adjusted_at`, written exactly once
  via `markTimeEntryAdjusted`'s `WHERE adjusted_at IS NULL` guard, checked
  and won BEFORE `insertReversalTimeEntry` — mirrors `markReceiptPosted`'s
  proven-correct order from PR #113 exactly. New regression test FIN5-08.
- **`recalibrateLaborRate`/`recalibrateEquipmentRate`** (`src/db/repos.ts`)
  — batches a guarded `closePrior` UPDATE with an unconditional
  `insertNew` INSERT, the same shape as the receipt-posting bug. Checked
  and downgraded to **low severity, no fix needed**: `getLaborRateAsOf`/
  `getEquipmentRateAsOf` resolve via `ORDER BY effective_from DESC LIMIT
  1`, so a duplicate-open-row race would resolve deterministically at
  lookup time rather than double-count a calculation — qualitatively
  different from the receipt-posting bug's direct duplicate-ledger-row
  money-doubling. Both write routes (`src/ui/budget.tsx`'s `/labor-rate`
  and `/equipment-rate`) are also owner-only (`can_see_budget_rates`),
  a single-privileged-actor context that meaningfully reduces real-world
  concurrency likelihood versus a multi-user-driven race. `listCurrentLaborRates`
  (no `LIMIT 1`, used by `budget.tsx`'s read-only display) would show a
  transient duplicate row if this ever raced, but that's a display
  artifact on an owner-only screen, not a financial miscalculation.
- **`src/api/rates.ts`'s `POST /internal/rates/profile`** — a third,
  separate code path writing `labor_rate_profile` with its own explicit
  pre-check-then-batch logic. Same TOCTOU shape and same mitigation as
  above (protected by `getLaborRateAsOf`'s `ORDER BY ... LIMIT 1`, and
  gated by `canViewCompensation`, again a narrow-privilege gate). No fix
  needed for the same reasons.
- **`reverseJobCostLedgerLine`** (`src/db/repos.ts`) — batches its
  reversal + optional replacement INSERTs atomically, but writes the
  `job_cost_ledger_adjustments` audit-trail row in a separate, non-batched
  statement AFTER the batch, a narrower gap than its own doc comment's
  atomicity claim covers. Grepped for callers across the entire route
  layer (`src/**/*.ts`, `src/**/*.tsx`, excluding tests) and found none —
  it is only referenced from its own unit tests
  (`src/db/job-progress-repos.test.ts`) and doc comments
  (`docs/spec/ITEM4-JOBCOST.md`, this checklist's own §7a). **Unwired/dead
  code today, not a live production risk.** No fix needed; flagged here so
  a future caller-wiring effort knows to batch the audit-trail INSERT in
  too, or accept the same narrower gap PR #113's schema-level unique-index
  fix was explicitly rejected to avoid re-breaking (see §7a above).
- **`approveChangeOrderAndCreateBudgetVersion`** — already confirmed safe
  in a prior session (uses the correct `WHERE changes() > 0` same-batch
  guard pattern, structurally different from the anti-pattern being
  audited for).
- **Scoping note:** this audit stayed within Finance-OS-prefixed code
  (time entries, rates, receipts, change orders, job cost ledger).
  General-CRM `db.batch(` call sites (scheduling, marketing, recurring,
  portal) were not swept — out of scope for this mandate, which is
  specifically about Finance OS.

**§9 Priority 3 (config-validation pass) — ✅ closed, PR #117:**
- **"Missing-env-var startup checks" half — investigated, no fix needed.**
  Surveyed the full secret/config surface: `CRON_SECRET`,
  `STRIPE_SECRET_KEY` (and `STRIPE_WEBHOOK_SECRET`/
  `STRIPE_CONNECT_WEBHOOK_SECRET`), `SENDGRID_API_KEY` (and
  `SENDGRID_WEBHOOK_PUBLIC_KEY`), `OPENAI_API_KEY`/`OPENAI_BASE_URL`, and
  `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`. Every one already has
  defensive, graceful per-call-site truthiness checking — a 400/503
  response, never an unhandled crash — at every call site (Stripe checks
  in `src/index.tsx`'s invoice/payment-method/charge routes; the 4-tier
  `_aiCreds` OpenAI key resolution cascade with 10+ downstream call sites
  all handling a missing key gracefully; the Google OAuth
  DB-setting-then-env-fallback cascade; `CRON_SECRET`'s fail-closed 503 in
  `src/api/cron-trigger.ts`). Cloudflare Workers have no traditional
  process "startup" phase to hook a check into — per-call-site graceful
  degradation is the correct idiom here, not a gap. No fix needed.
- **"Health-check endpoint coverage" half — real, narrow gap, fixed.**
  Several per-integration status endpoints already existed
  (`GET /api/google/status`, `GET /api/sms/status`, `GET /api/email/status`,
  `GET /api/stripe/status`, all in `src/index.tsx`) — but every one of
  them requires `requireAuth` (a session + company context). There was no
  unauthenticated route an ops engineer or an external uptime monitor
  could hit to confirm platform secrets actually landed after a deploy,
  without logging in first. `src/api/cron-trigger.ts`'s pre-auth
  `GET /rollup/status` already proved the safe pattern for this
  (`cron_secret_configured` — a boolean, never the secret value, safe to
  expose without auth). Fix: extended the already-public
  `GET /api/status` (`src/index.tsx`) with a `config` block reporting
  `cron_secret_configured`, `stripe_configured`, `sendgrid_configured`,
  `openai_configured`, `google_oauth_configured` — booleans only, mirroring
  `/rollup/status`'s proven-safe pattern exactly. New test file
  `src/status.test.ts` (ST-01..ST-04): no-auth 200, base fields unchanged,
  config block is booleans only (with an explicit assertion that no raw
  secret value ever appears anywhere in the response JSON), and
  `google_oauth_configured` requires BOTH client id and secret set, not
  either alone.

**§9 Priority 4 (missing route-mount/nav audit) — ✅ closed, PR #119:**
Swept every mounted finance UI route in `src/ui/mount.ts` for
discoverability. Found one real orphan: **`/post-receipts`**
(`src/ui/receipt-posting.tsx`) — a real, fully-tested page (PC-01..PC-11
e2e coverage) mounted in `mount.ts`, but with no link anywhere in the
finance UI; reachable only by typing the URL directly. Every other
mounted route checked out clean: either in the top tab-strip
(`FINANCE_NAV` in `src/ui/layout.tsx`) or reachable via an existing
related-pages link (Reconciliation/Forecast under Money Loop,
Collections/Obligations under Work Queue, change-orders drill-through
from Job Costing, policy/upload/onboarding from Config). Fix: added a
related-pages link on Documents — the page `receipt-posting.tsx` already
marks itself active under (`active="finDocuments"`) — mirroring the
existing Money Loop/Work Queue related-pages link pattern exactly. Same
`can_manage_receipts` auth gate as the rest of Documents, so no new
authorization surface: crew/crew_lead get 403 before ever reaching the
page that would show the link. New tests UFN-07/UFN-08 in
`src/ui/finance-nav.e2e.ts`.

## 8. Session log — 2026-08-31 (this update)

User instruction (verbatim): "remove the conststraints and go full auto
build mode and complete everything. i need this done and to move on to
other builds." Interpreted as: stop pausing for permission on ordinary
engineering decisions (builds, tests, merges, which Phase 6 item to pick
next); the one hard constraint kept in force regardless is: never run a
live production migration/backfill/secret rotation/financial-data mutation
against `avalon-sales-hub-production` without separate explicit human
sign-off (the one mistake category that can't be git-reverted).

Work done this session, in order:
1. Completed Phase 2's final commit→push→PR→CI→merge→sync cycle (PR #111,
   merged). Phase 2 fully closed.
2. Built and shipped Phase 6 item 1 (ingest-diagnostics, PR #112, merged).
3. While running the full verification gauntlet on PR #112, discovered
   PC-11 had failed CI a second time on a diff with zero relation to
   receipt-posting code — escalated from "retrigger, assume flaky" to
   "investigate as a real bug." Root-caused, fixed, verified, and shipped
   the receipt-posting concurrency race (PR #113, merged). This was not
   predicted by the original Phase 6 gap list in §6 — it was found by
   the verification process itself, which is exactly the kind of finding
   full-auto mode is meant to surface and close without waiting for a
   permission checkpoint.
4. Updated this checklist (§6/§7a/§8/§9) to reflect current state.

`main` is at `b90481f` (PRs #111, #112, #113 all merged, in that order).
Working tree clean. No WIP branch was touched, merged, or deleted.

## 9. Next executable action (current priority list, supersedes §7)

**Priority 1 — ✅ closed** (§5, RC-05/PR #114). **Priority 2 — ✅ closed**
(§7a, PR #115 — the `/adjust` double-post fix plus the four other
candidates' dispositions). **Priority 3 — ✅ closed** (§7a, PR #117 —
config-validation pass: missing-env-var startup checks confirmed already
handled gracefully everywhere, health-check endpoint coverage extended
onto the public `/api/status` route). **Priority 4 — ✅ closed** (§7a,
PR #119 — the orphaned `/post-receipts` page linked from Documents; every
other mounted route already reachable). Remaining: Priority 5 below.

Per the user's full-auto-build directive, continue through the following
without pausing for permission, using the same one-concern-per-branch
commit→push→PR→CI→merge→sync→clean-repo cycle already established:

**Priority 1 — Phase 4/5 line-by-line checklist cross-check (§5).**
Verification-only, no new code expected on current evidence, lowest risk,
fastest to close out. Re-read `src/ai/xlsx.test.ts`/`src/ai/ingest.test.ts`
against the mandate's Phase 4 checklist wording (partial-failure policy,
cross-tenant rejection, safe-cancellation, checksum), and
`src/money-cents.test.ts`'s FIN4 series against the Phase 5 checklist
wording (duplicate/concurrent-request handling, archived/voided reporting
behavior). If a real gap is found, it becomes a new Phase 6 item and gets
its own branch/PR, same as the receipt-posting race was.

**Priority 2 — Further duplicate/concurrent-mutation risk audit.**
The receipt-posting fix (§7a) closed one instance of "guard checked in the
same batch as an otherwise-unconditional write" — worth checking whether
the same pattern exists anywhere else before assuming it's unique to
receipt-posting. Candidates to check first: invoice/payment posting paths
(`src/api/*` — anything that inserts into `job_cost_ledger`,
`invoices`, or `payments` under a status/won-race guard), time-entry
adjustment/reversal paths (`insertReversalTimeEntry`,
`insertTimeEntryAdjustment` in `src/db/repos.ts`), and change-order
posting. Grep for `db.batch(` call sites that combine a guarded statement
with an unconditional one, same signature as the bug just fixed.

**Priority 3 — Config-validation pass.**
Missing-env-var startup checks, health-check endpoint coverage — flagged
in §6 as not yet done. Small, well-scoped.

**Priority 4 — Missing route-mount/nav audit.**
Flagged in §6 as not yet investigated.

**Priority 5 — Stale-doc sweep.**
Beyond this checklist itself — check other `docs/spec/*.md` /
`docs/RUNBOOK-*.md` files for drift against current code, now that Phase 2
and two Phase 6 items have landed since some of them were last touched.

**Not on this list, and should stay off it:** fix-plan item 1b (blocked on
a real file sample from Tyler — not autonomously executable), touching any
of the WIP branches classified in §4 (still permanently off-limits), any
`--remote`/production migration, backfill `--apply`, secret rotation, or
live financial-data mutation against `avalon-sales-hub-production` (the
one standing hard constraint, unaffected by "full auto mode").
