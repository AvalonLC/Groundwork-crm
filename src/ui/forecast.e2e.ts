import { test, expect } from "@playwright/test";
import { resetFinanceDb, exec } from "./test-seed";

const TENANT = "t-e2e-forecast";

test.beforeEach(async ({ request }) => {
  await resetFinanceDb(request, TENANT);
});

test("UF-01 with no rollup yet, says so plainly instead of showing a fabricated date", async ({ page }) => {
  await page.goto(`/forecast?tenant_id=${TENANT}&role=owner`);
  await expect(page.getByTestId("projected-date")).toHaveText("no projection yet");
});

test("UF-02 with a snapshot, shows the real projected date and confidence window", async ({ page, request }) => {
  await exec(request,
    `INSERT INTO recovery_snapshot (tenant_id, as_of, restated_target_cents, recovered_to_date_cents, hours_per_week_hundredths, blended_overhead_rate, weekly_recovery_cents, pct_recovered_millionths, projected_black_friday, confidence_days) VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [TENANT, "2026-08-03", 59100000, 38190000, 38000, 274300, 1042340, 646193, "2026-12-21", 13]);

  await page.goto(`/forecast?tenant_id=${TENANT}&role=owner`);
  await expect(page.getByTestId("projected-date")).toHaveText("2026-12-21");
  await expect(page.getByTestId("forecast-hero")).toContainText("13 days");
  await expect(page.getByTestId("forecast-hero")).toContainText("64.6%");
});

test("UF-03 the scope note is always visible — a fuller forecast is not being claimed", async ({ page }) => {
  await page.goto(`/forecast?tenant_id=${TENANT}&role=owner`);
  await expect(page.getByTestId("forecast-scope-note")).toBeVisible();
});

test("UF-04 crew and crew_lead are denied", async ({ page }) => {
  for (const role of ["crew", "crew_lead"]) {
    const res = await page.goto(`/forecast?tenant_id=${TENANT}&role=${role}`);
    expect(res?.status()).toBe(403);
    await expect(page.getByTestId("denied")).toBeVisible();
  }
});
