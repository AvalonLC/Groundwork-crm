import { test, expect } from "@playwright/test";
import { resetFinanceDb, exec } from "./test-seed";

const TENANT = "t-e2e-onboarding";

test.beforeEach(async ({ request }) => {
  await resetFinanceDb(request, TENANT);
});

test("UOB2-01 with nothing uploaded and no policy, all three domains show missing", async ({ page }) => {
  await page.goto(`/onboarding?tenant_id=${TENANT}&role=owner`);
  await expect(page.getByTestId("gap-row-0")).toContainText("Tenant Policy");
  await expect(page.getByTestId("gap-state-0")).toContainText("missing");
  await expect(page.getByTestId("gap-row-1")).toContainText("Financial Exports");
  await expect(page.getByTestId("gap-state-1")).toContainText("missing");
  await expect(page.getByTestId("gap-row-2")).toContainText("Receipts");
  await expect(page.getByTestId("gap-state-2")).toContainText("missing");
});

test("UOB2-02 tenant policy present shows good to go", async ({ page, request }) => {
  await exec(request,
    `INSERT INTO tenant_finance_policy (tenant_id, equipment_engine_active, materiality_threshold_cents, restated_target_cents, black_friday_date) VALUES (?,?,?,?,?)`,
    [TENANT, 0, 50000, 0, null]);
  await page.goto(`/onboarding?tenant_id=${TENANT}&role=owner`);
  await expect(page.getByTestId("gap-state-0")).toContainText("good");
});

test("UOB2-03 a mixed multi-file drop classifies each file and updates the gap report", async ({ page }) => {
  await page.goto(`/onboarding?tenant_id=${TENANT}&role=owner`);

  await page.getByTestId("onboarding-file-input").setInputFiles([
    { name: "class-pnl.csv", mimeType: "text/csv", buffer: Buffer.from("Class,Account,Total\nSome New Division,Fuel,500.00") },
    { name: "mystery.xyz", mimeType: "application/octet-stream", buffer: Buffer.from("not a known format") },
    { name: "receipt.jpg", mimeType: "image/jpeg", buffer: Buffer.from("fake-receipt-bytes-onboarding") },
  ]);
  await page.getByTestId("onboarding-submit").click();

  await expect(page.getByTestId("onboarding-file-results")).toBeVisible();
  await expect(page.getByTestId("file-result-0")).toContainText("class-pnl.csv");
  await expect(page.getByTestId("file-result-0")).toContainText("P&L");
  await expect(page.getByTestId("file-status-0")).toContainText("needs review");

  await expect(page.getByTestId("file-result-1")).toContainText("mystery.xyz");
  await expect(page.getByTestId("file-status-1")).toContainText("unrecognized");

  await expect(page.getByTestId("file-result-2")).toContainText("receipt.jpg");
  await expect(page.getByTestId("file-status-2")).toContainText("needs review");

  // Financial Exports and Receipts domains both now have data, but with a
  // low-confidence signal — "needs review," never rounded up to "good."
  await expect(page.getByTestId("gap-state-1")).toContainText("needs review");
  await expect(page.getByTestId("gap-state-2")).toContainText("needs review");
});

test("UOB2-04 a clean financial export (no unmapped divisions) shows good to go, not fabricated", async ({ page }) => {
  await page.goto(`/onboarding?tenant_id=${TENANT}&role=owner`);
  await page.getByTestId("onboarding-file-input").setInputFiles([
    { name: "pnl.csv", mimeType: "text/csv", buffer: Buffer.from("Account,Total\nFuel,500.00") },
  ]);
  await page.getByTestId("onboarding-submit").click();
  await expect(page.getByTestId("file-status-0")).toContainText("ok");
  await expect(page.getByTestId("gap-state-1")).toContainText("good");
});

test("UOB2-05 crew and crew_lead are denied", async ({ page }) => {
  for (const role of ["crew", "crew_lead"]) {
    const res = await page.goto(`/onboarding?tenant_id=${TENANT}&role=${role}`);
    expect(res?.status()).toBe(403);
    await expect(page.getByTestId("denied")).toBeVisible();
  }
});

test("UOB2-06 the Setup & Config page links to Financial Setup", async ({ page }) => {
  await page.goto(`/config?tenant_id=${TENANT}&role=owner`);
  await expect(page.getByTestId("onboarding-link")).toBeVisible();
  await page.getByTestId("onboarding-link").click();
  await expect(page).toHaveURL(/\/onboarding$/);
});
