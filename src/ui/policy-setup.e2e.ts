import { test, expect } from "@playwright/test";
import { resetFinanceDb } from "./test-seed";

const TENANT = "t-e2e-policy-setup";

test.beforeEach(async ({ request }) => {
  await resetFinanceDb(request, TENANT);
});

test("UP-01 first run pre-fills from the platform defaults and says so", async ({ page }) => {
  await page.goto(`/policy?tenant_id=${TENANT}&role=owner`);
  await expect(page.getByTestId("first-run-notice")).toBeVisible();
  await expect(page.getByTestId("input-equipment-engine-active")).not.toBeChecked();
  await expect(page.getByTestId("input-materiality-threshold")).toHaveValue("500.00");
  await expect(page.getByTestId("input-restated-target")).toHaveValue("0.00");
  await expect(page.getByTestId("save-policy")).toHaveText("Create company policy");
});

test("UP-02 non-owner roles are denied", async ({ page }) => {
  for (const role of ["crew", "crew_lead", "office"]) {
    const res = await page.goto(`/policy?tenant_id=${TENANT}&role=${role}`);
    expect(res?.status()).toBe(403);
    await expect(page.getByTestId("denied")).toBeVisible();
  }
});

test("UP-03 saving creates the row and the page reflects it on reload", async ({ page }) => {
  await page.goto(`/policy?tenant_id=${TENANT}&role=owner`);
  await page.getByTestId("input-equipment-engine-active").check();
  await page.getByTestId("input-materiality-threshold").fill("1234.56");
  await page.getByTestId("input-restated-target").fill("75000.00");
  await page.getByTestId("input-black-friday-date").fill("2026-12-25");
  await page.getByTestId("save-policy").click();

  await expect(page.getByTestId("notice")).toContainText("Saved");
  await expect(page.getByTestId("first-run-notice")).toHaveCount(0);
  await expect(page.getByTestId("input-equipment-engine-active")).toBeChecked();
  await expect(page.getByTestId("input-materiality-threshold")).toHaveValue("1234.56");
  await expect(page.getByTestId("input-restated-target")).toHaveValue("75000.00");
  await expect(page.getByTestId("input-black-friday-date")).toHaveValue("2026-12-25");
  await expect(page.getByTestId("current-materiality")).toContainText("$1,234.56");
  await expect(page.getByTestId("save-policy")).toHaveText("Save");
});

test("UP-04 negative or malformed amounts are rejected without writing", async ({ page }) => {
  await page.goto(`/policy?tenant_id=${TENANT}&role=owner`);
  await page.getByTestId("input-materiality-threshold").fill("-5.00");
  await page.getByTestId("save-policy").click();

  await expect(page.getByTestId("notice")).toContainText("Error");
  await expect(page.getByTestId("first-run-notice")).toBeVisible();
});

test("UP-05 the Setup & Config page links to Company Policy", async ({ page }) => {
  await page.goto(`/config?tenant_id=${TENANT}&role=owner`);
  await expect(page.getByTestId("policy-link")).toBeVisible();
  await page.getByTestId("policy-link").click();
  await expect(page).toHaveURL(/\/policy$/);
});
