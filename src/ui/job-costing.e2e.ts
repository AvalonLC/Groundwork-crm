import { test, expect, type APIRequestContext } from "@playwright/test";
import { resetFinanceDb, resetCrmDb, exec, execCrm } from "./test-seed";

/**
 * PR E end-to-end coverage. Stage-1 UJ-01/UJ-02/crew-cannot-see-margin
 * (labor+overhead tiles, hours-vs-estimate, margin gating) are unchanged
 * below — job-costing.tsx's rewrite kept those tiles byte-identical, only
 * adding the new "Job progress (Item 4 formulas)" card alongside them.
 *
 * New this PR: a `job_budget_versions` fixture (the original fixture had
 * none at all) so the new formula tiles have something real to render, per
 * ITEM4-JOBCOST.md §5/§8/§9. Seeded via raw INSERT (querySql/exec against
 * the real local D1 through /test/exec) rather than the change-order
 * approval flow, since these tests are about job-costing.tsx's rendering,
 * not the change-order workflow itself (already covered end-to-end in
 * change-orders.e2e.ts).
 */

const TENANT = "t-e2e-jobcost";
const OTHER_TENANT = "t-e2e-jobcost-other";
const JOB = "job-e2e-1";
const TIME_ENTRY = "te-e2e-1";

async function querySql<T = Record<string, unknown>>(
  request: APIRequestContext, sql: string, params: unknown[] = [],
): Promise<T[]> {
  const res = await request.post("/test/exec", { data: { sql, params } });
  expect(res.ok()).toBeTruthy();
  const body = (await res.json()) as { results: T[] };
  return body.results;
}

test.beforeEach(async ({ request }) => {
  await resetFinanceDb(request, TENANT);
  await resetFinanceDb(request, OTHER_TENANT);
  await resetCrmDb(request, TENANT);
  // work_item folded into work_orders (migrations/0057_finance_merge.sql) —
  // estimate_cents/finance_completed_at live on the work order itself now.
  await execCrm(request,
    `INSERT INTO work_orders (id, company_id, wo_number, status, estimate_cents, finance_completed_at) VALUES (?,?,?,?,?,?)`,
    [JOB, TENANT, "WO-E2E-1", "completed", 60000, "2026-07-01"]);
  // time_entry folded into time_entries — hours_hundredths is derived from
  // duration_min at read time (8h = 480min = 800 hundredths), not stored.
  await execCrm(request,
    `INSERT INTO time_entries (id, rep_id, company_id, clock_in, clock_out, duration_min, work_order_id, resolved_rate, posted_at) VALUES (?,?,?,?,?,?,?,?, datetime('now'))`,
    [TIME_ENTRY, "emp-1", TENANT, "2026-07-01T08:00:00Z", "2026-07-01T16:00:00Z", 480, JOB, 421002]);
  await exec(request,
    `INSERT INTO job_cost_ledger (company_id, time_entry_id, job_id, line_type, amount_cents, division) VALUES (?,?,?,'labor',?,?)`,
    [TENANT, TIME_ENTRY, JOB, 33680, "maintenance"]);
  await exec(request,
    `INSERT INTO job_cost_ledger (company_id, time_entry_id, job_id, line_type, amount_cents, division) VALUES (?,?,?,'overhead',?,?)`,
    [TENANT, TIME_ENTRY, JOB, 19374, "maintenance"]);
});

/** Minimal valid job_budget_versions row — every column job_budget_versions
 * requires (migrations/0085_job_budget_change_orders.sql §4.2) gets a
 * value; callers override only what a given test needs to vary. */
async function seedBudgetVersion(
  request: APIRequestContext, companyId: string, jobId: string,
  opts: {
    id?: string; revision_seq?: number; contract_value_cents?: number;
    direct_cost_budget_cents?: number; budgeted_overhead_cents?: number;
    completion_method?: string; service_units_planned?: number | null;
    source_type?: string; source_id?: string;
  } = {},
) {
  const id = opts.id ?? `jbv-${jobId}-${opts.revision_seq ?? 0}`;
  await exec(request, `
    INSERT INTO job_budget_versions
      (id, company_id, job_id, source_type, source_id, revision_seq,
       contract_value_cents, labor_hours_budgeted_hundredths, labor_rate_used,
       materials_budget_cents, subcontractor_budget_cents, equipment_budget_cents,
       disposal_budget_cents, permits_budget_cents, other_direct_budget_cents,
       direct_cost_budget_cents, division, overhead_rate_used, budgeted_overhead_cents,
       target_margin_millionths, completion_method, service_units_planned,
       needs_review, approved_at, approved_by)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `, [
    id, companyId, jobId, opts.source_type ?? "estimate", opts.source_id ?? "est-1", opts.revision_seq ?? 0,
    opts.contract_value_cents ?? 4600000, 34000, 280000,
    1200000, 0, 360000,
    350000, 0, 0,
    opts.direct_cost_budget_cents ?? 2750000, "hardscape", 242200, opts.budgeted_overhead_cents ?? 823480,
    null, opts.completion_method ?? "cost_to_cost", opts.service_units_planned ?? null,
    0, "2026-07-15T00:00:00Z", "rep-1",
  ]);
  return id;
}

