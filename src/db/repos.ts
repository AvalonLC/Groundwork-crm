import type {
  ActionItem, ActionVerb, ClassificationFinding, EquipmentRateProfile,
  FinanceConfigOverride, FinanceTimeEntry, FinanceWorkOrder, JobCostLedger,
  LaborRateProfile, OverheadAllocation, OverheadPool,
  RateConfidence, Receipt, RecoverySnapshot, TenantFinancePolicy,
  UploadBatch, UploadDomain,
} from "./schema";

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

/** The two-line post (POSTING.md): one labor line, one overhead line, atomic. */
export async function postJobCostLedgerLines(
  db: D1Database,
  laborLine: Omit<JobCostLedger, "id" | "posted_at" | "line_type">,
  overheadLine: Omit<JobCostLedger, "id" | "posted_at" | "line_type">,
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

export async function resolveActionItem(
  db: D1Database, companyId: string, id: string,
): Promise<void> {
  await db.prepare(`
    UPDATE action_item SET status = 'resolved', resolved_at = datetime('now')
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

export async function insertReceipt(
  db: D1Database, row: Omit<Receipt, "created_at">,
): Promise<void> {
  await db.prepare(`
    INSERT INTO receipt
      (id, company_id, job_id, r2_key, content_hash, vendor, amount_cents,
       receipt_date, field_confidence, action_item_id)
    VALUES (?,?,?,?,?,?,?,?,?,?)
  `).bind(
    row.id, row.company_id, row.job_id, row.r2_key, row.content_hash, row.vendor,
    row.amount_cents, row.receipt_date, row.field_confidence, row.action_item_id,
  ).run();
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

// ---- upload_batch ----
// One row per file processed through /finance/onboarding. Durable record of
// "was this ever uploaded" for the confidence-gap report — everything else
// about a financial export (its action_items) is per-line, not per-file.

export async function insertUploadBatch(
  db: D1Database, row: Omit<UploadBatch, "created_at">,
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
