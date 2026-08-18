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
