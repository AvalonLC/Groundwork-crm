/**
 * Companion Worker — Option A for scheduling the Finance OS nightly rollup.
 * See wrangler.jsonc in this directory and docs/spec/RECOVERY.md.
 *
 * This Worker does nothing but call the main app's authenticated rollup
 * endpoint on a schedule. All the actual rollup logic lives in
 * src/cron/rollup.ts and src/api/cron-trigger.ts, in the main groundwork-crm
 * project — this is intentionally a thin trigger, not a second copy of the
 * business logic.
 */
export interface Env {
  ROLLUP_ENDPOINT: string;
  CRON_SECRET: string;
}

export default {
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(triggerRollup(env));
  },

  // Manual invocation for testing this Worker itself (not the rollup logic,
  // which is tested in the main project). Not meant for production traffic.
  async fetch(_request: Request, env: Env): Promise<Response> {
    const result = await triggerRollup(env);
    return new Response(JSON.stringify(result), { headers: { "content-type": "application/json" } });
  },
};

async function triggerRollup(env: Env): Promise<{ status: number; body: string }> {
  const res = await fetch(env.ROLLUP_ENDPOINT, {
    method: "POST",
    headers: { "X-Cron-Secret": env.CRON_SECRET },
  });
  return { status: res.status, body: await res.text() };
}
