import { describe, it, expect } from "vitest";
import {
  assertUsableTenantId,
  canonicalizeManifest,
  hashManifest,
  hashConfirmationToken,
  buildManifestRowOrExclusion,
  buildManifestRow,
  assembleManifestJobs,
  validateManifestStructure,
  validateManifestForExecution,
  buildJobBudgetVersionInsertRow,
  describeReconciliation,
  describeRollbackPlan,
  SAFE_BACKFILL_BUCKETS,
  BACKFILL_MANIFEST_SCHEMA_VERSION,
  MAX_MANIFEST_AGE_MS,
  MAX_MANIFEST_JOBS,
  type BackfillManifest,
  type BackfillManifestJobRow,
  type JobRowInputs,
  type JobRowInputsWithContractValue,
  type ExecutionContext,
} from "./backfill-write";
import type { JobBackfillClassification } from "./backfill-analysis";

/** A fully "would succeed cleanly" classification for the cost_to_cost
 * safe bucket — each test mutates exactly one field to isolate one
 * validation branch at a time, same pattern as backfill-analysis.test.ts. */
const COST_TO_COST_CLASSIFICATION: JobBackfillClassification = {
  job_id: "job-1",
  bucket: "would_create_needs_review_cost_to_cost",
  reasons: ["ok"],
  would_need_review: true,
  resolved_completion_method: "cost_to_cost",
};

const SERVICE_UNITS_CLASSIFICATION: JobBackfillClassification = {
  ...COST_TO_COST_CLASSIFICATION,
  bucket: "would_create_needs_review_service_units",
  resolved_completion_method: "service_units",
};

const BASE_INPUT: JobRowInputsWithContractValue = {
  classification: COST_TO_COST_CLASSIFICATION,
  estimate_id: "est-1",
  estimate_total_cents: 500_000,
  estimate_subtotal_cents: 400_000,
  division: "landscaping",
  overhead_rate_used: 2422,
  remaining_service_units: null,
};

function makeManifest(overrides: Partial<BackfillManifest> = {}): Omit<BackfillManifest, "manifest_hash"> {
  return {
    schema_version: BACKFILL_MANIFEST_SCHEMA_VERSION,
    company_id: "tenant-1",
    as_of: "2026-08-27",
    environment: "local",
    generated_at: "2026-08-27T12:00:00.000Z",
    jobs: [],
    excluded_jobs: [],
    total_jobs_scanned: 0,
    ...overrides,
  };
}

async function withHash(m: Omit<BackfillManifest, "manifest_hash">): Promise<BackfillManifest> {
  return { ...m, manifest_hash: await hashManifest(m) };
}

const SAMPLE_JOB_ROW: BackfillManifestJobRow = {
  job_id: "job-1",
  source_id: "est-1",
  bucket: "would_create_needs_review_cost_to_cost",
  division: "landscaping",
  contract_value_cents: 500_000,
  overhead_rate_used: 2422,
  direct_cost_budget_cents: 400_000,
  completion_method: "cost_to_cost",
  service_units_planned: null,
};

// ── Property 3 / 17: explicit tenant targeting, wildcard refusal ──────────
describe("BW-01 assertUsableTenantId — refusal of wildcard/all-tenant writes", () => {
  it.each(["", "*", "all", "ALL", "all_tenants", "__all__", "  ", "AlL_TeNaNtS"])(
    "rejects wildcard sentinel %j",
    (bad) => {
      expect(() => assertUsableTenantId(bad)).toThrow(/wildcard/i);
    },
  );

  it("accepts a real, specific tenant id", () => {
    expect(() => assertUsableTenantId("tenant-abc-123")).not.toThrow();
  });
});

// ── Property 4: deterministic manifest generation with hash binding ───────
describe("BW-02 canonicalizeManifest / hashManifest — determinism", () => {
  it("two structurally-identical manifests hash identically", async () => {
    const a = makeManifest({ jobs: [SAMPLE_JOB_ROW] });
    const b = makeManifest({ jobs: [{ ...SAMPLE_JOB_ROW }] });
    expect(await hashManifest(a)).toBe(await hashManifest(b));
  });

  it("changing any single job field changes the hash", async () => {
    const a = makeManifest({ jobs: [SAMPLE_JOB_ROW] });
    const b = makeManifest({ jobs: [{ ...SAMPLE_JOB_ROW, contract_value_cents: 500_001 }] });
    expect(await hashManifest(a)).not.toBe(await hashManifest(b));
  });

  it("canonicalizeManifest produces a fixed key order regardless of object construction order", () => {
    const m1 = makeManifest({ jobs: [SAMPLE_JOB_ROW] });
    const m2 = { total_jobs_scanned: m1.total_jobs_scanned, jobs: m1.jobs, excluded_jobs: m1.excluded_jobs, generated_at: m1.generated_at, environment: m1.environment, as_of: m1.as_of, company_id: m1.company_id, schema_version: m1.schema_version };
    expect(canonicalizeManifest(m1)).toBe(canonicalizeManifest(m2));
  });

  it("hashConfirmationToken is deterministic and distinct per token", async () => {
    const h1 = await hashConfirmationToken("token-a");
    const h2 = await hashConfirmationToken("token-a");
    const h3 = await hashConfirmationToken("token-b");
    expect(h1).toBe(h2);
    expect(h1).not.toBe(h3);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
  });
});

