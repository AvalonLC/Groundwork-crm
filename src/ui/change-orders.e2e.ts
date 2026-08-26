import { test, expect, type APIRequestContext } from "@playwright/test";
import { resetFinanceDb, exec } from "./test-seed";

/**
 * PR D end-to-end coverage for the change-order / budget-version-review /
 * completion-method workflow (src/ui/change-orders.tsx), mounted at
 * /change-orders in dev-server.ts (production: /finance/change-orders via
 * mount.ts — see that file's comment on why the two prefixes differ).
 *
 * Structural template: receipt-posting.e2e.ts. Seed helpers below mirror
 * that file's seedJob/seedApprovedReceipt pair, plus an
 * seedApprovableJob-equivalent (crew+division+overhead_allocation) adapted
 * from src/api/change-order-approval.test.ts's vitest-side helper of the
 * same name — reimplemented here through HTTP /test/exec since Playwright
 * has no direct DB access.
 */

const TENANT = "t-e2e-change-orders";
const OTHER_TENANT = "t-e2e-change-orders-other";

test.beforeEach(async ({ request }) => {
  await resetFinanceDb(request, TENANT);
  await resetFinanceDb(request, OTHER_TENANT);
});

async function querySql<T = Record<string, unknown>>(
  request: APIRequestContext, sql: string, params: unknown[] = [],
): Promise<T[]> {
  const res = await request.post("/test/exec", { data: { sql, params } });
  expect(res.ok()).toBeTruthy();
  const body = (await res.json()) as { results: T[] };
  return body.results;
}

// work_orders.id (and crews.id, overhead_allocation.id) are GLOBAL primary
// keys, not tenant-scoped — the local D1 already carries fixture/other-suite
// rows using plain ids like "job-1"/"crew-1", so a colliding id here would
// fail as a PRIMARY KEY violation despite being a different tenant. The
// run-specific prefix (module-load timestamp) keeps every id this file
// generates unique across full-suite runs, not just within one test.
const RUN_PREFIX = `coe2e${Date.now()}`;
let uidCounter = 0;
function uid(prefix: string): string {
  uidCounter += 1;
  return `${RUN_PREFIX}-${prefix}-${uidCounter}`;
}

/** A tenant-scoped work order with a crew+division, wired the same way
 * getJobDivision (src/db/repos.ts) resolves it: work_orders.crew_id ->
 * crews.division. Callers that don't need a division (e.g. the
 * no_division-failure test) can omit `division`. */
async function seedJob(
  request: APIRequestContext, companyId: string, jobId: string,
  opts: { division?: string; status?: string } = {},
) {
  let crewId: string | null = null;
  if (opts.division) {
    crewId = `crew-${jobId}`;
    await exec(request, `INSERT INTO crews (id, company_id, name, division) VALUES (?,?,?,?)`,
      [crewId, companyId, `Crew ${crewId}`, opts.division]);
  }
  await exec(request,
    `INSERT INTO work_orders (id, company_id, wo_number, title, client_name, status, crew_id) VALUES (?,?,?,?,?,?,?)`,
    [jobId, companyId, `WO-${jobId}`, `Job ${jobId}`, "Acme Client", opts.status ?? "scheduled", crewId]);
  return crewId;
}

/** An overhead_allocation row for a division, as of a date — the minimum a
 * change order needs on record to be approvable at all (approveChangeOrder-
 * Workflow's no_overhead_rate failure otherwise). Mirrors change-order-
 * approval.test.ts's seedOverheadRate. */
async function seedOverheadRate(
  request: APIRequestContext, companyId: string, division: string, asOf: string, overheadRate = 242200,
) {
  // overhead_allocation.id is INTEGER PRIMARY KEY AUTOINCREMENT (migrations/
  // 0057_finance_merge.sql) — do not supply it, mirroring insertOverheadAllocation
  // in src/db/repos.ts which also omits id/created_at.
  await exec(request, `
    INSERT INTO overhead_allocation
      (company_id, division, as_of, sellable_hours, allocated_overhead_cents,
       weighted_labor_rate_cents, overhead_rate, absorbed_cost_cents, target_margin, required_bill_rate_cents)
    VALUES (?,?,?,?,?,?,?,?,?,?)
  `, [companyId, division, asOf, 1000, 100000, 350000, overheadRate, 0, 0, 0]);
}

/** A job with a division AND a current overhead rate on record — the
 * minimum needed for a change order on it to be approvable. Each call uses
 * its own division (overhead_allocation is UNIQUE on company_id+division+
 * as_of, migrations/0077), so multiple tests/seeds in the same run never
 * collide. */
async function seedApprovableJob(request: APIRequestContext, companyId: string, asOf = "2026-08-01") {
  const division = uid("division");
  const jobId = uid("job");
  await seedJob(request, companyId, jobId, { division });
  await seedOverheadRate(request, companyId, division, asOf, 242200);
  return jobId;
}

/** Creates a change order via the real UI form (POST /new) rather than a
 * raw INSERT, so every CO-creation test also exercises the actual route,
 * its field parsing (dollars -> cents, hours -> hundredths), and its
 * redirect. Returns the created CO's id (read back via querySql, since the
 * route only redirects, it never echoes the new id). */
async function createChangeOrderViaForm(
  request: APIRequestContext, companyId: string, jobId: string,
  fields: { description?: string; reason?: string; revenue_adjustment?: string; direct_cost_adjustment?: string; labor_hours_adjustment?: string; effective_date?: string } = {},
) {
  const res = await request.post(
    `/change-orders/new?tenant_id=${companyId}&role=office&job_id=${jobId}`,
    {
      form: {
        description: fields.description ?? "scope add",
        reason: fields.reason ?? "customer request",
        revenue_adjustment: fields.revenue_adjustment ?? "0",
        direct_cost_adjustment: fields.direct_cost_adjustment ?? "0",
        labor_hours_adjustment: fields.labor_hours_adjustment ?? "0",
        effective_date: fields.effective_date ?? "2026-08-01",
      },
      maxRedirects: 0,
    },
  );
  expect(res.status()).toBe(302);
  // created_at has only second-granularity (datetime('now')) — two change
  // orders created within the same second would tie on that column and make
  // "most recent" ambiguous. change_orders.id is a plain TEXT PRIMARY KEY
  // (not INTEGER PRIMARY KEY), so SQLite still assigns it an implicit rowid
  // in insertion order; ordering by rowid is a reliable "most recently
  // inserted" tiebreaker within this single test helper.
  const rows = await querySql<{ id: string }>(
    request, `SELECT id FROM change_orders WHERE company_id = ? AND job_id = ? ORDER BY rowid DESC LIMIT 1`,
    [companyId, jobId],
  );
  return { id: rows[0]?.id as string, location: res.headers()["location"] ?? "" };
}

async function submitCo(request: APIRequestContext, companyId: string, jobId: string, coId: string) {
  return request.post(`/change-orders/${coId}/submit?tenant_id=${companyId}&role=office&job_id=${jobId}`, { form: {}, maxRedirects: 0 });
}

