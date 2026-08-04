import type {
  ActionItem, ActionVerb, ClassificationFinding, EquipmentRateProfile,
  JobCostLedger, LaborRateProfile, OverheadAllocation, OverheadPool,
  RateConfidence, Receipt, RecoverySnapshot, TenantFinancePolicy, TimeEntry,
  WorkItem,
} from "./schema";

/**
 * D1-backed repository layer. See docs/spec/SCHEMA.md.
 *
 * HARD RULE (CLAUDE.md #2, W1-repos forbidden list): *_rate_profile rows are
 * immutable. The only UPDATE this file ever issues against labor_rate_profile
 * or equipment_rate_profile touches effective_to alone, to close out the row a
 * recalibration supersedes — never a rate/cost column. There is intentionally
 * no "updateLaborRateProfile" function of any kind.
 */

// ---- tenant_finance_policy ----

export async function getTenantFinancePolicy(
  db: D1Database, tenantId: string,
): Promise<TenantFinancePolicy | null> {
  return db.prepare(`SELECT * FROM tenant_finance_policy WHERE tenant_id = ?`)
    .bind(tenantId).first<TenantFinancePolicy>();
}

export async function upsertTenantFinancePolicy(
  db: D1Database, policy: TenantFinancePolicy,
): Promise<void> {
  await db.prepare(`
    INSERT INTO tenant_finance_policy
      (tenant_id, equipment_engine_active, materiality_threshold_cents,
       restated_target_cents, black_friday_date, updated_at)
    VALUES (?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(tenant_id) DO UPDATE SET
      equipment_engine_active = excluded.equipment_engine_active,
      materiality_threshold_cents = excluded.materiality_threshold_cents,
      restated_target_cents = excluded.restated_target_cents,
      black_friday_date = excluded.black_friday_date,
      updated_at = datetime('now')
  `).bind(
    policy.tenant_id, policy.equipment_engine_active,
    policy.materiality_threshold_cents, policy.restated_target_cents,
    policy.black_friday_date,
  ).run();
}

// ---- labor_rate_profile (IMMUTABLE) ----

/** Resolves the profile in effect on `asOfDate` — BH-07: a date before a rate
 * change resolves to the OLDER profile, not the current one. */
export async function getLaborRateAsOf(
  db: D1Database, tenantId: string, scope: string, scopeId: string, asOfDate: string,
): Promise<LaborRateProfile | null> {
  return db.prepare(`
    SELECT * FROM labor_rate_profile
    WHERE tenant_id = ? AND scope = ? AND scope_id = ?
      AND effective_from <= ?
      AND (effective_to IS NULL OR effective_to > ?)
    ORDER BY effective_from DESC LIMIT 1
  `).bind(tenantId, scope, scopeId, asOfDate, asOfDate).first<LaborRateProfile>();
}

export async function insertLaborRateProfile(
  db: D1Database, row: Omit<LaborRateProfile, "id" | "created_at">,
): Promise<void> {
  await db.prepare(`
    INSERT INTO labor_rate_profile
      (tenant_id, scope, scope_id, wage_cents, paid_hours, pto_hours, shop_hours,
       idle_hours, tax_rate, comp_rate, benefits_monthly_cents,
       support_truck_annual_cents, support_tools_annual_cents,
       support_equipment_annual_cents, require_rate_approval, effective_from, effective_to)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).bind(
    row.tenant_id, row.scope, row.scope_id, row.wage_cents, row.paid_hours,
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
  tenantId: string, scope: string, scopeId: string,
  newRow: Omit<LaborRateProfile, "id" | "created_at" | "effective_to">,
): Promise<void> {
  const closePrior = db.prepare(`
    UPDATE labor_rate_profile SET effective_to = ?
    WHERE tenant_id = ? AND scope = ? AND scope_id = ? AND effective_to IS NULL
  `).bind(newRow.effective_from, tenantId, scope, scopeId);

  const insertNew = db.prepare(`
    INSERT INTO labor_rate_profile
      (tenant_id, scope, scope_id, wage_cents, paid_hours, pto_hours, shop_hours,
       idle_hours, tax_rate, comp_rate, benefits_monthly_cents,
       support_truck_annual_cents, support_tools_annual_cents,
       support_equipment_annual_cents, require_rate_approval, effective_from, effective_to)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL)
  `).bind(
    newRow.tenant_id, newRow.scope, newRow.scope_id, newRow.wage_cents,
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
  db: D1Database, tenantId: string, equipmentId: string, asOfDate: string,
): Promise<EquipmentRateProfile | null> {
  return db.prepare(`
    SELECT * FROM equipment_rate_profile
    WHERE tenant_id = ? AND equipment_id = ?
      AND effective_from <= ?
      AND (effective_to IS NULL OR effective_to > ?)
    ORDER BY effective_from DESC LIMIT 1
  `).bind(tenantId, equipmentId, asOfDate, asOfDate).first<EquipmentRateProfile>();
}

export async function insertEquipmentRateProfile(
  db: D1Database, row: Omit<EquipmentRateProfile, "id" | "created_at">,
): Promise<void> {
  await db.prepare(`
    INSERT INTO equipment_rate_profile
      (tenant_id, equipment_id, purchase_price_cents, salvage_cents, life_years,
       annual_machine_hours, finance_rate, insurance_annual_cents, storage_annual_cents,
       fuel_gal_per_hr, fuel_price_cents, repairs_annual_cents, wear_annual_cents,
       lube_pct_of_fuel, effective_from, effective_to)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).bind(
    row.tenant_id, row.equipment_id, row.purchase_price_cents, row.salvage_cents,
    row.life_years, row.annual_machine_hours, row.finance_rate,
    row.insurance_annual_cents, row.storage_annual_cents, row.fuel_gal_per_hr,
    row.fuel_price_cents, row.repairs_annual_cents, row.wear_annual_cents,
    row.lube_pct_of_fuel, row.effective_from, row.effective_to,
  ).run();
}

