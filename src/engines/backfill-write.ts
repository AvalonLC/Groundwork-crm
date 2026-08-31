/**
 * Item 4 Stage 2, Phase 2: the guarded §10 WRITING backfill package.
 *
 * Pure functions only (same convention as backfill-analysis.ts/
 * job-progress.ts): no DB, no file system, no tenant/company_id defaults.
 * The one exception is `hashManifest`, which uses the Web Crypto API
 * (`crypto.subtle`, available in both Cloudflare Workers/workerd and
 * modern Node) — it performs no I/O and is fully deterministic given the
 * same input, so it stays in this file rather than the DB-orchestration
 * layer (src/db/backfill-write-repos.ts), matching classifyJobForBackfill's
 * own "every actual decision lives in the pure engine" discipline.
 *
 * This file answers "given already-resolved, already-classified inputs,
 * what exact job_budget_versions row would step 1's baseline row contain,
 * and is a given manifest safe to execute" — it never itself talks to D1.
 * src/db/backfill-write-repos.ts is the only place that ever issues an
 * INSERT built from this file's output.
 *
 * ── Why a two-step manifest workflow ────────────────────────────────────
 * generateBackfillManifest (repos layer) produces a MANIFEST: a
 * deterministic, hashed, timestamped, schema-versioned, environment-bound
 * snapshot of exactly which baseline rows WOULD be created, from
 * src/engines/backfill-analysis.ts's existing report-only classifier
 * (reused, never reimplemented — see that file's own bucket definitions).
 * executeBackfillManifest (repos layer) later takes that manifest back and
 * writes only what it describes, after re-validating every safety property
 * below against the CURRENT state of the database — never assuming the
 * world hasn't changed since generation. A manifest is a proposal, not an
 * authorization; every check in `validateManifestForExecution` runs again
 * at execute time regardless of what the manifest itself claims.
 *
 * ── Safety properties this file is responsible for (mandate's ~20-item
 * list), each with the exact function/constant that implements it ────────
 *  1. dry-run default              -> repos layer's `dryRun` param default;
 *                                      this file has no notion of "apply"
 *                                      at all, it only ever *describes*.
 *  2. never run against production -> repos layer requires an explicit,
 *                                      separately-supplied confirmation
 *                                      token (see 8) AND a matching
 *                                      `environment` on the manifest (7);
 *                                      this file cannot invoke wrangler or
 *                                      touch a remote binding itself.
 *  3. explicit tenant/as-of targeting -> `assertUsableTenantId` (16) +
 *                                      manifest.as_of is always the
 *                                      caller's explicit value, never a
 *                                      "today" default (matches
 *                                      runBackfillAnalysis's own
 *                                      convention).
 *  4. deterministic manifest generation with hash/schema-version/
 *     environment binding -> `canonicalizeManifest` + `hashManifest` +
 *                             `BACKFILL_MANIFEST_SCHEMA_VERSION` +
 *                             `BackfillManifest.environment`.
 *  5. expected-counts/staleness protection -> `MAX_MANIFEST_AGE_MS` +
 *                             `validateManifestForExecution`'s
 *                             `freshJobCount` / `generated_at` checks.
 *  6. explicit write flag + confirmation token -> repos layer's `apply` +
 *                             `confirmationToken` params; this file
 *                             defines `hashConfirmationToken` so the raw
 *                             token is never persisted (migration 0086's
 *                             `confirmation_token_hash` column).
 *  7. backup-confirmation requirement -> repos layer's `backupConfirmed`
 *                             boolean param, required true.
 *  8. unresolved-review-bucket rejection -> `SAFE_BACKFILL_BUCKETS` +
 *                             `assertOnlySafeBuckets`.
 *  9. safe-record allowlist -> same as 8 — only the two
 *                             `would_create_needs_review_*` buckets are
 *                             ever eligible to become a manifest row; every
 *                             other bucket (including the two "clean"
 *                             ones, provably unreachable today per
 *                             backfill-analysis.ts) is refused.
 * 10. transaction boundaries -> repos layer's single `db.batch()` call
 *                             covering every job row + the execution-
 *                             ledger row atomically; this file's
 *                             `buildJobBudgetVersionInsertStatementParts`
 *                             documents the per-row SQL shape that batch
 *                             uses.
 * 11. concurrency protection / 12. idempotency / 13. duplicate prevention
 *     -> the `WHERE NOT EXISTS` guard baked into every generated INSERT
 *        (see `buildJobBudgetVersionInsertStatementParts`'s doc comment)
 *        plus the `backfill_manifest_execution.manifest_hash` /
 *        status='completed' consumed-manifest check (repos layer).
 * 14. audit attribution -> `BackfillManifest.jobs[].bucket`/reasons kept
 *        on the manifest for the record, plus `approved_by` +
 *        `confirmation_token_hash` on every execution-ledger row
 *        (migration 0086); this file's `buildJobBudgetVersionInsertRow`
 *        always stamps `approved_by` from the caller-supplied operator
 *        identity, never blank.
 * 15. before/after reconciliation -> `describeReconciliation` produces the
 *        exact invariant checks (bucket-sum, job-count, per-bucket
 *        pre/post counts) the runbook's §7/§8 already specify for the
 *        read-only tool, extended here to also state the expected
 *        POST-write `job_budget_versions` row count.
 * 16. rollback/compensating-action documentation -> `describeRollbackPlan`
 *        (this file only ever DESCRIBES the rollback; it never executes
 *        one — see docs/RUNBOOK-item4-stage2-backfill.md §10, which this
 *        function's return value is written to match verbatim).
 * 17. refusal of wildcard/all-tenant writes -> `assertUsableTenantId`
 *        rejects "", "*", "ALL" (case-insensitive) and any other
 *        obviously-non-real tenant id.
 * 18. refusal of reused/altered/stale/mismatched/consumed manifests ->
 *        `validateManifestForExecution`'s hash-mismatch (altered),
 *        `generated_at` staleness (stale), `environment`/`company_id`
 *        mismatch (mismatched), schema-version mismatch (mismatched); the
 *        "consumed" half of this is the repos layer's
 *        `backfill_manifest_execution` lookup (a DB concern, not pure).
 * 19-20. the "never" list (never invent completion%/historical COs, never
 *        silently approve budget versions, never assign ambiguous
 *        receipts, never rewrite posted ledger, never include
 *        contradictory/manual-review records, never mutate production
 *        during dev/testing) -> enforced structurally: this file only
 *        ever builds `needs_review: 1` rows (never 0 — see
 *        `buildJobBudgetVersionInsertRow`), only from the two safe
 *        buckets (8/9), reusing runBackfillAnalysis's own "skip, don't
 *        guess" classification rather than re-deciding anything, and
 *        production-vs-local is entirely gated by the `environment`
 *        binding (7) the repos layer's confirmation-token check enforces.
 */

