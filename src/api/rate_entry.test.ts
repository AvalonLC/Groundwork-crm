import { describe, it, expect } from 'vitest';
import { parseRateForm, decimalToScaled, parseHours, type RateFormFields } from './rate_entry';

const TENANT = 'avalon';

/**
 * The golden fixture, as somebody would type it into the form.
 *
 * fixtures/golden.json burden_labor_with_equipment, in dollars and percents
 * instead of cents and ten-thousandths. If the form's conversion is right, the
 * preview must land on the same 42.1002 the BH-01 engine test asserts — which
 * is the whole point of testing it this way rather than against hand-written
 * expected integers.
 */
const GOLDEN: RateFormFields = {
  scope: 'employee', scope_id: 'emp-1',
  wage: '24', paid_hours: '2080', pto_hours: '96', shop_hours: '168', idle_hours: '194',
  tax_pct: '8.65', comp_pct: '7',
  benefits_monthly: '260',
  support_truck_annual: '4200', support_tools_annual: '834', support_equipment_annual: '2400',
  effective_from: '2026-01-01',
};

const ok = (r: ReturnType<typeof parseRateForm>) => {
  if (!r.ok) throw new Error(`expected ok, got: ${r.errors.join(' | ')}`);
  return r;
};

describe('decimalToScaled', () => {
  it('RE-01 moves the decimal point without multiplying a float', () => {
    // Number('8.65') * 100 is 864.9999999999999. This schema does not keep floats.
    expect(decimalToScaled('8.65', 10000)).toBe(86500);
    expect(decimalToScaled('24', 100)).toBe(2400);
    expect(decimalToScaled('24.5', 100)).toBe(2450);
    expect(decimalToScaled('0.07', 10000)).toBe(700);
    expect(decimalToScaled('1234.56', 100)).toBe(123456);
  });

  it('RE-02 rounds beyond the scale rather than truncating', () => {
    // Truncating turns half a cent into nothing, every time, in one direction.
    expect(decimalToScaled('0.005', 100)).toBe(1);
    expect(decimalToScaled('0.004', 100)).toBe(0);
    expect(decimalToScaled('9.999', 100)).toBe(1000);
  });

  it('RE-03 rejects anything that is not a plain decimal', () => {
    for (const bad of ['', '  ', 'abc', '1.2.3', '$24', '1e3', null, undefined]) {
      expect(decimalToScaled(bad as any, 100), String(bad)).toBeNull();
    }
  });

  it('RE-04 whole hours only — a fraction is a typo, not a truncation', () => {
    expect(parseHours('2080')).toBe(2080);
    expect(parseHours('0')).toBe(0);
    expect(parseHours('40.5')).toBeNull();
    expect(parseHours('-8')).toBeNull();
    expect(parseHours('abc')).toBeNull();
  });
});

describe('parseRateForm — the golden fixture, typed into the form', () => {
  it('RE-05 produces exactly the integers the schema expects', () => {
    const r = ok(parseRateForm(TENANT, GOLDEN, false));
    expect(r.row).toMatchObject({
      company_id: TENANT, scope: 'employee', scope_id: 'emp-1',
      wage_cents: 2400, paid_hours: 2080, pto_hours: 96, shop_hours: 168, idle_hours: 194,
      tax_rate: 865,   // 8.65% -> 0.0865 -> 865 ten-thousandths
      comp_rate: 700,  // 7%    -> 0.07   -> 700
      benefits_monthly_cents: 26000,
      support_truck_annual_cents: 420000,
      support_tools_annual_cents: 83400,
      support_equipment_annual_cents: 240000,
      effective_from: '2026-01-01',
    });
  });

  it('RE-06 previews the fixture rate — 42.1002, the BH-01 number', () => {
    const r = ok(parseRateForm(TENANT, GOLDEN, false));
    expect(r.preview.billable_hours).toBe(1622);
    expect(r.preview.burdened_rate).toBeCloseTo(42.1002, 3);
    expect(Number(r.preview.burden_multiplier.toFixed(3))).toBe(1.754);
  });

  it('RE-07 with the equipment engine on, the rate is 40.6205', () => {
    // BH-13. Equipment must be zero in the labor profile, and the rate drops to
    // the engine-on figure. Anything else double-charges the machine.
    const r = ok(parseRateForm(TENANT, { ...GOLDEN, support_equipment_annual: '0' }, true));
    expect(r.row.support_equipment_annual_cents).toBe(0);
    expect(r.preview.burdened_rate).toBeCloseTo(40.6205, 3);
    expect(Number(r.preview.burden_multiplier.toFixed(3))).toBe(1.693);
    expect(r.preview.support_equipment_annual_used).toBe(0);
  });
});

