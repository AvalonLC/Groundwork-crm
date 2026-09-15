/// <reference types="@cloudflare/vitest-pool-workers" />
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { cronTriggerRouter } from "./cron-trigger";
import { upsertTenantFinancePolicy } from "../db/repos";

const db = () => env.DB;
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
      company_id: TENANT, equipment_engine_active: 0, materiality_threshold_cents: 0,
      restated_target_cents: 59100000, black_friday_date: null,
    } as never);

    const res = await cronTriggerRouter.request("/rollup?as_of=2026-08-03", {
      method: "POST", headers: { "X-Cron-Secret": (env as any).TEST_CRON_SECRET },
    }, authedEnv());
    expect(res.status).toBe(200);
    const json = await res.json() as any;
    expect(json.tenants_processed).toBeGreaterThanOrEqual(1);
    expect(json.results.some((r: any) => r.company_id === TENANT)).toBe(true);
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
      company_id: tenantId, equipment_engine_active: 0, materiality_threshold_cents: 0,
      restated_target_cents: 59100000, black_friday_date: null,
    } as never);

    const res = await cronTriggerRouter.request("/rollup?as_of=2026-08-03&dry_run=true", {
      method: "POST", headers: { "X-Cron-Secret": (env as any).TEST_CRON_SECRET },
    }, authedEnv());
    expect(res.status).toBe(200);
    const json = await res.json() as any;
    expect(json.dry_run).toBe(true);
    expect(json.results.some((r: any) => r.company_id === tenantId)).toBe(true);

    const { results } = await db().prepare(
      `SELECT COUNT(*) as n FROM recovery_snapshot WHERE company_id = ?`,
    ).bind(tenantId).all();
    expect((results[0] as any).n).toBe(0); // nothing written
  });

  it("CT-10 a real (non-dry) run for the same tenant DOES write, confirming dry_run is the only thing that skipped it", async () => {
    const tenantId = "t-cron-realrun";
    await upsertTenantFinancePolicy(db(), {
      company_id: tenantId, equipment_engine_active: 0, materiality_threshold_cents: 0,
      restated_target_cents: 59100000, black_friday_date: null,
    } as never);

    await cronTriggerRouter.request("/rollup?as_of=2026-08-03", {
      method: "POST", headers: { "X-Cron-Secret": (env as any).TEST_CRON_SECRET },
    }, authedEnv());

    const { results } = await db().prepare(
      `SELECT COUNT(*) as n FROM recovery_snapshot WHERE company_id = ?`,
    ).bind(tenantId).all();
    expect((results[0] as any).n).toBe(1);
  });
});

// ── POST /internal/cron/lead-import-cleanup ─────────────────────────────────
// Same fail-closed-secret gate as /rollup above (CT-01..03), reused verbatim
// since both routes share this router's single auth check. These tests
// exercise the route itself (HTTP shape, query params) — the underlying
// sweep LOGIC (guards, dedupe, staleness) is already covered exhaustively
// by CAI-01..10 in src/ai/pdf-lead-import.test.ts; duplicating that here
// would just be redundant, so only enough sweep behavior is re-checked to
// confirm the route is wired to the real function with the right params.
describe("POST /internal/cron/lead-import-cleanup — auth", () => {
  it("LIC-01 fails closed (503) when CRON_SECRET isn't configured at all", async () => {
    const res = await cronTriggerRouter.request("/lead-import-cleanup", { method: "POST" }, env);
    expect(res.status).toBe(503);
  });

  it("LIC-02 rejects a wrong or missing secret header (401), even when CRON_SECRET is configured", async () => {
    const res = await cronTriggerRouter.request("/lead-import-cleanup", {
      method: "POST", headers: { "X-Cron-Secret": "wrong-secret" },
    }, authedEnv());
    expect(res.status).toBe(401);
  });

  it("LIC-03 accepts the correct secret and returns the expected response shape", async () => {
    const res = await cronTriggerRouter.request("/lead-import-cleanup", {
      method: "POST", headers: { "X-Cron-Secret": (env as any).TEST_CRON_SECRET },
    }, authedEnv());
    expect(res.status).toBe(200);
    const json = await res.json() as any;
    expect(json).toMatchObject({
      dry_run: false, company_id: null,
      imports_abandoned: expect.any(Number),
      documents_abandoned: expect.any(Number),
      abandoned_import_ids: expect.any(Array),
    });
  });
});

