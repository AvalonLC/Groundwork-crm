import {
  getChangeOrder, getLatestJobBudgetVersion, getJobDivision,
  getLatestOverheadAllocationForDivision, approveChangeOrderAndCreateBudgetVersion,
} from "../db/repos";
import { computeRevisedBudgetFromChangeOrders, validateRevisedBudget } from "../engines/job-progress";
import type { BudgetComponents } from "../engines/job-progress";
import type { Cents, CompletionMethod, JobBudgetVersion } from "../db/schema";

export type ChangeOrderApprovalResult =
  | { success: true; budget_version_id: string; revision_seq: number }
  | {
      success: false;
      reason:
        | "not_found" // CO doesn't exist for this tenant
        | "not_pending" // CO.status !== 'pending' (already approved/rejected/void, or still draft — must be submitted first)
        | "no_division" // the job's crew has no division set — needed to resolve/stamp an overhead rate
        | "no_overhead_rate" // no overhead_allocation row exists yet for that division as of today
        | "invalid_completion_inputs" // e.g. completion_method='service_units' with no positive service_units_planned
        | "invalid_revised_budget" // validateRevisedBudget rejected the resulting cumulative totals (negative total)
        | "atomic_conflict"; // approveChangeOrderAndCreateBudgetVersion's batch returned false — concurrent approval / CO state changed between read and write
    };

/** Caller-supplied choices for the resulting job_budget_versions revision
 * that aren't derivable from the change_orders row itself — this is PR D's
 * "completion-method configuration" hook: every CO approval produces a
 * brand-new, full (not diffed) job_budget_versions row per
 * ITEM4-JOBCOST.md §4.2, so the approver names completion_method and
 * service_units_planned for THAT new row at the same moment, defaulting to
 * whatever the prior revision already had (see resolveCompletionInputs
 * below) rather than requiring a separate "configure completion method"
 * workflow bolted on afterward. No separate schema/route needed — see
 * change-orders.tsx's approve form, which renders exactly these two
 * fields, gated per-method, on the same form as every other approval. */
export interface CompletionConfigInput {
  completion_method: CompletionMethod;
  /** Required (validated) only when completion_method === 'service_units'.
   * Ignored for every other method — never silently used to compute a
   * ratio it doesn't apply to. */
  service_units_planned: number | null;
}

/** Carries forward the prior revision's completion configuration when the
 * approver's form doesn't explicitly override it (e.g. a CO that only
 * changes revenue, with no interest in touching how progress is measured)
 * — "preserve auditable history when a job's method/progress changes"
 * cuts both ways: an approver who changes nothing about the method must
 * see that nothing changed, not a silently reset default. Falls back to
 * 'cost_to_cost' (the DDL's own column DEFAULT) only when there is no
 * prior revision AT ALL — a job's first-ever budget version, created by
 * its first-ever approved CO (see the "no baseline yet" branch below;
 * this mirrors the existing approveChangeOrderAndCreateBudgetVersion test
 * in job-progress-repos.test.ts, which already exercises revision_seq=0
 * coming directly from a CO approval with no separate baseline insert). */
export function resolveCompletionInputs(
  prior: JobBudgetVersion | null,
  override: CompletionConfigInput | null,
): { completion_method: CompletionMethod; service_units_planned: number | null } {
  if (override) {
    return {
      completion_method: override.completion_method,
      service_units_planned: override.completion_method === "service_units" ? override.service_units_planned : null,
    };
  }
  if (prior) return { completion_method: prior.completion_method, service_units_planned: prior.service_units_planned };
  return { completion_method: "cost_to_cost", service_units_planned: null };
}

function validateCompletionInputs(input: { completion_method: CompletionMethod; service_units_planned: number | null }): boolean {
  if (input.completion_method === "service_units") {
    return input.service_units_planned !== null && input.service_units_planned > 0;
  }
  return true;
}

