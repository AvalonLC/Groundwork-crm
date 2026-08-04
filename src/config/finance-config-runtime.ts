import { getConfigOverride, upsertConfigOverride, deleteConfigOverride, listConfigOverrides, GLOBAL_CONFIG_SCOPE } from "../db/repos";
import {
  classifierRules, ingestSources, automationPolicy, approvalThresholds,
  tenantDefaults, divisionMap, roleMap,
} from "./finance-config";

/**
 * Layers admin-edited DB overrides (finance_config_override,
 * migrations/finance/0004) on top of the static config/finance/*.json
 * defaults. The JSON files stay the safe, version-controlled fallback;
 * a saved override — global or per-tenant — takes effect immediately for
 * anything that reads config through getEffectiveConfig(), no deploy
 * needed. Precedence: tenant-specific override > global override > static
 * JSON default.
 */

export const CONFIG_NAMES = [
  "classifier_rules", "ingest_sources", "automation_policy",
  "approval_thresholds", "tenant_defaults", "division_map", "role_map",
] as const;
export type ConfigName = typeof CONFIG_NAMES[number];

const STATIC_DEFAULTS: Record<ConfigName, unknown> = {
  classifier_rules: classifierRules,
  ingest_sources: ingestSources,
  automation_policy: automationPolicy,
  approval_thresholds: approvalThresholds,
  tenant_defaults: tenantDefaults,
  division_map: divisionMap,
  role_map: roleMap,
};

export function getStaticDefault(name: ConfigName): unknown {
  return STATIC_DEFAULTS[name];
}

export function isConfigName(value: string): value is ConfigName {
  return (CONFIG_NAMES as readonly string[]).includes(value);
}

export interface EffectiveConfig<T = unknown> {
  name: ConfigName;
  value: T;
  is_override: boolean;
  override_scope: string | null; // '__global__', a tenant_id, or null (using static default)
  updated_by: string | null;
  updated_at: string | null;
}

export async function getEffectiveConfig<T = unknown>(
  db: D1Database, tenantId: string, name: ConfigName,
): Promise<EffectiveConfig<T>> {
  const override = await getConfigOverride(db, tenantId, name);
  if (override) {
    return {
      name, value: JSON.parse(override.config_json) as T, is_override: true,
      override_scope: override.tenant_id, updated_by: override.updated_by, updated_at: override.updated_at,
    };
  }
  return {
    name, value: STATIC_DEFAULTS[name] as T, is_override: false,
    override_scope: null, updated_by: null, updated_at: null,
  };
}

export async function listEffectiveConfigs(db: D1Database, tenantId: string): Promise<EffectiveConfig[]> {
  return Promise.all(CONFIG_NAMES.map((name) => getEffectiveConfig(db, tenantId, name)));
}

/** Minimal structural validation — not a full schema check, but enough to
 * reject malformed JSON before it can break a running config consumer. */
export function validateConfigShape(name: ConfigName, parsed: unknown): string | null {
  if (typeof parsed !== "object" || parsed === null) return "must be a JSON object";
  const obj = parsed as Record<string, unknown>;

  switch (name) {
    case "classifier_rules":
      if (!Array.isArray(obj.stage1_vendor_patterns)) return "stage1_vendor_patterns must be an array";
      if (!Array.isArray(obj.stage2_keyword_rules)) return "stage2_keyword_rules must be an array";
      if (!Array.isArray(obj.forced_review_categories)) return "forced_review_categories must be an array";
      if (typeof obj.confidence_thresholds !== "object" || obj.confidence_thresholds === null) return "confidence_thresholds must be an object";
      return null;
    case "ingest_sources":
      if (!Array.isArray(obj.sources)) return "sources must be an array";
      if (typeof obj.fallback !== "object" || obj.fallback === null) return "fallback must be an object";
      return null;
    case "division_map":
      if (!Array.isArray(obj.canonical_divisions)) return "canonical_divisions must be an array";
      if (typeof obj.aliases !== "object" || obj.aliases === null) return "aliases must be an object";
      return null;
    case "role_map":
      if (typeof obj.crm_role_to_finance_role !== "object" || obj.crm_role_to_finance_role === null) return "crm_role_to_finance_role must be an object";
      if (typeof obj.default_finance_role !== "string") return "default_finance_role must be a string";
      return null;
    case "automation_policy":
    case "approval_thresholds":
    case "tenant_defaults":
      return null; // shape is a flat bag of primitives; JSON.parse succeeding is enough
  }
}

export async function saveConfigOverride(
  db: D1Database, tenantId: string, name: ConfigName, rawJson: string, updatedBy: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    return { ok: false, error: "invalid JSON" };
  }
  const shapeError = validateConfigShape(name, parsed);
  if (shapeError) return { ok: false, error: shapeError };

  await upsertConfigOverride(db, tenantId, name, JSON.stringify(parsed), updatedBy);
  return { ok: true };
}

export async function resetConfigOverride(db: D1Database, tenantId: string, name: ConfigName): Promise<void> {
  await deleteConfigOverride(db, tenantId, name);
}

export { listConfigOverrides, GLOBAL_CONFIG_SCOPE };
