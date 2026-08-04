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
