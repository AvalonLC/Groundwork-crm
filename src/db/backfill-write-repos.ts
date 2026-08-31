/**
 * Item 4 Stage 2, Phase 2: DB-orchestration layer for the guarded §10
 * WRITING backfill. This is the ONLY file that ever issues a
 * job_budget_versions/backfill_manifest_execution write for this feature —
 * every actual decision (which bucket is safe, what a manifest row looks
 * like, what invalidates a manifest) lives in the pure engine
 * (src/engines/backfill-write.ts), reused here without modification, per
 * the mandate's "do not rewrite proven analysis/repo logic" instruction.
 *
 * Two entry points, matching src/engines/backfill-write.ts's header
 * comment's two-step workflow:
 *   - generateBackfillManifest: report-only, ZERO writes. Calls the
 *     existing, tested runBackfillAnalysis (Phase 3) to get per-job
 *     classifications, resolves the extra plain values the writing
 *     engine's buildManifestRow needs (estimate subtotal/total,
 *     division, overhead rate, remaining service units) via small,
 *     additive repos.ts queries, and returns a hashed, signed
 *     BackfillManifest a human reviews before ever supplying a
 *     confirmation token.
 *   - executeBackfillManifest: the only function in this whole feature
 *     that can write. Re-validates every safety property against the
 *     CURRENT database state (never trusting the manifest's own claims
 *     about itself beyond what validateManifestForExecution's hash/
 *     tenant/environment/staleness checks establish), then issues one
 *     atomic db.batch() covering every job_budget_versions row plus the
 *     backfill_manifest_execution ledger row, using
 *     insertJobBudgetVersionIfAbsentStatement's WHERE-NOT-EXISTS-
 *     equivalent (INSERT OR IGNORE against the unique
 *     (company_id, job_id, revision_seq) index) so a same-job race or a
 *     stale-manifest replay can only ever produce fewer rows than
 *     expected, never duplicate or extra ones.
 */

import {
  listBackfillCandidateJobs, resolveDivisionForBackfill,
  getAcceptedEstimateForBackfillWrite, getLatestOverheadAllocationForDivision,
  countRemainingPlanVisitsForJob, runBackfillAnalysis,
  insertJobBudgetVersionIfAbsentStatement, findCompletedManifestExecution,
  insertManifestExecutionStartStatement, finishManifestExecutionStatement,
} from "./repos";
import type { JobBackfillClassification } from "../engines/backfill-analysis";
import {
  assertUsableTenantId, buildManifestRow, assembleManifestJobs,
  validateManifestStructure, validateManifestForExecution, hashManifest,
  hashConfirmationToken, buildJobBudgetVersionInsertRow, describeReconciliation,
  BACKFILL_MANIFEST_SCHEMA_VERSION, MAX_MANIFEST_JOBS,
  type BackfillManifest, type BackfillManifestEnvironment,
  type JobRowInputsWithContractValue, type ManifestValidationResult,
  type ReconciliationExpectation,
} from "../engines/backfill-write";

/**
 * Report-only. Never issues a write of any kind — see this file's header
 * comment. `companyId`/`asOf`/`environment` are all REQUIRED, explicit
 * parameters (mandate item 3, matching runBackfillAnalysis's own
 * convention): no "all tenants," no "today" default. Throws (via
 * assertUsableTenantId) on a wildcard/all-tenant companyId rather than
 * silently scanning every tenant — mandate item 17.
 *
 * A tenant with more eligible (safe-bucket) jobs than MAX_MANIFEST_JOBS
 * causes this function to throw rather than silently truncate the
 * manifest — see MAX_MANIFEST_JOBS's own doc comment in
 * src/engines/backfill-write.ts for why an unbounded single manifest is
 * itself a risk this mandate's "transaction boundaries" property is meant
 * to bound.
 */
