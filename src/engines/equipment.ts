export interface EquipmentRateInput {
  purchase_price: number;
  salvage: number;
  life_years: number;
  annual_machine_hours: number;
  finance_rate: number;
  insurance_annual: number;
  storage_annual: number;
  fuel_gal_per_hr: number;
  fuel_price: number;
  repairs_annual: number;
  wear_annual: number;
  lube_pct_of_fuel: number;
}

export interface EquipmentRateResult {
  ownership_annual: number;
  ownership_rate: number;
  operating_rate: number;
  total_rate: number;
}

/**
 * Pure function. No DB, no I/O. See docs/spec/EQUIPMENT.md.
 * Ownership and operating are kept as two separate numbers throughout — never
 * merged into a single rate before the caller can see the breakdown.
 */
export function computeEquipmentRate(i: EquipmentRateInput): EquipmentRateResult {
  // Ownership: fixed costs, independent of usage.
  const depreciationAnnual = (i.purchase_price - i.salvage) / i.life_years;
  const financeCostAnnual = ((i.purchase_price + i.salvage) / 2) * i.finance_rate;
  const ownershipAnnual = depreciationAnnual + financeCostAnnual + i.insurance_annual + i.storage_annual;
  const ownershipRate = ownershipAnnual / i.annual_machine_hours;

  // Operating: variable costs, driven by machine hours.
  const fuelCostPerHr = i.fuel_gal_per_hr * i.fuel_price;
  const lubeCostPerHr = fuelCostPerHr * i.lube_pct_of_fuel;
  const repairsPerHr = i.repairs_annual / i.annual_machine_hours;
  const wearPerHr = i.wear_annual / i.annual_machine_hours;
  const operatingRate = fuelCostPerHr + lubeCostPerHr + repairsPerHr + wearPerHr;

  return {
    ownership_annual: ownershipAnnual,
    ownership_rate: ownershipRate,
    operating_rate: operatingRate,
    total_rate: ownershipRate + operatingRate,
  };
}
