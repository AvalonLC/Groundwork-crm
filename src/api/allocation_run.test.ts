import { describe, it, expect } from 'vitest';
import {
  weightedLaborRate, parseDivisionPlan, buildAllocationRows,
  type MemberRate, type DivisionPlan,
} from './allocation_run';
import golden from '../../fixtures/golden.json';

const F = golden.overhead_allocation;
/**
 * The fixture's own tolerance, one cent, same as src/engines/allocation.test.ts.
 *
 * The fixture's required_bill_rate is derived from its ROUNDED absorbed_cost
 * (62.62 / 0.6 = 104.37), while the engine divides the unrounded one
 * (62.617... / 0.6 = 104.3617 -> 104.36). Exactly one cent apart, which is what
 * tolerance.rate exists for — and matching the engine test rather than
 * inventing a stricter bar here is the point.
 */
/**
 * Compared in integer CENTS, allowing one cent.
 *
 * Comparing floats here fails on representation alone: |104.36 - 104.37| comes
 * out as 0.010000000000005, which is not <= 0.01. The fixture's tolerance is one
 * cent, so expressing the comparison in cents says exactly that and cannot drift
 * — which is also the unit these values are stored in.
 */
const centsWithin1 = (actualCents: number, expectedDollars: number, label: string) =>
  expect(
    Math.abs(actualCents - Math.round(expectedDollars * 100)),
    `${label}: ${actualCents}c vs ${Math.round(expectedDollars * 100)}c`,
  ).toBeLessThanOrEqual(Math.round(golden.tolerance.rate * 100));
const TENANT = 'avalon';
const AS_OF = '2026-08-01';

/** Ten-thousandths, as /internal/rates/resolve returns them. */
const member = (rep_id: string, dollarsPerHour: number, billable_hours?: number): MemberRate =>
  ({ rep_id, resolved_rate: Math.round(dollarsPerHour * 10000), billable_hours });

describe('weightedLaborRate', () => {
  it('AR-01 weights by billable hours, not by headcount', () => {
    // One full-time foreman at $50 and one occasional helper at $30. A plain
    // mean says $40/hr; the hours say the division mostly costs $50.
    const r = weightedLaborRate([member('a', 50, 1600), member('b', 30, 200)]);
    expect(r.rate).toBeCloseTo((50 * 1600 + 30 * 200) / 1800, 4);
    expect(r.rate).toBeGreaterThan(47);
    expect(r.counted).toBe(2);
  });

  it('AR-02 a rate with no hours yet still counts, at weight 1', () => {
    // Otherwise a profile entered today, before anyone has logged time against
    // it, would silently vanish from the division's average.
    const r = weightedLaborRate([member('a', 40)]);
    expect(r.rate).toBeCloseTo(40, 6);
    expect(r.counted).toBe(1);
  });

  it('AR-03 people with no rate are excluded and NAMED, never counted as zero', () => {
    // Counting them at zero reports the division as cheaper than it is — the
    // same trap crew_cost.ts documents.
    const r = weightedLaborRate([member('a', 40, 1000), { rep_id: 'b', resolved_rate: null }]);
    expect(r.rate).toBeCloseTo(40, 6);
    expect(r.counted).toBe(1);
    expect(r.unrated).toEqual(['b']);
  });

  it('AR-04 a division with nobody rated is 0 and says so, not a fabricated average', () => {
    const r = weightedLaborRate([{ rep_id: 'a', resolved_rate: null }, { rep_id: 'b', resolved_rate: 0 }]);
    expect(r.rate).toBe(0);
    expect(r.counted).toBe(0);
    expect(r.unrated).toEqual(['a', 'b']);
  });
});

describe('parseDivisionPlan — the divisors computeDivisionRate does not guard', () => {
  const ok = { division: 'maintenance', sellable_hours: '8110', target_margin_pct: '40' };

  it('AR-05 converts a percent to the 0..1 the engine expects', () => {
    const r = parseDivisionPlan(ok);
    expect(r.ok && r.value).toMatchObject({ division: 'maintenance', sellable_hours: 8110, target_margin: 0.4 });
  });

  it('AR-06 refuses zero billable hours', () => {
    // overheadRate = allocatedOverhead / sellable_hours, unguarded in the engine.
    const r = parseDivisionPlan({ ...ok, sellable_hours: '0' });
    expect(r.ok).toBe(false);
    expect((r as any).errors.join(' ')).toMatch(/divided by it/);
  });

  it('AR-07 refuses a 100% target margin', () => {
    // requiredBillRate = absorbedCost / (1 - target_margin). At 1.0 that is a
    // division by zero; above it the bill rate goes negative, which is worse
    // because it still looks like an answer.
    const r = parseDivisionPlan({ ...ok, target_margin_pct: '100' });
    expect(r.ok).toBe(false);
    expect((r as any).errors.join(' ')).toMatch(/below 100%/);

    const over = parseDivisionPlan({ ...ok, target_margin_pct: '120' });
    expect(over.ok).toBe(false);
  });

  it('AR-08 refuses junk rather than coercing it', () => {
    for (const f of [{ sellable_hours: '8110.5' }, { sellable_hours: 'lots' }, { target_margin_pct: 'forty' }, { division: '' }]) {
      expect(parseDivisionPlan({ ...ok, ...f }).ok, JSON.stringify(f)).toBe(false);
    }
  });
});

