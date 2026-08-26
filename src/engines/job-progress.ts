import type { Bool01, CompletionMethod } from "../db/schema";

/**
 * Pure functions. No DB, no I/O, no tenant/company_id anywhere in this file
 * — every input is a plain value the caller (src/db/repos.ts's job-progress
 * read section, or a future API route) is responsible for fetching. See
 * docs/spec/ITEM4-JOBCOST.md §5 (field/source mapping) and §8 (worked
 * examples) and §9 (test plan) — every function here, and every branch in
 * it, maps to a specific line in one of those sections; see each function's
 * doc comment for the exact citation.
 *
 * Money is INTEGER cents throughout (same convention as the rest of the
 * codebase — D1/SQLite has no native decimal type). Percentages are
 * INTEGER millionths (1_000_000 = 100.000000%) for the same reason rates
 * are stored as TenThousandths elsewhere: floating-point completion % must
 * never silently drift across repeated reads.
 *
 * Rounding rule, applied consistently everywhere money changes by a
 * percentage (formula 6, 7, and the overhead-adjustment step inside
 * computeRevisedBudgetFromChangeOrders): `Math.round(cents * millionths /
 * 1_000_000)` — round-half-away-from-zero at the single point the value
 * becomes an integer-cents amount, never truncated, never rounded twice.
 *
 * "No substitution of invoiced revenue, cash collected, or amount_actual":
 * every dollar figure below is sourced only from job_budget_versions
 * (approved budget) and job_cost_ledger (posted cost) shaped inputs — there
 * is no parameter anywhere in this file for an invoice total, a payment, or
 * work_orders.amount_actual. A caller who wires one of those in by mistake
 * is doing it entirely on their own; nothing here reads or forwards them.
 */

export const MILLIONTHS_SCALE = 1_000_000;

/** Caps a raw (possibly-out-of-range) millionths value to [0, 1_000_000] —
 * "completion capped between 0% and 100%" (mandate), and ITEM4-JOBCOST.md
 * §9 tests 3 and 5 (cost overruns / service-unit overruns must never push
 * completion fractionally above 1.00). Rounds to the nearest whole
 * millionth so repeated reads of the same ledger state are byte-stable. */
export function capMillionths(raw: number): number {
  if (!Number.isFinite(raw)) return 0;
  return Math.max(0, Math.min(MILLIONTHS_SCALE, Math.round(raw)));
}

/** Single rounding point for "cents × a millionths percentage" — used by
 * formulas 6 and 7, and by the overhead-adjustment step below. Round-half-
 * away-from-zero via Math.round, applied exactly once. */
function applyMillionthsToCents(cents: number, millionths: number): number {
  return Math.round((cents * millionths) / MILLIONTHS_SCALE);
}

// ── Change-order roll-forward (feeds a new job_budget_versions revision) ───

/** The three cumulative budget figures a job_budget_versions row stores.
 * Deliberately not `JobBudgetVersion` itself (schema.ts) — this pure engine
 * takes only the fields it needs, decoupled from the DB row shape, same
 * convention as allocation.ts/recovery.ts taking plain input interfaces. */
export interface BudgetComponents {
  contract_value_cents: number;
  direct_cost_budget_cents: number;
  budgeted_overhead_cents: number;
}

/**
 * One approved-or-not change order's adjustment figures, as stored on the
 * change_orders row. `overhead_rate_snapshot` is null until the CO is
 * approved (schema.ts's ChangeOrder doc comment) — frozen at THIS CO's own
 * approval, per ITEM4-JOBCOST.md §9 test 8, never re-read from today's
 * overhead_allocation. `labor_hours_adjustment_hundredths` is signed
 * (HoursHundredths-shaped, ÷100 for hours) to match the DDL.
 */
export interface ChangeOrderAdjustmentInput {
  status: "draft" | "pending" | "approved" | "rejected" | "void";
  revenue_adjustment_cents: number;
  direct_cost_adjustment_cents: number;
  labor_hours_adjustment_hundredths: number;
  overhead_rate_snapshot: number | null; // TenThousandths $/hr, frozen at approval
}

