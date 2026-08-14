import { Hono } from "hono";
import { getEquipmentRateAsOf, getLaborRateAsOf, getTenantFinancePolicy } from "../db/repos";
import { computeBurden } from "../engines/burden";
import { computeEquipmentRate } from "../engines/equipment";
import type { RateConfidence } from "../db/schema";
import { canViewCompensation, validateEquipmentSupport } from "./compensation";
import { computeCrewCost } from "./crew_cost";

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

export type RatesVariables = {
  repId: string;
  companyId: string;
  role: string;
  isSuperAdmin: boolean;
  canViewCompensation: boolean;
};

export const ratesRouter = new Hono<{ Bindings: RatesBindings; Variables: RatesVariables }>();

/**
 * Every endpoint here takes its tenant from the request BODY rather than the
 * session, so authentication alone is not enough: without this, any signed-in
 * user could pass another company's id and read that company's burdened labor
 * rates, which are wage-derived.
 *
 * requireAuth is applied at the mount point in src/index.tsx; this narrows it to
 * the caller's own tenant. Super admins are exempt because cross-tenant support
 * access is their purpose.
 */
ratesRouter.use("*", async (c, next) => {
  const sessionCompany = c.var.companyId;
  // Fails CLOSED. If this router is ever mounted without requireAuth in front of
  // it — which is exactly how it shipped originally — there is no session tenant
  // to compare against, and allowing the request through would reinstate the hole
  // this guard exists to close.
  if (!sessionCompany) {
    return c.json({ error: "unauthenticated" }, 401);
  }
  // Hono caches the parsed body, so reading it here does not consume it for the
  // handler. A malformed body is left for the handler's own 400.
  const body = await c.req.json<{ company_id?: string }>().catch(() => ({}) as { company_id?: string });
  if (body.company_id && body.company_id !== sessionCompany && !c.var.isSuperAdmin) {
    return c.json({ error: "company_id does not match the authenticated session" }, 403);
  }
  await next();
});

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

// ── POST /profile — the labor-rate write path ────────────────────────────────

/**
 * Create a labor rate profile, or recalibrate an existing one.
 *
 * PUNCHLIST item 8: "There is no way, anywhere in the product, to create a
 * labor_rate_profile row." /finance/budget is read-only, the seed does not make
 * one, and nothing else writes the table — so every tenant resolves against
 * nothing and the whole burden engine has been running on defaults. This is
 * that write path.
 *
 * Two rules from CLAUDE.md that this enforces rather than assumes:
 *
 *   Rate rows are IMMUTABLE and effective-dated. Recalibration INSERTs a new
 *   row and closes the prior one by setting effective_to. Nothing here ever
 *   UPDATEs a rate's numbers — a job costed last March must still resolve last
 *   March's rate, and rewriting a row in place silently restates history.
 *
 *   support_equipment_annual_cents MUST be 0 while the equipment engine is
 *   active, or the same machine is billed twice. Refused at the door rather than
 *   accepted and left to fail a fixture later. See BH-13.
 *
 * Per-employee rates need no new table: scope='employee' with scope_id set to
 * the rep id is what the existing schema already expresses, and getLaborRateAsOf
 * already resolves employee before crew before company.
 */
ratesRouter.post("/profile", async (c) => {
  const db = c.env.DB as D1Database;
  const companyId = c.var.companyId as string;

  // Writing a wage is not a scheduling action. Only people who may SEE
  // compensation may set it — the read rule and the write rule are the same
  // rule, and letting someone set a rate they cannot read back is worse than
  // either alone.
  if (!canViewCompensation({ role: c.var.role, can_view_compensation: c.var.canViewCompensation, is_super_admin: c.var.isSuperAdmin })) {
    return c.json({ error: "compensation permission required" }, 403);
  }

  const body = await c.req.json<any>().catch(() => ({}));
  const scope = String(body.scope || "company").toLowerCase();
  if (!["company", "crew", "employee"].includes(scope)) {
    return c.json({ error: "scope must be company, crew or employee" }, 400);
  }
  const scopeId = scope === "company" ? "" : String(body.scope_id || "");
  if (scope !== "company" && !scopeId) {
    return c.json({ error: `scope_id is required for scope=${scope}` }, 400);
  }
  const effectiveFrom = /^\d{4}-\d{2}-\d{2}$/.test(String(body.effective_from || ""))
    ? String(body.effective_from)
    : new Date().toISOString().slice(0, 10);

  const wageCents = Math.trunc(Number(body.wage_cents) || 0);
  if (wageCents <= 0) return c.json({ error: "wage_cents must be a positive integer (cents)" }, 400);

  const policy = await getTenantFinancePolicy(db, companyId);
  const guard = validateEquipmentSupport(body.support_equipment_annual_cents, !!policy?.equipment_engine_active);
  if (!guard.ok) return c.json({ error: guard.error }, 400);

  // Close the row this one supersedes. This is the ONE update a rate row ever
  // receives, and it changes when the row applied — never what it says.
  const prior = await db
    .prepare(
      `SELECT id, effective_from FROM labor_rate_profile
        WHERE company_id=? AND scope=? AND COALESCE(scope_id,'')=?
          AND (effective_to IS NULL OR effective_to='')
        ORDER BY effective_from DESC LIMIT 1`,
    )
    .bind(companyId, scope, scopeId)
    .first<{ id: number; effective_from: string }>();

  if (prior && prior.effective_from >= effectiveFrom) {
    // Back-dating on top of an open row would leave two rows live for the same
    // day and make resolution order-dependent.
    return c.json(
      { error: `A rate already applies from ${prior.effective_from}. Use an effective_from after that date.` },
      409,
    );
  }

  const int0 = (v: unknown) => Math.trunc(Number(v) || 0);
  const statements = [] as D1PreparedStatement[];
  if (prior) {
    statements.push(
      db.prepare(`UPDATE labor_rate_profile SET effective_to=? WHERE id=? AND company_id=?`)
        .bind(effectiveFrom, prior.id, companyId),
    );
  }
  statements.push(
    db.prepare(
      `INSERT INTO labor_rate_profile
         (company_id, scope, scope_id, wage_cents, paid_hours, pto_hours, shop_hours, idle_hours,
          tax_rate, comp_rate, benefits_monthly_cents,
          support_truck_annual_cents, support_tools_annual_cents, support_equipment_annual_cents,
          require_rate_approval, effective_from, effective_to)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL)`,
    ).bind(
      companyId, scope, scopeId, wageCents,
      int0(body.paid_hours), int0(body.pto_hours), int0(body.shop_hours), int0(body.idle_hours),
      int0(body.tax_rate), int0(body.comp_rate), int0(body.benefits_monthly_cents),
      int0(body.support_truck_annual_cents), int0(body.support_tools_annual_cents),
      int0(body.support_equipment_annual_cents),
      body.require_rate_approval ? 1 : 0, effectiveFrom,
    ),
  );
  await db.batch(statements);

  return c.json({
    ok: true,
    scope, scope_id: scopeId, effective_from: effectiveFrom,
    superseded: prior ? { id: prior.id, effective_to: effectiveFrom } : null,
  }, 201);
});

