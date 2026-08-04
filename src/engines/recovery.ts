export interface RecoveryProjectionInput {
  as_of: string; // YYYY-MM-DD
  restated_target: number; // dollars — restated actuals, never a straight-line budget/12
  recovered_to_date: number; // dollars
  hours_per_week: number;
  blended_overhead_rate: number; // $/hr
  /**
   * +/- day window around the projected date. NOT computed here: a real
   * confidence window needs trailing weekly_recovery variance (multiple
   * recovery_snapshot rows over time), which a single point-in-time call
   * can't supply. The caller (W3-rollup, once snapshot history exists)
   * derives this and passes it through. See docs/spec/RECOVERY.md.
   */
  confidence_days: number;
}

export interface RecoveryProjection {
  weekly_recovery: number;
  pct_recovered: number;
  projected_black_friday: string; // YYYY-MM-DD
  confidence_days: number;
}

/**
 * Pure function. No DB, no I/O. See docs/spec/RECOVERY.md.
 * Recovery recognition source is ALWAYS time_entry hours upstream of this
 * function — never an invoice, deposit, or payment event (CLAUDE.md hard
 * rule 3). This function doesn't touch those events at all; it only projects
 * forward from an already-restated target and an already-computed
 * recovered-to-date figure.
 */
export function computeRecoveryProjection(i: RecoveryProjectionInput): RecoveryProjection {
  const weeklyRecovery = i.hours_per_week * i.blended_overhead_rate;
  const pctRecovered = i.recovered_to_date / i.restated_target;

  const remaining = i.restated_target - i.recovered_to_date;
  const weeksRemaining = remaining / weeklyRecovery;
  const daysRemaining = Math.round(weeksRemaining * 7);

  const asOf = new Date(`${i.as_of}T00:00:00Z`);
  const projected = new Date(asOf.getTime() + daysRemaining * 86_400_000);
  const projectedBlackFriday = projected.toISOString().slice(0, 10);

  return {
    weekly_recovery: weeklyRecovery,
    pct_recovered: pctRecovered,
    projected_black_friday: projectedBlackFriday,
    // Never returned as a bare date with no window (forbidden: "returning a
    // single date without a confidence range") — always paired with this.
    confidence_days: i.confidence_days,
  };
}
