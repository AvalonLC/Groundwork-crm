import { test, expect, type Page } from "@playwright/test";

/**
 * Real-browser coverage for the finance-spa-integration change: Finance OS
 * nav (/finance/*) must behave exactly like every other in-SPA nav click —
 * content swaps into #view in place, sidebar stays, no reload — instead of
 * the old standalone-page-per-route behavior.
 *
 * Runs against the REAL app (src/index.tsx, built + served via
 * `wrangler pages dev`, see playwright.spa.config.ts) with a real session
 * cookie, not src/ui/dev-server.ts (no SPA shell, no auth — that's what the
 * other 16 *.e2e.ts files use, and they deliberately stay untouched by this
 * file). Logs in as the seeded `tyler`/`avalon` admin rep from
 * migrations/0002_seed_data.sql (finance role "owner" per
 * config/finance/role-map.json) via the same /api/auth/login endpoint the
 * real login screen posts to — no signup, no rate limit, no cleanup needed.
 */

const REP_LOGIN = { repId: "tyler", pin: "1111", companyId: "avalon" };

async function loginAndGoHome(page: Page) {
  const res = await page.request.post("/api/auth/login", { data: REP_LOGIN });
  expect(res.ok(), await res.text()).toBeTruthy();
  await page.goto("/");
  await page.waitForSelector("#sidebar", { state: "visible" });
  // Bootstrap (REPS hydration, canViewTab wiring, _initialRoute()'s own
  // show('gwDashboard') call) runs async after DOMContentLoaded and finishes
  // on its own timeline — the sidebar markup above is server-rendered and
  // present from first paint regardless, so waiting on it alone isn't enough.
  // A real user's first click naturally lands after bootstrap settles, but a
  // page.evaluate() calling financeFetch() directly does not — it can win
  // the race and get its own #view injection clobbered a moment later when
  // _initialRoute()'s deferred show() finally fires. Waiting for the
  // Dashboard's own real content (not just the static sidebar) guarantees
  // that initial show() has already happened before a test proceeds.
  await page.waitForSelector('.nav-item[data-view="gwFinancial"]');
  await page.waitForSelector("#view h1", { timeout: 15_000 });
}