import type { Cents, TenThousandths, JobBudgetVersion, CompletionMethod } from "../db/schema";
import type { BackfillBucket, JobBackfillClassification } from "./backfill-analysis";

/** Bumped whenever this manifest shape changes in a way that would make an
 * old manifest unsafe to execute against new code (a new required field, a
 * changed meaning for an existing one, etc.) — never bumped for a purely
 * additive, backward-compatible field. A manifest whose schema_version
 * doesn't match this constant at execute time is refused outright (see
 * validateManifestForExecution) rather than "best-effort" interpreted. */
export const BACKFILL_MANIFEST_SCHEMA_VERSION = 1;

/** Only these two backfill-analysis.ts buckets ever produce a manifest
 * row — the two provably-unreachable "clean" buckets (see that file's own
 * header comment) are deliberately EXCLUDED here even though they're
 * nominally "success" buckets, because a manifest row appearing in a
 * bucket the classifier can't currently produce would be a stronger signal
 * of a bug (either in the classifier or in this file) than of a genuinely
 * clean split, and mandate item 19 explicitly forbids ever silently
 * approving a budget version outside the classifier's own documented
 * decision. Every other bucket (already_has_budget_version,
 * no_accepted_estimate, no_division, no_overhead_rate_for_division,
 * ambiguous_direct_cost_split, no_completion_method_signal) is a §10
 * "skip, don't guess" outcome and never eligible for a manifest row. */
export const SAFE_BACKFILL_BUCKETS: readonly BackfillBucket[] = [
  "would_create_needs_review_cost_to_cost",
  "would_create_needs_review_service_units",
];

export type SafeBackfillBucket = "would_create_needs_review_cost_to_cost" | "would_create_needs_review_service_units";

function isSafeBucket(bucket: BackfillBucket): bucket is SafeBackfillBucket {
  return (SAFE_BACKFILL_BUCKETS as readonly string[]).includes(bucket);
}

/** A manifest older than this at execute time is refused as stale — §8's
 * reconciliation invariants and the runbook's own §13 residual-risk note
 * ("division/overhead-rate data drifts over time... re-run the dry run
 * immediately before --apply rather than trusting an older one") both
 * already establish that a manifest is only trustworthy briefly. 24 hours
 * is a deliberately conservative, generous-enough-for-a-human-review-cycle
 * window — long enough for Tyler to review a dry run's bucket counts
 * overnight, short enough that a genuinely stale manifest (left over from
 * a week-old investigation) cannot be replayed by accident. */
export const MAX_MANIFEST_AGE_MS = 24 * 60 * 60 * 1000;

/** Safety cap on how many job rows a single manifest may cover in one
 * execution batch. D1's db.batch() has practical statement-count/size
 * limits; more importantly, an unbounded single atomic transaction across
 * an entire tenant's job history is itself a risk this mandate's
 * "transaction boundaries" requirement is meant to bound, not just
 * technically satisfy. A tenant with more eligible jobs than this must
 * generate/execute multiple manifests (e.g. one per division, or paged by
 * job_id range) — a deliberate, documented limitation, never a silent
 * truncation (generateBackfillManifest throws rather than dropping jobs
 * past this cap). */
export const MAX_MANIFEST_JOBS = 500;

/** Tenant ids that must never be accepted as a real company_id for this
 * tool, regardless of casing — mandate item 17's "refusal of wildcard/
 * all-tenant writes." A real company_id in this codebase is always a
 * specific opaque id string; nothing about §10's spec or this backfill's
 * purpose is meaningful "for every tenant at once" in a single manifest. */