async function approveCo(request: APIRequestContext, companyId: string, jobId: string, coId: string, role = "owner") {
  return request.post(`/change-orders/${coId}/approve?tenant_id=${companyId}&role=${role}&job_id=${jobId}`, { form: {}, maxRedirects: 0 });
}

// ── Change-order lifecycle ──────────────────────────────────────────────────

test("CO-01 authorized user opens the change-order page and reaches it via the job picker", async ({ page, request }) => {
  const jobId = await seedApprovableJob(request, TENANT);

  await page.goto(`/change-orders?tenant_id=${TENANT}&role=office`);
  await expect(page.getByTestId("job-picker-list")).toBeVisible();
  await page.getByTestId(`job-picker-link-${jobId}`).click();
  await expect(page.getByTestId("co-list")).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`job_id=${jobId}`));
});

test("CO-02 create a change order for a tenant-owned job, edit it before approval, then submit", async ({ page, request }) => {
  const jobId = await seedApprovableJob(request, TENANT);

  await page.goto(`/change-orders/new?tenant_id=${TENANT}&role=office&job_id=${jobId}`);
  await page.getByTestId("co-description-input").fill("Add retaining wall section");
  await page.getByTestId("co-reason-input").fill("customer request");
  await page.getByTestId("co-revenue-adjustment-input").fill("6000");
  await page.getByTestId("co-direct-cost-adjustment-input").fill("3500");
  await page.getByTestId("co-labor-hours-adjustment-input").fill("40");
  await page.getByTestId("co-effective-date-input").fill("2026-08-01");
  await page.getByTestId("co-form-save").click();
  await expect(page.getByTestId("notice")).toContainText("Saved");
  await expect(page.getByTestId("co-list")).toContainText("Add retaining wall section");

  const rows = await querySql<{ id: string; status: string; revenue_adjustment_cents: number }>(
    request, `SELECT id, status, revenue_adjustment_cents FROM change_orders WHERE company_id = ? AND job_id = ?`, [TENANT, jobId],
  );
  expect(rows.length).toBe(1);
  expect(rows[0].status).toBe("draft");
  expect(rows[0].revenue_adjustment_cents).toBe(600000); // $6000 -> cents

  const coId = rows[0].id;

  // Edit it while still draft.
  await page.getByTestId(`co-edit-link-${coId}`).click();
  await expect(page.getByTestId("co-form")).toBeVisible();
  await page.getByTestId("co-description-input").fill("Add retaining wall section (revised scope)");
  await page.getByTestId("co-form-save").click();
  await expect(page.getByTestId("notice")).toContainText("Saved");
  await expect(page.getByTestId("co-list")).toContainText("revised scope");

  // Submit for approval.
  await page.getByTestId(`co-submit-${coId}`).click();
  await expect(page.getByTestId("notice")).toContainText("Submitted");
  await expect(page.getByTestId(`co-status-${coId}`)).toContainText("pending");

  const after = await querySql<{ status: string }>(request, `SELECT status FROM change_orders WHERE company_id = ? AND id = ?`, [TENANT, coId]);
  expect(after[0].status).toBe("pending");
});

test("CO-03 explicit rejection with a reason, and voiding a draft", async ({ page, request }) => {
  const jobId = await seedApprovableJob(request, TENANT);

  // Reject path: create -> submit -> reject.
  const co1 = await createChangeOrderViaForm(request, TENANT, jobId, { description: "reject me" });
  await submitCo(request, TENANT, jobId, co1.id);

  await page.goto(`/change-orders?tenant_id=${TENANT}&role=owner&job_id=${jobId}`);
  await page.getByTestId(`co-reject-reason-${co1.id}`).fill("scope not approved by customer");
  await page.getByTestId(`co-reject-${co1.id}`).click();
  await expect(page.getByTestId("notice")).toContainText("Rejected");
  await expect(page.getByTestId(`co-status-${co1.id}`)).toContainText("rejected");
  await expect(page.getByTestId(`co-approval-meta-${co1.id}`)).toContainText("scope not approved by customer");

  // Void path: a fresh draft, voided directly (draft -> void is supported;
  // approved -> void is not, covered separately in CO-08).
  const co2 = await createChangeOrderViaForm(request, TENANT, jobId, { description: "void me" });
  await page.goto(`/change-orders?tenant_id=${TENANT}&role=office&job_id=${jobId}`);
  await page.getByTestId(`co-void-reason-${co2.id}`).fill("customer cancelled the add");
  await page.getByTestId(`co-void-${co2.id}`).click();
  await expect(page.getByTestId("notice")).toContainText("Voided");
  await expect(page.getByTestId(`co-status-${co2.id}`)).toContainText("void");

  const rows = await querySql<{ id: string; status: string }>(
    request, `SELECT id, status FROM change_orders WHERE company_id = ? AND job_id = ? ORDER BY id`, [TENANT, jobId],
  );
  expect(rows.find((r) => r.id === co1.id)?.status).toBe("rejected");
  expect(rows.find((r) => r.id === co2.id)?.status).toBe("void");

  // Neither rejected nor voided CO ever produced a budget version.
  const versions = await querySql(request, `SELECT id FROM job_budget_versions WHERE company_id = ? AND job_id = ?`, [TENANT, jobId]);
  expect(versions.length).toBe(0);
});

test("CO-04 approval: view resulting status and the budget version it created", async ({ page, request }) => {
  const jobId = await seedApprovableJob(request, TENANT);
  const co = await createChangeOrderViaForm(request, TENANT, jobId, {
    description: "approve me", revenue_adjustment: "6000", direct_cost_adjustment: "3500", labor_hours_adjustment: "40",
  });
  await submitCo(request, TENANT, jobId, co.id);

  await page.goto(`/change-orders?tenant_id=${TENANT}&role=owner&job_id=${jobId}`);
  await page.getByTestId(`co-approve-${co.id}`).click();
  await expect(page.getByTestId("notice")).toContainText("Approved");
  await expect(page.getByTestId(`co-status-${co.id}`)).toContainText("approved");
  await expect(page.getByTestId(`co-approval-meta-${co.id}`)).toContainText("approved by");

  // The budget-version-history card shows the new revision, marked current.
  await expect(page.getByTestId("budget-version-list")).toBeVisible();
  const versions = await querySql<{ id: string; revision_seq: number; contract_value_cents: number; direct_cost_budget_cents: number; budgeted_overhead_cents: number }>(
    request, `SELECT id, revision_seq, contract_value_cents, direct_cost_budget_cents, budgeted_overhead_cents FROM job_budget_versions WHERE company_id = ? AND job_id = ?`,
    [TENANT, jobId],
  );
  expect(versions.length).toBe(1);
  expect(versions[0].revision_seq).toBe(0);
  expect(versions[0].contract_value_cents).toBe(600000);
  expect(versions[0].direct_cost_budget_cents).toBe(350000);
  expect(versions[0].budgeted_overhead_cents).toBe(96880); // 40 hrs * $24.22
  await expect(page.getByTestId(`budget-version-active-${versions[0].id}`)).toBeVisible();
});

