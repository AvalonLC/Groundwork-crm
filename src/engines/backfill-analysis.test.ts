import { describe, it, expect } from "vitest";
import {
  classifyJobForBackfill,
  buildBackfillAnalysisReport,
  BACKFILL_BUCKETS,
  type JobBackfillAnalysisInput,
  type JobBackfillClassification,
} from "./backfill-analysis";

/** A fully "would succeed cleanly" baseline input — each test below
 * mutates exactly one field off this base to isolate one bucket at a
 * time, same pattern as job-progress.test.ts's per-branch tests. */
const BASE: JobBackfillAnalysisInput = {
  job_id: "job-1",
  already_has_budget_version: false,
  accepted_estimate: { id: "est-1", total_cents: 500_000, accepted_at: "2026-01-15" },
  division: "landscaping",
  overhead_rate_available: true,
  has_non_labor_cost_evidence: false,
  work_order_type: "Install",
  has_recurring_plan_link: false,
};

describe("BA-01 idempotency — already has a budget version", () => {
  it("short-circuits to already_has_budget_version regardless of anything else", () => {
    const result = classifyJobForBackfill({ ...BASE, already_has_budget_version: true, division: null, accepted_estimate: null });
    expect(result.bucket).toBe("already_has_budget_version");
    expect(result.would_need_review).toBe(false);
    expect(result.resolved_completion_method).toBeNull();
  });
});

describe("BA-02 no accepted estimate (§10 skip reason 1)", () => {
  it("null accepted_estimate -> no_accepted_estimate", () => {
    const result = classifyJobForBackfill({ ...BASE, accepted_estimate: null });
    expect(result.bucket).toBe("no_accepted_estimate");
    expect(result.reasons[0]).toMatch(/no estimate/i);
  });

  it("malformed accepted estimate (missing total_cents) -> no_accepted_estimate, not a crash", () => {
    const result = classifyJobForBackfill({
      ...BASE,
      accepted_estimate: { id: "est-1", total_cents: null, accepted_at: "2026-01-15" },
    });
    expect(result.bucket).toBe("no_accepted_estimate");
    expect(result.reasons[0]).toMatch(/unusable/i);
  });

  it("malformed accepted estimate (missing accepted_at) -> no_accepted_estimate", () => {
    const result = classifyJobForBackfill({
      ...BASE,
      accepted_estimate: { id: "est-1", total_cents: 500_000, accepted_at: null },
    });
    expect(result.bucket).toBe("no_accepted_estimate");
  });

  it("malformed accepted estimate (negative total_cents) -> no_accepted_estimate, never a negative baseline", () => {
    const result = classifyJobForBackfill({
      ...BASE,
      accepted_estimate: { id: "est-1", total_cents: -100, accepted_at: "2026-01-15" },
    });
    expect(result.bucket).toBe("no_accepted_estimate");
  });

  it("malformed accepted estimate (NaN total_cents) -> no_accepted_estimate, never propagates NaN", () => {
    const result = classifyJobForBackfill({
      ...BASE,
      accepted_estimate: { id: "est-1", total_cents: NaN, accepted_at: "2026-01-15" },
    });
    expect(result.bucket).toBe("no_accepted_estimate");
  });

  it("malformed accepted estimate (empty-string accepted_at) -> no_accepted_estimate", () => {
    const result = classifyJobForBackfill({
      ...BASE,
      accepted_estimate: { id: "est-1", total_cents: 500_000, accepted_at: "" },
    });
    expect(result.bucket).toBe("no_accepted_estimate");
  });
});

describe("BA-03 no division (§10 skip reason 2)", () => {
  it("null division -> no_division", () => {
    expect(classifyJobForBackfill({ ...BASE, division: null }).bucket).toBe("no_division");
  });
  it("empty-string division -> no_division, not a crew named ''", () => {
    expect(classifyJobForBackfill({ ...BASE, division: "" }).bucket).toBe("no_division");
  });
});

describe("BA-04 no overhead rate for division", () => {
  it("overhead_rate_available=false -> no_overhead_rate_for_division", () => {
    const result = classifyJobForBackfill({ ...BASE, overhead_rate_available: false });
    expect(result.bucket).toBe("no_overhead_rate_for_division");
    expect(result.reasons[0]).toContain("landscaping");
  });
});

describe("BA-05 ambiguous direct-cost split (§10 skip reason 3)", () => {
  it("has_non_labor_cost_evidence=true -> ambiguous_direct_cost_split, never guesses a split", () => {
    const result = classifyJobForBackfill({ ...BASE, has_non_labor_cost_evidence: true });
    expect(result.bucket).toBe("ambiguous_direct_cost_split");
  });
});

