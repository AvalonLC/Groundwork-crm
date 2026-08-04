import { describe, it, expect } from "vitest";
import {
  classifierRules, ingestSources, automationPolicy, approvalThresholds,
  tenantDefaults, divisionMap, resolveDivision, confidenceAtLeast, compiledVendorPatternRules,
} from "./finance-config";

describe("finance config loader", () => {
  it("CFG-01 all six config files load with the expected top-level shape", () => {
    expect(classifierRules.version).toBe(1);
    expect(ingestSources.version).toBe(1);
    expect(automationPolicy.version).toBe(1);
    expect(approvalThresholds.version).toBe(1);
    expect(tenantDefaults.version).toBe(1);
    expect(divisionMap.version).toBe(1);
  });

  it("CFG-02 vendor patterns compile to valid regexes", () => {
    const compiled = compiledVendorPatternRules();
    expect(compiled.length).toBeGreaterThan(0);
    expect(compiled[0].regex).toBeInstanceOf(RegExp);
    expect("Shell Gas Station".match(compiled.find((c) => c.rule.id === "fuel-generic")!.regex)).not.toBeNull();
  });

  it("CFG-03 confidenceAtLeast ranks low < medium < high", () => {
    expect(confidenceAtLeast("high", "medium")).toBe(true);
    expect(confidenceAtLeast("medium", "high")).toBe(false);
    expect(confidenceAtLeast("low", "low")).toBe(true);
  });

  it("CFG-04 resolveDivision matches canonical names and aliases case-insensitively", () => {
    expect(resolveDivision("Maintenance")).toBe("maintenance");
    expect(resolveDivision("lawn maintenance")).toBe("maintenance");
    expect(resolveDivision("LAWN MAINTENANCE")).toBe("maintenance");
    expect(resolveDivision("totally-unknown-division")).toBeNull();
  });

  it("CFG-05 every ingest source has at least one required header", () => {
    for (const source of ingestSources.sources) {
      expect(source.detect.required_headers.length).toBeGreaterThan(0);
    }
  });
});
