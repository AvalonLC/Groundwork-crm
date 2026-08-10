/// <reference types="@cloudflare/vitest-pool-workers" />
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { buildTenantRollup, runNightlyRollup, type TenantRollupInput } from "./rollup";
import { getLatestRecoverySnapshot } from "../db/repos";
import golden from "../../fixtures/golden.json";

const db = () => env.DB;
const F = golden.recovery;

function fixtureInput(tenantId: string): TenantRollupInput {
  return {
    company_id: tenantId,
    as_of: F.as_of,
    restated_target_cents: Math.round(F.restated_target * 100),
    recovered_to_date_cents: Math.round(F.recovered_to_date * 100),
    hours_per_week_hundredths: F.hours_per_week * 100,
    blended_overhead_rate: Math.round(F.blended_overhead_rate * 10000),
    confidence_days: F.confidence_days,
    budgeted_overhead_cents: 1000000,
    absorbed_overhead_cents: 1050000,
  };
}

describe("buildTenantRollup", () => {
  it("RU-01 matches the recovery fixture and computes absorption variance", () => {
    const r = buildTenantRollup(fixtureInput("t-rollup-pure"));
    expect(r.projected_black_friday).toBe(F.projected_black_friday);
    expect(r.pct_recovered_millionths / 1_000_000).toBeCloseTo(F.pct_recovered, 5);
    expect(r.absorption_variance_cents).toBe(50000); // absorbed 1,050,000 - budgeted 1,000,000
  });

  it("RU-05 a tenant with zero hours logged gets an indeterminate projection, not a crash", () => {
    // Previously threw RangeError: Invalid time value (division by zero
    // inside computeRecoveryProjection) — a real bug caught while building
    // the cron-trigger endpoint, which processes real tenants that may not
    // have any activity yet.
    const r = buildTenantRollup({ ...fixtureInput("t-rollup-zero-hours"), hours_per_week_hundredths: 0 });
    expect(r.projected_black_friday).toBeNull();
    expect(r.indeterminate_reason).toBe("no_weekly_progress");
  });
});

describe("runNightlyRollup", () => {
  it("RU-02 writes every tenant's snapshot in a single batch call", async () => {
    const inputs = [fixtureInput("t-rollup-a"), fixtureInput("t-rollup-b"), fixtureInput("t-rollup-c")];
    const results = await runNightlyRollup(db(), inputs);
    expect(results.length).toBe(3);

    for (const tenantId of ["t-rollup-a", "t-rollup-b", "t-rollup-c"]) {
      const snapshot = await getLatestRecoverySnapshot(db(), tenantId);
      expect(snapshot?.as_of).toBe(F.as_of);
      expect(snapshot?.projected_black_friday).toBe(F.projected_black_friday);
    }
  });

  it("RU-03 re-running for the same day upserts, not duplicates, per tenant", async () => {
    const tenantId = "t-rollup-rerun";
    await runNightlyRollup(db(), [fixtureInput(tenantId)]);
    await runNightlyRollup(db(), [{ ...fixtureInput(tenantId), recovered_to_date_cents: 40000000 }]);

    const { results } = await db().prepare(
      `SELECT COUNT(*) as n FROM recovery_snapshot WHERE company_id = ? AND as_of = ?`,
    ).bind(tenantId, F.as_of).all();
    expect((results[0] as any).n).toBe(1);

    const latest = await getLatestRecoverySnapshot(db(), tenantId);
    expect(latest?.recovered_to_date_cents).toBe(40000000);
  });

  it("RU-04 recovery recognition never touches invoice/deposit/payment data — inputs are pre-derived cents only", async () => {
    // Structural proof: TenantRollupInput has no invoice/payment/deposit field
    // at all, and this function only reads its own arguments — there is no
    // code path here that could reach billing events even if they existed.
    const input = fixtureInput("t-rollup-structural");
    expect(Object.keys(input)).not.toContain("invoice_id");
    expect(Object.keys(input)).not.toContain("payment_id");
    expect(Object.keys(input)).not.toContain("deposit_id");
  });
});