/**
 * ITEM4-JOBCOST.md §5 formula 4's "base + SUM over approved COs" logic,
 * generalized to also roll forward contract value and direct-cost budget
 * (formulas 1 and 2's inputs) — used by the repo layer exactly once, at the
 * moment a new job_budget_versions revision is created (baseline row, or
 * each subsequent approved-CO row), never at read time. The resulting
 * revision is then stored as a new immutable cumulative row (schema.ts's
 * JobBudgetVersion doc comment: "no runtime summation" at read time) — this
 * function IS the one-time summation that produces that stored value.
 *
 * §9 test 1: draft/pending/rejected/void COs are filtered out entirely —
 * zero effect on any of the three totals.
 * §9 test 8: each CO's own overhead_rate_snapshot is used, frozen at that
 * CO's own approval — a later division-rate change can never reshape an
 * already-approved CO's contribution, since this function never reads a
 * "current" rate at all, only what's already stored on each CO row.
 */
export function computeRevisedBudgetFromChangeOrders(
  baseline: BudgetComponents,
  changeOrders: ChangeOrderAdjustmentInput[],
): BudgetComponents {
  let contractValueCents = baseline.contract_value_cents;
  let directCostBudgetCents = baseline.direct_cost_budget_cents;
  let budgetedOverheadCents = baseline.budgeted_overhead_cents;

  for (const co of changeOrders) {
    if (co.status !== "approved") continue; // test 1: non-approved COs never touch a total
    contractValueCents += co.revenue_adjustment_cents;
    directCostBudgetCents += co.direct_cost_adjustment_cents;
    if (co.overhead_rate_snapshot != null) {
      const hours = co.labor_hours_adjustment_hundredths / 100;
      const rateDollarsPerHr = co.overhead_rate_snapshot / 10_000;
      // Signed: a negative-hours CO (a scope reduction) reduces overhead the
      // same way a positive one adds it — "same sum, sign handles it" (§5).
      budgetedOverheadCents += Math.round(hours * rateDollarsPerHr * 100);
    }
  }

  return { contract_value_cents: contractValueCents, direct_cost_budget_cents: directCostBudgetCents, budgeted_overhead_cents: budgetedOverheadCents };
}

/**
 * PR D financial-integrity gate: "invalid negative totals or impossible
 * revised budgets are rejected" (mandate §2). Deliberately narrow — this is
 * NOT a business-judgment check (a shrinking budget from a scope-reduction
 * CO is legitimate and common), only a check that the three cumulative
 * totals a job_budget_versions row stores can never go negative, which
 * would be nonsensical for a "money owed"/"money budgeted" figure and
 * would corrupt every downstream formula (1, 2, 4, and everything chained
 * off them) for the rest of that job's life, since these rows are
 * immutable once written. Called by the approval route handler on the
 * result of computeRevisedBudgetFromChangeOrders, BEFORE it's ever passed
 * to approveChangeOrderAndCreateBudgetVersion — a caller that skips this
 * check and writes an impossible revision has no way to undo it afterward.
 */
export interface RevisedBudgetValidation {
  valid: boolean;
  errors: string[];
}

export function validateRevisedBudget(revised: BudgetComponents): RevisedBudgetValidation {
  const errors: string[] = [];
  if (revised.contract_value_cents < 0) {
    errors.push("Revised contract value cannot be negative.");
  }
  if (revised.direct_cost_budget_cents < 0) {
    errors.push("Revised budgeted direct cost cannot be negative.");
  }
  if (revised.budgeted_overhead_cents < 0) {
    errors.push("Revised budgeted overhead cannot be negative.");
  }
  return { valid: errors.length === 0, errors };
}

// ── Formulas 1, 2, 4: read the latest budget version (already cumulative) ──
// No live recompute at read time — see BudgetComponents' doc comment above.
// These three accessors exist mainly for null-safety/naming at every call
// site; a job with no job_budget_versions row at all returns null for all
// three (§9 test 4: "missing budgets" -> null, not a fabricated 0).

export function revisedContractValueCents(latest: BudgetComponents | null): number | null {
  return latest ? latest.contract_value_cents : null;
}

export function revisedBudgetedDirectCostCents(latest: BudgetComponents | null): number | null {
  return latest ? latest.direct_cost_budget_cents : null;
}

export function revisedBudgetedOverheadCents(latest: BudgetComponents | null): number | null {
  return latest ? latest.budgeted_overhead_cents : null;
}

// ── Formula 3 (and its progress-eligible variant) + formula 8 ──────────────

