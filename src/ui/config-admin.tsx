import { Hono } from "hono";
import {
  getEffectiveConfig, listEffectiveConfigs, saveConfigOverride, resetConfigOverride,
  isConfigName, getStaticDefault, CONFIG_NAMES, type ConfigName,
} from "../config/finance-config-runtime";
import { getCrewsMissingDivisionWithUnpostedTime } from "../db/repos";
import { canSee } from "./roles";
import { readPageArgs, Page, isPartialRequest, type FinanceAuthVars } from "./layout";

export type ConfigAdminBindings = { DB: D1Database };

/**
 * Admin-editable surface for config/finance/*.json — plain HTML forms
 * (POST + redirect, no client JS) editing raw JSON per config file. Saved
 * edits become a finance_config_override row (migrations/finance/0004)
 * and take effect immediately for anything reading through
 * getEffectiveConfig() — no deploy needed. "Reset" removes the override,
 * reverting to the version-controlled static default.
 *
 * Gating: the page itself (Company Policy / Upload Documents / Financial
 * Setup links) is owner-only, same gate as the Budget & Rates page
 * (docs/spec/ROLES.md). The raw JSON config editors below those links are
 * a SEPARATE, stricter gate: platform-staff-only (isSuperAdmin), not just
 * the tenant's Finance-OS owner role. A real business owner should only
 * need Upload — per owner feedback (docs/FINANCE-OS-FIX-PLAN.md item 2)
 * these editors were reaching every owner-role user, not just platform
 * staff, and needed to be hidden entirely (not greyed out/teased) rather
 * than exposed with a lock icon.
 */
export const configAdminRouter = new Hono<{ Bindings: ConfigAdminBindings; Variables: FinanceAuthVars }>();

/**
 * Shared by the GET handler (notice derived from ?saved=/?error= query
 * params) and the two POST handlers' partial-mode branch (notice derived
 * directly from the just-computed save/reset result — see isPartialRequest
 * in layout.tsx: a fetch()-based form submit can't follow a redirect the
 * way a real navigation does, so instead of c.redirect() this renders the
 * same target content the redirect would have landed on, directly).
 * Full-page (non-partial) POST behavior is untouched — still a real
 * redirect, exactly as before this function existed.
 */
