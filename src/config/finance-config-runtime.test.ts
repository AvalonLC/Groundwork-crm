/// <reference types="@cloudflare/vitest-pool-workers" />
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import {
  getEffectiveConfig, listEffectiveConfigs, saveConfigOverride, resetConfigOverride,
  validateConfigShape, getStaticDefault, isConfigName, CONFIG_NAMES,
} from "./finance-config-runtime";
import { classifierRules } from "./finance-config";
import { GLOBAL_CONFIG_SCOPE } from "../db/repos";

const db = () => env.DB;

describe("getEffectiveConfig — falls back to static default with no override", () => {
  it("RT-01 returns the static JSON default when no override exists", async () => {
    const eff = await getEffectiveConfig(db(), "t-rt-none", "classifier_rules");
    expect(eff.is_override).toBe(false);
    expect(eff.value).toEqual(classifierRules);
  });

  it("RT-02 all seven config names resolve without error", async () => {
    const results = await listEffectiveConfigs(db(), "t-rt-all");
    expect(results.length).toBe(CONFIG_NAMES.length);
    expect(results.every((r) => r.value !== undefined)).toBe(true);
  });
});

describe("saveConfigOverride — validates before writing", () => {
  it("RT-03 rejects invalid JSON without writing anything", async () => {
    const result = await saveConfigOverride(db(), "t-rt-badjson", "automation_policy", "{not valid json", "admin-1");
    expect(result.ok).toBe(false);
    const eff = await getEffectiveConfig(db(), "t-rt-badjson", "automation_policy");
    expect(eff.is_override).toBe(false); // nothing was saved
  });

  it("RT-04 rejects a classifier_rules payload missing a required array field", async () => {
    const result = await saveConfigOverride(db(), "t-rt-badshape", "classifier_rules", '{"stage2_keyword_rules":[]}', "admin-1");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error).toMatch(/stage1_vendor_patterns/);
  });

  it("RT-05 a valid override saves and is returned as effective config", async () => {
    const tenantId = "t-rt-valid";
    const override = { ...classifierRules, forced_review_categories: ["custom_category"] };
    const result = await saveConfigOverride(db(), tenantId, "classifier_rules", JSON.stringify(override), "admin-1");
    expect(result.ok).toBe(true);

    const eff = await getEffectiveConfig<typeof classifierRules>(db(), tenantId, "classifier_rules");
    expect(eff.is_override).toBe(true);
    expect(eff.value.forced_review_categories).toEqual(["custom_category"]);
    expect(eff.updated_by).toBe("admin-1");
  });

  it("RT-06 resetConfigOverride reverts to the static default", async () => {
    const tenantId = "t-rt-reset";
    await saveConfigOverride(db(), tenantId, "automation_policy", '{"classifier_enabled":false}', "admin-1");
    let eff = await getEffectiveConfig(db(), tenantId, "automation_policy");
    expect(eff.is_override).toBe(true);

    await resetConfigOverride(db(), tenantId, "automation_policy");
    eff = await getEffectiveConfig(db(), tenantId, "automation_policy");
    expect(eff.is_override).toBe(false);
  });
});

describe("validateConfigShape / isConfigName / getStaticDefault", () => {
  it("RT-07 rejects a non-object payload", () => {
    expect(validateConfigShape("automation_policy", "not an object")).toMatch(/JSON object/);
    expect(validateConfigShape("automation_policy", null)).toMatch(/JSON object/);
  });

  it("RT-08 accepts a flat config (automation_policy/approval_thresholds/tenant_defaults) with no structural requirements beyond being an object", () => {
    expect(validateConfigShape("automation_policy", { foo: "bar" })).toBeNull();
  });

  it("RT-09 isConfigName distinguishes valid from invalid names", () => {
    expect(isConfigName("classifier_rules")).toBe(true);
    expect(isConfigName("not_a_real_config")).toBe(false);
  });

  it("RT-10 getStaticDefault returns the same object finance-config.ts exports", () => {
    expect(getStaticDefault("classifier_rules")).toBe(classifierRules);
  });
});

describe("global vs tenant scope integration", () => {
  it("RT-11 a global override applies to every tenant that doesn't have its own", async () => {
    await saveConfigOverride(db(), GLOBAL_CONFIG_SCOPE, "division_map", '{"canonical_divisions":["only_one"],"aliases":{}}', "admin-1");
    const eff = await getEffectiveConfig<{ canonical_divisions: string[] }>(db(), "t-rt-global-consumer", "division_map");
    expect(eff.is_override).toBe(true);
    expect(eff.override_scope).toBe(GLOBAL_CONFIG_SCOPE);
    expect(eff.value.canonical_divisions).toEqual(["only_one"]);
  });
});