describe('buildAllocationRows — against the ALLOCATION.md fixture', () => {
  const pools = [
    { division: 'maintenance', pool_type: 'facility', annual_cost_cents: Math.round(F.divisions.maintenance.allocated_overhead * 100), driver: 'sellable_hours' as const },
    { division: 'hardscape', pool_type: 'facility', annual_cost_cents: Math.round(F.divisions.hardscape.allocated_overhead * 100), driver: 'sellable_hours' as const },
  ];

  const plans: DivisionPlan[] = [
    { division: 'maintenance', sellable_hours: F.divisions.maintenance.sellable_hours, target_margin: F.divisions.maintenance.target_margin },
    { division: 'hardscape', sellable_hours: F.divisions.hardscape.sellable_hours, target_margin: F.divisions.hardscape.target_margin },
  ];

  const rateFor = (d: string) => ({
    rate: (F.divisions as any)[d].weighted_labor_rate, counted: 1, unrated: [] as string[],
  });

  it('AR-09 reproduces the fixture overhead rate and required bill rate', () => {
    // The whole point: the run must land on the same numbers ALLOCATION.md
    // specifies, not on numbers that merely look plausible.
    const { rows } = buildAllocationRows(TENANT, AS_OF, pools, plans, rateFor);
    const maint = rows.find((r) => r.division === 'maintenance')!;

    // overhead_rate is ten-thousandths, so compare it at that scale.
    expect(Math.abs(maint.overhead_rate - Math.round(F.divisions.maintenance.overhead_rate * 10000)))
      .toBeLessThanOrEqual(100); // one cent, in ten-thousandths
    centsWithin1(maint.absorbed_cost_cents, F.divisions.maintenance.absorbed_cost, 'absorbed_cost');
    centsWithin1(maint.required_bill_rate_cents, F.divisions.maintenance.required_bill_rate, 'required_bill_rate');
  });

  it('AR-10 does the same for a division with a different target margin', () => {
    // hardscape prices at 34% where maintenance prices at 40% — if the margin
    // were being applied globally rather than per division, this would drift.
    const { rows } = buildAllocationRows(TENANT, AS_OF, pools, plans, rateFor);
    const hard = rows.find((r) => r.division === 'hardscape')!;
    expect(Math.abs(hard.overhead_rate - Math.round(F.divisions.hardscape.overhead_rate * 10000)))
      .toBeLessThanOrEqual(100);
    centsWithin1(hard.required_bill_rate_cents, F.divisions.hardscape.required_bill_rate, 'required_bill_rate');
  });

  it('AR-11 stores every value as an integer, in the schema units', () => {
    const { rows } = buildAllocationRows(TENANT, AS_OF, pools, plans, rateFor);
    for (const r of rows) {
      for (const [k, v] of Object.entries(r)) {
        if (typeof v === 'number') expect(Number.isInteger(v), `${r.division}.${k} = ${v}`).toBe(true);
      }
    }
    // target_margin is ten-thousandths: 0.40 -> 4000.
    expect(rows.find((r) => r.division === 'maintenance')!.target_margin).toBe(4000);
  });

  it('AR-12 warns when a division has no pools, and still produces a row', () => {
    const { rows, warnings } = buildAllocationRows(
      TENANT, AS_OF, pools, [...plans, { division: 'snow', sellable_hours: 500, target_margin: 0.3 }], rateFor,
    );
    expect(warnings.join(' ')).toMatch(/snow has no overhead pools/);
    expect(rows.find((r) => r.division === 'snow')).toBeTruthy();
  });

  it('AR-13 warns when a division has no resolvable labor rate', () => {
    const noRate = () => ({ rate: 0, counted: 0, unrated: [] as string[] });
    const { warnings } = buildAllocationRows(TENANT, AS_OF, pools, plans, noRate);
    expect(warnings.join(' ')).toMatch(/no resolvable labor rate/);
    expect(warnings.join(' ')).toMatch(/understates/);
  });

  it('AR-14 names unrated people rather than absorbing them silently', () => {
    const withUnrated = (d: string) => ({ ...rateFor(d), unrated: ['emp-7', 'emp-9'] });
    const { warnings } = buildAllocationRows(TENANT, AS_OF, pools, plans, withUnrated);
    expect(warnings.join(' ')).toMatch(/2 people have no labor rate/);
    expect(warnings.join(' ')).toMatch(/rather than counted as free/);
  });

  it('AR-15 lets the engine throw on a forbidden pool set rather than catching it', () => {
    // allocateOverheadPools refuses revenue-driven overhead above 10%. That is
    // refused at the pool form, so reaching it here means the data changed
    // underneath — and a wrong allocation is worse than a failed one.
    const bad = [
      { division: 'maintenance', pool_type: 'facility', annual_cost_cents: 8_900_000, driver: 'sellable_hours' as const },
      { division: 'maintenance', pool_type: 'ads', annual_cost_cents: 1_100_000, driver: 'revenue' as const },
    ];
    expect(() => buildAllocationRows(TENANT, AS_OF, bad, plans, rateFor)).toThrow(/10%/);
  });
});
