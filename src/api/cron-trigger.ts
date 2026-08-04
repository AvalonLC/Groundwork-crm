import { Hono } from "hono";
import { runNightlyRollup } from "../cron/rollup";
import { gatherTenantRollupInputs, listTenantIdsWithPolicy } from "../cron/gather-inputs";

export type CronTriggerBindings = { FINANCE_DB: D1Database; CRON_SECRET?: string };

/**
 * See docs/spec/RECOVERY.md and docs/PUNCHLIST.md — Cloudflare Pages has no
 * native Cron Trigger, so this is the invocable endpoint EITHER a companion
 * Worker's own Cron Trigger (see workers/finance-cron/) or an external
 * scheduled caller (GitHub Actions on a schedule, cron-job.org, etc.) hits
 * to actually run the nightly rollup. Not wired to any scheduler yet —
 * that's the one decision this scaffolding doesn't make for Tyler.
 *
 * Auth: a shared secret header, not a session cookie — no human is logged
 * in when a scheduler calls this. Fails closed: if CRON_SECRET isn't
 * configured at all, every request is rejected, never silently allowed
 * through.
 */
export const cronTriggerRouter = new Hono<{ Bindings: CronTriggerBindings }>();

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
  const db = c.env.FINANCE_DB;

  const tenantIds = await listTenantIdsWithPolicy(db);
  const inputs = [];
  const skipped: string[] = [];
  for (const tenantId of tenantIds) {
    const input = await gatherTenantRollupInputs(db, tenantId, asOf);
    if (input) inputs.push(input);
    else skipped.push(tenantId);
  }

  const results = await runNightlyRollup(db, inputs);

  return c.json({
    as_of: asOf,
    tenants_processed: results.length,
    tenants_skipped: skipped,
    results,
  });
});