/** The three job_cost_ledger fields formula 3/8 need. Deliberately not the
 * full `JobCostLedger` row (schema.ts) for the same decoupling reason as
 * BudgetComponents above — this engine has no idea a `job_cost_ledger`
 * table exists. */
export interface LedgerLineForProgress {
  line_type: "labor" | "overhead" | "direct_cost";
  amount_cents: number;
  progress_eligible: Bool01;
}

/**
 * Formula 3: "actual direct cost to date" — every posted labor + direct_cost
 * line, overhead excluded, reversals netting out automatically since a
 * reversal is a same-shape negative-amount row already included in this sum
 * (§5, §9 test 2). This is the ALL-inclusive total (used for cost-tracking
 * displays), deliberately distinct from the cost_to_cost numerator below —
 * §9 test 7 requires these two sums never silently collapse into one query.
 */
export function computeActualDirectCostToDate(lines: LedgerLineForProgress[]): number {
  return lines
    .filter((l) => l.line_type === "labor" || l.line_type === "direct_cost")
    .reduce((sum, l) => sum + l.amount_cents, 0);
}

/**
 * The cost_to_cost numerator: same labor+direct_cost filter as formula 3,
 * further restricted to progress_eligible=1 lines only. A posted
 * progress_eligible=0 line (prepaid/deposit/purchased-but-uninstalled) is
 * excluded here but still counted in computeActualDirectCostToDate above —
 * §9 test 7's "deliberately different sums" requirement.
 */
export function computeProgressEligibleDirectCostToDate(lines: LedgerLineForProgress[]): number {
  return lines
    .filter((l) => (l.line_type === "labor" || l.line_type === "direct_cost") && l.progress_eligible === 1)
    .reduce((sum, l) => sum + l.amount_cents, 0);
}

/**
 * Formula 8: "absorbed overhead to date" — SUM of posted overhead lines.
 * Valid only because postTimeEntryToLedger (src/api/posting.ts) always
 * posts overhead at the effective division rate for approved hours — see
 * §5's note; this function doesn't re-derive that, it just sums what's
 * already there, which is the one place the existing pipeline already
 * matches the new spec exactly.
 */
export function computeAbsorbedOverheadToDate(lines: LedgerLineForProgress[]): number {
  return lines.filter((l) => l.line_type === "overhead").reduce((sum, l) => sum + l.amount_cents, 0);
}

// ── Formula 5: earned completion % ──────────────────────────────────────────

export type EarnedCompletionUnavailableReason =
  | "no_budget_version"
  | "zero_direct_cost_budget"
  | "no_service_units_planned"
  | "no_manual_override_set"
  | "not_completed";

export interface EarnedCompletionResult {
  /** Millionths, capped [0, 1_000_000]. Null means "unavailable" — the
   * caller must surface this honestly (needs manual review), never
   * substitute a 0 or drop the job from a rollup silently. */
  completion_millionths: number | null;
  /** Non-null exactly when completion_millionths is null OR is a
   * meaningful non-error 0 (the 'completed' method's "not yet done" case) —
   * lets the caller distinguish "0% earned, working normally" from "we
   * don't actually know". */
  unavailable_reason: EarnedCompletionUnavailableReason | null;
}

export interface EarnedCompletionInput {
  /** Null when the job has no job_budget_versions row at all (§9 test 4). */
  completion_method: CompletionMethod | null;
  /** Formula 2's output. Null/0 both count as "no usable budget" for
   * cost_to_cost (§9 test 4 — division by zero must never happen). */
  direct_cost_budget_cents: number | null;
  /** Formula 3's progress-eligible variant (this method's own numerator;
   * ignored by every other completion_method). */
  progress_eligible_direct_cost_to_date_cents: number;
  /** work_orders.service_units_completed. Null treated as 0 completed. */
  service_units_completed: number | null;
  /** The active job_budget_versions row's service_units_planned. */
  service_units_planned: number | null;
  /** work_orders.completion_pct_millionths — manual override, NULL means
   * "not set yet", never defaulted to 0 or 100 (schema.ts's NULL-means-
   * compute convention). */
  manual_completion_pct_millionths: number | null;
  /** work_orders.status === 'completed'. */
  work_order_completed: boolean;
  /** work_orders.financially_closed_at IS NOT NULL. */
  financially_closed: boolean;
}

