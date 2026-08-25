import type {
  ActionItem, ActionVerb, ChangeOrder, ClassificationFinding, DirectCostCategory,
  EquipmentRateProfile, FinanceConfigOverride, FinanceTimeEntry, FinanceWorkOrder,
  FinanceWorkOrderProgress, JobBudgetVersion, JobCostLedger, JobCostLedgerAdjustment,
  LaborRateProfile, OverheadAllocation, OverheadPool,
  RateConfidence, Receipt, RecoverySnapshot, TenantFinancePolicy,
  TimeEntryAdjustment, UploadBatch, UploadDomain,
} from "./schema";
import type { LedgerLineForProgress } from "../engines/job-progress";

export const GLOBAL_CONFIG_SCOPE = "__global__";

/**
 * D1-backed repository layer. See docs/spec/SCHEMA.md and
 * migrations/0057_finance_merge.sql (2026-08-09) -- Finance OS tables now
 * live in the same database as the CRM's own tables (`companies`,
 * `work_orders`, `time_entries`, `crews`), no separate FINANCE_DB. Every
 * function below takes the single `DB` binding.
 *
 * HARD RULE (CLAUDE.md #2, W1-repos forbidden list): *_rate_profile rows are
 * immutable. The only UPDATE this file ever issues against labor_rate_profile
 * or equipment_rate_profile touches effective_to alone, to close out the row a
 * recalibration supersedes — never a rate/cost column. There is intentionally
 * no "updateLaborRateProfile" function of any kind.
 */

// ---- tenant_finance_policy ----

export async function getTenantFinancePolicy(
  db: D1Database, companyId: string,
): Promise<TenantFinancePolicy | null> {
  return db.prepare(`SELECT * FROM tenant_finance_policy WHERE company_id = ?`)
    .bind(companyId).first<TenantFinancePolicy>();
}

export async function upsertTenantFinancePolicy(
  db: D1Database, policy: TenantFinancePolicy,
): Promise<void> {
  await db.prepare(`
    INSERT INTO tenant_finance_policy
      (company_id, equipment_engine_active, materiality_threshold_cents,
       restated_target_cents, black_friday_date, updated_at)
    VALUES (?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(company_id) DO UPDATE SET
      equipment_engine_active = excluded.equipment_engine_active,
      materiality_threshold_cents = excluded.materiality_threshold_cents,
      restated_target_cents = excluded.restated_target_cents,
      black_friday_date = excluded.black_friday_date,
      updated_at = datetime('now')
  `).bind(
    policy.company_id, policy.equipment_engine_active,
    policy.materiality_threshold_cents, policy.restated_target_cents,
    policy.black_friday_date,
  ).run();
}

// ---- labor_rate_profile (IMMUTABLE) ----

/** Resolves the profile in effect on `asOfDate` — BH-07: a date before a rate
 * change resolves to the OLDER profile, not the current one. */
export async function getLaborRateAsOf(
  db: D1Database, companyId: string, scope: string, scopeId: string, asOfDate: string,
): Promise<LaborRateProfile | null> {
  return db.prepare(`
    SELECT * FROM labor_rate_profile
    WHERE company_id = ? AND scope = ? AND scope_id = ?
      AND effective_from <= ?
      AND (effective_to IS NULL OR effective_to > ?)
    ORDER BY effective_from DESC LIMIT 1
  `).bind(companyId, scope, scopeId, asOfDate, asOfDate).first<LaborRateProfile>();
}

/** All currently-open (effective_to IS NULL) labor rate profiles for a company. */
export async function listCurrentLaborRates(db: D1Database, companyId: string): Promise<LaborRateProfile[]> {
  const { results } = await db.prepare(
    `SELECT * FROM labor_rate_profile WHERE company_id = ? AND effective_to IS NULL ORDER BY scope, scope_id`,
  ).bind(companyId).all<LaborRateProfile>();
  return results;
}

export async function insertLaborRateProfile(
  db: D1Database, row: Omit<LaborRateProfile, "id" | "created_at">,
): Promise<void> {
  await db.prepare(`
    INSERT INTO labor_rate_profile
      (company_id, scope, scope_id, wage_cents, paid_hours, pto_hours, shop_hours,
       idle_hours, tax_rate, comp_rate, benefits_monthly_cents,
       support_truck_annual_cents, support_tools_annual_cents,
       support_equipment_annual_cents, require_rate_approval, effective_from, effective_to)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).bind(
    row.company_id, row.scope, row.scope_id, row.wage_cents, row.paid_hours,
    row.pto_hours, row.shop_hours, row.idle_hours, row.tax_rate, row.comp_rate,
    row.benefits_monthly_cents, row.support_truck_annual_cents,
    row.support_tools_annual_cents, row.support_equipment_annual_cents,
    row.require_rate_approval, row.effective_from, row.effective_to,
  ).run();
}

/**
 * Recalibration (BH-11): closes the currently-open row's effective_to and
 * inserts a new one, atomically. Never UPDATEs a rate/cost column — the only
 * field touched on the prior row is effective_to.
 */
export async function recalibrateLaborRate(
  db: D1Database,
  companyId: string, scope: string, scopeId: string,
  newRow: Omit<LaborRateProfile, "id" | "created_at" | "effective_to">,
): Promise<void> {
  const closePrior = db.prepare(`
    UPDATE labor_rate_profile SET effective_to = ?
    WHERE company_id = ? AND scope = ? AND scope_id = ? AND effective_to IS NULL
  `).bind(newRow.effective_from, companyId, scope, scopeId);

  const insertNew = db.prepare(`
    INSERT INTO labor_rate_profile
      (company_id, scope, scope_id, wage_cents, paid_hours, pto_hours, shop_hours,
       idle_hours, tax_rate, comp_rate, benefits_monthly_cents,
       support_truck_annual_cents, support_tools_annual_cents,
       support_equipment_annual_cents, require_rate_approval, effective_from, effective_to)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL)
  `).bind(
    newRow.company_id, newRow.scope, newRow.scope_id, newRow.wage_cents,
    newRow.paid_hours, newRow.pto_hours, newRow.shop_hours, newRow.idle_hours,
    newRow.tax_rate, newRow.comp_rate, newRow.benefits_monthly_cents,
    newRow.support_truck_annual_cents, newRow.support_tools_annual_cents,
    newRow.support_equipment_annual_cents, newRow.require_rate_approval,
    newRow.effective_from,
  );

  await db.batch([closePrior, insertNew]);
}

// ---- equipment_rate_profile (IMMUTABLE) ----

export async function getEquipmentRateAsOf(
  db: D1Database, companyId: string, equipmentId: string, asOfDate: string,
): Promise<EquipmentRateProfile | null> {
  return db.prepare(`
    SELECT * FROM equipment_rate_profile
    WHERE company_id = ? AND equipment_id = ?
      AND effective_from <= ?
      AND (effective_to IS NULL OR effective_to > ?)
    ORDER BY effective_from DESC LIMIT 1
  `).bind(companyId, equipmentId, asOfDate, asOfDate).first<EquipmentRateProfile>();
}

/** All currently-open (effective_to IS NULL) equipment rate profiles for a company. */
export async function listCurrentEquipmentRates(db: D1Database, companyId: string): Promise<EquipmentRateProfile[]> {
  const { results } = await db.prepare(
    `SELECT * FROM equipment_rate_profile WHERE company_id = ? AND effective_to IS NULL ORDER BY equipment_id`,
  ).bind(companyId).all<EquipmentRateProfile>();
  return results;
}

export async function insertEquipmentRateProfile(
  db: D1Database, row: Omit<EquipmentRateProfile, "id" | "created_at">,
): Promise<void> {
  await db.prepare(`
    INSERT INTO equipment_rate_profile
      (company_id, equipment_id, purchase_price_cents, salvage_cents, life_years,
       annual_machine_hours, finance_rate, insurance_annual_cents, storage_annual_cents,
       fuel_gal_per_hr, fuel_price_cents, repairs_annual_cents, wear_annual_cents,
       lube_pct_of_fuel, effective_from, effective_to)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).bind(
    row.company_id, row.equipment_id, row.purchase_price_cents, row.salvage_cents,
    row.life_years, row.annual_machine_hours, row.finance_rate,
    row.insurance_annual_cents, row.storage_annual_cents, row.fuel_gal_per_hr,
    row.fuel_price_cents, row.repairs_annual_cents, row.wear_annual_cents,
    row.lube_pct_of_fuel, row.effective_from, row.effective_to,
  ).run();
}

