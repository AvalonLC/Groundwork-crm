# Runbook: Item 4 Stage 2 §10 — Existing-Record Backfill Migration

**Status: this runbook is written, reviewed, and ready. Nothing in it has
been executed. It exists so that when Tyler decides to run the real §10
migration script (docs/spec/ITEM4-JOBCOST.md §10, steps 1-5 — creating
baseline `job_budget_versions` rows for every existing job with an accepted
estimate), the steps, ordering, and safety checks are already worked out
in one place, instead of being improvised live against production.**

This is a **write-only** document per the standing Item 4 Stage 2 mandate.
No command below has been run against production. No migration has been
applied to production. No live backfill has occurred. `src/engines/backfill-
analysis.ts` / `runBackfillAnalysis` (Item 4 Stage 2 Phase 3, merged PR
#105) already exist and are safe to run any time — they are report-only
and issue nothing but `SELECT`s. Everything else in this document describes
a *future*, currently-unbuilt, row-creating script and is explicitly gated
on a separate approval before anyone runs it for real. See "13. Residual
risks" for why the row-creating script itself is not built yet.

---

## 1. Backup / export (before touching anything)

Before any schema migration or data-writing script runs against
`avalon-sales-hub-production`, take a full export. D1 has no automatic
point-in-time restore for a script-induced mistake — this is the only
safety net.

```bash
# Full schema + data export, timestamped so repeated runs don't clobber
# each other:
npx wrangler d1 export avalon-sales-hub-production --remote \
  --output "backups/pre-backfill-$(date +%Y-%m-%d_%H%M).sql"
```

Store the resulting `.sql` file somewhere outside this repo's own git
history (it will contain real customer financial data) — e.g. a private
bucket or Tyler's own secured storage, never committed. Confirm the file
is non-trivial in size (`wc -l` / `ls -lh`) before proceeding — an export
that silently produced an empty or truncated file is worse than no backup,
because it creates false confidence.

**Table-scoped export as a lighter-weight alternative**, if a full export
is impractical for size/time reasons and only the tables step 1-5 of §10
actually touches need protecting:

```bash
npx wrangler d1 export avalon-sales-hub-production --remote \
  --table job_budget_versions --table work_orders --table estimates \
  --table crews --table overhead_allocation \
  --output "backups/pre-backfill-scoped-$(date +%Y-%m-%d_%H%M).sql"
```

Prefer the full export unless there's a specific, documented reason not
to — a scoped export only protects against mistakes *inside* those named
tables, not against a script bug that writes somewhere unexpected.

---

## 2. Migration commands / order

The row-creating §10 script does not exist as a runnable artifact yet (see
§13). When it is built, it is expected to be a standalone Node script
under `scripts/` (following the exact precedent of
`scripts/migrate-finance-data.mjs`, documented in
`docs/RUNBOOK-finance-merge.md`) rather than a numbered SQL migration file
— §10's logic (skip-vs-baseline decisions, division/overhead-rate
resolution, completion-method classification) is conditional business
logic per row, not a fixed-shape schema change, so it does not belong in
`/migrations`.

Expected order, once that script exists:

1. Apply any schema-only migration it depends on (if `job_budget_versions`
   or a related table needs a new nullable column not yet in production —
   check `migrations/` for the highest-numbered file at the time; as of
   this writing the last applied is `0085_job_budget_change_orders.sql`
   and already includes the `needs_review` column §10 step 2 relies on, so
   no new schema migration may be needed at all):
   ```bash
   wrangler d1 migrations apply avalon-sales-hub-production --remote
   ```
