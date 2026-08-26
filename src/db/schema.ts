/**
 * TypeScript row shapes for Finance OS tables, now living in the same
 * database as the CRM's own tables (migrations/0057_finance_merge.sql
 * merged the former separate `groundwork` D1 instance in — see that file
 * and docs/spec/SCHEMA.md). Field names match SQL column names exactly
 * (D1 returns rows as-is), except FinanceWorkOrder/FinanceTimeEntry, which
 * are deliberately slim views over work_orders/time_entries (see below).
 *
 * Money is INTEGER cents. Rates are INTEGER ten-thousandths. D1/SQLite has no
 * native decimal type; these branded aliases exist so a `Cents` value can't be
 * silently assigned where a `TenThousandths` value was expected, or vice versa.
 */
export type Cents = number & { readonly __brand: "Cents" };
export type TenThousandths = number & { readonly __brand: "TenThousandths" };
export type Millionths = number & { readonly __brand: "Millionths" };
export type HoursHundredths = number & { readonly __brand: "HoursHundredths" };

export type Bool01 = 0 | 1;

// ---- tenant_finance_policy (now company_id-keyed) ----

export interface TenantFinancePolicy {
  company_id: string;
  equipment_engine_active: Bool01;
  materiality_threshold_cents: Cents;
  restated_target_cents: Cents;
  black_friday_date: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * The Finance-relevant slice of a CRM work_order, not a separate table.
 * work_item's old columns folded onto work_orders (estimate_cents,
 * finance_completed_at added; id/job_id were always the same value as
 * work_orders.id — never a join; description/status were always redundant
 * with work_orders.title/status). repos.ts computes `status` here from
 * work_orders.status ('completed' -> 'complete', anything else -> 'open')
 * and aliases finance_completed_at AS completed_at, so this type's shape
 * matches the old WorkItem exactly and existing consumers
 * (src/engines/unbilled.ts, src/ui/job-costing.tsx) didn't need to change.
 */
export interface FinanceWorkOrder {
  id: string;
  company_id: string;
  status: "open" | "complete";
  estimate_cents: Cents | null;
  completed_at: string | null;
}

/**
 * Migration 0085 §4.3. The job-progress-relevant slice of a work_order —
 * separate from FinanceWorkOrder (above) rather than added onto it, since
 * FinanceWorkOrder's shape is deliberately frozen to match the old
 * WorkItem for its existing consumers (unbilled.ts, job-costing.tsx).
 * crew_id is included because division resolution is crew_id ->
 * crews.division (ITEM4-JOBCOST.md §2), not a stored column on work_orders
 * itself.
 */
export interface FinanceWorkOrderProgress {
  id: string;
  company_id: string;
  crew_id: string | null;
  /** Manual override only (completion_method='manual'). NULL means
   * "compute it instead". */
  completion_pct_millionths: Millionths | null;
  /** Only meaningful when the active job_budget_versions row has
   * completion_method='service_units'. */
  service_units_completed: number | null;
  /** Distinct from status='completed'/finance_completed_at (those mark the
   * *work* done); this marks the *cost side* closed, which forces earned
   * completion % to 1.00 regardless of completion_method. */
  financially_closed_at: string | null;
}

export type RateConfidence = "high" | "medium" | "low";

/**
 * The Finance-relevant slice of a CRM time_entries row, not a separate
 * table. time_entry's old columns folded onto time_entries
 * (resolved_rate/resolved_rate_confidence/applied_overhead_cents/posted_at
 * added). NOT duplicated: hours_hundredths (computed from duration_min at
 * posting time — see src/api/posting.ts), work_date (derived from
 * clock_in), employee_id/work_order_id (already rep_id/work_order_id).
 * ot_hours_hundredths dropped entirely — it was never read anywhere in the
 * posting formula, and the CRM has no overtime concept to source it from.
 */
export interface FinanceTimeEntry {
  id: string; // time_entries.id (TEXT) — was INTEGER AUTOINCREMENT on the old, separate time_entry table
  company_id: string;
  employee_id: string;
  work_order_id: string;
  work_date: string;
  hours_hundredths: HoursHundredths;
  resolved_rate: TenThousandths | null;
  resolved_rate_confidence: RateConfidence | null;
  applied_overhead_cents: Cents | null;
  posted_at: string | null;
}

