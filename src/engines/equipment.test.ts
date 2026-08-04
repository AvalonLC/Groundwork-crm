import { describe, it, expect } from "vitest";
import { computeEquipmentRate } from "./equipment";
import golden from "../../fixtures/golden.json";

const F = golden.equipment_rate;

describe("equipment rate engine", () => {
  it("EQ-01 golden fixture: ownership/operating split", () => {
    const r = computeEquipmentRate(F.input);
    expect(r.ownership_annual).toBeCloseTo(F.expect.ownership_annual, 2);
    expect(r.ownership_rate).toBeCloseTo(F.expect.ownership_rate, 3);
    expect(r.operating_rate).toBeCloseTo(F.expect.operating_rate, 3);
    expect(r.total_rate).toBeCloseTo(F.expect.total_rate, 3);
  });

  it("EQ-02 ownership and operating are never merged before total_rate", () => {
    const r = computeEquipmentRate(F.input);
    // total_rate must equal the sum of the two components — proves the two
    // numbers aren't independently computed shortcuts that happen to add up.
    expect(r.total_rate).toBeCloseTo(r.ownership_rate + r.operating_rate, 6);
    // And they must actually be distinct components, not one masquerading as both.
    expect(r.ownership_rate).not.toBeCloseTo(r.operating_rate, 1);
  });

  it("EQ-03 ownership scales with finance_rate; operating does not", () => {
    const base = computeEquipmentRate(F.input);
    const higherFinance = computeEquipmentRate({ ...F.input, finance_rate: F.input.finance_rate * 2 });
    expect(higherFinance.ownership_rate).toBeGreaterThan(base.ownership_rate);
    expect(higherFinance.operating_rate).toBeCloseTo(base.operating_rate, 6);
  });

  it("EQ-04 operating scales with fuel_price; ownership does not", () => {
    const base = computeEquipmentRate(F.input);
    const higherFuel = computeEquipmentRate({ ...F.input, fuel_price: F.input.fuel_price * 2 });
    expect(higherFuel.operating_rate).toBeGreaterThan(base.operating_rate);
    expect(higherFuel.ownership_rate).toBeCloseTo(base.ownership_rate, 6);
  });
});