const WILDCARD_TENANT_SENTINELS = new Set(["", "*", "all", "all_tenants", "__all__"]);

export function assertUsableTenantId(companyId: string): void {
  if (WILDCARD_TENANT_SENTINELS.has(companyId.trim().toLowerCase())) {
    throw new Error(
      `refusing wildcard/all-tenant company_id "${companyId}" — this tool must be run once per real, explicit tenant id, never "for every tenant"`,
    );
  }
}

export type BackfillManifestEnvironment = "local" | "remote";

/** One job's fully-resolved proposed baseline row — everything
 * insertJobBudgetVersion (src/db/repos.ts) needs, minus the fields that
 * are only decided at EXECUTE time (id, approved_at, approved_by — see
 * buildJobBudgetVersionInsertRow). Money/rate fields are plain numbers
 * here (not the branded Cents/TenThousandths types) for the same reason
 * job-progress.ts's BudgetComponents is plain-number: this is a decoupled,
 * DB-row-shape-free engine; the repos layer casts once at its own
 * boundary, same convention as change-order-approval.ts's `asCents`. */
export interface BackfillManifestJobRow {
  job_id: string;
  /** estimates.id — the accepted estimate this baseline is built from
   * (§10 step 1's `source_id`). Carried through for audit/traceability
   * even though this engine never re-reads the estimate itself. */
  source_id: string;
  bucket: SafeBackfillBucket;
  division: string;
  /** §10 step 1: `estimates.total`, cents-converted — the CONTRACT value
   * (selling price), distinct from the direct-cost budget below. */
  contract_value_cents: number;
  /** §10 step 1: the overhead_allocation rate for `division` at/before the
   * estimate's accepted_at date — frozen here exactly as
   * change-order-approval.ts freezes overhead_rate_snapshot at CO
   * approval, same "never retroactively reshape an old baseline" rule. */
  overhead_rate_used: number;
  /**
   * §10 step 2: "do not infer a materials/labor/subs split... set
   * direct_cost_budget_cents from subtotal with everything in
   * other_direct_budget_cents." This engine follows that instruction
   * literally rather than guessing a labor-hours figure from a lump
   * dollar subtotal (which would require inventing an hours/rate
   * decomposition the source data doesn't contain — exactly the "never
   * silently invent" rule §10 step 2 itself states). Consequently, for
   * every manifest row built by this file:
   *   - direct_cost_budget_cents = other_direct_budget_cents = the
   *     estimate's subtotal_cents (never total_cents — that's the
   *     CONTRACT value above, a different figure).
   *   - materials/subcontractor/equipment/disposal/permits_budget_cents
   *     are always 0 (no category evidence exists; §10 step 2 already
   *     established has_non_labor_cost_evidence=false is a precondition
   *     for even reaching this bucket).
   *   - labor_hours_budgeted_hundredths is always 0 and labor_rate_used
   *     is always null — there is no hours figure anywhere in an
   *     accepted-but-unbroken-down estimate to backfill one from.
   *   - budgeted_overhead_cents is therefore always 0 too (overhead
   *     recovery is computed from labor hours × the division rate per
   *     job-progress.ts's own formula; zero hours legitimately means zero
   *     overhead has been budgeted for this backfilled row, not a
   *     computation error) — `overhead_rate_used` above is still
   *     recorded (it's a real fact about the division/date), it simply
   *     has nothing to multiply against yet.
   * This is a deliberate, documented interpretation (same class of
   * decision as change-order-approval.ts's own direct-cost-category
   * comment), not an implementation gap — a human reviewing a
   * needs_review=1 row via resolveJobBudgetVersionReview / a follow-up
   * change order is exactly how a more precise breakdown gets applied
   * later, per §10's own "flag for manual review" design.
   */
  direct_cost_budget_cents: number;
  completion_method: SafeCompletionMethod;
  /** Required (validated > 0) only for the service_units bucket; always
   * null for cost_to_cost. See resolveRemainingPlanVisits in the repos
   * layer for how this is computed — this engine only validates it,
   * never derives it (no DB access here). */
  service_units_planned: number | null;
}

type SafeCompletionMethod = Extract<CompletionMethod, "cost_to_cost" | "service_units">;

/** A job the classifier put in a safe bucket but this engine still could
 * not turn into a manifest row (e.g. a service_units job with no
 * resolvable positive remaining-visit count) — §10's "skip, don't guess"
 * rule applied one level deeper than backfill-analysis.ts's own buckets
 * reach. Never silently dropped; always surfaced here with a reason, same
 * transparency contract as BackfillAnalysisReport's own buckets. */
export interface ExcludedBackfillJob {
  job_id: string;
  bucket: BackfillBucket;
  reason: string;
}

