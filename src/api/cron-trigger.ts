import { Hono } from "hono";
import { runNightlyRollup, buildTenantRollup } from "../cron/rollup";
import { gatherTenantRollupInputs, listTenantIdsWithPolicy } from "../cron/gather-inputs";

export type CronTriggerBindings = { FINANCE_DB: D1Database; CRON_SECRET?: string };

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
  const db = c.env.FINANCE_DB;

  const tenantIds = await listTenantIdsWithPolicy(db);
  const inputs = [];
  const skipped: string[] = [];
  for (const tenantId of tenantIds) {
    const input = await gatherTenantRollupInputs(db, tenantId, asOf);
    if (input) inputs.push(input);
    else skipped.push(tenantId);
  }

  const results = dryRun ? inputs.map(buildTenantRollup) : await runNightlyRollup(db, inputs);

  return c.json({
    as_of: asOf,
    dry_run: dryRun,
    tenants_processed: results.length,
    tenants_skipped: skipped,
    results,
  });
});