/** Same immutability contract as recalibrateLaborRate — see its docstring. */
export async function recalibrateEquipmentRate(
  db: D1Database, tenantId: string, equipmentId: string,
  newRow: Omit<EquipmentRateProfile, "id" | "created_at" | "effective_to">,
): Promise<void> {
  const closePrior = db.prepare(`
    UPDATE equipment_rate_profile SET effective_to = ?
    WHERE tenant_id = ? AND equipment_id = ? AND effective_to IS NULL
  `).bind(newRow.effective_from, tenantId, equipmentId);

  const insertNew = db.prepare(`
    INSERT INTO equipment_rate_profile
      (tenant_id, equipment_id, purchase_price_cents, salvage_cents, life_years,
       annual_machine_hours, finance_rate, insurance_annual_cents, storage_annual_cents,
       fuel_gal_per_hr, fuel_price_cents, repairs_annual_cents, wear_annual_cents,
       lube_pct_of_fuel, effective_from, effective_to)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL)
  `).bind(
    newRow.tenant_id, newRow.equipment_id, newRow.purchase_price_cents,
    newRow.salvage_cents, newRow.life_years, newRow.annual_machine_hours,
    newRow.finance_rate, newRow.insurance_annual_cents, newRow.storage_annual_cents,
    newRow.fuel_gal_per_hr, newRow.fuel_price_cents, newRow.repairs_annual_cents,
    newRow.wear_annual_cents, newRow.lube_pct_of_fuel, newRow.effective_from,
  );

  await db.batch([closePrior, insertNew]);
}

// ---- work_item ----

export async function insertWorkItem(
  db: D1Database, row: Omit<WorkItem, "created_at">,
): Promise<void> {
  await db.prepare(`
    INSERT INTO work_item (id, tenant_id, job_id, description, status, estimate_cents, completed_at)
    VALUES (?,?,?,?,?,?,?)
  `).bind(row.id, row.tenant_id, row.job_id, row.description, row.status,
          row.estimate_cents, row.completed_at).run();
}

export async function getWorkItem(db: D1Database, tenantId: string, id: string): Promise<WorkItem | null> {
  return db.prepare(`SELECT * FROM work_item WHERE tenant_id = ? AND id = ?`)
    .bind(tenantId, id).first<WorkItem>();
}

export async function listCompletedUnbilledWorkItems(
  db: D1Database, tenantId: string,
): Promise<WorkItem[]> {
  const { results } = await db.prepare(
    `SELECT * FROM work_item WHERE tenant_id = ? AND status = 'complete'`,
  ).bind(tenantId).all<WorkItem>();
  return results;
}

// ---- time_entry ----

export async function insertTimeEntry(
  db: D1Database, row: Omit<TimeEntry, "id" | "created_at" | "resolved_rate" |
    "resolved_rate_confidence" | "applied_overhead_cents" | "posted_at">,
): Promise<number> {
  const result = await db.prepare(`
    INSERT INTO time_entry
      (tenant_id, employee_id, crew_id, job_id, work_date, hours_hundredths, ot_hours_hundredths)
    VALUES (?,?,?,?,?,?,?)
  `).bind(row.tenant_id, row.employee_id, row.crew_id, row.job_id, row.work_date,
          row.hours_hundredths, row.ot_hours_hundredths).run();
  return result.meta.last_row_id as number;
}