/**
 * Migration 0085 (Item 4 Stage 2, docs/spec/ITEM4-JOBCOST.md §4.4).
 * time_entry_id is now nullable — non-labor postings (materials, subs,
 * equipment, disposal, permits, other) have no time_entry, they post from
 * an approved receipt instead (see source_receipt_id, and
 * src/api/receipt-posting.ts). line_type gained 'direct_cost'; labor/
 * overhead keep meaning exactly what they meant before this migration.
 */
export interface JobCostLedger {
  id: number;
  company_id: string;
  time_entry_id: string | null;
  job_id: string; // references work_orders(id)
  line_type: "labor" | "overhead" | "direct_cost";
  /** NULL for labor/overhead rows; required in practice for direct_cost
   * rows (enforced in application code, not a NOT NULL column, since the
   * CHECK only requires "NULL or one of the six values" — see repos.ts's
   * postDirectCostLedgerLine). */
  cost_category: DirectCostCategory | null;
  amount_cents: Cents;
  division: string | null;
  /** Bool01. 0 = posted but excluded from earned-completion cost-to-cost
   * math (deposits, prepaid vendor amounts, purchased-but-not-yet-installed
   * materials). Defaults to 1 so labor/overhead rows are unaffected. */
  progress_eligible: Bool01;
  /** NULL for lines not tied to a specific approved change order. */
  change_order_id: string | null;
  /** NULL for labor/overhead lines; set for a direct_cost line posted from
   * an approved receipt. */
  source_receipt_id: string | null;
  posted_at: string;
}

/** The six non-labor direct-cost buckets a job_cost_ledger 'direct_cost'
 * line or an approved receipt can be categorized into. Mirrors the CHECK
 * constraints on job_cost_ledger.cost_category and receipt.cost_category
 * (migration 0085). */
export type DirectCostCategory =
  | "materials" | "subcontractor" | "equipment" | "disposal" | "permits" | "other";

/** Runtime companion to the DirectCostCategory type — for building a
 * <select> of the exact six values the CHECK constraint allows, without
 * a UI file re-typing the literal list (and risking drift from it). */
export const DIRECT_COST_CATEGORIES: DirectCostCategory[] =
  ["materials", "subcontractor", "equipment", "disposal", "permits", "other"];

/**
 * Migration 0085 §4.1. Only status='approved' rows ever feed a job-progress
 * formula — enforced in application code (every read helper filters
 * WHERE status='approved'), matching how this codebase already gates by
 * status everywhere else. overhead_rate_snapshot is frozen at approval so a
 * later division-rate change never retroactively reshapes an old CO's
 * contribution to revised budgeted overhead (ITEM4-JOBCOST.md §9 test 8).
 */