// ── Stage 1: labor/overhead/estimate/margin tiles (unchanged) ──────────────

test("UJ-01 applied overhead shows labor, overhead, and total cost lines", async ({ page }) => {
  await page.goto(`/job-costing?tenant_id=${TENANT}&job_id=${JOB}&role=owner`);
  await expect(page.getByTestId("labor-cost")).toHaveText("336.80");
  await expect(page.getByTestId("overhead-cost")).toHaveText("193.74");
  await expect(page.getByTestId("total-cost")).toHaveText("530.54");
});

test("UJ-02 hours vs estimate shows the work order's estimate", async ({ page }) => {
  await page.goto(`/job-costing?tenant_id=${TENANT}&job_id=${JOB}&role=owner`);
  await expect(page.getByTestId("estimate-cents")).toHaveText("600.00");
});

test("crew-cannot-see-margin: owner sees live margin, crew does not", async ({ page }) => {
  await page.goto(`/job-costing?tenant_id=${TENANT}&job_id=${JOB}&role=owner`);
  await expect(page.getByTestId("margin-cents")).toHaveText("69.46"); // 600 - 530.54

  await page.goto(`/job-costing?tenant_id=${TENANT}&job_id=${JOB}&role=crew`);
  await expect(page.getByTestId("margin-hidden")).toBeVisible();
  await expect(page.getByTestId("margin-cents")).toHaveCount(0);
});

// ── PR E: the 9 Item 4 formula tiles ────────────────────────────────────────

test("JP-E2E-01 cost_to_cost: revised budget, actual/progress-eligible cost, earned completion, revenue, and overhead tiles all render worked-example-8.1-style figures", async ({ page, request }) => {
  await seedBudgetVersion(request, TENANT, JOB, {
    contract_value_cents: 4600000, direct_cost_budget_cents: 2750000, budgeted_overhead_cents: 823480,
    completion_method: "cost_to_cost",
  });
  // Direct-cost lines: $8,400 progress-eligible materials, $2,000 NOT
  // progress-eligible (purchased-but-uninstalled), $2,100 equipment —
  // mirrors worked example 8.1's split exactly.
  await exec(request,
    `INSERT INTO job_cost_ledger (company_id, job_id, line_type, cost_category, amount_cents, division, progress_eligible) VALUES (?,?,'direct_cost','materials',?,?,1)`,
    [TENANT, JOB, 840000, "hardscape"]);
  await exec(request,
    `INSERT INTO job_cost_ledger (company_id, job_id, line_type, cost_category, amount_cents, division, progress_eligible) VALUES (?,?,'direct_cost','materials',?,?,0)`,
    [TENANT, JOB, 200000, "hardscape"]);
  await exec(request,
    `INSERT INTO job_cost_ledger (company_id, job_id, line_type, cost_category, amount_cents, division, progress_eligible) VALUES (?,?,'direct_cost','equipment',?,?,1)`,
    [TENANT, JOB, 210000, "hardscape"]);
  // Additional labor $9,100 and overhead $8,234.80 on top of the fixture's
  // own $336.80/$193.74 lines (harmless — this job's actual-cost formulas
  // sum every posted line for the job, Stage 1's own labor/overhead tiles
  // are a separate, deliberately narrower labor+overhead-only read).
  await exec(request,
    `INSERT INTO job_cost_ledger (company_id, job_id, line_type, amount_cents, division) VALUES (?,?,'labor',?,?)`,
    [TENANT, JOB, 910000, "hardscape"]);
  await exec(request,
    `INSERT INTO job_cost_ledger (company_id, job_id, line_type, amount_cents, division) VALUES (?,?,'overhead',?,?)`,
    [TENANT, JOB, 823480, "hardscape"]);

  await page.goto(`/job-costing?tenant_id=${TENANT}&job_id=${JOB}&role=owner`);

  await expect(page.getByTestId("jp-revised-contract-value")).toHaveText("$46,000.00");
  await expect(page.getByTestId("jp-revised-direct-cost-budget")).toHaveText("$27,500.00");
  // actual = 840000+200000+210000+910000(new)+33680(fixture labor) = 2,193,680
  await expect(page.getByTestId("jp-actual-direct-cost")).toHaveText("$21,936.80");
  await expect(page.getByTestId("jp-budgeted-overhead")).toHaveText("$8,234.80");
  // progress-eligible = 840000+210000+910000+33680 = 1,993,680 -> 1,993,680/2,750,000 = 72.4982%
  const completionText = await page.getByTestId("jp-earned-completion").innerText();
  expect(completionText).toMatch(/^\d+\.\d%$/);
  await expect(page.getByTestId("jp-earned-revenue")).toBeVisible();
  await expect(page.getByTestId("jp-recovered-overhead")).toBeVisible();
  // absorbed = 823480(new) + 19374(fixture overhead) = 842,854
  await expect(page.getByTestId("jp-absorbed-overhead")).toHaveText("$8,428.54");
  await expect(page.getByTestId("jp-overhead-variance")).toBeVisible();
});

