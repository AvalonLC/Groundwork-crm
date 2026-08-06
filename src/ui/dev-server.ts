import { Hono } from "hono";
import { moneyLoopRouter } from "./money-loop";
import { recoveryRouter } from "./recovery";
import { budgetRouter } from "./budget";
import { queueRouter } from "./queue";
import { jobCostingRouter } from "./job-costing";
import { configAdminRouter, configAdminApiRouter } from "./config-admin";
import { policySetupRouter } from "./policy-setup";
import { documentUploadRouter } from "./document-upload";
import { collectionsRouter } from "./collections";
import { obligationsRouter } from "./obligations";
import { reconciliationRouter } from "./reconciliation";
import { forecastRouter } from "./forecast";
import { documentsRouter } from "./documents";

/**
 * Standalone dev/e2e-test entry for Finance OS UI pages — NOT part of the
 * deployed app (src/index.tsx never imports this file). Lets Playwright
 * exercise real server-rendered pages against a real local FINANCE_DB
 * without needing the main CRM's auth/session stack, or another
 * src/index.tsx mounting exception for every page. Pages accept role/tenant
 * via query params here as a testing convenience; wiring them into the real
 * app's session/auth is a separate, later integration step — same status as
 * rates.ts/actions.ts before they were mounted.
 *
 * `DB` is the CRM's own database (avalon-sales-hub-production locally) —
 * collections.tsx is the one page that reads it directly, so this dev
 * server needs it available too, same as the live app.
 *
 * Run: wrangler dev src/ui/dev-server.ts --port 3100 --local
 */
export type DevBindings = { FINANCE_DB: D1Database; RECEIPTS: R2Bucket; DB: D1Database };

const app = new Hono<{ Bindings: DevBindings }>();

app.get("/", (c) => c.text("Finance OS UI dev server"));
app.route("/money-loop", moneyLoopRouter);
app.route("/recovery", recoveryRouter);
app.route("/budget", budgetRouter);
app.route("/queue", queueRouter);
app.route("/job-costing", jobCostingRouter);
app.route("/config", configAdminRouter);
app.route("/policy", policySetupRouter);
app.route("/upload", documentUploadRouter);
app.route("/collections", collectionsRouter);
app.route("/obligations", obligationsRouter);
app.route("/reconciliation", reconciliationRouter);
app.route("/forecast", forecastRouter);
app.route("/documents", documentsRouter);
app.route("/api/config", configAdminApiRouter);

// ── Test-only seeding endpoints. Only reachable on this dev-only server,
// always against local Miniflare D1 (--local), never a real deployment. ──
// Children before parents (classification_finding/receipt.action_item_id ->
// action_item.id, job_cost_ledger.time_entry_id -> time_entry.id) — D1
// enforces foreign keys, so deleting a referenced row first fails the batch.
const FINANCE_TABLES = [
  "classification_finding", "receipt", "job_cost_ledger", "action_item",
  "time_entry", "recovery_snapshot", "overhead_allocation", "overhead_pool",
  "equipment_rate_profile", "labor_rate_profile", "work_item", "tenant_finance_policy",
  "finance_config_override",
];

app.post("/test/reset", async (c) => {
  // Scoped to tenant_id, not a global wipe — e2e suites for different pages
  // run as separate Playwright test files, which Playwright may execute in
  // parallel workers against this same shared local D1 instance. A global
  // DELETE here would race with another file's just-seeded data.
  const { tenant_id } = await c.req.json<{ tenant_id: string }>();
  if (!tenant_id) return c.json({ error: "tenant_id is required" }, 400);
  await c.env.FINANCE_DB.batch(
    FINANCE_TABLES.map((t) => c.env.FINANCE_DB.prepare(`DELETE FROM ${t} WHERE tenant_id = ?`).bind(tenant_id)),
  );
  return c.json({ ok: true });
});

app.post("/test/exec", async (c) => {
  const { sql, params } = await c.req.json<{ sql: string; params?: unknown[] }>();
  const result = await c.env.FINANCE_DB.prepare(sql).bind(...(params ?? [])).run();
  return c.json({ ok: true, meta: result.meta });
});

// ── Same two endpoints, but against the CRM's own `DB` — only collections.tsx
// reads it, so only its e2e suite needs these. Separate from /test/reset and
// /test/exec above so it's never ambiguous which database a seed call hits. ──
app.post("/test/reset-crm", async (c) => {
  const { company_id } = await c.req.json<{ company_id: string }>();
  if (!company_id) return c.json({ error: "company_id is required" }, 400);
  await c.env.DB.prepare(`DELETE FROM invoices WHERE company_id = ?`).bind(company_id).run();
  return c.json({ ok: true });
});

app.post("/test/exec-crm", async (c) => {
  const { sql, params } = await c.req.json<{ sql: string; params?: unknown[] }>();
  const result = await c.env.DB.prepare(sql).bind(...(params ?? [])).run();
  return c.json({ ok: true, meta: result.meta });
});

export default app;