describe('parseRateForm — refusals', () => {
  it('RE-08 refuses equipment cost while the equipment engine is active', () => {
    // The single most likely bug in this project, per CLAUDE.md. Not a warning:
    // saving this row bills every machine twice, forever, silently.
    const r = parseRateForm(TENANT, GOLDEN, true);
    expect(r.ok).toBe(false);
    expect((r as any).errors.join(' ')).toMatch(/must be 0 while the equipment engine is active/);
  });

  it('RE-09 refuses a profile with no billable hours', () => {
    // BH-03's divide-by-zero, caught at the form so the person is told, rather
    // than silently getting billable_hours = 1 and a rate 1600x too high.
    const r = parseRateForm(TENANT, { ...GOLDEN, idle_hours: '5000' }, false);
    expect(r.ok).toBe(false);
    expect((r as any).errors.join(' ')).toMatch(/Paid hours must exceed/);
  });

  it('RE-10 refuses a zero or missing wage', () => {
    expect(parseRateForm(TENANT, { ...GOLDEN, wage: '0' }, false).ok).toBe(false);
    expect(parseRateForm(TENANT, { ...GOLDEN, wage: '' }, false).ok).toBe(false);
  });

  it('RE-11 refuses a bad scope, and a missing subject', () => {
    expect(parseRateForm(TENANT, { ...GOLDEN, scope: 'department' }, false).ok).toBe(false);
    expect(parseRateForm(TENANT, { ...GOLDEN, scope_id: '' }, false).ok).toBe(false);
  });

  it('RE-12 a tenant-scope row defaults its subject to the tenant', () => {
    // "Everyone here" does not need a separate id typed in twice.
    const r = ok(parseRateForm(TENANT, { ...GOLDEN, scope: 'tenant', scope_id: '' }, false));
    expect(r.row.scope_id).toBe(TENANT);
  });

  it('RE-13 refuses a malformed effective date', () => {
    for (const d of ['', '01/01/2026', '2026-1-1', 'today']) {
      expect(parseRateForm(TENANT, { ...GOLDEN, effective_from: d }, false).ok, d).toBe(false);
    }
  });

  it('RE-14 reports every problem at once, not one per reload', () => {
    const r = parseRateForm(TENANT, { scope: 'nope', wage: 'x', paid_hours: '0', effective_from: '' }, false);
    expect(r.ok).toBe(false);
    expect((r as any).errors.length).toBeGreaterThan(3);
  });
});

describe('parseRateForm — warnings that do not block', () => {
  it('RE-15 flags low utilization but still saves', () => {
    const r = ok(parseRateForm(TENANT, { ...GOLDEN, idle_hours: '800' }, false));
    expect(r.preview.suspect).toBe(true);
    expect(r.warnings.join(' ')).toMatch(/billable/);
  });

  it('RE-16 flags an implausible multiplier but still saves', () => {
    const r = ok(parseRateForm(TENANT, { ...GOLDEN, support_truck_annual: '90000' }, false));
    expect(r.preview.config_warning).toBe(true);
    expect(r.warnings.join(' ')).toMatch(/x the wage/);
  });

  it('RE-17 says so when the equipment engine is why equipment is excluded', () => {
    const r = ok(parseRateForm(TENANT, { ...GOLDEN, support_equipment_annual: '0' }, true));
    expect(r.warnings.join(' ')).toMatch(/equipment engine is on/);
  });

  it('RE-18 a clean profile warns about nothing', () => {
    expect(ok(parseRateForm(TENANT, GOLDEN, false)).warnings).toEqual([]);
  });
});

// ── Equipment ────────────────────────────────────────────────────────────────

