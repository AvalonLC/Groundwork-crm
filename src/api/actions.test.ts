/// <reference types="@cloudflare/vitest-pool-workers" />
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { actionsRouter } from "./actions";

const TENANT = "t-actions-api";

const post = (path: string, body: unknown) =>
  actionsRouter.request(path, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }, env);

describe("POST /internal/actions", () => {
  it("AC-01 creates an action item with a valid verb", async () => {
    const res = await post("/", {
      id: "ai-api-1", company_id: TENANT, verb: "collect",
      owner_id: "user-1", sla_due: "2026-08-10",
    });
    expect(res.status).toBe(201);
  });

  it("forbidden: rejects any verb outside the five-item set", async () => {
    const res = await post("/", {
      id: "ai-api-bad", company_id: TENANT, verb: "approve",
      owner_id: "user-1", sla_due: "2026-08-10",
    });
    expect(res.status).toBe(400);
    const json = await res.json() as any;
    expect(json.error).toMatch(/collect, bill, pay, fix, decide/);
  });

  it("forbidden: rejects an action with no owner_id", async () => {
    const res = await post("/", {
      id: "ai-api-no-owner", company_id: TENANT, verb: "fix", sla_due: "2026-08-10",
    });
    expect(res.status).toBe(400);
    const json = await res.json() as any;
    expect(json.error).toMatch(/owner_id/);
  });

  it("forbidden: rejects an action with no sla_due", async () => {
    const res = await post("/", {
      id: "ai-api-no-sla", company_id: TENANT, verb: "fix", owner_id: "user-1",
    });
    expect(res.status).toBe(400);
    const json = await res.json() as any;
    expect(json.error).toMatch(/sla_due/);
  });
});

describe("GET /internal/actions", () => {
  it("AC-05 lists open actions, filterable by verb, resolving removes it", async () => {
    await post("/", { id: "ai-api-2", company_id: TENANT, verb: "bill", owner_id: "user-2", sla_due: "2026-08-11" });

    const listRes = await actionsRouter.request(`/?company_id=${TENANT}&verb=bill`, {}, env);
    const list = await listRes.json() as any;
    expect(list.items.some((i: any) => i.id === "ai-api-2")).toBe(true);

    const resolveRes = await actionsRouter.request(`/ai-api-2/resolve?company_id=${TENANT}`, { method: "POST" }, env);
    expect(resolveRes.status).toBe(200);

    const listAfter = await actionsRouter.request(`/?company_id=${TENANT}&verb=bill`, {}, env);
    const after = await listAfter.json() as any;
    expect(after.items.some((i: any) => i.id === "ai-api-2")).toBe(false);
  });
});
