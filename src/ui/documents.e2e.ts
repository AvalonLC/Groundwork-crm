import { test, expect } from "@playwright/test";
import { resetFinanceDb, exec } from "./test-seed";

const TENANT = "t-e2e-documents";

test.beforeEach(async ({ request }) => {
  await resetFinanceDb(request, TENANT);
});

test("UDO-01 with nothing uploaded yet, points at Upload Documents", async ({ page }) => {
  await page.goto(`/documents?tenant_id=${TENANT}&role=owner`);
  await expect(page.getByTestId("documents-list")).toContainText("No receipts yet");
});

test("UDO-02 seeded receipts render with vendor/amount/date and correct review status", async ({ page, request }) => {
  await exec(request,
    `INSERT INTO action_item (id, tenant_id, verb, owner_id, sla_due, confidence, status) VALUES (?,?,?,?,?,?, 'open')`,
    ["ai-fix-1", TENANT, "fix", "office-user-1", "2026-08-10", "low"]);
  await exec(request,
    `INSERT INTO receipt (id, tenant_id, job_id, r2_key, content_hash, vendor, amount_cents, receipt_date, field_confidence, action_item_id) VALUES (?,?,?,?,?,?,?,?,?,?)`,
    ["receipt-complete", TENANT, null, "receipts/x/1", "hash1", "Acme Supply", 4599, "2026-07-01", JSON.stringify({ vendor: "high", amount_cents: "high", receipt_date: "high" }), null]);
  await exec(request,
    `INSERT INTO receipt (id, tenant_id, job_id, r2_key, content_hash, vendor, amount_cents, receipt_date, field_confidence, action_item_id) VALUES (?,?,?,?,?,?,?,?,?,?)`,
    ["receipt-flagged", TENANT, null, "receipts/x/2", "hash2", null, 2000, "2026-07-03", JSON.stringify({ vendor: "low", amount_cents: "high", receipt_date: "high" }), "ai-fix-1"]);

  await page.goto(`/documents?tenant_id=${TENANT}&role=owner`);
  await expect(page.getByTestId("receipt-count")).toHaveText("2");
  await expect(page.getByTestId("needs-review-count")).toHaveText("1");
  await expect(page.getByTestId("receipt-receipt-complete")).toContainText("Acme Supply");
  await expect(page.getByTestId("receipt-receipt-complete")).toContainText("complete");
  await expect(page.getByTestId("receipt-receipt-flagged")).toContainText("needs review");
});

test("UDO-03 a receipt uploaded through Upload Documents shows up here end to end", async ({ page }) => {
  await page.goto(`/upload?tenant_id=${TENANT}&role=owner`);
  await page.getByTestId("receipt-file-input").setInputFiles({
    name: "e2e-doc.jpg", mimeType: "image/jpeg", buffer: Buffer.from("documents-e2e-bytes"),
  });
  await page.getByTestId("receipt-vendor-input").fill("Cross-Page Vendor");
  await page.getByTestId("receipt-amount-input").fill("12.34");
  await page.getByTestId("receipt-submit").click();
  await expect(page.getByTestId("receipt-result")).toBeVisible();

  await page.goto(`/documents?tenant_id=${TENANT}&role=owner`);
  await expect(page.getByTestId("documents-list")).toContainText("Cross-Page Vendor");
});

test("UDO-04 crew and crew_lead are denied", async ({ page }) => {
  for (const role of ["crew", "crew_lead"]) {
    const res = await page.goto(`/documents?tenant_id=${TENANT}&role=${role}`);
    expect(res?.status()).toBe(403);
    await expect(page.getByTestId("denied")).toBeVisible();
  }
});
