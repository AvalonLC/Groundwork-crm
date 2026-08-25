import { describe, it, expect } from "vitest";
import {
  capMillionths,
  computeRevisedBudgetFromChangeOrders,
  computeActualDirectCostToDate,
  computeProgressEligibleDirectCostToDate,
  computeAbsorbedOverheadToDate,
  computeEarnedCompletion,
  computeEarnedRevenueToDate,
  computeRecoveredOverheadToDate,
  computeOverheadRecoveryVariance,
  computeJobProgress,
  MILLIONTHS_SCALE,
  type LedgerLineForProgress,
} from "./job-progress";

const toCents = (dollars: number) => Math.round(dollars * 100);

describe("capMillionths", () => {
  it("clamps below 0 and above 1_000_000", () => {
    expect(capMillionths(-500)).toBe(0);
    expect(capMillionths(1_200_000)).toBe(MILLIONTHS_SCALE);
    expect(capMillionths(500_000)).toBe(500_000);
  });
  it("non-finite input never propagates NaN", () => {
    expect(capMillionths(NaN)).toBe(0);
    expect(capMillionths(Infinity)).toBe(0);
  });
});

describe("JP-01 change orders (§9 test 1)", () => {
  const baseline = { contract_value_cents: toCents(40_000), direct_cost_budget_cents: toCents(24_000), budgeted_overhead_cents: toCents(7_266) };

  it("an approved CO's revenue/cost/hours adjustments flow into the revised totals", () => {
    const result = computeRevisedBudgetFromChangeOrders(baseline, [
      { status: "approved", revenue_adjustment_cents: toCents(6_000), direct_cost_adjustment_cents: toCents(3_500), labor_hours_adjustment_hundredths: 4000, overhead_rate_snapshot: 242200 },
    ]);
    expect(result.contract_value_cents).toBe(toCents(46_000));
    expect(result.direct_cost_budget_cents).toBe(toCents(27_500));
    // 40 hrs * $24.22/hr = $968.80 -> 96880 cents (worked example 8.1)
    expect(result.budgeted_overhead_cents).toBe(toCents(7_266) + 96880);
  });

  it("draft/pending/rejected/void COs are excluded entirely — zero effect", () => {
    for (const status of ["draft", "pending", "rejected", "void"] as const) {
      const result = computeRevisedBudgetFromChangeOrders(baseline, [
        { status, revenue_adjustment_cents: toCents(999_000), direct_cost_adjustment_cents: toCents(999_000), labor_hours_adjustment_hundredths: 999900, overhead_rate_snapshot: 242200 },
      ]);
      expect(result).toEqual(baseline);
    }
  });

  it("a negative-adjustment (scope-reduction) CO reduces every total via its own sign", () => {
    const result = computeRevisedBudgetFromChangeOrders(baseline, [
      { status: "approved", revenue_adjustment_cents: -toCents(1_000), direct_cost_adjustment_cents: -toCents(500), labor_hours_adjustment_hundredths: -1000, overhead_rate_snapshot: 242200 },
    ]);
    expect(result.contract_value_cents).toBe(toCents(39_000));
    expect(result.direct_cost_budget_cents).toBe(toCents(23_500));
    // -10 hrs * $24.22/hr = -$242.20 (not -$24.22 — that would be 1 hour,
    // not 10) -> 7266 - 242.20 = 7023.80
    expect(result.budgeted_overhead_cents).toBe(toCents(7_266) - toCents(242.20));
  });
});

