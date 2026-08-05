import { describe, it, expect } from "vitest";
import { allocateOverheadPools, computeDivisionRate, computeBlendedOverheadRate } from "./allocation";
import golden from "../../fixtures/golden.json";

const F = golden.overhead_allocation;
const TOL = golden.tolerance.rate;
const toCents = (dollars: number) => Math.round(dollars * 100);
const closeWithinTol = (actual: number, expected: number) =>
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(TOL);

describe("overhead allocation engine", () => {
  it("AL-01 blended overhead rate matches total_overhead / total_sellable_hours", () => {
    const blended = computeBlendedOverheadRate(toCents(F.total_overhead), F.total_sellable_hours);
    expect(blended).toBeCloseTo(F.blended_overhead_rate, 3);
  });

  it.each(Object.entries(F.divisions))(
    "AL-02 %s: overhead_rate, absorbed_cost, required_bill_rate all match the fixture",
    (_name, d) => {
      const r = computeDivisionRate(
        { division: _name, sellable_hours: d.sellable_hours,
          weighted_labor_rate: d.weighted_labor_rate, target_margin: d.target_margin },
        toCents(d.allocated_overhead),
      );
      closeWithinTol(r.overhead_rate, d.overhead_rate);
      closeWithinTol(r.absorbed_cost, d.absorbed_cost);
      closeWithinTol(r.required_bill_rate, d.required_bill_rate);
    },
  );

  it("AL-03 division allocated_overhead figures sum to total_overhead — nothing left unallocated", () => {
    const sum = Object.values(F.divisions).reduce((acc, d) => acc + d.allocated_overhead, 0);
    expect(sum).toBeCloseTo(F.total_overhead, 0);
  });

  it("AL-04 pools group-sum by division (multi-driver: each pool carries its own driver)", () => {
    const { byDivision, totalCents } = allocateOverheadPools([
      { division: "maintenance", pool_type: "shop", annual_cost_cents: 15000000, driver: "sellable_hours" },
      { division: "maintenance", pool_type: "admin", annual_cost_cents: 4640000, driver: "sellable_hours" },
      { division: "hardscape", pool_type: "shop", annual_cost_cents: 26890000, driver: "sellable_hours" },
    ]);
    expect(byDivision.maintenance).toBe(19640000);
    expect(byDivision.hardscape).toBe(26890000);
    expect(totalCents).toBe(46530000);
  });

  it("AL-05 forbidden: revenue-driven pools may never exceed 10% of the total pool", () => {
    expect(() =>
      allocateOverheadPools([
        { division: "maintenance", pool_type: "shop", annual_cost_cents: 80000, driver: "sellable_hours" },
        { division: "maintenance", pool_type: "sales", annual_cost_cents: 20000, driver: "revenue" }, // 20%
      ]),
    ).toThrow(/10%/);
  });

  it("AL-06 forbidden: a pool with no division is rejected, never silently unallocated", () => {
    expect(() =>
      allocateOverheadPools([
        { division: "", pool_type: "shop", annual_cost_cents: 10000, driver: "sellable_hours" },
      ]),
    ).toThrow(/division/);
  });
});
