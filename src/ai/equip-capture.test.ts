/// <reference types="@cloudflare/vitest-pool-workers" />
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import {
  validateTier1Attachment, reconcileMeterReading, processTier2MeterReading,
} from "./equip-capture";

const db = () => env.DB;
const TENANT = "t-equipcapture";

describe("tier 1: crew-attached machine capture", () => {
  it("EC-01 a well-formed attachment is valid with high confidence", () => {
    const r = validateTier1Attachment({ time_entry_id: "te-1", equipment_id: "eq-1" });
    expect(r.valid).toBe(true);
    expect(r.confidence).toBe("high");
  });

  it("EC-02 an empty equipment_id is invalid with low confidence", () => {
    const r = validateTier1Attachment({ time_entry_id: "te-1", equipment_id: "  " });
    expect(r.valid).toBe(false);
    expect(r.confidence).toBe("low");
  });
});

describe("tier 2: meter-photo reconciliation", () => {
  it("EC-03 pace roughly matching the rate profile's assumption is not divergent", () => {
    // 720 assumed annual hours; 60 hours over 30 days -> 730/yr, ~1.4% off.
    const r = reconcileMeterReading({
      equipment_id: "eq-1", meter_hours: 60, period_days: 30, assumed_annual_machine_hours: 720,
    });
    expect(r.materially_divergent).toBe(false);
  });

  it("EC-04 pace far off the assumption is materially divergent (>20%)", () => {
    // 720 assumed; 120 hours over 30 days -> 1460/yr, ~103% over.
    const r = reconcileMeterReading({
      equipment_id: "eq-1", meter_hours: 120, period_days: 30, assumed_annual_machine_hours: 720,
    });
    expect(r.materially_divergent).toBe(true);
    expect(r.variance_pct).toBeGreaterThan(0.20);
  });

  it("EC-05 a matching reading writes no classification_finding at all", async () => {
    const result = await processTier2MeterReading(db(), TENANT, {
      equipment_id: "eq-match", meter_hours: 60, period_days: 30, assumed_annual_machine_hours: 720,
    });
    expect(result.finding_id).toBeNull();
    const { results } = await db().prepare(
      `SELECT COUNT(*) as n FROM classification_finding WHERE company_id = ? AND subject_id = ?`,
    ).bind(TENANT, "eq-match").all();
    expect((results[0] as any).n).toBe(0);
  });

  it("EC-06 a divergent reading writes exactly one classification_finding", async () => {
    const result = await processTier2MeterReading(db(), TENANT, {
      equipment_id: "eq-divergent", meter_hours: 120, period_days: 30, assumed_annual_machine_hours: 720,
    });
    expect(result.finding_id).not.toBeNull();
    const { results } = await db().prepare(
      `SELECT COUNT(*) as n FROM classification_finding WHERE company_id = ? AND subject_id = ?`,
    ).bind(TENANT, "eq-divergent").all();
    expect((results[0] as any).n).toBe(1);
  });
});
