# ITEM 4 — Job-Level Cost/Completion/Recovery Formulas (Stage 1 design)

Status: **Stage 1 — approved. Stage 2 (formula implementation) has landed
and is substantially built**, per Tyler's 2026-08-25 decision doc, which
requested this document as the Stage 1 deliverable (formula table,
migration design, field/source mapping, worked examples, test plan) before
Stage 2 began. That request is satisfied and Stage 2 is underway:
`migrations/0085_job_budget_change_orders.sql`,
`migrations/0086_backfill_manifest_execution.sql`, and
`migrations/0087_time_entry_adjusted_guard.sql` are all written and applied
(locally); `src/engines/job-progress.ts`, `src/engines/backfill-analysis.ts`,
and `src/engines/backfill-write.ts` all exist, are wired into
`src/ui/job-costing.tsx`, and are covered by tests. The **§3 scope decision
below was resolved 2026-08-25 in favor of "full scope"** — see the note at
the end of §3. The one part of Stage 2 that has *not* happened, and won't
without separate explicit sign-off, is running the row-creating backfill
script against production data — see §10's update for the current, accurate
status of that specific piece.

This document is kept as the design record for the schema, formulas, and
decisions below; treat the body of §1–§9 as historical design reasoning
that has been implemented as described, not as a pending proposal.

---

## 1. Existing versus proposed formula table

