import { insertClassificationFinding } from "../db/repos";
import type { Cents, RateConfidence } from "../db/schema";
import { approvalThresholds } from "../config/finance-config";

const ZERO_CENTS = 0 as Cents;

/**
 * See docs/spec/EQUIPMENT.md. Two tiers. Neither introduces new tables —
 * this task's files_owned is just this module, so both tiers write through
 * the existing classification_finding table rather than a bespoke
 * equipment_usage schema.
 */

// ---- Tier 1: crew-attached machine capture (job/crew association only) ----

export interface Tier1Attachment {
  time_entry_id: number;
  equipment_id: string;
}

export interface Tier1Result {
  valid: boolean;
  confidence: RateConfidence;
}

/** Cheap, deterministic, no meter reading — just "which machine was on
 * which job." */
export function validateTier1Attachment(a: Tier1Attachment): Tier1Result {
  const valid = a.time_entry_id > 0 && a.equipment_id.trim().length > 0;
  return { valid, confidence: valid ? "high" : "low" };
}

// ---- Tier 2: meter-photo capture (OCR'd hour-meter/odometer reading) ----

export interface Tier2MeterReading {
  equipment_id: string;
  meter_hours: number; // hours accumulated since the last known reading
  period_days: number; // days since that reading, to annualize the pace
  assumed_annual_machine_hours: number; // from equipment_rate_profile
}

export interface MeterReconciliation {
  projected_annual_hours: number;
  variance_pct: number; // (projected - assumed) / assumed
  materially_divergent: boolean;
}

/**
 * Pure. True-ups actual machine-hour pace against the rate profile's
 * annual_machine_hours assumption. `materialityThreshold` defaults to
 * config/finance/approval-thresholds.json's equipment_meter_variance_pct —
 * takes a parameter (rather than reading the config module singleton
 * directly) so a DB-aware caller can pass an admin-edited override without
 * this function itself needing DB access.
 */
export function reconcileMeterReading(
  r: Tier2MeterReading,
  materialityThreshold: number = approvalThresholds.equipment_meter_variance_pct,
): MeterReconciliation {
  const projectedAnnualHours = (r.meter_hours / r.period_days) * 365;
  const variancePct = (projectedAnnualHours - r.assumed_annual_machine_hours) / r.assumed_annual_machine_hours;
  return {
    projected_annual_hours: projectedAnnualHours,
    variance_pct: variancePct,
    materially_divergent: Math.abs(variancePct) > materialityThreshold,
  };
}

export interface Tier2Result {
  reconciliation: MeterReconciliation;
  finding_id: string | null;
}

/** Only writes a classification_finding when materially divergent — a
 * meter reading that roughly matches the rate profile's assumption produces
 * no finding at all, not a low-materiality noise row. */
export async function processTier2MeterReading(
  db: D1Database, tenantId: string, reading: Tier2MeterReading,
  materialityThreshold: number = approvalThresholds.equipment_meter_variance_pct,
): Promise<Tier2Result> {
  const reconciliation = reconcileMeterReading(reading, materialityThreshold);
  if (!reconciliation.materially_divergent) return { reconciliation, finding_id: null };

  const findingId = `cf-equip-${reading.equipment_id}-${crypto.randomUUID().slice(0, 8)}`;
  await insertClassificationFinding(db, {
    id: findingId,
    tenant_id: tenantId,
    subject_type: "equipment_meter",
    subject_id: reading.equipment_id,
    stage_reached: 1,
    confidence: "high",
    materiality_cents: ZERO_CENTS,
    proposed_change: JSON.stringify(reconciliation),
    action_item_id: null,
  });
  return { reconciliation, finding_id: findingId };
}
