import { describe, it, expect } from "vitest";
import { computeBurden } from "./burden";
import golden from "../../fixtures/golden.json";

const A = golden.burden_labor_with_equipment;
const B = golden.burden_labor_no_equipment;
const TOL = golden.tolerance.rate;

describe("burdened-hour engine", () => {
  it("BH-01 golden fixture, equipment_engine_active = false", () => {
    const r = computeBurden({ ...A.input, equipment_engine_active: false });
    expect(r.billable_hours).toBe(1622);
    expect(r.burdened_rate).toBeCloseTo(42.1002, 3);
    expect(Number(r.burdened_rate.toFixed(2))).toBe(42.10);
    expect(Number(r.burden_multiplier.toFixed(3))).toBe(1.754);
  });

  it("BH-02 zero support pools", () => {
    const r = computeBurden({ ...A.input, truck: 0, equip: 0, tools: 0,
                              equipment_engine_active: false });
    expect(Number(r.burdened_rate.toFixed(2))).toBe(37.52);
  });

  it("BH-03 divide-by-zero guard: non-billable exceeds paid hours", () => {
    const r = computeBurden({ ...A.input, idle: 5000, equipment_engine_active: false });
    expect(r.billable_hours).toBe(1);
    expect(r.config_error).toBe(true);
    expect(r.publishable).toBe(false);
  });

  it("BH-04 low utilization flag", () => {
    const r = computeBurden({ ...A.input, idle: 800, equipment_engine_active: false });
    expect(r.utilization).toBeLessThan(0.55);
    expect(r.suspect).toBe(true);
    expect(r.requires_review).toBe(true);
  });

  it("BH-05 multiplier ceiling warning", () => {
    const r = computeBurden({ ...A.input, truck: 90000, equipment_engine_active: false });
    expect(r.burden_multiplier).toBeGreaterThan(2.5);
    expect(r.config_warning).toBe(true);
  });

  // ---- THE ONE THAT MATTERS ----
  it("BH-13 equipment double-count guard", () => {
    const off = computeBurden({ ...A.input, equipment_engine_active: false });
    const on  = computeBurden({ ...A.input, equipment_engine_active: true });

    // with the equipment engine ON, labor must shed its equipment pool entirely
    expect(on.support_equipment_annual_used).toBe(0);
    expect(Number(on.burdened_rate.toFixed(2))).toBe(40.62);
    expect(Number(on.burden_multiplier.toFixed(3))).toBe(1.693);

    // the delta is equip / BILLABLE hours, NOT equip / paid hours
    const delta = off.burdened_rate - on.burdened_rate;
    expect(delta).toBeCloseTo(2400 / 1622, 3);   // 1.4797
    expect(delta).not.toBeCloseTo(2.61, 1);      // the wrong per-paid-hour figure

    // regression tripwire: 39.49 was an arithmetic error, never accept it
    expect(Number(on.burdened_rate.toFixed(2))).not.toBe(39.49);
  });

  it("BH-14 fixture file agrees with engine (spec drift tripwire)", () => {
    expect(Number(B.expect.burdened_rate.toFixed(2))).toBe(40.62);
    const r = computeBurden({ ...B.input, equipment_engine_active: true });
    expect(r.burdened_rate).toBeCloseTo(B.expect.burdened_rate, 3);
  });
});
