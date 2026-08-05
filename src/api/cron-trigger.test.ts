/// <reference types="@cloudflare/vitest-pool-workers" />
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { cronTriggerRouter } from "./cron-trigger";
import { upsertTenantFinancePolicy } from "../db/repos";

const db = () => env.FINANCE_DB;
const TENANT = "t-cron-trigger";

// TEST_CRON_SECRET is a fixed vitest-only value (vitest.config.ts) — never
// the real production secret, which this repo never contains.
const authedEnv = () => ({ ...env, CRON_SECRET: (env as any).TEST_CRON_SECRET });

describe("POST /internal/cron/rollup — auth", () => {
  it("CT-01 fails closed (503) when CRON_SECRET isn't configured at all", async () => {
    const res = await cronTriggerRouter.request("/rollup", { method: "POST" }, env); // no CRON_SECRET on this env
    expect(res.status).toBe(503);
  });

  it("CT-02 rejects a wrong or missing secret header (401), even when CRON_SECRET is configured", async () => {
    const res = await cronTriggerRouter.request("/rollup", {
      method: "POST", headers: { "X-Cron-Secret": "wrong-secret" },
    }, authedEnv());
    expect(res.status).toBe(401);
  });

  it("CT-03 accepts the correct secret", async () => {
    const res = await cronTriggerRouter.request("/rollup", {
      method: "POST", headers: { "X-Cron-Secret": (env as any).TEST_CRON_SECRET },
    }, authedEnv());
    expect(res.status).toBe(200);
  });
});

describe("POST /internal/cron/rollup — processes tenants", () => {
  it("CT-04 a tenant with a policy row gets processed; one without is skipped, not errored", async () => {
    await upsertTenantFinancePolicy(db(), {
      tenant_id: TENANT, equipment_engine_active: 0, materiality_threshold_cents: 0,
      restated_target_cents: 59100000, black_friday_date: null,
    } as never);

    const res = await cronTriggerRouter.request("/rollup?as_of=2026-08-03", {
      method: "POST", headers: { "X-Cron-Secret": (env as any).TEST_CRON_SECRET },
    }, authedEnv());
    expect(res.status).toBe(200);
    const json = await res.json() as any;
    expect(json.tenants_processed).toBeGreaterThanOrEqual(1);
    expect(json.results.some((r: any) => r.tenant_id === TENANT)).toBe(true);
    expect(Array.isArray(json.tenants_skipped)).toBe(true);
  });
});

describe("GET /internal/cron/rollup/status — pre-auth diagnostic", () => {
  it("CT-05 reports false with no secret required to check, when CRON_SECRET isn't configured", async () => {
    const res = await cronTriggerRouter.request("/rollup/status", {}, env); // no auth header at all
    expect(res.status).toBe(200);
    const json = await res.json() as any;
    expect(json.cron_secret_configured).toBe(false);
  });

  it("CT-06 reports true once CRON_SECRET is configured — still no secret header needed to ask", async () => {
    const res = await cronTriggerRouter.request("/rollup/status", {}, authedEnv());
    expect(res.status).toBe(200);
    const json = await res.json() as any;
    expect(json.cron_secret_configured).toBe(true);
  });

  it("CT-07 never reveals the actual secret value", async () => {
    const res = await cronTriggerRouter.request("/rollup/status", {}, authedEnv());
    const text = await res.text();
    expect(text).not.toContain((env as any).TEST_CRON_SECRET);
  });
});

describe("POST /internal/cron/rollup?dry_run=true — verification without writing", () => {
  it("CT-08 dry run still requires the real secret — not an unauthenticated preview", async () => {
    const res = await cronTriggerRouter.request("/rollup?dry_run=true", {
      method: "POST", headers: { "X-Cron-Secret": "wrong-secret" },
    }, authedEnv());
    expect(res.status).toBe(401);
  });

  it("CT-09 dry run computes results but writes nothing to recovery_snapshot", async () => {
    const tenantId = "t-cron-dryrun";
    await upsertTenantFinancePolicy(db(), {
      tenant_id: tenantId, equipment_engine_active: 0, materiality_threshold_cents: 0,
      restated_target_cents: 59100000, black_friday_date: null,
    } as never);

    const res = await cronTriggerRouter.request("/rollup?as_of=2026-08-03&dry_run=true", {
      method: "POST", headers: { "X-Cron-Secret": (env as any).TEST_CRON_SECRET },
    }, authedEnv());
    expect(res.status).toBe(200);
    const json = await res.json() as any;
    expect(json.dry_run).toBe(true);
    expect(json.results.some((r: any) => r.tenant_id === tenantId)).toBe(true);

    const { results } = await db().prepare(
      `SELECT COUNT(*) as n FROM recovery_snapshot WHERE tenant_id = ?`,
    ).bind(tenantId).all();
    expect((results[0] as any).n).toBe(0); // nothing written
  });

  it("CT-10 a real (non-dry) run for the same tenant DOES write, confirming dry_run is the only thing that skipped it", async () => {
    const tenantId = "t-cron-realrun";
    await upsertTenantFinancePolicy(db(), {
      tenant_id: tenantId, equipment_engine_active: 0, materiality_threshold_cents: 0,
      restated_target_cents: 59100000, black_friday_date: null,
    } as never);

    await cronTriggerRouter.request("/rollup?as_of=2026-08-03", {
      method: "POST", headers: { "X-Cron-Secret": (env as any).TEST_CRON_SECRET },
    }, authedEnv());

    const { results } = await db().prepare(
      `SELECT COUNT(*) as n FROM recovery_snapshot WHERE tenant_id = ?`,
    ).bind(tenantId).all();
    expect((results[0] as any).n).toBe(1);
  });
});