/** Same immutability contract as recalibrateLaborRate — see its docstring. */
export async function recalibrateEquipmentRate(
  db: D1Database, companyId: string, equipmentId: string,
  newRow: Omit<EquipmentRateProfile, "id" | "created_at" | "effective_to">,
): Promise<void> {
  const closePrior = db.prepare(`
    UPDATE equipment_rate_profile SET effective_to = ?
    WHERE company_id = ? AND equipment_id = ? AND effective_to IS NULL
  `).bind(newRow.effective_from, companyId, equipmentId);

  const insertNew = db.prepare(`
    INSERT INTO equipment_rate_profile
      (company_id, equipment_id, purchase_price_cents, salvage_cents, life_years,
       annual_machine_hours, finance_rate, insurance_annual_cents, storage_annual_cents,
       fuel_gal_per_hr, fuel_price_cents, repairs_annual_cents, wear_annual_cents,
       lube_pct_of_fuel, effective_from, effective_to)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL)
  `).bind(
    newRow.company_id, newRow.equipment_id, newRow.purchase_price_cents,
    newRow.salvage_cents, newRow.life_years, newRow.annual_machine_hours,
    newRow.finance_rate, newRow.insurance_annual_cents, newRow.storage_annual_cents,
    newRow.fuel_gal_per_hr, newRow.fuel_price_cents, newRow.repairs_annual_cents,
    newRow.wear_annual_cents, newRow.lube_pct_of_fuel, newRow.effective_from,
  );

  await db.batch([closePrior, insertNew]);
}

// ---- work_orders (Finance-relevant columns only — see FinanceWorkOrder) ----
// work_item is gone (folded into work_orders' own estimate_cents/
// finance_completed_at columns, migrations/0057_finance_merge.sql). `status`
// here is a computed 'open'|'complete' view over work_orders.status, and
// `completed_at` is finance_completed_at aliased back to its old name — kept
// so src/engines/unbilled.ts and src/ui/job-costing.tsx didn't need to change.

const FINANCE_WORK_ORDER_SELECT = `
  SELECT id, company_id,
    CASE WHEN status = 'completed' THEN 'complete' ELSE 'open' END AS status,
    estimate_cents, finance_completed_at AS completed_at
  FROM work_orders
`;

export async function getWorkItem(
  db: D1Database, companyId: string, id: string,
): Promise<FinanceWorkOrder | null> {
  return db.prepare(`${FINANCE_WORK_ORDER_SELECT} WHERE company_id = ? AND id = ?`)
    .bind(companyId, id).first<FinanceWorkOrder>();
}

export async function listCompletedUnbilledWorkItems(
  db: D1Database, companyId: string,
): Promise<FinanceWorkOrder[]> {
  const { results } = await db.prepare(
    `${FINANCE_WORK_ORDER_SELECT} WHERE company_id = ? AND status = 'completed'`,
  ).bind(companyId).all<FinanceWorkOrder>();
  return results;
}

/**
 * Set of work_orders.id already traced to ANY invoice (any status — draft
 * counts too; the question is "has someone started billing this," not
 * "has it been paid"), via the same estimate/opportunity chain
 * syncWorkOrderFinanceColumns (src/index.tsx) already walks:
 *   work_orders.estimate_id -> estimates.id -> invoices.estimate_id
 *   work_orders.id -> estimates.work_order_id -> invoices.estimate_id
 *   work_orders.opp_id -> estimates.opp_id -> invoices.estimate_id
 * A work order can be reached by more than one branch; the query
 * de-duplicates via UNION (not UNION ALL) and returns each id at most once.
 * See docs/FINANCE-OS-FIX-PLAN.md item 3 and docs/spec/UNBILLED.md (this
 * resolves the "Needs Tyler" cross-database-join gap noted there — the
 * join no longer crosses databases since migrations/0057_finance_merge.sql).
 */
export async function listBilledWorkOrderIds(
  db: D1Database, companyId: string,
): Promise<Set<string>> {
  const { results } = await db.prepare(`
    SELECT wo.id AS id FROM work_orders wo
    JOIN estimates es ON es.id = wo.estimate_id AND es.company_id = wo.company_id
    JOIN invoices inv ON inv.estimate_id = es.id AND inv.company_id = wo.company_id
    WHERE wo.company_id = ?
    UNION
    SELECT wo.id AS id FROM work_orders wo
    JOIN estimates es ON es.work_order_id = wo.id AND es.company_id = wo.company_id
    JOIN invoices inv ON inv.estimate_id = es.id AND inv.company_id = wo.company_id
    WHERE wo.company_id = ?
    UNION
    SELECT wo.id AS id FROM work_orders wo
    JOIN estimates es ON es.opp_id = wo.opp_id AND es.company_id = wo.company_id AND wo.opp_id IS NOT NULL
    JOIN invoices inv ON inv.estimate_id = es.id AND inv.company_id = wo.company_id
    WHERE wo.company_id = ?
  `).bind(companyId, companyId, companyId).all<{ id: string }>();
  return new Set(results.map((r) => r.id));
}

/** One row per crew whose missing `division` is currently blocking time
 * entries from posting — see getCrewsMissingDivisionWithUnpostedTime below. */
export interface UnpostableCrewDivisionGap {
  crew_id: string;
  crew_name: string;
  unposted_count: number;
}

/**
 * Surfaces docs/spec/OBSERVABILITY.md point 2: `postWorkOrderTimeEntry`
 * (src/index.tsx) silently no-ops at clock-out when the closed time entry's
 * work order points to a crew with no `division` set (crews.division,
 * migrations/0017_schedule_enhancements.sql) — that crew's time then never
 * posts to job_cost_ledger, forever, with nothing before this pointing a
 * human at the gap. This counts, per active crew with `division IS NULL`,
 * how many closed-but-unposted time entries are stuck behind it, so
 * Setup & Config can show "N time entries this week couldn't post — no
 * division set on crew X" instead of that being purely a log line.
 *
 * Scope is deliberately "ever unposted", not just "this week" — a gap left
 * unfixed for a month should still show the full backlog, not just the
 * newest slice of it. "Unposted" here means clock_out IS NOT NULL (the
 * entry is closed, so postWorkOrderTimeEntry has already had its one shot
 * at it) AND posted_at IS NULL (see POSTING.md's write-once posted_at
 * guard) — an entry still clocked in isn't "stuck", it just hasn't been
 * attempted yet. Only counts entries with a work_order_id pointing at a
 * real work order with a real crew_id assigned — general/non-job time and
 * work orders with no crew assigned are out of scope for this specific gap
 * (they no-op in postWorkOrderTimeEntry for a different, expected reason).
 */
export async function getCrewsMissingDivisionWithUnpostedTime(
  db: D1Database, companyId: string,
): Promise<UnpostableCrewDivisionGap[]> {
  const { results } = await db.prepare(`
    SELECT c.id AS crew_id, c.name AS crew_name, COUNT(te.id) AS unposted_count
    FROM crews c
    JOIN work_orders wo ON wo.crew_id = c.id AND wo.company_id = c.company_id
    JOIN time_entries te ON te.work_order_id = wo.id AND te.company_id = c.company_id
      AND te.clock_out IS NOT NULL AND te.posted_at IS NULL
    WHERE c.company_id = ? AND c.active = 1 AND c.division IS NULL
    GROUP BY c.id, c.name
    ORDER BY unposted_count DESC, c.name
  `).bind(companyId).all<UnpostableCrewDivisionGap>();
  return results;
}

/**
 * The rep an automated (cron-generated) action_item gets assigned to when
 * nothing more specific applies — every action_item requires a non-null
 * owner_id (docs/spec/ACTIONS.md, CLAUDE.md hard rule), and a cron job has
 * no logged-in user to attribute it to. Same role preference order already
 * used for impersonation's "find a rep to act as" (src/index.tsx's
 * POST /api/admin/impersonate): admin before office_manager, active only.
 * Returns null if the tenant genuinely has no active admin/office_manager
 * rep — callers must decide how to handle that (currently: skip creating
 * the item rather than write a bad owner_id).
 */
export async function getDefaultActionOwner(
  db: D1Database, companyId: string,
): Promise<string | null> {
  const row = await db.prepare(
    `SELECT id FROM reps WHERE company_id = ? AND role IN ('admin','office_manager') AND active = 1 ORDER BY role ASC LIMIT 1`,
  ).bind(companyId).first<{ id: string }>();
  return row?.id ?? null;
}

/**
 * Writes the Finance-side columns on an existing work order — called from
 * the CRM's own work-order create/update handlers (src/index.tsx), same
 * request, same database. Replaces the old cross-database
 * syncWorkOrderToFinance (src/bridge/finance-sync.ts, deleted in this merge).
 */
export async function updateWorkOrderFinanceColumns(
  db: D1Database, companyId: string, workOrderId: string,
  estimateCents: number | null, completedAt: string | null,
): Promise<void> {
  await db.prepare(
    `UPDATE work_orders SET estimate_cents = ?, finance_completed_at = ? WHERE id = ? AND company_id = ?`,
  ).bind(estimateCents, completedAt, workOrderId, companyId).run();
}

// ---- time_entries (Finance-relevant columns only — see FinanceTimeEntry) ----
// time_entry is gone (folded into time_entries' own resolved_rate/
// resolved_rate_confidence/applied_overhead_cents/posted_at columns,
// migrations/0057_finance_merge.sql). hours_hundredths is computed from
// duration_min at read time, never stored separately.

