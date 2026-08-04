import { Hono } from "hono";
import {
  getEffectiveConfig, listEffectiveConfigs, saveConfigOverride, resetConfigOverride,
  isConfigName, getStaticDefault, CONFIG_NAMES, type ConfigName,
} from "../config/finance-config-runtime";
import { canSee } from "./roles";
import { readPageArgs, Page, type FinanceAuthVars } from "./layout";

export type ConfigAdminBindings = { FINANCE_DB: D1Database };

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
    return c.html(<Page title="Finance Config"><p data-testid="denied">not available for this role</p></Page>, 403);
  }

  const configs = await listEffectiveConfigs(c.env.FINANCE_DB, tenant_id);
  const notice = c.req.query("saved") === "1" ? "Saved." : c.req.query("error") ? `Error: ${c.req.query("error")}` : null;
  // Absolute base path this router is mounted at, derived from the actual
  // request rather than hardcoded — works whether mounted at /config
  // (dev-server.ts) or /finance/config (the live app), no path assumptions.
  const basePath = c.req.path;

  return c.html(
    <Page title="Finance Config">
      <h1>Finance Config</h1>
      {notice && <p data-testid="notice">{notice}</p>}
      {configs.map((cfg) => (
        <section data-testid={`config-${cfg.name}`}>
          <h2>{cfg.name}</h2>
          <p data-testid={`status-${cfg.name}`}>
            {cfg.is_override
              ? `Overridden (${cfg.override_scope === "__global__" ? "global" : "this tenant"}, by ${cfg.updated_by ?? "unknown"} at ${cfg.updated_at})`
              : "Using static default (not overridden)"}
          </p>
          <form method="post" action={`${basePath}/${cfg.name}?tenant_id=${encodeURIComponent(tenant_id)}&role=${role}`}>
            <textarea name="config_json" rows={12} cols={80} data-testid={`editor-${cfg.name}`}>
              {escapeHtml(JSON.stringify(cfg.value, null, 2))}
            </textarea>
            <br />
            <button type="submit" data-testid={`save-${cfg.name}`}>Save</button>
          </form>
          {cfg.is_override && (
            <form method="post" action={`${basePath}/${cfg.name}/reset?tenant_id=${encodeURIComponent(tenant_id)}&role=${role}`}>
              <button type="submit" data-testid={`reset-${cfg.name}`}>Reset to default</button>
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
  const result = await saveConfigOverride(c.env.FINANCE_DB, tenant_id, name, rawJson, updatedBy);

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

  await resetConfigOverride(c.env.FINANCE_DB, tenant_id, name);
  const qs = `tenant_id=${encodeURIComponent(tenant_id)}&role=${role}`;
  return c.redirect(`${basePath}?${qs}&saved=1`);
});

// JSON API counterpart — same auth/validation, machine-readable, for
// future tooling (CLI, external scripts) rather than the browser form above.
export const configAdminApiRouter = new Hono<{ Bindings: ConfigAdminBindings; Variables: FinanceAuthVars }>();

configAdminApiRouter.get("/", async (c) => {
  const { tenant_id, role } = readPageArgs(c);
  if (!canSee(role, "can_see_budget_rates")) return c.json({ error: "owner role required" }, 403);
  return c.json({ configs: await listEffectiveConfigs(c.env.FINANCE_DB, tenant_id) });
});

configAdminApiRouter.get("/:name", async (c) => {
  const { tenant_id, role } = readPageArgs(c);
  if (!canSee(role, "can_see_budget_rates")) return c.json({ error: "owner role required" }, 403);
  const name = c.req.param("name");
  if (!isConfigName(name)) return c.json({ error: `unknown config: ${name}`, valid_names: CONFIG_NAMES }, 404);
  return c.json(await getEffectiveConfig(c.env.FINANCE_DB, tenant_id, name));
});

configAdminApiRouter.put("/:name", async (c) => {
  const { tenant_id, role } = readPageArgs(c);
  if (!canSee(role, "can_see_budget_rates")) return c.json({ error: "owner role required" }, 403);
  const name = c.req.param("name");
  if (!isConfigName(name)) return c.json({ error: `unknown config: ${name}` }, 404);
  const rawJson = await c.req.text();
  const updatedBy = c.var.repId ?? "unknown";
  const result = await saveConfigOverride(c.env.FINANCE_DB, tenant_id, name, rawJson, updatedBy);
  if (!result.ok) return c.json({ error: result.error }, 400);
  return c.json({ ok: true });
});

configAdminApiRouter.post("/:name/reset", async (c) => {
  const { tenant_id, role } = readPageArgs(c);
  if (!canSee(role, "can_see_budget_rates")) return c.json({ error: "owner role required" }, 403);
  const name = c.req.param("name");
  if (!isConfigName(name)) return c.json({ error: `unknown config: ${name}` }, 404);
  await resetConfigOverride(c.env.FINANCE_DB, tenant_id, name);
  return c.json({ ok: true });
});

configAdminApiRouter.get("/:name/default", (c) => {
  const name = c.req.param("name");
  if (!isConfigName(name)) return c.json({ error: `unknown config: ${name}` }, 404);
  return c.json({ name, value: getStaticDefault(name as ConfigName) });
});
