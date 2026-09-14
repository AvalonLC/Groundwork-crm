import { Hono } from "hono";
import { runNightlyRollup, buildTenantRollup } from "../cron/rollup";
import { gatherTenantRollupInputs, listTenantIdsWithPolicy } from "../cron/gather-inputs";
import { runUnbilledWorkDetection } from "../cron/unbilled-sweep";
import { cleanupAbandonedImports } from "../ai/pdf-lead-import";

export type CronTriggerBindings = { DB: D1Database; CRON_SECRET?: string };

/**
 * See docs/spec/RECOVERY.md, docs/RUNBOOK-finance-cron.md, and
 * docs/PUNCHLIST.md. Scheduling is decided: an external scheduler
 * (.github/workflows/finance-cron.yml) calls POST /rollup on a schedule.
 * The rejected companion-Worker option (workers/finance-cron/) is kept as
 * a documented, unused alternative.
 *
 * Auth: a shared secret header, not a session cookie — no human is logged
 * in when a scheduler calls this. Fails closed: if CRON_SECRET isn't
 * configured at all, POST /rollup rejects every request, never silently
 * allowed through.
 */
export const cronTriggerRouter = new Hono<{ Bindings: CronTriggerBindings }>();

/**
 * Pre-auth diagnostic — deliberately does NOT require the secret, since its
 * whole purpose is letting Tyler confirm the Cloudflare Pages side is
 * configured before he's certain the two secret values (GitHub + Cloudflare)
 * match. Reveals only a boolean; never the secret value, never tenant data.
 * See docs/RUNBOOK-finance-cron.md "How to verify" section.
 */
cronTriggerRouter.get("/rollup/status", (c) => {
  return c.json({ cron_secret_configured: !!c.env.CRON_SECRET });
});

cronTriggerRouter.post("/rollup", async (c) => {
  const configuredSecret = c.env.CRON_SECRET;
  if (!configuredSecret) {
    return c.json({ error: "CRON_SECRET is not configured — refusing all requests until it is" }, 503);
  }
  const providedSecret = c.req.header("X-Cron-Secret");
  if (providedSecret !== configuredSecret) {
    return c.json({ error: "unauthorized" }, 401);
  }

  const asOf = c.req.query("as_of") ?? new Date().toISOString().slice(0, 10);
  // Dry run: computes and returns what WOULD be written, touches no table.
  // Still requires the real secret — even a dry run reads real per-tenant
  // financial data (job_cost_ledger sums, overhead allocations), so it's
  // not something to expose without auth just because it doesn't write.
  const dryRun = c.req.query("dry_run") === "true";
  const db = c.env.DB;

  const tenantIds = await listTenantIdsWithPolicy(db);
  const inputs = [];
  const skipped: string[] = [];
  for (const tenantId of tenantIds) {
    const input = await gatherTenantRollupInputs(db, tenantId, asOf);
    if (input) inputs.push(input);
    else skipped.push(tenantId);
  }

  const results = dryRun ? inputs.map(buildTenantRollup) : await runNightlyRollup(db, inputs);

  // Unbilled-work sweep runs alongside the rollup, once per tenant with a
  // policy row (same tenant set the rollup itself uses) — see
  // docs/FINANCE-OS-FIX-PLAN.md item 3 and src/cron/unbilled-sweep.ts.
  // Same dry_run contract as the rollup above: computes/reports, writes
  // nothing when true.
  const unbilledResults = [];
  for (const tenantId of tenantIds) {
    unbilledResults.push(await runUnbilledWorkDetection(db, tenantId, dryRun));
  }

  return c.json({
    as_of: asOf,
    dry_run: dryRun,
    tenants_processed: results.length,
    tenants_skipped: skipped,
    results,
    unbilled_sweep: unbilledResults,
  });
});

// ── PDF lead-import abandoned-document cleanup ──────────────────────────────
//
// Implements the retention policy named by ABANDONED_RETENTION_HOURS in
// src/ai/pdf-lead-import.ts (see migrations/0088_pdf_lead_import.sql's own
// doc comment, which refers forward to "cleanupAbandonedImports()'s own
// guard and its tests" — this route is that function's only invocation
// path). Same auth/shape/dry-run contract as POST /rollup above, reusing
// the SAME shared secret (no new secret to provision) since both routes
// already share this router's fail-closed auth gate.
//
// Deliberately NOT a Cloudflare Workers `triggers` cron — this project's
// hosted-deploy path rejects `triggers` in wrangler config (see this
// repo's own deploy-skill notes), so periodic work here follows the exact
// pattern the finance rollup above already established: an external
// scheduler (a GitHub Actions cron, same as .github/workflows/finance-cron.yml)
// calls this HTTP endpoint on its own schedule. No workflow file wires this
// up yet — adding one is a follow-up, not a requirement for this route to
// exist and be safely callable (dry_run=true by hand, or a manual
// workflow_dispatch, both work today without any new scheduling code).
cronTriggerRouter.post("/lead-import-cleanup", async (c) => {
  const configuredSecret = c.env.CRON_SECRET;
  if (!configuredSecret) {
    return c.json({ error: "CRON_SECRET is not configured — refusing all requests until it is" }, 503);
  }
  const providedSecret = c.req.header("X-Cron-Secret");
  if (providedSecret !== configuredSecret) {
    return c.json({ error: "unauthorized" }, 401);
  }

  // Dry run: computes and returns what WOULD be abandoned without writing
  // anything — same contract as /rollup's own dry_run parameter.
  const dryRun = c.req.query("dry_run") === "true";
  // Optional single-tenant scope, for a manual/backfill run against just
  // one company without sweeping every tenant — omitted (the default)
  // sweeps every tenant, same as /rollup's own all-tenants default.
  const companyId = c.req.query("company_id") || undefined;
  const db = c.env.DB;

  const result = await cleanupAbandonedImports(db, { companyId, dryRun });

  return c.json({
    dry_run: dryRun,
    company_id: companyId || null,
    imports_abandoned: result.importsAbandoned,
    documents_abandoned: result.documentsAbandoned,
    abandoned_import_ids: result.abandonedImportIds,
  });
});
