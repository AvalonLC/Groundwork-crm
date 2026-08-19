import { approvalThresholds } from "../config/finance-config";
import { computeBlendedOverheadRate } from "../engines/allocation";
import type { TenantRollupInput } from "./rollup";

/**
 * Assembles a TenantRollupInput from real tables for one company. The
 * derivations below for recovered_to_date/budgeted/absorbed are reasonable
 * but INFERRED, not confirmed business logic — same status as every other
 * placeholder default in this build (docs/spec/RECOVERY.md flagged the
 * underlying ambiguity in wave 0). Safe to run, worth reviewing before
 * trusting the numbers for anything customer-facing.
 *
 * EVERY query here is bounded at BOTH ends by asOf. Three of them were not:
 * recovered_to_date and absorbed_this_week had a lower bound only, and the
 * blended rate took MAX(as_of) with no bound at all. That is invisible on the
 * nightly run, where asOf is today and there is no future to leak — and wrong
 * the moment anyone backfills, because a snapshot labelled 2026-08-14 would
 * carry ledger lines posted on the 19th and an allocation set after the fact.
 * A backfilled row that looks authoritative and is not is worse than no row.
 *
 * time_entries has no work_date/hours_hundredths columns of its own (see
 * migrations/0057_finance_merge.sql) — both are derived inline here, same
 * as everywhere else that reads a Finance-side view of a time entry.
 */
export async function gatherTenantRollupInputs(
  db: D1Database, companyId: string, asOf: string,
): Promise<TenantRollupInput | null> {
  const policy = await db.prepare(
    `SELECT restated_target_cents FROM tenant_finance_policy WHERE company_id = ?`,
  ).bind(companyId).first<{ restated_target_cents: number }>();
  if (!policy) return null; // no policy row -> company isn't set up for Finance OS yet

  // "Recovered to date" = cumulative overhead absorbed via posted work,
  // year-to-date. Proxy: sum of job_cost_ledger overhead lines this
  // calendar year. Inferred, not confirmed.
  const recoveredRow = await db.prepare(`
    SELECT COALESCE(SUM(amount_cents), 0) as total FROM job_cost_ledger
    WHERE company_id = ? AND line_type = 'overhead'
      AND substr(posted_at, 1, 10) >= ? AND substr(posted_at, 1, 10) <= ?
  `).bind(companyId, `${asOf.slice(0, 4)}-01-01`, asOf).first<{ total: number }>();

  // Hours logged in the trailing 7 days, posted entries only.
  const weekAgo = new Date(new Date(`${asOf}T00:00:00Z`).getTime() - 7 * 86_400_000).toISOString().slice(0, 10);
  const hoursRow = await db.prepare(`
    SELECT COALESCE(SUM(CAST(ROUND(COALESCE(duration_min, 0) * 100.0 / 60) AS INTEGER)), 0) as total
    FROM time_entries
    WHERE company_id = ? AND substr(clock_in, 1, 10) >= ? AND substr(clock_in, 1, 10) <= ? AND posted_at IS NOT NULL
  `).bind(companyId, weekAgo, asOf).first<{ total: number }>();

  // Blended rate from the allocation rows in effect ON asOf — the most recent
  // set at or before it, not the most recent set that exists. Unbounded MAX()
  // meant a backfilled date got today's allocation, so a snapshot labelled
  // 2026-08-14 would carry a rate that was not set until days later.
  const latestAsOfRow = await db.prepare(
    `SELECT MAX(as_of) as as_of FROM overhead_allocation WHERE company_id = ? AND as_of <= ?`,
  ).bind(companyId, asOf).first<{ as_of: string | null }>();
  let blendedRate = 0;
  if (latestAsOfRow?.as_of) {
    const totals = await db.prepare(`
      SELECT COALESCE(SUM(allocated_overhead_cents), 0) as overhead, COALESCE(SUM(sellable_hours), 0) as hours
      FROM overhead_allocation WHERE company_id = ? AND as_of = ?
    `).bind(companyId, latestAsOfRow.as_of).first<{ overhead: number; hours: number }>();
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
        WHERE company_id = ? AND as_of = ?
      `).bind(companyId, latestAsOfRow.as_of).first<{ total: number }>()
    : { total: 0 };
  const absorbedThisWeekRow = await db.prepare(`
    SELECT COALESCE(SUM(amount_cents), 0) as total FROM job_cost_ledger
    WHERE company_id = ? AND line_type = 'overhead'
      AND substr(posted_at, 1, 10) >= ? AND substr(posted_at, 1, 10) <= ?
  `).bind(companyId, weekAgo, asOf).first<{ total: number }>();

  return {
    company_id: companyId,
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
  const { results } = await db.prepare(`SELECT DISTINCT company_id FROM tenant_finance_policy`).all<{ company_id: string }>();
  return results.map((r) => r.company_id);
}
