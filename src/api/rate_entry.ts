/**
 * Turning a filled-in form into a labor_rate_profile row.
 *
 * There has never been one. `insertLaborRateProfile` is called from two test
 * files and no route, `/finance/budget` is three read-only tables, and until a
 * row exists `postTimeEntryToLedger` resolves nothing — which is why production
 * was returning `no_rate_resolves`. Job costing and overhead recovery cannot
 * produce a number for a tenant that has no rate.
 *
 * This module is the boundary the project's units rule talks about: the form
 * speaks dollars and percents, the database speaks integer cents and integer
 * ten-thousandths, and the conversion happens exactly here.
 */

import { computeBurden } from '../engines/burden';
import { computeEquipmentRate, type EquipmentRateResult } from '../engines/equipment';
import type { BurdenResult } from '../engines/types';
import type { LaborRateProfile, EquipmentRateProfile, OverheadPool, RateScope } from '../db/schema';
import { validateEquipmentSupport } from './compensation';

export const SCOPES = ['employee', 'crew', 'role', 'tenant'] as const;

/** Raw strings, as they arrive from a form body. */
export interface RateFormFields {
  scope?: string;
  scope_id?: string;
  /** Dollars per hour, e.g. "24" or "24.50". */
  wage?: string;
  paid_hours?: string;
  pto_hours?: string;
  shop_hours?: string;
  idle_hours?: string;
  /** Percent, e.g. "8.65" for 8.65%. */
  tax_pct?: string;
  comp_pct?: string;
  /** Dollars. */
  benefits_monthly?: string;
  support_truck_annual?: string;
  support_tools_annual?: string;
  support_equipment_annual?: string;
  require_rate_approval?: string;
  /** YYYY-MM-DD. */
  effective_from?: string;
}

/**
 * Exactly the row the repo layer writes, minus what the database fills in.
 *
 * Derived from LaborRateProfile rather than restated, so a column added to the
 * schema is a type error here instead of a field this form quietly stops
 * writing.
 */
export type RateRow = Omit<LaborRateProfile, 'id' | 'created_at' | 'effective_to'>;

/**
 * Decimal string -> scaled integer, without ever multiplying a float.
 *
 * `Number('8.65') * 100` is 864.9999999999999. Rounding hides it at two places
 * and stops hiding it somewhere else, and this schema does not keep floats. So
 * the digits are moved by string surgery: "8.65" at scale 100 is "865".
 *
 * Returns null for anything that is not a plain decimal number, so a typo
 * becomes a validation error rather than a NaN written to a money column.
 */
export function decimalToScaled(value: string | number | null | undefined, scale: number): number | null {
  if (value === null || value === undefined) return null;
  const raw = String(value).trim();
  if (raw === '') return null;
  const m = /^(-?)(\d*)(?:\.(\d*))?$/.exec(raw);
  if (!m || (!m[2] && !m[3])) return null;

  const sign = m[1] === '-' ? -1 : 1;
  const whole = m[2] || '0';
  const frac = m[3] || '';
  const places = String(scale).length - 1; // 100 -> 2, 10000 -> 4

  const padded = (frac + '0'.repeat(places)).slice(0, places);
  // Digits beyond the scale round the last kept digit rather than truncating,
  // so 0.005 at cents is 1 cent and not 0.
  const nextDigit = frac.length > places ? Number(frac[places]) : 0;
  const base = Number(whole) * scale + Number(padded || '0');
  if (!Number.isFinite(base)) return null;
  return sign * (base + (nextDigit >= 5 ? 1 : 0));
}

