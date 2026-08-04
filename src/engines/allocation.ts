export interface OverheadPoolInput {
  division: string;
  pool_type: string;
  annual_cost_cents: number;
  driver: "sellable_hours" | "revenue";
}

export interface DivisionInput {
  division: string;
  sellable_hours: number;
  weighted_labor_rate: number; // dollars/hr
  target_margin: number; // 0-1
}

export interface DivisionRate {
  division: string;
  sellable_hours: number;
  allocated_overhead_cents: number;
  weighted_labor_rate: number;
  overhead_rate: number; // $/hr
  absorbed_cost: number; // $/hr
  target_margin: number;
  required_bill_rate: number; // $/hr
}

/**
 * Pure function. No DB, no I/O. See docs/spec/ALLOCATION.md.
 *
 * Allocation is a group-by-sum over already-assigned overhead_pool rows, not a
 * proportional split of one grand total — each pool carries its own division
 * and driver (the "multi-driver" in the task title), so the allocation itself
 * is just addition. What the engine enforces is the two hard rules: revenue
 * may never drive more than 10% of the total pool, and no pool may be left
 * without a division.
 */
export function allocateOverheadPools(
  pools: OverheadPoolInput[],
): { byDivision: Record<string, number>; totalCents: number } {
  const byDivision: Record<string, number> = {};
  let totalCents = 0;
  let revenueCents = 0;

  for (const p of pools) {
    if (!p.division) {
      throw new Error(`overhead pool "${p.pool_type}" has no division — pools may not go unallocated`);
    }
    byDivision[p.division] = (byDivision[p.division] ?? 0) + p.annual_cost_cents;
    totalCents += p.annual_cost_cents;
    if (p.driver === "revenue") revenueCents += p.annual_cost_cents;
  }

  if (totalCents > 0 && revenueCents / totalCents > 0.10) {
    throw new Error(
      `revenue-driven pools are ${((revenueCents / totalCents) * 100).toFixed(1)}% of total overhead — must not exceed 10%`,
    );
  }

  return { byDivision, totalCents };
}

export function computeDivisionRate(
  d: DivisionInput, allocatedOverheadCents: number,
): DivisionRate {
  const allocatedOverhead = allocatedOverheadCents / 100;
  const overheadRate = allocatedOverhead / d.sellable_hours;
  const absorbedCost = d.weighted_labor_rate + overheadRate;
  const requiredBillRate = absorbedCost / (1 - d.target_margin);

  return {
    division: d.division,
    sellable_hours: d.sellable_hours,
    allocated_overhead_cents: allocatedOverheadCents,
    weighted_labor_rate: d.weighted_labor_rate,
    overhead_rate: overheadRate,
    absorbed_cost: absorbedCost,
    target_margin: d.target_margin,
    required_bill_rate: requiredBillRate,
  };
}

export function computeBlendedOverheadRate(
  totalOverheadCents: number, totalSellableHours: number,
): number {
  return (totalOverheadCents / 100) / totalSellableHours;
}