// ── Authorization and tenant isolation ──────────────────────────────────────

test("CO-05 unauthorized roles get 403 on the page and every mutation route, not just hidden controls", async ({ page, request }) => {
  const jobId = await seedApprovableJob(request, TENANT);
  const co = await createChangeOrderViaForm(request, TENANT, jobId);
  await submitCo(request, TENANT, jobId, co.id);

  for (const role of ["crew", "crew_lead"]) {
    const pageRes = await page.goto(`/change-orders?tenant_id=${TENANT}&role=${role}&job_id=${jobId}`);
    expect(pageRes?.status()).toBe(403);
    await expect(page.getByTestId("denied")).toBeVisible();

    // The crafted requests below prove the server enforces this even if a
    // malicious client skips the UI (which wouldn't render these controls
    // for crew/crew_lead in the first place — canManage/canApprove gate
    // rendering, but this is testing the ROUTE, not the button's absence).
    const newRes = await request.post(`/change-orders/new?tenant_id=${TENANT}&role=${role}&job_id=${jobId}`, { form: { description: "x", reason: "x", revenue_adjustment: "0", direct_cost_adjustment: "0", labor_hours_adjustment: "0" } });
    expect(newRes.status()).toBe(403);
    const submitRes = await request.post(`/change-orders/${co.id}/submit?tenant_id=${TENANT}&role=${role}&job_id=${jobId}`, { form: {} });
    expect(submitRes.status()).toBe(403);
    const approveRes = await request.post(`/change-orders/${co.id}/approve?tenant_id=${TENANT}&role=${role}&job_id=${jobId}`, { form: {} });
    expect(approveRes.status()).toBe(403);
    const rejectRes = await request.post(`/change-orders/${co.id}/reject?tenant_id=${TENANT}&role=${role}&job_id=${jobId}`, { form: { reason: "x" } });
    expect(rejectRes.status()).toBe(403);
    const voidRes = await request.post(`/change-orders/${co.id}/void?tenant_id=${TENANT}&role=${role}&job_id=${jobId}`, { form: { reason: "x" } });
    expect(voidRes.status()).toBe(403);
  }

  // office (can_manage but NOT can_approve) can submit but must still be
  // refused at approve/reject specifically — the two-tier permission split.
  const officeApprove = await request.post(`/change-orders/${co.id}/approve?tenant_id=${TENANT}&role=office&job_id=${jobId}`, { form: {} });
  expect(officeApprove.status()).toBe(403);
  const officeReject = await request.post(`/change-orders/${co.id}/reject?tenant_id=${TENANT}&role=office&job_id=${jobId}`, { form: { reason: "x" } });
  expect(officeReject.status()).toBe(403);

  // Confirm nothing was actually mutated by any of the unauthorized attempts.
  const rows = await querySql<{ status: string }>(request, `SELECT status FROM change_orders WHERE company_id = ? AND id = ?`, [TENANT, co.id]);
  expect(rows[0].status).toBe("pending");
  const versions = await querySql(request, `SELECT id FROM job_budget_versions WHERE company_id = ? AND job_id = ?`, [TENANT, jobId]);
  expect(versions.length).toBe(0);
});

test("CO-06 a work order from another tenant cannot be linked: cross-tenant job_id is rejected", async ({ request }) => {
  const foreignJobId = await seedApprovableJob(request, OTHER_TENANT);

  // A crafted POST straight at /new using a foreign tenant's job id in the
  // query string — getAssignableJob is tenant-scoped, so this must be
  // treated as "no such job", never silently create a CO against it.
  const res = await request.post(
    `/change-orders/new?tenant_id=${TENANT}&role=office&job_id=${foreignJobId}`,
    { form: { description: "x", reason: "x", revenue_adjustment: "0", direct_cost_adjustment: "0", labor_hours_adjustment: "0" }, maxRedirects: 0 },
  );
  expect(res.status()).toBe(302);
  expect(res.headers()["location"] ?? "").toContain("error=no_job");

  const rows = await querySql(request, `SELECT id FROM change_orders WHERE job_id = ?`, [foreignJobId]);
  expect(rows.length).toBe(0);
});

test("CO-07 a change order from another tenant cannot be viewed or mutated by a crafted cross-tenant request", async ({ request }) => {
  const foreignJobId = await seedApprovableJob(request, OTHER_TENANT);
  const foreignCo = await createChangeOrderViaForm(request, OTHER_TENANT, foreignJobId, { description: "belongs to other tenant" });
  await submitCo(request, OTHER_TENANT, foreignJobId, foreignCo.id);

  // GET edit page for a foreign-tenant CO id, spoofing our own tenant_id.
  const editRes = await request.get(`/change-orders/${foreignCo.id}/edit?tenant_id=${TENANT}&role=office`);
  expect(editRes.status()).toBe(404);

  // POST edit/submit/approve/reject/void against the foreign CO id, spoofing our tenant_id.
  const editPost = await request.post(`/change-orders/${foreignCo.id}/edit?tenant_id=${TENANT}&role=office&job_id=${foreignJobId}`,
    { form: { description: "hijacked", reason: "x", revenue_adjustment: "0", direct_cost_adjustment: "0", labor_hours_adjustment: "0" }, maxRedirects: 0 });
  expect(editPost.status()).toBe(302);
  expect(editPost.headers()["location"] ?? "").toContain("error=not_editable");

  const approvePost = await request.post(`/change-orders/${foreignCo.id}/approve?tenant_id=${TENANT}&role=owner&job_id=${foreignJobId}`, { form: {}, maxRedirects: 0 });
  expect(approvePost.status()).toBe(302);
  expect(approvePost.headers()["location"] ?? "").toContain("error=not_found");

  const rejectPost = await request.post(`/change-orders/${foreignCo.id}/reject?tenant_id=${TENANT}&role=owner&job_id=${foreignJobId}`, { form: { reason: "x" }, maxRedirects: 0 });
  expect(rejectPost.status()).toBe(302);
  expect(rejectPost.headers()["location"] ?? "").toContain("error=not_pending");

  // Confirm the foreign CO is completely untouched under its OWN tenant.
  const rows = await querySql<{ status: string; description: string }>(
    request, `SELECT status, description FROM change_orders WHERE company_id = ? AND id = ?`, [OTHER_TENANT, foreignCo.id],
  );
  expect(rows[0].status).toBe("pending");
  expect(rows[0].description).toBe("belongs to other tenant");
});

