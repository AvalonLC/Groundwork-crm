# Finance OS Fix Plan — hand-off for implementation

Owner request, verbatim (2 rounds):
1. "nothing in there is clickable... I cant start anything in the queue... nothing is
   reading or matching... [Setup & Config should] only need the upload section and
   the rest should be pretty automated."
2. "what else regarding the finance section may not be working or syncing to the
   rest of the crm properly?"

This doc is the complete, ordered fix list for both rounds. It assumes the reader
(human or agent) has NOT seen the investigation that produced it — every item states
the problem, the exact root cause, the fix, the files to touch, and how to verify.
Work top-to-bottom; later items are lower-risk/lower-value and some depend on earlier
ones being merged first (noted per item).

Branch note: item 0 already exists on `finance-os-queue-actions` (commit `bfa6c0d`),
built off `main` at `5202845`. Land it first (or rebase everything after it), then
branch each remaining item separately so they can be reviewed/merged independently.

---

## 0. Ship the already-built Work Queue fix (branch exists, just needs to land)

**Status:** Done, committed, not pushed. Sub-requests "nothing clickable" / "can't
start anything in the queue."

**What was built:** `dismissActionItem()` added to `src/db/repos.ts` (mirrors the
pre-existing `resolveActionItem()`, sets `status='dismissed'`). `src/ui/queue.tsx`
rewritten to add Resolve + Dismiss `<form>` buttons per queue item, backed by new
`POST /finance/queue/:id/resolve` and `POST /finance/queue/:id/dismiss` routes.

**To do now:**
1. `git checkout finance-os-queue-actions`
2. Run the full suite, not just typecheck: `npm test` (vitest + node tests) — this
   has not been run since the change, only `tsc --noEmit` and `npm run build`.
3. Add e2e coverage in `src/ui/queue.e2e.ts` for the two new buttons: seed an open
   `action_item` via the existing `resetFinanceDb`/`exec` test-seed helpers
   (`src/ui/test-seed.ts`), click Resolve, assert the item leaves the open list and
   `status='resolved'` in DB; repeat for Dismiss → `status='dismissed'`.
4. `git push -u origin finance-os-queue-actions`, open a PR against `main`, verify CI
   (`.github/workflows/ci.yml`) is green, merge.

**Verify after merge:** hit `/finance/queue` as a logged-in owner/office user, confirm
Resolve and Dismiss buttons appear on every open item and actually change status.

---

## 1. Fix "nothing is reading or matching" (ingest / classifier)

**Root cause (confirmed):** `src/ai/ingest.ts`'s `detectSource()` matches an
uploaded file's header row against 5 fixed shapes in
`config/finance/ingest.sources.json` (QBO P&L, Class/Division P&L, Balance Sheet,
Bank/Card CSV, Payroll). If the headers don't subset-match any of the 5, it returns
`null` and the file becomes a review item with a generic "not recognized" message —
it is NOT reading the file wrong, the file's headers genuinely don't match any
configured shape. `automation-policy.json` was checked and confirmed NOT disabled
(`ingest_auto_detect_enabled: true`, `auto_create_action_items: true`, etc.) — this
is not a policy toggle problem.

**Two-part fix — do both:**

### 1a. Make the failure diagnosable instead of opaque
File: `src/ai/ingest.ts` (the `createIngestReviewItem` call sites and whatever
struct becomes `IngestResult`). File: `src/ui/document-upload.tsx`'s
`ingestResultCard()` "Format not recognized" branch.

- When `detectSource()` returns `null`, capture the actual header row that was
  parsed (not just the fallback reason string already in
  `ingest.sources.json`'s `fallback.reason`).
- Surface it in the UI: "We found these column headers: `A, B, C` — none of our
  known formats matched. Expected one of: `Account,Total` (P&L),
  `Class,Account,Total` (Class P&L), `Account,Balance` (Balance Sheet),
  `Date,Description,Amount` (Bank/Card), `Employee,Pay Date,Gross Pay` (Payroll)."
  This turns every future "nothing is reading" report into a 10-second diagnosis
  instead of a re-investigation.
- Add a unit test (wherever `ingest.test.ts` / `src/ai/ingest.test.ts` lives) that
  asserts an unmatched header set produces a review item whose stored reason/detail
  includes the actual headers seen.

### 1b. Get the real export headers and extend the config (or don't — decide with the user)
- Ask the business owner (not Claude) for one real sample export from each source
  system they actually use (QuickBooks P&L export, bank CSV, payroll report, etc.)
  — the specific column names/order that caused "not recognized."
- Compare those headers against `config/finance/ingest.sources.json`'s
  `detect.required_headers` for the closest matching shape.
- Either (a) the real header set is a reasonable variant (e.g. extra column,
  different casing already handled since matching is case/order-insensitive, or a
  near-miss) → add it as an alternate `required_headers` set for that shape, or add
  a 6th shape if it's a genuinely different export format, or (b) it's a false
  need and 1a's diagnostic message is the actual fix (some uploads may just be the
  wrong file type for this flow).
