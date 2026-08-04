import { approvalThresholds } from "../config/finance-config";
import { computeBlendedOverheadRate } from "../engines/allocation";
import type { TenantRollupInput } from "./rollup";

/**
 * Assembles a TenantRollupInput from real tables for one tenant. The
 * derivations below for recovered_to_date/budgeted/absorbed are reasonable
 * but INFERRED, not confirmed business logic — same status as every other
 * placeholder default in this build (docs/spec/RECOVERY.md flagged the
 * underlying ambiguity in wave 0). Safe to run, worth reviewing before
 * trusting the numbers for anything customer-facing.
 */
export async function gatherTenantRollupInputs(
  db: D1Database, tenantId: string, asOf: string,
): Promise<TenantRollupInput | null> {
  const policy = await db.prepare(
    `SELECT restated_target_cents FROM tenant_finance_policy WHERE tenant_id = ?`,
  ).bind(tenantId).first<{ restated_target_cents: number }>();
  if (!policy) return null; // no policy row -> tenant isn't set up for Finance OS yet

  // "Recovered to date" = cumulative overhead absorbed via posted work,
  // year-to-date. Proxy: sum of job_cost_ledger overhead lines this
  // calendar year. Inferred, not confirmed.
  const recoveredRow = await db.prepare(`
    SELECT COALESCE(SUM(amount_cents), 0) as total FROM job_cost_ledger
    WHERE tenant_id = ? AND line_type = 'overhead' AND posted_at >= ?
  `).bind(tenantId, `${asOf.slice(0, 4)}-01-01`).first<{ total: number }>();

  // Hours logged in the trailing 7 days, posted entries only.
  const weekAgo = new Date(new Date(`${asOf}T00:00:00Z`).getTime() - 7 * 86_400_000).toISOString().slice(0, 10);
  const hoursRow = await db.prepare(`
    SELECT COALESCE(SUM(hours_hundredths), 0) as total FROM time_entry
    WHERE tenant_id = ? AND work_date >= ? AND work_date <= ? AND posted_at IS NOT NULL
  `).bind(tenantId, weekAgo, asOf).first<{ total: number }>();

  // Blended rate from the tenant's most recent overhead_allocation rows
  // (one per division, same as_of).
  const latestAsOfRow = await db.prepare(
    `SELECT MAX(as_of) as as_of FROM overhead_allocation WHERE tenant_id = ?`,
  ).bind(tenantId).first<{ as_of: string | null }>();
  let blendedRate = 0;
  if (latestAsOfRow?.as_of) {
    const totals = await db.prepare(`
      SELECT COALESCE(SUM(allocated_overhead_cents), 0) as overhead, COALESCE(SUM(sellable_hours), 0) as hours
      FROM overhead_allocation WHERE tenant_id = ? AND as_of = ?
    `).bind(tenantId, latestAsOfRow.as_of).first<{ overhead: number; hours: number }>();
    if (totals && totals.hours > 0) {
      blendedRate = computeBlendedOverheadRate(totals.overhead, totals.hours) * 10000; // dollars/hr -> ten-thousandths
    }
  }

  // Absorption variance inputs: budgeted = this week's share of allocated
  // overhead (annual / 52); absorbed = overhead lines posted this week.
  // Both inferred proxies, not confirmed formulas.
  const budgetedRow = latestAsOfRow?.as_of
    ? await db.prepare(`
        SELECT COALESCE(SUM(allocated_overhead_cents), 0) as total FROM overhead_allocation
        WHERE tenant_id = ? AND as_of = ?
      `).bind(tenantId, latestAsOfRow.as_of).first<{ total: number }>()
    : { total: 0 };
  const absorbedThisWeekRow = await db.prepare(`
    SELECT COALESCE(SUM(amount_cents), 0) as total FROM job_cost_ledger
    WHERE tenant_id = ? AND line_type = 'overhead' AND posted_at >= ?
  `).bind(tenantId, weekAgo).first<{ total: number }>();

  return {
    tenant_id: tenantId,
    as_of: asOf,
    restated_target_cents: policy.restated_target_cents,
    recovered_to_date_cents: recoveredRow?.total ?? 0,
    hours_per_week_hundredths: hoursRow?.total ?? 0,
    blended_overhead_rate: Math.round(blendedRate),
    confidence_days: approvalThresholds.recovery_confidence_days_default,
    budgeted_overhead_cents: Math.round((budgetedRow?.total ?? 0) / 52),
    absorbed_overhead_cents: absorbedThisWeekRow?.total ?? 0,
  };
}

export async function listTenantIdsWithPolicy(db: D1Database): Promise<string[]> {
  const { results } = await db.prepare(`SELECT DISTINCT tenant_id FROM tenant_finance_policy`).all<{ tenant_id: string }>();
  return results.map((r) => r.tenant_id);
}