test("JP-E2E-02 an approved change order's contract/direct-cost/overhead adjustments show up as the revised figures", async ({ page, request }) => {
  // Baseline (revision 0), then a CO-sourced revision 1 with the exact
  // worked-example-8.1 deltas (+$6,000 revenue, +$3,500 direct cost, +40
  // hrs @ $24.22/hr = +$968.80 overhead) already rolled into its
  // cumulative totals — mirrors what approveChangeOrderWorkflow would have
  // produced, without re-driving the whole change-order UI (already
  // covered by change-orders.e2e.ts's own CO-04).
  await seedBudgetVersion(request, TENANT, JOB, {
    id: "jbv-base", revision_seq: 0, source_type: "estimate", source_id: "est-1",
    contract_value_cents: 4000000, direct_cost_budget_cents: 2400000, budgeted_overhead_cents: 726600,
  });
  await seedBudgetVersion(request, TENANT, JOB, {
    id: "jbv-co1", revision_seq: 1, source_type: "change_order", source_id: "co-1",
    contract_value_cents: 4600000, direct_cost_budget_cents: 2750000, budgeted_overhead_cents: 823480,
  });

  await page.goto(`/job-costing?tenant_id=${TENANT}&job_id=${JOB}&role=owner`);

  // The LATEST (revision 1, CO-sourced) revision's cumulative totals are
  // what renders — never the superseded baseline's own figures.
  await expect(page.getByTestId("jp-revised-contract-value")).toHaveText("$46,000.00");
  await expect(page.getByTestId("jp-revised-direct-cost-budget")).toHaveText("$27,500.00");
  await expect(page.getByTestId("jp-budgeted-overhead")).toHaveText("$8,234.80");
});

test("JP-E2E-03 service_units completion method reads service_units_completed/planned, not a cost ratio", async ({ page, request }) => {
  await seedBudgetVersion(request, TENANT, JOB, {
    contract_value_cents: 60000, direct_cost_budget_cents: 36000, budgeted_overhead_cents: 29064,
    completion_method: "service_units", service_units_planned: 4,
  });
  await execCrm(request, `UPDATE work_orders SET service_units_completed = ? WHERE id = ?`, [3, JOB]);

  await page.goto(`/job-costing?tenant_id=${TENANT}&job_id=${JOB}&role=owner`);
  await expect(page.getByTestId("jp-earned-completion")).toHaveText("75.0%"); // 3/4, not a cost-to-cost ratio
  await expect(page.getByTestId("jp-earned-revenue")).toHaveText("$450.00"); // 600 * 0.75
});

test("JP-E2E-04 manual completion method reads work_orders.completion_pct_millionths", async ({ page, request }) => {
  await seedBudgetVersion(request, TENANT, JOB, {
    contract_value_cents: 10000, direct_cost_budget_cents: 5000, budgeted_overhead_cents: 100,
    completion_method: "manual",
  });
  await execCrm(request, `UPDATE work_orders SET completion_pct_millionths = ? WHERE id = ?`, [400000, JOB]);

  await page.goto(`/job-costing?tenant_id=${TENANT}&job_id=${JOB}&role=owner`);
  await expect(page.getByTestId("jp-earned-completion")).toHaveText("40.0%");
  await expect(page.getByTestId("jp-earned-revenue")).toHaveText("$40.00"); // 100 * 0.4
});