export interface BackfillManifest {
  schema_version: number;
  company_id: string;
  as_of: string;
  environment: BackfillManifestEnvironment;
  /** ISO-8601 UTC timestamp of manifest generation — the staleness clock's
   * zero point (see MAX_MANIFEST_AGE_MS). */
  generated_at: string;
  /** sha256 hex digest of `canonicalizeManifest(this-manifest-with-hash-
   * cleared)` — see hashManifest. Present on every manifest this file
   * builds; a manifest read back with a mismatching recomputed hash is
   * proof of tampering/hand-editing between generate and execute. */
  manifest_hash: string;
  /** Sorted by job_id ascending (see buildManifest) for the same
   * determinism reason runBackfillAnalysis sorts its own classifications —
   * two generate calls against unchanged data must produce byte-identical
   * manifests (deep-equal, timestamp/hash aside), never depend on SELECT
   * row order. */
  jobs: BackfillManifestJobRow[];
  excluded_jobs: ExcludedBackfillJob[];
  /** Total jobs the underlying runBackfillAnalysis scanned (all 10
   * buckets) — kept for the reconciliation invariant in
   * describeReconciliation, so a manifest is self-describing about how
   * many jobs it chose NOT to touch and why, not just the ones it will. */
  total_jobs_scanned: number;
}

/** Deterministic JSON serialization: object keys emitted in a fixed order
 * (never Object.keys' insertion order, which JSON.stringify would
 * otherwise depend on) and jobs/excluded_jobs already required to be
 * pre-sorted by the caller (buildManifest). Used both to compute the hash
 * and, if ever needed, to compare two manifests for exact equality without
 * relying on deep-equal semantics across a hash boundary. */
export function canonicalizeManifest(manifest: Omit<BackfillManifest, "manifest_hash">): string {
  const jobPart = (j: BackfillManifestJobRow) =>
    `{"job_id":${JSON.stringify(j.job_id)},"source_id":${JSON.stringify(j.source_id)},"bucket":${JSON.stringify(j.bucket)},"division":${JSON.stringify(j.division)},"contract_value_cents":${j.contract_value_cents},"overhead_rate_used":${j.overhead_rate_used},"direct_cost_budget_cents":${j.direct_cost_budget_cents},"completion_method":${JSON.stringify(j.completion_method)},"service_units_planned":${j.service_units_planned === null ? "null" : j.service_units_planned}}`;
  const excludedPart = (e: ExcludedBackfillJob) =>
    `{"job_id":${JSON.stringify(e.job_id)},"bucket":${JSON.stringify(e.bucket)},"reason":${JSON.stringify(e.reason)}}`;
  return (
    `{"schema_version":${manifest.schema_version}` +
    `,"company_id":${JSON.stringify(manifest.company_id)}` +
    `,"as_of":${JSON.stringify(manifest.as_of)}` +
    `,"environment":${JSON.stringify(manifest.environment)}` +
    `,"generated_at":${JSON.stringify(manifest.generated_at)}` +
    `,"total_jobs_scanned":${manifest.total_jobs_scanned}` +
    `,"jobs":[${manifest.jobs.map(jobPart).join(",")}]` +
    `,"excluded_jobs":[${manifest.excluded_jobs.map(excludedPart).join(",")}]}`
  );
}

/** sha256 hex digest via the Web Crypto API (available in both Cloudflare
 * Workers/workerd and Node >=19's global `crypto`) — no I/O, deterministic
 * given the same input, computed over `canonicalizeManifest`'s stable
 * string form so two structurally-identical manifests always hash
 * identically regardless of how their in-memory objects were built. */
export async function hashManifest(manifest: Omit<BackfillManifest, "manifest_hash">): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalizeManifest(manifest));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** sha256 hex digest of a raw confirmation token string — same primitive
 * as hashManifest, used so migration 0086's `confirmation_token_hash`
 * column never has to store (or this file ever has to log) the actual
 * token a human typed in. */