async function renderConfigAdminPage(
  c: { env: { DB: D1Database } },
  tenant_id: string, role: string, isSuperAdmin: boolean, basePath: string, notice: string | null, partial: boolean,
) {
  // The raw-JSON editors read/list effective configs from the DB — skip the
  // query entirely for a non-super-admin, not just the render, since
  // there's nothing for them to do with the result either way.
  const configs = isSuperAdmin ? await listEffectiveConfigs(c.env.DB, tenant_id) : [];
  // Real business owners (not just super-admins) need to see this — it's
  // operational fallout, not raw platform config. See
  // docs/spec/OBSERVABILITY.md point 2 and getCrewsMissingDivisionWithUnpostedTime.
  const divisionGaps = await getCrewsMissingDivisionWithUnpostedTime(c.env.DB, tenant_id);
  return (
    <Page
      title="Setup & Config"
      active="finConfig"
      tenant={tenant_id || undefined}
      role={role}
      partial={partial}
    >
      {notice && (
        <div class="fin-note" data-testid="notice" style={notice.startsWith("Error") ? "border-left-color:var(--gw-rose)" : ""}>
          {notice}
        </div>
      )}

      {divisionGaps.length > 0 && (
        <div class="fin-note" data-testid="division-gap-banner" style="border-left-color:var(--gw-amber)">
          <strong>&#9888; Time entries can't post to the ledger — no division set.</strong>
          <ul style="margin:8px 0 0 18px;padding:0">
            {divisionGaps.map((g) => (
              <li data-testid={`division-gap-${g.crew_id}`}>
                {g.unposted_count} time {g.unposted_count === 1 ? "entry" : "entries"} stuck behind{" "}
                <strong>{g.crew_name}</strong> — set a division for this crew to release them.
              </li>
            ))}
          </ul>
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

      {isSuperAdmin && configs.map((cfg) => (
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
          <form method="post" action={`${basePath}/${cfg.name}?tenant_id=${encodeURIComponent(tenant_id)}&role=${role}${isSuperAdmin ? "&is_super_admin=1" : ""}`}>
            <textarea
              name="config_json"
              rows={12}
              cols={80}
              data-testid={`editor-${cfg.name}`}
              style="width:100%;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;line-height:1.5;padding:12px;border:1px solid var(--gw-line-strong);border-radius:var(--gw-r-sm);background:var(--gw-surface-2);color:var(--gw-ink)"
            >
              {/*
                No escapeHtml here. Hono JSX already escapes a {expression}
                child, so escaping first produced &amp;quot; where the browser
                needed &quot; — the textarea rendered `&quot;a&quot;` instead of
                `"a"`, and copying that value back out failed JSON.parse. The
                fix is to escape once, which JSX does for us.
              */}
              {JSON.stringify(cfg.value, null, 2)}
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
            <form method="post" action={`${basePath}/${cfg.name}/reset?tenant_id=${encodeURIComponent(tenant_id)}&role=${role}${isSuperAdmin ? "&is_super_admin=1" : ""}`} style="margin-top:8px">
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
    </Page>
  );
}

configAdminRouter.get("/", async (c) => {
  const { tenant_id, role, isSuperAdmin } = readPageArgs(c);
  const partial = isPartialRequest(c);
  if (!canSee(role, "can_see_budget_rates")) {
    return c.html(
      <Page title="Setup & Config" active="finConfig" role={role} partial={partial}>
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

  const notice = c.req.query("saved") === "1" ? "Saved." : c.req.query("error") ? `Error: ${c.req.query("error")}` : null;
  // Absolute base path this router is mounted at, derived from the actual
  // request rather than hardcoded — works whether mounted at /config
  // (dev-server.ts) or /finance/config (the live app), no path assumptions.
  const basePath = c.req.path;

  return c.html(await renderConfigAdminPage(c, tenant_id, role, isSuperAdmin, basePath, notice, partial));
});

configAdminRouter.post("/:name", async (c) => {
  const { tenant_id, role, isSuperAdmin } = readPageArgs(c);
  const name = c.req.param("name");
  const basePath = c.req.path.replace(new RegExp(`/${name}$`), "");
  if (!canSee(role, "can_see_budget_rates")) return c.text("owner role required", 403);
  if (!isConfigName(name)) return c.text(`unknown config: ${name}`, 404);

  const form = await c.req.parseBody();
  const rawJson = String(form.config_json ?? "");
  const updatedBy = c.var.repId ?? "unknown";
  const result = await saveConfigOverride(c.env.DB, tenant_id, name, rawJson, updatedBy);

  // Partial (SPA in-app-nav) requests can't follow a redirect the way a
  // real navigation does (see layout.tsx's isPartialRequest) — render the
  // same content the redirect below would have landed on, directly.
  // Full-page requests keep the exact pre-existing redirect behavior.
  if (isPartialRequest(c)) {
    const notice = result.ok ? "Saved." : `Error: ${result.error}`;
    return c.html(await renderConfigAdminPage(c, tenant_id, role, isSuperAdmin, basePath, notice, true));
  }
  const qs = `tenant_id=${encodeURIComponent(tenant_id)}&role=${role}${isSuperAdmin ? "&is_super_admin=1" : ""}`;
  if (!result.ok) return c.redirect(`${basePath}?${qs}&error=${encodeURIComponent(result.error)}`);
  return c.redirect(`${basePath}?${qs}&saved=1`);
});

configAdminRouter.post("/:name/reset", async (c) => {
  const { tenant_id, role, isSuperAdmin } = readPageArgs(c);
  const name = c.req.param("name");
  const basePath = c.req.path.replace(new RegExp(`/${name}/reset$`), "");
  if (!canSee(role, "can_see_budget_rates")) return c.text("owner role required", 403);
  if (!isConfigName(name)) return c.text(`unknown config: ${name}`, 404);

  await resetConfigOverride(c.env.DB, tenant_id, name);

  if (isPartialRequest(c)) {
    return c.html(await renderConfigAdminPage(c, tenant_id, role, isSuperAdmin, basePath, "Saved.", true));
  }
  const qs = `tenant_id=${encodeURIComponent(tenant_id)}&role=${role}${isSuperAdmin ? "&is_super_admin=1" : ""}`;
  return c.redirect(`${basePath}?${qs}&saved=1`);
});

// JSON API counterpart — same auth/validation, machine-readable, for
// future tooling (CLI, external scripts) rather than the browser form above.
export const configAdminApiRouter = new Hono<{ Bindings: ConfigAdminBindings; Variables: FinanceAuthVars }>();

// Every endpoint below is gated twice: canSee(...) keeps non-owner roles out
// (unchanged, pre-existing), and the isSuperAdmin check keeps ordinary
// tenant owners out of the raw-JSON config surface even though they pass
// the owner check — this is the API-level half of the same fix that hides
// the editors in the UI (renderConfigAdminPage above); a non-super-admin
// must get a 403 hitting these routes directly, not just have the buttons
// hidden from them. See docs/FINANCE-OS-FIX-PLAN.md item 2.
configAdminApiRouter.get("/", async (c) => {
  const { tenant_id, role, isSuperAdmin } = readPageArgs(c);
  if (!canSee(role, "can_see_budget_rates")) return c.json({ error: "owner role required" }, 403);
  if (!isSuperAdmin) return c.json({ error: "super admin required" }, 403);
  return c.json({ configs: await listEffectiveConfigs(c.env.DB, tenant_id) });
});

configAdminApiRouter.get("/:name", async (c) => {
  const { tenant_id, role, isSuperAdmin } = readPageArgs(c);
  if (!canSee(role, "can_see_budget_rates")) return c.json({ error: "owner role required" }, 403);
  if (!isSuperAdmin) return c.json({ error: "super admin required" }, 403);
  const name = c.req.param("name");
  if (!isConfigName(name)) return c.json({ error: `unknown config: ${name}`, valid_names: CONFIG_NAMES }, 404);
  return c.json(await getEffectiveConfig(c.env.DB, tenant_id, name));
});

configAdminApiRouter.put("/:name", async (c) => {
  const { tenant_id, role, isSuperAdmin } = readPageArgs(c);
  if (!canSee(role, "can_see_budget_rates")) return c.json({ error: "owner role required" }, 403);
  if (!isSuperAdmin) return c.json({ error: "super admin required" }, 403);
  const name = c.req.param("name");
  if (!isConfigName(name)) return c.json({ error: `unknown config: ${name}` }, 404);
  const rawJson = await c.req.text();
  const updatedBy = c.var.repId ?? "unknown";
  const result = await saveConfigOverride(c.env.DB, tenant_id, name, rawJson, updatedBy);
  if (!result.ok) return c.json({ error: result.error }, 400);
  return c.json({ ok: true });
});

configAdminApiRouter.post("/:name/reset", async (c) => {
  const { tenant_id, role, isSuperAdmin } = readPageArgs(c);
  if (!canSee(role, "can_see_budget_rates")) return c.json({ error: "owner role required" }, 403);
  if (!isSuperAdmin) return c.json({ error: "super admin required" }, 403);
  const name = c.req.param("name");
  if (!isConfigName(name)) return c.json({ error: `unknown config: ${name}` }, 404);
  await resetConfigOverride(c.env.DB, tenant_id, name);
  return c.json({ ok: true });
});

// GET /:name/default intentionally has NO isSuperAdmin gate (and no auth
// gate at all): it returns the static, version-controlled default value
// for a config name — not tenant data, not an override, nothing sensitive.
// Any caller who can read this repo can already see the same JSON in
// config/finance/*.json.
configAdminApiRouter.get("/:name/default", (c) => {
  const name = c.req.param("name");
  if (!isConfigName(name)) return c.json({ error: `unknown config: ${name}` }, 404);
  return c.json({ name, value: getStaticDefault(name as ConfigName) });
});
