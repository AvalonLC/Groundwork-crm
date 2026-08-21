import classifierRulesJson from "../../config/finance/classifier.rules.json" with { type: "json" };
import ingestSourcesJson from "../../config/finance/ingest.sources.json" with { type: "json" };
import automationPolicyJson from "../../config/finance/automation-policy.json" with { type: "json" };
import approvalThresholdsJson from "../../config/finance/approval-thresholds.json" with { type: "json" };
import tenantDefaultsJson from "../../config/finance/tenant-defaults.json" with { type: "json" };
import divisionMapJson from "../../config/finance/division-map.json" with { type: "json" };
import roleMapJson from "../../config/finance/role-map.json" with { type: "json" };
import type { RateConfidence } from "../db/schema";
import type { Role } from "../ui/roles";

/**
 * Typed access to config/finance/*.json — the single place business
 * decisions live instead of being embedded in engine/classifier/ingest
 * code. Edit the JSON files to tune behavior; nothing here should need a
 * code change for a threshold, rule, or mapping update.
 */

// ---- classifier.rules.json ----

export interface VendorPatternRule {
  id: string;
  pattern: string;
  category: string;
  confidence: RateConfidence;
  placeholder?: boolean;
}

export interface KeywordRule {
  id: string;
  keywords: string[];
  category: string;
  confidence: RateConfidence;
  placeholder?: boolean;
}

export interface AmountReviewRule {
  id: string;
  min_cents: number;
  action: "force_review";
  reason: string;
  placeholder?: boolean;
}

export interface ClassifierRules {
  version: number;
  stage1_vendor_patterns: VendorPatternRule[];
  stage2_keyword_rules: KeywordRule[];
  stage3_amount_review_rules: AmountReviewRule[];
  forced_review_categories: string[];
  confidence_thresholds: { auto_categorize_min: RateConfidence; stage4_fallback_min: RateConfidence };
}

export const classifierRules = classifierRulesJson as ClassifierRules;

const CONFIDENCE_RANK: Record<RateConfidence, number> = { low: 0, medium: 1, high: 2 };
export function confidenceAtLeast(actual: RateConfidence, min: RateConfidence): boolean {
  return CONFIDENCE_RANK[actual] >= CONFIDENCE_RANK[min];
}

let compiledVendorPatterns: { rule: VendorPatternRule; regex: RegExp }[] | null = null;
export function compiledVendorPatternRules(): { rule: VendorPatternRule; regex: RegExp }[] {
  if (!compiledVendorPatterns) {
    compiledVendorPatterns = classifierRules.stage1_vendor_patterns.map((rule) => ({
      rule, regex: new RegExp(rule.pattern, "i"),
    }));
  }
  return compiledVendorPatterns;
}

// ---- ingest.sources.json ----

export interface IngestSourceDef {
  id: string;
  label: string;
  format: "csv" | "xlsx";
  // Only meaningful when format === "xlsx" — which binary-shape parser to
  // apply (src/ai/xlsx.ts). CSV sources never set this; detectSource()
  // routes on file type + this field, not on required_headers, since an
  // xlsx file's "header row" (the division names) isn't row 1 like a CSV's.
  shape?: "wide_class_pnl";
  target: string;
  detect: { required_headers: string[] };
  column_map: Record<string, string>;
}

export interface IngestSourcesConfig {
  version: number;
  sources: IngestSourceDef[];
  fallback: { target: string; action: string; reason: string };
}

// column_map varies per source, so TS infers a union of specific shapes from
// the JSON literal rather than Record<string, string> — widen through
// unknown rather than fight the inferred type.
export const ingestSources = ingestSourcesJson as unknown as IngestSourcesConfig;

// ---- automation-policy.json ----

export interface AutomationPolicy {
  version: number;
  classifier_enabled: boolean;
  classifier_ai_fallback_enabled: boolean;
  ingest_auto_detect_enabled: boolean;
  ingest_unknown_format_action: string;
  receipts_ai_extraction_enabled: boolean;
  equipcapture_tier2_reconciliation_enabled: boolean;
  auto_create_action_items: boolean;
}

export const automationPolicy = automationPolicyJson as AutomationPolicy;

// ---- approval-thresholds.json ----

export interface ApprovalThresholds {
  version: number;
  default_materiality_threshold_cents: number;
  large_transaction_review_cents: number;
  equipment_meter_variance_pct: number;
  recovery_confidence_days_default: number;
  receipt_review_sla_days: number;
}

export const approvalThresholds = approvalThresholdsJson as ApprovalThresholds;

// ---- tenant-defaults.json ----

export interface TenantDefaults {
  version: number;
  equipment_engine_active: boolean;
  materiality_threshold_cents: number;
  restated_target_cents: number;
  black_friday_date: string | null;
}

export const tenantDefaults = tenantDefaultsJson as TenantDefaults;

// ---- division-map.json ----

export interface DivisionMap {
  version: number;
  canonical_divisions: string[];
  aliases: Record<string, string[]>;
  unmapped_division_action: string;
}

export const divisionMap = divisionMapJson as DivisionMap;

/** Case-insensitive alias resolution — returns the canonical division name,
 * or null if nothing matches (caller applies unmapped_division_action).
 * Takes `map` as a parameter (defaulting to the static config) so a
 * DB-aware caller can pass an admin-edited override. */
export function resolveDivision(input: string, map: DivisionMap = divisionMap): string | null {
  const needle = input.trim().toLowerCase();
  if (map.canonical_divisions.some((d) => d.toLowerCase() === needle)) {
    return map.canonical_divisions.find((d) => d.toLowerCase() === needle)!;
  }
  for (const canonical of map.canonical_divisions) {
    const aliases = map.aliases[canonical] ?? [];
    if (aliases.some((a) => a.toLowerCase() === needle)) return canonical;
  }
  return null;
}

// ---- role-map.json ----

export interface RoleMapConfig {
  version: number;
  crm_role_to_finance_role: Record<string, Role>;
  default_finance_role: Role;
  super_admin_finance_role: Role;
}

export const roleMap = roleMapJson as RoleMapConfig;

/** Maps a CRM session's role string (+ isSuperAdmin flag) to a Finance OS
 * Role. Unrecognized CRM roles fall back to default_finance_role (the most
 * restrictive option, by design — see role-map.json's note) rather than
 * throwing or defaulting to something permissive. */
export function resolveFinanceRole(crmRole: string | undefined | null, isSuperAdmin: boolean): Role {
  if (isSuperAdmin) return roleMap.super_admin_finance_role;
  if (!crmRole) return roleMap.default_finance_role;
  return roleMap.crm_role_to_finance_role[crmRole] ?? roleMap.default_finance_role;
}
