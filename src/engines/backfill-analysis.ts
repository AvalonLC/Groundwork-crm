/**
 * Pure functions. No DB, no I/O, no tenant/company_id anywhere in this file
 * — every input is a plain value the caller (src/db/repos.ts's backfill-
 * analysis read section) is responsible for fetching. Same architectural
 * convention as src/engines/job-progress.ts.
 *
 * Phase 3 of the Item 4 Stage 2 mandate: a REPORT-ONLY, ZERO-WRITE analysis
 * of what the real §10 existing-record migration script (docs/spec/
 * ITEM4-JOBCOST.md §10, still unimplemented/unscheduled) WOULD do to each
 * job, without ever creating a job_budget_versions row itself. This file
 * answers "which of the 10 review buckets does this job fall into," never
 * "insert a baseline row" — that is a deliberately separate, future,
 * explicitly-approved effort (§10's own migration script), not this one.
 *
 * §10's exact rules this classifier implements:
 *   1. Baseline row needs: an accepted estimate, a resolvable division
 *      (work_orders.crew_id -> crews.division), and an overhead_allocation
 *      rate for that division at/before the estimate's accepted_at date.
 *   2. Direct-cost split: NEVER infer a materials/labor/subs split from
 *      estimates.line_items. If there is no receipt/vendor-cost history
 *      suggesting materials were ever separately budgeted, the whole
 *      subtotal can be attributed to labor — but that row still must be
 *      flagged needs_review=1 (never a silent, confident split). If there
 *      IS such evidence, the split is ambiguous and the job is skipped
 *      entirely (§10 step 4) rather than guessed.
 *   3. completion_method: cost_to_cost default for Install/Service-typed
 *      jobs; service_units for jobs linked to recurring_plans/plan_visits.
 *      A recurring-plan link is treated as the more specific signal and
 *      takes priority over the type-based cost_to_cost default when a job
 *      has both (spec lists the plan-link rule as an override, not a
 *      fallback). Anything resolving to neither is skipped
 *      (no_completion_method_signal).
 *   4. Skip, don't guess: no_accepted_estimate / no_division /
 *      ambiguous_direct_cost_split / no_completion_method_signal jobs get
 *      NO baseline row in the real backfill and must not get one predicted
 *      here either.
 *   5. Idempotency: a job that already has ANY job_budget_versions row
 *      (baseline or otherwise) is out of scope for a *baseline* backfill
 *      entirely — the real script must never touch it, so this report
 *      buckets it separately rather than re-evaluating §10 rules against it.
 *
 * The 10 buckets (checked in this exact order — mutually exclusive,
 * exhaustive; every job lands in exactly one):
 *   1. already_has_budget_version        — idempotency short-circuit
 *   2. no_accepted_estimate              — §10 skip reason 1
 *   3. no_division                       — §10 skip reason 2
 *   4. no_overhead_rate_for_division     — a real "can't build the row
 *                                          without inventing a rate" case;
 *                                          not one of §10's 4 *named*
 *                                          reasons but governed by the same
 *                                          "skip, don't guess" rule (§10
 *                                          step 4's rule, generalized to a
 *                                          failure mode the doc's prose
 *                                          didn't enumerate by name).
 *   5. ambiguous_direct_cost_split       — §10 skip reason 3
 *   6. no_completion_method_signal       — §10 skip reason 4
 *   7. would_create_clean_cost_to_cost   — full success, needs_review=0
 *   8. would_create_clean_service_units  — full success, needs_review=0
 *   9. would_create_needs_review_cost_to_cost    — success but needs_review=1
 *  10. would_create_needs_review_service_units   — success but needs_review=1
 */

export type BackfillBucket =
  | "already_has_budget_version"
  | "no_accepted_estimate"
  | "no_division"
  | "no_overhead_rate_for_division"
  | "ambiguous_direct_cost_split"
  | "no_completion_method_signal"
  | "would_create_clean_cost_to_cost"
  | "would_create_clean_service_units"
  | "would_create_needs_review_cost_to_cost"
  | "would_create_needs_review_service_units";

/** Ordered, exhaustive list — used both to drive the priority-checked
 * classification below and to seed a zero-initialized bucket-count map so
 * a report always shows all 10 buckets, even the ones with zero jobs in
 * them (a bucket silently missing from the output is indistinguishable
 * from "not implemented yet," which this report must never be). */
export const BACKFILL_BUCKETS: readonly BackfillBucket[] = [
  "already_has_budget_version",
  "no_accepted_estimate",
  "no_division",
  "no_overhead_rate_for_division",
  "ambiguous_direct_cost_split",
  "no_completion_method_signal",
  "would_create_clean_cost_to_cost",
  "would_create_clean_service_units",
  "would_create_needs_review_cost_to_cost",
  "would_create_needs_review_service_units",
] as const;