- This step CANNOT be done blind — it needs a real file sample. If none is
  available, ship 1a alone and close the loop with the user next time an upload
  fails, using the new diagnostic message.

**Verify:** upload a file with an unrecognized header row through
`/finance/upload` (document-upload.tsx), confirm the review item now shows the
actual detected headers alongside the expected ones.

---

## 2. Hide raw JSON config editors from regular users (Setup & Config)

**Goal restated by owner:** a real user should only see the Upload section; the rest
should be automated and hidden.

**Current state:** `src/ui/config-admin.tsx` renders a `{configs.map(...)}` block
(~lines 110-160) showing all 7 named configs (`classifier_rules`, `ingest_sources`,
`automation_policy`, `approval_thresholds`, `tenant_defaults`, `division_map`,
`role_map`) as raw JSON editors, gated only on `canSee(role, "can_see_budget_rates")`
— i.e. any `owner`-role user sees them, which in practice is most business owners.
GET/POST routes at ~lines 165-230 gate the same way.

**Fix — gate behind `isSuperAdmin`, not the `owner` Finance role:**

1. `src/ui/layout.tsx`: extend `PageArgs` (currently `{tenant_id, role, vocab}`) to
   also carry `isSuperAdmin: boolean`, and update `readPageArgs()` to populate it —
   real-auth path should read `c.var.isSuperAdmin` (already set at CRM session
   resolution, `src/index.tsx` ~line 566-618); the query-param dev-server fallback
   path should read an `is_super_admin=1` query param defaulting to `false`.
2. `src/ui/config-admin.tsx`: wrap the raw-JSON `{configs.map(...)}` block in an
   `isSuperAdmin` check. When false, render nothing there (not even a locked/greyed
   placeholder — the owner's ask was "they only need the upload section," so the
   rest of the page should just not exist for them, not tease something they can't
   use).
3. Apply the same `isSuperAdmin` gate to the GET/POST routes in `config-admin.tsx`
   (not just the render — a non-super-admin should get a 403 hitting the API
   directly, not just have the UI hidden).
4. Do NOT touch `src/ui/document-upload.tsx` or the Upload section — that stays
   visible to normal owner/office users exactly as today.
5. Leave `src/ui/policy-setup.tsx` (Company Policy) as-is unless the owner also
   wants that hidden — it wasn't called out, only "Setup & Config."

**Verify:** log in as a normal owner-role (non-super-admin) user, visit
`/finance/config`, confirm only Upload is visible (or the page redirects/simplifies
appropriately) and `POST /finance/config/*` returns 403. Then confirm a
super-admin session still sees and can edit all 7 configs.

**Add test coverage:** extend `src/ui/config-admin.e2e.ts` and/or
`src/ui/roles.e2e.ts` with a case for `isSuperAdmin=false` hiding the block and
`isSuperAdmin=true` showing it.

---

## 3. Wire up the unbilled-work detector (biggest single fix for "nothing in the queue")

**Root cause (confirmed):** `src/engines/unbilled.ts`'s `detectUnbilledWork()` and
`src/db/repos.ts`'s `listCompletedUnbilledWorkItems()` are fully written and
individually unit-tested, but **neither is called from anywhere except its own
test file** — no route, no cron, nothing. This is the engine specifically meant to
scan completed jobs with no invoice and turn them into `action_item(verb='collect')`
rows. It was left stubbed on purpose (`docs/spec/UNBILLED.md`, flagged in
`docs/PUNCHLIST.md` item 3) because at the time it was written, Finance OS didn't
have visibility into the CRM's invoice tables — that blocker is gone since the
2026-08-09 DB merge (`migrations/0057_finance_merge.sql`); everything now lives in
one D1 database.