import { parseEquipmentForm, type EquipmentFormFields } from './rate_entry';
import { computeEquipmentRate } from '../engines/equipment';

/** fixtures/golden.json equipment_rate, in the units a person types. */
const GOLDEN_EQ: EquipmentFormFields = {
  equipment_id: 'ex-310', effective_from: '2026-01-01',
  purchase_price: '62000', salvage: '14000',
  life_years: '7', annual_machine_hours: '720',
  finance_pct: '7.5',
  insurance_annual: '1180', storage_annual: '600',
  fuel_gal_per_hr: '2.4', fuel_price: '4.05',
  repairs_annual: '4900', wear_annual: '3300',
  lube_pct_of_fuel: '12',
};

const okEq = (r: ReturnType<typeof parseEquipmentForm>) => {
  if (!r.ok) throw new Error(`expected ok, got: ${r.errors.join(' | ')}`);
  return r;
};

describe('parseEquipmentForm — the golden fixture, typed into the form', () => {
  it('EQE-01 produces the integers the schema expects', () => {
    const r = okEq(parseEquipmentForm(TENANT, GOLDEN_EQ));
    expect(r.row).toMatchObject({
      equipment_id: 'ex-310',
      purchase_price_cents: 6_200_000, salvage_cents: 1_400_000,
      life_years: 7, annual_machine_hours: 720,
      finance_rate: 750,        // 7.5% -> 0.075 -> 750
      insurance_annual_cents: 118_000, storage_annual_cents: 60_000,
      fuel_gal_per_hr: 24_000,  // 2.4 gal/hr in ten-thousandths
      fuel_price_cents: 405,    // $4.05/gal
      repairs_annual_cents: 490_000, wear_annual_cents: 330_000,
      lube_pct_of_fuel: 1_200,  // 12%
    });
  });

  it('EQE-02 previews the fixture rate — the EQ-01 numbers', () => {
    const r = okEq(parseEquipmentForm(TENANT, GOLDEN_EQ));
    expect(r.preview.ownership_annual).toBeCloseTo(11487.14, 2);
    expect(r.preview.ownership_rate).toBeCloseTo(15.9544, 3);
    expect(r.preview.operating_rate).toBeCloseTo(22.2753, 3);
    expect(r.preview.total_rate).toBeCloseTo(38.2297, 3);
  });
});

describe('parseEquipmentForm — the divisors computeEquipmentRate does not guard', () => {
  it('EQE-03 refuses zero machine hours', () => {
    // computeBurden falls back to 1 billable hour and flags config_error.
    // computeEquipmentRate has no such guard — it divides straight through, so
    // zero here writes Infinity into job costing and nothing downstream catches it.
    const r = parseEquipmentForm(TENANT, { ...GOLDEN_EQ, annual_machine_hours: '0' });
    expect(r.ok).toBe(false);
    expect((r as any).errors.join(' ')).toMatch(/Machine hours a year must be greater than zero/);
  });

  it('EQE-04 refuses zero life years', () => {
    const r = parseEquipmentForm(TENANT, { ...GOLDEN_EQ, life_years: '0' });
    expect(r.ok).toBe(false);
    expect((r as any).errors.join(' ')).toMatch(/Life in years must be at least 1/);
  });

  it('EQE-05 proves those guards are load-bearing', () => {
    // What the engine actually does with the values the form refuses to pass
    // it. If someone ever "simplifies" the two checks above, this is the
    // consequence they are removing: an hourly cost of Infinity, written to
    // job costing, with nothing downstream to catch it.
    const zeroHours = computeEquipmentRate({
      purchase_price: 62000, salvage: 14000, life_years: 7,
      annual_machine_hours: 0,
      finance_rate: 0.075, insurance_annual: 1180, storage_annual: 600,
      fuel_gal_per_hr: 2.4, fuel_price: 4.05, repairs_annual: 4900,
      wear_annual: 3300, lube_pct_of_fuel: 0.12,
    });
    expect(Number.isFinite(zeroHours.total_rate)).toBe(false);

    const zeroLife = computeEquipmentRate({
      purchase_price: 62000, salvage: 14000, life_years: 0,
      annual_machine_hours: 720,
      finance_rate: 0.075, insurance_annual: 1180, storage_annual: 600,
      fuel_gal_per_hr: 2.4, fuel_price: 4.05, repairs_annual: 4900,
      wear_annual: 3300, lube_pct_of_fuel: 0.12,
    });
    expect(Number.isFinite(zeroLife.total_rate)).toBe(false);
  });
});