/**
 * Formula 5, branching on completion_method exactly per §5's table, plus
 * the financially_closed override (checked first, applies to every method —
 * §9 test 6: a closed work order reads 1.00 even if its own method's ratio
 * would read lower). §9 test 3/5: cost_to_cost and service_units both cap at
 * exactly 1.00 via capMillionths, never fractionally above regardless of
 * how far over budget/plan the actuals run (worked example 8.3).
 */
export function computeEarnedCompletion(i: EarnedCompletionInput): EarnedCompletionResult {
  if (i.financially_closed) {
    return { completion_millionths: MILLIONTHS_SCALE, unavailable_reason: null };
  }

  if (i.completion_method === null) {
    return { completion_millionths: null, unavailable_reason: "no_budget_version" };
  }

  switch (i.completion_method) {
    case "cost_to_cost": {
      if (i.direct_cost_budget_cents === null || i.direct_cost_budget_cents <= 0) {
        return { completion_millionths: null, unavailable_reason: "zero_direct_cost_budget" };
      }
      const raw = (i.progress_eligible_direct_cost_to_date_cents / i.direct_cost_budget_cents) * MILLIONTHS_SCALE;
      return { completion_millionths: capMillionths(raw), unavailable_reason: null };
    }
    case "service_units": {
      if (i.service_units_planned === null || i.service_units_planned <= 0) {
        return { completion_millionths: null, unavailable_reason: "no_service_units_planned" };
      }
      const completed = i.service_units_completed ?? 0;
      const raw = (completed / i.service_units_planned) * MILLIONTHS_SCALE;
      return { completion_millionths: capMillionths(raw), unavailable_reason: null };
    }
    case "manual": {
      if (i.manual_completion_pct_millionths === null) {
        return { completion_millionths: null, unavailable_reason: "no_manual_override_set" };
      }
      return { completion_millionths: capMillionths(i.manual_completion_pct_millionths), unavailable_reason: null };
    }
    case "completed": {
      // Spec: "1.00 if event/service marked done+approved (status='completed'
      // AND financially_closed_at IS NOT NULL), else 0." financially_closed
      // is already false in every path that reaches this branch (checked
      // above), so the AND can never be satisfied here — this method
      // genuinely reads 0 until the job is financially closed, which is the
      // intended "no partial credit for an unclosed flat-rate event"
      // behavior (worked example 8.3). unavailable_reason is always
      // "not_completed" in this branch (not conditioned on
      // work_order_completed) — a work order marked status='completed' but
      // not yet financially closed is still, for revenue-earning purposes,
      // "not completed" per the spec's AND condition.
      return { completion_millionths: 0, unavailable_reason: "not_completed" };
    }
  }
}

// ── Formulas 6, 7, 9 ─────────────────────────────────────────────────────────

/** Formula 6: earned revenue to date = revised contract value × earned
 * completion %. Null propagates from either missing input — never silently
 * treated as $0 earned on an unavailable completion %. */
export function computeEarnedRevenueToDate(
  revisedContractValueCentsIn: number | null, completionMillionths: number | null,
): number | null {
  if (revisedContractValueCentsIn === null || completionMillionths === null) return null;
  return applyMillionthsToCents(revisedContractValueCentsIn, completionMillionths);
}

/** Formula 7: recovered overhead to date = revised budgeted overhead ×
 * earned completion %. */
export function computeRecoveredOverheadToDate(
  revisedBudgetedOverheadCentsIn: number | null, completionMillionths: number | null,
): number | null {
  if (revisedBudgetedOverheadCentsIn === null || completionMillionths === null) return null;
  return applyMillionthsToCents(revisedBudgetedOverheadCentsIn, completionMillionths);
}

/**
 * Formula 9: overhead recovery variance = recovered − absorbed. Sign
 * convention is deliberately "recovered minus absorbed" (reversed from the
 * old company-wide `absorbed − budgeted`, per §1's table) — a negative
 * result means the job has absorbed MORE overhead than it has earned so
 * far (expected mid-project, worked example 8.1), a positive result means
 * it's ahead of its overhead absorption relative to progress.
 */