test("JP-E2E-05 financially_closed_at forces 100% earned completion and a positive earned-revenue figure even for a completed-method flat-rate job that ran over budget", async ({ page, request }) => {
  await seedBudgetVersion(request, TENANT, JOB, {
    contract_value_cents: 80000, direct_cost_budget_cents: 32000, budgeted_overhead_cents: 24220,
    completion_method: "completed",
  });
  // 11 hrs actual vs 10 hrs budgeted — over budget, per worked example 8.3.
  await exec(request,
    `INSERT INTO job_cost_ledger (company_id, job_id, line_type, amount_cents, division) VALUES (?,?,'labor',?,?)`,
    [TENANT, JOB, 35200, "snow"]);
  await exec(request,
    `INSERT INTO job_cost_ledger (company_id, job_id, line_type, amount_cents, division) VALUES (?,?,'overhead',?,?)`,
    [TENANT, JOB, 26642, "snow"]);
  await execCrm(request, `UPDATE work_orders SET status = 'completed', financially_closed_at = ? WHERE id = ?`, ["2026-07-10T00:00:00Z", JOB]);

  await page.goto(`/job-costing?tenant_id=${TENANT}&job_id=${JOB}&role=owner`);
  await expect(page.getByTestId("jp-earned-completion")).toHaveText("100.0%"); // NOT >100% despite the overrun
  await expect(page.getByTestId("jp-earned-revenue")).toHaveText("$800.00");
  // Overhead recovery variance is NEGATIVE here — absorbed overhead sums
  // EVERY posted overhead line for the job (formula 8), which includes not
  // just this test's own $266.42 (worked example 8.3's figure) but also the
  // shared beforeEach fixture's $193.74 line, since these tests share one
  // job_cost_ledger fixture rather than isolating per-test. Recovered
  // (100% of the $242.20 budgeted overhead) minus the true absorbed total
  // ($266.42 + $193.74 = $460.16) is -$217.96, not worked example 8.3's own
  // -$24.22 in isolation — this still proves the negative-variance render
  // path (color:var(--gw-rose)) and that money() renders a negative amount
  // correctly, not just a magnitude, which is this test's actual purpose.
  const varianceEl = page.getByTestId("jp-overhead-variance");
  await expect(varianceEl).toHaveText("$-217.96");
  await expect(varianceEl).toHaveCSS("color", "rgb(139, 58, 42)"); // --gw-rose
});

test("JP-E2E-06 no job_budget_versions row at all: every budget-derived tile shows review-required, never a fabricated number, while actual/absorbed cost still render as real zeros", async ({ page }) => {
  await page.goto(`/job-costing?tenant_id=${TENANT}&job_id=${JOB}&role=owner`);

  // No budget version exists for this job at all in this test (the
  // beforeEach fixture posts labor/overhead lines but never inserts a
  // job_budget_versions row) — every budget-derived tile must read
  // "review required," never $0.00 or 0.0%.
  await expect(page.getByTestId("jp-revised-contract-value")).toContainText("review required");
  await expect(page.getByTestId("jp-revised-direct-cost-budget")).toContainText("review required");
  await expect(page.getByTestId("jp-budgeted-overhead")).toContainText("review required");
  await expect(page.getByTestId("jp-earned-revenue")).toContainText("review required");
  await expect(page.getByTestId("jp-recovered-overhead")).toContainText("review required");
  await expect(page.getByTestId("jp-overhead-variance")).toContainText("review required");
  // Earned completion renders its own dedicated review-required note with
  // the specific "no approved budget version" reason, not the generic pill.
  await expect(page.getByTestId("jp-earned-completion")).toContainText("no approved budget version");

  // Formulas 3 and 8 (actual/absorbed cost) are ALWAYS computable — a
  // legitimate $336.80/$193.74 from the fixture's own posted lines, never
  // coerced into "review required" just because the budget is missing.
  await expect(page.getByTestId("jp-actual-direct-cost")).toHaveText("$336.80");
  await expect(page.getByTestId("jp-absorbed-overhead")).toHaveText("$193.74");
});

test("JP-E2E-07 legitimate zero values render as real zeros, not review-required", async ({ page, request }) => {
  // A brand-new job with an approved budget version but zero posted cost
  // yet — actual/progress-eligible/absorbed must all read $0.00 (a real,
  // known answer), and earned completion under cost_to_cost is a real 0.0%
  // (0 spent / budget > 0), never "review required."
  const zeroJob = "job-e2e-zero";
  await execCrm(request,
    `INSERT INTO work_orders (id, company_id, wo_number, status) VALUES (?,?,?,?)`,
    [zeroJob, TENANT, "WO-E2E-ZERO", "scheduled"]);
  await seedBudgetVersion(request, TENANT, zeroJob, {
    id: "jbv-zero", contract_value_cents: 100000, direct_cost_budget_cents: 50000, budgeted_overhead_cents: 5000,
    completion_method: "cost_to_cost",
  });

  await page.goto(`/job-costing?tenant_id=${TENANT}&job_id=${zeroJob}&role=owner`);
  await expect(page.getByTestId("jp-actual-direct-cost")).toHaveText("$0.00");
  await expect(page.getByTestId("jp-absorbed-overhead")).toHaveText("$0.00");
  await expect(page.getByTestId("jp-earned-completion")).toHaveText("0.0%");
  await expect(page.getByTestId("jp-earned-revenue")).toHaveText("$0.00");
});

