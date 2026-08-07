import { test, expect } from "@playwright/test";
import { resetFinanceDb, resetCrmDb } from "./test-seed";

const TENANT = "t-e2e-finance-nav";

test.beforeEach(async ({ request }) => {
  await resetFinanceDb(request, TENANT);
  await resetCrmDb(request, TENANT);
});

const TOP_LEVEL_ROUTES = [
  "/money-loop",
  "/queue",
  "/job-costing",
  "/budget",
  "/recovery",
  "/invoices-payments",
  "/ledger",
  "/documents",
];

test("UFN-01 all 8 top-level Financial routes resolve for an owner", async ({ request }) => {
  for (const route of TOP_LEVEL_ROUTES) {
    const res = await request.get(`${route}?tenant_id=${TENANT}&role=owner`);
    expect(res.status(), `${route} should resolve 200`).toBe(200);
  }
});

test("UFN-02 Setup & Config (the 9th, non-core item) also resolves", async ({ request }) => {
  const res = await request.get(`/config?tenant_id=${TENANT}&role=owner`);
  expect(res.status()).toBe(200);
});

test("UFN-03 Reconciliation and Forecast are reachable from Money Loop, not top-level", async ({ page }) => {
  await page.goto(`/money-loop?tenant_id=${TENANT}&role=owner`);
  const link = page.getByTestId("related-pages-link");
  await expect(link).toBeVisible();
  await expect(link).toContainText("Reconciliation");
  await expect(link).toContainText("Forecast");
});

test("UFN-04 Collections and Obligations are reachable from Work Queue, not top-level", async ({ page }) => {
  await page.goto(`/queue?tenant_id=${TENANT}&role=owner`);
  const link = page.getByTestId("related-pages-link");
  await expect(link).toBeVisible();
  await expect(link).toContainText("Collections");
  await expect(link).toContainText("Obligations");
});

test("UFN-05 the top tab-strip renders all 8 items plus Setup & Config, with the current page marked active", async ({ page }) => {
  await page.goto(`/money-loop?tenant_id=${TENANT}&role=owner`);
  for (const label of [
    "Money Loop", "Work Queue", "Job Costing", "Budget & Rates", "Overhead Recovery",
    "Invoices & Payments", "Ledger", "Documents", "Setup & Config",
  ]) {
    await expect(page.locator(".fin-toptab", { hasText: label })).toBeVisible();
  }
  await expect(page.locator(".fin-toptab.is-active")).toHaveText("Money Loop");
});

test("UFN-06 non-owner roles without can_see_recovery don't see the related-pages links", async ({ page }) => {
  await page.goto(`/money-loop?tenant_id=${TENANT}&role=crew`);
  await expect(page.getByTestId("related-pages-link")).toHaveCount(0);
});