| # | Concept | Current (`gather-inputs.ts` / `rollup.ts`) | Proposed (Tyler's spec) | Status |
|---|---|---|---|---|
| — | Revised contract value | *(does not exist — no job-level contract-value field anywhere)* | `accepted estimate total + approved CO revenue additions − approved CO revenue reductions` | **New** |
| — | Revised budgeted direct cost | *(does not exist)* | `original approved direct-cost budget + approved CO direct-cost additions − reductions` | **New** |
| — | Actual direct cost to date | *(does not exist as a job-level rollup; `work_orders.amount_actual` exists but is explicitly forbidden as a substitute)* | Sum of posted, approved direct job-cost-ledger entries (labor/materials/subs/equipment/disposal/permits/other), net of credits/reversals | **New** |
| — | Revised budgeted overhead | *(does not exist at job level)* | `budgeted sellable labor hours × frozen overhead rate at approval` + CO-added hours × rate-at-CO-approval − reductions | **New** |
| — | Earned completion % | *(does not exist)* | `progress-eligible actual direct cost / revised budgeted direct cost`, capped `[0,1]`, method-dependent (`cost_to_cost` / `service_units` / `manual` / `completed`) | **New** |
| — | Earned revenue to date | *(does not exist)* | `revised contract value × earned completion %` | **New** |
| `recovered_to_date_cents` (job-level reuse) | "Recovered overhead to date" | `SUM(job_cost_ledger WHERE line_type='overhead')` YTD — this is **absorbed**, not earned, overhead | `revised budgeted overhead × earned completion %` | **Corrected** — current formula measures the wrong thing under the new definition |
| `budgeted_overhead_cents` | "Budgeted overhead" | `latest overhead_allocation annual sum ÷ 52` — a **weekly company-wide** target | Job-level: see revised budgeted overhead above. Company-wide weekly figure survives, renamed. | **Corrected + renamed** |
| `absorbed_overhead_cents` | "Absorbed overhead" | Trailing-7-day `SUM(job_cost_ledger WHERE line_type='overhead')` — company-wide, not job-level | `SUM(approved productive hours × division overhead rate effective on each work date)`, job-level | **Corrected** (may still equal the current query's *shape* if ledger overhead lines are reliably generated from approved hours at the effective rate — see §5, formula 8) |
| `pct_recovered` (`buildTenantRollup`) | `recovered_to_date_cents / restated_target_cents` | **Unchanged for the annual company dashboard.** For jobs: `job recovered overhead / job revised budgeted overhead` — a **different ratio**, never mixed with the annual one | **Split into two, both kept** |
| `absorption_variance_cents` | `absorbed_overhead_cents − budgeted_overhead_cents` (company-wide, weekly proxies) | New job-level "Overhead recovery variance" = `recovered overhead to date − absorbed overhead to date`. Sign convention is reversed from today's `absorbed − budgeted`. | **New metric, does not replace the old one** — see §6 |

The annual company-level dashboard formulas in `docs/spec/RECOVERY.md`
(`weekly_recovery = hours_per_week × blended_overhead_rate`,
`pct_recovered = recovered_to_date / restated_target`) are **explicitly
confirmed as still correct** by Tyler's own decision doc ("For the annual
company dashboard: YTD recovered overhead ÷ restated annual overhead
target"). Nothing here touches those two formulas or `recovery_snapshot`.
What changes is everything upstream of them that currently pretends to be
job-level.

---

## 2. Resolved design questions (no longer open)

Three things I flagged as open in the interim comparison turned out to
already be answered by existing code, or to be a false conflict once
checked against the spec text carefully. Recording the reasoning so it can
be checked, not just the conclusion.

**How does a work order resolve to a division?** — Already solved.
`crews.division` (migration `0017_schedule_enhancements.sql`) is the source
of truth; `work_orders.crew_id → crews.division` is the resolution path
`src/index.tsx`'s `postWorkOrderTimeEntry` and `src/api/posting.ts`'s
`postTimeEntryToLedger` already use today to stamp `job_cost_ledger.division`
at post time. Formula 8 (absorbed overhead to date) can read
`job_cost_ledger.division` directly on already-posted rows, or re-derive it
via the same `crew_id → division` join for anything computed off raw time
entries. No new column needed.

**`config/finance/division-map.json`'s 4 canonical divisions
(maintenance/hardscape/snow/drainage) vs. "Landscape Design/Build"** — not
actually a conflict. `division` is the *overhead-pool* axis (which cost pool
a crew's hours draw from). `completion_method` (`cost_to_cost` /
`service_units` / `manual` / `completed`) is a *different, orthogonal* axis
— how a job's earned % gets measured. A hardscape-division installation job
uses `cost_to_cost`; a maintenance-division job uses `service_units`. Nothing
about "Landscape Design/Build" needs to become a 5th division —
`completion_method` is a field on the job/budget, not a rename of the
division taxonomy.

**Should `time_entry_adjustments`' reversal+replacement pattern
(migration `0083`) be reused for job-cost-ledger corrections?** — Yes. It's
generalized below into `job_cost_ledger_adjustments`, same shape, not scoped
to time-entry-sourced lines only (so it also covers materials/subcontractor
corrections once those post).

---

## 3. Needs Tyler — one real scope decision before Stage 2 is sized

Formula 3 (actual direct cost to date) requires categorizing postings into
labor / materials / subcontractors / equipment / disposal / permits /
other. That's a genuine gap, but it's bigger than a CHECK-constraint
change: **today, only labor (and its paired overhead line) is ever posted
to `job_cost_ledger`.** There is no code path that posts a materials
purchase, a subcontractor invoice, equipment rental, disposal, or a permit
fee to the ledger. `receipt` rows exist (vendor, amount, job_id, date — the
Item 1 receipt-intake pipeline) but nothing joins a `receipt` to
`job_cost_ledger` today; they're two disconnected pipelines.

So "actual direct cost to date" done fully requires two things, not one:
(a) the schema to hold non-labor categories (this document proposes that),
and (b) a **posting pipeline** that turns an approved receipt / vendor bill
into a `job_cost_ledger` row — work that doesn't exist in any form yet and
is a real Stage-2 build item, not a config change.

Two ways to sequence this, and I want your call before Stage 2 starts:

- **(a) Full scope**: Stage 2 also builds the receipt-to-ledger posting
  pipeline (approved receipt → `job_cost_ledger` row with a direct-cost
  category), so "actual direct cost to date" is complete from day one.
  Larger Stage 2.
- **(b) Phased scope**: Stage 2 ships the schema (all categories, ready to
  receive postings) and the formulas, but "actual direct cost to date"
  is computed from **labor only** until the receipt-posting pipeline is
  built as separate, explicitly-scoped follow-up work. Every UI surface
  showing earned completion %/earned revenue/recovered overhead is labeled
  "labor-only, materials/subs/equipment not yet posted" until that
  follow-up lands. Smaller Stage 2, but completion % will read low on any
  job with meaningful non-labor direct cost until the follow-up ships.

I've made every other decision below on the assumption that this gets
answered before Stage 2 starts; the schema in §4 works either way (it holds
all categories regardless of which posting pipelines exist yet).

> **Resolved 2026-08-25 — (a) Full scope.** Tyler's 2026-08-25 autonomy
> mandate decided this in favor of full scope: Stage 2 builds the
> receipt-to-ledger posting pipeline in the same effort, not as a deferred
> follow-up. See `migrations/0085_job_budget_change_orders.sql`'s own header
> comment ("Tyler's 2026-08-25 autonomy mandate resolved §3 in favor of
> building the posting pipeline in this same effort, not as a deferred
> follow-up") and `docs/PUNCHLIST.md`'s "SUPERSEDED 2026-08-25 by Tyler's
> final Item 4 formula decision" note. The two options above are kept as-is
> for the historical reasoning; option (a) is the one that shipped.

---

## 4. Migration design

Everything below is proposed DDL for a new migration file
(`migrations/0085_job_budget_change_orders.sql` — next number after `0084`).
Nothing in this section has been run. Following this repo's established
pattern (see `0083`, `0016`+`0017`): additive `CREATE TABLE` /
`ALTER TABLE ... ADD COLUMN` only, no `DROP`/data-loss steps, comments
explaining *why* each piece exists.

### 4.1 `change_orders`

```sql
CREATE TABLE change_orders (
  id                          TEXT PRIMARY KEY,
  company_id                  TEXT NOT NULL,
  job_id                      TEXT NOT NULL REFERENCES work_orders(id),
  estimate_id                 TEXT REFERENCES estimates(id),      -- nullable: a CO can exist before/without a fresh estimate revision
  customer_id                 TEXT,                                -- denormalized for reporting; not authoritative (clients.id is)
  status                      TEXT NOT NULL DEFAULT 'draft'
                                CHECK (status IN ('draft','pending','approved','rejected','void')),
  revenue_adjustment_cents    INTEGER NOT NULL DEFAULT 0,          -- signed: + adds revenue, - reduces it
  direct_cost_adjustment_cents INTEGER NOT NULL DEFAULT 0,         -- signed
  labor_hours_adjustment_hundredths INTEGER NOT NULL DEFAULT 0,    -- signed, HoursHundredths-shaped
  overhead_rate_snapshot      INTEGER,                             -- TenThousandths $/hr, the division overhead rate effective at approval — NULL until approved
  approved_at                 TEXT,                                -- NULL until status='approved'
  approved_by                 TEXT,                                -- reps.id; NULL until approved
  effective_date              TEXT,                                -- date the adjustment takes effect for formula purposes (may differ from approved_at)
  description                 TEXT NOT NULL DEFAULT '',
  reason                      TEXT DEFAULT '',
  created_by                  TEXT NOT NULL,
  created_at                  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at                  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_change_orders_job ON change_orders(company_id, job_id);
CREATE INDEX idx_change_orders_status ON change_orders(company_id, status);
```

Only `status='approved'` rows ever feed a formula — enforced in application
code (every read helper in §5 filters `WHERE status='approved'`), not by a
trigger, matching how this codebase already gates by status everywhere else
(e.g. `estimates.status='accepted'`, `invoices` status filters).

### 4.2 `job_budget_versions` ("approved budget versions")

One row per approved baseline or approved-change-order revision. Never
updated in place — a new revision is a new row, same immutability
convention as `labor_rate_profile`/`equipment_rate_profile`
(`effective_from`/`effective_to`, SCHEMA.md's stated hard rule).

```sql
CREATE TABLE job_budget_versions (
  id                              TEXT PRIMARY KEY,
  company_id                      TEXT NOT NULL,
  job_id                          TEXT NOT NULL REFERENCES work_orders(id),
  source_type                     TEXT NOT NULL CHECK (source_type IN ('estimate','change_order')),
  source_id                       TEXT NOT NULL,               -- estimates.id or change_orders.id
  revision_seq                    INTEGER NOT NULL,            -- 0 = original baseline, 1,2,3... = each approved revision in order
  contract_value_cents            INTEGER NOT NULL,            -- cumulative, i.e. already includes this and all prior revisions
  -- Direct-cost budget, broken out by category (cumulative, same convention):
  labor_hours_budgeted_hundredths INTEGER NOT NULL DEFAULT 0,
  labor_rate_used                 INTEGER,                     -- TenThousandths $/hr, burdened rate used for this budget
  materials_budget_cents          INTEGER NOT NULL DEFAULT 0,
  subcontractor_budget_cents      INTEGER NOT NULL DEFAULT 0,
  equipment_budget_cents          INTEGER NOT NULL DEFAULT 0,
  disposal_budget_cents           INTEGER NOT NULL DEFAULT 0,
  permits_budget_cents            INTEGER NOT NULL DEFAULT 0,
  other_direct_budget_cents       INTEGER NOT NULL DEFAULT 0,
  direct_cost_budget_cents        INTEGER NOT NULL,            -- = labor $ (hours*rate) + materials + subs + equipment + disposal + permits + other; stored, not recomputed, so a later rate-table change never silently reshapes an old budget
  division                        TEXT NOT NULL,               -- crews.division at time of approval, drives the overhead-rate lookup below
  overhead_rate_used              INTEGER NOT NULL,            -- TenThousandths $/hr, the division rate effective on approved_at — frozen, per Tyler's "store the rate used" requirement
  budgeted_overhead_cents         INTEGER NOT NULL,            -- labor_hours_budgeted x overhead_rate_used, stored
  target_margin_millionths        INTEGER,                     -- Millionths, nullable (not every job has one set)
  completion_method               TEXT NOT NULL DEFAULT 'cost_to_cost'
                                     CHECK (completion_method IN ('cost_to_cost','service_units','manual','completed')),
  service_units_planned           REAL,                        -- only meaningful when completion_method='service_units'
  approved_at                     TEXT NOT NULL,
  approved_by                     TEXT NOT NULL,
  created_at                      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX idx_job_budget_versions_seq ON job_budget_versions(company_id, job_id, revision_seq);
CREATE INDEX idx_job_budget_versions_job ON job_budget_versions(company_id, job_id);
```

"Revised contract value" and "revised budgeted direct cost" (§1) are always
just the latest `job_budget_versions` row for that job — no runtime
summation of the estimate + every change order needed, because each
revision already stores the cumulative total. This mirrors the existing
`labor_rate_profile` pattern (read the one row with `effective_to IS NULL`,
don't replay history) rather than inventing a new resolution style.

### 4.3 Completion/progress tracking on `work_orders`

```sql
ALTER TABLE work_orders ADD COLUMN completion_pct_millionths INTEGER DEFAULT NULL;
-- Manual override only (completion_method='manual'). NULL means "compute it",
-- a value means "trust this instead" — same NULL-means-compute convention
-- used elsewhere in this schema (e.g. custom_price on client_plan_subscriptions).

ALTER TABLE work_orders ADD COLUMN service_units_completed REAL DEFAULT NULL;
-- Only meaningful when the active job_budget_versions row has
-- completion_method='service_units'. Planned units live on the budget
-- version (service_units_planned); completed units live here because they
-- change continuously as work happens, unlike a budget figure.

ALTER TABLE work_orders ADD COLUMN financially_closed_at TEXT DEFAULT NULL;
-- Distinct from work_orders.status='completed' and finance_completed_at
-- (migrations/0057_finance_merge.sql) — those mark the *work* done.
-- financially_closed_at marks the *cost side* closed (no more direct-cost
-- postings expected), which is what forces completion to 1.00 per Tyler's
-- rule ("If a work order is formally completed and financially closed, set
-- completion to 1.00"). A job can be work-completed but not yet
-- financially closed (late vendor bills still expected).
```

### 4.4 `job_cost_ledger` — direct-cost category + progress eligibility + change-order linkage

```sql
-- SQLite has no ALTER TABLE ... ADD CONSTRAINT; widening the line_type CHECK
-- requires the same recreate-and-copy pattern already used in this repo
-- (migrations/0003_add_company_id.sql, revenue_actuals_new). No data is
-- dropped; every existing row is copied through unchanged.
CREATE TABLE job_cost_ledger_new (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id            TEXT NOT NULL,
  time_entry_id         TEXT REFERENCES time_entries(id),      -- now nullable: non-labor postings (materials, subs, ...) have no time_entry
  job_id                TEXT NOT NULL REFERENCES work_orders(id),
  line_type             TEXT NOT NULL CHECK (line_type IN ('labor','overhead','direct_cost')),
  -- 'direct_cost' is the new bucket for materials/subs/equipment/disposal/
  -- permits/other; labor/overhead keep meaning exactly what they mean today
  -- (the two-line time-entry post). cost_category further classifies
  -- direct_cost rows; labor/overhead rows leave it NULL.
  cost_category         TEXT CHECK (cost_category IS NULL OR cost_category IN
                           ('materials','subcontractor','equipment','disposal','permits','other')),
  amount_cents          INTEGER NOT NULL,
  division               TEXT,
  progress_eligible     INTEGER NOT NULL DEFAULT 1,            -- Bool01. 0 = posted but excluded from earned-completion cost-to-cost math
  -- Tyler's rule: "Deposits, prepaid vendor amounts, and purchased-but-not-
  -- yet-installed materials should not advance completion." Rather than
  -- guess at that from amount/category, this is an explicit flag set by
  -- whoever posts the line (or by the receipt-approval UI once the
  -- receipt-to-ledger pipeline exists — see §3). Defaults to 1 (eligible)
  -- so today's labor/overhead postings are unaffected.
  change_order_id       TEXT REFERENCES change_orders(id),      -- NULL for lines not tied to a specific approved CO
  source_receipt_id     TEXT REFERENCES receipt(id),             -- NULL for labor/overhead lines; set for a direct_cost line posted from an approved receipt
  posted_at             TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT INTO job_cost_ledger_new
  (id, company_id, time_entry_id, job_id, line_type, amount_cents, division, posted_at)
  SELECT id, company_id, time_entry_id, job_id, line_type, amount_cents, division, posted_at
  FROM job_cost_ledger;
DROP TABLE job_cost_ledger;
ALTER TABLE job_cost_ledger_new RENAME TO job_cost_ledger;
CREATE INDEX idx_job_cost_ledger_job ON job_cost_ledger(company_id, job_id);
CREATE INDEX idx_job_cost_ledger_time_entry ON job_cost_ledger(time_entry_id);
CREATE INDEX idx_job_cost_ledger_change_order ON job_cost_ledger(change_order_id);
```

Every existing row survives with `cost_category=NULL`, `progress_eligible=1`,
`change_order_id=NULL`, `source_receipt_id=NULL` — behaviorally identical to
today until new columns get populated by new code paths.

### 4.5 `job_cost_ledger_adjustments` (generalizing migration `0083`'s pattern)

```sql
CREATE TABLE job_cost_ledger_adjustments (
  id                    TEXT PRIMARY KEY,
  company_id            TEXT NOT NULL,
  original_line_id      INTEGER NOT NULL REFERENCES job_cost_ledger(id),
  reversal_line_id      INTEGER NOT NULL REFERENCES job_cost_ledger(id),
  replacement_line_id   INTEGER REFERENCES job_cost_ledger(id),  -- NULL for a pure reversal/credit
  reason                TEXT NOT NULL,
  created_by            TEXT NOT NULL,
  created_at            TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_jcl_adjustments_original ON job_cost_ledger_adjustments(company_id, original_line_id);
```

A credit/refund/correction posts a reversal `job_cost_ledger` row (negative
`amount_cents`, same `job_id`/category) plus, if it's a correction rather
than a pure credit, a replacement row — exactly `time_entry_adjustments`'
shape, applied to any ledger line instead of only time-entry-sourced ones.
"Actual direct cost to date" sums `job_cost_ledger.amount_cents` directly,
so a posted reversal nets itself out with no special-case query logic.

---

## 5. Field/source mapping

| Formula | Reads from |
|---|---|
| 1. Revised contract value | `job_budget_versions` — latest row's `contract_value_cents`, for the job |
| 2. Revised budgeted direct cost | `job_budget_versions` — latest row's `direct_cost_budget_cents` |
| 3. Actual direct cost to date | `SUM(job_cost_ledger.amount_cents) WHERE job_id=? AND line_type IN ('labor','direct_cost') AND posted_at <= as_of` (overhead lines excluded per spec; reversals net out automatically since they're negative-amount rows in the same sum) |
| 4. Revised budgeted overhead | `job_budget_versions.budgeted_overhead_cents` (base) + `SUM(change_orders.labor_hours_adjustment_hundredths × change_orders.overhead_rate_snapshot)` for approved COs on the job, − any negative-adjustment COs (same sum, sign handles it) |
| 5. Earned completion % | `completion_method` from latest `job_budget_versions` row branches the calc:<br>• `cost_to_cost`: `SUM(job_cost_ledger WHERE progress_eligible=1 AND line_type IN ('labor','direct_cost')) / direct_cost_budget_cents`, capped `[0,1]`<br>• `service_units`: `work_orders.service_units_completed / job_budget_versions.service_units_planned`, capped<br>• `manual`: `work_orders.completion_pct_millionths / 1_000_000`<br>• `completed`: `1.00` if event/service marked done+approved (Snow: `work_orders.status='completed'` AND `financially_closed_at IS NOT NULL`), else `0`<br>Overridden to `1.00` regardless of method if `work_orders.financially_closed_at IS NOT NULL` (the "financially closed" rule) |
| 6. Earned revenue to date | Formula 1 × Formula 5 |
| 7. Recovered overhead to date | Formula 4 × Formula 5 |
| 8. Absorbed overhead to date | `SUM(job_cost_ledger WHERE line_type='overhead' AND posted_at <= as_of)` for the job — valid **only if** every overhead line was generated from approved hours at the effective rate, which is true today (`postTimeEntryToLedger` always posts overhead at `getLatestOverheadAllocationForDivision`'s rate). No new derivation needed; this is the one place the existing pipeline already matches the new spec exactly. |
| 9. Overhead recovery variance | Formula 7 − Formula 8 |

The company-level annual dashboard (`recovery_snapshot`, `RecoverySnapshot`,
`buildTenantRollup`) is untouched — it keeps reading
`tenant_finance_policy` + trailing time-entry hours + `overhead_allocation`
exactly as it does today. Job-level formulas above are new query functions,
proposed to live in a new `src/engines/job-progress.ts` (pure, like
`allocation.ts`/`recovery.ts`) plus a new `src/db/repos.ts` read section for
the new tables — no existing exported function changes signature.

---

## 6. Corrected/renamed existing fields

- `gather-inputs.ts`'s `budgeted_overhead_cents` (annual allocation ÷ 52) is
  a real, still-useful metric — the **company-wide weekly overhead
  target** — but must stop being called anything that implies it's a job's
  budgeted overhead. Rename to `weekly_budgeted_overhead_target_cents`
  wherever it's read (the `TenantRollupInput`/`TenantRollupResult`
  interfaces, and `absorption_variance_cents`'s inputs).
- `absorbed_overhead_cents` (trailing-7-day company-wide sum) stays valid as
  a **weekly absorbed-overhead metric** per Tyler's correction ("can remain
  ... only if the ledger's overhead entries are reliably generated from
  approved productive hours and the correct effective overhead rate" — true
  today, see formula 8's note above). No rename needed for this one; it was
  never mislabeled, only reused at the wrong granularity by
  `recovered_to_date_cents`.
- `recovered_to_date_cents` at the **company/tenant** level (feeding
  `recovery_snapshot.recovered_to_date_cents` and the annual `pct_recovered`)
  is unchanged — Tyler's correction section is explicit that the annual
  dashboard formula stays as-is. Only a *job-level* field of the same name
  would be wrong; there isn't one today, so nothing to rename there — the
  new job-level "recovered overhead to date" (formula 7) is a distinct,
  new, separately-named value (proposed field name:
  `job_recovered_overhead_cents`, to avoid ever colliding with the
  tenant-level column of a similar name).

---

## 7. Provisional-labeling (can happen independently of Stage 1/2 approval)

Per Tyler's explicit instruction — *"Do not treat the existing inferred
proxies as trusted financial results while this migration is pending. Label
them provisional or unavailable"* — this is scoped separately below as a
low-risk, immediately actionable, reversible change, since it touches only
copy/comments, not formulas:

- `docs/spec/RECOVERY.md`'s "Derivation confidence" section gets a note
  that `gather-inputs.ts`'s job-level-adjacent proxies are **superseded**
  by this document, not merely "inferred."
- `src/ui/job-costing.tsx` (job-costing page) — the only UI surface that
  currently implies job-level cost/margin — gets a visible "provisional"
  badge/note on the total-cost and margin tiles until formulas 1–9 are
  live, since today's total-cost figure is labor+overhead only (no
  materials/subs/etc.) and margin is estimate-minus-that, not the new
  earned-revenue-minus-actual-cost framing.
- `src/cron/gather-inputs.ts`'s file-level comment gets updated to point at
  this document instead of the old "reasonable proxies, not confirmed"
  wording, and the four fields get inline comments noting the rename/split
  from §6 as pending.

This can be done as a small, separate, low-risk PR ahead of or in parallel
with Stage 1 review, since it's copy-only and doesn't touch any formula
logic or schema.

---

## 8. Worked examples

### 8.1 Landscape Design/Build (`cost_to_cost`)

Job WO-9001, division `hardscape`. Original accepted estimate: contract
$40,000, direct-cost budget $24,000 (labor 300 hrs @ burdened $28/hr =
$8,400 + materials $12,000 + equipment $3,600), overhead rate at approval
$24.22/hr → budgeted overhead = 300 × $24.22 = $7,266.

Approved change order #1 (customer added a retaining wall section):
revenue +$6,000, direct-cost +$3,500, labor +40 hrs, overhead rate at CO
approval $24.22/hr (unchanged) → overhead adjustment = 40 × $24.22 = $968.80.

- Revised contract value = $40,000 + $6,000 = **$46,000**
- Revised budgeted direct cost = $24,000 + $3,500 = **$27,500**
- Revised budgeted overhead = $7,266.00 + $968.80 = **$8,234.80**
- Actual direct cost to date (mid-project, progress-eligible only —
  $2,000 of purchased-but-uninstalled stone excluded per the
  not-yet-earned rule): labor $9,100 + materials $8,400 (of $10,400 posted,
  $2,000 flagged `progress_eligible=0`) + equipment $2,100 = **$19,600**
- Earned completion % = $19,600 / $27,500 = **71.3%**
- Earned revenue to date = $46,000 × 0.713 = **$32,798**
- Recovered overhead to date = $8,234.80 × 0.713 = **$5,871.42**
- Absorbed overhead to date (from posted job_cost_ledger overhead lines,
  340 approved hrs × $24.22 effective rate) = **$8,234.80**
- Overhead recovery variance = $5,871.42 − $8,234.80 = **−$2,363.38**
  (job has absorbed more overhead than it has earned so far — expected
  mid-project before the last push of billable progress lands)

### 8.2 Recurring Maintenance (`service_units`)

Client plan subscription, monthly mow route, division `maintenance`.
Budget version: contract value $600/month, direct-cost budget $360/month
(labor only, no materials), `service_units_planned` = 4 (visits/month),
overhead rate $24.22/hr, budgeted labor hours 12/month → budgeted overhead
= 12 × $24.22 = $290.64.

Mid-month, 3 of 4 visits completed and approved
(`work_orders.service_units_completed = 3`).

- Revised contract value = **$600**
- Revised budgeted direct cost = **$360**
- Actual direct cost to date = 3 visits posted @ ~$90 labor each = **$270**
- Earned completion % = `service_units_completed / service_units_planned`
  = 3/4 = **75.0%** (NOT cost-to-cost — $270/$360 also happens to be 75%
  here only by coincidence of even visit costs; a maintenance route with
  uneven per-visit cost would diverge, which is exactly why
  `completion_method` must be selectable per job rather than always
  `cost_to_cost`)
- Earned revenue to date = $600 × 0.75 = **$450**
- Recovered overhead to date = $290.64 × 0.75 = **$217.98**
- Absorbed overhead to date = 9 posted hrs (3 visits × 3 hrs) × $24.22 =
  **$217.98** (matches exactly here because hours tracked linearly with
  visits — variance = $0)

### 8.3 Snow/event (`completed`)

Single snow-event work order, division `snow`. Budget version: contract
$800 (per-event flat rate), direct-cost budget $320 (labor: 10 hrs @
burdened $32/hr), overhead rate $24.22/hr → budgeted overhead = 10 × $24.22
= $242.20.

Event runs, crew logs 11 hrs (slightly over budget — heavier snowfall than
estimated), work order marked `status='completed'` and
`financially_closed_at` set once the last plow-truck fuel receipt posts.

- Revised contract value = **$800** (no change order — event scope didn't
  change, just took longer)
- Revised budgeted direct cost = **$320** (unchanged — an overrun in hours
  doesn't retroactively rewrite the budget; that's what the actual-vs-
  budget comparison is *for*)
- Actual direct cost to date = 11 hrs × $32 = **$352** (over budget by $32)
- Earned completion % = **100%**, forced by `completion_method='completed'`
  AND `financially_closed_at IS NOT NULL` — **not** `$352/$320` (which
  would be >100% and is exactly the "cost overruns do not push completion
  above 100%" case Tyler's spec calls out)
- Earned revenue to date = $800 × 1.00 = **$800**
- Recovered overhead to date = $242.20 × 1.00 = **$242.20**
- Absorbed overhead to date = 11 hrs × $24.22 = **$266.42**
- Overhead recovery variance = $242.20 − $266.42 = **−$24.22** (the event
  absorbed slightly more overhead than it recovered, because it ran long —
  correctly visible as a variance rather than hidden inside a >100%
  completion figure)

---

## 9. Test plan (Stage 2)

New `src/engines/job-progress.test.ts` (pure-function tests, mirroring
`allocation.test.ts`/`recovery.test.ts`) plus repo/e2e coverage:

1. **Change orders** — approved CO's revenue/cost/hours adjustments flow
   into revised contract value / budgeted direct cost / budgeted overhead;
   `draft`/`pending`/`rejected`/`void` COs are excluded entirely (zero
   effect on any formula).
2. **Credits/reversals** — a `job_cost_ledger_adjustments` reversal row
   (negative amount) reduces actual direct cost to date; the paired
   replacement (if any) is included at its own posted amount; a pure
   credit with no replacement nets to the original minus the credit only.
3. **Cost overruns** — actual direct cost > revised budgeted direct cost
   still caps earned completion % at exactly `1.00`, never fractionally
   above (mirrors worked example 8.3).
4. **Missing budgets** — no `job_budget_versions` row for a job (or
   `direct_cost_budget_cents = 0`) → earned completion % returns `null`,
   not a division-by-zero value or a silent `0`; caller surfaces "needs
   manual review."
5. **Completion caps** — `service_units_completed` slightly exceeding
   `service_units_planned` (e.g. an extra unscheduled visit) still caps at
   `1.00`, same rule as cost-to-cost.
6. **Closed work orders** — `financially_closed_at IS NOT NULL` forces
   `1.00` regardless of `completion_method` or the underlying cost/unit
   ratio, including when that ratio would otherwise read below 100% (e.g.
   a job closed with some budgeted spend never incurred).
7. **`progress_eligible=0` exclusion** — a posted `direct_cost` line
   flagged not-yet-earned (prepaid/purchased-but-uninstalled) is excluded
   from the cost-to-cost numerator but still included in "actual direct
   cost to date" for cost-tracking purposes — the two are deliberately
   different sums, tested separately so they can't silently collapse into
   one query by accident.
8. **Division-rate-at-CO-approval snapshot** — a CO approved after a
   division's overhead rate has since changed still uses the
   `overhead_rate_snapshot` frozen on the CO row, not today's rate, proving
   historical budgets don't drift when `overhead_allocation` gets a new
   row.

---

## 10. Existing-record migration plan

For every job with an accepted estimate today:

1. **Baseline row**: one `job_budget_versions` row, `revision_seq=0`,
   `source_type='estimate'`, `contract_value_cents = estimates.total`
   (cents-converted). `division` from `work_orders.crew_id → crews.division`
   (skip/flag if crew or division is null). `overhead_rate_used` = the
   `overhead_allocation` rate for that division at/before the estimate's
   `accepted_at` date (same lookup `gather-inputs.ts` already does for the
   blended rate, applied per-division here).
2. **Direct-cost budget breakdown**: `estimates.line_items` is an opaque
   blob with no category tags — **do not infer a materials/labor/subs split
   from it.** If the estimate's `subtotal` can be fully attributed to labor
   (i.e. the job has no receipt/vendor-cost history suggesting materials
   were ever separately budgeted), set `direct_cost_budget_cents` from
   `subtotal` with everything in `other_direct_budget_cents` and flag the
   row `needs_review=1` (new nullable column) rather than guessing category
   splits. **Never silently invent a labor/materials breakdown that wasn't
   in the source data.**
3. **`completion_method`**: default `cost_to_cost` for
   `work_orders.type IN ('Install','Service')`-flavored jobs; jobs linked
   to `recurring_plans`/`plan_visits` (via `plan_visits.work_order_id`) get
   `service_units` with `service_units_planned` backfilled from the plan's
   remaining scheduled visit count. Anything that can't be classified this
   way (ambiguous `type`, no recurring-plan link, no clean estimate figure)
   is flagged for the exception report below rather than defaulted silently.
4. **Skip, don't guess**: jobs with no accepted estimate, no
   `division` resolvable via crew, or a `direct_cost_budget_cents` that
   can't be attributed per step 2 get **no** `job_budget_versions` row at
   all — they surface in the exception report as "needs financial review,"
   exactly per Tyler's instruction, rather than getting a fabricated
   baseline.
5. **No historical change orders invented**: change orders only ever exist
   from the migration's run-date forward. A job's pre-migration history is
   represented entirely by its single baseline row; nothing retroactively
   splits an old estimate revision into a synthetic CO.
6. **Exception report**: a one-time query (not a stored table — a script
   run once at migration time, output reviewed by hand) listing every job
   that hit step 4's skip condition, with the specific reason
   (`no_accepted_estimate` / `no_division` / `ambiguous_direct_cost_split` /
   `no_completion_method_signal`), for Tyler/ops to work through manually.

**Implemented (Item 4 Stage 2, Phase 3): a report-only, zero-write preview
of this exception report.** `src/engines/backfill-analysis.ts`
(`classifyJobForBackfill`, `buildBackfillAnalysisReport`) plus
`src/db/repos.ts`'s `runBackfillAnalysis` implement exactly step 6's
exception-report query above — callable programmatically today, with
explicit tenant/`as_of` targeting — as 10 review buckets (the 4 named
reasons above, one additional implied failure mode
`no_overhead_rate_for_division` generalized from the same "skip, don't
guess" rule, `already_has_budget_version`, and 4 forward-compatibility
buckets that are currently unreachable — see that file's own comments for
the full reasoning). **This tool only ever issues `SELECT`s — it does not
create any `job_budget_versions` rows.**

**Update: Steps 1–5 above (the row-creating migration script itself) are
now also implemented** — `src/engines/backfill-write.ts` (Item 4 Stage 2,
Phase 2: the guarded §10 writing-backfill package) builds, tests, and
CLI-wraps exactly this script, with dry-run-by-default behavior, explicit
tenant/`as_of` targeting, a deterministic manifest hash/schema-version/
environment binding, expected-counts/staleness protection, transactional
batched writes, and idempotency/duplicate-prevention guards. It has been
smoke-tested against local D1 only. Per the standing production
restriction against any live backfill, **it has never been run with
`--remote --apply` against production, and will not be without separate,
explicit human sign-off** — that constraint is what remains true today,
not "unimplemented." See `docs/FINANCE-OS-COMPLETION-CHECKLIST.md` §2 for
the authoritative status tracking of this package.

---

## 11. Implementation sequence (recap)

1. **Stage 1 (this document)** — schema/migration design, completion-method
   support, worked examples, test plan. **Approved.**
2. **Stage 2 (approved 2026-08-25, §3 resolved as "full scope")** —
   `migrations/0085_job_budget_change_orders.sql`, `src/engines/job-progress.ts`,
   repo functions, rewritten `gather-inputs.ts` fields (renamed per §6), the
   receipt-to-ledger posting pipeline, and the full test suite per §9 have
   all landed. New UI surfaces for change-order entry/approval and
   budget-version review, and the guarded §10 writing-backfill package
   (`src/engines/backfill-write.ts`), have also landed and are tested —
   see `docs/FINANCE-OS-COMPLETION-CHECKLIST.md` for the authoritative,
   up-to-date tracking of exactly which pieces are built versus still open,
   and for the standing restriction on running any backfill against
   production.
