import { test, expect } from "@playwright/test";
import { resetCrmDb, execCrm } from "./test-seed";

const TENANT = "t-e2e-ledger";

test.beforeEach(async ({ request }) => {
  await resetCrmDb(request, TENANT);
});

test("ULG-01 merges invoices and payments into one sorted feed", async ({ page, request }) => {
  // total/amount (float) are deliberately wrong — only the _cents columns
  // are correct, proving this page reads cents (Stage 3a cutover).
  await execCrm(request,
    `INSERT INTO invoices (id, company_id, invoice_number, client_name, status, total, total_cents, balance_due, balance_due_cents, due_date, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    ["inv-1", TENANT, "INV-1", "Client A", "sent", 999999, 50000, 999999, 50000, "2026-09-01", "2026-08-01T00:00:00Z"]);
  await execCrm(request,
    `INSERT INTO payments (id, company_id, invoice_id, amount, amount_cents, payment_method, status, created_at) VALUES (?,?,?,?,?,?,?,?)`,
    ["pay-1", TENANT, "inv-1", 999999, 20000, "card", "succeeded", "2026-08-02T00:00:00Z"]);

  await page.goto(`/ledger?tenant_id=${TENANT}&role=owner`);
  await expect(page.getByTestId("event-count")).toHaveText("2");
  await expect(page.getByTestId("total-in")).toContainText("200.00");
  await expect(page.getByTestId("ledger-list")).toContainText("INV-1");
  await expect(page.getByTestId("ledger-list")).toContainText("500.00");
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