/**
 * The single authorized entry point for turning a 'pending' change order
 * into: (a) status='approved' with overhead_rate_snapshot frozen, and (b)
 * a brand-new, cumulative job_budget_versions revision — both atomically,
 * via the already-tested approveChangeOrderAndCreateBudgetVersion (never
 * re-implemented here). This function's own job is entirely upstream of
 * that atomic write: resolving division/overhead rate, computing the
 * cumulative totals via the pure engine, and validating them BEFORE they
 * are ever handed to an insert that can't be undone.
 *
 * Financial-integrity notes (mandate §2), each covered by an existing
 * mechanism this function calls rather than re-implements:
 *  - tenant ownership: every read below is company_id-scoped (getChangeOrder,
 *    getJobDivision, getLatestOverheadAllocationForDivision).
 *  - only a 'pending' CO can be approved: enforced twice — once here (early
 *    return) and again inside approveChangeOrderStatement's own WHERE
 *    clause (belt-and-suspenders against a race between this read and the
 *    eventual write).
 *  - atomic approval + budget-version creation, immune to duplicate/
 *    concurrent approval: delegated entirely to
 *    approveChangeOrderAndCreateBudgetVersion's db.batch() + `WHERE
 *    changes() > 0` guard (see repos.ts's own doc comment on that
 *    function) — if two requests race, at most one succeeds; the other
 *    lands here as "atomic_conflict", never a second budget-version row.
 *  - rejected/draft/pending COs never reach this far: gated by the
 *    not_pending check before any budget math happens.
 *  - invalid negative totals rejected: validateRevisedBudget, called on
 *    the computed cumulative totals, BEFORE the write.
 *  - integer cents / division-rate-at-approval snapshot: unchanged from
 *    the existing engine/repo layer — this function is a thin composition
 *    of already-tested pieces, not a new source of money math.
 */