describe("POST /internal/cron/lead-import-cleanup — sweeps real rows via HTTP", () => {
  const TENANT = "t-cron-lic";
  let seq = 0;
  function freshId(prefix: string): string {
    seq += 1;
    return `${prefix}_lic${seq}_${Date.now()}`;
  }
  function hoursAgo(h: number): string {
    return new Date(Date.now() - h * 60 * 60 * 1000).toISOString().replace("T", " ").slice(0, 19);
  }
  async function insertDocument(companyId: string, updatedAt: string): Promise<string> {
    const id = freshId("lidoc");
    await db().prepare(
      `INSERT INTO lead_import_document (id, company_id, original_filename, safe_filename, r2_key, byte_size, sha256_hash, status, updated_at)
       VALUES (?,?,?,?,?,?,?,'uploaded',?)`,
    ).bind(id, companyId, "x.pdf", "x.pdf", `fake/r2/${id}`, 10, `hash_${id}`, updatedAt).run();
    return id;
  }
  async function insertImport(companyId: string, documentId: string, status: string, updatedAt: string): Promise<string> {
    const id = freshId("limp");
    await db().prepare(
      `INSERT INTO lead_import (id, company_id, document_id, idempotency_token, status, extracted_text, warnings_json, updated_at)
       VALUES (?,?,?,?,?,?,'[]',?)`,
    ).bind(id, companyId, documentId, `tok_${id}`, status, "some extracted text", updatedAt).run();
    return id;
  }

  it("LIC-04 a real (non-dry) call abandons a stale import and reports its id", async () => {
    // ABANDONED_RETENTION_HOURS is 72 in production config; comfortably
    // exceed it so this test never becomes flaky if that constant changes.
    const docId = await insertDocument(TENANT, hoursAgo(500));
    const importId = await insertImport(TENANT, docId, "needs_review", hoursAgo(500));

    const res = await cronTriggerRouter.request(`/lead-import-cleanup?company_id=${TENANT}`, {
      method: "POST", headers: { "X-Cron-Secret": (env as any).TEST_CRON_SECRET },
    }, authedEnv());
    expect(res.status).toBe(200);
    const json = await res.json() as any;
    expect(json.company_id).toBe(TENANT);
    expect(json.abandoned_import_ids).toContain(importId);

    const row = await db().prepare(`SELECT status, extracted_text FROM lead_import WHERE id = ?`).bind(importId).first() as any;
    expect(row.status).toBe("abandoned");
    expect(row.extracted_text).toBe("");
  });

  it("LIC-05 dry_run=true via HTTP reports the sweep but writes nothing", async () => {
    const docId = await insertDocument(TENANT, hoursAgo(500));
    const importId = await insertImport(TENANT, docId, "needs_review", hoursAgo(500));

    const res = await cronTriggerRouter.request(`/lead-import-cleanup?company_id=${TENANT}&dry_run=true`, {
      method: "POST", headers: { "X-Cron-Secret": (env as any).TEST_CRON_SECRET },
    }, authedEnv());
    expect(res.status).toBe(200);
    const json = await res.json() as any;
    expect(json.dry_run).toBe(true);
    expect(json.abandoned_import_ids).toContain(importId);

    const row = await db().prepare(`SELECT status FROM lead_import WHERE id = ?`).bind(importId).first() as any;
    expect(row.status).toBe("needs_review"); // unchanged — dry run wrote nothing
  });

  it("LIC-06 dry_run also requires the real secret — not an unauthenticated preview", async () => {
    const res = await cronTriggerRouter.request("/lead-import-cleanup?dry_run=true", {
      method: "POST", headers: { "X-Cron-Secret": "wrong-secret" },
    }, authedEnv());
    expect(res.status).toBe(401);
  });

  it("LIC-07 a recently-updated import in another tenant is left alone by a company_id-scoped call", async () => {
    const OTHER_TENANT = "t-cron-lic-other";
    const docId = await insertDocument(OTHER_TENANT, hoursAgo(500));
    const importId = await insertImport(OTHER_TENANT, docId, "needs_review", hoursAgo(500));

    const res = await cronTriggerRouter.request(`/lead-import-cleanup?company_id=${TENANT}`, {
      method: "POST", headers: { "X-Cron-Secret": (env as any).TEST_CRON_SECRET },
    }, authedEnv());
    expect(res.status).toBe(200);
    const json = await res.json() as any;
    expect(json.abandoned_import_ids).not.toContain(importId);

    const row = await db().prepare(`SELECT status FROM lead_import WHERE id = ?`).bind(importId).first() as any;
    expect(row.status).toBe("needs_review"); // a different tenant, untouched by this scoped call
  });
});