describe('parseEquipmentForm — other refusals and warnings', () => {
  it('EQE-06 refuses salvage above purchase price', () => {
    // Negative depreciation: the machine earns money by ageing. Usually a
    // swapped pair of fields.
    const r = parseEquipmentForm(TENANT, { ...GOLDEN_EQ, salvage: '99000' });
    expect(r.ok).toBe(false);
    expect((r as any).errors.join(' ')).toMatch(/Salvage value cannot exceed/);
  });

  it('EQE-07 refuses a zero purchase price and a missing machine', () => {
    expect(parseEquipmentForm(TENANT, { ...GOLDEN_EQ, purchase_price: '0' }).ok).toBe(false);
    expect(parseEquipmentForm(TENANT, { ...GOLDEN_EQ, equipment_id: '' }).ok).toBe(false);
  });

  it('EQE-08 warns about implausibly low annual hours without blocking', () => {
    const r = okEq(parseEquipmentForm(TENANT, { ...GOLDEN_EQ, annual_machine_hours: '40' }));
    expect(r.warnings.join(' ')).toMatch(/hours and not days/);
  });

  it('EQE-09 warns when running cost dwarfs owning cost', () => {
    // Fuel price out by a factor of ten is the usual cause.
    const r = okEq(parseEquipmentForm(TENANT, { ...GOLDEN_EQ, fuel_price: '40.50' }));
    expect(r.warnings.join(' ')).toMatch(/factor of ten/);
  });

  it('EQE-10 the clean fixture warns about nothing', () => {
    expect(okEq(parseEquipmentForm(TENANT, GOLDEN_EQ)).warnings).toEqual([]);
  });
});

// ── Overhead pools ───────────────────────────────────────────────────────────

import { parseOverheadForm, type OverheadFormFields } from './rate_entry';
import { allocateOverheadPools } from '../engines/allocation';

const POOL = (division: string, pool_type: string, annual_cost_cents: number, driver = 'sellable_hours') =>
  ({ division, pool_type, annual_cost_cents, driver }) as any;

const GOLDEN_POOL: OverheadFormFields = {
  division: 'hardscape', pool_type: 'facility', annual_cost: '120000',
  driver: 'sellable_hours', as_of: '2026-01-01',
};

const okOv = (r: ReturnType<typeof parseOverheadForm>) => {
  if (!r.ok) throw new Error(`expected ok, got: ${r.errors.join(' | ')}`);
  return r;
};

describe('parseOverheadForm', () => {
  it('OV-01 converts dollars to cents and keeps the driver', () => {
    const r = okOv(parseOverheadForm(TENANT, GOLDEN_POOL, []));
    expect(r.row).toMatchObject({
      company_id: TENANT, division: 'hardscape', pool_type: 'facility',
      annual_cost_cents: 12_000_000, driver: 'sellable_hours', as_of: '2026-01-01',
    });
  });

  it('OV-02 refuses a pool with no division', () => {
    // allocateOverheadPools throws on this rather than skipping the pool, which
    // takes down every page that computes an allocation.
    const r = parseOverheadForm(TENANT, { ...GOLDEN_POOL, division: '' }, []);
    expect(r.ok).toBe(false);
    expect((r as any).errors.join(' ')).toMatch(/pool with nowhere to land/);
  });

  it('OV-03 refuses a driver the engine does not implement', () => {
    // The Why text on this page mentions headcount and machine hours; the engine
    // implements exactly two. Offering a third would type-check and then throw.
    const r = parseOverheadForm(TENANT, { ...GOLDEN_POOL, driver: 'headcount' }, []);
    expect(r.ok).toBe(false);
    expect((r as any).errors.join(' ')).toMatch(/Driver must be one of/);
  });

  it('OV-04 refuses a duplicate pool for the same division', () => {
    // listOverheadPools has no as_of filter, so a second row for the same pool
    // is the same cost counted twice in every rate that inherits it.
    const r = parseOverheadForm(TENANT, GOLDEN_POOL, [POOL('hardscape', 'facility', 9_000_000)]);
    expect(r.ok).toBe(false);
    expect((r as any).errors.join(' ')).toMatch(/counts that cost twice/);
  });

  it('OV-05 the same pool_type in a DIFFERENT division is fine', () => {
    expect(okOv(parseOverheadForm(TENANT, GOLDEN_POOL, [POOL('maintenance', 'facility', 9_000_000)])).row.division)
      .toBe('hardscape');
  });
});