test("CO-08 a budget version from another tenant cannot be viewed or resolved cross-tenant", async ({ request }) => {
  const foreignJobId = await seedApprovableJob(request, OTHER_TENANT, "2026-08-01");
  const foreignCo = await createChangeOrderViaForm(request, OTHER_TENANT, foreignJobId, { revenue_adjustment: "100", direct_cost_adjustment: "0", labor_hours_adjustment: "0" });
  await submitCo(request, OTHER_TENANT, foreignJobId, foreignCo.id);
  await approveCo(request, OTHER_TENANT, foreignJobId, foreignCo.id);

  const versionRows = await querySql<{ id: string }>(request, `SELECT id FROM job_budget_versions WHERE company_id = ? AND job_id = ?`, [OTHER_TENANT, foreignJobId]);
  expect(versionRows.length).toBe(1);
  const versionId = versionRows[0].id;

  // Force it into needs_review, then try to resolve it while spoofing our tenant.
  await exec(request, `UPDATE job_budget_versions SET needs_review = 1 WHERE id = ?`, [versionId]);
  const resolveRes = await request.post(`/change-orders/budget-versions/${versionId}/resolve-review?tenant_id=${TENANT}&role=office`, { form: {}, maxRedirects: 0 });
  expect(resolveRes.status()).toBe(302);
  expect(resolveRes.headers()["location"] ?? "").toContain("error=already_resolved"); // resolveJobBudgetVersionReview finds no matching row under TENANT, returns false

  const stillFlagged = await querySql<{ needs_review: number }>(request, `SELECT needs_review FROM job_budget_versions WHERE id = ?`, [versionId]);
  expect(stillFlagged[0].needs_review).toBe(1); // untouched by the cross-tenant attempt

  // And it must never appear in OUR tenant's review queue.
  const ourQueue = await request.get(`/change-orders/budget-versions/review?tenant_id=${TENANT}&role=owner`);
  const ourBody = await ourQueue.text();
  expect(ourBody).not.toContain(versionId);
});

// ── Financial integrity ─────────────────────────────────────────────────────

test("CO-09 approved change orders become immutable: edit/submit/reject all fail once approved", async ({ request }) => {
  const jobId = await seedApprovableJob(request, TENANT);
  const co = await createChangeOrderViaForm(request, TENANT, jobId, { revenue_adjustment: "1000", direct_cost_adjustment: "0", labor_hours_adjustment: "0" });
  await submitCo(request, TENANT, jobId, co.id);
  const approveRes = await approveCo(request, TENANT, jobId, co.id);
  expect(approveRes.headers()["location"] ?? "").toContain("approved=1");

  const editRes = await request.post(`/change-orders/${co.id}/edit?tenant_id=${TENANT}&role=office&job_id=${jobId}`,
    { form: { description: "trying to edit after approval", reason: "x", revenue_adjustment: "999999", direct_cost_adjustment: "0", labor_hours_adjustment: "0" }, maxRedirects: 0 });
  expect(editRes.headers()["location"] ?? "").toContain("error=not_editable");

  const submitRes = await submitCo(request, TENANT, jobId, co.id);
  expect(submitRes.headers()["location"] ?? "").toContain("error=not_draft");

  const rejectRes = await request.post(`/change-orders/${co.id}/reject?tenant_id=${TENANT}&role=owner&job_id=${jobId}`, { form: { reason: "too late" }, maxRedirects: 0 });
  expect(rejectRes.headers()["location"] ?? "").toContain("error=not_pending");

  const voidRes = await request.post(`/change-orders/${co.id}/void?tenant_id=${TENANT}&role=office&job_id=${jobId}`, { form: { reason: "too late" }, maxRedirects: 0 });
  expect(voidRes.headers()["location"] ?? "").toContain("error=not_editable");

  // Approved history was never overwritten by any of the attempts above.
  const rows = await querySql<{ description: string; revenue_adjustment_cents: number; status: string }>(
    request, `SELECT description, revenue_adjustment_cents, status FROM change_orders WHERE company_id = ? AND id = ?`, [TENANT, co.id],
  );
  expect(rows[0].status).toBe("approved");
  expect(rows[0].revenue_adjustment_cents).toBe(100000); // still the original $1000, not 999999
  expect(rows[0].description).not.toContain("trying to edit");
});

test("CO-10 rejected and voided change orders never produce a budget version", async ({ request }) => {
  const jobId = await seedApprovableJob(request, TENANT);

  const rejected = await createChangeOrderViaForm(request, TENANT, jobId, { revenue_adjustment: "500", direct_cost_adjustment: "0", labor_hours_adjustment: "0" });
  await submitCo(request, TENANT, jobId, rejected.id);
  await request.post(`/change-orders/${rejected.id}/reject?tenant_id=${TENANT}&role=owner&job_id=${jobId}`, { form: { reason: "declined" } });

  const voided = await createChangeOrderViaForm(request, TENANT, jobId, { revenue_adjustment: "700", direct_cost_adjustment: "0", labor_hours_adjustment: "0" });
  await request.post(`/change-orders/${voided.id}/void?tenant_id=${TENANT}&role=office&job_id=${jobId}`, { form: { reason: "cancelled" } });

  const versions = await querySql(request, `SELECT id FROM job_budget_versions WHERE company_id = ? AND job_id = ?`, [TENANT, jobId]);
  expect(versions.length).toBe(0);
});

test("CO-11 approval creates the correct atomic budget version: exactly one row, correct cumulative totals", async ({ request }) => {
  const jobId = await seedApprovableJob(request, TENANT);
  const co1 = await createChangeOrderViaForm(request, TENANT, jobId, { revenue_adjustment: "1000", direct_cost_adjustment: "500", labor_hours_adjustment: "0" });
  await submitCo(request, TENANT, jobId, co1.id);
  const first = await approveCo(request, TENANT, jobId, co1.id);
  expect(first.headers()["location"] ?? "").toContain("approved=1");

  const co2 = await createChangeOrderViaForm(request, TENANT, jobId, { revenue_adjustment: "250", direct_cost_adjustment: "100", labor_hours_adjustment: "0" });
  await submitCo(request, TENANT, jobId, co2.id);
  const second = await approveCo(request, TENANT, jobId, co2.id);
  expect(second.headers()["location"] ?? "").toContain("approved=1");

  const versions = await querySql<{ revision_seq: number; contract_value_cents: number; direct_cost_budget_cents: number }>(
    request, `SELECT revision_seq, contract_value_cents, direct_cost_budget_cents FROM job_budget_versions WHERE company_id = ? AND job_id = ? ORDER BY revision_seq`,
    [TENANT, jobId],
  );
  expect(versions.length).toBe(2); // one per approval, atomically
  expect(versions[0].revision_seq).toBe(0);
  expect(versions[0].contract_value_cents).toBe(100000); // revision 0 untouched by revision 1
  expect(versions[1].revision_seq).toBe(1);
  expect(versions[1].contract_value_cents).toBe(125000); // 1000 + 250, cumulative
  expect(versions[1].direct_cost_budget_cents).toBe(60000); // 500 + 100, cumulative
});