2. Dry-run the backfill script itself (flag name illustrative — match
   whatever the actual script implements, following
   `migrate-finance-data.mjs --remote`'s own dry-run-by-default pattern):
   ```bash
   node scripts/backfill-job-budget-versions.mjs --remote
   ```
3. Review the dry-run's summary against §9 below before ever passing
   `--apply`.
4. Apply for real, only after separate explicit approval (§12):
   ```bash
   node scripts/backfill-job-budget-versions.mjs --remote --apply
   ```

**Never run step 4 twice.** Per §10 step 4 ("skip, don't guess") and step
5 ("no historical change orders invented"), a `job_budget_versions` row is
a `revision_seq=0` baseline meant to exist exactly once per job. Re-running
the apply step against jobs that already have a baseline row is expected
to be a no-op (skip via the `already_has_budget_version` bucket — see §4
of `src/engines/backfill-analysis.ts`) rather than a duplicate insert, but
that guarantee should be confirmed by the script's own tests, not assumed,
before the first real run.

---

## 3. Deploy ordering

No code deploy is required to run the backfill script itself — it is a
standalone Node script invoked from a developer machine or CI job with
`--remote` credentials, not a route the deployed Worker serves. Because of
that, there is no strict ordering constraint between "deploy the app" and
"run the backfill" the way `RUNBOOK-finance-merge.md`'s merge had one
(that runbook's schema needed to exist before the app code that read it).

That said, if a future PR adds a UI surface that *reads* the newly-created
`job_budget_versions` baseline rows (e.g. surfacing them on the job-costing
page), the safe order is:
1. Deploy the code that can read the new rows (it already tolerates zero
   rows today — `src/ui/job-costing.tsx`'s JP-E2E-06 test covers the
   no-budget-version case explicitly).
2. Run the backfill script.
3. No redeploy needed afterward — the same deployed code now has real rows
   to read.

---

## 4. Config / secrets checklist

The backfill script needs no new secret beyond what already exists for any
`--remote` wrangler operation: a valid `CLOUDFLARE_API_TOKEN` /
`CLOUDFLARE_ACCOUNT_ID` pair with D1 write access to
`avalon-sales-hub-production`, the same credential Tyler already uses for
`npm run db:migrate:prod` and `npm run deploy`. Confirm before running:

```bash
npx wrangler whoami
```
Shows the authenticated account. No new Cloudflare Pages secret
(`wrangler pages secret put ...`) is needed — the script talks to D1
directly via wrangler's own D1 API, not through a deployed route.

---

## 5. Pre-deploy verification

Before running the real backfill script against production:

1. **Confirm main is clean and synced**, exactly as required at the end of
   every phase in this mandate:
   ```bash
   git status --short          # expect nothing
   git rev-parse HEAD origin/main   # expect the two hashes to match
   ```
2. **Run `runBackfillAnalysis` against production data first**, via a
   temporary read-only script or a debug route gated to owner/super-admin
   only (never a public route), to get the real, current bucket counts —
   this is exactly what Phase 3's tool exists for. Do this *before*
   building/running the real row-creating script, so the expected bucket
   distribution in §7 below is based on real numbers, not a guess.
3. **Confirm the backfill script's own test suite passes**, once it
   exists, the same way Phase 3's 57 tests were required to pass before
   merge — zero-write dry-run mode, tenant isolation, and idempotency
   (re-running against already-migrated jobs is a no-op) all need
   dedicated tests, not just the classifier's tests reused as-is.
4. **Confirm the backup from §1 exists and is non-empty.**

---

## 6. Post-deploy smoke tests

After the real backfill script runs (`--apply`, real production run):

```bash
# Total new baseline rows created should equal the dry-run's predicted
# "would create" bucket counts (would_create_needs_review_cost_to_cost +
# would_create_needs_review_service_units — the two reachable buckets;
# see §7's invariant).
wrangler d1 execute avalon-sales-hub-production --remote --command \
  "SELECT COUNT(*) FROM job_budget_versions WHERE revision_seq = 0 AND source_type = 'estimate'"

# Spot-check a handful of newly-created rows against a job you already
# know the numbers for by hand (pick 2-3 real jobs, not a random sample —
# ones a human can independently verify).
wrangler d1 execute avalon-sales-hub-production --remote --command \
  "SELECT * FROM job_budget_versions WHERE job_id = '<a known job id>'"

# Confirm the job-costing page renders correctly for one of those jobs —
# GET /finance/job-costing/<job_id> as an owner-role user, in a real
# browser or via curl with a valid session, and eyeball the "Job progress
# (Item 4 formulas)" card against the row you just inspected.
```

---

## 7. Dry-run backfill command + expected buckets

```bash
node scripts/backfill-job-budget-versions.mjs --remote
# (or, until that script exists, run runBackfillAnalysis programmatically
# against production — same effective preview, today, zero-write, via
# Phase 3's own tool)
```

Expected output shape (per `BackfillAnalysisReport` from
`src/engines/backfill-analysis.ts`) — a `bucket_counts` object with all 10
keys always present (zero-filled, per that file's own aggregation
contract), plus a `total_jobs_scanned` count and a per-job `jobs[]` array:

| Bucket | Meaning | Expected under real data |
|---|---|---|
| `already_has_budget_version` | Job already has a `revision_seq=0` row — a true no-op skip | Should be 0 on the very first run; nonzero on any re-run, confirming idempotency |
| `no_accepted_estimate` | §10 step 4 skip — no accepted estimate found via any of the 3 job-to-estimate paths | Expect nonzero — some jobs predate estimate tracking entirely |
| `no_division` | §10 step 4 skip — crew has no division set, or job has no crew | Should shrink over time as `configAdminRouter`'s division-gap banner (see `getCrewsMissingDivisionWithUnpostedTime`) gets acted on; nonzero here is a real, known, already-surfaced gap, not a bug |
| `no_overhead_rate_for_division` | Implied 5th skip reason (§10 doesn't name it, but the "skip, don't guess" rule generalizes to it) — division resolved but no `overhead_allocation` row exists at/before the job's estimate-acceptance date | Should be small; a division with jobs but literally no overhead rate ever configured is itself worth flagging to Tyler as a separate gap |
| `ambiguous_direct_cost_split` | §10 step 2 — reserved for a future case where the direct-cost split genuinely can't be attributed even under the "everything to labor" fallback; the current classifier's step 2 always resolves to labor + `needs_review=1` rather than truly failing, so expect 0 unless the classifier logic changes | Expect 0 under the current classifier |
| `no_completion_method_signal` | §10 step 3 — job type isn't `Install`/`Service` and has no recurring-plan link | Expect nonzero for one-off jobs outside the two known type buckets |
| `would_create_clean_cost_to_cost` | Provably unreachable today (§10 step 2 always sets `needs_review=1`) — kept for forward compatibility only | **Must be 0.** A nonzero count here means the classifier's `needs_review` logic regressed; treat as a bug, not a legitimate result |
| `would_create_clean_service_units` | Same as above, service_units variant | **Must be 0**, same reasoning |
| `would_create_needs_review_cost_to_cost` | The real "this job would get a baseline row" bucket, cost_to_cost method | The bulk of successfully-classified jobs are expected here |
| `would_create_needs_review_service_units` | Same, service_units method (recurring-plan-linked jobs) | Expected nonzero, smaller than the cost_to_cost bucket unless the tenant is recurring-maintenance-heavy |

**Reconciliation invariant to check on every dry run:** the sum of all 10
bucket counts must equal `total_jobs_scanned`. `buildBackfillAnalysisReport`
guarantees this by construction (every job gets classified into exactly
one bucket), but re-verify it manually on the real dry-run output before
trusting anything downstream of it — see §8.

---

## 8. Reconciliation queries + invariants

Run these against the dry-run's raw JSON output (or against
`runBackfillAnalysis`'s return value directly, if invoked from a script
rather than a CLI):

```bash
# Invariant 1: bucket counts sum to total_jobs_scanned.
python3 -c "
import json
r = json.load(open('dry-run-output.json'))
assert sum(r['bucket_counts'].values()) == r['total_jobs_scanned'], 'bucket sum mismatch'
print('OK: bucket sum == total_jobs_scanned')
"

# Invariant 2: every job_id in jobs[] is unique (no job classified twice).
python3 -c "
import json
r = json.load(open('dry-run-output.json'))
ids = [j['job_id'] for j in r['jobs']]
assert len(ids) == len(set(ids)), 'duplicate job_id in report'
print('OK: no duplicate job_id')
"

# Invariant 3: the two 'clean' buckets are exactly 0 (see §7's note — a
# nonzero value here means the classifier regressed).
python3 -c "
import json
r = json.load(open('dry-run-output.json'))
assert r['bucket_counts']['would_create_clean_cost_to_cost'] == 0
assert r['bucket_counts']['would_create_clean_service_units'] == 0
print('OK: both clean buckets are 0, as expected under the current classifier')
"

# Invariant 4 (post-apply only): row count created in job_budget_versions
# matches the pre-apply dry-run's would_create_* sum exactly.
wrangler d1 execute avalon-sales-hub-production --remote --command \
  "SELECT COUNT(*) FROM job_budget_versions WHERE revision_seq = 0"
# Compare manually against:
#   bucket_counts.would_create_needs_review_cost_to_cost
#   + bucket_counts.would_create_needs_review_service_units
# from the immediately-preceding dry run (not an older one — division/
# overhead-rate data can change between runs).
```

If any invariant fails, **stop** — do not proceed to `--apply` (or, if it
already ran, do not consider the run verified) until the discrepancy is
understood. This is exactly the kind of "risk of corrupting or
misrepresenting financial records" condition the standing mandate requires
stopping for, not guessing past.

---

## 9. Monitoring

- **During the dry run / apply run**: watch the script's own stdout/stderr
  in real time (it should log progress per-job or per-batch, following
  `migrate-finance-data.mjs`'s own precedent of a readable per-row summary
  rather than a silent long-running process).
- **After the run**: Cloudflare Workers Logs (enabled per `wrangler.jsonc`'s
  `observability.enabled: true`) will show any request-level errors if a
  UI page reads the new rows and something is malformed, but the backfill
  script itself runs outside the Worker's request lifecycle (it's a direct
  D1 client script), so it will not appear there — the script's own
  terminal output is the only log of the run itself. Redirect it to a file
  for the permanent record:
  ```bash
  node scripts/backfill-job-budget-versions.mjs --remote --apply \
    2>&1 | tee "backups/backfill-run-$(date +%Y-%m-%d_%H%M).log"
  ```
- **After deploy** (if a UI change shipped alongside): the existing
  Money Loop "last updated" staleness banner and the nightly-rollup GitHub
  Actions failure-issue mechanism (`docs/RUNBOOK-finance-cron.md`) are
  unrelated to this backfill specifically, but both remain useful general
  signals that something in the finance pipeline broke — check them as
  part of general post-deploy vigilance for a day or two.

---

## 10. Rollback strategy

**Schema-only migrations** (if step 2's optional new-column migration ran):
D1 has no `DOWN` migration mechanism in this repo's convention (every
migration file in `/migrations` is forward-only, matching
`docs/RUNBOOK-finance-merge.md`'s own precedent). Rolling back a schema
change means writing and applying a new forward migration that drops/
reverts the column — never editing or deleting the already-applied
migration file.

**Data written by the backfill script** (the row-creating step): this is
the harder case, and it's why §1's backup is mandatory, not optional.
- If the run created rows but you want to fully undo it: restore from the
  `--table job_budget_versions` scoped export taken in §1, which requires
  a manual `DELETE FROM job_budget_versions WHERE revision_seq = 0 AND
  created_at >= '<run start time>'` (using the ISO timestamp the script
  logged at start, per the log file from §9) followed by re-importing the
  pre-run export's rows for that table — there is no single wrangler
  command that does this atomically; treat it as a manual, careful,
  Tyler-supervised operation, not an automated rollback script.
- **A partial run failing midway is the more likely failure mode than a
  full run needing a full rollback.** Because §10 step 4's "skip, don't
  guess" logic means each job's baseline row is independent of every other
  job's, a script that dies partway through (network blip, D1 timeout on
  one row) leaves a safe, partially-completed state: some jobs have a
  correct baseline row, others don't yet. The fix is simply re-running the
  script — the `already_has_budget_version` bucket (see §7) ensures
  already-migrated jobs are skipped, not double-inserted, so a resumed run
  is safe by construction, provided the idempotency guarantee from §2 has
  actually been verified by that script's own tests before the first real
  run.

---

## 11. Reversible vs. irreversible actions

| Action | Reversible? | Notes |
|---|---|---|
| Running `runBackfillAnalysis` / the dry-run script (no `--apply`) | Fully reversible (it's a no-op) | Zero writes, safe to run against production any time, any number of times |
| Schema-only migration (new nullable column, if needed) | Reversible via a new forward migration | Never edit/delete the already-applied migration file itself |
| The real `--apply` run creating `job_budget_versions` rows | **Not reversible via any built-in tool** | Requires the manual restore-from-backup procedure in §10; treat every `--apply` invocation as effectively permanent unless you have a very recent, verified backup |
| `resolveJobBudgetVersionReview` flipping `needs_review` 0→1 on a row the backfill created | Reversible (the row itself is untouched; only the flag changes, and flipping it back is a single UPDATE) | This is the one legitimately-mutable field on an otherwise-immutable row, per the existing architecture (see Phase 4 regression notes) |
| A change order created *after* a backfilled baseline row exists | Not applicable here — out of scope for this runbook; that's the existing, already-shipped PR D/PR E workflow, unaffected by whether the baseline row came from real-time creation or backfill |

---

## 12. Explicit separate-approval requirement for live backfill

**This is the single most important line in this document.** Per the
standing mandate's hard production restriction: *"never apply production
migrations, deploy production, backfill live records, rotate secrets, or
modify live financial data."* Nothing in Phase 3, Phase 4, or this runbook
authorizes running the real `--apply` step against production, ever,
under any circumstance, as part of this mandate's own execution.

Before anyone runs `node scripts/backfill-job-budget-versions.mjs --remote
--apply` (once that script exists) against `avalon-sales-hub-production`:

1. Tyler (or whoever owns this decision) must explicitly approve running
   it, separately from and after approving this runbook's existence.
   Writing this runbook is not that approval.
2. The dry-run's bucket-count summary (§7) must have been reviewed by a
   human first — specifically the `no_division` /
   `no_overhead_rate_for_division` / `no_completion_method_signal` /
   `no_accepted_estimate` counts, since each of those represents jobs
   that will be silently excluded (not migrated, not errored) rather than
   backfilled, and a human should confirm that's the intended outcome for
   the specific jobs in those buckets before proceeding, not just accept
   the aggregate count.
3. The backup from §1 must exist, be verified non-empty, and be reachable
   by whoever would need to execute a rollback.
4. This is the same "Tyler runs those himself while awake" boundary
   `CLAUDE.md` and `.githooks/pre-push` already enforce for
   `db:migrate:prod` / `wrangler ... deploy` / `wrangler ... --remote` in
   general — this runbook does not create a new exception to that
   boundary, it documents how to exercise it correctly when the time
   comes.

---

## 13. Residual risks

- **The row-creating script does not exist yet.** This runbook describes
  its expected shape and command surface based on §10's spec and the
  `migrate-finance-data.mjs` precedent, but no code has been written for
  it. Building it is future work, not part of this mandate's Phase 3
  (which deliberately scoped to the report-only preview tool only, per
  the PR #105 description). Until it's built and has its own test suite,
  this runbook's §2/§6/§7 commands are illustrative, not literally
  copy-pasteable.
- **§10 step 2's "everything to labor" fallback is a judgment call, not a
  verified fact**, for every job it applies to. The classifier flags those
  rows `needs_review=1`, which is the honest, designed-in mitigation — but
  it means a nonzero fraction of backfilled rows will have a
  `direct_cost_budget_cents` split that a human still needs to look at
  before treating it as authoritative for change-order math or margin
  reporting.
- **Division/overhead-rate data drifts over time.** A dry run's bucket
  counts (§7) reflect `overhead_allocation` and `crews.division` as of
  the moment it's run. If real time passes between the dry run and the
  `--apply` run (e.g. a review-and-approve cycle spanning days), re-run
  the dry run immediately before `--apply` rather than trusting an older
  one — §8's Invariant 4 note already calls this out.
- **No idempotency test exists yet** because the row-creating script
  doesn't exist yet — §5 point 3 and §10's rollback note both depend on
  this guarantee holding, but it is currently a *design intent*
  (`already_has_budget_version` existing as a bucket specifically to
  support it), not yet a verified, tested behavior of a real script. This
  must be confirmed by that script's own dedicated tests before its first
  production run, not assumed from the classifier engine's tests alone
  (which only prove the classification decision is idempotent, not that
  the actual INSERT statements built around that decision are).
- **This runbook itself has not been reviewed by Tyler.** Per this
  mandate's Phase 5 scope ("write, but never execute"), it is a complete,
  ready-to-review draft, not a pre-approved procedure. Treat every command
  in it as unverified against real production behavior until someone with
  production access has actually walked through §1-§9 once, end to end,
  in a low-stakes moment (e.g. against a near-empty or heavily-reviewed
  small subset first, if that's operationally possible) before trusting
  it for the full tenant base.
