/// <reference types="@cloudflare/vitest-pool-workers" />
import { describe, it, expect } from "vitest";
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import app from "./index";

/**
 * Finance OS §9 Priority 3 (config-validation pass).
 *
 * GET /api/status is the ONE genuinely public, unauthenticated health-check
 * route in this app. Every per-integration status endpoint that already
 * existed before this (/api/google/status, /api/sms/status,
 * /api/email/status, /api/stripe/status) requires requireAuth — none of them
 * can be used by an external uptime monitor or by an ops engineer confirming
 * a fresh deploy's secrets landed, without first logging in. This closes
 * that gap by reporting boolean-only config flags on the already-public
 * /api/status route, mirroring the pattern already proven safe for public
 * exposure by src/api/cron-trigger.ts's GET /rollup/status
 * (cron_secret_configured) — booleans only, never secret values.
 */

async function statusReq() {
  const ctx = createExecutionContext();
  const res = await app.request("/api/status", {}, env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

describe("GET /api/status — public health check with config coverage", () => {
  it("ST-01 requires no auth (no cookie, no header) and returns 200", async () => {
    const res = await statusReq();
    expect(res.status).toBe(200);
  });

  it("ST-02 reports the base fields unchanged (app, status, server_time)", async () => {
    const res = await statusReq();
    const json = await res.json() as any;
    expect(json.app).toBe("Groundwork CRM");
    expect(json.status).toBe("ok");
    expect(typeof json.server_time).toBe("string");
  });

  it("ST-03 reports a config block of booleans only, never the secret values themselves", async () => {
    const res = await statusReq();
    const json = await res.json() as any;
    expect(json.config).toBeDefined();
    for (const key of [
      "cron_secret_configured", "stripe_configured", "sendgrid_configured",
      "openai_configured", "google_oauth_configured",
    ]) {
      expect(typeof json.config[key]).toBe("boolean");
    }
    // Never leak an actual value anywhere in the response — the whole point
    // of this endpoint being safe to expose without auth is that a boolean
    // reveals nothing usable. If a secret's raw value ever appeared in the
    // JSON, this stringified-response check would catch it.
    const raw = JSON.stringify(json);
    for (const secretEnvVar of [
      "CRON_SECRET", "STRIPE_SECRET_KEY", "SENDGRID_API_KEY",
      "OPENAI_API_KEY", "GOOGLE_CLIENT_SECRET",
    ]) {
      const val = (env as any)[secretEnvVar];
      if (val) expect(raw).not.toContain(val);
    }
  });

  it("ST-04 google_oauth_configured is only true when BOTH client id and secret are set (test env has neither)", async () => {
    const res = await statusReq();
    const json = await res.json() as any;
    // This test environment's wrangler.jsonc / vitest bindings do not set
    // GOOGLE_CLIENT_ID/SECRET, so this should read false here — a real
    // production deploy with both secrets set would read true.
    expect(json.config.google_oauth_configured).toBe(false);
  });
});
