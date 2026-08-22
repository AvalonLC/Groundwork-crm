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
import { invoicesPaymentsRouter } from "./invoices-payments";
import { ledgerRouter } from "./ledger";
import { onboardingRouter } from "./onboarding";

/**
 * Standalone dev/e2e-test entry for Finance OS UI pages — NOT part of the
 * deployed app (src/index.tsx never imports this file). Lets Playwright
 * exercise real server-rendered pages against a real local D1 without
 * needing the main CRM's auth/session stack, or another src/index.tsx
 * mounting exception for every page. Pages accept role/tenant via query
 * params here as a testing convenience; wiring them into the real app's
 * session/auth is a separate, later integration step — same status as
 * rates.ts/actions.ts before they were mounted.
 *
 * Single `DB` binding since the 2026-08-09 merge
 * (migrations/0057_finance_merge.sql) — Finance OS's own tables and the
 * CRM's tables (work_orders, time_entries, invoices, etc.) live in the
 * same database now.
 *
 * Run: wrangler dev src/ui/dev-server.ts --port 3100 --local
 */
export type DevBindings = { DB: D1Database; RECEIPTS: R2Bucket };

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
app.route("/invoices-payments", invoicesPaymentsRouter);
app.route("/ledger", ledgerRouter);
app.route("/onboarding", onboardingRouter);
app.route("/api/config", configAdminApiRouter);

// ── Test-only seeding endpoints. Only reachable on this dev-only server,
// always against local Miniflare D1 (--local), never a real deployment. ──
// Children before parents (classification_finding/receipt.action_item_id ->
// action_item.id, job_cost_ledger.time_entry_id -> time_entries.id) — D1
// enforces foreign keys, so deleting a referenced row first fails the batch.
// work_item and time_entry are gone (folded into work_orders/time_entries,
// migrations/0057_finance_merge.sql) — not listed here since /test/reset-crm
// below covers work_orders/time_entries (and this reset would otherwise
// need to also clear their finance-only columns, which /test/reset-crm's
// company_id-scoped DELETE already handles by removing the rows entirely).
const FINANCE_TABLES = [
  "classification_finding", "receipt", "job_cost_ledger", "action_item",
  "upload_batch",
  "recovery_snapshot", "overhead_allocation", "overhead_pool",
  "equipment_rate_profile", "labor_rate_profile", "tenant_finance_policy",
  "finance_config_override",
];

app.post("/test/reset", async (c) => {
  // Scoped to company_id, not a global wipe — e2e suites for different pages
  // run as separate Playwright test files, which Playwright may execute in
  // parallel workers against this same shared local D1 instance. A global
  // DELETE here would race with another file's just-seeded data.
  const { tenant_id } = await c.req.json<{ tenant_id: string }>();
  if (!tenant_id) return c.json({ error: "tenant_id is required" }, 400);
  await c.env.DB.batch(
    FINANCE_TABLES.map((t) => c.env.DB.prepare(`DELETE FROM ${t} WHERE company_id = ?`).bind(tenant_id)),
  );
  return c.json({ ok: true });
});

app.post("/test/exec", async (c) => {
  const { sql, params } = await c.req.json<{ sql: string; params?: unknown[] }>();
  const result = await c.env.DB.prepare(sql).bind(...(params ?? [])).run();
  // `results` is included (in addition to the original `ok`/`meta`) so seed
  // callers that only INSERT are unaffected, while SELECT-based verification
  // callers (e.g. queue.e2e.ts's Resolve/Dismiss tests) can read rows back.
  return c.json({ ok: true, meta: result.meta, results: result.results });
});

// ── Same two endpoints, but against the CRM's own `DB` — only collections.tsx
// reads it, so only its e2e suite needs these. Separate from /test/reset and
// /test/exec above so it's never ambiguous which database a seed call hits. ──
app.post("/test/reset-crm", async (c) => {
  const { company_id } = await c.req.json<{ company_id: string }>();
  if (!company_id) return c.json({ error: "company_id is required" }, 400);
  // payments before invoices: payments.invoice_id references invoices.id in
  // spirit (no FK constraint declared, but deleting children first keeps the
  // same discipline as the FINANCE_TABLES order above). work_order_employees
  // before work_orders: real FK, ON DELETE CASCADE would handle it anyway,
  // explicit for clarity. Callers seeding job_cost_ledger against these rows
  // (job-costing.e2e.ts) must call resetFinanceDb() BEFORE this, not after —
  // job_cost_ledger.time_entry_id/job_id are real FKs into time_entries/
  // work_orders since migrations/0057_finance_merge.sql. crew_members before
  // crews (real FK, ON DELETE CASCADE, explicit for the same reason as
  // work_order_employees); crews itself comes AFTER work_orders since
  // work_orders.crew_id is a real FK into crews(id) (migrations/0016_crews.sql)
  // — added for config-admin's division-gap banner e2e coverage.
  await c.env.DB.batch([
    c.env.DB.prepare(`DELETE FROM payments WHERE company_id = ?`).bind(company_id),
    c.env.DB.prepare(`DELETE FROM invoices WHERE company_id = ?`).bind(company_id),
    c.env.DB.prepare(`DELETE FROM time_entries WHERE company_id = ?`).bind(company_id),
    c.env.DB.prepare(`DELETE FROM work_order_employees WHERE company_id = ?`).bind(company_id),
    c.env.DB.prepare(`DELETE FROM work_orders WHERE company_id = ?`).bind(company_id),
    c.env.DB.prepare(`DELETE FROM crew_members WHERE company_id = ?`).bind(company_id),
    c.env.DB.prepare(`DELETE FROM crews WHERE company_id = ?`).bind(company_id),
  ]);
  return c.json({ ok: true });
});

app.post("/test/exec-crm", async (c) => {
  const { sql, params } = await c.req.json<{ sql: string; params?: unknown[] }>();
  const result = await c.env.DB.prepare(sql).bind(...(params ?? [])).run();
  return c.json({ ok: true, meta: result.meta });
});

export default app;