export function computeOverheadRecoveryVariance(
  recoveredOverheadToDateCents: number | null, absorbedOverheadToDateCents: number,
): number | null {
  if (recoveredOverheadToDateCents === null) return null;
  return recoveredOverheadToDateCents - absorbedOverheadToDateCents;
}

// ── Composite: all nine formulas from one call, for a single job/as-of ─────

export interface JobProgressInput {
  /** Latest job_budget_versions row for the job, already cumulative. Null
   * if the job has none yet (§9 test 4). */
  latestBudgetVersion: BudgetComponents | null;
  completionMethod: CompletionMethod | null;
  serviceUnitsPlanned: number | null;
  serviceUnitsCompleted: number | null;
  manualCompletionPctMillionths: number | null;
  workOrderCompleted: boolean;
  financiallyClosed: boolean;
  /** Every posted job_cost_ledger line for the job, as of the caller's
   * as_of cutoff (the repo layer applies `posted_at <= as_of`, per §5 —
   * this engine has no clock and no concept of "as of", it just sums
   * whatever list it's handed). */
  ledgerLines: LedgerLineForProgress[];
}

export interface JobProgressResult {
  revised_contract_value_cents: number | null; // formula 1
  revised_budgeted_direct_cost_cents: number | null; // formula 2
  actual_direct_cost_to_date_cents: number; // formula 3
  progress_eligible_direct_cost_to_date_cents: number; // formula 3's cost_to_cost numerator
  revised_budgeted_overhead_cents: number | null; // formula 4
  earned_completion: EarnedCompletionResult; // formula 5
  earned_revenue_to_date_cents: number | null; // formula 6
  recovered_overhead_to_date_cents: number | null; // formula 7
  absorbed_overhead_to_date_cents: number; // formula 8
  overhead_recovery_variance_cents: number | null; // formula 9
}

/** Runs all nine formulas for one job as of one point in time (implied by
 * the caller's `ledgerLines` cutoff). Pure — see the file-level doc comment
 * for why nothing here touches a database, an invoice, or amount_actual. */
export function computeJobProgress(i: JobProgressInput): JobProgressResult {
  const revisedContractValue = revisedContractValueCents(i.latestBudgetVersion);
  const revisedDirectCostBudget = revisedBudgetedDirectCostCents(i.latestBudgetVersion);
  const revisedBudgetedOverhead = revisedBudgetedOverheadCents(i.latestBudgetVersion);

  const actualDirectCostToDate = computeActualDirectCostToDate(i.ledgerLines);
  const progressEligibleDirectCostToDate = computeProgressEligibleDirectCostToDate(i.ledgerLines);
  const absorbedOverheadToDate = computeAbsorbedOverheadToDate(i.ledgerLines);

  const earnedCompletion = computeEarnedCompletion({
    completion_method: i.completionMethod,
    direct_cost_budget_cents: revisedDirectCostBudget,
    progress_eligible_direct_cost_to_date_cents: progressEligibleDirectCostToDate,
    service_units_completed: i.serviceUnitsCompleted,
    service_units_planned: i.serviceUnitsPlanned,
    manual_completion_pct_millionths: i.manualCompletionPctMillionths,
    work_order_completed: i.workOrderCompleted,
    financially_closed: i.financiallyClosed,
  });

  const earnedRevenueToDate = computeEarnedRevenueToDate(revisedContractValue, earnedCompletion.completion_millionths);
  const recoveredOverheadToDate = computeRecoveredOverheadToDate(revisedBudgetedOverhead, earnedCompletion.completion_millionths);
  const overheadRecoveryVariance = computeOverheadRecoveryVariance(recoveredOverheadToDate, absorbedOverheadToDate);

  return {
    revised_contract_value_cents: revisedContractValue,
    revised_budgeted_direct_cost_cents: revisedDirectCostBudget,
    actual_direct_cost_to_date_cents: actualDirectCostToDate,
    progress_eligible_direct_cost_to_date_cents: progressEligibleDirectCostToDate,
    revised_budgeted_overhead_cents: revisedBudgetedOverhead,
    earned_completion: earnedCompletion,
    earned_revenue_to_date_cents: earnedRevenueToDate,
    recovered_overhead_to_date_cents: recoveredOverheadToDate,
    absorbed_overhead_to_date_cents: absorbedOverheadToDate,
    overhead_recovery_variance_cents: overheadRecoveryVariance,
  };
}