export async function getTimeEntry(
  db: D1Database, companyId: string, id: string,
): Promise<FinanceTimeEntry | null> {
  return db.prepare(`
    SELECT id, company_id, rep_id AS employee_id, work_order_id,
      substr(clock_in, 1, 10) AS work_date,
      CAST(ROUND(COALESCE(duration_min, 0) * 100.0 / 60) AS INTEGER) AS hours_hundredths,
      resolved_rate, resolved_rate_confidence, applied_overhead_cents, posted_at
    FROM time_entries WHERE company_id = ? AND id = ?
  `).bind(companyId, id).first<FinanceTimeEntry>();
}

/**
 * Writes resolved_rate/applied_overhead/posted_at exactly once (POSTING.md).
 * The WHERE posted_at IS NULL guard makes re-posting a no-op (0 rows affected)
 * rather than silently overwriting an already-posted entry.
 */
export async function postTimeEntry(
  db: D1Database, companyId: string, timeEntryId: string,
  resolvedRate: number, confidence: RateConfidence, appliedOverheadCents: number,
): Promise<boolean> {
  const result = await db.prepare(`
    UPDATE time_entries
    SET resolved_rate = ?, resolved_rate_confidence = ?, applied_overhead_cents = ?,
        posted_at = datetime('now')
    WHERE company_id = ? AND id = ? AND posted_at IS NULL
  `).bind(resolvedRate, confidence, appliedOverheadCents, companyId, timeEntryId).run();
  return (result.meta.changes ?? 0) > 0;
}

// ---- job_cost_ledger ----

/** The two-line post (POSTING.md): one labor line, one overhead line,
 * atomic. Neither line ever sets cost_category/progress_eligible/
 * change_order_id/source_receipt_id (migration 0085) — those are
 * direct_cost-only columns; labor/overhead rows get the column DEFAULTs
 * (cost_category NULL, progress_eligible 1, change_order_id/
 * source_receipt_id NULL) by simply not naming them in the INSERT, same
 * as this function did before migration 0085 added them. */
export async function postJobCostLedgerLines(
  db: D1Database,
  laborLine: Pick<JobCostLedger, "company_id" | "time_entry_id" | "job_id" | "amount_cents" | "division">,
  overheadLine: Pick<JobCostLedger, "company_id" | "time_entry_id" | "job_id" | "amount_cents" | "division">,
): Promise<void> {
  const labor = db.prepare(`
    INSERT INTO job_cost_ledger (company_id, time_entry_id, job_id, line_type, amount_cents, division)
    VALUES (?,?,?, 'labor', ?, ?)
  `).bind(laborLine.company_id, laborLine.time_entry_id, laborLine.job_id,
          laborLine.amount_cents, laborLine.division);

  const overhead = db.prepare(`
    INSERT INTO job_cost_ledger (company_id, time_entry_id, job_id, line_type, amount_cents, division)
    VALUES (?,?,?, 'overhead', ?, ?)
  `).bind(overheadLine.company_id, overheadLine.time_entry_id, overheadLine.job_id,
          overheadLine.amount_cents, overheadLine.division);

  await db.batch([labor, overhead]);
}

export async function getJobCostLedgerForJob(
  db: D1Database, companyId: string, jobId: string,
): Promise<JobCostLedger[]> {
  const { results } = await db.prepare(
    `SELECT * FROM job_cost_ledger WHERE company_id = ? AND job_id = ?`,
  ).bind(companyId, jobId).all<JobCostLedger>();
  return results;
}

/** The job_cost_ledger lines posted for one specific time_entry — always
 * exactly two once posted (labor + overhead, POSTING.md). Used to compute a
 * reversal's negated amounts without recomputing a rate. */
export async function getJobCostLedgerLinesForTimeEntry(
  db: D1Database, companyId: string, timeEntryId: string,
): Promise<JobCostLedger[]> {
  const { results } = await db.prepare(
    `SELECT * FROM job_cost_ledger WHERE company_id = ? AND time_entry_id = ?`,
  ).bind(companyId, timeEntryId).all<JobCostLedger>();
  return results;
}

// ---- time_entry_adjustments (Finance OS fix plan item 5) ----
//
// Posted time_entries rows and their job_cost_ledger lines are never
// UPDATEd or DELETEd directly (POSTING.md's immutability rule; the same
// insert-new-row-never-update precedent as CLAUDE.md hard rule 2's rate
// rows). A correction instead posts a brand-new reversal time_entries row
// whose job_cost_ledger lines are the exact negation of what's already
// posted for the original entry -- not a recomputed rate -- so Job Costing's
// net total is correct without the original ever being touched.

/**
 * Inserts the reversal time_entries row (itself posted immediately, so it
 * can't be edited/deleted directly either) plus its negated job_cost_ledger
 * lines, one negated line per line already posted for `originalEntryId`.
 * Returns the new reversal entry's id.
 */
export async function insertReversalTimeEntry(
  db: D1Database, companyId: string,
  original: FinanceTimeEntry,
  originalLines: JobCostLedger[],
  reversalId: string,
): Promise<void> {
  const now = new Date().toISOString();
  const negatedOverhead = original.applied_overhead_cents != null ? -original.applied_overhead_cents : null;

  await db.batch([
    db.prepare(`
      INSERT INTO time_entries
        (id, rep_id, company_id, clock_in, clock_out, duration_min, job_type, notes,
         approved, work_order_id, resolved_rate, resolved_rate_confidence,
         applied_overhead_cents, posted_at)
      VALUES (?,?,?,?,NULL,NULL,?,?, 1, ?, ?, ?, ?, datetime('now'))
    `).bind(
      reversalId, original.employee_id, companyId, now,
      'Adjustment: Reversal', `Reversal of time entry ${original.id}`,
      original.work_order_id, original.resolved_rate, original.resolved_rate_confidence,
      negatedOverhead,
    ),
    ...originalLines.map(line => db.prepare(`
      INSERT INTO job_cost_ledger (company_id, time_entry_id, job_id, line_type, amount_cents, division)
      VALUES (?,?,?,?,?,?)
    `).bind(companyId, reversalId, line.job_id, line.line_type, -line.amount_cents, line.division)),
  ]);
}

/** The audit-trail row linking an original posted entry to its reversal
 * (and, for a correction rather than a pure "logged in error" reversal, the
 * replacement entry carrying the corrected values). */
export async function insertTimeEntryAdjustment(
  db: D1Database, row: Omit<TimeEntryAdjustment, "created_at">,
): Promise<void> {
  await db.prepare(`
    INSERT INTO time_entry_adjustments
      (id, company_id, original_entry_id, reversal_entry_id, replacement_entry_id, reason, created_by)
    VALUES (?,?,?,?,?,?,?)
  `).bind(
    row.id, row.company_id, row.original_entry_id, row.reversal_entry_id,
    row.replacement_entry_id, row.reason, row.created_by,
  ).run();
}

export async function getTimeEntryAdjustmentsForEntry(
  db: D1Database, companyId: string, originalEntryId: string,
): Promise<TimeEntryAdjustment[]> {
  const { results } = await db.prepare(
    `SELECT * FROM time_entry_adjustments WHERE company_id = ? AND original_entry_id = ? ORDER BY created_at`,
  ).bind(companyId, originalEntryId).all<TimeEntryAdjustment>();
  return results;
}

// ---- overhead_pool / overhead_allocation ----

/** Every overhead_pool row for a company — the "driver map" (which pool uses
 * which allocation driver, per division). */
export async function listOverheadPools(db: D1Database, companyId: string): Promise<OverheadPool[]> {
  const { results } = await db.prepare(
    `SELECT * FROM overhead_pool WHERE company_id = ? ORDER BY division, pool_type`,
  ).bind(companyId).all<OverheadPool>();
  return results;
}

export async function insertOverheadPool(
  db: D1Database, row: Omit<OverheadPool, "id" | "created_at">,
): Promise<void> {
  await db.prepare(`
    INSERT INTO overhead_pool (company_id, division, pool_type, annual_cost_cents, driver, as_of)
    VALUES (?,?,?,?,?,?)
  `).bind(row.company_id, row.division, row.pool_type, row.annual_cost_cents,
          row.driver, row.as_of).run();
}

/**
 * Write one division's allocation for a date, replacing any prior run.
 *
 * Upsert rather than insert because the allocation run produces a full set per
 * as_of, and re-running a date must correct it rather than add a second set —
 * gather-inputs sums across the rows for a date, so duplicates double the
 * overhead feeding the rollup. The constraint is migration 0077.
 */
export async function upsertOverheadAllocation(
  db: D1Database, row: Omit<OverheadAllocation, "id" | "created_at">,
): Promise<void> {
  await db.prepare(`
    INSERT INTO overhead_allocation
      (company_id, division, as_of, sellable_hours, allocated_overhead_cents,
       weighted_labor_rate_cents, overhead_rate, absorbed_cost_cents, target_margin,
       required_bill_rate_cents)
    VALUES (?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(company_id, division, as_of) DO UPDATE SET
      sellable_hours = excluded.sellable_hours,
      allocated_overhead_cents = excluded.allocated_overhead_cents,
      weighted_labor_rate_cents = excluded.weighted_labor_rate_cents,
      overhead_rate = excluded.overhead_rate,
      absorbed_cost_cents = excluded.absorbed_cost_cents,
      target_margin = excluded.target_margin,
      required_bill_rate_cents = excluded.required_bill_rate_cents
  `).bind(
    row.company_id, row.division, row.as_of, row.sellable_hours,
    row.allocated_overhead_cents, row.weighted_labor_rate_cents, row.overhead_rate,
    row.absorbed_cost_cents, row.target_margin, row.required_bill_rate_cents,
  ).run();
}

