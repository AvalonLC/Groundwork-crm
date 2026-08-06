import { test, expect } from "@playwright/test";
import { resetCrmDb, execCrm } from "./test-seed";

const TENANT = "t-e2e-collections";

test.beforeEach(async ({ request }) => {
  await resetCrmDb(request, TENANT);
});

test("UCO-01 owner sees open invoices, soonest due date first", async ({ page, request }) => {
  await execCrm(request,
    `INSERT INTO invoices (id, company_id, invoice_number, client_name, status, balance_due, due_date) VALUES (?,?,?,?,?,?,?)`,
    ["inv-1", TENANT, "INV-1001", "Acme Landscaping", "sent", 500.00, "2026-12-01"]);
  await execCrm(request,
    `INSERT INTO invoices (id, company_id, invoice_number, client_name, status, balance_due, due_date) VALUES (?,?,?,?,?,?,?)`,
    ["inv-2", TENANT, "INV-1002", "Beta Yards", "overdue", 250.00, "2026-07-01"]);

  await page.goto(`/collections?tenant_id=${TENANT}&role=owner`);
  await expect(page.getByTestId("total-owed")).toContainText("750.00");
  await expect(page.getByTestId("overdue-count")).toHaveText("1");
  await expect(page.getByTestId("invoice-inv-2")).toBeVisible();
  await expect(page.getByTestId("invoice-inv-1")).toBeVisible();
});

test("UCO-02 paid, void, and draft invoices are excluded", async ({ page, request }) => {
  await execCrm(request,
    `INSERT INTO invoices (id, company_id, invoice_number, client_name, status, balance_due, due_date) VALUES (?,?,?,?,?,?,?)`,
    ["inv-paid", TENANT, "INV-2001", "Paid Co", "paid", 0, "2026-07-01"]);
  await execCrm(request,
    `INSERT INTO invoices (id, company_id, invoice_number, client_name, status, balance_due, due_date) VALUES (?,?,?,?,?,?,?)`,
    ["inv-draft", TENANT, "INV-2002", "Draft Co", "draft", 900.00, "2026-07-01"]);
  await execCrm(request,
    `INSERT INTO invoices (id, company_id, invoice_number, client_name, status, balance_due, due_date) VALUES (?,?,?,?,?,?,?)`,
    ["inv-void", TENANT, "INV-2003", "Void Co", "void", 300.00, "2026-07-01"]);

  await page.goto(`/collections?tenant_id=${TENANT}&role=owner`);
  await expect(page.getByTestId("collections-list")).toContainText("Nothing open");
});

test("UCO-03 a company's invoices never leak into another company's view", async ({ page, request }) => {
  const OTHER = "t-e2e-collections-other";
  await resetCrmDb(request, OTHER);
  await execCrm(request,
    `INSERT INTO invoices (id, company_id, invoice_number, client_name, status, balance_due, due_date) VALUES (?,?,?,?,?,?,?)`,
    ["inv-other", OTHER, "INV-3001", "Other Co Client", "sent", 100.00, "2026-09-01"]);

  await page.goto(`/collections?tenant_id=${TENANT}&role=owner`);
  await expect(page.getByTestId("collections-list")).toContainText("Nothing open");
  await expect(page.getByTestId("invoice-inv-other")).toHaveCount(0);
});

test("UCO-04 crew and crew_lead are denied", async ({ page }) => {
  for (const role of ["crew", "crew_lead"]) {
    const res = await page.goto(`/collections?tenant_id=${TENANT}&role=${role}`);
    expect(res?.status()).toBe(403);
    await expect(page.getByTestId("denied")).toBeVisible();
  }
});