describe("BA-06 no completion-method signal (§10 skip reason 4)", () => {
  it("type not Install/Service and no recurring-plan link -> no_completion_method_signal", () => {
    const result = classifyJobForBackfill({ ...BASE, work_order_type: "Maintenance", has_recurring_plan_link: false });
    expect(result.bucket).toBe("no_completion_method_signal");
  });
  it("null work_order_type and no plan link -> no_completion_method_signal", () => {
    const result = classifyJobForBackfill({ ...BASE, work_order_type: null, has_recurring_plan_link: false });
    expect(result.bucket).toBe("no_completion_method_signal");
  });
});

describe("BA-07 successful classification — cost_to_cost", () => {
  it("Install type, no plan link -> would_create_needs_review_cost_to_cost (needs_review always true per §10 step 2)", () => {
    const result = classifyJobForBackfill({ ...BASE, work_order_type: "Install" });
    expect(result.bucket).toBe("would_create_needs_review_cost_to_cost");
    expect(result.would_need_review).toBe(true);
    expect(result.resolved_completion_method).toBe("cost_to_cost");
  });
  it("Service type, no plan link -> would_create_needs_review_cost_to_cost", () => {
    const result = classifyJobForBackfill({ ...BASE, work_order_type: "Service" });
    expect(result.bucket).toBe("would_create_needs_review_cost_to_cost");
    expect(result.resolved_completion_method).toBe("cost_to_cost");
  });
});

describe("BA-08 successful classification — service_units", () => {
  it("recurring-plan link present -> would_create_needs_review_service_units, regardless of type", () => {
    const result = classifyJobForBackfill({ ...BASE, work_order_type: "Maintenance", has_recurring_plan_link: true });
    expect(result.bucket).toBe("would_create_needs_review_service_units");
    expect(result.resolved_completion_method).toBe("service_units");
  });
  it("plan link takes priority over an Install/Service type match", () => {
    const result = classifyJobForBackfill({ ...BASE, work_order_type: "Install", has_recurring_plan_link: true });
    expect(result.bucket).toBe("would_create_needs_review_service_units");
    expect(result.resolved_completion_method).toBe("service_units");
  });
});

describe("BA-09 needs_review is always true on every successful classification", () => {
  it("no input shape reaches would_create_clean_* — §10 never produces a confident split", () => {
    // Sweep every combination that reaches the success branches and assert
    // every single one lands in a needs_review bucket, never a clean one.
    for (const work_order_type of ["Install", "Service"]) {
      for (const has_recurring_plan_link of [true, false]) {
        const result = classifyJobForBackfill({ ...BASE, work_order_type, has_recurring_plan_link });
        expect(result.would_need_review).toBe(true);
        expect(["would_create_needs_review_cost_to_cost", "would_create_needs_review_service_units"]).toContain(result.bucket);
      }
    }
  });
});

describe("BA-10 priority ordering — earlier-checked reasons win when multiple apply", () => {
  it("already_has_budget_version wins over every other simultaneous problem", () => {
    const result = classifyJobForBackfill({
      ...BASE,
      already_has_budget_version: true,
      accepted_estimate: null,
      division: null,
      overhead_rate_available: false,
      has_non_labor_cost_evidence: true,
      work_order_type: null,
    });
    expect(result.bucket).toBe("already_has_budget_version");
  });

  it("no_accepted_estimate wins over no_division/no_overhead_rate/etc when it also applies", () => {
    const result = classifyJobForBackfill({
      ...BASE,
      accepted_estimate: null,
      division: null,
      overhead_rate_available: false,
      has_non_labor_cost_evidence: true,
      work_order_type: null,
    });
    expect(result.bucket).toBe("no_accepted_estimate");
  });

  it("no_division wins over no_overhead_rate/ambiguous-split/no-method when it also applies", () => {
    const result = classifyJobForBackfill({
      ...BASE,
      division: null,
      overhead_rate_available: false,
      has_non_labor_cost_evidence: true,
      work_order_type: null,
    });
    expect(result.bucket).toBe("no_division");
  });

  it("no_overhead_rate_for_division wins over ambiguous-split/no-method when it also applies", () => {
    const result = classifyJobForBackfill({
      ...BASE,
      overhead_rate_available: false,
      has_non_labor_cost_evidence: true,
      work_order_type: null,
    });
    expect(result.bucket).toBe("no_overhead_rate_for_division");
  });

  it("ambiguous_direct_cost_split wins over no-completion-method-signal when it also applies", () => {
    const result = classifyJobForBackfill({
      ...BASE,
      has_non_labor_cost_evidence: true,
      work_order_type: null,
    });
    expect(result.bucket).toBe("ambiguous_direct_cost_split");
  });
});