export async function generateBackfillManifest(
  db: D1Database, companyId: string, asOf: string, environment: BackfillManifestEnvironment,
): Promise<BackfillManifest> {
  assertUsableTenantId(companyId);

  const report = await runBackfillAnalysis(db, companyId, asOf);

  // Only the two safe buckets are worth resolving the extra per-job inputs
  // for — every other bucket is already excluded by construction
  // (buildManifestRow itself also re-checks this, but there is no reason
  // to issue DB reads for a classification that can never produce a row).
  const safeBucketJobs = report.jobs.filter(
    (j) => j.bucket === "would_create_needs_review_cost_to_cost" || j.bucket === "would_create_needs_review_service_units",
  );

  if (safeBucketJobs.length > MAX_MANIFEST_JOBS) {
    throw new Error(
      `tenant "${companyId}" as_of "${asOf}" has ${safeBucketJobs.length} safe-bucket jobs, exceeding MAX_MANIFEST_JOBS=${MAX_MANIFEST_JOBS} — split this run into multiple manifests (e.g. one per division) rather than generating a single oversized one`,
    );
  }

  // listBackfillCandidateJobs/resolveDivisionForBackfill are the exact
  // same functions runBackfillAnalysis's own buildBackfillInputForJob
  // uses — reused, not re-derived, so a job's division here can never
  // silently diverge from the division the classification above was
  // computed against.
  const candidateJobs = await listBackfillCandidateJobs(db, companyId, asOf);
  const crewIdByJobId = new Map(candidateJobs.map((j) => [j.id, j.crew_id]));

  const results = await Promise.all(
    safeBucketJobs.map((classification) => resolveJobRowInputs(db, companyId, asOf, classification, crewIdByJobId.get(classification.job_id) ?? null)),
  );

  const { jobs, excluded_jobs } = assembleManifestJobs(results);
  const generated_at = new Date().toISOString();
  const withoutHash: Omit<BackfillManifest, "manifest_hash"> = {
    schema_version: BACKFILL_MANIFEST_SCHEMA_VERSION,
    company_id: companyId,
    as_of: asOf,
    environment,
    generated_at,
    jobs,
    excluded_jobs,
    total_jobs_scanned: report.total_jobs_scanned,
  };
  const manifest_hash = await hashManifest(withoutHash);
  const manifest: BackfillManifest = { ...withoutHash, manifest_hash };

  // Self-check: a manifest this function itself just built must always
  // pass its own structural validation. A failure here is a bug in this
  // file (or in the pure engine), never a legitimate data-driven outcome —
  // surfaced loudly rather than returned as a "maybe-broken" manifest.
  const selfCheck = validateManifestStructure(manifest);
  if (!selfCheck.valid) {
    throw new Error(`generateBackfillManifest produced a structurally invalid manifest (this is a bug): ${selfCheck.errors.join("; ")}`);
  }

  return manifest;
}

/** One job's full set of plain-value inputs, resolved via the small,
 * additive repos.ts queries — division reused from resolveDivisionForBackfill
 * (the same cascade runBackfillAnalysis's own input-assembly uses),
 * estimate total/subtotal from the new getAcceptedEstimateForBackfillWrite,
 * overhead rate from the existing exported getLatestOverheadAllocationForDivision
 * (not the private, boolean-only overheadRateAvailableForDivision Phase 3
 * uses — this path needs the actual rate value to freeze into the row),
 * and remaining service units from the new countRemainingPlanVisitsForJob
 * (only actually queried for service_units-bucket jobs; a cost_to_cost job
 * has no use for this figure and buildManifestRow ignores it either way). */
async function resolveJobRowInputs(
  db: D1Database, companyId: string, asOf: string,
  classification: JobBackfillClassification, crewId: string | null,
): Promise<{ row: import("../engines/backfill-write").BackfillManifestJobRow } | { excluded: import("../engines/backfill-write").ExcludedBackfillJob }> {
  const [estimate, division] = await Promise.all([
    getAcceptedEstimateForBackfillWrite(db, companyId, classification.job_id, asOf),
    resolveDivisionForBackfill(db, companyId, crewId),
  ]);

  const overheadAllocation = estimate?.accepted_at && division
    ? await getLatestOverheadAllocationForDivision(db, companyId, division, estimate.accepted_at)
    : null;

  const remainingServiceUnits = classification.resolved_completion_method === "service_units"
    ? await countRemainingPlanVisitsForJob(db, companyId, classification.job_id)
    : null;

  const input: JobRowInputsWithContractValue = {
    classification,
    estimate_id: estimate?.id ?? null,
    estimate_total_cents: estimate?.total_cents ?? null,
    estimate_subtotal_cents: estimate?.subtotal_cents ?? null,
    division,
    overhead_rate_used: overheadAllocation?.overhead_rate ?? null,
    remaining_service_units: remainingServiceUnits,
  };

  return buildManifestRow(input);
}