describe('parseOverheadForm — the 10% revenue rule, across the whole set', () => {
  it('OV-06 refuses the row that would cross the line', () => {
    // 10,000 revenue against 89,000 other = 10.1%. The rule is about the set,
    // so the row being added is what gets refused.
    const existing = [POOL('hardscape', 'facility', 8_900_000)];
    const r = parseOverheadForm(
      TENANT, { ...GOLDEN_POOL, pool_type: 'marketing', driver: 'revenue', annual_cost: '10000' }, existing,
    );
    expect(r.ok).toBe(false);
    expect((r as any).errors.join(' ')).toMatch(/limit is 10%/);
  });

  it('OV-07 allows exactly at the line', () => {
    // 10,000 of 100,000 is 10.0% — the rule is "must not exceed".
    const existing = [POOL('hardscape', 'facility', 9_000_000)];
    const r = okOv(parseOverheadForm(
      TENANT, { ...GOLDEN_POOL, pool_type: 'marketing', driver: 'revenue', annual_cost: '10000' }, existing,
    ));
    expect(r.totals.revenue_share).toBeCloseTo(0.10, 6);
  });

  it('OV-08 counts revenue pools that already exist, not just this one', () => {
    // Two 6% pools are individually fine and together are not.
    const existing = [POOL('hardscape', 'facility', 8_800_000), POOL('hardscape', 'ads', 600_000, 'revenue')];
    const r = parseOverheadForm(
      TENANT, { ...GOLDEN_POOL, pool_type: 'sponsorship', driver: 'revenue', annual_cost: '6000' }, existing,
    );
    expect(r.ok).toBe(false);
  });

  it('OV-09 warns while approaching the limit without blocking', () => {
    // 8,500 of 100,500 is 8.46% — past the warning line at 8%, short of the 10%
    // refusal. (8,000 of 100,000 is exactly 8%, which is NOT above it.)
    const existing = [POOL('hardscape', 'facility', 9_200_000)];
    const r = okOv(parseOverheadForm(
      TENANT, { ...GOLDEN_POOL, pool_type: 'marketing', driver: 'revenue', annual_cost: '8500' }, existing,
    ));
    expect(r.totals.revenue_share).toBeGreaterThan(0.08);
    expect(r.totals.revenue_share).toBeLessThan(0.10);
    expect(r.warnings.join(' ')).toMatch(/not much room left/);
  });

  it('OV-10 a set the form accepts is a set the engine accepts', () => {
    // The point of all of it: what the form allows through must not throw in
    // allocateOverheadPools. This is the coupling the tests exist to hold.
    const accepted = [
      POOL('hardscape', 'facility', 9_000_000),
      POOL('hardscape', 'marketing', 1_000_000, 'revenue'),
    ];
    const r = okOv(parseOverheadForm(
      TENANT, { ...GOLDEN_POOL, division: 'maintenance', pool_type: 'yard', annual_cost: '5000' }, accepted,
    ));
    const all = [...accepted, { division: r.row.division, pool_type: r.row.pool_type,
      annual_cost_cents: r.row.annual_cost_cents, driver: r.row.driver }] as any;
    expect(() => allocateOverheadPools(all)).not.toThrow();
  });

  it('OV-11 and a set the form refuses is one the engine would have thrown on', () => {
    const existing = [POOL('hardscape', 'facility', 8_900_000)];
    const bad = [...existing, POOL('hardscape', 'marketing', 1_010_000, 'revenue')];
    expect(() => allocateOverheadPools(bad)).toThrow(/10%/);
  });
});