export async function approveChangeOrderWorkflow(
  db: D1Database, companyId: string, changeOrderId: string, approvedBy: string,
  completionOverride: CompletionConfigInput | null,
  asOfDate: string,
): Promise<ChangeOrderApprovalResult> {
  const co = await getChangeOrder(db, companyId, changeOrderId);
  if (!co) return { success: false, reason: "not_found" };
  if (co.status !== "pending") return { success: false, reason: "not_pending" };

  const priorVersion = await getLatestJobBudgetVersion(db, companyId, co.job_id);

  const division = await getJobDivision(db, companyId, co.job_id);
  if (!division) return { success: false, reason: "no_division" };

  const overheadAllocation = await getLatestOverheadAllocationForDivision(db, companyId, division, asOfDate);
  if (!overheadAllocation) return { success: false, reason: "no_overhead_rate" };
  const overheadRateSnapshot = overheadAllocation.overhead_rate;

  const completion = resolveCompletionInputs(priorVersion, completionOverride);
  if (!validateCompletionInputs(completion)) return { success: false, reason: "invalid_completion_inputs" };

  const baseline: BudgetComponents = priorVersion
    ? {
        contract_value_cents: priorVersion.contract_value_cents,
        direct_cost_budget_cents: priorVersion.direct_cost_budget_cents,
        budgeted_overhead_cents: priorVersion.budgeted_overhead_cents,
      }
    : { contract_value_cents: 0, direct_cost_budget_cents: 0, budgeted_overhead_cents: 0 };

  // Synthetic "as if approved" input for the pure engine — the CO row
  // itself is still 'pending' in the DB at this point (approval hasn't
  // been written yet); computeRevisedBudgetFromChangeOrders only reads
  // the fields on this object, so marking status 'approved' here is
  // exactly what "the CO we are in the middle of approving" means for the
  // purposes of this one computation, not a claim about the DB's current
  // state.
  const revised = computeRevisedBudgetFromChangeOrders(baseline, [{
    status: "approved",
    revenue_adjustment_cents: co.revenue_adjustment_cents,
    direct_cost_adjustment_cents: co.direct_cost_adjustment_cents,
    labor_hours_adjustment_hundredths: co.labor_hours_adjustment_hundredths,
    overhead_rate_snapshot: overheadRateSnapshot,
  }]);

  const validation = validateRevisedBudget(revised);
  if (!validation.valid) return { success: false, reason: "invalid_revised_budget" };

  // Cumulative labor hours: prior revision's budgeted hours (0 if none)
  // plus this CO's own signed hours adjustment — same "cumulative, roll
  // forward" convention computeRevisedBudgetFromChangeOrders applies to
  // the three BudgetComponents fields, extended here to the hours column
  // (which that pure function doesn't itself track, since BudgetComponents
  // is deliberately only the three fields formulas 1/2/4 need).
  const laborHoursBudgetedHundredths =
    (priorVersion?.labor_hours_budgeted_hundredths ?? 0) + co.labor_hours_adjustment_hundredths;

  // A change order carries exactly one lump direct_cost_adjustment_cents —
  // it has no per-category (materials/subcontractor/equipment/disposal/
  // permits/other) breakdown in its own schema (migration 0085 §4.1: a
  // single signed column). Rather than guess a category split that isn't
  // in the source data (the same "never silently invent a breakdown"
  // principle ITEM4-JOBCOST.md §10 step 2 applies to estimate-derived
  // baselines), every CO-driven direct-cost delta is bucketed into
  // other_direct_budget_cents; the five explicitly-categorized columns
  // are carried forward unchanged from the prior revision. This is a
  // deliberate, documented interpretation (mandate: "document any
  // technical interpretation in code/tests"), not a data gap — the
  // formulas that matter (1/2/4/5) all read the summed
  // direct_cost_budget_cents column, never the per-category breakdown, so
  // nothing downstream is affected by which bucket the CO's lump total
  // lands in.
  const newRevision = {
    id: `jbv-${crypto.randomUUID().slice(0, 12)}`,
    company_id: companyId,
    job_id: co.job_id,
    source_type: "change_order" as const,
    source_id: co.id,
    revision_seq: priorVersion ? priorVersion.revision_seq + 1 : 0,
    contract_value_cents: asCents(revised.contract_value_cents),
    labor_hours_budgeted_hundredths: asHours(laborHoursBudgetedHundredths),
    labor_rate_used: priorVersion?.labor_rate_used ?? null,
    materials_budget_cents: asCents(priorVersion?.materials_budget_cents ?? 0),
    subcontractor_budget_cents: asCents(priorVersion?.subcontractor_budget_cents ?? 0),
    equipment_budget_cents: asCents(priorVersion?.equipment_budget_cents ?? 0),
    disposal_budget_cents: asCents(priorVersion?.disposal_budget_cents ?? 0),
    permits_budget_cents: asCents(priorVersion?.permits_budget_cents ?? 0),
    other_direct_budget_cents: asCents((priorVersion?.other_direct_budget_cents ?? 0) + co.direct_cost_adjustment_cents),
    direct_cost_budget_cents: asCents(revised.direct_cost_budget_cents),
    division,
    overhead_rate_used: overheadRateSnapshot,
    budgeted_overhead_cents: asCents(revised.budgeted_overhead_cents),
    target_margin_millionths: priorVersion?.target_margin_millionths ?? null,
    completion_method: completion.completion_method,
    service_units_planned: completion.service_units_planned,
    needs_review: 0 as const, // a CO is an explicit, complete, human-approved input — never an inferred/ambiguous one (needs_review is reserved for the §10 backfill script's own baseline rows).
    approved_at: new Date().toISOString(),
    approved_by: approvedBy,
  };

  // newRevision's money/hours fields are plain `number` here (computed from
  // BudgetComponents/engine output, which are deliberately branded-type-free
  // per job-progress.ts's own doc comment) — cast once at this boundary,
  // same "the repo layer is the brand checkpoint" convention already used
  // elsewhere (e.g. receipt-posting.ts's toCents), rather than threading
  // Cents/HoursHundredths through the engine layer.
  const ok = await approveChangeOrderAndCreateBudgetVersion(
    db, companyId, changeOrderId, approvedBy, overheadRateSnapshot,
    newRevision as unknown as Omit<JobBudgetVersion, "created_at">,
  );
  if (!ok) return { success: false, reason: "atomic_conflict" };

  return { success: true, budget_version_id: newRevision.id, revision_seq: newRevision.revision_seq };
}
