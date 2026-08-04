import { test, expect } from "@playwright/test";
import { resetFinanceDb, exec } from "./test-seed";

const TENANT = "t-e2e-recovery";

test.beforeEach(async ({ request }) => {
  await resetFinanceDb(request, TENANT);
  await exec(request,
    `INSERT INTO recovery_snapshot (tenant_id, as_of, restated_target_cents, recovered_to_date_cents, hours_per_week_hundredths, blended_overhead_rate, weekly_recovery_cents, pct_recovered_millionths, projected_black_friday, confidence_days) VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [TENANT, "2026-08-03", 59100000, 38190000, 38000, 274300, 1042340, 646193, "2026-12-21", 13]);
  await exec(request,
    `INSERT INTO overhead_allocation (tenant_id, division, as_of, sellable_hours, allocated_overhead_cents, weighted_labor_rate_cents, overhead_rate, absorbed_cost_cents, target_margin, required_bill_rate_cents) VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [TENANT, "maintenance", "2026-08-03", 8110, 19640000, 3840, 242170, 6262, 4000, 10437]);
});

test("UR-01 thermometer shows pct_recovered and the projected date with confidence window", async ({ page }) => {
  await page.goto(`/recovery?tenant_id=${TENANT}&role=owner`);
  await expect(page.getByTestId("pct-recovered")).toContainText("64.6%");
  const dateText = await page.getByTestId("projected-date").innerText();
  expect(dateText).toContain("2026-12-21");
  expect(dateText).toMatch(/\+\/- 13 days/);
});

test("UR-02 division-dates section is honest about the gap, not fabricated", async ({ page }) => {
  await page.goto(`/recovery?tenant_id=${TENANT}&role=owner`);
  await expect(page.getByTestId("division-dates-note")).toContainText("not yet computed upstream");
});

test("UR-03 absorption table shows division absorbed cost and required bill rate", async ({ page }) => {
  await page.goto(`/recovery?tenant_id=${TENANT}&role=owner`);
  await expect(page.getByTestId("absorbed-maintenance")).toHaveText("62.62");
  await expect(page.getByTestId("required-bill-rate-maintenance")).toHaveText("104.37");
});

test("UR-04 crew role is denied — recovery numbers never reach that role", async ({ page }) => {
  const res = await page.goto(`/recovery?tenant_id=${TENANT}&role=crew`);
  expect(res?.status()).toBe(403);
  await expect(page.getByTestId("denied")).toBeVisible();
});
