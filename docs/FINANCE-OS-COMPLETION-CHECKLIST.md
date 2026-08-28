# Finance OS Completion Checklist

**Purpose:** a repository-backed record of what's done, what's outstanding,
and what's been conclusively classified as obsolete — so progress survives
across invocation limits without re-deriving it from scratch each time.
Update this file as each subsequent phase closes, rather than replacing it.

Last updated: 2026-08-28 (autonomous Finance OS continuation session).

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

The one piece of Stage 2 that is explicitly **not yet built**: the
row-creating §10 migration/backfill script itself
(`docs/spec/ITEM4-JOBCOST.md` §10 steps 1–5). The report-only preview
(`runBackfillAnalysis` / `classifyJobForBackfill`) is done; the tool that
actually inserts `job_budget_versions` baseline rows is not. This is
tracked as **Phase 2** below — the single largest piece of genuinely new
required Finance OS work identified so far.

## 3. `docs/FINANCE-OS-FIX-PLAN.md` items — resolution status

| # | Item | Status | Evidence |
|---|---|---|---|
| 0 | (intro/context) | n/a | — |
| 1a | Ingest: XLSX format for QuickBooks Class P&L | ✅ Done | PR #88 (`src/ai/xlsx.ts`, real Avalon fixture) |
| 1b | Ingest: unrecognized-format diagnostics (surface actual parsed headers in the review reason/UI, not just a static config string) | ⚠️ **Still open** | `src/ai/ingest.ts`'s `IngestResult`/`detectSource` and `src/ui/document-upload.tsx`'s unrecognized-format branch both confirmed to lack header-echo; see §6 below |
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

- **Open, real gap:** ingest format-detection diagnostics (fix-plan item
  1b). `IngestResult` (`src/ai/ingest.ts`) does not carry the actual
  parsed header row when `detectSource` fails to match — only a static
  config string (`sources.fallback.reason`) is used. `src/ui/document-
  upload.tsx`'s unrecognized-format card likewise shows no header list.
  Fix: thread the detected header array through `IngestResult` (e.g. a new
  `detected_headers: string[]` field) and render it in the review card
  ("We found these column headers: A, B, C — none of our known formats
  matched"). Small, well-scoped, no business-rule ambiguity — good Phase 6
  candidate for the next session.
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
- **Not yet investigated:** missing route mounts/nav audit, duplicate/
  concurrent-mutation risk audit beyond what Phase 4/5 tests already
  cover, missing health-check endpoint, stale-doc sweep beyond this
  checklist itself.

## 7. Next executable action (for the next session/invocation)

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
