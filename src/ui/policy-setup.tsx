import { Hono } from "hono";
import { getTenantFinancePolicy, upsertTenantFinancePolicy } from "../db/repos";
import type { TenantFinancePolicy } from "../db/schema";
import { parseMoneyToCents } from "../ai/csv";
import { tenantDefaults } from "../config/finance-config";
import { canSee } from "./roles";
import { readPageArgs, Page, Card, Why, money, type FinanceAuthVars } from "./layout";

export type PolicySetupBindings = { DB: D1Database };

/**
 * The keystone gap found by direct production inspection (2026-08-06):
 * tenant_finance_policy had zero rows for the live tenant until Tyler
 * inserted one by hand directly against the production database. Every downstream
 * reader (src/api/rates.ts, src/ai/classify.ts) falls back to a default
 * when this row is missing, so the app never errors — it just silently runs
 * on defaults, which is how the gap went unnoticed. This page is the only
 * production path to create/edit that row; upsertTenantFinancePolicy()
 * (db/repos.ts) existed with no caller before this.
 *
 * Owner-gated, same as Budget & Rates and Setup & Config — this sets the
 * numbers those pages and the nightly rollup depend on.
 */
export const policySetupRouter = new Hono<{ Bindings: PolicySetupBindings; Variables: FinanceAuthVars }>();

function centsToDollarInput(cents: number): string {
  return (cents / 100).toFixed(2);
}