export async function insertOverheadAllocation(
  db: D1Database, row: Omit<OverheadAllocation, "id" | "created_at">,
): Promise<void> {
  await db.prepare(`
    INSERT INTO overhead_allocation
      (company_id, division, as_of, sellable_hours, allocated_overhead_cents,
       weighted_labor_rate_cents, overhead_rate, absorbed_cost_cents, target_margin,
       required_bill_rate_cents)
    VALUES (?,?,?,?,?,?,?,?,?,?)
  `).bind(
    row.company_id, row.division, row.as_of, row.sellable_hours,
    row.allocated_overhead_cents, row.weighted_labor_rate_cents, row.overhead_rate,
    row.absorbed_cost_cents, row.target_margin, row.required_bill_rate_cents,
  ).run();
}

export async function getOverheadAllocationAsOf(
  db: D1Database, companyId: string, asOf: string,
): Promise<OverheadAllocation[]> {
  const { results } = await db.prepare(
    `SELECT * FROM overhead_allocation WHERE company_id = ? AND as_of = ?`,
  ).bind(companyId, asOf).all<OverheadAllocation>();
  return results;
}

/** Most recent allocation for a division as of a given date (periodic, not
 * effective-dated the way rate profiles are — allocations get recomputed on
 * a cadence, not superseded row-by-row). */
export async function getLatestOverheadAllocationForDivision(
  db: D1Database, companyId: string, division: string, asOfDate: string,
): Promise<OverheadAllocation | null> {
  return db.prepare(`
    SELECT * FROM overhead_allocation
    WHERE company_id = ? AND division = ? AND as_of <= ?
    ORDER BY as_of DESC LIMIT 1
  `).bind(companyId, division, asOfDate).first<OverheadAllocation>();
}

// ---- recovery_snapshot ----

/** Nightly rollup only (W3-rollup); replaces same-day snapshot if re-run. */
export async function upsertRecoverySnapshot(
  db: D1Database, row: Omit<RecoverySnapshot, "id" | "created_at">,
): Promise<void> {
  await db.prepare(`
    INSERT INTO recovery_snapshot
      (company_id, as_of, restated_target_cents, recovered_to_date_cents,
       hours_per_week_hundredths, blended_overhead_rate, weekly_recovery_cents,
       pct_recovered_millionths, projected_black_friday, confidence_days)
    VALUES (?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(company_id, as_of) DO UPDATE SET
      restated_target_cents = excluded.restated_target_cents,
      recovered_to_date_cents = excluded.recovered_to_date_cents,
      hours_per_week_hundredths = excluded.hours_per_week_hundredths,
      blended_overhead_rate = excluded.blended_overhead_rate,
      weekly_recovery_cents = excluded.weekly_recovery_cents,
      pct_recovered_millionths = excluded.pct_recovered_millionths,
      projected_black_friday = excluded.projected_black_friday,
      confidence_days = excluded.confidence_days
  `).bind(
    row.company_id, row.as_of, row.restated_target_cents, row.recovered_to_date_cents,
    row.hours_per_week_hundredths, row.blended_overhead_rate, row.weekly_recovery_cents,
    row.pct_recovered_millionths, row.projected_black_friday, row.confidence_days,
  ).run();
}

export async function getLatestRecoverySnapshot(
  db: D1Database, companyId: string,
): Promise<RecoverySnapshot | null> {
  return db.prepare(
    `SELECT * FROM recovery_snapshot WHERE company_id = ? ORDER BY as_of DESC LIMIT 1`,
  ).bind(companyId).first<RecoverySnapshot>();
}

// ---- action_item ----

export async function insertActionItem(
  db: D1Database, row: Omit<ActionItem, "created_at" | "resolved_at" | "status">,
): Promise<void> {
  await db.prepare(`
    INSERT INTO action_item
      (id, company_id, verb, owner_id, sla_due, amount_cents, confidence,
       stale_components, status, source_type, source_id)
    VALUES (?,?,?,?,?,?,?,?, 'open', ?,?)
  `).bind(
    row.id, row.company_id, row.verb, row.owner_id, row.sla_due, row.amount_cents,
    row.confidence, row.stale_components, row.source_type, row.source_id,
  ).run();
}

export async function getOpenActionItems(
  db: D1Database, companyId: string, verb?: ActionVerb,
): Promise<ActionItem[]> {
  const sql = verb
    ? `SELECT * FROM action_item WHERE company_id = ? AND status = 'open' AND verb = ? ORDER BY sla_due ASC`
    : `SELECT * FROM action_item WHERE company_id = ? AND status = 'open' ORDER BY sla_due ASC`;
  const stmt = verb ? db.prepare(sql).bind(companyId, verb) : db.prepare(sql).bind(companyId);
  const { results } = await stmt.all<ActionItem>();
  return results;
}

/**
 * Ids of open action_item rows for a given source_type, keyed by
 * source_id — used by producers (like the unbilled-work sweep) that run
 * repeatedly against the same source and must not create a second open
 * item for something that already has one (docs/FINANCE-OS-FIX-PLAN.md
 * item 3's "no duplicate/stale item" requirement).
 */
export async function getOpenActionItemSourceIds(
  db: D1Database, companyId: string, sourceType: NonNullable<ActionItem["source_type"]>,
): Promise<Set<string>> {
  const { results } = await db.prepare(
    `SELECT source_id FROM action_item WHERE company_id = ? AND status = 'open' AND source_type = ? AND source_id IS NOT NULL`,
  ).bind(companyId, sourceType).all<{ source_id: string }>();
  return new Set(results.map((r) => r.source_id));
}

/**
 * Auto-resolves any open action_item for a given source once its
 * underlying source is no longer actionable (e.g. a 'collect' item for a
 * work order that has since been invoiced, or one whose source work order
 * was deleted — see docs/FINANCE-OS-FIX-PLAN.md items 3 and 4). Distinct
 * from resolveActionItem/dismissActionItem (which act on a known
 * action_item id): this looks the row up by its source instead, since
 * callers here only know the source, not which action_item (if any) it
 * produced. A no-op if no open item exists for that source.
 */
export async function resolveActionItemsBySource(
  db: D1Database, companyId: string, sourceType: NonNullable<ActionItem["source_type"]>, sourceId: string,
): Promise<void> {
  await db.prepare(`
    UPDATE action_item SET status = 'resolved', resolved_at = datetime('now')
    WHERE company_id = ? AND status = 'open' AND source_type = ? AND source_id = ?
  `).bind(companyId, sourceType, sourceId).run();
}

export async function resolveActionItem(
  db: D1Database, companyId: string, id: string,
): Promise<void> {
  await db.prepare(`
    UPDATE action_item SET status = 'resolved', resolved_at = datetime('now')
    WHERE company_id = ? AND id = ?
  `).bind(companyId, id).run();
}

/** Counterpart to resolveActionItem — closes an item as "not actionable"
 * rather than "done" (e.g. stale test data, or a finding the reviewer
 * judged doesn't need a change). Schema already allows this status
 * (migrations/finance/0003_action.sql's CHECK); this just exposes it. */
export async function dismissActionItem(
  db: D1Database, companyId: string, id: string,
): Promise<void> {
  await db.prepare(`
    UPDATE action_item SET status = 'dismissed', resolved_at = datetime('now')
    WHERE company_id = ? AND id = ?
  `).bind(companyId, id).run();
}

// ---- classification_finding ----

export async function insertClassificationFinding(
  db: D1Database, row: Omit<ClassificationFinding, "created_at">,
): Promise<void> {
  await db.prepare(`
    INSERT INTO classification_finding
      (id, company_id, subject_type, subject_id, stage_reached, confidence,
       materiality_cents, proposed_change, action_item_id)
    VALUES (?,?,?,?,?,?,?,?,?)
  `).bind(
    row.id, row.company_id, row.subject_type, row.subject_id, row.stage_reached,
    row.confidence, row.materiality_cents, row.proposed_change, row.action_item_id,
  ).run();
}

/** Newest first, for the Reconciliation page. */
export async function listClassificationFindings(
  db: D1Database, companyId: string,
): Promise<ClassificationFinding[]> {
  const { results } = await db.prepare(
    `SELECT * FROM classification_finding WHERE company_id = ? ORDER BY created_at DESC`,
  ).bind(companyId).all<ClassificationFinding>();
  return results;
}

// ---- receipt ----

export async function getReceiptByHash(
  db: D1Database, companyId: string, contentHash: string,
): Promise<Receipt | null> {
  return db.prepare(`SELECT * FROM receipt WHERE company_id = ? AND content_hash = ?`)
    .bind(companyId, contentHash).first<Receipt>();
}