test("CO-12 duplicate approval does not create a second budget version", async ({ request }) => {
  const jobId = await seedApprovableJob(request, TENANT);
  const co = await createChangeOrderViaForm(request, TENANT, jobId, { revenue_adjustment: "100", direct_cost_adjustment: "0", labor_hours_adjustment: "0" });
  await submitCo(request, TENANT, jobId, co.id);

  const first = await approveCo(request, TENANT, jobId, co.id);
  expect(first.headers()["location"] ?? "").toContain("approved=1");

  const second = await approveCo(request, TENANT, jobId, co.id);
  expect(second.headers()["location"] ?? "").toContain("error="); // not_pending, since it's already approved

  const versions = await querySql(request, `SELECT id FROM job_budget_versions WHERE company_id = ? AND job_id = ?`, [TENANT, jobId]);
  expect(versions.length).toBe(1);
});

test("CO-13 concurrent approval attempts (Promise.all) yield exactly one success and one budget version", async ({ request }) => {
  const jobId = await seedApprovableJob(request, TENANT);
  const co = await createChangeOrderViaForm(request, TENANT, jobId, { revenue_adjustment: "100", direct_cost_adjustment: "0", labor_hours_adjustment: "0" });
  await submitCo(request, TENANT, jobId, co.id);

  const attempts = await Promise.all(
    Array.from({ length: 5 }, () => approveCo(request, TENANT, jobId, co.id)),
  );
  const outcomes = attempts.map((res) => {
    const loc = res.headers()["location"] ?? "";
    return loc.includes("approved=1") ? "approved" : loc.includes("error=") ? "conflict" : "other";
  });
  expect(outcomes.filter((o) => o === "approved").length).toBe(1);
  expect(outcomes.filter((o) => o === "conflict").length).toBe(4);
  expect(outcomes.filter((o) => o === "other").length).toBe(0);

  const versions = await querySql(request, `SELECT id FROM job_budget_versions WHERE company_id = ? AND job_id = ?`, [TENANT, jobId]);
  expect(versions.length).toBe(1); // the atomic INSERT...SELECT...WHERE changes()>0 guard held under concurrency
});

test("CO-14 revised totals use integer cents; a negative-resulting total is rejected before any write", async ({ request }) => {
  const jobId = await seedApprovableJob(request, TENANT);
  // -50.006 (not -50.005) deliberately avoids Math.round's exact-half tie
  // case: Math.round(-5000.5) is -5000 (JS rounds ties toward +Infinity, not
  // away from zero), which would make an unambiguous-rounding assertion
  // flaky-looking. -50.006 -> -5000.6 -> -5001 has no such ambiguity.
  const co = await createChangeOrderViaForm(request, TENANT, jobId, { revenue_adjustment: "-50.006", direct_cost_adjustment: "0", labor_hours_adjustment: "0" });
  await submitCo(request, TENANT, jobId, co.id);

  const res = await approveCo(request, TENANT, jobId, co.id);
  expect(res.headers()["location"] ?? "").toContain("error=invalid_revised_budget");

  // No budget version created for the rejected approval attempt.
  const versions = await querySql(request, `SELECT id FROM job_budget_versions WHERE company_id = ? AND job_id = ?`, [TENANT, jobId]);
  expect(versions.length).toBe(0);

  const rows = await querySql<{ revenue_adjustment_cents: number; status: string }>(
    request, `SELECT revenue_adjustment_cents, status FROM change_orders WHERE company_id = ? AND id = ?`, [TENANT, co.id],
  );
  expect(rows[0].revenue_adjustment_cents).toBe(-5001); // rounded to the nearest cent (integer), not a float
  expect(rows[0].status).toBe("pending"); // approval failed, CO stays pending, never silently "approved"
});

test("CO-15 a job with no division set fails approval with no_division, and one with no overhead rate fails with no_overhead_rate", async ({ request }) => {
  const jobNoDivision = uid("job");
  await seedJob(request, TENANT, jobNoDivision); // no crew/division at all
  const co1 = await createChangeOrderViaForm(request, TENANT, jobNoDivision, { revenue_adjustment: "100" });
  await submitCo(request, TENANT, jobNoDivision, co1.id);
  const res1 = await approveCo(request, TENANT, jobNoDivision, co1.id);
  expect(res1.headers()["location"] ?? "").toContain("error=no_division");

  const jobNoRate = uid("job");
  await seedJob(request, TENANT, jobNoRate, { division: "no-rate-division" }); // division set, but no overhead_allocation row
  const co2 = await createChangeOrderViaForm(request, TENANT, jobNoRate, { revenue_adjustment: "100" });
  await submitCo(request, TENANT, jobNoRate, co2.id);
  const res2 = await approveCo(request, TENANT, jobNoRate, co2.id);
  expect(res2.headers()["location"] ?? "").toContain("error=no_overhead_rate");
});

// ── Budget-version review ───────────────────────────────────────────────────

test("CO-16 versions needing review appear in the tenant-wide review queue with original and revised values visible", async ({ page, request }) => {
  const jobId = await seedApprovableJob(request, TENANT);
  const co = await createChangeOrderViaForm(request, TENANT, jobId, { revenue_adjustment: "1234", direct_cost_adjustment: "567", labor_hours_adjustment: "0" });
  await submitCo(request, TENANT, jobId, co.id);
  await approveCo(request, TENANT, jobId, co.id);

  const versionRows = await querySql<{ id: string }>(request, `SELECT id FROM job_budget_versions WHERE company_id = ? AND job_id = ?`, [TENANT, jobId]);
  const versionId = versionRows[0].id;
  // needs_review is only ever set by the historical-data backfill in this
  // codebase's design (never ordinary approval flow) — simulate that here
  // by flipping the flag directly, matching how job-progress-repos.test.ts
  // exercises resolveJobBudgetVersionReview.
  await exec(request, `UPDATE job_budget_versions SET needs_review = 1 WHERE id = ?`, [versionId]);

  await page.goto(`/change-orders/budget-versions/review?tenant_id=${TENANT}&role=owner`);
  await expect(page.getByTestId("needs-review-list")).toBeVisible();
  await expect(page.getByTestId(`review-row-${versionId}`)).toBeVisible();
  // money() (src/ui/layout.tsx) renders whole dollars with 2 decimals and
  // thousands separators: a $1234 revenue adjustment -> "$1,234.00".
  await expect(page.getByTestId(`review-row-${versionId}`)).toContainText("$1,234.00"); // revised contract value visible in the row
  await expect(page.getByTestId(`review-row-${versionId}`)).toContainText("$567.00"); // revised direct-cost budget visible in the row
});

