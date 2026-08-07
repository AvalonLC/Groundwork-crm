/**
 * TypeScript row shapes for migrations/finance/0001_spine.sql, 0002_rates.sql,
 * 0003_action.sql. Field names match SQL column names exactly (D1 returns rows
 * as-is). See docs/spec/SCHEMA.md.
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

// ---- 0001_spine.sql ----

export interface TenantFinancePolicy {
  tenant_id: string;
  equipment_engine_active: Bool01;
  materiality_threshold_cents: Cents;
  restated_target_cents: Cents;
  black_friday_date: string | null;
  created_at: string;
  updated_at: string;
}

export interface WorkItem {
  id: string;
  tenant_id: string;
  job_id: string;
  description: string;
  status: "open" | "complete";
  estimate_cents: Cents | null;
  completed_at: string | null;
  created_at: string;
}

export type RateConfidence = "high" | "medium" | "low";

export interface TimeEntry {
  id: number;
  tenant_id: string;
  employee_id: string;
  crew_id: string | null;
  job_id: string;
  work_date: string;
  hours_hundredths: HoursHundredths;
  ot_hours_hundredths: HoursHundredths;
  // Written ONCE at posting by /internal/rates/resolve. Never recomputed on read.
  resolved_rate: TenThousandths | null;
  resolved_rate_confidence: RateConfidence | null;
  applied_overhead_cents: Cents | null;
  posted_at: string | null;
  created_at: string;
}

export interface JobCostLedger {
  id: number;
  tenant_id: string;
  time_entry_id: number;
  job_id: string;
  line_type: "labor" | "overhead";
  amount_cents: Cents;
  division: string | null;
  posted_at: string;
}

// ---- 0002_rates.sql ----

export type RateScope = "employee" | "crew" | "role" | "tenant";

export interface LaborRateProfile {
  id: number;
  tenant_id: string;
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
  tenant_id: string;
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
  tenant_id: string;
  division: string;
  pool_type: string;
  annual_cost_cents: Cents;
  driver: string;
  as_of: string;
  created_at: string;
}

export interface OverheadAllocation {
  id: number;
  tenant_id: string;
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
  tenant_id: string;
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

// ---- 0003_action.sql ----

export type ActionVerb = "collect" | "bill" | "pay" | "fix" | "decide";
export type ActionStatus = "open" | "resolved" | "dismissed";

export interface ActionItem {
  id: string;
  tenant_id: string;
  verb: ActionVerb;
  owner_id: string;
  sla_due: string;
  amount_cents: Cents | null;
  confidence: RateConfidence;
  /** JSON-encoded string[] — must render in the UI (CLAUDE.md hard rule 4). */
  stale_components: string | null;
  status: ActionStatus;
  source_type: "work_item" | "classification_finding" | "receipt" | "ingest" | null;
  source_id: string | null;
  created_at: string;
  resolved_at: string | null;
}

export interface ClassificationFinding {
  id: string;
  tenant_id: string;
  subject_type: string;
  subject_id: string;
  stage_reached: 1 | 2 | 3 | 4;
  confidence: RateConfidence;
  materiality_cents: Cents;
  proposed_change: string | null; // JSON
  action_item_id: string | null;
  created_at: string;
}

export interface Receipt {
  id: string;
  tenant_id: string;
  job_id: string | null;
  r2_key: string;
  content_hash: string;
  vendor: string | null;
  amount_cents: Cents | null;
  receipt_date: string | null;
  /** JSON-encoded Record<string, RateConfidence> — one entry per extracted field. */
  field_confidence: string | null;
  action_item_id: string | null;
  created_at: string;
}

// ---- 0005_uploads.sql ----

export type UploadDomain = "financial_export" | "receipt" | "unrecognized";

export interface UploadBatch {
  id: string;
  tenant_id: string;
  filename: string;
  domain: UploadDomain;
  detected_source_id: string | null;
  needs_review: Bool01;
  row_count: number | null;
  created_at: string;
}

// ---- 0004_config_overrides.sql ----

export interface FinanceConfigOverride {
  id: number;
  tenant_id: string; // '__global__' or a real tenant_id
  config_name: string;
  config_json: string;
  updated_by: string | null;
  updated_at: string;
}
