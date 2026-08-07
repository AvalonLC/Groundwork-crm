import { test, expect } from "@playwright/test";
import { resetCrmDb, execCrm } from "./test-seed";

const TENANT = "t-e2e-ledger";

test.beforeEach(async ({ request }) => {
  await resetCrmDb(request, TENANT);
});

test("ULG-01 merges invoices and payments into one sorted feed", async ({ page, request }) => {
  await execCrm(request,
    `INSERT INTO invoices (id, company_id, invoice_number, client_name, status, total, balance_due, due_date, created_at) VALUES (?,?,?,?,?,?,?,?,?)`,
    ["inv-1", TENANT, "INV-1", "Client A", "sent", 500, 500, "2026-09-01", "2026-08-01T00:00:00Z"]);
  await execCrm(request,
    `INSERT INTO payments (id, company_id, invoice_id, amount, payment_method, status, created_at) VALUES (?,?,?,?,?,?,?)`,
    ["pay-1", TENANT, "inv-1", 200, "card", "succeeded", "2026-08-02T00:00:00Z"]);

  await page.goto(`/ledger?tenant_id=${TENANT}&role=owner`);
  await expect(page.getByTestId("event-count")).toHaveText("2");
  await expect(page.getByTestId("total-in")).toContainText("200.00");
  await expect(page.getByTestId("ledger-list")).toContainText("INV-1");
});

test("ULG-02 is honest about Deposits/Statements not being tracked server-side", async ({ page }) => {
  await page.goto(`/ledger?tenant_id=${TENANT}&role=owner`);
  await expect(page.getByTestId("deposits-statements-gap")).toBeVisible();
  await expect(page.getByTestId("deposits-statements-gap")).toContainText("Deposits");
  await expect(page.getByTestId("deposits-statements-gap")).toContainText("Statements");
});

test("ULG-03 crew and crew_lead are denied", async ({ page }) => {
  for (const role of ["crew", "crew_lead"]) {
    const res = await page.goto(`/ledger?tenant_id=${TENANT}&role=${role}`);
    expect(res?.status()).toBe(403);
    await expect(page.getByTestId("denied")).toBeVisible();
  }
});