/** Whole hours. Rejects fractions rather than silently truncating a shift. */
export function parseHours(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined || String(value).trim() === '') return null;
  const raw = String(value).trim();
  if (!/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

export interface ParseSuccess {
  ok: true;
  row: RateRow;
  /** What this row will cost per hour, before it is written. */
  preview: BurdenResult;
  /** Non-blocking things the reviewer should see. */
  warnings: string[];
}
export interface ParseFailure { ok: false; errors: string[] }
export type ParseResult = ParseSuccess | ParseFailure;

/**
 * Validate and convert, or explain why not.
 *
 * Collects every error rather than stopping at the first, because a form that
 * reveals its problems one reload at a time is how people give up on it.
 */
export function parseRateForm(
  companyId: string,
  fields: RateFormFields,
  equipmentEngineActive: boolean,
): ParseResult {
  const errors: string[] = [];

  const scope = String(fields.scope || '').trim() as RateScope;
  if (!SCOPES.includes(scope)) errors.push(`Scope must be one of: ${SCOPES.join(', ')}.`);

  // A tenant-wide default is scoped to the tenant itself; everything else needs
  // to say who or what it is for.
  const scopeId = String(fields.scope_id || '').trim() || (scope === 'tenant' ? companyId : '');
  if (!scopeId) errors.push('Who this rate is for is required.');

  const wageCents = decimalToScaled(fields.wage, 100);
  if (wageCents === null) errors.push('Hourly wage must be a number.');
  else if (wageCents <= 0) errors.push('Hourly wage must be greater than zero.');

  const paid = parseHours(fields.paid_hours);
  if (paid === null) errors.push('Paid hours must be a whole number.');
  else if (paid <= 0) errors.push('Paid hours must be greater than zero.');

  const pto = parseHours(fields.pto_hours ?? '0');
  const shop = parseHours(fields.shop_hours ?? '0');
  const idle = parseHours(fields.idle_hours ?? '0');
  for (const [name, v] of [['PTO', pto], ['Shop', shop], ['Idle', idle]] as const) {
    if (v === null) errors.push(`${name} hours must be a whole number.`);
  }

  if (paid !== null && pto !== null && shop !== null && idle !== null) {
    // The divide-by-zero the engine guards (BH-03). Caught here so the person
    // filling the form is told, rather than silently getting billable_hours = 1.
    if (pto + shop + idle >= paid) {
      errors.push('Paid hours must exceed PTO + shop + idle — otherwise there are no billable hours to spread cost over.');
    }
  }

  const taxRate = decimalToScaled(fields.tax_pct, 10000);
  const compRate = decimalToScaled(fields.comp_pct, 10000);
  // A percent is stored as its decimal in ten-thousandths: 8.65% -> 0.0865 -> 865.
  const tax = taxRate === null ? null : Math.round(taxRate / 100);
  const comp = compRate === null ? null : Math.round(compRate / 100);
  if (tax === null || tax < 0) errors.push('Payroll tax % must be a non-negative number.');
  if (comp === null || comp < 0) errors.push("Workers' comp % must be a non-negative number.");

  const benefits = decimalToScaled(fields.benefits_monthly ?? '0', 100);
  const truck = decimalToScaled(fields.support_truck_annual ?? '0', 100);
  const tools = decimalToScaled(fields.support_tools_annual ?? '0', 100);
  const equip = decimalToScaled(fields.support_equipment_annual ?? '0', 100);
  for (const [name, v] of [
    ['Benefits', benefits], ['Truck', truck], ['Tools', tools], ['Equipment', equip],
  ] as const) {
    if (v === null || v < 0) errors.push(`${name} cost must be a non-negative number.`);
  }

  // The rule this whole project is most likely to get wrong. Not a warning.
  if (equip !== null) {
    const guard = validateEquipmentSupport(equip, equipmentEngineActive);
    if (!guard.ok) errors.push(guard.error);
  }

  const effectiveFrom = String(fields.effective_from || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(effectiveFrom)) errors.push('Effective date must be YYYY-MM-DD.');

  if (errors.length) return { ok: false, errors };

  // Cents and TenThousandths are branded types, and this is the one place in the
  // codebase entitled to mint them: every value below has just been converted
  // from a decimal string by decimalToScaled and validated. The casts are the
  // acknowledgement the brand exists to force, not a way around it.
  const cents = (n: number) => n as LaborRateProfile['wage_cents'];
  const tenThousandths = (n: number) => n as LaborRateProfile['tax_rate'];

  const row: RateRow = {
    company_id: companyId,
    scope,
    scope_id: scopeId,
    wage_cents: cents(wageCents!),
    paid_hours: paid!,
    pto_hours: pto!,
    shop_hours: shop!,
    idle_hours: idle!,
    tax_rate: tenThousandths(tax!),
    comp_rate: tenThousandths(comp!),
    benefits_monthly_cents: cents(benefits!),
    support_truck_annual_cents: cents(truck!),
    support_tools_annual_cents: cents(tools!),
    support_equipment_annual_cents: cents(equip!),
    require_rate_approval: String(fields.require_rate_approval || '') === '1' ? 1 : 0,
    effective_from: effectiveFrom,
  };

  // Same conversion /internal/rates/resolve uses, so the preview and the
  // resolved rate cannot disagree.
  const preview = computeBurden({
    wage: row.wage_cents / 100,
    paid: row.paid_hours,
    pto: row.pto_hours,
    shop: row.shop_hours,
    idle: row.idle_hours,
    tax: row.tax_rate / 10000,
    comp: row.comp_rate / 10000,
    ben_mo: row.benefits_monthly_cents / 100,
    truck: row.support_truck_annual_cents / 100,
    tools: row.support_tools_annual_cents / 100,
    equip: row.support_equipment_annual_cents / 100,
    equipment_engine_active: equipmentEngineActive,
  });

  const warnings: string[] = [];
  if (preview.suspect) {
    warnings.push(
      `Only ${Math.round(preview.utilization * 100)}% of paid hours are billable. ` +
      'That is low enough that the resulting rate is probably not what you meant.',
    );
  }
  if (preview.config_warning) {
    warnings.push(
      `The burdened rate is ${preview.burden_multiplier.toFixed(2)}x the wage. ` +
      'Typical is 1.15x to 2.5x — worth checking the annual costs above.',
    );
  }
  if (equipmentEngineActive) {
    warnings.push(
      'The equipment engine is on, so equipment cost is charged per machine-hour and ' +
      'is deliberately excluded from this rate.',
    );
  }

  return { ok: true, row, preview, warnings };
}

// ── Equipment ────────────────────────────────────────────────────────────────

/**
 * The same boundary, for machines.
 *
 * Worth noting what is different: computeBurden guards its divide-by-zero
 * (BH-03 — billable hours falls back to 1 and sets config_error).
 * computeEquipmentRate has no such guard. It divides by life_years and by
 * annual_machine_hours directly, so a zero in either produces Infinity and
 * writes an hourly rate of Infinity into job costing. There is nothing
 * downstream to catch that, which makes this form the only thing standing
 * between a typo and a machine that costs infinity dollars an hour.
 */

/** Raw strings from the equipment form. */
export interface EquipmentFormFields {
  equipment_id?: string;
  /** Dollars. */
  purchase_price?: string;
  salvage?: string;
  insurance_annual?: string;
  storage_annual?: string;
  repairs_annual?: string;
  wear_annual?: string;
  /** Dollars per gallon, e.g. "4.05". */
  fuel_price?: string;
  /** Gallons per hour, e.g. "2.4". */
  fuel_gal_per_hr?: string;
  /** Percent, e.g. "7.5" or "12". */
  finance_pct?: string;
  lube_pct_of_fuel?: string;
  life_years?: string;
  annual_machine_hours?: string;
  effective_from?: string;
}

export type EquipmentRow = Omit<EquipmentRateProfile, 'id' | 'created_at' | 'effective_to'>;

export interface EquipmentParseSuccess {
  ok: true;
  row: EquipmentRow;
  preview: EquipmentRateResult;
  warnings: string[];
}
export type EquipmentParseResult = EquipmentParseSuccess | ParseFailure;

export function parseEquipmentForm(
  companyId: string,
  fields: EquipmentFormFields,
): EquipmentParseResult {
  const errors: string[] = [];

  const equipmentId = String(fields.equipment_id || '').trim();
  if (!equipmentId) errors.push('Which machine this is for is required.');

  const money = (label: string, raw: string | undefined, required = false) => {
    const v = decimalToScaled(raw ?? '0', 100);
    if (v === null) { errors.push(`${label} must be a number.`); return null; }
    if (v < 0) { errors.push(`${label} cannot be negative.`); return null; }
    if (required && v <= 0) { errors.push(`${label} must be greater than zero.`); return null; }
    return v;
  };

  const purchase = money('Purchase price', fields.purchase_price, true);
  const salvage = money('Salvage value', fields.salvage);
  const insurance = money('Insurance', fields.insurance_annual);
  const storage = money('Storage', fields.storage_annual);
  const repairs = money('Repairs', fields.repairs_annual);
  const wear = money('Wear parts', fields.wear_annual);
  const fuelPrice = money('Fuel price', fields.fuel_price);

  // Salvage above cost makes depreciation negative — the machine would earn
  // money by ageing. Almost always a swapped pair of fields.
  if (purchase !== null && salvage !== null && salvage > purchase) {
    errors.push('Salvage value cannot exceed the purchase price.');
  }

  // The two divisors. computeEquipmentRate does not guard them.
  const life = parseHours(fields.life_years);
  if (life === null) errors.push('Life in years must be a whole number.');
  else if (life <= 0) errors.push('Life in years must be at least 1 — it is divided by.');

  const machineHours = parseHours(fields.annual_machine_hours);
  if (machineHours === null) errors.push('Machine hours a year must be a whole number.');
  else if (machineHours <= 0) errors.push('Machine hours a year must be greater than zero — it is divided by.');

  const financePct = decimalToScaled(fields.finance_pct ?? '0', 10000);
  const finance = financePct === null ? null : Math.round(financePct / 100);
  if (finance === null || finance < 0) errors.push('Finance rate % must be a non-negative number.');

  const lubePct = decimalToScaled(fields.lube_pct_of_fuel ?? '0', 10000);
  const lube = lubePct === null ? null : Math.round(lubePct / 100);
  if (lube === null || lube < 0) errors.push('Lube % of fuel must be a non-negative number.');

  // Gallons per hour is a rate, not money: 2.4 -> 24000 ten-thousandths.
  const fuelGal = decimalToScaled(fields.fuel_gal_per_hr ?? '0', 10000);
  if (fuelGal === null || fuelGal < 0) errors.push('Fuel burn (gal/hr) must be a non-negative number.');

  const effectiveFrom = String(fields.effective_from || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(effectiveFrom)) errors.push('Effective date must be YYYY-MM-DD.');

  if (errors.length) return { ok: false, errors };

  const cents = (n: number) => n as EquipmentRateProfile['purchase_price_cents'];
  const tenThousandths = (n: number) => n as EquipmentRateProfile['finance_rate'];

  const row: EquipmentRow = {
    company_id: companyId,
    equipment_id: equipmentId,
    purchase_price_cents: cents(purchase!),
    salvage_cents: cents(salvage!),
    life_years: life!,
    annual_machine_hours: machineHours!,
    finance_rate: tenThousandths(finance!),
    insurance_annual_cents: cents(insurance!),
    storage_annual_cents: cents(storage!),
    fuel_gal_per_hr: tenThousandths(fuelGal!),
    fuel_price_cents: cents(fuelPrice!),
    repairs_annual_cents: cents(repairs!),
    wear_annual_cents: cents(wear!),
    lube_pct_of_fuel: tenThousandths(lube!),
    effective_from: effectiveFrom,
  };

  // Same conversion /internal/rates/equipment uses.
  const preview = computeEquipmentRate({
    purchase_price: row.purchase_price_cents / 100,
    salvage: row.salvage_cents / 100,
    life_years: row.life_years,
    annual_machine_hours: row.annual_machine_hours,
    finance_rate: row.finance_rate / 10000,
    insurance_annual: row.insurance_annual_cents / 100,
    storage_annual: row.storage_annual_cents / 100,
    fuel_gal_per_hr: row.fuel_gal_per_hr / 10000,
    fuel_price: row.fuel_price_cents / 100,
    repairs_annual: row.repairs_annual_cents / 100,
    wear_annual: row.wear_annual_cents / 100,
    lube_pct_of_fuel: row.lube_pct_of_fuel / 10000,
  });

  const warnings: string[] = [];
  if (row.annual_machine_hours < 200) {
    warnings.push(
      `${row.annual_machine_hours} machine hours a year is low, so every fixed cost lands on very ` +
      'few hours and the rate will look extreme. Check it is hours and not days.',
    );
  }
  if (preview.operating_rate > preview.ownership_rate * 3) {
    warnings.push(
      'Running cost is more than three times owning cost. Usually fuel burn or fuel price ' +
      'is out by a factor of ten.',
    );
  }
  return { ok: true, row, preview, warnings };
}

// ── Overhead pools ───────────────────────────────────────────────────────────

/**
 * The third rate input, and the one whose rules are not about a single row.
 *
 * allocateOverheadPools does not degrade on bad input the way computeBurden does —
 * it THROWS:
 *
 *   pool with no division     -> "pools may not go unallocated"
 *   revenue-driven over 10%   -> "must not exceed 10%"
 *
 * A thrown error there takes down every page that computes an allocation, so
 * both have to be caught before the row lands. And the 10% rule is a property of
 * the whole SET, not of the row being added — which is why this function needs
 * the pools that already exist, unlike the labor and equipment parsers.
 */

/** The only two the engine implements. Everything else throws downstream. */
export const OVERHEAD_DRIVERS = ['sellable_hours', 'revenue'] as const;
export type OverheadDriver = (typeof OVERHEAD_DRIVERS)[number];

export interface OverheadFormFields {
  division?: string;
  pool_type?: string;
  /** Dollars per year. */
  annual_cost?: string;
  driver?: string;
  /** YYYY-MM-DD. */
  as_of?: string;
}

export type OverheadRow = Omit<OverheadPool, 'id' | 'created_at'>;

export interface OverheadParseSuccess {
  ok: true;
  row: OverheadRow;
  /** What the set looks like once this row is in it. */
  totals: { total_cents: number; revenue_cents: number; revenue_share: number };
  warnings: string[];
}
export type OverheadParseResult = OverheadParseSuccess | ParseFailure;

export function parseOverheadForm(
  companyId: string,
  fields: OverheadFormFields,
  existing: Array<Pick<OverheadPool, 'division' | 'pool_type' | 'annual_cost_cents' | 'driver'>>,
): OverheadParseResult {
  const errors: string[] = [];

  const division = String(fields.division || '').trim();
  // computeAllocation throws on a pool with no division rather than skipping it.
  if (!division) errors.push('Division is required — a pool with nowhere to land stops every allocation.');

  const poolType = String(fields.pool_type || '').trim();
  if (!poolType) errors.push('What this pool is for is required.');

  const annual = decimalToScaled(fields.annual_cost, 100);
  if (annual === null) errors.push('Annual cost must be a number.');
  else if (annual <= 0) errors.push('Annual cost must be greater than zero.');

  const driver = String(fields.driver || '').trim() as OverheadDriver;
  if (!OVERHEAD_DRIVERS.includes(driver)) {
    errors.push(`Driver must be one of: ${OVERHEAD_DRIVERS.join(', ')}.`);
  }

  const asOf = String(fields.as_of || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(asOf)) errors.push('As-of date must be YYYY-MM-DD.');

  // listOverheadPools returns every row for the company with no as_of filter, so
  // a second row for the same pool is not a new version of it — it is the same
  // cost counted twice, in every rate that inherits the allocation.
  const dup = existing.find((p) => p.division === division && p.pool_type === poolType);
  if (dup) {
    errors.push(
      `${division} already has a "${poolType}" pool. Adding a second one counts that cost twice, ` +
      'because allocation sums every pool on file rather than only the newest.',
    );
  }

  if (errors.length) return { ok: false, errors };

  const priorTotal = existing.reduce((n, p) => n + Number(p.annual_cost_cents || 0), 0);
  const priorRevenue = existing
    .filter((p) => p.driver === 'revenue')
    .reduce((n, p) => n + Number(p.annual_cost_cents || 0), 0);

  const totalCents = priorTotal + annual!;
  const revenueCents = priorRevenue + (driver === 'revenue' ? annual! : 0);
  const share = totalCents > 0 ? revenueCents / totalCents : 0;

  // The forbidden rule from ALLOCATION.md, checked across the whole set. Adding
  // this row is what would break it, so this row is what gets refused.
  if (share > 0.10) {
    return {
      ok: false,
      errors: [
        `This would make revenue-driven pools ${(share * 100).toFixed(1)}% of total overhead, ` +
        'and the limit is 10%. Revenue-driven overhead makes busy divisions subsidise quiet ones, ' +
        'so the engine refuses to allocate at all above that line.',
      ],
    };
  }

  const row: OverheadRow = {
    company_id: companyId,
    division,
    pool_type: poolType,
    annual_cost_cents: annual! as OverheadPool['annual_cost_cents'],
    driver,
    as_of: asOf,
  };

  const warnings: string[] = [];
  if (share > 0.08) {
    warnings.push(
      `Revenue-driven pools are now ${(share * 100).toFixed(1)}% of overhead. The hard limit is 10%, ` +
      'so there is not much room left before allocation stops working.',
    );
  }
  return { ok: true, row, totals: { total_cents: totalCents, revenue_cents: revenueCents, revenue_share: share }, warnings };
}
