import { Hono } from "hono";
import { getEquipmentRateAsOf, getLaborRateAsOf, getTenantFinancePolicy } from "../db/repos";
import { computeBurden } from "../engines/burden";
import { computeEquipmentRate } from "../engines/equipment";
import type { RateConfidence } from "../db/schema";

export type RatesBindings = { DB: D1Database };

export interface ResolvedLaborRate {
  resolved_rate: number; // ten-thousandths
  burden_multiplier: number;
  confidence: RateConfidence;
  stale_components: string[];
  requires_review: boolean;
  publishable: boolean;
  resolved_scope: string;
  effective_from: string;
}

export interface ResolvedEquipmentRate {
  ownership_rate: number; // ten-thousandths
  operating_rate: number; // ten-thousandths
  total_rate: number; // ten-thousandths
  confidence: RateConfidence;
  effective_from: string;
}

/**
 * See docs/spec/API.md. The ONLY legitimate entry point into the burden
 * engine — no other module computes its own labor arithmetic (CLAUDE.md).
 * Re-resolves on every call using work_date; never caches across dates
 * (forbidden clause) since an effective-dated profile can change underneath
 * a cached value. Shared by the HTTP route below and by posting.ts, so both
 * paths go through identical logic rather than posting.ts reimplementing it.
 */
export async function resolveLaborRate(
  db: D1Database,
  args: { company_id: string; employee_id: string; work_date: string; crew_id?: string; role?: string },
): Promise<ResolvedLaborRate | null> {
  const { company_id, employee_id, work_date, crew_id, role } = args;

  // BH-06 cascade: employee -> crew -> role -> tenant, each hop downgrading
  // confidence. First match wins. ("tenant" here is the rate-resolution
  // scope name (labor_rate_profile.scope, unchanged by the 2026-08-09
  // merge) — a fallback tier meaning "whole company," not the old tenant_id
  // column, which is gone.)
  const attempts: Array<{ scope: string; scopeId: string | undefined; confidence: RateConfidence }> = [
    { scope: "employee", scopeId: employee_id, confidence: "high" },
    { scope: "crew", scopeId: crew_id, confidence: "medium" },
    { scope: "role", scopeId: role, confidence: "medium" },
    { scope: "tenant", scopeId: company_id, confidence: "low" },
  ];

  let profile = null;
  let confidence: RateConfidence = "low";
  for (const a of attempts) {
    if (!a.scopeId) continue;
    profile = await getLaborRateAsOf(db, company_id, a.scope, a.scopeId, work_date);
    if (profile) { confidence = a.confidence; break; }
  }
  if (!profile) return null;

  const policy = await getTenantFinancePolicy(db, company_id);
  const equipmentEngineActive = policy?.equipment_engine_active === 1;

  const burden = computeBurden({
    wage: profile.wage_cents / 100,
    paid: profile.paid_hours,
    pto: profile.pto_hours,
    shop: profile.shop_hours,
    idle: profile.idle_hours,
    tax: profile.tax_rate / 10000,
    comp: profile.comp_rate / 10000,
    ben_mo: profile.benefits_monthly_cents / 100,
    truck: profile.support_truck_annual_cents / 100,
    tools: profile.support_tools_annual_cents / 100,
    equip: profile.support_equipment_annual_cents / 100,
    equipment_engine_active: equipmentEngineActive,
  });

  const staleComponents: string[] = [];
  if (burden.suspect) staleComponents.push("utilization");
  if (burden.config_warning) staleComponents.push("multiplier");

  return {
    resolved_rate: Math.round(burden.burdened_rate * 10000),
    burden_multiplier: burden.burden_multiplier,
    confidence,
    stale_components: staleComponents,
    requires_review: burden.requires_review,
    publishable: burden.publishable,
    resolved_scope: profile.scope,
    effective_from: profile.effective_from,
  };
}

export async function resolveEquipmentRate(
  db: D1Database,
  args: { company_id: string; equipment_id: string; work_date: string },
): Promise<ResolvedEquipmentRate | null> {
  const profile = await getEquipmentRateAsOf(db, args.company_id, args.equipment_id, args.work_date);
  if (!profile) return null;

  const rate = computeEquipmentRate({
    purchase_price: profile.purchase_price_cents / 100,
    salvage: profile.salvage_cents / 100,
    life_years: profile.life_years,
    annual_machine_hours: profile.annual_machine_hours,
    finance_rate: profile.finance_rate / 10000,
    insurance_annual: profile.insurance_annual_cents / 100,
    storage_annual: profile.storage_annual_cents / 100,
    fuel_gal_per_hr: profile.fuel_gal_per_hr / 10000,
    fuel_price: profile.fuel_price_cents / 100,
    repairs_annual: profile.repairs_annual_cents / 100,
    wear_annual: profile.wear_annual_cents / 100,
    lube_pct_of_fuel: profile.lube_pct_of_fuel / 10000,
  });

  return {
    ownership_rate: Math.round(rate.ownership_rate * 10000),
    operating_rate: Math.round(rate.operating_rate * 10000),
    total_rate: Math.round(rate.total_rate * 10000),
    confidence: "high",
    effective_from: profile.effective_from,
  };
}

export const ratesRouter = new Hono<{ Bindings: RatesBindings }>();

ratesRouter.post("/resolve", async (c) => {
  const body = await c.req.json<{
    company_id: string; employee_id: string; work_date: string;
    crew_id?: string; role?: string;
  }>();
  if (!body.company_id || !body.employee_id || !body.work_date) {
    return c.json({ error: "company_id, employee_id, work_date are required" }, 400);
  }

  const result = await resolveLaborRate(c.env.DB, body);
  if (!result) {
    // Never falls back to a guessed rate (forbidden: "returning a number
    // without confidence").
    return c.json({ error: "no labor rate profile resolves for this employee/date", confidence: "none" }, 404);
  }
  return c.json(result);
});

ratesRouter.post("/equipment", async (c) => {
  const body = await c.req.json<{ company_id: string; equipment_id: string; work_date: string }>();
  if (!body.company_id || !body.equipment_id || !body.work_date) {
    return c.json({ error: "company_id, equipment_id, work_date are required" }, 400);
  }

  const result = await resolveEquipmentRate(c.env.DB, body);
  if (!result) {
    return c.json({ error: "no equipment rate profile resolves for this equipment/date", confidence: "none" }, 404);
  }
  return c.json(result);
});