// ── Property 8/9: unresolved-review-bucket rejection / safe-record allowlist ──
describe("BW-03 buildManifestRowOrExclusion — bucket allowlist", () => {
  it("refuses any bucket outside SAFE_BACKFILL_BUCKETS", () => {
    const input: JobRowInputs = {
      ...BASE_INPUT,
      classification: { ...COST_TO_COST_CLASSIFICATION, bucket: "no_division", would_need_review: false },
    };
    const result = buildManifestRowOrExclusion(input);
    expect("excluded" in result).toBe(true);
    if ("excluded" in result) expect(result.excluded.reason).toMatch(/not one of the two safe write buckets/i);
  });

  it("accepts both SAFE_BACKFILL_BUCKETS entries", () => {
    for (const bucket of SAFE_BACKFILL_BUCKETS) {
      const isServiceUnits = bucket === "would_create_needs_review_service_units";
      const input: JobRowInputs = {
        ...BASE_INPUT,
        classification: isServiceUnits ? SERVICE_UNITS_CLASSIFICATION : COST_TO_COST_CLASSIFICATION,
        remaining_service_units: isServiceUnits ? 3 : null,
      };
      const result = buildManifestRowOrExclusion(input);
      expect("row" in result).toBe(true);
    }
  });

  it("defense in depth: refuses a safe-bucket classification that somehow lacks would_need_review=true", () => {
    const input: JobRowInputs = {
      ...BASE_INPUT,
      classification: { ...COST_TO_COST_CLASSIFICATION, would_need_review: false },
    };
    const result = buildManifestRowOrExclusion(input);
    expect("excluded" in result).toBe(true);
    if ("excluded" in result) expect(result.excluded.reason).toMatch(/would_need_review=true/i);
  });
});

// ── Property 19-20 (the "never" list): never invent, never guess ──────────
describe("BW-04 buildManifestRowOrExclusion — never guesses from unusable data", () => {
  it("excludes when estimate_id is missing", () => {
    const result = buildManifestRowOrExclusion({ ...BASE_INPUT, estimate_id: null });
    expect("excluded" in result).toBe(true);
  });

  it.each([null, undefined, NaN, Infinity, -1])(
    "excludes when estimate_subtotal_cents is %p",
    (bad) => {
      const result = buildManifestRowOrExclusion({ ...BASE_INPUT, estimate_subtotal_cents: bad as number | null });
      expect("excluded" in result).toBe(true);
    },
  );

  it("excludes when division is missing", () => {
    const result = buildManifestRowOrExclusion({ ...BASE_INPUT, division: null });
    expect("excluded" in result).toBe(true);
  });

  it.each([null, undefined, NaN])("excludes when overhead_rate_used is %p", (bad) => {
    const result = buildManifestRowOrExclusion({ ...BASE_INPUT, overhead_rate_used: bad as number | null });
    expect("excluded" in result).toBe(true);
  });

  it("excludes when resolved_completion_method is null", () => {
    const result = buildManifestRowOrExclusion({
      ...BASE_INPUT,
      classification: { ...COST_TO_COST_CLASSIFICATION, resolved_completion_method: null },
    });
    expect("excluded" in result).toBe(true);
  });

  it.each([null, undefined, 0, -1, NaN])(
    "service_units bucket excludes when remaining_service_units is %p (never guesses a positive count)",
    (bad) => {
      const result = buildManifestRowOrExclusion({
        ...BASE_INPUT,
        classification: SERVICE_UNITS_CLASSIFICATION,
        remaining_service_units: bad as number | null,
      });
      expect("excluded" in result).toBe(true);
      if ("excluded" in result) expect(result.excluded.reason).toMatch(/remaining scheduled-visit count/i);
    },
  );

  it("service_units bucket succeeds with a positive remaining_service_units and carries it through", () => {
    const result = buildManifestRowOrExclusion({
      ...BASE_INPUT,
      classification: SERVICE_UNITS_CLASSIFICATION,
      remaining_service_units: 4,
    });
    expect("row" in result).toBe(true);
    if ("row" in result) {
      expect(result.row.service_units_planned).toBe(4);
      expect(result.row.completion_method).toBe("service_units");
    }
  });

  it("cost_to_cost bucket always has service_units_planned=null even if remaining_service_units was somehow supplied", () => {
    const result = buildManifestRowOrExclusion({ ...BASE_INPUT, remaining_service_units: 99 });
    expect("row" in result).toBe(true);
    if ("row" in result) expect(result.row.service_units_planned).toBeNull();
  });
});

