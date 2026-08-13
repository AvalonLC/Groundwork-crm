/// <reference types="@cloudflare/vitest-pool-workers" />
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { Hono } from "hono";
import { ratesRouter } from "./rates";
import {
  insertLaborRateProfile, insertEquipmentRateProfile, upsertTenantFinancePolicy,
} from "../db/repos";
import golden from "../../fixtures/golden.json";

const db = () => env.DB;
const TENANT = "t-rates-api";

/**
 * requireAuth is applied at the mount point in src/index.tsx, so these tests wrap
 * the router the same way production does — otherwise the tenant guard inside the
 * router (which fails closed without a session) would reject everything.
 */
function authedAs(companyId: string, isSuperAdmin = false) {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("companyId" as never, companyId as never);
    c.set("repId" as never, "test-rep" as never);
    c.set("role" as never, "owner" as never);
    c.set("isSuperAdmin" as never, isSuperAdmin as never);
    await next();
  });
  app.route("/", ratesRouter);
  return app;
}

const post = (path: string, body: unknown) =>
  authedAs(TENANT).request(path, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }, env);

describe("POST /internal/rates/resolve", () => {
  it("RA-01 resolves employee-scope profile with high confidence and matches BH-01", async () => {
    await upsertTenantFinancePolicy(db(), {
      company_id: TENANT, equipment_engine_active: 0, materiality_threshold_cents: 0,
      restated_target_cents: 0, black_friday_date: null,
    } as never);
    const A = golden.burden_labor_with_equipment.input;
    await insertLaborRateProfile(db(), {
      company_id: TENANT, scope: "employee", scope_id: "emp-1",
      wage_cents: Math.round(A.wage * 100), paid_hours: A.paid, pto_hours: A.pto,
      shop_hours: A.shop, idle_hours: A.idle, tax_rate: Math.round(A.tax * 10000),
      comp_rate: Math.round(A.comp * 10000), benefits_monthly_cents: Math.round(A.ben_mo * 100),
      support_truck_annual_cents: Math.round(A.truck * 100),
      support_tools_annual_cents: Math.round(A.tools * 100),
      support_equipment_annual_cents: Math.round(A.equip * 100),
      require_rate_approval: 0, effective_from: "2026-01-01", effective_to: null,
    });

    const res = await post("/resolve", { company_id: TENANT, employee_id: "emp-1", work_date: "2026-06-01" });
    expect(res.status).toBe(200);
    const json = await res.json() as any;
    expect(json.confidence).toBe("high");
    expect(json.resolved_scope).toBe("employee");
    expect(Number((json.resolved_rate / 10000).toFixed(2))).toBe(42.10);
  });

  it("RA-02 cascades to tenant scope when no employee/crew/role profile exists", async () => {
    await insertLaborRateProfile(db(), {
      company_id: TENANT, scope: "tenant", scope_id: TENANT,
      wage_cents: 2200, paid_hours: 2080, pto_hours: 80, shop_hours: 100, idle_hours: 100,
      tax_rate: 800, comp_rate: 600, benefits_monthly_cents: 20000,
      support_truck_annual_cents: 300000, support_tools_annual_cents: 50000,
      support_equipment_annual_cents: 100000, require_rate_approval: 0,
      effective_from: "2026-01-01", effective_to: null,
    });
    const res = await post("/resolve", { company_id: TENANT, employee_id: "emp-no-profile", work_date: "2026-06-01" });
    expect(res.status).toBe(200);
    const json = await res.json() as any;
    expect(json.confidence).toBe("low");
    expect(json.resolved_scope).toBe("tenant");
  });

  it("RA-03 forbidden: never caches across work_date — a recalibration mid-range is visible on the next call", async () => {
    const scopeId = "emp-recal";
    await insertLaborRateProfile(db(), {
      company_id: TENANT, scope: "employee", scope_id: scopeId,
      wage_cents: 2000, paid_hours: 2080, pto_hours: 80, shop_hours: 100, idle_hours: 100,
      tax_rate: 800, comp_rate: 600, benefits_monthly_cents: 20000,
      support_truck_annual_cents: 300000, support_tools_annual_cents: 50000,
      support_equipment_annual_cents: 0, require_rate_approval: 0,
      effective_from: "2026-01-01", effective_to: "2026-06-01",
    });
    await insertLaborRateProfile(db(), {
      company_id: TENANT, scope: "employee", scope_id: scopeId,
      wage_cents: 3000, paid_hours: 2080, pto_hours: 80, shop_hours: 100, idle_hours: 100,
      tax_rate: 800, comp_rate: 600, benefits_monthly_cents: 20000,
      support_truck_annual_cents: 300000, support_tools_annual_cents: 50000,
      support_equipment_annual_cents: 0, require_rate_approval: 0,
      effective_from: "2026-06-01", effective_to: null,
    });

    const before = await (await post("/resolve", { company_id: TENANT, employee_id: scopeId, work_date: "2026-03-01" })).json() as any;
    const after = await (await post("/resolve", { company_id: TENANT, employee_id: scopeId, work_date: "2026-07-01" })).json() as any;
    expect(before.resolved_rate).not.toBe(after.resolved_rate);
    expect(after.resolved_rate).toBeGreaterThan(before.resolved_rate);
  });

  it("RA-04 returns 404, not a cached/guessed value, when nothing resolves", async () => {
    // Authenticated AS the empty tenant rather than querying it from another
    // session: the assertion is unchanged (nothing resolves -> 404, never a
    // guessed number), but crossing tenants is now a 403 and would mask it.
    const res = await authedAs("t-empty").request("/resolve", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ company_id: "t-empty", employee_id: "nobody", work_date: "2026-01-01" }),
    }, env);
    expect(res.status).toBe(404);
  });
});

