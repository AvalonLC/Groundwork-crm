import { Hono } from "hono";
import {
  getEffectiveConfig, listEffectiveConfigs, saveConfigOverride, resetConfigOverride,
  isConfigName, getStaticDefault, CONFIG_NAMES, type ConfigName,
} from "../config/finance-config-runtime";
import { canSee } from "./roles";
import { readPageArgs, Page, type FinanceAuthVars } from "./layout";

export type ConfigAdminBindings = { DB: D1Database };

/**
 * Admin-editable surface for config/finance/*.json — plain HTML forms
 * (POST + redirect, no client JS) editing raw JSON per config file. Saved
 * edits become a finance_config_override row (migrations/finance/0004)
 * and take effect immediately for anything reading through
 * getEffectiveConfig() — no deploy needed. "Reset" removes the override,
 * reverting to the version-controlled static default. Owner-only, same
 * gate as the Budget & Rates page (docs/spec/ROLES.md).
 */
export const configAdminRouter = new Hono<{ Bindings: ConfigAdminBindings; Variables: FinanceAuthVars }>();

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

configAdminRouter.get("/", async (c) => {
  const { tenant_id, role } = readPageArgs(c);
  if (!canSee(role, "can_see_budget_rates")) {
    return c.html(
      <Page title="Setup & Config" active="finConfig" role={role}>
        <section class="fin-card">
          <div class="fin-empty" data-testid="denied">
            <div class="fin-empty-t">Not available for your role</div>
            <div class="fin-empty-s">Financial configuration is owner-only.</div>
          </div>
        </section>
      </Page>,
      403,
    );
  }

  const configs = await listEffectiveConfigs(c.env.DB, tenant_id);
  const notice = c.req.query("saved") === "1" ? "Saved." : c.req.query("error") ? `Error: ${c.req.query("error")}` : null;
  // Absolute base path this router is mounted at, derived from the actual
  // request rather than hardcoded — works whether mounted at /config
  // (dev-server.ts) or /finance/config (the live app), no path assumptions.
  const basePath = c.req.path;

  return c.html(
    <Page
      title="Setup & Config"
      active="finConfig"
      tenant={tenant_id || undefined}
      role={role}
    >
      {notice && (
        <div class="fin-note" data-testid="notice" style={notice.startsWith("Error") ? "border-left-color:var(--gw-rose)" : ""}>
          {notice}
        </div>
      )}
      <div class="fin-note">
        These files are the platform defaults every company starts from. Saving here
        writes an override for <strong>this company only</strong> — it never changes
        another tenant's view or the shipped default. Reset puts it back.
      </div>

      <section class="fin-card" data-testid="policy-link-card">
        <div class="fin-card-h">
          <h2 class="fin-card-t">Company Policy</h2>
        </div>
        <p class="fin-card-s" style="margin-bottom:12px">
          The one setting that isn't a config file: your company's own materiality
          threshold, overhead target, and equipment-engine switch. Rate resolution,
          classification, and the nightly recovery rollup all read this row directly.
        </p>
        <a
          href={basePath.replace(/\/config$/, "/policy")}
          data-testid="policy-link"
          style="display:inline-block;background:var(--gw-pine);color:#fff;border-radius:var(--gw-r-sm);padding:9px 18px;font-size:13px;font-weight:700"
        >
          Open Company Policy
        </a>
      </section>

      <section class="fin-card" data-testid="upload-link-card">
        <div class="fin-card-h">
          <h2 class="fin-card-t">Upload Documents</h2>
        </div>
        <p class="fin-card-s" style="margin-bottom:12px">
          Financial exports (P&L, bank/card CSV, payroll) and receipts — checked against
          known formats and reconciled against your overhead pools, with anything
          uncertain flagged for review instead of guessed at.
        </p>
        <a
          href={basePath.replace(/\/config$/, "/upload")}
          data-testid="upload-link"
          style="display:inline-block;background:var(--gw-pine);color:#fff;border-radius:var(--gw-r-sm);padding:9px 18px;font-size:13px;font-weight:700"
        >
          Open Upload Documents
        </a>
      </section>

      <section class="fin-card" data-testid="onboarding-link-card">
        <div class="fin-card-h">
          <h2 class="fin-card-t">Financial Setup</h2>
        </div>
        <p class="fin-card-s" style="margin-bottom:12px">
          Drop in P&L exports, bank/card exports, and receipts all at once — each gets
          classified, and a single report shows what's good to go, what needs review,
          and what's still missing across the board.
        </p>
        <a
          href={basePath.replace(/\/config$/, "/onboarding")}
          data-testid="onboarding-link"
          style="display:inline-block;background:var(--gw-pine);color:#fff;border-radius:var(--gw-r-sm);padding:9px 18px;font-size:13px;font-weight:700"
        >
          Open Financial Setup
        </a>
      </section>

      {configs.map((cfg) => (
        <section class="fin-card" data-testid={`config-${cfg.name}`}>
          <div class="fin-card-h">
            <h2 class="fin-card-t">{cfg.name}</h2>
            <span class={`fin-badge ${cfg.is_override ? "b-med" : "b-human"}`}>
              {cfg.is_override ? "overridden" : "default"}
            </span>
          </div>
          <p class="fin-card-s" data-testid={`status-${cfg.name}`} style="margin-bottom:10px">
            {cfg.is_override
              ? `Overridden (${cfg.override_scope === "__global__" ? "global" : "this tenant"}, by ${cfg.updated_by ?? "unknown"} at ${cfg.updated_at})`
              : "Using static default (not overridden)"}
          </p>
          <form method="post" action={`${basePath}/${cfg.name}?tenant_id=${encodeURIComponent(tenant_id)}&role=${role}`}>
            <textarea
              name="config_json"
              rows={12}
              cols={80}
              data-testid={`editor-${cfg.name}`}
              style="width:100%;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;line-height:1.5;padding:12px;border:1px solid var(--gw-line-strong);border-radius:var(--gw-r-sm);background:var(--gw-surface-2);color:var(--gw-ink)"
            >
              {escapeHtml(JSON.stringify(cfg.value, null, 2))}
            </textarea>
            <button
              type="submit"
              data-testid={`save-${cfg.name}`}
              style="margin-top:10px;background:var(--gw-pine);color:#fff;border:0;border-radius:var(--gw-r-sm);padding:9px 18px;font-size:13px;font-weight:700;cursor:pointer"
            >
              Save
            </button>
          </form>
          {cfg.is_override && (
            <form method="post" action={`${basePath}/${cfg.name}/reset?tenant_id=${encodeURIComponent(tenant_id)}&role=${role}`} style="margin-top:8px">
              <button
                type="submit"
                data-testid={`reset-${cfg.name}`}
                style="background:none;color:var(--gw-muted);border:1px solid var(--gw-line-strong);border-radius:var(--gw-r-sm);padding:8px 16px;font-size:12.5px;font-weight:600;cursor:pointer"
              >
                Reset to default
              </button>
            </form>
          )}
        </section>
      ))}
    </Page>,
  );
});