policySetupRouter.get("/", async (c) => {
  const { tenant_id, role, vocab } = readPageArgs(c);
  if (!canSee(role, "can_see_budget_rates")) {
    return c.html(
      <Page title="Company Policy" active="finConfig" role={role}>
        <Card>
          <div class="fin-empty" data-testid="denied">
            <div class="fin-empty-t">Not available for your role</div>
            <div class="fin-empty-s">Company financial policy is owner-only.</div>
          </div>
        </Card>
      </Page>,
      403,
    );
  }

  const db = c.env.DB;
  const existing = await getTenantFinancePolicy(db, tenant_id);
  const isFirstRun = !existing;
  // First-run pre-fill uses the platform default seed (config/finance/tenant-defaults.json)
  // — the same values Tyler used for the manual insert — rather than blank/zero.
  const view = existing ?? {
    tenant_id,
    equipment_engine_active: tenantDefaults.equipment_engine_active ? 1 : 0,
    materiality_threshold_cents: tenantDefaults.materiality_threshold_cents,
    restated_target_cents: tenantDefaults.restated_target_cents,
    black_friday_date: tenantDefaults.black_friday_date,
  };

  const notice = c.req.query("saved") === "1" ? "Saved." : c.req.query("error") ? `Error: ${c.req.query("error")}` : null;
  const basePath = c.req.path;

  return c.html(
    <Page title="Company Policy" active="finConfig" tenant={tenant_id || undefined} role={role} vocab={vocab}>
      {notice && (
        <div class="fin-note" data-testid="notice" style={notice.startsWith("Error") ? "border-left-color:var(--gw-rose)" : ""}>
          {notice}
        </div>
      )}
      {isFirstRun ? (
        <div class="fin-note" data-testid="first-run-notice">
          No company policy is set up yet. The values below are the platform's starting
          defaults — save to create your company's real row. Until this is saved, rate
          resolution and classification run on these same defaults silently, with nothing
          visibly wrong if they're not what you actually want.
        </div>
      ) : null}

      <Card title="Company Policy" sub="drives rate resolution, classification review, and the nightly recovery rollup">
        <form method="post" action={`${basePath}?tenant_id=${encodeURIComponent(tenant_id)}&role=${role}`}>
          <div style="margin-bottom:16px">
            <label style="display:flex;align-items:center;gap:8px;font-size:13px;font-weight:600">
              <input
                type="checkbox"
                name="equipment_engine_active"
                data-testid="input-equipment-engine-active"
                checked={view.equipment_engine_active === 1}
              />
              Equipment engine active
            </label>
            <p class="fin-card-s" style="margin-top:4px">
              When on, machine cost is charged per machine hour instead of being smeared
              across labor hours. Must stay off if any labor rate profile still carries its
              own equipment component (CLAUDE.md's equipment double-count guard).
            </p>
          </div>

          <div style="margin-bottom:16px">
            <label style="display:block;font-size:13px;font-weight:600;margin-bottom:4px">
              Materiality threshold
            </label>
            <input
              type="text"
              name="materiality_threshold_cents"
              data-testid="input-materiality-threshold"
              value={centsToDollarInput(view.materiality_threshold_cents)}
              inputmode="decimal"
              style="width:160px;padding:8px 10px;border:1px solid var(--gw-line-strong);border-radius:var(--gw-r-sm);font-size:13px"
            />
            <p class="fin-card-s" style="margin-top:4px">
              Dollars. A transaction above this amount is always forced to review,
              regardless of what the classifier's confident about.
            </p>
          </div>

          <div style="margin-bottom:16px">
            <label style="display:block;font-size:13px;font-weight:600;margin-bottom:4px">
              Restated overhead target
            </label>
            <input
              type="text"
              name="restated_target_cents"
              data-testid="input-restated-target"
              value={centsToDollarInput(view.restated_target_cents)}
              inputmode="decimal"
              style="width:160px;padding:8px 10px;border:1px solid var(--gw-line-strong);border-radius:var(--gw-r-sm);font-size:13px"
            />
            <p class="fin-card-s" style="margin-top:4px">
              Dollars. The annual fixed-cost figure the recovery snapshot measures progress
              against. Zero until you have a real number to put here.
            </p>
          </div>

          <div style="margin-bottom:20px">
            <label style="display:block;font-size:13px;font-weight:600;margin-bottom:4px">
              Target recovery date (optional)
            </label>
            <input
              type="date"
              name="black_friday_date"
              data-testid="input-black-friday-date"
              value={view.black_friday_date ?? ""}
              style="padding:8px 10px;border:1px solid var(--gw-line-strong);border-radius:var(--gw-r-sm);font-size:13px"
            />
          </div>

          <button
            type="submit"
            data-testid="save-policy"
            style="background:var(--gw-pine);color:#fff;border:0;border-radius:var(--gw-r-sm);padding:9px 18px;font-size:13px;font-weight:700;cursor:pointer"
          >
            {isFirstRun ? "Create company policy" : "Save"}
          </button>
        </form>

        {!isFirstRun ? (
          <p class="fin-card-s" data-testid="current-materiality" style="margin-top:16px">
            Current materiality threshold: <strong>{money(view.materiality_threshold_cents)}</strong>
          </p>
        ) : null}

        <Why
          what="The company-wide settings every rate resolution, classification review, and the nightly recovery rollup reads."
          source="Set here, once per company. Not derived from anything else — this is the one place these numbers come from."
          matters="Missing this row doesn't error anywhere downstream, it just quietly runs on platform defaults instead of your real numbers."
          moves="Editing and saving here. Nothing else in Finance OS writes to this row."
        />
      </Card>
    </Page>,
  );
});

function parseDollarField(raw: FormDataEntryValue | undefined): number | null {
  const s = String(raw ?? "").trim();
  if (!s) return null;
  const cents = parseMoneyToCents(s);
  return Number.isFinite(cents) ? cents : null;
}

policySetupRouter.post("/", async (c) => {
  const { tenant_id, role } = readPageArgs(c);
  const basePath = c.req.path;
  if (!canSee(role, "can_see_budget_rates")) return c.text("owner role required", 403);

  const form = await c.req.parseBody();
  const qs = `tenant_id=${encodeURIComponent(tenant_id)}&role=${role}`;

  const materialityCents = parseDollarField(form.materiality_threshold_cents as string);
  const restatedCents = parseDollarField(form.restated_target_cents as string);
  const blackFridayRaw = String(form.black_friday_date ?? "").trim();
  const blackFridayDate = blackFridayRaw || null;

  if (materialityCents === null || materialityCents < 0) {
    return c.redirect(`${basePath}?${qs}&error=${encodeURIComponent("materiality threshold must be a non-negative amount")}`);
  }
  if (restatedCents === null || restatedCents < 0) {
    return c.redirect(`${basePath}?${qs}&error=${encodeURIComponent("restated target must be a non-negative amount")}`);
  }
  if (blackFridayDate !== null && !/^\d{4}-\d{2}-\d{2}$/.test(blackFridayDate)) {
    return c.redirect(`${basePath}?${qs}&error=${encodeURIComponent("target recovery date must be YYYY-MM-DD")}`);
  }

  const policy: TenantFinancePolicy = {
    company_id: tenant_id,
    equipment_engine_active: form.equipment_engine_active ? 1 : 0,
    materiality_threshold_cents: materialityCents as never,
    restated_target_cents: restatedCents as never,
    black_friday_date: blackFridayDate,
    created_at: "",
    updated_at: "",
  };

  await upsertTenantFinancePolicy(c.env.DB, policy);
  return c.redirect(`${basePath}?${qs}&saved=1`);
});