describe("POST /internal/rates/equipment", () => {
  it("RA-05 resolves ownership_rate and operating_rate separately, matching the fixture", async () => {
    const F = golden.equipment_rate;
    await insertEquipmentRateProfile(db(), {
      company_id: TENANT, equipment_id: "eq-1",
      purchase_price_cents: Math.round(F.input.purchase_price * 100),
      salvage_cents: Math.round(F.input.salvage * 100), life_years: F.input.life_years,
      annual_machine_hours: F.input.annual_machine_hours,
      finance_rate: Math.round(F.input.finance_rate * 10000),
      insurance_annual_cents: Math.round(F.input.insurance_annual * 100),
      storage_annual_cents: Math.round(F.input.storage_annual * 100),
      fuel_gal_per_hr: Math.round(F.input.fuel_gal_per_hr * 10000),
      fuel_price_cents: Math.round(F.input.fuel_price * 100),
      repairs_annual_cents: Math.round(F.input.repairs_annual * 100),
      wear_annual_cents: Math.round(F.input.wear_annual * 100),
      lube_pct_of_fuel: Math.round(F.input.lube_pct_of_fuel * 10000),
      effective_from: "2026-01-01", effective_to: null,
    });

    const res = await post("/equipment", { company_id: TENANT, equipment_id: "eq-1", work_date: "2026-06-01" });
    const json = await res.json() as any;
    expect(json.ownership_rate).not.toBe(json.operating_rate);
    expect(Number((json.total_rate / 10000).toFixed(2))).toBe(38.23);
    expect(json.confidence).toBeDefined();
  });
});

/**
 * These endpoints carry wage-derived data. They shipped mounted with no
 * authentication at all — an anonymous POST reached the handler on production —
 * and they take their tenant from the request body rather than the session, so
 * authentication alone would still have allowed cross-tenant reads.
 */
describe("tenant isolation", () => {
  const raw = (path: string, body: unknown) =>
    ratesRouter.request(path, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }, env);

  it("rejects an unauthenticated request rather than falling through", async () => {
    // No session vars at all — the shape the router shipped in.
    const res = await raw("/resolve", {
      company_id: TENANT, employee_id: "emp-1", work_date: "2026-01-15",
    });
    expect(res.status).toBe(401);
  });

  it("rejects a company_id that does not match the session", async () => {
    const res = await authedAs("some-other-tenant").request("/resolve", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ company_id: TENANT, employee_id: "emp-1", work_date: "2026-01-15" }),
    }, env);
    expect(res.status).toBe(403);
    // The rate must not leak in the error body either.
    expect(JSON.stringify(await res.json())).not.toContain("resolved_rate");
  });

  it("allows a super admin to cross tenants, since that is their purpose", async () => {
    const res = await authedAs("support-tenant", true).request("/resolve", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ company_id: TENANT, employee_id: "emp-1", work_date: "2026-01-15" }),
    }, env);
    expect(res.status).not.toBe(403);
    expect(res.status).not.toBe(401);
  });

  it("guards the equipment endpoint too, not just resolve", async () => {
    const res = await raw("/equipment", {
      company_id: TENANT, equipment_id: "eq-1", work_date: "2026-01-15",
    });
    expect(res.status).toBe(401);
  });
});
