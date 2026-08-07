import { test, expect } from "@playwright/test";
import { resetCrmDb, execCrm } from "./test-seed";

const TENANT = "t-e2e-invpay";

test.beforeEach(async ({ request }) => {
  await resetCrmDb(request, TENANT);
});

test("UIP-01 shows invoices of every status, not just open ones", async ({ page, request }) => {
  await execCrm(request,
    `INSERT INTO invoices (id, company_id, invoice_number, client_name, status, total, balance_due, due_date) VALUES (?,?,?,?,?,?,?,?)`,
    ["inv-open", TENANT, "INV-1", "Open Co", "sent", 500, 500, "2026-09-01"]);
  await execCrm(request,
    `INSERT INTO invoices (id, company_id, invoice_number, client_name, status, total, balance_due, due_date) VALUES (?,?,?,?,?,?,?,?)`,
    ["inv-paid", TENANT, "INV-2", "Paid Co", "paid", 900, 0, "2026-07-01"]);

  await page.goto(`/invoices-payments?tenant_id=${TENANT}&role=owner`);
  await expect(page.getByTestId("invoice-inv-open")).toBeVisible();
  await expect(page.getByTestId("invoice-inv-paid")).toBeVisible();
});

test("UIP-02 payments show their linked invoice number", async ({ page, request }) => {
  await execCrm(request,
    `INSERT INTO invoices (id, company_id, invoice_number, client_name, status, total, balance_due, due_date) VALUES (?,?,?,?,?,?,?,?)`,
    ["inv-1", TENANT, "INV-9001", "Client A", "partial", 1000, 400, "2026-09-01"]);
  await execCrm(request,
    `INSERT INTO payments (id, company_id, invoice_id, amount, payment_method, status, created_at) VALUES (?,?,?,?,?,?,?)`,
    ["pay-1", TENANT, "inv-1", 600, "card", "succeeded", "2026-08-01T00:00:00Z"]);

  await page.goto(`/invoices-payments?tenant_id=${TENANT}&role=owner`);
  await expect(page.getByTestId("payment-pay-1")).toContainText("INV-9001");
  await expect(page.getByTestId("payment-pay-1")).toContainText("600.00");
});

test("UIP-03 crew and crew_lead are denied", async ({ page }) => {
  for (const role of ["crew", "crew_lead"]) {
    const res = await page.goto(`/invoices-payments?tenant_id=${TENANT}&role=${role}`);
    expect(res?.status()).toBe(403);
    await expect(page.getByTestId("denied")).toBeVisible();
  }
});