export interface ExecuteBackfillManifestOptions {
  /** Mandate item 1: dry-run default. `apply !== true` (i.e. omitted,
   * false, or any other falsy value) always short-circuits to a pure
   * reconciliation-preview return with zero writes issued — this is the
   * ONLY branch point in this whole file between "describe" and "write." */
  apply?: boolean;
  /** Mandate item 6: explicit write flag + confirmation token. Required
   * (and independently hashed via hashConfirmationToken, never persisted
   * in cleartext) whenever apply=true. */
  confirmationToken?: string;
  /** Mandate item 7: backup-confirmation requirement. Required true
   * whenever apply=true — a human operator's explicit attestation that a
   * pre-execution backup exists, never inferred or defaulted. */
  backupConfirmed?: boolean;
  /** Mandate item 14: audit attribution. The human operator's identity,
   * stamped on every job_budget_versions row this execution creates
   * (buildJobBudgetVersionInsertRow's approved_by) AND on the
   * backfill_manifest_execution ledger row — never blank, never a system
   * account, whenever apply=true. */
  approvedBy?: string;
  /** Injected rather than read from Date.now() internally, so staleness/
   * future-timestamp checks are unit-testable without mocking global
   * time — same convention as ExecutionContext.nowIso in the pure engine. */
  nowIso?: string;
  /** Id generator, injected for deterministic tests (defaults to
   * crypto.randomUUID-based ids matching this codebase's own
   * `prefix-${crypto.randomUUID().slice(0, N)}` convention elsewhere). */
  newId?: () => string;
}

export interface ExecuteBackfillManifestResult {
  applied: boolean;
  validation: ManifestValidationResult;
  reconciliation: ReconciliationExpectation;
  /** Present only when applied=true. */
  rowsWritten?: number;
  executionId?: string;
}