test("CO-17 resolving review changes only the review flag; approved financial values are untouched", async ({ page, request }) => {
  const jobId = await seedApprovableJob(request, TENANT);
  const co = await createChangeOrderViaForm(request, TENANT, jobId, { revenue_adjustment: "1000", direct_cost_adjustment: "500", labor_hours_adjustment: "0" });
  await submitCo(request, TENANT, jobId, co.id);
  await approveCo(request, TENANT, jobId, co.id);

  const before = await querySql<{ id: string; contract_value_cents: number; direct_cost_budget_cents: number; budgeted_overhead_cents: number; approved_at: string; approved_by: string }>(
    request, `SELECT id, contract_value_cents, direct_cost_budget_cents, budgeted_overhead_cents, approved_at, approved_by FROM job_budget_versions WHERE company_id = ? AND job_id = ?`,
    [TENANT, jobId],
  );
  const versionId = before[0].id;
  await exec(request, `UPDATE job_budget_versions SET needs_review = 1 WHERE id = ?`, [versionId]);

  await page.goto(`/change-orders/budget-versions/review?tenant_id=${TENANT}&role=office`);
  await page.getByTestId(`resolve-review-${versionId}`).click();
  await expect(page.getByTestId("notice")).toContainText("reviewed");

  const after = await querySql<{ contract_value_cents: number; direct_cost_budget_cents: number; budgeted_overhead_cents: number; approved_at: string; approved_by: string; needs_review: number }>(
    request, `SELECT contract_value_cents, direct_cost_budget_cents, budgeted_overhead_cents, approved_at, approved_by, needs_review FROM job_budget_versions WHERE id = ?`,
    [versionId],
  );
  expect(after[0].needs_review).toBe(0); // only this column changed
  expect(after[0].contract_value_cents).toBe(before[0].contract_value_cents);
  expect(after[0].direct_cost_budget_cents).toBe(before[0].direct_cost_budget_cents);
  expect(after[0].budgeted_overhead_cents).toBe(before[0].budgeted_overhead_cents);
  expect(after[0].approved_at).toBe(before[0].approved_at);
  expect(after[0].approved_by).toBe(before[0].approved_by);

  // Resolving it a second time is refused (already_resolved), never a
  // silent success and never a route that mutates financial fields.
  const resolveAgain = await request.post(`/change-orders/budget-versions/${versionId}/resolve-review?tenant_id=${TENANT}&role=office`, { form: {}, maxRedirects: 0 });
  expect(resolveAgain.headers()["location"] ?? "").toContain("error=already_resolved");
});

test("CO-18 prior budget versions remain visible and immutable; the active version is distinguishable from priors", async ({ page, request }) => {
  const jobId = await seedApprovableJob(request, TENANT);
  const co1 = await createChangeOrderViaForm(request, TENANT, jobId, { revenue_adjustment: "1000", direct_cost_adjustment: "0", labor_hours_adjustment: "0" });
  await submitCo(request, TENANT, jobId, co1.id);
  await approveCo(request, TENANT, jobId, co1.id);

  const co2 = await createChangeOrderViaForm(request, TENANT, jobId, { revenue_adjustment: "500", direct_cost_adjustment: "0", labor_hours_adjustment: "0" });
  await submitCo(request, TENANT, jobId, co2.id);
  await approveCo(request, TENANT, jobId, co2.id);

  await page.goto(`/change-orders?tenant_id=${TENANT}&role=owner&job_id=${jobId}`);
  const versions = await querySql<{ id: string; revision_seq: number; contract_value_cents: number }>(
    request, `SELECT id, revision_seq, contract_value_cents FROM job_budget_versions WHERE company_id = ? AND job_id = ? ORDER BY revision_seq`, [TENANT, jobId],
  );
  expect(versions.length).toBe(2);
  const [rev0, rev1] = versions;

  // Both rows are still visible in the page's history table.
  await expect(page.getByTestId(`budget-version-${rev0.id}`)).toBeVisible();
  await expect(page.getByTestId(`budget-version-${rev1.id}`)).toBeVisible();
  // Only the latest carries the "current" badge.
  await expect(page.getByTestId(`budget-version-active-${rev1.id}`)).toBeVisible();
  await expect(page.getByTestId(`budget-version-active-${rev0.id}`)).toHaveCount(0);
  // Revision 0's stored total is exactly what it was when created — never
  // rewritten by revision 1's approval.
  expect(rev0.contract_value_cents).toBe(100000);
  expect(rev1.contract_value_cents).toBe(150000);
});

// ── Completion methods ───────────────────────────────────────────────────────

test("CO-19 completion_method=manual: accepts a valid 0-100 percentage, rejects out-of-range values", async ({ page, request }) => {
  const jobId = await seedApprovableJob(request, TENANT);
  const co = await createChangeOrderViaForm(request, TENANT, jobId, { revenue_adjustment: "100" });
  await submitCo(request, TENANT, jobId, co.id);
  await approveCo(request, TENANT, jobId, co.id, "owner"); // no completion override -> defaults to cost_to_cost; flip it below

  const versionRows = await querySql<{ id: string }>(request, `SELECT id FROM job_budget_versions WHERE company_id = ? AND job_id = ?`, [TENANT, jobId]);
  await exec(request, `UPDATE job_budget_versions SET completion_method = 'manual' WHERE id = ?`, [versionRows[0].id]);

  await page.goto(`/change-orders?tenant_id=${TENANT}&role=office&job_id=${jobId}`);
  await expect(page.getByTestId("current-completion-method")).toContainText("manual");
  await expect(page.getByTestId("manual-completion-input")).toBeVisible();
  await expect(page.getByTestId("service-units-completed-input")).toHaveCount(0);

  await page.getByTestId("manual-completion-input").fill("42.5");
  await page.getByTestId("completion-config-save").click();
  await expect(page.getByTestId("notice")).toContainText("Saved");

  let progress = await querySql<{ completion_pct_millionths: number }>(request, `SELECT completion_pct_millionths FROM work_orders WHERE company_id = ? AND id = ?`, [TENANT, jobId]);
  expect(progress[0].completion_pct_millionths).toBe(425000); // 42.5% -> millionths

  // Out-of-range (>100) is rejected, not clamped, and the prior valid value survives.
  const badRes = await request.post(`/change-orders/progress?tenant_id=${TENANT}&role=office&job_id=${jobId}`, { form: { manual_completion_pct: "150" }, maxRedirects: 0 });
  expect(badRes.headers()["location"] ?? "").toContain("error=invalid_budget");
  progress = await querySql<{ completion_pct_millionths: number }>(request, `SELECT completion_pct_millionths FROM work_orders WHERE company_id = ? AND id = ?`, [TENANT, jobId]);
  expect(progress[0].completion_pct_millionths).toBe(425000); // unchanged by the rejected attempt

  // Non-numeric garbage is likewise rejected.
  const garbageRes = await request.post(`/change-orders/progress?tenant_id=${TENANT}&role=office&job_id=${jobId}`, { form: { manual_completion_pct: "not-a-number" }, maxRedirects: 0 });
  expect(garbageRes.headers()["location"] ?? "").toContain("error=invalid_budget");
});