/** status is intentionally NOT a caller-supplied field here — every new
 * receipt enters 'pending_review' via the column DEFAULT (migration 0084)
 * so there's exactly one place ("pending_review is the starting state")
 * instead of every insert call site having to remember to pass it. Use
 * setReceiptStatus() below for the explicit human approve/reject action.
 * cost_category/progress_eligible/posted_at (migration 0085) are likewise
 * NOT caller-supplied at insert time — a freshly-uploaded receipt has no
 * job/category decision made yet; those are set later by
 * setReceiptCostCategory() and postApprovedReceiptToLedger() respectively,
 * once a human has actually decided them. */
export async function insertReceipt(
  db: D1Database, row: Omit<Receipt, "created_at" | "status" | "cost_category" | "progress_eligible" | "posted_at">,
): Promise<void> {
  await db.prepare(`
    INSERT INTO receipt
      (id, company_id, job_id, r2_key, content_hash, vendor, amount_cents,
       receipt_date, field_confidence, action_item_id, receipt_number)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)
  `).bind(
    row.id, row.company_id, row.job_id, row.r2_key, row.content_hash, row.vendor,
    row.amount_cents, row.receipt_date, row.field_confidence, row.action_item_id,
    row.receipt_number,
  ).run();
}

/** Item 1's fuzzy dedupe signal (vendor+date+receipt_number+total),
 * distinct from getReceiptByHash's exact content-hash match. Matches on
 * vendor+date+amount alone (receipt_number NULL on either side, or a
 * mismatch) are still returned but are a weaker signal — the caller
 * (processReceiptUpload) treats them as "surface for review", never as
 * "block/replace", since two genuinely different small purchases from
 * the same vendor on the same day for the same rounded total are
 * possible and must not be silently dropped. */
export async function findLikelyDuplicateReceipts(
  db: D1Database, companyId: string, vendor: string | null, receiptDate: string | null,
  amountCents: number | null, receiptNumber: string | null,
): Promise<Receipt[]> {
  if (!vendor || !receiptDate || amountCents === null) return [];
  const { results } = await db.prepare(`
    SELECT * FROM receipt
    WHERE company_id = ? AND vendor = ? AND receipt_date = ? AND amount_cents = ?
  `).bind(companyId, vendor, receiptDate, amountCents).all<Receipt>();
  // Exact receipt_number match (when both sides have one) sorts first —
  // it's the strongest of the two signals.
  return results.sort((a, b) => {
    const aExact = receiptNumber && a.receipt_number === receiptNumber ? 0 : 1;
    const bExact = receiptNumber && b.receipt_number === receiptNumber ? 0 : 1;
    return aExact - bExact;
  });
}

/** Newest first, for the Documents page. */
export async function listReceiptsForTenant(
  db: D1Database, companyId: string,
): Promise<Receipt[]> {
  const { results } = await db.prepare(
    `SELECT * FROM receipt WHERE company_id = ? ORDER BY created_at DESC`,
  ).bind(companyId).all<Receipt>();
  return results;
}

/** The only way a receipt leaves 'pending_review' — an explicit human
 * action (see documents.tsx's approve/reject buttons), never automatic.
 * This does not touch job_cost_ledger; approving a receipt here still
 * does not post anything, per CLAUDE.md's "nothing from OCR/receipts
 * posts to the ledger without a separate, explicit posting action". */
export async function setReceiptStatus(
  db: D1Database, companyId: string, id: string, status: "approved" | "rejected",
): Promise<void> {
  await db.prepare(
    `UPDATE receipt SET status = ? WHERE company_id = ? AND id = ?`,
  ).bind(status, companyId, id).run();
}

// ---- upload_batch ----
// One row per file processed through /finance/onboarding. Durable record of
// "was this ever uploaded" for the confidence-gap report — everything else
// about a financial export (its action_items) is per-line, not per-file.

/** status is not caller-supplied — see insertReceipt's doc comment above;
 * same reasoning applies here (migration 0084 DEFAULT 'pending_review'). */
export async function insertUploadBatch(
  db: D1Database, row: Omit<UploadBatch, "created_at" | "status">,
): Promise<void> {
  await db.prepare(`
    INSERT INTO upload_batch
      (id, company_id, filename, domain, detected_source_id, needs_review, row_count)
    VALUES (?,?,?,?,?,?,?)
  `).bind(
    row.id, row.company_id, row.filename, row.domain, row.detected_source_id,
    row.needs_review, row.row_count,
  ).run();
}

/** Newest first, optionally filtered to one domain — the confidence-gap
 * report queries this per domain to answer "any ever, and clean?". */
export async function listUploadBatchesForTenant(
  db: D1Database, companyId: string, domain?: UploadDomain,
): Promise<UploadBatch[]> {
  const sql = domain
    ? `SELECT * FROM upload_batch WHERE company_id = ? AND domain = ? ORDER BY created_at DESC`
    : `SELECT * FROM upload_batch WHERE company_id = ? ORDER BY created_at DESC`;
  const stmt = domain ? db.prepare(sql).bind(companyId, domain) : db.prepare(sql).bind(companyId);
  const { results } = await stmt.all<UploadBatch>();
  return results;
}

// ---- finance_config_override ----
// Admin-editable overrides for config/finance/*.json. Company-specific beats
// global beats the static JSON default. See src/config/finance-config-runtime.ts.

/** Effective override for one config, company-specific first, then global,
 * else null (caller falls back to the static JSON default). */
export async function getConfigOverride(
  db: D1Database, companyId: string, configName: string,
): Promise<FinanceConfigOverride | null> {
  const companySpecific = await db.prepare(
    `SELECT * FROM finance_config_override WHERE company_id = ? AND config_name = ?`,
  ).bind(companyId, configName).first<FinanceConfigOverride>();
  if (companySpecific) return companySpecific;
  if (companyId === GLOBAL_CONFIG_SCOPE) return null;
  return db.prepare(
    `SELECT * FROM finance_config_override WHERE company_id = ? AND config_name = ?`,
  ).bind(GLOBAL_CONFIG_SCOPE, configName).first<FinanceConfigOverride>();
}

export async function upsertConfigOverride(
  db: D1Database, companyId: string, configName: string, configJson: string, updatedBy: string | null,
): Promise<void> {
  await db.prepare(`
    INSERT INTO finance_config_override (company_id, config_name, config_json, updated_by, updated_at)
    VALUES (?, ?, ?, ?, datetime('now'))
    ON CONFLICT(company_id, config_name) DO UPDATE SET
      config_json = excluded.config_json,
      updated_by = excluded.updated_by,
      updated_at = datetime('now')
  `).bind(companyId, configName, configJson, updatedBy).run();
}

export async function deleteConfigOverride(
  db: D1Database, companyId: string, configName: string,
): Promise<void> {
  await db.prepare(
    `DELETE FROM finance_config_override WHERE company_id = ? AND config_name = ?`,
  ).bind(companyId, configName).run();
}

/** All overrides visible to a company — its own plus global ones — for an
 * admin listing page. */
export async function listConfigOverrides(
  db: D1Database, companyId: string,
): Promise<FinanceConfigOverride[]> {
  const { results } = await db.prepare(
    `SELECT * FROM finance_config_override WHERE company_id = ? OR company_id = ? ORDER BY config_name, company_id`,
  ).bind(companyId, GLOBAL_CONFIG_SCOPE).all<FinanceConfigOverride>();
  return results;
}

// ── Item 4 Stage 2 (docs/spec/ITEM4-JOBCOST.md, migration 0085) ────────────
// change_orders, job_budget_versions, work_orders progress columns,
// job_cost_ledger direct-cost posting + adjustments, and the receipt ->
// ledger posting pipeline. See src/engines/job-progress.ts for the pure
// formula engine these repo functions feed.

// ---- change_orders ----

/** Every field a caller must supply to create a change order — id/status/
 * approval fields excluded (status defaults to 'draft' via the column
 * DEFAULT, same "one place owns the starting state" convention as
 * insertReceipt/insertUploadBatch above; approved_at/approved_by/
 * overhead_rate_snapshot are NULL until an explicit approveChangeOrder
 * call, never guessed at creation time). */
export async function insertChangeOrder(
  db: D1Database,
  row: Pick<ChangeOrder,
    "id" | "company_id" | "job_id" | "estimate_id" | "customer_id" |
    "revenue_adjustment_cents" | "direct_cost_adjustment_cents" |
    "labor_hours_adjustment_hundredths" | "effective_date" | "description" |
    "reason" | "created_by">,
): Promise<void> {
  await db.prepare(`
    INSERT INTO change_orders
      (id, company_id, job_id, estimate_id, customer_id,
       revenue_adjustment_cents, direct_cost_adjustment_cents,
       labor_hours_adjustment_hundredths, effective_date, description, reason, created_by)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
  `).bind(
    row.id, row.company_id, row.job_id, row.estimate_id, row.customer_id,
    row.revenue_adjustment_cents, row.direct_cost_adjustment_cents,
    row.labor_hours_adjustment_hundredths, row.effective_date, row.description,
    row.reason, row.created_by,
  ).run();
}

export async function getChangeOrder(
  db: D1Database, companyId: string, id: string,
): Promise<ChangeOrder | null> {
  return db.prepare(`SELECT * FROM change_orders WHERE company_id = ? AND id = ?`)
    .bind(companyId, id).first<ChangeOrder>();
}

