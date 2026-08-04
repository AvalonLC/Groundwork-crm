import { computeRecoveryProjection } from "../engines/recovery";

export interface TenantRollupInput {
  tenant_id: string;
  as_of: string; // YYYY-MM-DD
  restated_target_cents: number;
  recovered_to_date_cents: number;
  hours_per_week_hundredths: number;
  blended_overhead_rate: number; // ten-thousandths, $/hr
  /** See docs/spec/RECOVERY.md — provisional until snapshot history exists
   * to derive a real trailing-variance window. */
  confidence_days: number;
  /** For absorption variance: budgeted (allocated) vs. actually absorbed
   * overhead over the same period, both in cents. */
  budgeted_overhead_cents: number;
  absorbed_overhead_cents: number;
}

export interface TenantRollupResult {
  tenant_id: string;
  as_of: string;
  restated_target_cents: number;
  recovered_to_date_cents: number;
  hours_per_week_hundredths: number;
  blended_overhead_rate: number;
  weekly_recovery_cents: number;
  pct_recovered_millionths: number;
  projected_black_friday: string;
  confidence_days: number;
  /** absorbed - budgeted: positive = absorbing more overhead than planned. */
  absorption_variance_cents: number;
}

/** Pure. See docs/spec/RECOVERY.md for the underlying formulas. */
export function buildTenantRollup(input: TenantRollupInput): TenantRollupResult {
  const projection = computeRecoveryProjection({
    as_of: input.as_of,
    restated_target: input.restated_target_cents / 100,
    recovered_to_date: input.recovered_to_date_cents / 100,
    hours_per_week: input.hours_per_week_hundredths / 100,
    blended_overhead_rate: input.blended_overhead_rate / 10000,
    confidence_days: input.confidence_days,
  });

  return {
    tenant_id: input.tenant_id,
    as_of: input.as_of,
    restated_target_cents: input.restated_target_cents,
    recovered_to_date_cents: input.recovered_to_date_cents,
    hours_per_week_hundredths: input.hours_per_week_hundredths,
    blended_overhead_rate: input.blended_overhead_rate,
    weekly_recovery_cents: Math.round(projection.weekly_recovery * 100),
    pct_recovered_millionths: Math.round(projection.pct_recovered * 1_000_000),
    projected_black_friday: projection.projected_black_friday,
    confidence_days: projection.confidence_days,
    absorption_variance_cents: input.absorbed_overhead_cents - input.budgeted_overhead_cents,
  };
}

/**
 * Nightly cron rollup. See docs/spec/RECOVERY.md — Cloudflare Pages has no
 * native Cron Trigger, so what actually invokes this on a schedule (a
 * companion Worker, or an external scheduled caller hitting an authenticated
 * endpoint) is still an open infrastructure decision, not resolved here.
 * This function is the invocable unit either path would call.
 *
 * Writes every tenant's recovery_snapshot row in ONE db.batch() call —
 * forbidden: "row-by-row writes". Recovery recognition source is entirely
 * upstream (the caller supplies recovered_to_date_cents, already derived
 * from time_entry hours per CLAUDE.md hard rule 3); this function never
 * touches invoice/deposit/payment data itself.
 */
export async function runNightlyRollup(
  db: D1Database, inputs: TenantRollupInput[],
): Promise<TenantRollupResult[]> {
  const results = inputs.map(buildTenantRollup);

  const statements = results.map((r) => db.prepare(`
    INSERT INTO recovery_snapshot
      (tenant_id, as_of, restated_target_cents, recovered_to_date_cents,
       hours_per_week_hundredths, blended_overhead_rate, weekly_recovery_cents,
       pct_recovered_millionths, projected_black_friday, confidence_days)
    VALUES (?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(tenant_id, as_of) DO UPDATE SET
      restated_target_cents = excluded.restated_target_cents,
      recovered_to_date_cents = excluded.recovered_to_date_cents,
      hours_per_week_hundredths = excluded.hours_per_week_hundredths,
      blended_overhead_rate = excluded.blended_overhead_rate,
      weekly_recovery_cents = excluded.weekly_recovery_cents,
      pct_recovered_millionths = excluded.pct_recovered_millionths,
      projected_black_friday = excluded.projected_black_friday,
      confidence_days = excluded.confidence_days
  `).bind(
    r.tenant_id, r.as_of, r.restated_target_cents, r.recovered_to_date_cents,
    r.hours_per_week_hundredths, r.blended_overhead_rate, r.weekly_recovery_cents,
    r.pct_recovered_millionths, r.projected_black_friday, r.confidence_days,
  ));

  if (statements.length > 0) await db.batch(statements);
  return results;
}