describe("BA-11 determinism", () => {
  it("the same input always produces the exact same classification (structurally equal)", () => {
    const inputs: JobBackfillAnalysisInput[] = [
      BASE,
      { ...BASE, accepted_estimate: null },
      { ...BASE, division: null },
      { ...BASE, has_non_labor_cost_evidence: true },
      { ...BASE, work_order_type: "Maintenance" },
      { ...BASE, has_recurring_plan_link: true },
    ];
    for (const input of inputs) {
      const a = classifyJobForBackfill(input);
      const b = classifyJobForBackfill(input);
      expect(a).toEqual(b);
    }
  });

  it("field order / object identity of the input never affects the result", () => {
    const shuffled: JobBackfillAnalysisInput = {
      work_order_type: BASE.work_order_type,
      has_recurring_plan_link: BASE.has_recurring_plan_link,
      job_id: BASE.job_id,
      division: BASE.division,
      already_has_budget_version: BASE.already_has_budget_version,
      overhead_rate_available: BASE.overhead_rate_available,
      accepted_estimate: BASE.accepted_estimate ? { ...BASE.accepted_estimate } : null,
      has_non_labor_cost_evidence: BASE.has_non_labor_cost_evidence,
    };
    expect(classifyJobForBackfill(shuffled)).toEqual(classifyJobForBackfill(BASE));
  });
});

describe("BA-12 report aggregation — bucketing and invariant totals", () => {
  it("every job appears in exactly one bucket; bucket counts sum to total_jobs_scanned", () => {
    const classifications: JobBackfillClassification[] = [
      classifyJobForBackfill({ ...BASE, job_id: "j1" }),
      classifyJobForBackfill({ ...BASE, job_id: "j2", accepted_estimate: null }),
      classifyJobForBackfill({ ...BASE, job_id: "j3", division: null }),
      classifyJobForBackfill({ ...BASE, job_id: "j4", overhead_rate_available: false }),
      classifyJobForBackfill({ ...BASE, job_id: "j5", has_non_labor_cost_evidence: true }),
      classifyJobForBackfill({ ...BASE, job_id: "j6", work_order_type: "Maintenance" }),
      classifyJobForBackfill({ ...BASE, job_id: "j7", has_recurring_plan_link: true }),
      classifyJobForBackfill({ ...BASE, job_id: "j8", already_has_budget_version: true }),
    ];
    const report = buildBackfillAnalysisReport("company-A", "2026-08-27", classifications);

    expect(report.total_jobs_scanned).toBe(8);
    const sumOfBuckets = Object.values(report.bucket_counts).reduce((a, b) => a + b, 0);
    expect(sumOfBuckets).toBe(report.total_jobs_scanned);

    // Every one of the 10 buckets is present in the output (zero-filled if empty) —
    // a bucket silently missing must never be confused with "not implemented."
    expect(Object.keys(report.bucket_counts).sort()).toEqual([...BACKFILL_BUCKETS].sort());

    // Spot-check a few expected placements.
    expect(report.bucket_counts.no_accepted_estimate).toBe(1);
    expect(report.bucket_counts.no_division).toBe(1);
    expect(report.bucket_counts.no_overhead_rate_for_division).toBe(1);
    expect(report.bucket_counts.ambiguous_direct_cost_split).toBe(1);
    expect(report.bucket_counts.no_completion_method_signal).toBe(1);
    expect(report.bucket_counts.would_create_needs_review_service_units).toBe(1);
    expect(report.bucket_counts.already_has_budget_version).toBe(1);
    expect(report.bucket_counts.would_create_needs_review_cost_to_cost).toBe(1);
    expect(report.bucket_counts.would_create_clean_cost_to_cost).toBe(0);
    expect(report.bucket_counts.would_create_clean_service_units).toBe(0);
  });

  it("an empty job list produces a report with total_jobs_scanned=0 and every bucket zeroed, never an omitted key", () => {
    const report = buildBackfillAnalysisReport("company-B", "2026-08-27", []);
    expect(report.total_jobs_scanned).toBe(0);
    for (const bucket of BACKFILL_BUCKETS) {
      expect(report.bucket_counts[bucket]).toBe(0);
    }
  });

  it("report carries the exact company_id/as_of it was built with (tenant/as-of targeting is explicit, not inferred)", () => {
    const report = buildBackfillAnalysisReport("company-XYZ", "2025-12-31", []);
    expect(report.company_id).toBe("company-XYZ");
    expect(report.as_of).toBe("2025-12-31");
  });

  it("building the same classifications twice produces deep-equal reports (determinism at the aggregation layer too)", () => {
    const classifications = [classifyJobForBackfill(BASE), classifyJobForBackfill({ ...BASE, division: null })];
    const r1 = buildBackfillAnalysisReport("co", "2026-01-01", classifications);
    const r2 = buildBackfillAnalysisReport("co", "2026-01-01", classifications);
    expect(r1).toEqual(r2);
  });
});