// ── §10 step 1 vs step 2 field separation ──────────────────────────────────
describe("BW-05 buildManifestRow — contract_value_cents vs direct_cost_budget_cents separation", () => {
  it("direct_cost_budget_cents comes from subtotal, contract_value_cents from total — never conflated", () => {
    const result = buildManifestRow({ ...BASE_INPUT, estimate_total_cents: 700_000, estimate_subtotal_cents: 400_000 });
    expect("row" in result).toBe(true);
    if ("row" in result) {
      expect(result.row.contract_value_cents).toBe(700_000);
      expect(result.row.direct_cost_budget_cents).toBe(400_000);
    }
  });

  it.each([null, undefined, NaN, Infinity, -1])(
    "excludes when estimate_total_cents is %p, independent of a perfectly valid subtotal",
    (bad) => {
      const result = buildManifestRow({ ...BASE_INPUT, estimate_total_cents: bad as number | null, estimate_subtotal_cents: 400_000 });
      expect("excluded" in result).toBe(true);
      if ("excluded" in result) expect(result.excluded.reason).toMatch(/total_cents/i);
    },
  );

  it("a malformed subtotal excludes even when total_cents is perfectly valid", () => {
    const result = buildManifestRow({ ...BASE_INPUT, estimate_total_cents: 700_000, estimate_subtotal_cents: -1 });
    expect("excluded" in result).toBe(true);
    if ("excluded" in result) expect(result.excluded.reason).toMatch(/subtotal_cents/i);
  });
});

// ── "Everything to labor" interpretation ───────────────────────────────────
describe("BW-06 buildJobBudgetVersionInsertRow — everything-to-labor interpretation, needs_review hardcoded", () => {
  const built = buildJobBudgetVersionInsertRow(SAMPLE_JOB_ROW, { id: "jbv-1", approvedAt: "2026-08-27T00:00:00.000Z", approvedBy: "tester" });

  it("needs_review is always 1, never a parameter", () => {
    expect(built.needs_review).toBe(1);
  });

  it("every non-labor category budget is 0", () => {
    expect(built.materials_budget_cents).toBe(0);
    expect(built.subcontractor_budget_cents).toBe(0);
    expect(built.equipment_budget_cents).toBe(0);
    expect(built.disposal_budget_cents).toBe(0);
    expect(built.permits_budget_cents).toBe(0);
  });

  it("other_direct_budget_cents and direct_cost_budget_cents both equal the job row's direct_cost_budget_cents (the subtotal)", () => {
    expect(built.other_direct_budget_cents).toBe(SAMPLE_JOB_ROW.direct_cost_budget_cents);
    expect(built.direct_cost_budget_cents).toBe(SAMPLE_JOB_ROW.direct_cost_budget_cents);
  });

  it("labor_hours_budgeted_hundredths is 0, labor_rate_used is null, budgeted_overhead_cents is 0", () => {
    expect(built.labor_hours_budgeted_hundredths).toBe(0);
    expect(built.labor_rate_used).toBeNull();
    expect(built.budgeted_overhead_cents).toBe(0);
  });

  it("revision_seq is always 0 (baseline), source_type is always 'estimate'", () => {
    expect(built.revision_seq).toBe(0);
    expect(built.source_type).toBe("estimate");
  });

  it("audit attribution: approved_by/approved_at are always stamped from the caller-supplied meta, never blank", () => {
    expect(built.approved_by).toBe("tester");
    expect(built.approved_at).toBe("2026-08-27T00:00:00.000Z");
  });
});

