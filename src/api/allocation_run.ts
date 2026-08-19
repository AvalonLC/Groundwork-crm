/**
 * Turning overhead pools into per-division allocations.
 *
 * This is the step that has never existed. `overhead_pool` is enterable (#68),
 * `allocateOverheadPools` and `computeDivisionRate` are written and tested, the
 * rollup and the recovery page both read `overhead_allocation` — and nothing has
 * ever written it. `insertOverheadAllocation` is called from two test files and
 * no route, so the chain reads:
 *
 *     overhead_pool -> [ nothing ] -> overhead_allocation -> rollup / recovery
 *
 * Three inputs per division. Two of them are business facts nobody can derive:
 *
 *   sellable_hours   how many billable hours that division expects to sell
 *   target_margin    what margin it prices toward
 *
 * They come from a form. Guessing them would produce a required bill rate that
 * looks authoritative and is invented, which is the one thing this project's
 * rules are most insistent about.
 *
 * The third, weighted_labor_rate, IS derivable — from the labor rate profiles
 * that became enterable in #66, resolved through the crews assigned to that
 * division. So it is derived, not asked for.
 *
 * Both divisors computeDivisionRate uses are unguarded there:
 *
 *   overheadRate     = allocatedOverhead / sellable_hours      -> Infinity at 0
 *   requiredBillRate = absorbedCost / (1 - target_margin)      -> Infinity at 1.0
 *
 * Same shape as computeEquipmentRate. Both are refused here.
 */

import { allocateOverheadPools, computeDivisionRate } from '../engines/allocation';
import type { DivisionInput, OverheadPoolInput } from '../engines/allocation';

/** Rates are ten-thousandths of a dollar per hour: $42.1002/hr -> 421002. */
export const RATE_SCALE = 10000;

export interface DivisionFormFields {
  division?: string;
  /** Whole hours this division expects to bill in the period. */
  sellable_hours?: string;
  /** Percent, e.g. "40" for a 40% target margin. */
  target_margin_pct?: string;
}

export interface MemberRate {
  rep_id: string;
  /** Ten-thousandths per hour, as /internal/rates/resolve returns. */
  resolved_rate: number | null;
  /** Billable hours behind that rate, for weighting. */
  billable_hours?: number | null;
}

export interface WeightedRate {
  /** Dollars per hour, which is what computeDivisionRate expects. */
  rate: number;
  /** How many people contributed a rate. */
  counted: number;
  /** People in the division with no resolvable rate. */
  unrated: string[];
}

/**
 * Average burdened rate across a division, weighted by billable hours.
 *
 * Weighted rather than a plain mean because a division with one full-time
 * foreman and one occasional helper does not cost the average of their two
 * rates per hour — it costs whatever the hours actually skew toward.
 *
 * People with no resolvable rate are EXCLUDED and named, never counted as zero.
 * Counting them at zero quietly reports the division as cheaper than it is,
 * which is the same trap crew_cost.ts documents.
 */
export function weightedLaborRate(members: MemberRate[]): WeightedRate {
  const unrated: string[] = [];
  let weightedTotal = 0;
  let hoursTotal = 0;
  let counted = 0;

  for (const m of members || []) {
    const rate = Number(m.resolved_rate);
    if (!Number.isFinite(rate) || rate <= 0) {
      unrated.push(m.rep_id);
      continue;
    }
    // A rate with no hours behind it still counts, at weight 1 — otherwise a
    // profile that has not logged time yet would vanish from the average.
    const hours = Math.max(1, Math.trunc(Number(m.billable_hours) || 0) || 1);
    weightedTotal += rate * hours;
    hoursTotal += hours;
    counted++;
  }

  return {
    rate: hoursTotal > 0 ? weightedTotal / hoursTotal / RATE_SCALE : 0,
    counted,
    unrated,
  };
}

export interface DivisionPlan {
  division: string;
  sellable_hours: number;
  /** 0..1, as computeDivisionRate expects. */
  target_margin: number;
}

export type ParseResult<T> = { ok: true; value: T } | { ok: false; errors: string[] };