/**
 * Writes resolved_rate/applied_overhead/posted_at exactly once (POSTING.md).
 * The WHERE posted_at IS NULL guard makes re-posting a no-op (0 rows affected)
 * rather than silently overwriting an already-posted entry.
 */
export async function postTimeEntry(
  db: D1Database, tenantId: string, timeEntryId: number,
  resolvedRate: number, confidence: RateConfidence, appliedOverheadCents: number,
): Promise<boolean> {
  const result = await db.prepare(`
    UPDATE time_entry
    SET resolved_rate = ?, resolved_rate_confidence = ?, applied_overhead_cents = ?,
        posted_at = datetime('now')
    WHERE tenant_id = ? AND id = ? AND posted_at IS NULL
  `).bind(resolvedRate, confidence, appliedOverheadCents, tenantId, timeEntryId).run();
  return (result.meta.changes ?? 0) > 0;
}

export async function getTimeEntry(
  db: D1Database, tenantId: string, id: number,
): Promise<TimeEntry | null> {
  return db.prepare(`SELECT * FROM time_entry WHERE tenant_id = ? AND id = ?`)
    .bind(tenantId, id).first<TimeEntry>();
}

// ---- job_cost_ledger ----

/** The two-line post (POSTING.md): one labor line, one overhead line, atomic. */
export async function postJobCostLedgerLines(
  db: D1Database,
  laborLine: Omit<JobCostLedger, "id" | "posted_at" | "line_type">,
  overheadLine: Omit<JobCostLedger, "id" | "posted_at" | "line_type">,
): Promise<void> {
  const labor = db.prepare(`
    INSERT INTO job_cost_ledger (tenant_id, time_entry_id, job_id, line_type, amount_cents, division)
    VALUES (?,?,?, 'labor', ?, ?)
  `).bind(laborLine.tenant_id, laborLine.time_entry_id, laborLine.job_id,
          laborLine.amount_cents, laborLine.division);

  const overhead = db.prepare(`
    INSERT INTO job_cost_ledger (tenant_id, time_entry_id, job_id, line_type, amount_cents, division)
    VALUES (?,?,?, 'overhead', ?, ?)
  `).bind(overheadLine.tenant_id, overheadLine.time_entry_id, overheadLine.job_id,
          overheadLine.amount_cents, overheadLine.division);

  await db.batch([labor, overhead]);
}

export async function getJobCostLedgerForJob(
  db: D1Database, tenantId: string, jobId: string,
): Promise<JobCostLedger[]> {
  const { results } = await db.prepare(
    `SELECT * FROM job_cost_ledger WHERE tenant_id = ? AND job_id = ?`,
  ).bind(tenantId, jobId).all<JobCostLedger>();
  return results;
}

// ---- overhead_pool / overhead_allocation ----

export async function insertOverheadPool(
  db: D1Database, row: Omit<OverheadPool, "id" | "created_at">,
): Promise<void> {
  await db.prepare(`
    INSERT INTO overhead_pool (tenant_id, division, pool_type, annual_cost_cents, driver, as_of)
    VALUES (?,?,?,?,?,?)
  `).bind(row.tenant_id, row.division, row.pool_type, row.annual_cost_cents,
          row.driver, row.as_of).run();
}

export async function insertOverheadAllocation(
  db: D1Database, row: Omit<OverheadAllocation, "id" | "created_at">,
): Promise<void> {
  await db.prepare(`
    INSERT INTO overhead_allocation
      (tenant_id, division, as_of, sellable_hours, allocated_overhead_cents,
       weighted_labor_rate_cents, overhead_rate, absorbed_cost_cents, target_margin,
       required_bill_rate_cents)
    VALUES (?,?,?,?,?,?,?,?,?,?)
  `).bind(
    row.tenant_id, row.division, row.as_of, row.sellable_hours,
    row.allocated_overhead_cents, row.weighted_labor_rate_cents, row.overhead_rate,
    row.absorbed_cost_cents, row.target_margin, row.required_bill_rate_cents,
  ).run();
}

export async function getOverheadAllocationAsOf(
  db: D1Database, tenantId: string, asOf: string,
): Promise<OverheadAllocation[]> {
  const { results } = await db.prepare(
    `SELECT * FROM overhead_allocation WHERE tenant_id = ? AND as_of = ?`,
  ).bind(tenantId, asOf).all<OverheadAllocation>();
  return results;
}

/** Most recent allocation for a division as of a given date (periodic, not
 * effective-dated the way rate profiles are — allocations get recomputed on
 * a cadence, not superseded row-by-row). */
