import { test, expect } from "@playwright/test";

const TENANT = "t-e2e-obligations";

test("UOB-01 owner sees an honest explanation of the gap, not fabricated numbers", async ({ page }) => {
  await page.goto(`/obligations?tenant_id=${TENANT}&role=owner`);
  await expect(page.getByTestId("obligations-blocked")).toBeVisible();
  await expect(page.getByTestId("obligations-blocked")).toContainText("No vendor bill data exists yet");
});

test("UOB-02 crew and crew_lead are denied", async ({ page }) => {
  for (const role of ["crew", "crew_lead"]) {
    const res = await page.goto(`/obligations?tenant_id=${TENANT}&role=${role}`);
    expect(res?.status()).toBe(403);
    await expect(page.getByTestId("denied")).toBeVisible();
  }
});
