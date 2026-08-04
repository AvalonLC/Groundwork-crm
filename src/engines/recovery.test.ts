import { describe, it, expect } from "vitest";
import { computeRecoveryProjection } from "./recovery";
import golden from "../../fixtures/golden.json";

const F = golden.recovery;

describe("recovery projection engine", () => {
  it("RC-01 golden fixture: weekly_recovery, pct_recovered, projected_black_friday", () => {
    const r = computeRecoveryProjection({
      as_of: F.as_of,
      restated_target: F.restated_target,
      recovered_to_date: F.recovered_to_date,
      hours_per_week: F.hours_per_week,
      blended_overhead_rate: F.blended_overhead_rate,
      confidence_days: F.confidence_days,
    });
    expect(r.weekly_recovery).toBeCloseTo(F.weekly_recovery, 1);
    expect(r.pct_recovered).toBeCloseTo(F.pct_recovered, 5);
    expect(r.projected_black_friday).toBe(F.projected_black_friday);
  });

  it("RC-02 confidence_days always travels with the projected date", () => {
    const r = computeRecoveryProjection({
      as_of: F.as_of, restated_target: F.restated_target,
      recovered_to_date: F.recovered_to_date, hours_per_week: F.hours_per_week,
      blended_overhead_rate: F.blended_overhead_rate, confidence_days: 9,
    });
    // forbidden: "returning a single date without a confidence range" —
    // confidence_days is always present on the result, never dropped.
    expect(r.confidence_days).toBe(9);
    expect(typeof r.projected_black_friday).toBe("string");
  });

  it("RC-03 target is restated actuals, not straight-line: pct_recovered is not time-of-year linear", () => {
    // A straight-line target/12 model would give the same pct_recovered
    // regardless of restated_target's actual value, for the same
    // recovered_to_date. Changing restated_target must change pct_recovered.
    const a = computeRecoveryProjection({ ...F, restated_target: 591000 });
    const b = computeRecoveryProjection({ ...F, restated_target: 700000 });
    expect(a.pct_recovered).not.toBeCloseTo(b.pct_recovered, 3);
  });

  it("RC-04 more weekly recovery pulls the projected date earlier, not later", () => {
    const slow = computeRecoveryProjection({ ...F, hours_per_week: 200 });
    const fast = computeRecoveryProjection({ ...F, hours_per_week: 500 });
    expect(new Date(fast.projected_black_friday).getTime())
      .toBeLessThan(new Date(slow.projected_black_friday).getTime());
  });
});