export async function hashConfirmationToken(token: string): Promise<string> {
  const bytes = new TextEncoder().encode(token);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Plain-value inputs this engine needs to decide whether ONE classified
 * job becomes a manifest row, an excluded-with-reason entry, or (should
 * never happen given classifyJobForBackfill's own contract, but checked
 * anyway per this file's "never trust upstream blindly" discipline) is
 * simply skipped because it isn't in a safe bucket at all. All DB reads
 * that produce these values live in the repos layer (generateBackfillManifest) —
 * this function only combines already-fetched plain values. */
export interface JobRowInputs {
  classification: JobBackfillClassification;
  /** estimates.id for the job's accepted estimate — null only if
   * classification.bucket isn't a safe bucket (defensive; the classifier's
   * own contract guarantees a safe-bucket classification always came from
   * a usable accepted estimate, but this engine never assumes that without
   * checking). */
  estimate_id: string | null;
  /** estimates.subtotal_cents (NOT total_cents — see
   * BackfillManifestJobRow.direct_cost_budget_cents's doc comment for why
   * these are different fields). Null/undefined-safe: a malformed/missing
   * subtotal routes this job to excluded_jobs, never a fabricated 0. */
  estimate_subtotal_cents: number | null;
  division: string | null;
  overhead_rate_used: number | null;
  /** Only consulted for the service_units bucket; the repos layer computes
   * this via a real plan_visits query (resolveRemainingPlanVisits) and
   * must pass null (not 0) when it couldn't compute a real count, so this
   * function can tell "no count available" apart from "confirmed zero
   * remaining visits" — both route to excluded_jobs, but with different,
   * honest reasons. */
  remaining_service_units: number | null;
}

/** Builds exactly one manifest row (or an excluded-job entry) from
 * already-resolved plain inputs — the one place a
 * JobBackfillClassification turns into (or is refused from becoming) a
 * BackfillManifestJobRow. Never throws on malformed input; every failure
 * mode routes to `{ excluded: ... }` with a specific reason, same
 * defensive-by-construction discipline as classifyJobForBackfill itself. */
export function buildManifestRowOrExclusion(
  input: JobRowInputs,
): { row: BackfillManifestJobRow } | { excluded: ExcludedBackfillJob } {
  const { classification } = input;
  const job_id = classification.job_id;

  if (!isSafeBucket(classification.bucket)) {
    return {
      excluded: {
        job_id,
        bucket: classification.bucket,
        reason: `bucket "${classification.bucket}" is not one of the two safe write buckets (${SAFE_BACKFILL_BUCKETS.join(", ")}) — never eligible for a manifest row`,
      },
    };
  }
  if (!classification.would_need_review) {
    // Defense in depth: every reachable path into a safe bucket already
    // sets would_need_review=true (backfill-analysis.ts's own contract),
    // but this engine never trusts that without checking — mandate item
    // 19's "never silently approve a budget version" applies here too.
    return {
      excluded: {
        job_id,
        bucket: classification.bucket,
        reason: "safe-bucket classification did not carry would_need_review=true — refusing to build a row that isn't honestly flagged for manual review",
      },
    };
  }
  if (!input.estimate_id) {
    return { excluded: { job_id, bucket: classification.bucket, reason: "no accepted-estimate id resolved for this job — cannot stamp source_id" } };
  }
  if (
    input.estimate_subtotal_cents === null ||
    input.estimate_subtotal_cents === undefined ||
    !Number.isFinite(input.estimate_subtotal_cents) ||
    input.estimate_subtotal_cents < 0
  ) {
    return {
      excluded: {
        job_id,
        bucket: classification.bucket,
        reason: "estimates.subtotal_cents is missing/negative/non-numeric for this job's accepted estimate — never guessing a direct-cost budget from an unusable subtotal",
      },
    };
  }
  if (!input.division) {
    return { excluded: { job_id, bucket: classification.bucket, reason: "division did not resolve at manifest-build time (should be unreachable given the classifier's own gate — treated as a hard stop, not assumed)" } };
  }
  if (input.overhead_rate_used === null || input.overhead_rate_used === undefined || !Number.isFinite(input.overhead_rate_used)) {
    return { excluded: { job_id, bucket: classification.bucket, reason: "overhead_rate_used did not resolve at manifest-build time (should be unreachable given the classifier's own gate — treated as a hard stop, not assumed)" } };
  }
  if (classification.resolved_completion_method === null) {
    return { excluded: { job_id, bucket: classification.bucket, reason: "resolved_completion_method is null (should be unreachable in a safe bucket) — refusing to guess cost_to_cost vs service_units" } };
  }

  let service_units_planned: number | null = null;
  if (classification.resolved_completion_method === "service_units") {
    if (
      input.remaining_service_units === null ||
      input.remaining_service_units === undefined ||
      !Number.isFinite(input.remaining_service_units) ||
      input.remaining_service_units <= 0
    ) {
      return {
        excluded: {
          job_id,
          bucket: classification.bucket,
          reason: "recurring-plan-linked job has no resolvable positive remaining scheduled-visit count as of as_of — §10 step 3's service_units_planned cannot be backfilled without guessing, skipping per 'skip, don't guess'",
        },
      };
    }
    service_units_planned = input.remaining_service_units;
  }

  const subtotal = input.estimate_subtotal_cents;
  return {
    row: {
      job_id,
      source_id: input.estimate_id,
      bucket: classification.bucket,
      division: input.division,
      contract_value_cents: subtotal >= 0 ? subtotal : 0, // unreachable given the check above; kept for type-narrowing clarity
      overhead_rate_used: input.overhead_rate_used,
      direct_cost_budget_cents: subtotal,
      completion_method: classification.resolved_completion_method,
      service_units_planned,
    },
  };
}

/**
 * NOTE on contract_value_cents above: §10 step 1 says
 * `contract_value_cents = estimates.total` (the SELLING price), while
 * direct_cost_budget_cents comes from `estimates.subtotal` (step 2) — two
 * different estimate fields. `buildManifestRowOrExclusion`'s `JobRowInputs`
 * deliberately only carries `estimate_subtotal_cents` (direct-cost budget's
 * source) because that is the one figure this engine's malformed-record
 * defense (the check above) must gate on; `contract_value_cents` itself
 * must be supplied as `estimate_total_cents` by the repos layer via a
 * SEPARATE field so a malformed total_cents doesn't get silently
 * conflated with a valid subtotal_cents (or vice versa) — seeAdjust below.
 */
export interface JobRowInputsWithContractValue extends JobRowInputs {
  /** estimates.total_cents — §10 step 1's contract_value_cents source,
   * kept separate from estimate_subtotal_cents (step 2's direct-cost-
   * budget source) so a malformed value in one never silently substitutes
   * for the other. Null/negative/non-numeric routes to excluded_jobs, same
   * as an unusable subtotal. */
  estimate_total_cents: number | null;
}

/** The real entry point (buildManifestRowOrExclusion above is kept
 * exported for direct unit testing of the subtotal/division/overhead/
 * service-units validation branches in isolation, but every real caller —
 * generateBackfillManifest — must go through this wrapper, which adds the
 * contract_value_cents-specific check `buildManifestRowOrExclusion` alone
 * does not perform). */
export function buildManifestRow(
  input: JobRowInputsWithContractValue,
): { row: BackfillManifestJobRow } | { excluded: ExcludedBackfillJob } {
  if (
    input.estimate_total_cents === null ||
    input.estimate_total_cents === undefined ||
    !Number.isFinite(input.estimate_total_cents) ||
    input.estimate_total_cents < 0
  ) {
    return {
      excluded: {
        job_id: input.classification.job_id,
        bucket: input.classification.bucket,
        reason: "estimates.total_cents is missing/negative/non-numeric for this job's accepted estimate — never guessing a contract value from an unusable total",
      },
    };
  }
  const result = buildManifestRowOrExclusion(input);
  if ("excluded" in result) return result;
  return { row: { ...result.row, contract_value_cents: input.estimate_total_cents } };
}

/** Assembles the full manifest from a list of per-job build results —
 * pure aggregation, mirrors buildBackfillAnalysisReport's own role in
 * backfill-analysis.ts. `generated_at`/`environment`/`company_id`/`as_of`
 * are all caller-supplied (this function invents none of them); the hash
 * is computed by the caller (generateBackfillManifest) via hashManifest,
 * since hashing is async and this aggregation step deliberately stays
 * sync so it can be unit-tested without awaiting anything. */
export function assembleManifestJobs(
  results: Array<{ row: BackfillManifestJobRow } | { excluded: ExcludedBackfillJob }>,
): { jobs: BackfillManifestJobRow[]; excluded_jobs: ExcludedBackfillJob[] } {
  const jobs: BackfillManifestJobRow[] = [];
  const excluded_jobs: ExcludedBackfillJob[] = [];
  for (const r of results) {
    if ("row" in r) jobs.push(r.row);
    else excluded_jobs.push(r.excluded);
  }
  jobs.sort((a, b) => (a.job_id < b.job_id ? -1 : a.job_id > b.job_id ? 1 : 0));
  excluded_jobs.sort((a, b) => (a.job_id < b.job_id ? -1 : a.job_id > b.job_id ? 1 : 0));
  return { jobs, excluded_jobs };
}

export interface ManifestValidationResult {
  valid: boolean;
  errors: string[];
}

/** Structural self-consistency checks a manifest must ALWAYS satisfy,
 * independent of when/where it's being validated (generation time or
 * execution time) — no duplicate job_ids, every job in a safe bucket,
 * every job's needs_review-equivalent invariants hold, non-negative money,
 * required completion-method/service-units pairing. Called by both
 * generateBackfillManifest (as a sanity check on its own output) and
 * validateManifestForExecution (as the first line of defense against a
 * hand-edited/corrupted manifest file). */
export function validateManifestStructure(manifest: BackfillManifest): ManifestValidationResult {
  const errors: string[] = [];

  if (manifest.schema_version !== BACKFILL_MANIFEST_SCHEMA_VERSION) {
    errors.push(`schema_version ${manifest.schema_version} does not match the current schema version ${BACKFILL_MANIFEST_SCHEMA_VERSION}`);
  }
  try {
    assertUsableTenantId(manifest.company_id);
  } catch (e) {
    errors.push((e as Error).message);
  }
  if (!manifest.as_of || manifest.as_of.trim() === "") errors.push("as_of is empty");
  if (manifest.environment !== "local" && manifest.environment !== "remote") {
    errors.push(`environment must be "local" or "remote", got "${manifest.environment}"`);
  }
  if (manifest.jobs.length > MAX_MANIFEST_JOBS) {
    errors.push(`manifest has ${manifest.jobs.length} job rows, exceeding MAX_MANIFEST_JOBS=${MAX_MANIFEST_JOBS} — split into multiple manifests`);
  }

  const seen = new Set<string>();
  for (const j of manifest.jobs) {
    if (seen.has(j.job_id)) errors.push(`duplicate job_id in manifest: ${j.job_id}`);
    seen.add(j.job_id);

    if (!isSafeBucket(j.bucket)) errors.push(`job ${j.job_id}: bucket "${j.bucket}" is not a safe write bucket`);
    if (!j.division || j.division.trim() === "") errors.push(`job ${j.job_id}: division is empty`);
    if (!Number.isFinite(j.contract_value_cents) || j.contract_value_cents < 0) errors.push(`job ${j.job_id}: contract_value_cents is invalid (${j.contract_value_cents})`);
    if (!Number.isFinite(j.direct_cost_budget_cents) || j.direct_cost_budget_cents < 0) errors.push(`job ${j.job_id}: direct_cost_budget_cents is invalid (${j.direct_cost_budget_cents})`);
    if (!Number.isFinite(j.overhead_rate_used) || j.overhead_rate_used < 0) errors.push(`job ${j.job_id}: overhead_rate_used is invalid (${j.overhead_rate_used})`);
    if (j.completion_method === "service_units") {
      if (j.service_units_planned === null || !Number.isFinite(j.service_units_planned) || j.service_units_planned <= 0) {
        errors.push(`job ${j.job_id}: completion_method=service_units requires a positive service_units_planned, got ${j.service_units_planned}`);
      }
    } else if (j.service_units_planned !== null) {
      errors.push(`job ${j.job_id}: completion_method=cost_to_cost must have service_units_planned=null, got ${j.service_units_planned}`);
    }
  }

  const jobSum = manifest.jobs.length + manifest.excluded_jobs.length;
  if (jobSum > manifest.total_jobs_scanned) {
    errors.push(`jobs.length (${manifest.jobs.length}) + excluded_jobs.length (${manifest.excluded_jobs.length}) = ${jobSum} exceeds total_jobs_scanned (${manifest.total_jobs_scanned})`);
  }

  return { valid: errors.length === 0, errors };
}

/** Everything needed to validate a manifest is safe to EXECUTE right now,
 * gathered fresh by the repos layer at execute time — never taken from the
 * manifest's own claims about itself except where explicitly comparing
 * against them (that's the whole point: the manifest describes a past
 * moment, this context describes the present one). */
export interface ExecutionContext {
  /** The tenant the caller actually intends to write into — compared
   * against manifest.company_id; a mismatch means "wrong manifest for this
   * run," refused outright (never silently redirected to the manifest's
   * own company_id, which would defeat the whole "explicit tenant
   * targeting" safety property). */
  expectedCompanyId: string;
  /** The environment the caller is actually about to write into (which D1
   * binding is live — 'local' for --local, 'remote' for --remote). */
  expectedEnvironment: BackfillManifestEnvironment;
  /** Current wall-clock time, ISO-8601 — injected rather than read from
   * `Date.now()` inside this function so staleness checks are unit-
   * testable without mocking global time. */
  nowIso: string;
  /** The manifest's own recomputed hash (via hashManifest, computed by the
   * repos layer since hashing is async) — compared against
   * manifest.manifest_hash; any difference means the manifest JSON was
   * altered after generation (tampering or an accidental hand-edit). */
  recomputedHash: string;
}

/** The single gate every execution must pass before repos layer's
 * executeBackfillManifest is allowed to build so much as one SQL
 * statement. Returns every violation found (not just the first) so a
 * human reviewing a refusal sees the whole picture at once. */
export function validateManifestForExecution(manifest: BackfillManifest, ctx: ExecutionContext): ManifestValidationResult {
  const structural = validateManifestStructure(manifest);
  const errors = [...structural.errors];

  if (manifest.manifest_hash !== ctx.recomputedHash) {
    errors.push("manifest_hash does not match the recomputed hash of this manifest's contents — the manifest file was altered after generation, or is corrupted; refusing to execute a manifest that cannot be verified byte-for-byte");
  }
  if (manifest.company_id !== ctx.expectedCompanyId) {
    errors.push(`manifest.company_id ("${manifest.company_id}") does not match the tenant this run is targeting ("${ctx.expectedCompanyId}") — refusing to execute a manifest generated for a different tenant`);
  }
  if (manifest.environment !== ctx.expectedEnvironment) {
    errors.push(`manifest.environment ("${manifest.environment}") does not match the environment this run is actually targeting ("${ctx.expectedEnvironment}") — refusing to execute a local-generated manifest against remote, or vice versa`);
  }

  const generatedAtMs = Date.parse(manifest.generated_at);
  const nowMs = Date.parse(ctx.nowIso);
  if (!Number.isFinite(generatedAtMs)) {
    errors.push(`manifest.generated_at ("${manifest.generated_at}") is not a parseable timestamp`);
  } else if (!Number.isFinite(nowMs)) {
    errors.push(`ctx.nowIso ("${ctx.nowIso}") is not a parseable timestamp`);
  } else if (nowMs - generatedAtMs > MAX_MANIFEST_AGE_MS) {
    const ageHours = ((nowMs - generatedAtMs) / (60 * 60 * 1000)).toFixed(1);
    errors.push(`manifest is ${ageHours}h old, exceeding MAX_MANIFEST_AGE_MS (${MAX_MANIFEST_AGE_MS / (60 * 60 * 1000)}h) — regenerate a fresh manifest immediately before executing rather than trusting stale bucket data`);
  } else if (nowMs < generatedAtMs) {
    errors.push(`manifest.generated_at ("${manifest.generated_at}") is in the future relative to ctx.nowIso ("${ctx.nowIso}") — refusing a manifest with an inconsistent clock`);
  }

  return { valid: errors.length === 0, errors };
}

/** Builds the exact Omit<JobBudgetVersion,"created_at"> shape
 * insertJobBudgetVersion (src/db/repos.ts) expects, from one manifest row
 * plus the execute-time-only fields (id, approved_at, approved_by) —
 * needs_review is HARD-CODED to 1 here, never a parameter, per mandate
 * item 19 ("never silently approve a budget version"): every row this
 * file can possibly build came from a would_create_needs_review_* bucket,
 * so needs_review=1 is not a choice this function makes, it's the only
 * value consistent with how the row got here at all. */
export function buildJobBudgetVersionInsertRow(
  jobRow: BackfillManifestJobRow,
  meta: { id: string; approvedAt: string; approvedBy: string },
): Omit<JobBudgetVersion, "created_at"> {
  return {
    id: meta.id,
    company_id: "", // filled in by the repos layer (this engine has no notion of "which tenant" beyond what's already on the manifest as a whole)
    job_id: jobRow.job_id,
    source_type: "estimate",
    source_id: jobRow.source_id,
    revision_seq: 0, // §10 step 1: the baseline is always revision_seq=0 — a job in a safe bucket has, by the classifier's own already_has_budget_version gate, no existing revision of any kind.
    contract_value_cents: jobRow.contract_value_cents as Cents,
    labor_hours_budgeted_hundredths: 0 as JobBudgetVersion["labor_hours_budgeted_hundredths"],
    labor_rate_used: null,
    materials_budget_cents: 0 as Cents,
    subcontractor_budget_cents: 0 as Cents,
    equipment_budget_cents: 0 as Cents,
    disposal_budget_cents: 0 as Cents,
    permits_budget_cents: 0 as Cents,
    other_direct_budget_cents: jobRow.direct_cost_budget_cents as Cents,
    direct_cost_budget_cents: jobRow.direct_cost_budget_cents as Cents,
    division: jobRow.division,
    overhead_rate_used: jobRow.overhead_rate_used as TenThousandths,
    budgeted_overhead_cents: 0 as Cents,
    target_margin_millionths: null,
    completion_method: jobRow.completion_method,
    service_units_planned: jobRow.service_units_planned,
    needs_review: 1,
    approved_at: meta.approvedAt,
    approved_by: meta.approvedBy,
  };
}

export interface ReconciliationExpectation {
  /** manifest.jobs.length — the number of job_budget_versions rows this
   * execution SHOULD create, assuming zero races (every job still
   * eligible at execute time). Compared against the batch's actual
   * `rows_written` after execution; per-job WHERE-NOT-EXISTS guards (repos
   * layer) mean a lower actual count is possible (and safe — see
   * concurrency-protection doc comment above) but never a HIGHER one. */
  expected_max_rows_written: number;
  /** Restates the manifest's own accounting for a human to eyeball before
   * approving execution — mirrors the runbook's §8 Invariant 1
   * (bucket-sum == total_jobs_scanned) extended to this manifest's
   * narrower jobs/excluded_jobs split. */
  total_jobs_scanned: number;
  jobs_in_manifest: number;
  jobs_excluded: number;
}

/** Pure, pre-execution description of what SHOULD happen — the repos
 * layer's dry-run output surfaces this directly; a human reviews it
 * before ever supplying a confirmation token. */
export function describeReconciliation(manifest: BackfillManifest): ReconciliationExpectation {
  return {
    expected_max_rows_written: manifest.jobs.length,
    total_jobs_scanned: manifest.total_jobs_scanned,
    jobs_in_manifest: manifest.jobs.length,
    jobs_excluded: manifest.excluded_jobs.length,
  };
}

export interface RollbackPlan {
  reversible: boolean;
  summary: string;
  manual_steps: string[];
}

/** Pure, static description of how to undo one execution — this function
 * never runs a rollback itself (per this file's header comment, and
 * matching docs/RUNBOOK-item4-stage2-backfill.md §10's existing "manual,
 * careful, Tyler-supervised operation, not an automated rollback script"
 * stance). Kept here so the CLI/runbook can print the exact same text the
 * engine's own tests assert against, rather than the two drifting apart. */
export function describeRollbackPlan(execution: { manifest_hash: string; started_at: string; company_id: string }): RollbackPlan {
  return {
    reversible: false,
    summary:
      "Not reversible via any built-in tool. A job_budget_versions row created by this execution can only be removed by a manual, careful, human-supervised restore from the pre-execution backup — never by an automated script (see RUNBOOK §10).",
    manual_steps: [
      `Confirm the pre-execution backup exists (docs/RUNBOOK-item4-stage2-backfill.md §1) and covers company_id='${execution.company_id}'.`,
      `Identify every row this execution created: SELECT * FROM job_budget_versions WHERE company_id = '${execution.company_id}' AND revision_seq = 0 AND created_at >= '${execution.started_at}'`,
      `Cross-reference against backfill_manifest_execution WHERE manifest_hash = '${execution.manifest_hash}' to confirm the exact row count expected (rows_written column).`,
      "DELETE those specific rows (by id, not a broad company_id+timestamp range) only after confirming with the backup which ones are safe to remove.",
      "Re-import the pre-execution backup's job_budget_versions rows for this tenant if any were overwritten (should never happen — this tool never UPDATEs an existing row — but verify).",
      "This is a manual, Tyler-supervised operation. Never scripted, never automated, never run without the backup already confirmed non-empty.",
    ],
  };
}