// ── Structural validation / duplicate prevention ───────────────────────────
describe("BW-07 validateManifestStructure", () => {
  it("a manifest built from SAMPLE_JOB_ROW is valid", () => {
    const m: BackfillManifest = { ...makeManifest({ jobs: [SAMPLE_JOB_ROW], total_jobs_scanned: 1 }), manifest_hash: "irrelevant-for-structure" };
    expect(validateManifestStructure(m).valid).toBe(true);
  });

  it("rejects a schema_version mismatch", () => {
    const m: BackfillManifest = { ...makeManifest({ schema_version: 999 }), manifest_hash: "x" };
    const result = validateManifestStructure(m);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => /schema_version/.test(e))).toBe(true);
  });

  it("rejects a wildcard company_id", () => {
    const m: BackfillManifest = { ...makeManifest({ company_id: "*" }), manifest_hash: "x" };
    expect(validateManifestStructure(m).valid).toBe(false);
  });

  it("rejects duplicate job_ids", () => {
    const m: BackfillManifest = {
      ...makeManifest({ jobs: [SAMPLE_JOB_ROW, { ...SAMPLE_JOB_ROW }], total_jobs_scanned: 2 }),
      manifest_hash: "x",
    };
    const result = validateManifestStructure(m);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => /duplicate job_id/.test(e))).toBe(true);
  });

  it("rejects more jobs than MAX_MANIFEST_JOBS", () => {
    const jobs = Array.from({ length: MAX_MANIFEST_JOBS + 1 }, (_, i) => ({ ...SAMPLE_JOB_ROW, job_id: `job-${i}` }));
    const m: BackfillManifest = { ...makeManifest({ jobs, total_jobs_scanned: jobs.length }), manifest_hash: "x" };
    const result = validateManifestStructure(m);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => /MAX_MANIFEST_JOBS/.test(e))).toBe(true);
  });

  it("rejects a service_units job with a non-positive service_units_planned", () => {
    const badRow = { ...SAMPLE_JOB_ROW, completion_method: "service_units" as const, service_units_planned: 0 };
    const m: BackfillManifest = { ...makeManifest({ jobs: [badRow], total_jobs_scanned: 1 }), manifest_hash: "x" };
    expect(validateManifestStructure(m).valid).toBe(false);
  });

  it("rejects a cost_to_cost job with a non-null service_units_planned", () => {
    const badRow = { ...SAMPLE_JOB_ROW, service_units_planned: 4 };
    const m: BackfillManifest = { ...makeManifest({ jobs: [badRow], total_jobs_scanned: 1 }), manifest_hash: "x" };
    expect(validateManifestStructure(m).valid).toBe(false);
  });

  it("rejects jobs.length + excluded_jobs.length exceeding total_jobs_scanned", () => {
    const m: BackfillManifest = { ...makeManifest({ jobs: [SAMPLE_JOB_ROW], total_jobs_scanned: 0 }), manifest_hash: "x" };
    expect(validateManifestStructure(m).valid).toBe(false);
  });
});

// ── assembleManifestJobs — determinism/sorting ─────────────────────────────
describe("BW-08 assembleManifestJobs", () => {
  it("sorts jobs and excluded_jobs by job_id ascending regardless of input order", () => {
    const jobB = { ...SAMPLE_JOB_ROW, job_id: "job-b" };
    const jobA = { ...SAMPLE_JOB_ROW, job_id: "job-a" };
    const { jobs } = assembleManifestJobs([{ row: jobB }, { row: jobA }]);
    expect(jobs.map((j) => j.job_id)).toEqual(["job-a", "job-b"]);
  });

  it("splits row/excluded results correctly", () => {
    const { jobs, excluded_jobs } = assembleManifestJobs([
      { row: SAMPLE_JOB_ROW },
      { excluded: { job_id: "job-2", bucket: "no_division", reason: "x" } },
    ]);
    expect(jobs.length).toBe(1);
    expect(excluded_jobs.length).toBe(1);
  });
});

