/**
 * What we sold labor for, against what it actually costs.
 *
 * Tyler's rule, and the whole shape of this module:
 *
 *   A sent or approved estimate keeps its original blended labor rate.
 *   Customer pricing is never silently recalculated.
 *   Actual employee rates drive INTERNAL job costing.
 *   The variance between the two is DISPLAYED, not reconciled away.
 *
 * The last clause is the one that constrains the code. It would be easy to
 * recompute the estimate at today's rates and show a tidy number; that number
 * would be a price nobody agreed to. So the sold figure is read from the frozen
 * rate and never touched, the cost figure is computed from real rates, and the
 * gap is reported as a gap.
 */

/** Rates are ten-thousandths of a dollar per hour: $42.1002/hr -> 421002. */
export const RATE_SCALE = 10000;

export interface LaborVarianceInput {
  /** Ten-thousandths. Null when the estimate never locked one. */
  lockedRate: number | null | undefined;
  /** Ten-thousandths, resolved from labor_rate_profile as of the work date. */
  currentRate: number | null | undefined;
  /** Labor actually planned or worked, in minutes. */
  minutes: number | null | undefined;
}

export interface LaborVariance {
  /** Cents this labor was SOLD at, using the frozen rate. Null if unknown. */
  sold_cents: number | null;
  /** Cents this labor actually COSTS, using current rates. Null if unknown. */
  cost_cents: number | null;
  /** cost - sold. Positive means the job is costing more than it was sold for. */
  variance_cents: number | null;
  /** Variance as a percentage of sold. Null when sold is unknown or zero. */
  variance_pct: number | null;
  /**
   * Why a number is missing, when one is. Always set alongside a null so a
   * caller never has to guess whether the figure is zero or absent.
   */
  reason: string | null;
}

/** Rate (ten-thousandths) x minutes -> whole cents. */
function costCents(rateTenThousandths: number, minutes: number): number {
  // rate/10000 dollars per hour * minutes/60 hours * 100 cents.
  // Grouped to divide once at the end, so the rounding happens in one place
  // rather than compounding through three intermediate divisions.
  return Math.round((rateTenThousandths * minutes) / (RATE_SCALE * 60) * 100);
}

export function computeLaborVariance(input: LaborVarianceInput): LaborVariance {
  const minutes = Math.max(0, Math.trunc(Number(input.minutes) || 0));
  const locked = Number(input.lockedRate);
  const current = Number(input.currentRate);
  const hasLocked = Number.isFinite(locked) && locked > 0;
  const hasCurrent = Number.isFinite(current) && current > 0;

  const empty: LaborVariance = {
    sold_cents: null, cost_cents: null, variance_cents: null, variance_pct: null, reason: null,
  };

  if (!minutes) {
    return { ...empty, reason: 'No labor recorded yet.' };
  }
  if (!hasLocked && !hasCurrent) {
    return { ...empty, reason: 'No labor rate is configured, and this estimate never locked one.' };
  }
  if (!hasLocked) {
    // Common for anything created before this mechanism existed. The cost is
    // knowable, the comparison is not — and reporting variance as 0 would claim
    // the job is exactly on target.
    return {
      ...empty,
      cost_cents: costCents(current, minutes),
      reason: 'This estimate was sent before rates were locked, so there is nothing to compare against.',
    };
  }
  if (!hasCurrent) {
    return {
      ...empty,
      sold_cents: costCents(locked, minutes),
      reason: 'No current labor rate is configured, so the real cost is unknown.',
    };
  }

  const sold = costCents(locked, minutes);
  const cost = costCents(current, minutes);
  const variance = cost - sold;
  return {
    sold_cents: sold,
    cost_cents: cost,
    variance_cents: variance,
    variance_pct: sold === 0 ? null : Math.round((variance / sold) * 1000) / 10,
    reason: null,
  };
}

/**
 * Whether an estimate's rate should be frozen now.
 *
 * At transition, not at creation: a draft is still being priced and should
 * follow current rates. The moment it reaches the customer it stops moving.
 *
 * Only ever freezes once. Re-sending an estimate must not re-lock it at today's
 * rate — that is silent recalculation of customer pricing wearing a different
 * hat, and it is the exact thing the rule forbids.
 */
export function shouldLockRate(
  nextStatus: string,
  alreadyLocked: number | null | undefined,
): boolean {
  if (alreadyLocked != null && Number(alreadyLocked) > 0) return false;
  return ['sent', 'accepted', 'approved', 'invoiced'].includes(String(nextStatus || '').toLowerCase());
}
