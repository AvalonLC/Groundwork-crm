import { test, expect } from "@playwright/test";
import { resetFinanceDb } from "./test-seed";

const TENANT = "t-e2e-upload";

test.beforeEach(async ({ request }) => {
  await resetFinanceDb(request, TENANT);
});

test("UD-01 owner sees both upload forms", async ({ page }) => {
  await page.goto(`/upload?tenant_id=${TENANT}&role=owner`);
  await expect(page.getByTestId("ingest-file-input")).toBeVisible();
  await expect(page.getByTestId("receipt-file-input")).toBeVisible();
});

test("UD-02 crew and crew_lead are denied", async ({ page }) => {
  for (const role of ["crew", "crew_lead"]) {
    const res = await page.goto(`/upload?tenant_id=${TENANT}&role=${role}`);
    expect(res?.status()).toBe(403);
    await expect(page.getByTestId("denied")).toBeVisible();
  }
});

test("UD-03 office role (not just owner) can access and upload", async ({ page }) => {
  await page.goto(`/upload?tenant_id=${TENANT}&role=office`);
  await expect(page.getByTestId("ingest-file-input")).toBeVisible();
});

test("UD-04 a recognized P&L export is detected and its lines shown, no review needed", async ({ page }) => {
  await page.goto(`/upload?tenant_id=${TENANT}&role=owner`);
  await page.getByTestId("ingest-file-input").setInputFiles({
    name: "pnl.csv", mimeType: "text/csv",
    buffer: Buffer.from("Account,Total\nFuel,500.00"),
  });
  await page.getByTestId("ingest-submit").click();

  await expect(page.getByTestId("ingest-source-label")).toContainText("P&L");
  await expect(page.getByTestId("ingest-line-0")).toBeVisible();
  await expect(page.getByTestId("ingest-line-0")).toContainText("500.00");
});

test("UD-05 an unrecognized export is flagged for review, not guessed at", async ({ page }) => {
  await page.goto(`/upload?tenant_id=${TENANT}&role=owner`);
  await page.getByTestId("ingest-file-input").setInputFiles({
    name: "mystery.csv", mimeType: "text/csv",
    buffer: Buffer.from("Foo,Bar\n1,2"),
  });
  await page.getByTestId("ingest-submit").click();

  await expect(page.getByTestId("ingest-unrecognized")).toBeVisible();
  await expect(page.getByTestId("ingest-review-count")).toContainText("1");
});

test("UD-06 an unmapped division on a class P&L is flagged for review, not resolved", async ({ page }) => {
  await page.goto(`/upload?tenant_id=${TENANT}&role=owner`);
  await page.getByTestId("ingest-file-input").setInputFiles({
    name: "class-pnl.csv", mimeType: "text/csv",
    buffer: Buffer.from("Class,Account,Total\nSome Totally New Division,Fuel,500.00"),
  });
  await page.getByTestId("ingest-submit").click();

  await expect(page.getByTestId("ingest-review-0")).toContainText("needs review");
  await expect(page.getByTestId("ingest-review-count")).toContainText("1");
});

test("UD-07 a receipt with every field filled in is stored with high confidence and no review", async ({ page }) => {
  await page.goto(`/upload?tenant_id=${TENANT}&role=owner`);
  await page.getByTestId("receipt-file-input").setInputFiles({
    name: "receipt1.jpg", mimeType: "image/jpeg",
    buffer: Buffer.from("fake-receipt-bytes-1"),
  });
  await page.getByTestId("receipt-vendor-input").fill("Acme Supply");
  await page.getByTestId("receipt-amount-input").fill("45.99");
  await page.getByTestId("receipt-date-input").fill("2026-07-01");
  await page.getByTestId("receipt-submit").click();

  await expect(page.getByTestId("receipt-result")).toBeVisible();
  await expect(page.getByTestId("receipt-field-vendor")).toContainText("high");
  await expect(page.getByTestId("receipt-field-amount_cents")).toContainText("high");
  await expect(page.getByTestId("receipt-needs-review")).toHaveCount(0);
});

test("UD-08 a receipt with a blank field is flagged for review, not silently accepted", async ({ page }) => {
  await page.goto(`/upload?tenant_id=${TENANT}&role=owner`);
  await page.getByTestId("receipt-file-input").setInputFiles({
    name: "receipt2.jpg", mimeType: "image/jpeg",
    buffer: Buffer.from("fake-receipt-bytes-2"),
  });
  await page.getByTestId("receipt-amount-input").fill("20.00");
  await page.getByTestId("receipt-date-input").fill("2026-07-03");
  // vendor left blank on purpose
  await page.getByTestId("receipt-submit").click();

  await expect(page.getByTestId("receipt-field-vendor")).toContainText("low");
  await expect(page.getByTestId("receipt-needs-review")).toBeVisible();
});

test("UD-09 uploading the exact same receipt bytes twice is detected as a duplicate, not double-stored", async ({ page }) => {
  await page.goto(`/upload?tenant_id=${TENANT}&role=owner`);
  const file = { name: "dupe.jpg", mimeType: "image/jpeg", buffer: Buffer.from("dupe-receipt-bytes") };

  await page.getByTestId("receipt-file-input").setInputFiles(file);
  await page.getByTestId("receipt-amount-input").fill("10.00");
  await page.getByTestId("receipt-submit").click();
  await expect(page.getByTestId("receipt-id")).toBeVisible();

  await page.getByTestId("receipt-file-input").setInputFiles(file);
  await page.getByTestId("receipt-amount-input").fill("10.00");
  await page.getByTestId("receipt-submit").click();
  await expect(page.getByTestId("receipt-duplicate")).toBeVisible();
});

test("UD-10 the Setup & Config page and Control Center both link to Upload Documents", async ({ page }) => {
  await page.goto(`/config?tenant_id=${TENANT}&role=owner`);
  await expect(page.getByTestId("upload-link")).toBeVisible();

  await page.goto(`/money-loop?tenant_id=${TENANT}&role=owner`);
  await expect(page.getByTestId("upload-documents-link")).toBeVisible();

  await page.goto(`/money-loop?tenant_id=${TENANT}&role=crew`);
  await expect(page.getByTestId("upload-documents-link")).toHaveCount(0);
});