describe("JP-02 credits/reversals (§9 test 2)", () => {
  it("a reversal (negative amount_cents) reduces actual direct cost to date", () => {
    const lines: LedgerLineForProgress[] = [
      { line_type: "direct_cost", amount_cents: toCents(500), progress_eligible: 1 },
      { line_type: "direct_cost", amount_cents: -toCents(500), progress_eligible: 1 }, // pure credit, no replacement
    ];
    expect(computeActualDirectCostToDate(lines)).toBe(0);
  });

  it("a reversal + replacement nets to the replacement's own posted amount", () => {
    const lines: LedgerLineForProgress[] = [
      { line_type: "direct_cost", amount_cents: toCents(500), progress_eligible: 1 }, // original (wrong amount)
      { line_type: "direct_cost", amount_cents: -toCents(500), progress_eligible: 1 }, // reversal
      { line_type: "direct_cost", amount_cents: toCents(420), progress_eligible: 1 }, // replacement (correct amount)
    ];
    expect(computeActualDirectCostToDate(lines)).toBe(toCents(420));
  });

  it("a pure credit with no replacement nets to original minus the credit only", () => {
    const lines: LedgerLineForProgress[] = [
      { line_type: "labor", amount_cents: toCents(1_000), progress_eligible: 1 },
      { line_type: "direct_cost", amount_cents: toCents(300), progress_eligible: 1 },
      { line_type: "direct_cost", amount_cents: -toCents(100), progress_eligible: 1 }, // partial credit
    ];
    expect(computeActualDirectCostToDate(lines)).toBe(toCents(1_200));
  });
});

describe("JP-03 cost overruns cap completion at exactly 1.00 (§9 test 3, worked example 8.3)", () => {
  it("actual > revised budget still caps at 1.00, never fractionally above", () => {
    const result = computeEarnedCompletion({
      completion_method: "cost_to_cost",
      direct_cost_budget_cents: toCents(320),
      progress_eligible_direct_cost_to_date_cents: toCents(352), // 110% raw
      service_units_completed: null, service_units_planned: null,
      manual_completion_pct_millionths: null,
      work_order_completed: true, financially_closed: false,
    });
    expect(result.completion_millionths).toBe(MILLIONTHS_SCALE);
    expect(result.unavailable_reason).toBeNull();
  });
});

describe("JP-04 missing budgets return null, never a fabricated 0 (§9 test 4)", () => {
  it("no job_budget_versions row at all -> completion_method is null -> null, not 0", () => {
    const result = computeEarnedCompletion({
      completion_method: null,
      direct_cost_budget_cents: null,
      progress_eligible_direct_cost_to_date_cents: 0,
      service_units_completed: null, service_units_planned: null,
      manual_completion_pct_millionths: null,
      work_order_completed: false, financially_closed: false,
    });
    expect(result.completion_millionths).toBeNull();
    expect(result.unavailable_reason).toBe("no_budget_version");
  });

  it("direct_cost_budget_cents = 0 -> null, not a division-by-zero value", () => {
    const result = computeEarnedCompletion({
      completion_method: "cost_to_cost",
      direct_cost_budget_cents: 0,
      progress_eligible_direct_cost_to_date_cents: toCents(100),
      service_units_completed: null, service_units_planned: null,
      manual_completion_pct_millionths: null,
      work_order_completed: false, financially_closed: false,
    });
    expect(result.completion_millionths).toBeNull();
    expect(result.unavailable_reason).toBe("zero_direct_cost_budget");
    expect(Number.isNaN(result.completion_millionths as never)).toBe(false);
  });

  it("earned revenue/recovered overhead propagate null rather than treating an unavailable completion % as $0 earned", () => {
    expect(computeEarnedRevenueToDate(toCents(46_000), null)).toBeNull();
    expect(computeRecoveredOverheadToDate(toCents(8_234.80), null)).toBeNull();
    expect(computeOverheadRecoveryVariance(null, toCents(500))).toBeNull();
  });
});

