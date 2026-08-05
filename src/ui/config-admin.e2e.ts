import { test, expect } from "@playwright/test";
import { resetFinanceDb } from "./test-seed";

const TENANT = "t-e2e-config-admin";

test.beforeEach(async ({ request }) => {
  await resetFinanceDb(request, TENANT);
});

test("UC-01 owner sees all seven configs, each starting as 'using static default'", async ({ page }) => {
  await page.goto(`/config?tenant_id=${TENANT}&role=owner`);
  for (const name of ["classifier_rules", "ingest_sources", "automation_policy", "approval_thresholds", "tenant_defaults", "division_map", "role_map"]) {
    await expect(page.getByTestId(`config-${name}`)).toBeVisible();
    await expect(page.getByTestId(`status-${name}`)).toContainText("static default");
  }
});

test("UC-02 non-owner roles are denied", async ({ page }) => {
  for (const role of ["crew", "crew_lead", "office"]) {
    const res = await page.goto(`/config?tenant_id=${TENANT}&role=${role}`);
    expect(res?.status()).toBe(403);
    await expect(page.getByTestId("denied")).toBeVisible();
  }
});

test("UC-03 saving valid JSON creates an override and the page reflects it", async ({ page }) => {
  await page.goto(`/config?tenant_id=${TENANT}&role=owner`);
  const editor = page.getByTestId("editor-automation_policy");
  await editor.fill(JSON.stringify({ version: 1, classifier_enabled: false }));
  await page.getByTestId("save-automation_policy").click();

  await expect(page.getByTestId("notice")).toContainText("Saved");
  await expect(page.getByTestId("status-automation_policy")).toContainText("Overridden");
  await expect(page.getByTestId("status-automation_policy")).toContainText("this tenant");
});

test("UC-04 saving invalid JSON shows an error and does not create an override", async ({ page }) => {
  await page.goto(`/config?tenant_id=${TENANT}&role=owner`);
  await page.getByTestId("editor-division_map").fill("{not valid json");
  await page.getByTestId("save-division_map").click();

  await expect(page.getByTestId("notice")).toContainText("Error");
  await expect(page.getByTestId("status-division_map")).toContainText("static default");
});

test("UC-05 saving structurally invalid JSON (missing required field) is rejected", async ({ page }) => {
  await page.goto(`/config?tenant_id=${TENANT}&role=owner`);
  await page.getByTestId("editor-classifier_rules").fill(JSON.stringify({ stage2_keyword_rules: [] }));
  await page.getByTestId("save-classifier_rules").click();

  await expect(page.getByTestId("notice")).toContainText("stage1_vendor_patterns");
  await expect(page.getByTestId("status-classifier_rules")).toContainText("static default");
});

test("UC-06 reset removes the override and reverts to the static default", async ({ page }) => {
  await page.goto(`/config?tenant_id=${TENANT}&role=owner`);
  await page.getByTestId("editor-tenant_defaults").fill(JSON.stringify({ version: 1, equipment_engine_active: true }));
  await page.getByTestId("save-tenant_defaults").click();
  await expect(page.getByTestId("status-tenant_defaults")).toContainText("Overridden");

  await page.getByTestId("reset-tenant_defaults").click();
  await expect(page.getByTestId("status-tenant_defaults")).toContainText("static default");
});

test("UC-07 JSON API: GET/PUT/reset round-trip works the same as the form", async ({ request }) => {
  const base = `/api/config?tenant_id=${TENANT}&role=owner`;

  const before = await (await request.get(`/api/config/approval_thresholds?tenant_id=${TENANT}&role=owner`)).json();
  expect(before.is_override).toBe(false);

  const put = await request.put(`/api/config/approval_thresholds?tenant_id=${TENANT}&role=owner`, {
    data: JSON.stringify({ version: 1, default_materiality_threshold_cents: 999999 }),
    headers: { "content-type": "application/json" },
  });
  expect(put.ok()).toBe(true);

  const after = await (await request.get(`/api/config/approval_thresholds?tenant_id=${TENANT}&role=owner`)).json();
  expect(after.is_override).toBe(true);
  expect(after.value.default_materiality_threshold_cents).toBe(999999);

  const list = await (await request.get(base)).json();
  expect(list.configs.length).toBe(7);

  await request.post(`/api/config/approval_thresholds/reset?tenant_id=${TENANT}&role=owner`);
  const reset = await (await request.get(`/api/config/approval_thresholds?tenant_id=${TENANT}&role=owner`)).json();
  expect(reset.is_override).toBe(false);
});

test("UC-08 JSON API denies non-owner roles", async ({ request }) => {
  const res = await request.get(`/api/config?tenant_id=${TENANT}&role=crew`);
  expect(res.status()).toBe(403);
});

test("UC-09 a tenant's saved override never becomes another tenant's default — the platform default stays the platform default", async ({ request }) => {
  // Direct verification of the product rule: any one tenant (e.g. a future
  // Avalon tenant) editing its own config must never change what a
  // different tenant, or the platform as a whole, sees as the default.
  const tenantA = "t-e2e-isolation-a";
  const tenantB = "t-e2e-isolation-b";
  await resetFinanceDb(request, tenantA);
  await resetFinanceDb(request, tenantB);

  // Tenant A customizes its own classifier rules.
  await request.put(`/api/config/classifier_rules?tenant_id=${tenantA}&role=owner`, {
    data: JSON.stringify({
      version: 1,
      stage1_vendor_patterns: [], stage2_keyword_rules: [], stage3_amount_review_rules: [],
      forced_review_categories: ["tenant_a_only_category"],
      confidence_thresholds: { auto_categorize_min: "high", stage4_fallback_min: "medium" },
    }),
    headers: { "content-type": "application/json" },
  });

  const aView = await (await request.get(`/api/config/classifier_rules?tenant_id=${tenantA}&role=owner`)).json();
  expect(aView.is_override).toBe(true);
  expect(aView.value.forced_review_categories).toEqual(["tenant_a_only_category"]);

  // Tenant B — an entirely different company — still sees the untouched
  // platform default, never tenant A's edit.
  const bView = await (await request.get(`/api/config/classifier_rules?tenant_id=${tenantB}&role=owner`)).json();
  expect(bView.is_override).toBe(false);
  expect(bView.value.forced_review_categories).not.toContain("tenant_a_only_category");
});
