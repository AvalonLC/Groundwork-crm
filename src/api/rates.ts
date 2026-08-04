import { Hono } from "hono";
import { getEquipmentRateAsOf, getLaborRateAsOf, getTenantFinancePolicy } from "../db/repos";
import { computeBurden } from "../engines/burden";
import { computeEquipmentRate } from "../engines/equipment";
import type { RateConfidence } from "../db/schema";

export type RatesBindings = { FINANCE_DB: D1Database };

export const ratesRouter = new Hono<{ Bindings: RatesBindings }>();

/**
 * See docs/spec/API.md. The ONLY legitimate entry point into the burden
 * engine — no other module computes its own labor arithmetic (CLAUDE.md).
 * Re-resolves on every call using work_date; never caches across dates
 * (forbidden clause) since an effective-dated profile can change underneath
 * a cached value.
 */
ratesRouter.post("/resolve", async (c) => {
  const body = await c.req.json<{
    tenant_id: string; employee_id: string; work_date: string;
    crew_id?: string; role?: string;
  }>();
  const { tenant_id, employee_id, work_date, crew_id, role } = body;
  if (!tenant_id || !employee_id || !work_date) {
    return c.json({ error: "tenant_id, employee_id, work_date are required" }, 400);
  }

  const db = c.env.FINANCE_DB;

  // BH-06 cascade: employee -> crew -> role -> tenant, each hop downgrading
  // confidence. First match wins.
  const attempts: Array<{ scope: string; scopeId: string | undefined; confidence: RateConfidence }> = [
    { scope: "employee", scopeId: employee_id, confidence: "high" },
    { scope: "crew", scopeId: crew_id, confidence: "medium" },
    { scope: "role", scopeId: role, confidence: "medium" },
    { scope: "tenant", scopeId: tenant_id, confidence: "low" },
  ];

  let profile = null;
  let confidence: RateConfidence = "low";
  for (const a of attempts) {
    if (!a.scopeId) continue;
    profile = await getLaborRateAsOf(db, tenant_id, a.scope, a.scopeId, work_date);
    if (profile) { confidence = a.confidence; break; }
  }

  if (!profile) {
    return c.json({ error: "no labor rate profile resolves for this employee/date", confidence: "none" }, 404);
  }

  const policy = await getTenantFinancePolicy(db, tenant_id);
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

  // Never returned without confidence (forbidden: "returning a number
  // without confidence").
  return c.json({
    resolved_rate: Math.round(burden.burdened_rate * 10000), // ten-thousandths
    burden_multiplier: burden.burden_multiplier,
    confidence,
    stale_components: staleComponents,
    requires_review: burden.requires_review,
    publishable: burden.publishable,
    resolved_scope: profile.scope,
    effective_from: profile.effective_from,
  });
});

ratesRouter.post("/equipment", async (c) => {
  const body = await c.req.json<{ tenant_id: string; equipment_id: string; work_date: string }>();
  const { tenant_id, equipment_id, work_date } = body;
  if (!tenant_id || !equipment_id || !work_date) {
    return c.json({ error: "tenant_id, equipment_id, work_date are required" }, 400);
  }

  const db = c.env.FINANCE_DB;
  const profile = await getEquipmentRateAsOf(db, tenant_id, equipment_id, work_date);
  if (!profile) {
    return c.json({ error: "no equipment rate profile resolves for this equipment/date", confidence: "none" }, 404);
  }

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

  // Ownership and operating stay separate in the response — never merged
  // (same rule as the engine itself).
  return c.json({
    ownership_rate: Math.round(rate.ownership_rate * 10000),
    operating_rate: Math.round(rate.operating_rate * 10000),
    total_rate: Math.round(rate.total_rate * 10000),
    confidence: "high" as RateConfidence,
    effective_from: profile.effective_from,
  });
});