**This directly explains why the Work Queue looked empty/broken** — it's not that
existing findings weren't clickable (that's fixed in item 0), it's that almost
nothing was ever being generated in the first place for the single most common
finance event (a job gets marked done and nobody invoices it).

**Fix — write the missing join and call it on a schedule:**

1. New function, e.g. `runUnbilledWorkDetection(db, companyId)` in
   `src/engines/unbilled.ts` or a new `src/cron/unbilled-sweep.ts` (follow the
   existing pattern in `src/cron/gather-inputs.ts` / `src/cron/rollup.ts`):
   - Pull completed work orders via the existing
     `listCompletedUnbilledWorkItems(db, companyId)` (already correctly reads the
     merged `work_orders` table — verified, not the dead `work_item` table).
   - Determine "no receivable" by joining against `invoices` — the CRM's own
     `invoices` table has `estimate_id` → `estimates.opp_id` / `estimates.id`, and
     `work_orders` has `opp_id`/`estimate_id`. Build the set of work-order ids that
     already have ANY invoice (any status, not just paid) traced back to them
     through that chain, and treat everything else as `billedWorkItemIds` should
     NOT contain them.
   - Call `detectUnbilledWork(completedItems, billedWorkItemIds)` (pure, already
     tested, no changes needed there) and for each `UnbilledFinding`, create an
     `action_item(verb='collect', source_type='work_order', source_id=work_item_id,
     amount_cents=finding.amount_cents, confidence=finding.confidence)` via a new
     `createActionItem()` helper in `src/db/repos.ts` (or reuse whatever creation
     helper `src/ai/ingest.ts`'s `createIngestReviewItem` already demonstrates the
     pattern for) — guard against duplicates: skip if an open `action_item` with
     that `source_type`+`source_id` already exists.
