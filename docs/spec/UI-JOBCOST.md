# UI-JOBCOST

W4-jobcost-ui: "Job Costing — live margin, hours vs estimate, applied overhead,
and (Item 4 Stage 2) the nine approved job-costing formulas." Depends on
W3-posting and, for Stage 2, ITEM4-JOBCOST.md. Files: `src/ui/job-costing.tsx`,
`src/ui/job-costing.e2e.ts`.

Two data sources feed this page:

1. **Stage 1 (unchanged since W4):** `job_cost_ledger`'s posted labor/overhead
   lines (POSTING.md) plus a `work_item`/`work_orders` row for the estimate —
   the "applied overhead" tiles, "hours vs estimate," and "live margin" below.
2. **Stage 2 (Item 4, PR E):** `src/db/repos.ts`'s `getJobProgress`, which
   assembles the job's latest `job_budget_versions` row and every posted
   `job_cost_ledger` line into `src/engines/job-progress.ts`'s
   `computeJobProgress` — the pure function that implements all nine
   ITEM4-JOBCOST.md formulas. **The page renders this output directly; it
   never recomputes a formula itself** (§11's "no duplicated formula logic in
   the UI" requirement) — every number in the "Job progress (Item 4
   formulas)" card is `computeJobProgress`'s own return value, formatted only
   at the point of rendering.

## Stage 1: applied overhead, hours vs estimate, live margin

### Live margin
Reads `job_cost_ledger`'s two posted lines per `time_entry` (POSTING.md: labor line +
overhead line) and the job's billed/quoted amount (`work_item.estimate_cents`) to show
real-time margin as work is logged — "live" meaning it updates as new `time_entry` rows
post, not a batch/nightly figure like `recovery_snapshot`. Gated behind `can_see_margin`
(`src/ui/roles.ts`) — CLAUDE.md's one hard rule ("crew role: never render margin, wage,
or rate fields") is enforced here via `data-testid="margin-hidden"` for crew/crew_lead,
and `data-testid="margin-cents"` (present, `toHaveCount(0)` for crew) for office/owner.

### Hours vs estimate
Compares the work order's `estimate_cents` (via `getWorkItem`) against posted cost —
`data-testid="estimate-cents"`. **Needs Tyler:** job estimates live in the CRM's own
database; the cross-database join used here reads the finance-side work item as a
stand-in, not a real jobs/estimates table — this gap is unchanged from Stage 1's
original "Needs Tyler" note and is NOT resolved by Stage 2.

### Applied overhead
`data-testid="labor-cost"` / `"overhead-cost"` / `"total-cost"` — the labor+overhead-only
subset of `job_cost_ledger` for the job (POSTING.md/ALLOCATION.md), immutable once
posted. **Deliberately narrower than Stage 2's "actual direct cost to date" tile below**
— it excludes materials, subcontractor, equipment, disposal, and permit lines. This
scope difference is called out explicitly on the page itself via
`data-testid="jobcost-labor-overhead-note"` (see "Banner resolution" below).

## Stage 2: the nine Item 4 formulas (`data-testid="jobprogress-tiles"`)

Rendered inside a "Job progress (Item 4 formulas)" card, visible whenever `job_id` is
set and a job exists (`progress !== null`, i.e. `getJobProgress` returned a result —
it returns `null` only when the job itself isn't found under the tenant, not merely
when it has no budget version; see "Missing-input / review-required states" below).