test("CO-20 completion_method=service_units: accepts completed units up to plan, requires a planned-units figure to exist first", async ({ page, request }) => {
  const jobId = await seedApprovableJob(request, TENANT);
  const co = await createChangeOrderViaForm(request, TENANT, jobId, { revenue_adjustment: "600" });
  await submitCo(request, TENANT, jobId, co.id);
  await approveCo(request, TENANT, jobId, co.id);

  const versionRows = await querySql<{ id: string }>(request, `SELECT id FROM job_budget_versions WHERE company_id = ? AND job_id = ?`, [TENANT, jobId]);
  const versionId = versionRows[0].id;
  await exec(request, `UPDATE job_budget_versions SET completion_method = 'service_units', service_units_planned = 4 WHERE id = ?`, [versionId]);

  await page.goto(`/change-orders?tenant_id=${TENANT}&role=office&job_id=${jobId}`);
  await expect(page.getByTestId("service-units-planned-display")).toContainText("4");
  await page.getByTestId("service-units-completed-input").fill("3");
  await page.getByTestId("completion-config-save").click();
  await expect(page.getByTestId("notice")).toContainText("Saved");

  const rows = await querySql<{ service_units_completed: number }>(request, `SELECT service_units_completed FROM work_orders WHERE company_id = ? AND id = ?`, [TENANT, jobId]);
  expect(rows[0].service_units_completed).toBe(3);

  // A record with service_units_planned NULL (not yet set on the budget
  // version) refuses a progress write entirely, rather than accepting
  // units against an undefined plan.
  await exec(request, `UPDATE job_budget_versions SET service_units_planned = NULL WHERE id = ?`, [versionId]);
  const res = await request.post(`/change-orders/progress?tenant_id=${TENANT}&role=office&job_id=${jobId}`, { form: { service_units_completed: "2" }, maxRedirects: 0 });
  expect(res.headers()["location"] ?? "").toContain("error=no_service_units_planned");
});

test("CO-21 completion_method=cost_to_cost and completed: no manual input accepted or rendered", async ({ page, request }) => {
  const jobId = await seedApprovableJob(request, TENANT);
  const co = await createChangeOrderViaForm(request, TENANT, jobId, { revenue_adjustment: "100" });
  await submitCo(request, TENANT, jobId, co.id);
  await approveCo(request, TENANT, jobId, co.id); // defaults to cost_to_cost

  await page.goto(`/change-orders?tenant_id=${TENANT}&role=office&job_id=${jobId}`);
  await expect(page.getByTestId("current-completion-method")).toContainText("cost_to_cost");
  await expect(page.getByTestId("no-manual-input-needed")).toBeVisible();
  await expect(page.getByTestId("manual-completion-input")).toHaveCount(0);
  await expect(page.getByTestId("service-units-completed-input")).toHaveCount(0);

  const versionRows = await querySql<{ id: string }>(request, `SELECT id FROM job_budget_versions WHERE company_id = ? AND job_id = ?`, [TENANT, jobId]);
  await exec(request, `UPDATE job_budget_versions SET completion_method = 'completed' WHERE id = ?`, [versionRows[0].id]);
  await page.goto(`/change-orders?tenant_id=${TENANT}&role=office&job_id=${jobId}`);
  await expect(page.getByTestId("current-completion-method")).toContainText("completed");
  await expect(page.getByTestId("no-manual-input-needed")).toBeVisible();

  // A POST for either no-input method is a safe, tenant-scoped no-op save —
  // never an error, but also never invents a progress value.
  const res = await request.post(`/change-orders/progress?tenant_id=${TENANT}&role=office&job_id=${jobId}`, { form: {}, maxRedirects: 0 });
  expect(res.headers()["location"] ?? "").toContain("saved=1");
});

test("CO-22 a job with no approved budget version yet cannot be configured, and surfaces the review-needed note instead of guessed values", async ({ page, request }) => {
  const jobId = await seedApprovableJob(request, TENANT);
  // No change order created/approved for this job at all.
  await page.goto(`/change-orders?tenant_id=${TENANT}&role=office&job_id=${jobId}`);
  await expect(page.getByTestId("no-budget-version-note")).toBeVisible();
  await expect(page.getByTestId("completion-config-form")).toHaveCount(0);
});

test("CO-23 tenant scope and authorization on the progress-configuration route itself", async ({ request }) => {
  const jobId = await seedApprovableJob(request, TENANT);
  const co = await createChangeOrderViaForm(request, TENANT, jobId, { revenue_adjustment: "100" });
  await submitCo(request, TENANT, jobId, co.id);
  await approveCo(request, TENANT, jobId, co.id);

  const res = await request.post(`/change-orders/progress?tenant_id=${TENANT}&role=crew&job_id=${jobId}`, { form: { manual_completion_pct: "50" } });
  expect(res.status()).toBe(403);

  // A crafted request against another tenant's job_id, spoofing our own
  // tenant_id, must not read/affect the foreign job's work_orders row —
  // getLatestJobBudgetVersion is company-scoped so `latest` resolves null
  // for a foreign job_id under our tenant, and the route no-ops safely.
  const foreignJobId = await seedApprovableJob(request, OTHER_TENANT);
  const crossRes = await request.post(`/change-orders/progress?tenant_id=${TENANT}&role=office&job_id=${foreignJobId}`, { form: { manual_completion_pct: "50" }, maxRedirects: 0 });
  expect(crossRes.headers()["location"] ?? "").toContain("saved=1"); // no-op save, no method resolved for a job not in this tenant
  const foreignRow = await querySql<{ completion_pct_millionths: number | null }>(request, `SELECT completion_pct_millionths FROM work_orders WHERE id = ?`, [foreignJobId]);
  expect(foreignRow[0].completion_pct_millionths).toBeNull();
});

// ── Routing regression coverage (protects the 2041171 basePath/routerRoot fix) ─