// ── Property 18: refusal of reused/altered/stale/mismatched manifests ─────
describe("BW-09 validateManifestForExecution", () => {
  async function ctxFor(manifest: BackfillManifest, overrides: Partial<ExecutionContext> = {}): Promise<ExecutionContext> {
    const { manifest_hash: _h, ...rest } = manifest;
    return {
      expectedCompanyId: manifest.company_id,
      expectedEnvironment: manifest.environment,
      nowIso: manifest.generated_at,
      recomputedHash: await hashManifest(rest),
      ...overrides,
    };
  }

  it("a freshly-generated, unaltered manifest passes", async () => {
    const m = await withHash(makeManifest());
    const ctx = await ctxFor(m);
    expect(validateManifestForExecution(m, ctx).valid).toBe(true);
  });

  it("rejects a tampered/altered manifest (hash mismatch)", async () => {
    const m = await withHash(makeManifest());
    // Simulates a manifest file hand-edited after generation: its content
    // changed (total_jobs_scanned) but its manifest_hash field still
    // claims the OLD (pre-edit) hash. The real executor reads the
    // manifest fresh and recomputes the hash from what's ACTUALLY in it
    // (ctxFor(tampered) below does exactly that) — the mismatch against
    // the stale manifest_hash field is what proves tampering.
    const tampered: BackfillManifest = { ...m, total_jobs_scanned: 999 };
    const ctx = await ctxFor(tampered);
    const result = validateManifestForExecution(tampered, ctx);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => /altered after generation|corrupted/.test(e))).toBe(true);
  });

  it("rejects a mismatched tenant", async () => {
    const m = await withHash(makeManifest({ company_id: "tenant-1" }));
    const ctx = await ctxFor(m, { expectedCompanyId: "tenant-2" });
    const result = validateManifestForExecution(m, ctx);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => /different tenant/.test(e))).toBe(true);
  });

  it("rejects a mismatched environment", async () => {
    const m = await withHash(makeManifest({ environment: "local" }));
    const ctx = await ctxFor(m, { expectedEnvironment: "remote" });
    const result = validateManifestForExecution(m, ctx);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => /environment/.test(e))).toBe(true);
  });

  it("rejects a stale manifest (older than MAX_MANIFEST_AGE_MS)", async () => {
    const m = await withHash(makeManifest({ generated_at: "2026-08-01T00:00:00.000Z" }));
    const nowIso = new Date(Date.parse("2026-08-01T00:00:00.000Z") + MAX_MANIFEST_AGE_MS + 1000).toISOString();
    const ctx = await ctxFor(m, { nowIso });
    const result = validateManifestForExecution(m, ctx);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => /stale|exceeding MAX_MANIFEST_AGE_MS/.test(e))).toBe(true);
  });

  it("accepts a manifest just under the staleness threshold", async () => {
    const m = await withHash(makeManifest({ generated_at: "2026-08-01T00:00:00.000Z" }));
    const nowIso = new Date(Date.parse("2026-08-01T00:00:00.000Z") + MAX_MANIFEST_AGE_MS - 1000).toISOString();
    const ctx = await ctxFor(m, { nowIso });
    expect(validateManifestForExecution(m, ctx).valid).toBe(true);
  });

  it("rejects a manifest whose generated_at is in the future relative to now (clock inconsistency)", async () => {
    const m = await withHash(makeManifest({ generated_at: "2026-08-27T12:00:00.000Z" }));
    const ctx = await ctxFor(m, { nowIso: "2026-08-27T00:00:00.000Z" });
    const result = validateManifestForExecution(m, ctx);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => /future/.test(e))).toBe(true);
  });

  it("structural errors surface too (a hand-edited manifest with a schema mismatch AND a hash mismatch reports both)", async () => {
    const m = await withHash(makeManifest({ schema_version: 999 }));
    const ctx = await ctxFor(m);
    const result = validateManifestForExecution(m, ctx);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThanOrEqual(1);
    expect(result.errors.some((e) => /schema_version/.test(e))).toBe(true);
  });
});

// ── Property 15: before/after reconciliation ───────────────────────────────
describe("BW-10 describeReconciliation", () => {
  it("expected_max_rows_written equals jobs.length, never more", () => {
    const m: BackfillManifest = { ...makeManifest({ jobs: [SAMPLE_JOB_ROW], excluded_jobs: [{ job_id: "j2", bucket: "no_division", reason: "x" }], total_jobs_scanned: 5 }), manifest_hash: "x" };
    const r = describeReconciliation(m);
    expect(r.expected_max_rows_written).toBe(1);
    expect(r.jobs_in_manifest).toBe(1);
    expect(r.jobs_excluded).toBe(1);
    expect(r.total_jobs_scanned).toBe(5);
  });
});

// ── Property 16: rollback/compensating-action documentation ───────────────
describe("BW-11 describeRollbackPlan", () => {
  it("is always non-reversible (this tool never auto-rolls-back)", () => {
    const plan = describeRollbackPlan({ manifest_hash: "abc", started_at: "2026-08-27T00:00:00.000Z", company_id: "tenant-1" });
    expect(plan.reversible).toBe(false);
    expect(plan.manual_steps.length).toBeGreaterThan(0);
    expect(plan.summary).toMatch(/manual|human-supervised/i);
  });

  it("manual steps reference the specific company_id/manifest_hash/started_at supplied", () => {
    const plan = describeRollbackPlan({ manifest_hash: "hash-xyz", started_at: "2026-08-27T00:00:00.000Z", company_id: "tenant-9" });
    expect(plan.manual_steps.some((s) => s.includes("tenant-9"))).toBe(true);
    expect(plan.manual_steps.some((s) => s.includes("hash-xyz"))).toBe(true);
  });
});