export async function getLatestOverheadAllocationForDivision(
  db: D1Database, tenantId: string, division: string, asOfDate: string,
): Promise<OverheadAllocation | null> {
  return db.prepare(`
    SELECT * FROM overhead_allocation
    WHERE tenant_id = ? AND division = ? AND as_of <= ?
    ORDER BY as_of DESC LIMIT 1
  `).bind(tenantId, division, asOfDate).first<OverheadAllocation>();
}

// ---- recovery_snapshot ----

/** Nightly rollup only (W3-rollup); replaces same-day snapshot if re-run. */
export async function upsertRecoverySnapshot(
  db: D1Database, row: Omit<RecoverySnapshot, "id" | "created_at">,
): Promise<void> {
  await db.prepare(`
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
    row.tenant_id, row.as_of, row.restated_target_cents, row.recovered_to_date_cents,
    row.hours_per_week_hundredths, row.blended_overhead_rate, row.weekly_recovery_cents,
    row.pct_recovered_millionths, row.projected_black_friday, row.confidence_days,
  ).run();
}

export async function getLatestRecoverySnapshot(
  db: D1Database, tenantId: string,
): Promise<RecoverySnapshot | null> {
  return db.prepare(
    `SELECT * FROM recovery_snapshot WHERE tenant_id = ? ORDER BY as_of DESC LIMIT 1`,
  ).bind(tenantId).first<RecoverySnapshot>();
}

// ---- action_item ----

export async function insertActionItem(
  db: D1Database, row: Omit<ActionItem, "created_at" | "resolved_at" | "status">,
): Promise<void> {
  await db.prepare(`
    INSERT INTO action_item
      (id, tenant_id, verb, owner_id, sla_due, amount_cents, confidence,
       stale_components, status, source_type, source_id)
    VALUES (?,?,?,?,?,?,?,?, 'open', ?,?)
  `).bind(
    row.id, row.tenant_id, row.verb, row.owner_id, row.sla_due, row.amount_cents,
    row.confidence, row.stale_components, row.source_type, row.source_id,
  ).run();
}

export async function getOpenActionItems(
  db: D1Database, tenantId: string, verb?: ActionVerb,
): Promise<ActionItem[]> {
  const sql = verb
    ? `SELECT * FROM action_item WHERE tenant_id = ? AND status = 'open' AND verb = ? ORDER BY sla_due ASC`
    : `SELECT * FROM action_item WHERE tenant_id = ? AND status = 'open' ORDER BY sla_due ASC`;
  const stmt = verb ? db.prepare(sql).bind(tenantId, verb) : db.prepare(sql).bind(tenantId);
  const { results } = await stmt.all<ActionItem>();
  return results;
}

export async function resolveActionItem(
  db: D1Database, tenantId: string, id: string,
): Promise<void> {
  await db.prepare(`
    UPDATE action_item SET status = 'resolved', resolved_at = datetime('now')
    WHERE tenant_id = ? AND id = ?
  `).bind(tenantId, id).run();
}

// ---- classification_finding ----

export async function insertClassificationFinding(
  db: D1Database, row: Omit<ClassificationFinding, "created_at">,
): Promise<void> {
  await db.prepare(`
    INSERT INTO classification_finding
      (id, tenant_id, subject_type, subject_id, stage_reached, confidence,
       materiality_cents, proposed_change, action_item_id)
    VALUES (?,?,?,?,?,?,?,?,?)
  `).bind(
    row.id, row.tenant_id, row.subject_type, row.subject_id, row.stage_reached,
    row.confidence, row.materiality_cents, row.proposed_change, row.action_item_id,
  ).run();
}

// ---- receipt ----

export async function getReceiptByHash(
  db: D1Database, tenantId: string, contentHash: string,
): Promise<Receipt | null> {
  return db.prepare(`SELECT * FROM receipt WHERE tenant_id = ? AND content_hash = ?`)
    .bind(tenantId, contentHash).first<Receipt>();
}

export async function insertReceipt(
  db: D1Database, row: Omit<Receipt, "created_at">,
): Promise<void> {
  await db.prepare(`
    INSERT INTO receipt
      (id, tenant_id, job_id, r2_key, content_hash, vendor, amount_cents,
       receipt_date, field_confidence, action_item_id)
    VALUES (?,?,?,?,?,?,?,?,?,?)
  `).bind(
    row.id, row.tenant_id, row.job_id, row.r2_key, row.content_hash, row.vendor,
    row.amount_cents, row.receipt_date, row.field_confidence, row.action_item_id,
  ).run();
}