| # | Tile | `data-testid` | Source field | Formula |
|---|------|---------------|---------------|---------|
| 1 | Revised contract value | `jp-revised-contract-value` | `revised_contract_value_cents` | baseline `contract_value_cents` + Σ approved COs' `revenue_adjustment_cents` |
| 2 | Revised budgeted direct cost | `jp-revised-direct-cost-budget` | `revised_budgeted_direct_cost_cents` | baseline `direct_cost_budget_cents` + Σ approved COs' `direct_cost_adjustment_cents` |
| 3 | Actual direct cost to date | `jp-actual-direct-cost` | `actual_direct_cost_to_date_cents` | Σ posted `labor`+`direct_cost` ledger lines (ALL, regardless of `progress_eligible`) |
| 3′| (sub-line under #3) | — | `progress_eligible_direct_cost_to_date_cents` | same filter, restricted to `progress_eligible=1` — the cost-to-cost numerator |
| 4 | Budgeted overhead | `jp-budgeted-overhead` | `revised_budgeted_overhead_cents` | baseline `budgeted_overhead_cents` + Σ approved COs' frozen `overhead_rate_snapshot` × `labor_hours_adjustment_hundredths` |
| 5 | Earned completion % | `jp-earned-completion` | `earned_completion.completion_millionths` | branches on `completion_method`; `financially_closed_at` forces 100% for every method (checked first) |
| 6 | Earned revenue to date | `jp-earned-revenue` | `earned_revenue_to_date_cents` | revised contract value (#1) × earned completion % (#5) |
| 7 | Recovered overhead to date | `jp-recovered-overhead` | `recovered_overhead_to_date_cents` | budgeted overhead (#4) × earned completion % (#5) |
| 8 | Absorbed overhead to date | `jp-absorbed-overhead` | `absorbed_overhead_to_date_cents` | Σ posted `overhead` ledger lines |
| 9 | Overhead recovery variance | `jp-overhead-variance` | `overhead_recovery_variance_cents` | recovered (#7) − absorbed (#8); negative means the job has absorbed more overhead than it has earned so far |

Money is rendered via `layout.tsx`'s `money()` helper (integer cents → `"$X,XXX.XX"`,
negative values render as `"$-X.XX"`, never a bare magnitude). Earned completion % is
rendered via this page's own `pct()` helper (`millionths / 10_000` → one decimal place,
e.g. `"71.3%"`) — the only formatting step applied to the engine's raw millionths
integer; no other rounding happens in the UI.

### Completion-method behavior (formula 5)
`earned_completion` branches on the job's `completion_method` (from its latest
`job_budget_versions` row), checked in this order:
1. **`financially_closed_at IS NOT NULL`** (any method): completion is forced to
   exactly 100.0%, regardless of the method's own ratio — even a `completed`-method
   job that ran over its labor-hours budget reads 100%, not a fabricated overrun
   percentage (worked example 8.3; `JP-E2E-05`).
2. **`cost_to_cost`**: `progress_eligible` direct cost to date ÷ revised budgeted
   direct cost, capped at 100%. Purchased-but-uninstalled materials
   (`progress_eligible=0`) are excluded from the numerator here but still counted in
   tile #3's all-inclusive total.
3. **`service_units`**: `work_orders.service_units_completed` ÷ the budget version's
   `service_units_planned`, capped at 100%.
4. **`manual`**: `work_orders.completion_pct_millionths`, capped at 100% — a direct
   operator-entered override, not derived from cost or units at all.
5. **`completed`** (flat-rate/event jobs): reads exactly 0% until financially closed
   (step 1 above) — no partial credit for an unclosed flat-rate job, by design.

### Missing-input / review-required states
Every formula whose inputs can be genuinely absent surfaces a **"review required"**
badge (`data-testid` = the formula's own tile id, containing `<span class="fin-badge
b-med">review required</span>`) instead of a fabricated number:

- **No `job_budget_versions` row at all** (`getJobProgress` still returns non-null —
  the job itself exists, just has no approved budget): tiles #1, #2, #4, #6, #7, #9
  all show "review required." Tile #5 (earned completion) shows its own **specific**
  reason text nested inside the `jp-earned-completion` element (not the generic
  badge alone) — one of `EarnedCompletionUnavailableReason`'s five literal values,
  each with dedicated copy in `job-costing.tsx`'s `UNAVAILABLE_REASON_COPY` map:
  - `no_budget_version` — "This job has no approved budget version yet — set one up in Change Orders."
  - `zero_direct_cost_budget` — cost_to_cost method, but the budget's direct-cost figure is $0.
  - `no_service_units_planned` — service_units method, but no units-planned figure is set.
  - `no_manual_override_set` — manual method, but no completion percentage entered yet.
  - `not_completed` — flat-rate/event job, not yet financially closed (reads 0%, which is a
    **legitimate zero**, not review-required — see below — but `unavailable_reason` is still
    set so the sub-line copy explains why).
  This map is a `Record<EarnedCompletionUnavailableReason, string>` — an exhaustive
  literal-key mapping that fails `npm run typecheck` if a sixth reason is ever added to
  the engine without a corresponding copy entry here.
- **Tiles #3 and #8 (actual/absorbed cost) are NEVER review-required** — they sum
  whatever `job_cost_ledger` lines exist for the job regardless of whether a budget
  version exists, and render as real (possibly $0.00) numbers always.
- The generic `ReviewRequired`/badge rendering path is a shared `FormulaTile`
  component: a tile's `value` prop is `string | null`; `null` renders the badge (with
  `sub`, if any, nested inside the same testid'd element), non-null renders the value.
  **Null-ness is the only discriminator** — there is no heuristic like "0 with no
  ledger lines"; a genuine `$0.00`/`0.0%` result from `computeJobProgress` is a real
  number and always renders as such (see next section).

### Legitimate-zero vs review-required
A job with an approved budget version and zero posted cost renders **real zeros**
(`$0.00`, `0.0%`, etc.) on every tile — not review-required badges. This is the
opposite failure mode from the missing-budget case above, and is exercised
end-to-end by `JP-E2E-07`. The discriminator is always the engine's own
`null`-vs-number return value, never a UI-side inference from "is everything zero."

### Job-level vs company-wide `budgeted_overhead_cents`
**Disambiguation, restated from ITEM4-JOBCOST.md §6:** `job_budget_versions.
budgeted_overhead_cents` (the source for tile #4, "Budgeted overhead" /
`jp-budgeted-overhead`) is a **job-level** field and was never renamed. The §6 rename
(`budgeted_overhead_cents` → `weekly_budgeted_overhead_target_cents`) applied only to
the unrelated **company-wide** field of the identical name in `src/cron/gather-
inputs.ts`/`rollup.ts` (the weekly company-wide overhead-recovery rollup, a
completely separate feature from this page). This page's tile #4 has always read,
and still reads, the job-level field under its original name.

### Role gating
- **`can_see_margin`** (unchanged from Stage 1) gates the "Live margin" card only.
- **`can_see_recovery`** gates tiles #7, #8, #9 (recovered/absorbed overhead,
  overhead variance) — the same gate `src/ui/recovery.tsx` (UI-RECOVERY.md) uses for
  the company-wide equivalent of these same figures. When hidden, a
  `data-testid="jobprogress-recovery-hidden"` empty-state note explains the gate
  instead of omitting the space silently.
- Tiles #1, #2, #3, #5, #6 (revised contract value, revised direct-cost budget,
  actual direct cost to date, earned completion %, earned revenue) are **NOT**
  gated — ROLES.md's crew restriction is scoped to "margin, wage, or rate fields"
  specifically; a job's revised budget or earned-completion progress is neither a
  margin figure, a wage, nor a rate. This is a documented inference (ROLES.md's own
  confidence-level note), not a CLAUDE.md-literal rule, and is worth revisiting if
  Tyler indicates otherwise.