test("CO-24 routing regression: every route uses the real mounted /change-orders path, never /finance/change-orders, never doubled", async ({ page, request }) => {
  const jobId = await seedApprovableJob(request, TENANT);

  // List page.
  await page.goto(`/change-orders?tenant_id=${TENANT}&role=office&job_id=${jobId}`);
  let html = await page.content();
  expect(html).not.toContain("/finance/change-orders");
  expect(html).not.toMatch(/\/change-orders\/change-orders/);
  await expect(page.getByTestId("co-new-link")).toHaveAttribute("href", new RegExp(`^/change-orders/new\\?`));

  // New form.
  await page.goto(`/change-orders/new?tenant_id=${TENANT}&role=office&job_id=${jobId}`);
  const formAction = await page.getByTestId("co-form").getAttribute("action");
  expect(formAction).toMatch(/^\/change-orders\/new\?/);
  expect(formAction).not.toContain("/finance/change-orders");

  // Create -> redirect lands on a real 200 list page at the correct mount.
  const createRes = await page.goto(`/change-orders/new?tenant_id=${TENANT}&role=office&job_id=${jobId}`);
  expect(createRes?.status()).toBe(200);
  await page.getByTestId("co-description-input").fill("routing check");
  await page.getByTestId("co-reason-input").fill("routing check");
  await page.getByTestId("co-revenue-adjustment-input").fill("10");
  await page.getByTestId("co-direct-cost-adjustment-input").fill("0");
  await page.getByTestId("co-labor-hours-adjustment-input").fill("0");
  const [afterCreate] = await Promise.all([page.waitForNavigation(), page.getByTestId("co-form-save").click()]);
  expect(afterCreate?.status()).toBe(200);
  expect(page.url()).toMatch(/\/change-orders\?/);
  expect(page.url()).not.toContain("/finance/change-orders");

  const rows = await querySql<{ id: string }>(request, `SELECT id FROM change_orders WHERE company_id = ? AND job_id = ? ORDER BY rowid DESC LIMIT 1`, [TENANT, jobId]);
  const coId = rows[0].id;

  // Edit form action + update redirect.
  await page.goto(`/change-orders/${coId}/edit?tenant_id=${TENANT}&role=office&job_id=${jobId}`);
  const editAction = await page.getByTestId("co-form").getAttribute("action");
  expect(editAction).toMatch(new RegExp(`^/change-orders/${coId}/edit\\?`));
  const [afterEdit] = await Promise.all([page.waitForNavigation(), page.getByTestId("co-form-save").click()]);
  expect(afterEdit?.status()).toBe(200);

  // Submit action.
  await page.goto(`/change-orders?tenant_id=${TENANT}&role=office&job_id=${jobId}`);
  await expect(page.getByTestId(`co-submit-${coId}`).locator("xpath=..")).toHaveAttribute("action", new RegExp(`^/change-orders/${coId}/submit\\?`));
  const [afterSubmit] = await Promise.all([page.waitForNavigation(), page.getByTestId(`co-submit-${coId}`).click()]);
  expect(afterSubmit?.status()).toBe(200);

  // Reject action (use a fresh CO to avoid disturbing the approve-flow one below).
  const co2 = await createChangeOrderViaForm(request, TENANT, jobId, { description: "reject-route-check" });
  await submitCo(request, TENANT, jobId, co2.id);
  await page.goto(`/change-orders?tenant_id=${TENANT}&role=owner&job_id=${jobId}`);
  await expect(page.getByTestId(`co-reject-${co2.id}`).locator("xpath=..")).toHaveAttribute("action", new RegExp(`^/change-orders/${co2.id}/reject\\?`));
  await page.getByTestId(`co-reject-reason-${co2.id}`).fill("routing check");
  const [afterReject] = await Promise.all([page.waitForNavigation(), page.getByTestId(`co-reject-${co2.id}`).click()]);
  expect(afterReject?.status()).toBe(200);

  // Void action (another fresh CO).
  const co3 = await createChangeOrderViaForm(request, TENANT, jobId, { description: "void-route-check" });
  await page.goto(`/change-orders?tenant_id=${TENANT}&role=office&job_id=${jobId}`);
  await expect(page.getByTestId(`co-void-${co3.id}`).locator("xpath=..")).toHaveAttribute("action", new RegExp(`^/change-orders/${co3.id}/void\\?`));
  await page.getByTestId(`co-void-reason-${co3.id}`).fill("routing check");
  const [afterVoid] = await Promise.all([page.waitForNavigation(), page.getByTestId(`co-void-${co3.id}`).click()]);
  expect(afterVoid?.status()).toBe(200);

  // Approve action.
  await page.goto(`/change-orders?tenant_id=${TENANT}&role=owner&job_id=${jobId}`);
  await expect(page.getByTestId(`co-approve-${coId}`).locator("xpath=..")).toHaveAttribute("action", new RegExp(`^/change-orders/${coId}/approve\\?`));
  const [afterApprove] = await Promise.all([page.waitForNavigation(), page.getByTestId(`co-approve-${coId}`).click()]);
  expect(afterApprove?.status()).toBe(200);
  expect(page.url()).toContain("approved=1");

  // Review queue + resolve-review, BOTH branches (with job_id and without —
  // exactly where the original doubled-path bug lived, per 2041171).
  const versionRows = await querySql<{ id: string }>(request, `SELECT id FROM job_budget_versions WHERE company_id = ? AND job_id = ?`, [TENANT, jobId]);
  const versionId = versionRows[0].id;
  await exec(request, `UPDATE job_budget_versions SET needs_review = 1 WHERE id = ?`, [versionId]);

  // Branch (a): reached from the job's own page (job_id present in qs).
  await page.goto(`/change-orders?tenant_id=${TENANT}&role=owner&job_id=${jobId}`);
  await expect(page.getByTestId(`resolve-review-${versionId}`).locator("xpath=..")).toHaveAttribute(
    "action", new RegExp(`^/change-orders/budget-versions/${versionId}/resolve-review\\?`),
  );

  // Branch (b): reached from the tenant-wide review queue (no job_id) —
  // the exact case that used to double the path.
  await page.goto(`/change-orders/budget-versions/review?tenant_id=${TENANT}&role=owner`);
  html = await page.content();
  expect(html).not.toContain("/finance/change-orders");
  expect(html).not.toMatch(/\/change-orders\/change-orders/);
  await expect(page.getByTestId(`resolve-review-${versionId}`).locator("xpath=..")).toHaveAttribute(
    "action", new RegExp(`^/change-orders/budget-versions/${versionId}/resolve-review\\?`),
  );
  const [afterResolve] = await Promise.all([page.waitForNavigation(), page.getByTestId(`resolve-review-${versionId}`).click()]);
  expect(afterResolve?.status()).toBe(200);
  expect(page.url()).toMatch(/\/change-orders\/budget-versions\/review\?/);
  expect(page.url()).not.toContain("/finance/change-orders");
  expect(page.url()).not.toMatch(/\/change-orders\/change-orders/);
  expect(page.url()).toContain("resolved=1");
});

test("CO-25 validation/authorization failures redirect with an error, never a bare 404 or a false 200 success", async ({ request }) => {
  const jobId = await seedApprovableJob(request, TENANT);

  // A reject with no reason: 302 + error, not a 404, not a silent 200 "success".
  const co = await createChangeOrderViaForm(request, TENANT, jobId);
  await submitCo(request, TENANT, jobId, co.id);
  const noReasonRes = await request.post(`/change-orders/${co.id}/reject?tenant_id=${TENANT}&role=owner&job_id=${jobId}`, { form: {}, maxRedirects: 0 });
  expect(noReasonRes.status()).toBe(302);
  expect(noReasonRes.headers()["location"] ?? "").toContain("error=reason_required");

  // A void with no reason: same shape.
  const co2 = await createChangeOrderViaForm(request, TENANT, jobId);
  const noReasonVoid = await request.post(`/change-orders/${co2.id}/void?tenant_id=${TENANT}&role=office&job_id=${jobId}`, { form: {}, maxRedirects: 0 });
  expect(noReasonVoid.status()).toBe(302);
  expect(noReasonVoid.headers()["location"] ?? "").toContain("error=reason_required");

  // A GET edit for a nonexistent CO id returns 404, not a 200 with an empty form.
  const notFoundRes = await request.get(`/change-orders/no-such-id/edit?tenant_id=${TENANT}&role=office`);
  expect(notFoundRes.status()).toBe(404);

  // The error page for the failed reject is itself a real 200 render (not
  // a broken/blank page), confirmed by following the redirect location.
  const followUp = await request.get(`${new URL(noReasonRes.headers()["location"]!, "http://localhost").pathname}${new URL(noReasonRes.headers()["location"]!, "http://localhost").search}`);
  expect(followUp.status()).toBe(200);
});