describe("JP-05 completion caps for service_units (§9 test 5)", () => {
  it("service_units_completed slightly exceeding planned still caps at 1.00", () => {
    const result = computeEarnedCompletion({
      completion_method: "service_units",
      direct_cost_budget_cents: toCents(360),
      progress_eligible_direct_cost_to_date_cents: 0,
      service_units_completed: 5, service_units_planned: 4, // an extra unscheduled visit
      manual_completion_pct_millionths: null,
      work_order_completed: false, financially_closed: false,
    });
    expect(result.completion_millionths).toBe(MILLIONTHS_SCALE);
  });

  it("no service_units_planned -> null, not a fabricated ratio", () => {
    const result = computeEarnedCompletion({
      completion_method: "service_units",
      direct_cost_budget_cents: toCents(360),
      progress_eligible_direct_cost_to_date_cents: 0,
      service_units_completed: 3, service_units_planned: null,
      manual_completion_pct_millionths: null,
      work_order_completed: false, financially_closed: false,
    });
    expect(result.completion_millionths).toBeNull();
    expect(result.unavailable_reason).toBe("no_service_units_planned");
  });
});

describe("JP-06 closed work orders force 1.00 regardless of method or ratio (§9 test 6)", () => {
  it("financially_closed_at set overrides cost_to_cost even when the ratio reads below 100%", () => {
    const result = computeEarnedCompletion({
      completion_method: "cost_to_cost",
      direct_cost_budget_cents: toCents(1_000),
      progress_eligible_direct_cost_to_date_cents: toCents(100), // only 10% spent
      service_units_completed: null, service_units_planned: null,
      manual_completion_pct_millionths: null,
      work_order_completed: true, financially_closed: true,
    });
    expect(result.completion_millionths).toBe(MILLIONTHS_SCALE);
    expect(result.unavailable_reason).toBeNull();
  });

  it("financially_closed_at set overrides 'manual' with no override value set at all", () => {
    const result = computeEarnedCompletion({
      completion_method: "manual",
      direct_cost_budget_cents: null,
      progress_eligible_direct_cost_to_date_cents: 0,
      service_units_completed: null, service_units_planned: null,
      manual_completion_pct_millionths: null, // not set
      work_order_completed: true, financially_closed: true,
    });
    expect(result.completion_millionths).toBe(MILLIONTHS_SCALE);
  });

  it("'completed' method with financially_closed=false reads 0, not partial credit", () => {
    const result = computeEarnedCompletion({
      completion_method: "completed",
      direct_cost_budget_cents: toCents(320),
      progress_eligible_direct_cost_to_date_cents: toCents(352),
      service_units_completed: null, service_units_planned: null,
      manual_completion_pct_millionths: null,
      work_order_completed: true, financially_closed: false,
    });
    expect(result.completion_millionths).toBe(0);
    expect(result.unavailable_reason).toBe("not_completed");
  });
});

describe("JP-07 progress_eligible=0 exclusion (§9 test 7)", () => {
  it("a progress_eligible=0 direct_cost line is excluded from the cost-to-cost numerator but still counted in actual direct cost to date", () => {
    const lines: LedgerLineForProgress[] = [
      { line_type: "labor", amount_cents: toCents(9_100), progress_eligible: 1 },
      { line_type: "direct_cost", amount_cents: toCents(8_400), progress_eligible: 1 }, // installed materials
      { line_type: "direct_cost", amount_cents: toCents(2_000), progress_eligible: 0 }, // purchased-but-uninstalled stone
      { line_type: "direct_cost", amount_cents: toCents(2_100), progress_eligible: 1 }, // equipment
      { line_type: "overhead", amount_cents: toCents(8_234.80), progress_eligible: 1 },
    ];
    const actual = computeActualDirectCostToDate(lines); // includes the $2,000
    const eligible = computeProgressEligibleDirectCostToDate(lines); // excludes it
    expect(actual).toBe(toCents(9_100 + 8_400 + 2_000 + 2_100));
    expect(eligible).toBe(toCents(9_100 + 8_400 + 2_100));
    expect(actual).not.toBe(eligible); // the two sums must never silently collapse into one
  });
});