function defaultNewId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID().slice(0, 12)}`;
}

/**
 * The single write path for this whole feature. `expectedCompanyId`/
 * `expectedEnvironment` are the caller's actual runtime targets (which D1
 * binding is genuinely live) — compared against the manifest's own claims
 * by validateManifestForExecution, never trusted from the manifest alone
 * (mandate item 18).
 *
 * Dry-run (apply!==true, the default) path: validates the manifest against
 * current DB state (re-checking hash/tenant/environment/staleness, AND —
 * beyond what the pure engine alone can check — whether this exact
 * manifest_hash has already been consumed by a completed execution) and
 * returns the reconciliation preview. Issues zero writes.
 *
 * Apply path (apply===true): additionally requires confirmationToken,
 * backupConfirmed===true, and a non-blank approvedBy (mandate items 6/7/14)
 * — missing any of these is treated as a validation failure, not a thrown
 * exception, so a caller always gets the same ManifestValidationResult
 * shape regardless of which check failed. Only once every check passes
 * does this function build ONE db.batch() (mandate item 10: transaction
 * boundaries — all of it happens, or none of it does) covering:
 *   1. the backfill_manifest_execution start row (status='in_progress'),
 *   2. one insertJobBudgetVersionIfAbsentStatement per manifest job row
 *      (mandate items 10-13: WHERE-NOT-EXISTS-equivalent duplicate/race
 *      guard via INSERT OR IGNORE against the unique
 *      (company_id, job_id, revision_seq) index),
 *   3. the ledger's own completion update, in the SAME batch, which
 *      computes rows_written via a subquery over the database's own
 *      post-insert state (see finishManifestExecutionStatement's doc
 *      comment) rather than assuming it equals jobs.length (mandate item
 *      15: before/after reconciliation grounded in what actually landed,
 *      not what was merely attempted).
 * The final rows_written value is then read back (a plain SELECT, no
 * further write) from the now-completed ledger row for the caller.
 */
export async function executeBackfillManifest(
  db: D1Database, manifest: BackfillManifest, opts: ExecuteBackfillManifestOptions & {
    expectedCompanyId: string; expectedEnvironment: BackfillManifestEnvironment;
  },
): Promise<ExecuteBackfillManifestResult> {
  const nowIso = opts.nowIso ?? new Date().toISOString();
  // hashManifest's input type deliberately excludes manifest_hash
  // (canonicalizeManifest never reads that field) — destructure it away
  // rather than pass the full manifest through, so recomputing the hash
  // here exactly matches how generateBackfillManifest computed it originally.
  const { manifest_hash: _ignoredHash, ...manifestWithoutHash } = manifest;
  const recomputedHash = await hashManifest(manifestWithoutHash);
  const structuralCtx = {
    expectedCompanyId: opts.expectedCompanyId,
    expectedEnvironment: opts.expectedEnvironment,
    nowIso,
    recomputedHash,
  };

  const baseValidation = validateManifestForExecution(manifest, structuralCtx);
  const errors = [...baseValidation.errors];

  // The "consumed" half of mandate item 18 — a DB concern the pure engine
  // cannot check on its own (see validateManifestForExecution's own doc
  // comment). Checked even on a dry-run call: a human reviewing a dry-run
  // reconciliation for an already-consumed manifest deserves to see that
  // fact before ever supplying a confirmation token.
  if (baseValidation.valid) {
    const consumed = await findCompletedManifestExecution(db, manifest.company_id, manifest.manifest_hash);
    if (consumed) {
      errors.push(
        `manifest_hash "${manifest.manifest_hash}" was already executed to completion at ${consumed.finished_at ?? consumed.started_at} (execution id ${consumed.id}, ${consumed.rows_written} rows written) — refusing to execute the same manifest twice`,
      );
    }
  }

  const reconciliation = describeReconciliation(manifest);

  if (opts.apply !== true) {
    return { applied: false, validation: { valid: errors.length === 0, errors }, reconciliation };
  }

  // Apply-path-only checks (mandate items 6/7/14) — never enforced on a
  // dry run, since a dry run's whole purpose is to be safely inspectable
  // without any of these being supplied yet.
  if (!opts.confirmationToken || opts.confirmationToken.trim() === "") {
    errors.push("apply=true requires a non-empty confirmationToken — refusing to write without an explicit, human-supplied confirmation");
  }
  if (opts.backupConfirmed !== true) {
    errors.push("apply=true requires backupConfirmed===true — refusing to write without an explicit attestation that a pre-execution backup exists");
  }
  if (!opts.approvedBy || opts.approvedBy.trim() === "") {
    errors.push("apply=true requires a non-blank approvedBy identity — refusing to write an unattributed budget version");
  }

  const validation: ManifestValidationResult = { valid: errors.length === 0, errors };
  if (!validation.valid) {
    return { applied: false, validation, reconciliation };
  }

  const executionId = (opts.newId ?? ((p: string) => defaultNewId(p)))("bfx");
  const confirmationTokenHash = await hashConfirmationToken(opts.confirmationToken!);
  const approvedAt = nowIso;

  const startStmt = insertManifestExecutionStartStatement(db, {
    id: executionId,
    company_id: manifest.company_id,
    manifest_hash: manifest.manifest_hash,
    schema_version: manifest.schema_version,
    environment: manifest.environment,
    as_of: manifest.as_of,
    generated_at: manifest.generated_at,
    job_count: manifest.jobs.length,
    approved_by: opts.approvedBy!,
    confirmation_token_hash: confirmationTokenHash,
  });

  const newId = opts.newId ?? ((p: string) => defaultNewId(p));
  const attemptedJobRowIds: string[] = [];
  const insertStmts = manifest.jobs.map((jobRow) => {
    const rowId = newId("jbv");
    attemptedJobRowIds.push(rowId);
    const insertRow = buildJobBudgetVersionInsertRow(jobRow, {
      id: rowId,
      approvedAt,
      approvedBy: opts.approvedBy!,
    });
    // buildJobBudgetVersionInsertRow leaves company_id as "" (a flagged
    // placeholder — see its own doc comment: "filled in by the repos
    // layer"). This is the one, single place that override happens, on
    // the manifest's own company_id (already validated to equal
    // opts.expectedCompanyId above) — never left blank, never taken from
    // anywhere else.
    return insertJobBudgetVersionIfAbsentStatement(db, { ...insertRow, company_id: manifest.company_id });
  });

  // ONE atomic db.batch(): the ledger's start row, every job insert
  // attempt, and the ledger's own completion update (which computes
  // rows_written from the database's own post-insert state via a
  // subquery — see finishManifestExecutionStatement's doc comment) — all
  // in a single transaction, or none of it happens (mandate item 10).
  const finishStmt = finishManifestExecutionStatement(db, executionId, {
    status: "completed",
    attemptedJobRowIds,
    errorMessage: null,
  });
  await db.batch([startStmt, ...insertStmts, finishStmt]);

  const ledgerRow = await findCompletedManifestExecution(db, manifest.company_id, manifest.manifest_hash);
  const rowsWritten = ledgerRow?.rows_written ?? 0;

  return { applied: true, validation, reconciliation, rowsWritten, executionId };
}
