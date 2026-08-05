import { describe, it, expect } from "vitest";
import { detectUnbilledWork } from "./unbilled";

const items = [
  { id: "wi-1", job_id: "job-1", estimate_cents: 12000, completed_at: "2026-07-01" },
  { id: "wi-2", job_id: "job-2", estimate_cents: 5000, completed_at: "2026-07-02" },
  { id: "wi-3", job_id: "job-3", estimate_cents: null, completed_at: "2026-07-03" },
];

describe("unbilled-work detector", () => {
  it("UB-01 flags completed items with no matching billed id", () => {
    const findings = detectUnbilledWork(items, new Set(["wi-2"]));
    expect(findings.map((f) => f.work_item_id).sort()).toEqual(["wi-1", "wi-3"]);
  });

  it("UB-02 a billed item never appears as a finding", () => {
    const findings = detectUnbilledWork(items, new Set(["wi-1", "wi-2", "wi-3"]));
    expect(findings).toEqual([]);
  });

  it("UB-03 confidence is high when the dollar amount is known, low when it isn't", () => {
    const findings = detectUnbilledWork(items, new Set());
    const wi1 = findings.find((f) => f.work_item_id === "wi-1");
    const wi3 = findings.find((f) => f.work_item_id === "wi-3");
    expect(wi1?.confidence).toBe("high");
    expect(wi1?.amount_cents).toBe(12000);
    expect(wi3?.confidence).toBe("low");
    expect(wi3?.amount_cents).toBeNull();
  });

  it("UB-04 empty input produces no findings", () => {
    expect(detectUnbilledWork([], new Set())).toEqual([]);
  });
});