test.describe("Finance OS SPA integration", () => {
  test.beforeEach(async ({ page }) => {
    await loginAndGoHome(page);
  });

  test("clicking Financial nav items swaps #view in place — no reload, sidebar stays, URL only gains a hash", async ({ page }) => {
    // A real navigation/reload tears down the JS context, which would clear
    // this marker — the strongest available signal that nothing reloaded.
    await page.evaluate(() => { (window as any).__gwNoReload = true; });

    await page.locator('.nav-item[data-view="gwFinancial"]').click();
    await page.locator('#gw-subtabs-gwFinancial button[data-tab="finControl"]').click();

    await expect(page).toHaveURL(/^http:\/\/localhost:3000\/#finControl$/);
    await expect(page.locator("#sidebar")).toBeVisible();
    await expect(page.locator("#view .fin-title")).toHaveText("Money Loop");
    expect(await page.evaluate(() => (window as any).__gwNoReload)).toBe(true);

    // second nav click also swaps in place, not just the first
    await page.locator('#gw-subtabs-gwFinancial button[data-tab="finQueue"]').click();
    await expect(page).toHaveURL(/^http:\/\/localhost:3000\/#finQueue$/);
    await expect(page.locator("#view .fin-title")).toHaveText("Work Queue");
    await expect(page.locator("#sidebar")).toBeVisible();
    expect(await page.evaluate(() => (window as any).__gwNoReload)).toBe(true);

    // no green Finance OS top tab-strip — that's the old standalone-page chrome
    await expect(page.locator(".fin-topbar")).toHaveCount(0);
  });

  test("Setup & Config's save form submits via fetch-intercept, no reload", async ({ page }) => {
    await page.evaluate(() => { (window as any).__gwNoReload = true; });
    await page.locator('.nav-item[data-view="gwFinancial"]').click();
    await page.locator('#gw-subtabs-gwFinancial button[data-tab="finConfig"]').click();
    await expect(page).toHaveURL(/#finConfig$/);

    // tenant_defaults specifically: validateConfigShape treats it as "a flat
    // bag of primitives, JSON.parse succeeding is enough" (src/config/
    // finance-config-runtime.ts), so any valid JSON object round-trips
    // clean. NOT reading the pre-rendered textarea's own current value and
    // resubmitting it (as tried initially) — that trips a real, pre-existing,
    // unrelated bug: config-admin.tsx's textarea content is double
    // HTML-escaped (its own escapeHtml() plus Hono JSX's default escaping of
    // the {expression} child), so what a real browser reads back via
    // inputValue() contains literal `&quot;` text instead of `"` characters
    // and fails JSON.parse — logged in docs/PUNCHLIST.md, out of scope here.
    const textarea = page.locator('[data-testid="editor-tenant_defaults"]');
    const saveBtn = page.locator('[data-testid="save-tenant_defaults"]');
    await expect(textarea).toBeVisible();
    await textarea.fill(JSON.stringify({ spa_nav_test: true }));
    await saveBtn.click();

    await expect(page.locator('[data-testid="notice"]')).toHaveText("Saved.");
    expect(await page.evaluate(() => (window as any).__gwNoReload)).toBe(true);
    // still swapped into the SPA's own #view, not a standalone reload
    await expect(page.locator("#sidebar")).toBeVisible();
    await expect(page.locator(".fin-topbar")).toHaveCount(0);
  });

  test("a redirect-after-POST page (Company Policy) renders the saved result directly when fetched as a partial, no redirect chased", async ({ page }) => {
    // Company Policy isn't one of the 9 sidebar-level nav items (only
    // reachable today via an in-page link from Setup & Config, which is a
    // real <a href> and not yet itself SPA-intercepted — see PUNCHLIST.md).
    // Drives financeFetch() directly with its path: the exact mechanism a
    // rewired link would use, verifying config-admin.tsx/policy-setup.tsx's
    // partial-mode redirect fix (src/ui/policy-setup.tsx) actually works
    // end-to-end through the browser-side fetch-intercept plumbing.
    await page.evaluate(() => (window as any).financeFetch("/finance/policy", "finPolicyTest"));
    await page.waitForSelector('[data-testid="save-policy"]');

    await page.fill('[data-testid="input-materiality-threshold"]', "150.00");
    await page.fill('[data-testid="input-restated-target"]', "9000.00");
    await page.click('[data-testid="save-policy"]');

    await expect(page.locator('[data-testid="notice"]')).toHaveText("Saved.");
    await expect(page.locator('[data-testid="current-materiality"]')).toContainText("$150.00");
    // Confirms no redirect was followed to a fresh full-page load — the SPA
    // shell (sidebar) is still the one that was already on screen.
    await expect(page.locator("#sidebar")).toBeVisible();
    await expect(page.locator(".fin-topbar")).toHaveCount(0);
  });

  test("Upload Documents' multipart ingest form submits via fetch-intercept", async ({ page }) => {
    await page.evaluate(() => (window as any).financeFetch("/finance/upload", "finUploadTest"));
    await page.waitForSelector('[data-testid="ingest-file-input"]');

    await page.setInputFiles('[data-testid="ingest-file-input"]', {
      name: "test-export.csv",
      mimeType: "text/csv",
      buffer: Buffer.from("account,amount\nTest Account,100.00\n"),
    });
    await page.click('[data-testid="ingest-submit"]');

    // Present whether the format is recognized or not — either way confirms
    // the multipart POST round-tripped through fetch() and got injected,
    // not a real form-submit page reload.
    await expect(page.locator('[data-testid="ingest-result"]')).toBeVisible();
    await expect(page.locator("#sidebar")).toBeVisible();
    await expect(page.locator(".fin-topbar")).toHaveCount(0);
  });

  test("a direct/bookmarked load of a /finance/* URL still renders the full standalone page", async ({ page }) => {
    await page.goto("/finance/money-loop");
    await expect(page.locator(".fin-topbar")).toBeVisible();
    await expect(page.locator(".fin-toptab", { hasText: "Money Loop" })).toBeVisible();
    // Not the SPA shell — this is the standalone document, no sidebar/#view.
    await expect(page.locator("#sidebar")).toHaveCount(0);
    await expect(page.locator("#view")).toHaveCount(0);
  });
});
