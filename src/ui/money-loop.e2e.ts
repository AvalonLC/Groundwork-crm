import { test, expect } from "@playwright/test";
import { resetFinanceDb, exec } from "./test-seed";

const TENANT = "t-e2e-moneyloop";

test.beforeEach(async ({ request }) => {
  await resetFinanceDb(request, TENANT);
  await exec(request,
    `INSERT INTO recovery_snapshot (company_id, as_of, restated_target_cents, recovered_to_date_cents, hours_per_week_hundredths, blended_overhead_rate, weekly_recovery_cents, pct_recovered_millionths, projected_black_friday, confidence_days) VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [TENANT, "2026-08-03", 59100000, 38190000, 38000, 274300, 1042340, 646193, "2026-12-21", 13]);
  await exec(request,
    `INSERT INTO action_item (id, company_id, verb, owner_id, sla_due, amount_cents, confidence, status) VALUES (?,?,?,?,?,?,?, 'open')`,
    ["ai-e2e-1", TENANT, "collect", "user-1", "2026-08-10", 5000, "high"]);
  await exec(request,
    `INSERT INTO action_item (id, company_id, verb, owner_id, sla_due, amount_cents, confidence, status) VALUES (?,?,?,?,?,?,?, 'open')`,
    ["ai-e2e-2", TENANT, "bill", "user-2", "2026-08-11", 8000, "medium"]);
});

test("UM-01 runway hero shows the recovery snapshot percentage", async ({ page }) => {
  await page.goto(`/money-loop?tenant_id=${TENANT}&role=owner&vocab=simple`);
  await expect(page.getByTestId("pct-recovered")).toHaveText("64.6%");
});

test("UM-02 five verb tiles render with correct counts", async ({ page }) => {
  await page.goto(`/money-loop?tenant_id=${TENANT}&role=owner`);
  for (const verb of ["collect", "bill", "pay", "fix", "decide"]) {
    await expect(page.getByTestId(`verb-tile-${verb}`)).toBeVisible();
  }
  await expect(page.getByTestId("verb-count-collect")).toHaveText("1");
  await expect(page.getByTestId("verb-count-bill")).toHaveText("1");
  await expect(page.getByTestId("verb-count-pay")).toHaveText("0");
});

test("UM-03 verb lanes list the actual open action items (depth 2)", async ({ page }) => {
  await page.goto(`/money-loop?tenant_id=${TENANT}&role=owner`);
  await expect(page.getByTestId("action-ai-e2e-1")).toBeVisible();
  await expect(page.getByTestId("action-ai-e2e-2")).toBeVisible();
});

test("UM-04 simple vocabulary mode shows no raw accounting words for verb labels", async ({ page }) => {
  await page.goto(`/money-loop?tenant_id=${TENANT}&role=owner&vocab=simple`);
  const text = await page.getByTestId("verb-tile-collect").innerText();
  expect(text).toMatch(/money to collect/i);
});

test("UM-05 owner sees a setup banner when no company policy row exists yet", async ({ page }) => {
  await page.goto(`/money-loop?tenant_id=${TENANT}&role=owner`);
  await expect(page.getByTestId("policy-setup-banner")).toBeVisible();
  await page.getByTestId("policy-setup-banner").getByRole("link").click();
  await expect(page).toHaveURL(/\/policy$/);
});

test("UM-06 banner disappears once a company policy row exists", async ({ page, request }) => {
  await exec(request,
    `INSERT INTO tenant_finance_policy (company_id, equipment_engine_active, materiality_threshold_cents, restated_target_cents, black_friday_date) VALUES (?,?,?,?,?)`,
    [TENANT, 0, 50000, 0, null]);
  await page.goto(`/money-loop?tenant_id=${TENANT}&role=owner`);
  await expect(page.getByTestId("policy-setup-banner")).toHaveCount(0);
});

test("UM-07 non-owner roles never see the setup banner", async ({ page }) => {
  await page.goto(`/money-loop?tenant_id=${TENANT}&role=crew`);
  await expect(page.getByTestId("policy-setup-banner")).toHaveCount(0);
});

// Fix plan item 6, hardening step 3: an in-app "last successful run"
// freshness signal for the nightly rollup, independent of whether anyone
// is watching GitHub Actions or email. See docs/RUNBOOK-finance-cron.md.
test("UM-08 a stale rollup (the beforeEach's 2026-08-03 snapshot) surfaces a visible warning", async ({ page }) => {
  await page.goto(`/money-loop?tenant_id=${TENANT}&role=owner`);
  const warning = page.getByTestId("rollup-stale-warning");
  await expect(warning).toBeVisible();
  await expect(warning).toContainText("2026-08-03");
  await expect(warning).toContainText("days ago");
  await expect(page.getByTestId("rollup-last-updated")).toHaveCount(0);
});

test("UM-09 a fresh rollup (as_of today) shows a plain last-updated note, no warning", async ({ page, request }) => {
  const today = new Date().toISOString().slice(0, 10);
  await exec(request,
    `INSERT INTO recovery_snapshot (company_id, as_of, restated_target_cents, recovered_to_date_cents, hours_per_week_hundredths, blended_overhead_rate, weekly_recovery_cents, pct_recovered_millionths, projected_black_friday, confidence_days) VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [TENANT, today, 59100000, 38190000, 38000, 274300, 1042340, 646193, "2026-12-21", 13]);
  await page.goto(`/money-loop?tenant_id=${TENANT}&role=owner`);
  const note = page.getByTestId("rollup-last-updated");
  await expect(note).toBeVisible();
  await expect(note).toContainText(today);
  await expect(page.getByTestId("rollup-stale-warning")).toHaveCount(0);
});
