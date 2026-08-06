import { test, expect } from "@playwright/test";
import { resetFinanceDb, exec } from "./test-seed";

const TENANT = "t-e2e-reconciliation";

test.beforeEach(async ({ request }) => {
  await resetFinanceDb(request, TENANT);
});

test("UR2-01 with nothing classified yet, the page is honest about why, not empty by accident", async ({ page }) => {
  await page.goto(`/reconciliation?tenant_id=${TENANT}&role=owner`);
  await expect(page.getByTestId("reconciliation-list")).toContainText("Nothing classified yet");
  await expect(page.getByTestId("reconciliation-list")).toContainText("classifyTransaction");
});

test("UR2-02 findings render with stage, confidence, materiality, and resolution status", async ({ page, request }) => {
  await exec(request,
    `INSERT INTO action_item (id, tenant_id, verb, owner_id, sla_due, confidence, status) VALUES (?,?,?,?,?,?, 'open')`,
    ["ai-decide-1", TENANT, "decide", "office-user-1", "2026-08-10", "low"]);
  await exec(request,
    `INSERT INTO classification_finding (id, tenant_id, subject_type, subject_id, stage_reached, confidence, materiality_cents, proposed_change, action_item_id) VALUES (?,?,?,?,?,?,?,?,?)`,
    ["cf-1", TENANT, "bank_transaction", "txn-1", 1, "high", 5000, null, null]);
  await exec(request,
    `INSERT INTO classification_finding (id, tenant_id, subject_type, subject_id, stage_reached, confidence, materiality_cents, proposed_change, action_item_id) VALUES (?,?,?,?,?,?,?,?,?)`,
    ["cf-2", TENANT, "bank_transaction", "txn-2", 4, "low", 12000, '{"category":"fuel"}', "ai-decide-1"]);

  await page.goto(`/reconciliation?tenant_id=${TENANT}&role=owner`);
  await expect(page.getByTestId("findings-count")).toHaveText("2");
  await expect(page.getByTestId("unresolved-count")).toHaveText("1");
  await expect(page.getByTestId("finding-cf-1")).toContainText("auto-resolved");
  await expect(page.getByTestId("finding-cf-2")).toContainText("has review item");
});

test("UR2-03 crew and crew_lead are denied", async ({ page }) => {
  for (const role of ["crew", "crew_lead"]) {
    const res = await page.goto(`/reconciliation?tenant_id=${TENANT}&role=${role}`);
    expect(res?.status()).toBe(403);
    await expect(page.getByTestId("denied")).toBeVisible();
  }
});