/** Newest first, for a job's change-order history/needs_review-adjacent
 * exception views. */
export async function listChangeOrdersForJob(
  db: D1Database, companyId: string, jobId: string,
): Promise<ChangeOrder[]> {
  const { results } = await db.prepare(
    `SELECT * FROM change_orders WHERE company_id = ? AND job_id = ? ORDER BY created_at DESC`,
  ).bind(companyId, jobId).all<ChangeOrder>();
  return results;
}

/** Every change order awaiting a decision, across all jobs — the tenant's
 * change-order approval queue. */
export async function listPendingChangeOrders(
  db: D1Database, companyId: string,
): Promise<ChangeOrder[]> {
  const { results } = await db.prepare(
    `SELECT * FROM change_orders WHERE company_id = ? AND status = 'pending' ORDER BY created_at ASC`,
  ).bind(companyId, ).all<ChangeOrder>();
  return results;
}

/**
 * Only a 'draft' or 'pending' CO may be edited (ITEM4-JOBCOST.md — once
 * approved a CO's adjustment figures are frozen, same immutability
 * convention as job_budget_versions; corrections require a new CO or a
 * job_cost_ledger reversal, never a mutation of an approved one). Returns
 * false (no rows changed) if the CO doesn't exist, belongs to another
 * tenant, or is already approved/rejected/void — callers must treat that
 * as "edit refused", not silently succeed.
 */
export async function updateChangeOrder(
  db: D1Database, companyId: string, id: string,
  fields: Partial<Pick<ChangeOrder,
    "revenue_adjustment_cents" | "direct_cost_adjustment_cents" |
    "labor_hours_adjustment_hundredths" | "effective_date" | "description" | "reason">>,
): Promise<boolean> {
  const cols = Object.keys(fields);
  if (cols.length === 0) return true;
  const setClause = cols.map((c) => `${c} = ?`).join(", ");
  const values = cols.map((c) => (fields as Record<string, unknown>)[c]);
  const result = await db.prepare(`
    UPDATE change_orders SET ${setClause}, updated_at = datetime('now')
    WHERE company_id = ? AND id = ? AND status IN ('draft','pending')
  `).bind(...values, companyId, id).run();
  return (result.meta.changes ?? 0) > 0;
}

/** Moves a draft CO to 'pending' (submitted for approval) — a distinct step
 * from creation so a CO can be edited freely while still a draft. No-op
 * (returns false) if the CO isn't currently 'draft'. */
export async function submitChangeOrderForApproval(
  db: D1Database, companyId: string, id: string,
): Promise<boolean> {
  const result = await db.prepare(`
    UPDATE change_orders SET status = 'pending', updated_at = datetime('now')
    WHERE company_id = ? AND id = ? AND status = 'draft'
  `).bind(companyId, id).run();
  return (result.meta.changes ?? 0) > 0;
}

/**
 * Approves a pending change order, freezing overhead_rate_snapshot at the
 * division's CURRENT overhead rate (caller resolves this via
 * getLatestOverheadAllocationForDivision and passes it in — this function
 * itself has no idea what "current" means, same decoupling as the pure
 * engine) — ITEM4-JOBCOST.md §9 test 8: once written here, this snapshot
 * never changes again even if the division's rate changes later. Only a
 * 'pending' CO can be approved (draft must be submitted first); returns
 * false if the row doesn't exist, isn't pending, or belongs to another
 * tenant. Approving a CO here does NOT by itself create a new
 * job_budget_versions row — see createJobBudgetVersionFromChangeOrder,
 * called by the caller as a second, explicit step (so the two-write
 * sequence can be wrapped in one db.batch() by the route handler).
 */
export function approveChangeOrderStatement(
  db: D1Database, companyId: string, id: string,
  approvedBy: string, overheadRateSnapshot: number,
): D1PreparedStatement {
  return db.prepare(`
    UPDATE change_orders
    SET status = 'approved', approved_at = datetime('now'), approved_by = ?,
        overhead_rate_snapshot = ?, updated_at = datetime('now')
    WHERE company_id = ? AND id = ? AND status = 'pending'
  `).bind(approvedBy, overheadRateSnapshot, companyId, id);
}

export async function approveChangeOrder(
  db: D1Database, companyId: string, id: string,
  approvedBy: string, overheadRateSnapshot: number,
): Promise<boolean> {
  const result = await approveChangeOrderStatement(db, companyId, id, approvedBy, overheadRateSnapshot).run();
  return (result.meta.changes ?? 0) > 0;
}

/** Only a 'pending' CO can be rejected. Rejected COs are terminal — a
 * rejected CO is never later approved; a new CO must be created instead
 * (same "never mutate a terminal-status row's meaning" rule as approval). */
export async function rejectChangeOrder(
  db: D1Database, companyId: string, id: string, rejectedBy: string, reason: string,
): Promise<boolean> {
  const result = await db.prepare(`
    UPDATE change_orders
    SET status = 'rejected', approved_by = ?, reason = ?, updated_at = datetime('now')
    WHERE company_id = ? AND id = ? AND status = 'pending'
  `).bind(rejectedBy, reason, companyId, id).run();
  return (result.meta.changes ?? 0) > 0;
}

/** Voids a draft/pending CO that should never be acted on again (withdrawn
 * by the person who created it, superseded by a different CO, etc.) —
 * distinct from 'rejected' (a reviewer's explicit no) so the two audit
 * trails read differently. An already-approved CO can never be voided
 * (financial history is immutable once approved) — only draft/pending. */
export async function voidChangeOrder(
  db: D1Database, companyId: string, id: string, reason: string,
): Promise<boolean> {
  const result = await db.prepare(`
    UPDATE change_orders SET status = 'void', reason = ?, updated_at = datetime('now')
    WHERE company_id = ? AND id = ? AND status IN ('draft','pending')
  `).bind(reason, companyId, id).run();
  return (result.meta.changes ?? 0) > 0;
}

// ---- job_budget_versions (IMMUTABLE — see schema.ts's doc comment) ----

/** The latest (highest revision_seq) job_budget_versions row for a job —
 * the "current revised budget" every formula reads from. Null if the job
 * has no approved budget version at all (ITEM4-JOBCOST.md §9 test 4). */
export async function getLatestJobBudgetVersion(
  db: D1Database, companyId: string, jobId: string,
): Promise<JobBudgetVersion | null> {
  return db.prepare(`
    SELECT * FROM job_budget_versions
    WHERE company_id = ? AND job_id = ?
    ORDER BY revision_seq DESC LIMIT 1
  `).bind(companyId, jobId).first<JobBudgetVersion>();
}

/** Full revision history for a job, oldest first — the "approved budget
 * version history" view (PR D). */
export async function listJobBudgetVersionsForJob(
  db: D1Database, companyId: string, jobId: string,
): Promise<JobBudgetVersion[]> {
  const { results } = await db.prepare(
    `SELECT * FROM job_budget_versions WHERE company_id = ? AND job_id = ? ORDER BY revision_seq ASC`,
  ).bind(companyId, jobId).all<JobBudgetVersion>();
  return results;
}

/**
 * Inserts a brand-new immutable revision — either the original baseline
 * (revision_seq=0, source_type='estimate') or the next approved-CO
 * revision (revision_seq = prior max + 1, source_type='change_order').
 * NEVER an UPDATE to an existing row (schema.ts's JobBudgetVersion doc
 * comment: "Never updated in place"). Every money/hours figure on `row`
 * must already be the CUMULATIVE total (the caller computes this via
 * src/engines/job-progress.ts's computeRevisedBudgetFromChangeOrders
 * before calling this) — this function does no summation itself, it only
 * persists what it's given as one new row.
 */