configAdminRouter.post("/:name", async (c) => {
  const { tenant_id, role } = readPageArgs(c);
  const name = c.req.param("name");
  const basePath = c.req.path.replace(new RegExp(`/${name}$`), "");
  if (!canSee(role, "can_see_budget_rates")) return c.text("owner role required", 403);
  if (!isConfigName(name)) return c.text(`unknown config: ${name}`, 404);

  const form = await c.req.parseBody();
  const rawJson = String(form.config_json ?? "");
  const updatedBy = c.var.repId ?? "unknown";
  const result = await saveConfigOverride(c.env.DB, tenant_id, name, rawJson, updatedBy);

  const qs = `tenant_id=${encodeURIComponent(tenant_id)}&role=${role}`;
  if (!result.ok) return c.redirect(`${basePath}?${qs}&error=${encodeURIComponent(result.error)}`);
  return c.redirect(`${basePath}?${qs}&saved=1`);
});

configAdminRouter.post("/:name/reset", async (c) => {
  const { tenant_id, role } = readPageArgs(c);
  const name = c.req.param("name");
  const basePath = c.req.path.replace(new RegExp(`/${name}/reset$`), "");
  if (!canSee(role, "can_see_budget_rates")) return c.text("owner role required", 403);
  if (!isConfigName(name)) return c.text(`unknown config: ${name}`, 404);

  await resetConfigOverride(c.env.DB, tenant_id, name);
  const qs = `tenant_id=${encodeURIComponent(tenant_id)}&role=${role}`;
  return c.redirect(`${basePath}?${qs}&saved=1`);
});

// JSON API counterpart — same auth/validation, machine-readable, for
// future tooling (CLI, external scripts) rather than the browser form above.
export const configAdminApiRouter = new Hono<{ Bindings: ConfigAdminBindings; Variables: FinanceAuthVars }>();

configAdminApiRouter.get("/", async (c) => {
  const { tenant_id, role } = readPageArgs(c);
  if (!canSee(role, "can_see_budget_rates")) return c.json({ error: "owner role required" }, 403);
  return c.json({ configs: await listEffectiveConfigs(c.env.DB, tenant_id) });
});

configAdminApiRouter.get("/:name", async (c) => {
  const { tenant_id, role } = readPageArgs(c);
  if (!canSee(role, "can_see_budget_rates")) return c.json({ error: "owner role required" }, 403);
  const name = c.req.param("name");
  if (!isConfigName(name)) return c.json({ error: `unknown config: ${name}`, valid_names: CONFIG_NAMES }, 404);
  return c.json(await getEffectiveConfig(c.env.DB, tenant_id, name));
});

configAdminApiRouter.put("/:name", async (c) => {
  const { tenant_id, role } = readPageArgs(c);
  if (!canSee(role, "can_see_budget_rates")) return c.json({ error: "owner role required" }, 403);
  const name = c.req.param("name");
  if (!isConfigName(name)) return c.json({ error: `unknown config: ${name}` }, 404);
  const rawJson = await c.req.text();
  const updatedBy = c.var.repId ?? "unknown";
  const result = await saveConfigOverride(c.env.DB, tenant_id, name, rawJson, updatedBy);
  if (!result.ok) return c.json({ error: result.error }, 400);
  return c.json({ ok: true });
});

configAdminApiRouter.post("/:name/reset", async (c) => {
  const { tenant_id, role } = readPageArgs(c);
  if (!canSee(role, "can_see_budget_rates")) return c.json({ error: "owner role required" }, 403);
  const name = c.req.param("name");
  if (!isConfigName(name)) return c.json({ error: `unknown config: ${name}` }, 404);
  await resetConfigOverride(c.env.DB, tenant_id, name);
  return c.json({ ok: true });
});

configAdminApiRouter.get("/:name/default", (c) => {
  const name = c.req.param("name");
  if (!isConfigName(name)) return c.json({ error: `unknown config: ${name}` }, 404);
  return c.json({ name, value: getStaticDefault(name as ConfigName) });
});