/** The one usable accepted estimate for a job, already resolved by the
 * caller (src/db/repos.ts) to a single row per job — deterministic
 * tie-break rules for "which estimate if more than one is accepted" are a
 * DB-layer concern (see getAcceptedEstimateForJob's own doc comment), not
 * this pure engine's. `total_cents`/`accepted_at` are nullable here
 * specifically to model a MALFORMED accepted-estimate row (status=
 * 'accepted' but missing the figures a baseline needs) — see
 * classifyJobForBackfill's malformed-record handling below. */
export interface ResolvedAcceptedEstimate {
  id: string;
  total_cents: number | null;
  accepted_at: string | null;
}

/** Plain-value shape of everything the classifier needs to know about one
 * candidate job (a work_orders row). Decoupled from any DB row shape —
 * same convention as job-progress.ts's BudgetComponents. */
export interface JobBackfillAnalysisInput {
  job_id: string;
  /** True if job_budget_versions already has >=1 row for this job (any
   * revision, any source_type) — checked first, short-circuits everything
   * else per the idempotency rule above. */
  already_has_budget_version: boolean;
  /** Null when no estimates row for this job has status='accepted' at all
   * (§10 skip reason 1's clean case). */
  accepted_estimate: ResolvedAcceptedEstimate | null;
  /** crews.division resolved via work_orders.crew_id, already validated
   * non-null/non-empty by the caller. Null/empty here means unresolved —
   * crew_id was null, the crew row didn't exist, or crews.division was
   * itself null/empty. */
  division: string | null;
  /** Whether an overhead_allocation row exists for `division` at or before
   * accepted_estimate.accepted_at (irrelevant/false when there's no usable
   * accepted estimate or no division — the classifier never reaches this
   * check in that case, but the field stays required so a caller can't
   * accidentally omit doing the lookup). */
  overhead_rate_available: boolean;
  /** True when the job has any receipt/vendor-cost history suggesting
   * materials/subs/equipment were ever separately budgeted for it — the
   * §10 step 2 "evidence that rules out a clean fully-labor split." False
   * means the estimate subtotal can be safely attributed entirely to
   * labor (still needs_review=1, never a confident split). */
  has_non_labor_cost_evidence: boolean;
  /** work_orders.type, e.g. 'Install' | 'Service' | 'Maintenance' | ... —
   * used for the cost_to_cost default. Null/empty is treated as
   * unresolved (not one of the recognized flavors). */
  work_order_type: string | null;
  /** True when this job has a plan_visits row with work_order_id = job_id
   * (i.e. it's linked to a recurring_plans subscription). Takes priority
   * over the type-based cost_to_cost default per this file's header
   * comment. */
  has_recurring_plan_link: boolean;
}

export type ResolvedCompletionMethod = "cost_to_cost" | "service_units" | null;

export interface JobBackfillClassification {
  job_id: string;
  bucket: BackfillBucket;
  /** Human-readable reasons this job landed in this bucket — always at
   * least one entry, may be more than one for a skip bucket that was hit
   * for compounding reasons (the FIRST reason in priority order is always
   * present; a report reader should not need to guess why). */
  reasons: string[];
  /** True only for the two would_create_needs_review_* buckets — lets a
   * caller answer "review required, visible" without string-matching the
   * bucket name. */
  would_need_review: boolean;
  /** The completion_method the real backfill would use, or null when the
   * job was skipped before completion-method resolution was reached (or
   * genuinely has no resolvable signal). */
  resolved_completion_method: ResolvedCompletionMethod;
}

const INSTALL_SERVICE_TYPES = new Set(["Install", "Service"]);

/**
 * Classifies exactly one job into exactly one of the 10 buckets above.
 * Never throws on a malformed/incomplete input — every field is treated
 * defensively (missing/invalid data routes to the most specific matching
 * skip bucket rather than crashing the whole report over one bad row; see
 * inline comments below for each defensive branch).
 */
