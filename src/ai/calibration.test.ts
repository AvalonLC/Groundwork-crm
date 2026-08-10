/// <reference types="@cloudflare/vitest-pool-workers" />
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { computeCalibrationSnapshot } from "./calibration";
import { insertClassificationFinding } from "../db/repos";
import type { Cents } from "../db/schema";

const db = () => env.DB;
const TENANT = "t-calibration";

describe("computeCalibrationSnapshot", () => {
  it("CB-01 empty tenant produces a zeroed, honest snapshot", async () => {
    const snap = await computeCalibrationSnapshot(db(), "t-calibration-empty");
    expect(snap.total_findings).toBe(0);
    expect(snap.ai_assisted_pct).toBe(0);
    expect(snap.note).toMatch(/not an accuracy measurement/);
  });

  it("CB-02 counts findings by stage_reached and computes ai_assisted_pct from stage 4", async () => {
    const rows = [
      { id: "cf-cal-1", stage: 1 as const }, { id: "cf-cal-2", stage: 2 as const },
      { id: "cf-cal-3", stage: 4 as const }, { id: "cf-cal-4", stage: 4 as const },
    ];
    for (const r of rows) {
      await insertClassificationFinding(db(), {
        id: r.id, company_id: TENANT, subject_type: "bank_transaction", subject_id: r.id,
        stage_reached: r.stage, confidence: "medium", materiality_cents: 0 as Cents,
        proposed_change: null, action_item_id: null,
      });
    }
    const snap = await computeCalibrationSnapshot(db(), TENANT);
    expect(snap.total_findings).toBe(4);
    expect(snap.ai_assisted_count).toBe(2);
    expect(snap.ai_assisted_pct).toBe(0.5);
    expect(snap.stage_distribution["4"]).toBe(2);
  });
});