describe("JP-08 division-rate-at-CO-approval snapshot (§9 test 8)", () => {
  it("a CO's own overhead_rate_snapshot is used, not a later changed division rate", () => {
    const baseline = { contract_value_cents: 0, direct_cost_budget_cents: 0, budgeted_overhead_cents: toCents(1_000) };
    // CO approved when the division rate was $20/hr for 10 hours -> $200,
    // frozen on the CO row. The division's rate has since changed to
    // $30/hr in overhead_allocation, but that new rate is never passed in
    // here at all — proving this function has no way to read "today's"
    // rate even if it wanted to.
    const result = computeRevisedBudgetFromChangeOrders(baseline, [
      { status: "approved", revenue_adjustment_cents: 0, direct_cost_adjustment_cents: 0, labor_hours_adjustment_hundredths: 1000, overhead_rate_snapshot: 200000 },
    ]);
    expect(result.budgeted_overhead_cents).toBe(toCents(1_000) + toCents(200));
  });
});

describe("worked examples (§8) — full computeJobProgress composite", () => {
  it("8.1 Landscape Design/Build (cost_to_cost)", () => {
    const latestBudgetVersion = { contract_value_cents: toCents(46_000), direct_cost_budget_cents: toCents(27_500), budgeted_overhead_cents: toCents(8_234.80) };
    const ledgerLines: LedgerLineForProgress[] = [
      { line_type: "labor", amount_cents: toCents(9_100), progress_eligible: 1 },
      { line_type: "direct_cost", amount_cents: toCents(8_400), progress_eligible: 1 },
      { line_type: "direct_cost", amount_cents: toCents(2_000), progress_eligible: 0 },
      { line_type: "direct_cost", amount_cents: toCents(2_100), progress_eligible: 1 },
      { line_type: "overhead", amount_cents: toCents(8_234.80), progress_eligible: 1 },
    ];
    const result = computeJobProgress({
      latestBudgetVersion, completionMethod: "cost_to_cost",
      serviceUnitsPlanned: null, serviceUnitsCompleted: null,
      manualCompletionPctMillionths: null, workOrderCompleted: false, financiallyClosed: false,
      ledgerLines,
    });

    expect(result.revised_contract_value_cents).toBe(toCents(46_000));
    expect(result.revised_budgeted_direct_cost_cents).toBe(toCents(27_500));
    expect(result.actual_direct_cost_to_date_cents).toBe(toCents(19_600 + 2_000)); // full posted, incl. ineligible
    expect(result.progress_eligible_direct_cost_to_date_cents).toBe(toCents(19_600));
    expect(result.revised_budgeted_overhead_cents).toBe(toCents(8_234.80));
    // 19600/27500 = 0.712727... -> rounds to 712727 millionths (71.2727%).
    // ITEM4-JOBCOST.md §8.1's prose rounds the completion % to 71.3% for
    // display before showing $32,798/$5,871.42/-$2,363.38 — this engine
    // applies exactly one rounding point (at the final cents conversion) on
    // the full-precision 712727 millionths value instead of re-rounding an
    // already-rounded percentage, per this file's documented rounding rule.
    // The precise figures below are the correct output of that single-
    // rounding-point rule, not a deviation from the spec's arithmetic.
    const completionMillionths = Math.round((19_600 / 27_500) * MILLIONTHS_SCALE);
    expect(result.earned_completion.completion_millionths).toBe(completionMillionths);
    expect(result.earned_revenue_to_date_cents).toBe(Math.round((toCents(46_000) * completionMillionths) / MILLIONTHS_SCALE));
    expect(result.earned_revenue_to_date_cents! / 100).toBeCloseTo(32_785.44, 2);
    expect(result.recovered_overhead_to_date_cents).toBe(Math.round((toCents(8_234.80) * completionMillionths) / MILLIONTHS_SCALE));
    expect(result.recovered_overhead_to_date_cents! / 100).toBeCloseTo(5_869.16, 2);
    expect(result.absorbed_overhead_to_date_cents).toBe(toCents(8_234.80));
    expect(result.overhead_recovery_variance_cents! / 100).toBeCloseTo(-2_365.64, 2);
  });

  it("8.2 Recurring Maintenance (service_units)", () => {
    const latestBudgetVersion = { contract_value_cents: toCents(600), direct_cost_budget_cents: toCents(360), budgeted_overhead_cents: toCents(290.64) };
    const ledgerLines: LedgerLineForProgress[] = [
      { line_type: "labor", amount_cents: toCents(270), progress_eligible: 1 },
      { line_type: "overhead", amount_cents: toCents(217.98), progress_eligible: 1 },
    ];
    const result = computeJobProgress({
      latestBudgetVersion, completionMethod: "service_units",
      serviceUnitsPlanned: 4, serviceUnitsCompleted: 3,
      manualCompletionPctMillionths: null, workOrderCompleted: false, financiallyClosed: false,
      ledgerLines,
    });

    expect(result.earned_completion.completion_millionths).toBe(750_000); // 75.0%
    expect(result.earned_revenue_to_date_cents).toBe(toCents(450));
    expect(result.recovered_overhead_to_date_cents! / 100).toBeCloseTo(217.98, 1);
    expect(result.absorbed_overhead_to_date_cents! / 100).toBeCloseTo(217.98, 1);
    expect(result.overhead_recovery_variance_cents).toBe(0);
  });

  it("8.3 Snow/event (completed, financially closed)", () => {
    const latestBudgetVersion = { contract_value_cents: toCents(800), direct_cost_budget_cents: toCents(320), budgeted_overhead_cents: toCents(242.20) };
    const ledgerLines: LedgerLineForProgress[] = [
      { line_type: "labor", amount_cents: toCents(352), progress_eligible: 1 }, // 11 hrs * $32 (over budget)
      { line_type: "overhead", amount_cents: toCents(266.42), progress_eligible: 1 }, // 11 hrs * $24.22
    ];
    const result = computeJobProgress({
      latestBudgetVersion, completionMethod: "completed",
      serviceUnitsPlanned: null, serviceUnitsCompleted: null,
      manualCompletionPctMillionths: null, workOrderCompleted: true, financiallyClosed: true,
      ledgerLines,
    });

    // Cost overrun does NOT push completion above 100%, and the
    // financially_closed override forces exactly 1.00 even for 'completed'.
    expect(result.earned_completion.completion_millionths).toBe(MILLIONTHS_SCALE);
    expect(result.earned_revenue_to_date_cents).toBe(toCents(800));
    expect(result.recovered_overhead_to_date_cents).toBe(toCents(242.20));
    expect(result.absorbed_overhead_to_date_cents! / 100).toBeCloseTo(266.42, 1);
    expect(result.overhead_recovery_variance_cents! / 100).toBeCloseTo(-24.22, 1);
  });
});

describe("no substitution of invoiced revenue, cash collected, or amount_actual", () => {
  it("computeJobProgress's input shape has no field for any of those three", () => {
    // Compile-time guarantee (TypeScript would fail this file's typecheck
    // if such a field existed and callers started relying on it) plus a
    // runtime sanity check that the composite result is fully derived from
    // budget + ledger inputs alone.
    const latestBudgetVersion = { contract_value_cents: toCents(1_000), direct_cost_budget_cents: toCents(500), budgeted_overhead_cents: toCents(100) };
    const result = computeJobProgress({
      latestBudgetVersion, completionMethod: "cost_to_cost",
      serviceUnitsPlanned: null, serviceUnitsCompleted: null,
      manualCompletionPctMillionths: null, workOrderCompleted: false, financiallyClosed: false,
      ledgerLines: [{ line_type: "labor", amount_cents: toCents(250), progress_eligible: 1 }],
    });
    expect(result.earned_completion.completion_millionths).toBe(500_000);
  });
});