export async function insertJobBudgetVersion(
  db: D1Database, row: Omit<JobBudgetVersion, "created_at">,
): Promise<void> {
  await db.prepare(`
    INSERT INTO job_budget_versions
      (id, company_id, job_id, source_type, source_id, revision_seq,
       contract_value_cents, labor_hours_budgeted_hundredths, labor_rate_used,
       materials_budget_cents, subcontractor_budget_cents, equipment_budget_cents,
       disposal_budget_cents, permits_budget_cents, other_direct_budget_cents,
       direct_cost_budget_cents, division, overhead_rate_used, budgeted_overhead_cents,
       target_margin_millionths, completion_method, service_units_planned,
       needs_review, approved_at, approved_by)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).bind(
    row.id, row.company_id, row.job_id, row.source_type, row.source_id, row.revision_seq,
    row.contract_value_cents, row.labor_hours_budgeted_hundredths, row.labor_rate_used,
    row.materials_budget_cents, row.subcontractor_budget_cents, row.equipment_budget_cents,
    row.disposal_budget_cents, row.permits_budget_cents, row.other_direct_budget_cents,
    row.direct_cost_budget_cents, row.division, row.overhead_rate_used, row.budgeted_overhead_cents,
    row.target_margin_millionths, row.completion_method, row.service_units_planned,
    row.needs_review, row.approved_at, row.approved_by,
  ).run();
}

/** All job_budget_versions rows flagged needs_review=1 for a tenant — the
 * §10 backfill's "needs manual review" queue surfaced in the UI (PR D). */
export async function listJobBudgetVersionsNeedingReview(
  db: D1Database, companyId: string,
): Promise<JobBudgetVersion[]> {
  const { results } = await db.prepare(
    `SELECT * FROM job_budget_versions WHERE company_id = ? AND needs_review = 1 ORDER BY job_id, revision_seq`,
  ).bind(companyId).all<JobBudgetVersion>();
  return results;
}

/**
 * Approves a pending change order AND creates the next job_budget_versions
 * revision from it in one atomic batch — either both happen or neither
 * does, since a CO that's "approved" but hasn't produced a new budget
 * revision (or vice versa) would leave formulas reading stale/inconsistent
 * data. `newRevision` must already carry the correct CUMULATIVE totals
 * (computed by the caller via computeRevisedBudgetFromChangeOrders) and
 * revision_seq (prior max + 1) — this function only writes what it's
 * given, it does not compute anything.
 */
export async function approveChangeOrderAndCreateBudgetVersion(
  db: D1Database, companyId: string, changeOrderId: string,
  approvedBy: string, overheadRateSnapshot: number,
  newRevision: Omit<JobBudgetVersion, "created_at">,
): Promise<boolean> {
  const approveStmt = approveChangeOrderStatement(db, companyId, changeOrderId, approvedBy, overheadRateSnapshot);
  // The INSERT is deliberately written as `INSERT ... SELECT ... WHERE changes() > 0`
  // rather than a plain `INSERT ... VALUES (...)`. db.batch() runs statements
  // sequentially inside one implicit transaction on a single connection, so
  // SQLite's changes() scalar function here reflects exactly how many rows the
  // immediately preceding statement (approveStmt) touched. If the CO wasn't
  // 'pending' (approveStmt's WHERE clause matched nothing, changes() = 0), the
  // SELECT's WHERE guard is false and NO row is inserted — closing the gap
  // where an unconditional INSERT would otherwise land even on a no-op UPDATE,
  // which would violate the "either both writes happen or neither does"
  // atomicity guarantee this function exists to provide.
  const insertStmt = db.prepare(`
    INSERT INTO job_budget_versions
      (id, company_id, job_id, source_type, source_id, revision_seq,
       contract_value_cents, labor_hours_budgeted_hundredths, labor_rate_used,
       materials_budget_cents, subcontractor_budget_cents, equipment_budget_cents,
       disposal_budget_cents, permits_budget_cents, other_direct_budget_cents,
       direct_cost_budget_cents, division, overhead_rate_used, budgeted_overhead_cents,
       target_margin_millionths, completion_method, service_units_planned,
       needs_review, approved_at, approved_by)
    SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?
    WHERE changes() > 0
  `).bind(
    newRevision.id, newRevision.company_id, newRevision.job_id, newRevision.source_type,
    newRevision.source_id, newRevision.revision_seq, newRevision.contract_value_cents,
    newRevision.labor_hours_budgeted_hundredths, newRevision.labor_rate_used,
    newRevision.materials_budget_cents, newRevision.subcontractor_budget_cents,
    newRevision.equipment_budget_cents, newRevision.disposal_budget_cents,
    newRevision.permits_budget_cents, newRevision.other_direct_budget_cents,
    newRevision.direct_cost_budget_cents, newRevision.division, newRevision.overhead_rate_used,
    newRevision.budgeted_overhead_cents, newRevision.target_margin_millionths,
    newRevision.completion_method, newRevision.service_units_planned,
    newRevision.needs_review, newRevision.approved_at, newRevision.approved_by,
  );

  const results = await db.batch([approveStmt, insertStmt]);
  const approveChanges = (results[0] as D1Result).meta.changes ?? 0;
  const insertChanges = (results[1] as D1Result).meta.changes ?? 0;
  return approveChanges > 0 && insertChanges > 0;
}

// ---- work_orders progress columns (migration 0085 §4.3) ----

export async function getWorkOrderProgress(
  db: D1Database, companyId: string, id: string,
): Promise<FinanceWorkOrderProgress | null> {
  return db.prepare(`
    SELECT id, company_id, crew_id, completion_pct_millionths,
      service_units_completed, financially_closed_at
    FROM work_orders WHERE company_id = ? AND id = ?
  `).bind(companyId, id).first<FinanceWorkOrderProgress>();
}

/** Manual completion-% override (completion_method='manual' only) — set
 * explicitly by a human, never computed. Passing null clears the override
 * back to "compute it" (NULL-means-compute convention). */
export async function setWorkOrderManualCompletion(
  db: D1Database, companyId: string, id: string, completionPctMillionths: number | null,
): Promise<boolean> {
  const result = await db.prepare(
    `UPDATE work_orders SET completion_pct_millionths = ? WHERE company_id = ? AND id = ?`,
  ).bind(completionPctMillionths, companyId, id).run();
  return (result.meta.changes ?? 0) > 0;
}

/** service_units_completed — updated continuously as service_units-method
 * work happens (each completed visit/unit increments this on the work
 * order; planned units live on the budget version instead, since they
 * don't change as work happens). */
export async function setWorkOrderServiceUnitsCompleted(
  db: D1Database, companyId: string, id: string, serviceUnitsCompleted: number | null,
): Promise<boolean> {
  const result = await db.prepare(
    `UPDATE work_orders SET service_units_completed = ? WHERE company_id = ? AND id = ?`,
  ).bind(serviceUnitsCompleted, companyId, id).run();
  return (result.meta.changes ?? 0) > 0;
}

/**
 * Sets financially_closed_at — forces earned completion to exactly 1.00
 * regardless of completion_method (src/engines/job-progress.ts's
 * computeEarnedCompletion, checked first before any method branch).
 * Passing null re-opens the job (e.g. a late vendor bill turns up after an
 * accidental early close) — this is a deliberate, human-triggered action
 * in both directions, never automatic.
 */
export async function setWorkOrderFinanciallyClosed(
  db: D1Database, companyId: string, id: string, financiallyClosedAt: string | null,
): Promise<boolean> {
  const result = await db.prepare(
    `UPDATE work_orders SET financially_closed_at = ? WHERE company_id = ? AND id = ?`,
  ).bind(financiallyClosedAt, companyId, id).run();
  return (result.meta.changes ?? 0) > 0;
}

// ---- job_cost_ledger: direct_cost posting + progress read helpers ----

/**
 * The single-line direct_cost post — parallel to postJobCostLedgerLines'
 * two-line labor+overhead post, but for exactly one non-labor cost line
 * (materials/subcontractor/equipment/disposal/permits/other). Always sets
 * time_entry_id NULL (a direct_cost line is never tied to a time entry) and
 * always requires a cost_category (enforced here in application code, since
 * the column CHECK only requires "NULL or one of six" — migration 0085's
 * comment on schema.ts's JobCostLedger.cost_category). Returns the new
 * job_cost_ledger row's id for the caller to link into
 * job_cost_ledger_adjustments/receipt.posted_at bookkeeping.
 */
export async function postDirectCostLedgerLine(
  db: D1Database,
  line: Pick<JobCostLedger,
    "company_id" | "job_id" | "cost_category" | "amount_cents" | "division" |
    "progress_eligible" | "change_order_id" | "source_receipt_id">,
): Promise<number> {
  if (line.cost_category === null) {
    throw new Error("postDirectCostLedgerLine: cost_category is required for a direct_cost line");
  }
  const result = await db.prepare(`
    INSERT INTO job_cost_ledger
      (company_id, time_entry_id, job_id, line_type, cost_category, amount_cents,
       division, progress_eligible, change_order_id, source_receipt_id)
    VALUES (?, NULL, ?, 'direct_cost', ?, ?, ?, ?, ?, ?)
  `).bind(
    line.company_id, line.job_id, line.cost_category, line.amount_cents,
    line.division, line.progress_eligible, line.change_order_id, line.source_receipt_id,
  ).run();
  return result.meta.last_row_id as number;
}

/** Same statement as postDirectCostLedgerLine, but returned unexecuted so
 * callers (postApprovedReceiptToLedger below) can batch it atomically with
 * the receipt's write-once posted_at update — either both happen or
 * neither does. */
export function postDirectCostLedgerLineStatement(
  db: D1Database,
  line: Pick<JobCostLedger,
    "company_id" | "job_id" | "cost_category" | "amount_cents" | "division" |
    "progress_eligible" | "change_order_id" | "source_receipt_id">,
): D1PreparedStatement {
  if (line.cost_category === null) {
    throw new Error("postDirectCostLedgerLineStatement: cost_category is required for a direct_cost line");
  }
  return db.prepare(`
    INSERT INTO job_cost_ledger
      (company_id, time_entry_id, job_id, line_type, cost_category, amount_cents,
       division, progress_eligible, change_order_id, source_receipt_id)
    VALUES (?, NULL, ?, 'direct_cost', ?, ?, ?, ?, ?, ?)
  `).bind(
    line.company_id, line.job_id, line.cost_category, line.amount_cents,
    line.division, line.progress_eligible, line.change_order_id, line.source_receipt_id,
  );
}

/** All posted job_cost_ledger lines for a job, shaped exactly as
 * src/engines/job-progress.ts's pure formulas need (LedgerLineForProgress)
 * — this is the one place the DB row shape gets narrowed down to the
 * engine's decoupled plain-input shape, so the engine itself never has to
 * know about job_cost_ledger's real column set. */
export async function getLedgerLinesForJobProgress(
  db: D1Database, companyId: string, jobId: string,
): Promise<LedgerLineForProgress[]> {
  const { results } = await db.prepare(`
    SELECT line_type, amount_cents, progress_eligible
    FROM job_cost_ledger WHERE company_id = ? AND job_id = ?
  `).bind(companyId, jobId).all<LedgerLineForProgress>();
  return results;
}

export async function getJobCostLedgerLine(
  db: D1Database, companyId: string, id: number,
): Promise<JobCostLedger | null> {
  return db.prepare(`SELECT * FROM job_cost_ledger WHERE company_id = ? AND id = ?`)
    .bind(companyId, id).first<JobCostLedger>();
}

// ---- job_cost_ledger_adjustments (generalizes time_entry_adjustments) ----

/**
 * Reverses any posted job_cost_ledger line (labor, overhead, or
 * direct_cost — generalizing insertReversalTimeEntry's labor/overhead-only
 * reversal to cover direct_cost lines too) by inserting a same-shape
 * negative-amount row, optionally followed by a replacement row carrying
 * the corrected amount, plus the audit-trail job_cost_ledger_adjustments
 * row linking all of them together. All writes happen in one db.batch() —
 * either the full reversal (and optional replacement) succeeds, or none of
 * it does; there is no path that leaves a reversal without its audit row
 * or vice versa. Posted lines are never UPDATEd or DELETEd directly — this
 * is the only way to correct one (schema.ts's JobCostLedgerAdjustment doc
 * comment).
 */
export async function reverseJobCostLedgerLine(
  db: D1Database,
  companyId: string,
  original: JobCostLedger,
  adjustmentId: string,
  reason: string,
  createdBy: string,
  replacementAmountCents?: number,
): Promise<{ reversal_line_id: number; replacement_line_id: number | null }> {
  const reversalStmt = db.prepare(`
    INSERT INTO job_cost_ledger
      (company_id, time_entry_id, job_id, line_type, cost_category, amount_cents,
       division, progress_eligible, change_order_id, source_receipt_id)
    VALUES (?,?,?,?,?,?,?,?,?,?)
  `).bind(
    companyId, original.time_entry_id, original.job_id, original.line_type,
    original.cost_category, -original.amount_cents, original.division,
    original.progress_eligible, original.change_order_id, original.source_receipt_id,
  );

  const statements: D1PreparedStatement[] = [reversalStmt];
  if (replacementAmountCents !== undefined) {
    statements.push(db.prepare(`
      INSERT INTO job_cost_ledger
        (company_id, time_entry_id, job_id, line_type, cost_category, amount_cents,
         division, progress_eligible, change_order_id, source_receipt_id)
      VALUES (?,?,?,?,?,?,?,?,?,?)
    `).bind(
      companyId, original.time_entry_id, original.job_id, original.line_type,
      original.cost_category, replacementAmountCents, original.division,
      original.progress_eligible, original.change_order_id, original.source_receipt_id,
    ));
  }

  const results = await db.batch(statements);
  const reversalLineId = (results[0] as D1Result).meta.last_row_id as number;
  const replacementLineId = results.length > 1 ? ((results[1] as D1Result).meta.last_row_id as number) : null;

  await db.prepare(`
    INSERT INTO job_cost_ledger_adjustments
      (id, company_id, original_line_id, reversal_line_id, replacement_line_id, reason, created_by)
    VALUES (?,?,?,?,?,?,?)
  `).bind(adjustmentId, companyId, original.id, reversalLineId, replacementLineId, reason, createdBy).run();

  return { reversal_line_id: reversalLineId, replacement_line_id: replacementLineId };
}

export async function getJobCostLedgerAdjustmentsForLine(
  db: D1Database, companyId: string, originalLineId: number,
): Promise<JobCostLedgerAdjustment[]> {
  const { results } = await db.prepare(
    `SELECT * FROM job_cost_ledger_adjustments WHERE company_id = ? AND original_line_id = ? ORDER BY created_at`,
  ).bind(companyId, originalLineId).all<JobCostLedgerAdjustment>();
  return results;
}

// ---- receipt: cost-category/progress-eligibility + write-once posting ----

/**
 * Sets a receipt's cost_category and progress_eligible — the human
 * approver's decision, made at posting time (migration 0085's doc comment:
 * "Set by the human approver... NOT guessed from vendor name/amount...
 * NULL until then"), never at initial upload. Refuses to touch a receipt
 * that's already posted (posted_at NOT NULL) — once a receipt has produced
 * its one job_cost_ledger line, its category is part of that line's
 * immutable record, not the receipt's own mutable field anymore; a
 * post-posting category correction must go through
 * reverseJobCostLedgerLine instead. Returns false if the receipt doesn't
 * exist, belongs to another tenant, or is already posted.
 */
export async function setReceiptCostCategory(
  db: D1Database, companyId: string, id: string,
  costCategory: DirectCostCategory, progressEligible: 0 | 1,
): Promise<boolean> {
  const result = await db.prepare(`
    UPDATE receipt SET cost_category = ?, progress_eligible = ?
    WHERE company_id = ? AND id = ? AND posted_at IS NULL
  `).bind(costCategory, progressEligible, companyId, id).run();
  return (result.meta.changes ?? 0) > 0;
}

/** Every approved-but-not-yet-posted receipt for a tenant with a job
 * assigned and a cost_category set — the "ready to post" queue. Receipts
 * missing a job_id or cost_category still show up in listReceiptsForTenant
 * generally, but are NOT ready to post (see the unassigned/manual-review
 * queue below). */
export async function listReceiptsReadyToPost(
  db: D1Database, companyId: string,
): Promise<Receipt[]> {
  const { results } = await db.prepare(`
    SELECT * FROM receipt
    WHERE company_id = ? AND status = 'approved' AND posted_at IS NULL
      AND job_id IS NOT NULL AND cost_category IS NOT NULL
    ORDER BY created_at ASC
  `).bind(companyId).all<Receipt>();
  return results;
}

/** Approved receipts that cannot yet be safely posted — no job assigned,
 * or no cost_category set — surfaced as an explicit "unassigned / needs
 * manual review" queue (PR C requirement) rather than silently sitting
 * unposted with no visible reason. */
export async function listReceiptsNeedingManualAssignment(
  db: D1Database, companyId: string,
): Promise<Receipt[]> {
  const { results } = await db.prepare(`
    SELECT * FROM receipt
    WHERE company_id = ? AND status = 'approved' AND posted_at IS NULL
      AND (job_id IS NULL OR cost_category IS NULL)
    ORDER BY created_at ASC
  `).bind(companyId).all<Receipt>();
  return results;
}

export async function getReceiptForPosting(
  db: D1Database, companyId: string, id: string,
): Promise<Receipt | null> {
  return db.prepare(`SELECT * FROM receipt WHERE company_id = ? AND id = ?`)
    .bind(companyId, id).first<Receipt>();
}

/**
 * Write-once guard (POSTING.md's "WHERE posted_at IS NULL" pattern,
 * mirrored exactly from postTimeEntry above): marks a receipt posted,
 * returning false (no rows changed) if it was already posted by a
 * concurrent request — the caller (postApprovedReceiptToLedger,
 * src/api/receipt-posting.ts) must treat false as "someone else already
 * posted this, return a safe conflict response", never retry the write.
 */
export function markReceiptPostedStatement(
  db: D1Database, companyId: string, id: string,
): D1PreparedStatement {
  return db.prepare(`
    UPDATE receipt SET posted_at = datetime('now')
    WHERE company_id = ? AND id = ? AND posted_at IS NULL
  `).bind(companyId, id);
}

export async function markReceiptPosted(
  db: D1Database, companyId: string, id: string,
): Promise<boolean> {
  const result = await markReceiptPostedStatement(db, companyId, id).run();
  return (result.meta.changes ?? 0) > 0;
}

/**
 * Duplicate/source-identity protection: is there already a job_cost_ledger
 * line sourced from this exact receipt? Since markReceiptPosted's
 * "posted_at IS NULL" guard is the primary write-once gate, this is a
 * belt-and-suspenders check for the (should-never-happen) case of a
 * receipt whose posted_at got set without a corresponding ledger line, or
 * a caller that skips the guarded write path entirely — the posting route
 * checks this BEFORE attempting to post (see PR C step "prevent duplicate
 * posting"), not just relying on the write-once column.
 */
export async function receiptHasPostedLedgerLine(
  db: D1Database, companyId: string, receiptId: string,
): Promise<boolean> {
  const row = await db.prepare(
    `SELECT id FROM job_cost_ledger WHERE company_id = ? AND source_receipt_id = ? LIMIT 1`,
  ).bind(companyId, receiptId).first<{ id: number }>();
  return row !== null;
}