/** Percent string -> 0..1, refusing the values that make the engine divide by zero. */
export function parseDivisionPlan(fields: DivisionFormFields): ParseResult<DivisionPlan> {
  const errors: string[] = [];

  const division = String(fields.division || '').trim();
  if (!division) errors.push('Division is required.');

  const hoursRaw = String(fields.sellable_hours ?? '').trim();
  const hours = /^\d+$/.test(hoursRaw) ? Number(hoursRaw) : NaN;
  if (!Number.isFinite(hours)) errors.push('Billable hours must be a whole number.');
  // computeDivisionRate divides by this and does not guard it.
  else if (hours <= 0) errors.push('Billable hours must be greater than zero — the overhead rate is divided by it.');

  const marginRaw = String(fields.target_margin_pct ?? '').trim();
  const marginPct = /^\d+(\.\d+)?$/.test(marginRaw) ? Number(marginRaw) : NaN;
  if (!Number.isFinite(marginPct)) errors.push('Target margin must be a number.');
  else if (marginPct < 0) errors.push('Target margin cannot be negative.');
  // requiredBillRate = absorbedCost / (1 - target_margin). At 100% that is a
  // division by zero; above it the bill rate goes negative, which is worse
  // because it looks like an answer.
  else if (marginPct >= 100) errors.push('Target margin must be below 100% — at 100% the required bill rate is infinite.');

  if (errors.length) return { ok: false, errors };
  return { ok: true, value: { division, sellable_hours: hours, target_margin: marginPct / 100 } };
}

export interface AllocationRow {
  company_id: string;
  division: string;
  as_of: string;
  sellable_hours: number;
  allocated_overhead_cents: number;
  weighted_labor_rate_cents: number;
  overhead_rate: number;
  absorbed_cost_cents: number;
  target_margin: number;
  required_bill_rate_cents: number;
}

export interface BuildResult {
  rows: AllocationRow[];
  warnings: string[];
}

/**
 * Run the engine over every division that has both pools and a plan.
 *
 * `allocateOverheadPools` throws on an unallocated pool or revenue-driven
 * overhead above 10% — those are refused at the pool form (#68), so reaching
 * them here means the data changed underneath. The throw is deliberately not
 * caught: a wrong allocation is worse than a failed one.
 */
export function buildAllocationRows(
  companyId: string,
  asOf: string,
  pools: OverheadPoolInput[],
  plans: DivisionPlan[],
  laborRateFor: (division: string) => WeightedRate,
): BuildResult {
  const { byDivision } = allocateOverheadPools(pools);
  const rows: AllocationRow[] = [];
  const warnings: string[] = [];

  for (const plan of plans) {
    const allocatedCents = byDivision[plan.division] ?? 0;
    if (allocatedCents === 0) {
      warnings.push(`${plan.division} has no overhead pools, so its allocated overhead is zero.`);
    }

    const labor = laborRateFor(plan.division);
    if (labor.counted === 0) {
      warnings.push(
        `${plan.division} has no resolvable labor rate — its absorbed cost is overhead only, ` +
        'which understates what an hour there actually costs.',
      );
    }
    if (labor.unrated.length) {
      warnings.push(
        `${plan.division}: ${labor.unrated.length} ` +
        `${labor.unrated.length === 1 ? 'person has' : 'people have'} no labor rate and ` +
        'are excluded from its weighted rate rather than counted as free.',
      );
    }

    const input: DivisionInput = {
      division: plan.division,
      sellable_hours: plan.sellable_hours,
      weighted_labor_rate: labor.rate,
      target_margin: plan.target_margin,
    };
    const r = computeDivisionRate(input, allocatedCents);

    rows.push({
      company_id: companyId,
      division: r.division,
      as_of: asOf,
      sellable_hours: r.sellable_hours,
      allocated_overhead_cents: r.allocated_overhead_cents,
      // Dollars -> cents at the boundary, rounded once.
      weighted_labor_rate_cents: Math.round(r.weighted_labor_rate * 100),
      overhead_rate: Math.round(r.overhead_rate * RATE_SCALE),
      absorbed_cost_cents: Math.round(r.absorbed_cost * 100),
      target_margin: Math.round(r.target_margin * RATE_SCALE),
      required_bill_rate_cents: Math.round(r.required_bill_rate * 100),
    });
  }

  return { rows, warnings };
}
