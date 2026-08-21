import { test, expect } from "@playwright/test";
import { resetFinanceDb } from "./test-seed";

const TENANT = "t-e2e-config-admin";

test.beforeEach(async ({ request }) => {
  await resetFinanceDb(request, TENANT);
});

test("UC-01 super-admin owner sees all seven configs, each starting as 'using static default'", async ({ page }) => {
  await page.goto(`/config?tenant_id=${TENANT}&role=owner&is_super_admin=1`);
  for (const name of ["classifier_rules", "ingest_sources", "automation_policy", "approval_thresholds", "tenant_defaults", "division_map", "role_map"]) {
    await expect(page.getByTestId(`config-${name}`)).toBeVisible();
    await expect(page.getByTestId(`status-${name}`)).toContainText("static default");
  }
});

test("UC-01b a normal owner (isSuperAdmin=false) sees the page but none of the seven raw JSON config editors", async ({ page }) => {
  await page.goto(`/config?tenant_id=${TENANT}&role=owner`);
  await expect(page.getByTestId("policy-link-card")).toBeVisible();
  await expect(page.getByTestId("upload-link-card")).toBeVisible();
  await expect(page.getByTestId("onboarding-link-card")).toBeVisible();
  for (const name of ["classifier_rules", "ingest_sources", "automation_policy", "approval_thresholds", "tenant_defaults", "division_map", "role_map"]) {
    await expect(page.getByTestId(`config-${name}`)).toHaveCount(0);
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
  await page.goto(`/config?tenant_id=${TENANT}&role=owner&is_super_admin=1`);
  const editor = page.getByTestId("editor-automation_policy");
  await editor.fill(JSON.stringify({ version: 1, classifier_enabled: false }));
  await page.getByTestId("save-automation_policy").click();

  await expect(page.getByTestId("notice")).toContainText("Saved");
  await expect(page.getByTestId("status-automation_policy")).toContainText("Overridden");
  await expect(page.getByTestId("status-automation_policy")).toContainText("this tenant");
});

test("UC-04 saving invalid JSON shows an error and does not create an override", async ({ page }) => {
  await page.goto(`/config?tenant_id=${TENANT}&role=owner&is_super_admin=1`);
  await page.getByTestId("editor-division_map").fill("{not valid json");
  await page.getByTestId("save-division_map").click();

  await expect(page.getByTestId("notice")).toContainText("Error");
  await expect(page.getByTestId("status-division_map")).toContainText("static default");
});

test("UC-05 saving structurally invalid JSON (missing required field) is rejected", async ({ page }) => {
  await page.goto(`/config?tenant_id=${TENANT}&role=owner&is_super_admin=1`);
  await page.getByTestId("editor-classifier_rules").fill(JSON.stringify({ stage2_keyword_rules: [] }));
  await page.getByTestId("save-classifier_rules").click();

  await expect(page.getByTestId("notice")).toContainText("stage1_vendor_patterns");
  await expect(page.getByTestId("status-classifier_rules")).toContainText("static default");
});

test("UC-06 reset removes the override and reverts to the static default", async ({ page }) => {
  await page.goto(`/config?tenant_id=${TENANT}&role=owner&is_super_admin=1`);
  await page.getByTestId("editor-tenant_defaults").fill(JSON.stringify({ version: 1, equipment_engine_active: true }));
  await page.getByTestId("save-tenant_defaults").click();
  await expect(page.getByTestId("status-tenant_defaults")).toContainText("Overridden");

  await page.getByTestId("reset-tenant_defaults").click();
  await expect(page.getByTestId("status-tenant_defaults")).toContainText("static default");
});

test("UC-07 JSON API: GET/PUT/reset round-trip works the same as the form (super-admin)", async ({ request }) => {
  const base = `/api/config?tenant_id=${TENANT}&role=owner&is_super_admin=1`;

  const before = await (await request.get(`/api/config/approval_thresholds?tenant_id=${TENANT}&role=owner&is_super_admin=1`)).json();
  expect(before.is_override).toBe(false);

  const put = await request.put(`/api/config/approval_thresholds?tenant_id=${TENANT}&role=owner&is_super_admin=1`, {
    data: JSON.stringify({ version: 1, default_materiality_threshold_cents: 999999 }),
    headers: { "content-type": "application/json" },
  });
  expect(put.ok()).toBe(true);

  const after = await (await request.get(`/api/config/approval_thresholds?tenant_id=${TENANT}&role=owner&is_super_admin=1`)).json();
  expect(after.is_override).toBe(true);
  expect(after.value.default_materiality_threshold_cents).toBe(999999);

  const list = await (await request.get(base)).json();
  expect(list.configs.length).toBe(7);

  await request.post(`/api/config/approval_thresholds/reset?tenant_id=${TENANT}&role=owner&is_super_admin=1`);
  const reset = await (await request.get(`/api/config/approval_thresholds?tenant_id=${TENANT}&role=owner&is_super_admin=1`)).json();
  expect(reset.is_override).toBe(false);
});

test("UC-08 JSON API denies non-owner roles", async ({ request }) => {
  const res = await request.get(`/api/config?tenant_id=${TENANT}&role=crew&is_super_admin=1`);
  expect(res.status()).toBe(403);
});

test("UC-08b JSON API denies an owner-role request that is not isSuperAdmin, on every mutating and read endpoint", async ({ request }) => {
  const list = await request.get(`/api/config?tenant_id=${TENANT}&role=owner`);
  expect(list.status()).toBe(403);

  const get = await request.get(`/api/config/approval_thresholds?tenant_id=${TENANT}&role=owner`);
  expect(get.status()).toBe(403);

  const put = await request.put(`/api/config/approval_thresholds?tenant_id=${TENANT}&role=owner`, {
    data: JSON.stringify({ version: 1, default_materiality_threshold_cents: 1 }),
    headers: { "content-type": "application/json" },
  });
  expect(put.status()).toBe(403);

  const reset = await request.post(`/api/config/approval_thresholds/reset?tenant_id=${TENANT}&role=owner`);
  expect(reset.status()).toBe(403);
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
  await request.put(`/api/config/classifier_rules?tenant_id=${tenantA}&role=owner&is_super_admin=1`, {
    data: JSON.stringify({
      version: 1,
      stage1_vendor_patterns: [], stage2_keyword_rules: [], stage3_amount_review_rules: [],
      forced_review_categories: ["tenant_a_only_category"],
      confidence_thresholds: { auto_categorize_min: "high", stage4_fallback_min: "medium" },
    }),
    headers: { "content-type": "application/json" },
  });

  const aView = await (await request.get(`/api/config/classifier_rules?tenant_id=${tenantA}&role=owner&is_super_admin=1`)).json();
  expect(aView.is_override).toBe(true);
  expect(aView.value.forced_review_categories).toEqual(["tenant_a_only_category"]);

  // Tenant B — an entirely different company — still sees the untouched
  // platform default, never tenant A's edit.
  const bView = await (await request.get(`/api/config/classifier_rules?tenant_id=${tenantB}&role=owner&is_super_admin=1`)).json();
  expect(bView.is_override).toBe(false);
  expect(bView.value.forced_review_categories).not.toContain("tenant_a_only_category");
});

test("UC-08 the textarea's live value is valid JSON, not double-escaped", async ({ page }) => {
  // The bug this guards. The textarea content was run through a local
  // escapeHtml() AND then escaped again by Hono JSX's {expression} handling, so
  // the browser received `&amp;quot;` where it needed `&quot;`. What the user
  // saw in the box was `&quot;version&quot;: 1` rather than `"version": 1`.
  //
  // Every existing test in this file .fill()s the editor before reading it, so
  // none of them ever looked at what was rendered INTO it — which is exactly how
  // this survived. This one reads the value the browser actually holds.
  await page.goto(`/config?tenant_id=${TENANT}&role=owner&is_super_admin=1`);

  for (const name of ["automation_policy", "classifier_rules", "approval_thresholds"]) {
    const value = await page.getByTestId(`editor-${name}`).inputValue();
    expect(value, `${name} contains raw entity text`).not.toContain("&quot;");
    expect(value, `${name} contains raw entity text`).not.toContain("&amp;");
    // The real assertion: copy it out, parse it. This is what a user does when
    // they edit one field and resubmit, and it is what used to throw.
    expect(() => JSON.parse(value), `${name} did not round-trip through JSON.parse`).not.toThrow();
  }
});

test("UC-09 a config containing & and < survives the round trip", async ({ page }) => {
  // Characters that need escaping exactly once. Saving a value with them and
  // reading it back is where a single-escape and a double-escape diverge
  // visibly, so it pins the direction of the fix rather than just its absence.
  await page.goto(`/config?tenant_id=${TENANT}&role=owner&is_super_admin=1`);
  const payload = { version: 1, note: 'fuel & oil <10% of "total"' };

  await page.getByTestId("editor-automation_policy").fill(JSON.stringify(payload));
  await page.getByTestId("save-automation_policy").click();
  await page.goto(`/config?tenant_id=${TENANT}&role=owner&is_super_admin=1`);

  const value = await page.getByTestId("editor-automation_policy").inputValue();
  expect(JSON.parse(value)).toEqual(payload);
});