### Banner resolution (§7)
Stage 1 originally carried a blanket `data-testid="jobcost-provisional-note"` banner
reading "Provisional — labor and overhead only... does not yet compute earned
completion %..." — placeholder language pending the Item 4 formulas. **That banner is
now removed entirely** (`JP-E2E-11` asserts `toHaveCount(0)`), since all nine
formulas are wired to `getJobProgress`, DB-tested (`job-progress-repos.test.ts`,
`job-costing.e2e.ts`), and missing inputs surface as review-required rather than
being silently omitted or defaulted.

In its place, a narrower, precise note remains — `data-testid=
"jobcost-labor-overhead-note"` — scoped only to the three Stage-1 "applied overhead"
tiles (`labor-cost`/`overhead-cost`/`total-cost`), which are deliberately still
labor+overhead-only (they do not include materials/subcontractor/equipment/
disposal/permit costs, unlike tile #3's all-inclusive "actual direct cost to date").
This is a real, permanent scope limitation of those three specific tiles — not a
placeholder awaiting future work — and the note says so explicitly, pointing the
reader to tile #3 for the full posted-cost figure.

### Remaining deferred limitations
- **"Hours vs estimate" cross-database join** (Stage 1's original "Needs Tyler"
  note): still unresolved. Job estimates live in the CRM's own database; no
  jobs/estimates table has been confirmed, so this reads the finance-side work item
  as a stand-in.
- **Tenant scoping / auth**: this page (like the rest of Finance OS's Wave 4 UI) reads
  `tenant_id`/`role` from query params via `readPageArgs` — a testing convenience
  documented in `src/ui/dev-server.ts`'s own file-level comment, not yet wired into
  the real app's session/auth stack. Server-side tenant scoping on every DB read
  (`getJobProgress`, `getJobCostLedgerForJob`, `getWorkItem`) is real and enforced;
  only the *caller's identity* (who is allowed to pass which `tenant_id`) is not yet
  gated by a real session.

## Derivation confidence
**Confident:** Stage 1's three data sources (`job_cost_ledger`, `time_entry.hours`,
applied overhead) and all nine Stage 2 formulas (grounded in ITEM4-JOBCOST.md,
verified against its three worked examples in `job-progress.test.ts` and
`job-progress-repos.test.ts`, and end-to-end in `job-costing.e2e.ts`).

**Inferred:** the job's "estimate" source (see "Hours vs estimate" above) and the
exact role-gating boundary for tiles #1/#2/#3/#5/#6 (see "Role gating" above) — both
carried over from Stage 1/ROLES.md's own documented inference-confidence notes,
neither resolved by Stage 2. **Needs Tyler:** confirm which existing CRM table holds
job estimates, and confirm whether revised-budget/earned-completion figures should
in fact be crew-visible as currently implemented.