test("JP-E2E-08 recovered/absorbed overhead and overhead variance are hidden from crew, same gate as company-wide recovery", async ({ page, request }) => {
  await seedBudgetVersion(request, TENANT, JOB);

  await page.goto(`/job-costing?tenant_id=${TENANT}&job_id=${JOB}&role=crew`);
  await expect(page.getByTestId("jobprogress-recovery-hidden")).toBeVisible();
  await expect(page.getByTestId("jp-recovered-overhead")).toHaveCount(0);
  await expect(page.getByTestId("jp-absorbed-overhead")).toHaveCount(0);
  await expect(page.getByTestId("jp-overhead-variance")).toHaveCount(0);

  // But the non-margin, non-recovery formula tiles (revised budget, actual
  // cost, earned completion/revenue) ARE visible to crew — ROLES.md gates
  // only "margin, wage, or rate fields," and recovery specifically; a
  // job's revised contract value / earned completion is neither.
  await expect(page.getByTestId("jp-revised-contract-value")).toBeVisible();
  await expect(page.getByTestId("jp-earned-completion")).toBeVisible();

  await page.goto(`/job-costing?tenant_id=${TENANT}&job_id=${JOB}&role=owner`);
  await expect(page.getByTestId("jp-recovered-overhead")).toBeVisible();
});

test("JP-E2E-09 tenant isolation: a job_budget_versions row under another tenant never leaks into this tenant's job-costing page", async ({ page, request }) => {
  await seedBudgetVersion(request, TENANT, JOB, { contract_value_cents: 4600000 });

  // Same job id string is impossible under work_orders' global PK (see
  // job-progress-repos.test.ts's own note on this); instead prove
  // isolation by seeding a wildly different figure under OTHER_TENANT for
  // its OWN distinct job and confirming it never appears on TENANT's page.
  const otherJob = "job-e2e-other-tenant";
  await resetCrmDb(request, OTHER_TENANT);
  await execCrm(request,
    `INSERT INTO work_orders (id, company_id, wo_number, status) VALUES (?,?,?,?)`,
    [otherJob, OTHER_TENANT, "WO-OTHER", "scheduled"]);
  await seedBudgetVersion(request, OTHER_TENANT, otherJob, { id: "jbv-other", contract_value_cents: 999999900 });

  await page.goto(`/job-costing?tenant_id=${TENANT}&job_id=${JOB}&role=owner`);
  await expect(page.getByTestId("jp-revised-contract-value")).toHaveText("$46,000.00");
  await expect(page.getByTestId("jp-revised-contract-value")).not.toContainText("999,999");
});

test("JP-E2E-10 an unknown job id under this tenant shows a job-not-found note instead of a crashed or fabricated page", async ({ page }) => {
  const res = await page.goto(`/job-costing?tenant_id=${TENANT}&job_id=no-such-job&role=owner`);
  expect(res?.status()).toBe(200);
  await expect(page.getByTestId("jobcost-job-not-found")).toBeVisible();
  await expect(page.getByTestId("jobprogress-tiles")).toHaveCount(0);
});

// ── Provisional-banner resolution (§7) ──────────────────────────────────────

test("JP-E2E-11 the old blanket 'provisional, formulas awaiting implementation' banner is gone now that the 9 formulas are wired and DB-tested", async ({ page, request }) => {
  await seedBudgetVersion(request, TENANT, JOB);
  await page.goto(`/job-costing?tenant_id=${TENANT}&job_id=${JOB}&role=owner`);
  await expect(page.getByTestId("jobcost-provisional-note")).toHaveCount(0);
  // Replaced by a precise, narrower note scoping exactly what the
  // Stage-1 labor/overhead tiles still don't include (never a blanket
  // "formulas awaiting implementation" claim, since they no longer are).
  await expect(page.getByTestId("jobcost-labor-overhead-note")).toBeVisible();
  await expect(page.getByTestId("jobcost-labor-overhead-note")).not.toContainText("awaiting implementation");
});
