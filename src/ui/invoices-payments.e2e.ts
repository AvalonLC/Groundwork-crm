import { test, expect } from "@playwright/test";
import { resetCrmDb, execCrm } from "./test-seed";

const TENANT = "t-e2e-invpay";

test.beforeEach(async ({ request }) => {
  await resetCrmDb(request, TENANT);
});

test("UIP-01 shows invoices of every status, not just open ones", async ({ page, request }) => {
  await execCrm(request,
    `INSERT INTO invoices (id, company_id, invoice_number, client_name, status, total, total_cents, balance_due, balance_due_cents, due_date) VALUES (?,?,?,?,?,?,?,?,?,?)`,
    ["inv-open", TENANT, "INV-1", "Open Co", "sent", 500, 50000, 500, 50000, "2026-09-01"]);
  await execCrm(request,
    `INSERT INTO invoices (id, company_id, invoice_number, client_name, status, total, total_cents, balance_due, balance_due_cents, due_date) VALUES (?,?,?,?,?,?,?,?,?,?)`,
    ["inv-paid", TENANT, "INV-2", "Paid Co", "paid", 900, 90000, 0, 0, "2026-07-01"]);

  await page.goto(`/invoices-payments?tenant_id=${TENANT}&role=owner`);
  await expect(page.getByTestId("invoice-inv-open")).toBeVisible();
  await expect(page.getByTestId("invoice-inv-paid")).toBeVisible();
});

test("UIP-02 payments show their linked invoice number", async ({ page, request }) => {
  // total/balance_due (float) are deliberately wrong here — only the _cents
  // columns are correct, proving this page reads cents (Stage 3a cutover).
  await execCrm(request,
    `INSERT INTO invoices (id, company_id, invoice_number, client_name, status, total, total_cents, balance_due, balance_due_cents, due_date) VALUES (?,?,?,?,?,?,?,?,?,?)`,
    ["inv-1", TENANT, "INV-9001", "Client A", "partial", 999999, 100000, 999999, 40000, "2026-09-01"]);
  await execCrm(request,
    `INSERT INTO payments (id, company_id, invoice_id, amount, amount_cents, payment_method, status, created_at) VALUES (?,?,?,?,?,?,?,?)`,
    ["pay-1", TENANT, "inv-1", 999999, 60000, "card", "succeeded", "2026-08-01T00:00:00Z"]);

  await page.goto(`/invoices-payments?tenant_id=${TENANT}&role=owner`);
  await expect(page.getByTestId("payment-pay-1")).toContainText("INV-9001");
  await expect(page.getByTestId("payment-pay-1")).toContainText("600.00");
  await expect(page.getByTestId("invoice-inv-1")).toContainText("1,000.00");
  await expect(page.getByTestId("invoice-inv-1")).toContainText("400.00");
});

test("UIP-03 crew and crew_lead are denied", async ({ page }) => {
  for (const role of ["crew", "crew_lead"]) {
    const res = await page.goto(`/invoices-payments?tenant_id=${TENANT}&role=${role}`);
    expect(res?.status()).toBe(403);
    await expect(page.getByTestId("denied")).toBeVisible();
  }
});