export interface ChangeOrder {
  id: string;
  company_id: string;
  job_id: string; // references work_orders(id)
  estimate_id: string | null; // references estimates(id)
  customer_id: string | null; // denormalized for reporting; not authoritative
  status: "draft" | "pending" | "approved" | "rejected" | "void";
  revenue_adjustment_cents: Cents; // signed
  direct_cost_adjustment_cents: Cents; // signed
  labor_hours_adjustment_hundredths: HoursHundredths; // signed
  overhead_rate_snapshot: TenThousandths | null; // NULL until approved
  approved_at: string | null;
  approved_by: string | null;
  effective_date: string | null;
  description: string;
  reason: string;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export type CompletionMethod = "cost_to_cost" | "service_units" | "manual" | "completed";

/**
 * Migration 0085 §4.2. One row per approved baseline (revision_seq=0) or
 * approved-change-order revision (1,2,3...). Never updated in place — same
 * immutability convention as labor_rate_profile/equipment_rate_profile.
 * Every money/hours figure here is CUMULATIVE (already includes this and
 * all prior revisions) so "revised contract value"/"revised budgeted direct
 * cost" are always just the latest row for a job, no runtime summation.
 */
export interface JobBudgetVersion {
  id: string;
  company_id: string;
  job_id: string; // references work_orders(id)
  source_type: "estimate" | "change_order";
  source_id: string; // estimates.id or change_orders.id
  revision_seq: number;
  contract_value_cents: Cents;
  labor_hours_budgeted_hundredths: HoursHundredths;
  labor_rate_used: TenThousandths | null;
  materials_budget_cents: Cents;
  subcontractor_budget_cents: Cents;
  equipment_budget_cents: Cents;
  disposal_budget_cents: Cents;
  permits_budget_cents: Cents;
  other_direct_budget_cents: Cents;
  direct_cost_budget_cents: Cents; // stored, not recomputed
  division: string;
  overhead_rate_used: TenThousandths; // frozen at approval
  budgeted_overhead_cents: Cents; // stored
  target_margin_millionths: Millionths | null;
  completion_method: CompletionMethod;
  service_units_planned: number | null;
  /** Bool01. Set by the existing-record backfill script (ITEM4-JOBCOST.md
   * §10 step 2) when a category split couldn't be attributed cleanly from
   * source data — never invented, flagged for manual review instead. */
  needs_review: Bool01;
  approved_at: string;
  approved_by: string;
  created_at: string;
}

/**
 * Migration 0085 §4.5, generalizing time_entry_adjustments' (migration
 * 0083) reversal+replacement pattern to any job_cost_ledger line, not only
 * time-entry-sourced ones — so it also covers materials/subcontractor/
 * equipment/etc. corrections once those post via the receipt pipeline.
 */
export interface JobCostLedgerAdjustment {
  id: string;
  company_id: string;
  original_line_id: number; // references job_cost_ledger(id)
  reversal_line_id: number; // references job_cost_ledger(id)
  replacement_line_id: number | null; // NULL for a pure reversal/credit
  reason: string;
  created_by: string;
  created_at: string;
}

/**
 * Finance OS fix plan item 5: audit trail for a correction to an
 * already-posted time_entries row. Posted entries and their job_cost_ledger
 * lines are never UPDATEd or DELETEd directly (see POSTING.md's
 * immutability rule and CLAUDE.md hard rule 2's rate-row precedent) — a
 * correction instead posts a reversal time_entries row that negates the
 * original's ledger impact, optionally paired with a replacement entry
 * carrying the corrected values, and this row links the three together for
 * audit trail. migrations/0083_work_order_archive_and_time_adjustments.sql.
 */
export interface TimeEntryAdjustment {
  id: string;
  company_id: string;
  original_entry_id: string; // references time_entries(id) — the posted entry being corrected
  reversal_entry_id: string; // references time_entries(id) — negates the original's posted ledger lines
  replacement_entry_id: string | null; // references time_entries(id) — null if this was a pure reversal (entry logged in error), not a correction
  reason: string;
  created_by: string;
  created_at: string;
}

// ---- rate profiles, overhead allocation, recovery snapshots ----

export type RateScope = "employee" | "crew" | "role" | "tenant";

export interface LaborRateProfile {
  id: number;
  company_id: string;
  scope: RateScope;
  scope_id: string;
  wage_cents: Cents;
  paid_hours: number;
  pto_hours: number;
  shop_hours: number;
  idle_hours: number;
  tax_rate: TenThousandths;
  comp_rate: TenThousandths;
  benefits_monthly_cents: Cents;
  support_truck_annual_cents: Cents;
  support_tools_annual_cents: Cents;
  /** MUST be 0 when tenant_finance_policy.equipment_engine_active = true (BH-13). */
  support_equipment_annual_cents: Cents;
  require_rate_approval: Bool01;
  effective_from: string;
  effective_to: string | null;
  created_at: string;
}

export interface EquipmentRateProfile {
  id: number;
  company_id: string;
  equipment_id: string;
  purchase_price_cents: Cents;
  salvage_cents: Cents;
  life_years: number;
  annual_machine_hours: number;
  finance_rate: TenThousandths;
  insurance_annual_cents: Cents;
  storage_annual_cents: Cents;
  fuel_gal_per_hr: TenThousandths;
  fuel_price_cents: Cents;
  repairs_annual_cents: Cents;
  wear_annual_cents: Cents;
  lube_pct_of_fuel: TenThousandths;
  effective_from: string;
  effective_to: string | null;
  created_at: string;
}

export interface OverheadPool {
  id: number;
  company_id: string;
  division: string;
  pool_type: string;
  annual_cost_cents: Cents;
  driver: string;
  as_of: string;
  created_at: string;
}

export interface OverheadAllocation {
  id: number;
  company_id: string;
  division: string;
  as_of: string;
  sellable_hours: number;
  allocated_overhead_cents: Cents;
  weighted_labor_rate_cents: Cents;
  overhead_rate: TenThousandths;
  absorbed_cost_cents: Cents;
  target_margin: TenThousandths;
  required_bill_rate_cents: Cents;
  created_at: string;
}

export interface RecoverySnapshot {
  id: number;
  company_id: string;
  as_of: string;
  restated_target_cents: Cents;
  recovered_to_date_cents: Cents;
  hours_per_week_hundredths: HoursHundredths;
  blended_overhead_rate: TenThousandths;
  weekly_recovery_cents: Cents;
  pct_recovered_millionths: Millionths;
  projected_black_friday: string | null;
  confidence_days: number;
  created_at: string;
}

// ---- action queue + AI layer ----

export type ActionVerb = "collect" | "bill" | "pay" | "fix" | "decide";
export type ActionStatus = "open" | "resolved" | "dismissed";

export interface ActionItem {
  id: string;
  company_id: string;
  verb: ActionVerb;
  owner_id: string;
  sla_due: string;
  amount_cents: Cents | null;
  confidence: RateConfidence;
  stale_components: string | null;
  status: ActionStatus;
  // 'work_order', not 'work_item' — the table this literal named no longer
  // exists under that name as of the 2026-08-09 merge (action_item was
  // empty in production at merge time, so this is a rename, not a live
  // data migration).
  source_type: "work_order" | "classification_finding" | "receipt" | "ingest" | null;
  source_id: string | null;
  created_at: string;
  resolved_at: string | null;
}

export interface ClassificationFinding {
  id: string;
  company_id: string;
  subject_type: string;
  subject_id: string;
  stage_reached: 1 | 2 | 3 | 4;
  confidence: RateConfidence;
  materiality_cents: Cents;
  proposed_change: string | null; // JSON
  action_item_id: string | null;
  created_at: string;
}

/** Migration 0084. Literal lifecycle status — separate from the derived
 * needs_review/field_confidence signal (which flags "the extraction was
 * unsure about a field"), this is the human review-and-approval gate:
 * every new receipt starts 'pending_review' and nothing about it ever
 * posts to job_cost_ledger regardless of status. 'approved'/'rejected'
 * are set only by an explicit human action (see documents.tsx). */
export type DocumentStatus = "pending_review" | "approved" | "rejected";

export interface Receipt {
  id: string;
  company_id: string;
  job_id: string | null; // references work_orders(id)
  r2_key: string;
  content_hash: string;
  vendor: string | null;
  amount_cents: Cents | null;
  receipt_date: string | null;
  /** JSON-encoded Record<string, RateConfidence> — one entry per extracted field. */
  field_confidence: string | null;
  action_item_id: string | null;
  /** Migration 0084. Nullable — not every receipt has a visible receipt/
   * invoice number. Used by findLikelyDuplicateReceipt's fuzzy dedupe. */
  receipt_number: string | null;
  /** Migration 0084. Defaults to 'pending_review' on insert; distinct from
   * field_confidence-derived needs_review (see DocumentStatus doc above). */
  status: DocumentStatus;
  /** Migration 0085. Set by the human approver (not guessed from vendor
   * name/amount) when posting an approved receipt to job_cost_ledger as a
   * direct_cost line — see src/api/receipt-posting.ts. NULL until then. */
  cost_category: DirectCostCategory | null;
  /** Migration 0085. Bool01, same not-yet-earned semantics as
   * job_cost_ledger.progress_eligible — set by the approver at posting
   * time (deposit/prepaid/purchased-but-uninstalled -> 0). Defaults to 1. */
  progress_eligible: Bool01;
  /** Migration 0085. Write-once guard (same "WHERE posted_at IS NULL"
   * pattern as time_entries.posted_at): a receipt can produce at most one
   * job_cost_ledger line. NULL until postApprovedReceiptToLedger succeeds. */
  posted_at: string | null;
  created_at: string;
}

// ---- upload_batch ----

export type UploadDomain = "financial_export" | "receipt" | "unrecognized";

export interface UploadBatch {
  id: string;
  company_id: string;
  filename: string;
  domain: UploadDomain;
  detected_source_id: string | null;
  needs_review: Bool01;
  row_count: number | null;
  /** Migration 0084. See DocumentStatus doc above Receipt. */
  status: DocumentStatus;
  created_at: string;
}

// ---- finance_config_override ----

export interface FinanceConfigOverride {
  id: number;
  company_id: string; // '__global__' or a real company id
  config_name: string;
  config_json: string;
  updated_by: string | null;
  updated_at: string;
}