export function classifyJobForBackfill(input: JobBackfillAnalysisInput): JobBackfillClassification {
  const { job_id } = input;

  // 1. Idempotency short-circuit — a job that already has a budget version
  // is entirely out of scope for a *baseline* backfill; nothing else about
  // it matters for this report.
  if (input.already_has_budget_version) {
    return {
      job_id,
      bucket: "already_has_budget_version",
      reasons: ["job already has at least one job_budget_versions row — baseline backfill would not touch it"],
      would_need_review: false,
      resolved_completion_method: null,
    };
  }

  // 2. No accepted estimate — includes the malformed-record case where an
  // "accepted" estimate row exists but is missing the figures a baseline
  // needs (total_cents null/invalid, or accepted_at null/invalid): such a
  // row cannot honestly be called "usable," so it is treated exactly like
  // having no accepted estimate at all rather than crashing on a null.
  const est = input.accepted_estimate;
  const estimateUsable =
    est !== null &&
    typeof est.total_cents === "number" &&
    Number.isFinite(est.total_cents) &&
    est.total_cents >= 0 &&
    typeof est.accepted_at === "string" &&
    est.accepted_at.length > 0;
  if (!estimateUsable) {
    const reasons =
      est === null
        ? ["no estimate for this job has status='accepted'"]
        : ["an accepted estimate exists but is missing a usable total_cents/accepted_at — treated as unusable, not guessed"];
    return { job_id, bucket: "no_accepted_estimate", reasons, would_need_review: false, resolved_completion_method: null };
  }

  // 3. No division — crew_id null, crew not found, or crews.division
  // null/empty all collapse to the same unresolved state by the time this
  // input reaches the classifier (the DB layer's job).
  const division = input.division;
  if (division === null || division === "") {
    return {
      job_id,
      bucket: "no_division",
      reasons: ["work_orders.crew_id -> crews.division did not resolve to a usable division"],
      would_need_review: false,
      resolved_completion_method: null,
    };
  }

  // 4. No overhead rate available for that division at/before accepted_at.
  if (!input.overhead_rate_available) {
    return {
      job_id,
      bucket: "no_overhead_rate_for_division",
      reasons: [`no overhead_allocation rate found for division "${division}" at or before ${est!.accepted_at}`],
      would_need_review: false,
      resolved_completion_method: null,
    };
  }

  // 5. Ambiguous direct-cost split — receipt/vendor evidence rules out a
  // clean fully-labor attribution.
  if (input.has_non_labor_cost_evidence) {
    return {
      job_id,
      bucket: "ambiguous_direct_cost_split",
      reasons: ["receipt/vendor-cost history suggests a materials/subs/equipment split that cannot be safely inferred from the estimate alone"],
      would_need_review: false,
      resolved_completion_method: null,
    };
  }

  // 6. Completion-method resolution. Recurring-plan link takes priority
  // over the type-based default (see file header comment).
  let completionMethod: ResolvedCompletionMethod = null;
  if (input.has_recurring_plan_link) {
    completionMethod = "service_units";
  } else if (input.work_order_type && INSTALL_SERVICE_TYPES.has(input.work_order_type)) {
    completionMethod = "cost_to_cost";
  }
  if (completionMethod === null) {
    return {
      job_id,
      bucket: "no_completion_method_signal",
      reasons: [
        `work_orders.type ("${input.work_order_type ?? "null"}") is not Install/Service and no recurring-plan link was found`,
      ],
      would_need_review: false,
      resolved_completion_method: null,
    };
  }

  // 7-10. Would create a baseline row — needs_review is always true here
  // per §10 step 2 ("If ... fully attributed to labor ... flag the row
  // needs_review=1 ... rather than guessing category splits"): reaching
  // this point already means has_non_labor_cost_evidence was false, i.e.
  // exactly the "attribute the whole subtotal to labor" case §10
  // describes — which the doc itself says must ALWAYS be flagged
  // needs_review=1, never treated as a confident clean split. There is no
  // code path in §10 that produces needs_review=0: a truly itemized
  // materials/labor/subs split is never inferred from source data at all
  // (§10 step 2's "never silently invent" rule), so "clean" here means
  // "no other problem was found," not "the cost split is fully trusted."
  //
  // The would_create_clean_* buckets are kept in the 10-bucket taxonomy
  // for forward-compatibility (a future data source — e.g. itemized
  // line_items with real category tags — could make a genuinely clean,
  // needs_review=0 split possible without changing this classifier's
  // bucket set) but are UNREACHABLE under today's §10 rules; see this
  // file's test suite for an explicit assertion of that fact.
  return {
    job_id,
    bucket: completionMethod === "service_units" ? "would_create_needs_review_service_units" : "would_create_needs_review_cost_to_cost",
    reasons: ["no accepted-estimate/division/overhead-rate/cost-split/completion-method problems found; baseline row flagged needs_review=1 per §10 step 2's fully-labor-attribution rule"],
    would_need_review: true,
    resolved_completion_method: completionMethod,
  };
}

/** Summary shape for a whole tenant/as-of run — see src/db/repos.ts's
 * runBackfillAnalysis for the read-only DB orchestration that produces
 * this. Kept here (not in repos.ts) because building the summary from a
 * list of classifications is itself pure. */
export interface BackfillAnalysisReport {
  company_id: string;
  as_of: string;
  total_jobs_scanned: number;
  bucket_counts: Record<BackfillBucket, number>;
  jobs: JobBackfillClassification[];
}

/**
 * Pure aggregation: turns a list of per-job classifications into the full
 * report shape, always including all 10 buckets in bucket_counts (zero-
 * filled) so a bucket with no jobs in it is still visibly present rather
 * than absent. `total_jobs_scanned` and the sum of bucket_counts are
 * guaranteed equal by construction (every classification increments
 * exactly one bucket) — this is the "invariant totals" the test suite
 * checks are never violated.
 */
export function buildBackfillAnalysisReport(
  companyId: string,
  asOf: string,
  classifications: JobBackfillClassification[],
): BackfillAnalysisReport {
  const bucket_counts = Object.fromEntries(BACKFILL_BUCKETS.map((b) => [b, 0])) as Record<BackfillBucket, number>;
  for (const c of classifications) {
    bucket_counts[c.bucket] += 1;
  }
  return {
    company_id: companyId,
    as_of: asOf,
    total_jobs_scanned: classifications.length,
    bucket_counts,
    jobs: classifications,
  };
}