2. Wire it into the existing nightly rollup cron rather than inventing a second
   schedule: call it from `src/api/cron-trigger.ts`'s `POST /rollup` handler,
   right after (or before) `runNightlyRollup` — same `X-Cron-Secret` gate already
   protects it, same `.github/workflows/finance-cron.yml` trigger already calls it
   once a day. Respect `dry_run` (compute/log findings, don't write).
3. Update `docs/spec/UNBILLED.md` to mark the CRM-join gap as resolved and describe
   the actual join implemented (it currently says "Needs Tyler" for this exact
   piece — that's the resolution).
4. Update `docs/PUNCHLIST.md` to remove/cross out item 3's unbilled half once shipped.

**Verify:** in a local/dev DB, mark a work order `status='completed'` with no
invoice against it, run `POST /internal/cron/rollup?dry_run=true` (or the real
sweep function directly in a test), confirm a `collect` action_item appears in
`/finance/queue` and Money Loop's "collect" tile count increases. Then create an
invoice for that job and re-run — confirm no duplicate/stale item remains open (add
a check: if a job that had an open `collect` item gets invoiced, either
auto-resolve that item or at minimum don't create a second one).

**Tests to add:** `src/cron/unbilled-sweep.test.ts` (or wherever it lands) covering:
completed+uninvoiced → creates item; completed+invoiced → no item; already has an
open item → no duplicate; dry_run → computes but doesn't write.

---

## 4. Close the work-order delete → orphaned Finance data gap

**Root cause (confirmed, not yet triggered in production — checked, zero orphans
today, but no guard exists):** `DELETE /api/work-orders/:id`
(`src/index.tsx` ~line 12747) cleans up `wo_day_employees` and `wo_days` but never
touches:
- `job_cost_ledger` rows already posted against that job (`job_id` FK to
  `work_orders.id`, but D1 does not appear to enforce FK constraints here — no
  `PRAGMA foreign_keys` found anywhere in the codebase — so the delete silently
  succeeds and leaves ledger rows pointing at a job_id that no longer exists).
- Any open `action_item` with `source_type='work_order'` and
  `source_id=<deleted wo id>`.

**Fix:**
1. In the same `db.batch([...])` call in the delete handler, add:
   - `UPDATE action_item SET status='dismissed', resolved_at=datetime('now') WHERE
     company_id=? AND source_type='work_order' AND source_id=? AND status='open'`
     — auto-dismiss rather than hard-delete, so there's still an audit trail of
     "this was open, then its source job was deleted."
   - Decide with the user whether `job_cost_ledger` rows for a deleted job should
     be deleted too, or kept as a historical cost record with the job gone (leaning
     toward **keep** — real labor/overhead was actually incurred and posted;
     deleting the ledger would erase that cost history. Recommend keeping the rows
     but confirming this decision explicitly with the user before shipping, since
     it affects historical job-costing reports).
2. Add a short code comment at the delete handler explaining why ledger rows are
   (or aren't) cleaned up, so the next person doesn't have to re-derive this.

**Verify:** create a work order, post time against it (clock in/out with a crew
that has a division set), confirm a `job_cost_ledger` row exists, delete the work
order, confirm the decided-upon behavior (ledger kept or removed per the decision
above) and confirm any open `action_item` referencing it is now `dismissed`.

**Test to add:** extend the existing work-order delete test (find it via
`grep -rn "DELETE /api/work-orders" src/**/*.test.ts` or similar) with an assertion
covering the new cleanup step.

---

## 5. Guard against stale ledger data when a posted time entry is edited

**Root cause (confirmed, not yet triggered in production — checked, zero cases
today):** `src/api/posting.ts`'s `postTimeEntryToLedger()` posts to
`job_cost_ledger` exactly once, by design (comment explicitly calls this
"immutability," matching a documented hard rule against "retroactive recost without
an explicit job"). But `PUT /api/time/entries/:id` (`src/index.tsx` ~line 4359)
still allows an admin/office_manager to edit `clockIn`/`clockOut` and recompute
`duration_min` on an entry regardless of whether it's already `posted_at IS NOT
NULL`. If that happens, the ledger keeps the original labor/overhead cents while
the time entry now shows different hours — Job Costing would show a job's cost
total that no longer matches its own time entries.

**Fix — pick one (recommend option A, matches the existing "propose don't
auto-write" philosophy used everywhere else in Finance OS):**

- **Option A (recommended):** in the `PUT /api/time/entries/:id` handler, if the
  entry being edited has `posted_at IS NOT NULL` AND the edit changes `clockIn`,
  `clockOut`, or anything that would change `duration_min`, block the destructive
  fields with a 409 and a clear message: "This entry has already been posted to
  the job cost ledger and can't be edited directly — [use a correction workflow /
  contact office_manager to reverse and re-post]." Non-time fields (`notes`,
  `jobType`, `approved`) remain freely editable regardless of `posted_at`.
- **Option B (more work, more correct long-term):** build an explicit
  "correction" flow — reverse the original two ledger lines (insert offsetting
  negative labor/overhead lines) and re-post fresh ones reflecting the new
  duration, preserving a full audit trail. This is a bigger change; only do this
  if the user specifically wants editable posted time, not just a safety block.

**Same question applies to `DELETE /api/time/entries/:id`** (~line 4403) — it
already blocks deleting an *approved* entry for non-admins, but does NOT check
`posted_at` at all for any role. An admin can delete a time entry that's already
been posted to the ledger, leaving `job_cost_ledger` rows referencing a
`time_entry_id` that no longer exists. Add the same `posted_at IS NOT NULL` guard
here too (block the delete outright, regardless of role, once posted — deleting
financial history should never be silently possible).

**Verify:** clock a crew member in/out on a job with a division set (confirms
posting happens), then attempt to edit the entry's clock-out time via the API —
confirm it's rejected with a clear error once the guard is in place; confirm
non-financial fields (notes) still save fine.

**Test to add:** in the time-entries test file, add a case: post an entry, attempt
to edit clockOut, expect 409; attempt to delete a posted entry, expect 409/403.

---

## 6. Prevent silent CRON_SECRET drift from recurring

**Root cause (confirmed, already self-resolved for now):** the nightly rollup
(`.github/workflows/finance-cron.yml` → `POST /internal/cron/rollup`) failed 4
consecutive scheduled nights (Aug 16-19) with HTTP 401 because the GitHub Actions
`CRON_SECRET` and the Cloudflare Pages `CRON_SECRET` didn't match. It's currently
fixed and has succeeded every night since Aug 20 (confirmed via production
`recovery_snapshot`, latest row is today). Nothing prevents this from silently
recurring — a scheduled GitHub Action failure produces a red X in the Actions tab
and nothing else; nobody is notified.

**Fix:**
1. Add a monitoring step: either (a) a second, tiny scheduled GitHub Action (or a
   step appended to the existing one) that emails/notifies on failure — GitHub
   Actions supports this natively via a failure-notification step, or simplest:
   turn on GitHub's built-in "notify on workflow failure" for repo watchers so
   Tyler gets an email the same night it fails instead of noticing days later; or
   (b) add a lightweight uptime-style external check that hits
   `GET /internal/cron/rollup/status` daily and alerts if `cron_secret_configured`
   is ever `false` (catches the 503 case) — note this does NOT catch a 401
   mismatch since `/status` never validates the actual secret value, only whether
   one is configured. Prefer option (a) since it directly monitors the real
   workflow, not just a proxy signal.
2. Add a short paragraph to `docs/RUNBOOK-finance-cron.md`'s "If a scheduled run
   fails" section pointing at whichever notification mechanism gets chosen, so the
   next incident is caught the same night, not four days later.
3. Optional hardening: add a "last successful run" freshness check somewhere
   visible in the Money Loop UI itself (e.g. small text under the recovery number:
   "Last updated Aug 21" pulled from `MAX(recovery_snapshot.as_of)` for the tenant)
   — this gives a human, in-app signal independent of whether anyone's watching
   GitHub Actions or email.

**Verify:** deliberately break `CRON_SECRET` in a test/staging context (or just
review the GitHub Actions failure-notification settings), confirm a failure
produces a real notification, not just a silent red X.

---

## 7. General: reduce "silent Finance sync failure" risk across the three write-through helpers

**Context (no single fix — a standing risk to document and decide on):**
`syncWorkOrderFinanceColumns`, `postWorkOrderTimeEntry`, and
`markOpportunityCollectedFromInvoice` (all in `src/index.tsx`, ~lines 635-753) are
deliberately "best-effort" — they never throw, never block the CRM request that
triggered them, and on failure only call `console.error`/`console.warn`. This is
architecturally correct (a Finance OS hiccup should never break creating a work
order), but there is currently **no observability configured at all** — no Sentry,
no Cloudflare Logpush/Analytics alerting, nothing (confirmed: no observability
block in `wrangler.jsonc`, no error-tracking secret in `wrangler pages secret
list`). A real failure in any of these three helpers today is invisible to
everyone.

**Recommended fix (do this once, benefits all three):**
1. Set up Cloudflare's built-in Logpush or Workers Logs (or a lightweight
   Sentry/Cloudflare-compatible error tracker) so `console.error` calls are
   actually retained and searchable somewhere a human can check, rather than
   scrolling `wrangler tail` after the fact.
2. Consider whether `postWorkOrderTimeEntry`'s two silent no-op cases (no
   `work_order_id`, or crew has no `division` set) should surface anywhere
   user-facing — right now a crew with no division silently never gets its time
   posted to the ledger, forever, with only a `console.warn`. At minimum this
   should show up as something in Setup & Config / Job Costing ("N time entries
   this week couldn't post — no division set on crew X") rather than being purely
   a log line. This overlaps with item 2's Setup & Config redesign — factor it in
   there if that page still shows anything beyond raw config to super-admins.

This item is lower priority than 0-6 and doesn't need to ship in the same PR wave —
flag it to the user as a standing architectural note, decide observability tooling
with them explicitly (adds a new secret/dependency), and schedule separately.

---

## Suggested execution order & branching

1. Land item 0 (already built) first — quick, isolated, unblocks nothing else but
   is the most user-visible immediate fix.
2. Item 1 (ingest diagnostics) — needs a real file sample from the user for 1b;
   ship 1a (better error message) regardless, even without the sample.
3. Item 2 (config-admin gating) — independent of everything else, safe to do in
   parallel with item 1.
4. Item 3 (unbilled-work detector) — the single highest-value fix from the audit;
   do this before items 4/5 since it's more impactful, but it's independent of them
   code-wise.
5. Items 4 and 5 (delete/edit guards) — small, independent, low-risk; can be one
   combined PR ("Finance OS data-integrity guards for work-order delete and posted
   time-entry edits") since they're thematically identical (protecting posted
   financial data from silent corruption via ordinary CRM mutations).
6. Item 6 (cron monitoring) — quick, no code dependency on anything else, but
   naturally follows right after diagnosing the rollup failure.
7. Item 7 (observability) — a standing note, not a PR; revisit once the above are
   merged and stable.

Each item above states its own file list, exact fix, and verification steps —
sufficient to hand to an implementer one at a time without needing this
conversation's full history.