// ── GET /employees — per-person rates, and where each one came from ──────────

/**
 * Every rep with the rate that currently resolves for them, and its scope.
 *
 * The scope is the point. A list of rates with no provenance invites someone to
 * read the company default as "what Ben earns" — the editor needs to show which
 * rows are real and which are inherited, or setting one is indistinguishable
 * from leaving it alone.
 */
ratesRouter.get("/employees", async (c) => {
  const db = c.env.DB as D1Database;
  const companyId = c.var.companyId as string;
  if (!canViewCompensation({ role: c.var.role, can_view_compensation: c.var.canViewCompensation, is_super_admin: c.var.isSuperAdmin })) {
    return c.json({ error: "compensation permission required" }, 403);
  }
  const workDate = new Date().toISOString().slice(0, 10);
  const reps = await db
    .prepare(`SELECT id, name, role FROM reps WHERE company_id=? AND active=1 ORDER BY name`)
    .bind(companyId).all<any>();

  const employees = [];
  for (const r of reps.results || []) {
    const resolved = await resolveLaborRate(db, { company_id: companyId, employee_id: r.id, work_date: workDate });
    employees.push({
      rep_id: r.id, rep_name: r.name, role: r.role,
      resolved_rate: resolved?.resolved_rate ?? null,
      resolved_scope: resolved?.resolved_scope ?? null,
      // A rate inherited from the company is not a rate for this person, and the
      // editor renders the two differently.
      has_own_rate: resolved?.resolved_scope === "employee",
      confidence: resolved?.confidence ?? null,
      stale_components: resolved?.stale_components ?? [],
    });
  }
  return c.json({ ok: true, work_date: workDate, employees });
});

// ── GET /crew/:id/cost — what a crew costs per hour ─────────────────────────

/**
 * Crew cost from the ROSTER, with the inference guard attached.
 *
 * Never the bare number. computeCrewCost returns the total alongside which
 * members' rates were inherited and which have none at all, because
 * "Blue Crew costs $126/hr" and "…and two of those rates are the company
 * default" are different claims and only one of them should price a job.
 */
ratesRouter.get("/crew/:id/cost", async (c) => {
  const db = c.env.DB as D1Database;
  const companyId = c.var.companyId as string;
  if (!canViewCompensation({ role: c.var.role, can_view_compensation: c.var.canViewCompensation, is_super_admin: c.var.isSuperAdmin })) {
    return c.json({ error: "compensation permission required" }, 403);
  }
  const crewId = c.req.param("id");
  const workDate = /^\d{4}-\d{2}-\d{2}$/.test(String(c.req.query("date") || ""))
    ? String(c.req.query("date"))
    : new Date().toISOString().slice(0, 10);

  const members = await db
    .prepare(
      `SELECT cm.rep_id, cm.crew_role, r.name AS rep_name
         FROM crew_members cm JOIN reps r ON r.id = cm.rep_id
        WHERE cm.crew_id=? AND cm.company_id=?`,
    )
    .bind(crewId, companyId).all<any>();

  const rated = [];
  for (const m of members.results || []) {
    const resolved = await resolveLaborRate(db, {
      company_id: companyId, employee_id: m.rep_id, work_date: workDate, crew_id: crewId, role: m.crew_role,
    });
    rated.push({
      rep_id: m.rep_id, rep_name: m.rep_name, crew_role: m.crew_role,
      resolved_rate: resolved?.resolved_rate ?? null,
      resolved_scope: resolved?.resolved_scope ?? null,
    });
  }
  return c.json({ ok: true, work_date: workDate, ...computeCrewCost(crewId, rated) });
});
