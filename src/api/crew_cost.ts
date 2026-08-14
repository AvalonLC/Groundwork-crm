/**
 * What a crew costs per hour, from the people actually on it.
 *
 * The number everyone wants is "Blue Crew costs $126/hr". The number that is
 * honest is "Blue Crew costs $126/hr, and two of those three rates are the
 * company default because nobody has set a rate for Ben or Cara".
 *
 * Those are very different claims. The first gets used to price a job; the
 * second tells you the price is a guess. This module refuses to produce the
 * first without the second attached.
 */

/** Rates are ten-thousandths of a dollar per hour: $42.1002/hr -> 421002. */
export const RATE_SCALE = 10000;

export interface MemberRate {
  rep_id: string;
  rep_name?: string | null;
  crew_role?: string | null;
  /** Ten-thousandths. Null when nothing could be resolved at all. */
  resolved_rate: number | null;
  /**
   * Which profile the rate came from: 'employee', 'crew' or 'company'.
   *
   * This is the inference guard. A rate that resolved at 'employee' scope was
   * set for that person. Anything broader is a fallback — real, usable, and not
   * a statement about them.
   */
  resolved_scope?: string | null;
}

export interface CrewCost {
  crew_id: string;
  member_count: number;
  /** Ten-thousandths per hour, summed across members. Null if nothing resolved. */
  hourly_cost: number | null;
  /** Whole cents per hour, for display. */
  hourly_cost_cents: number | null;
  /** Members whose rate came from a broader scope than themselves. */
  inferred: Array<{ rep_id: string; rep_name: string | null; from_scope: string }>;
  /** Members for whom no rate resolved at all. */
  unrated: Array<{ rep_id: string; rep_name: string | null }>;
  /**
   * True only when every member's rate was set for that member.
   *
   * The flag a caller should check before treating hourly_cost as a fact — and
   * the reason this is not just a sum.
   */
  fully_specified: boolean;
  /** Plain-language summary of what is uncertain, or null when nothing is. */
  caveat: string | null;
}

export function computeCrewCost(crewId: string, members: MemberRate[]): CrewCost {
  const list = members || [];
  const inferred: CrewCost['inferred'] = [];
  const unrated: CrewCost['unrated'] = [];
  let total = 0;
  let counted = 0;

  for (const m of list) {
    const rate = Number(m.resolved_rate);
    if (!Number.isFinite(rate) || rate <= 0) {
      unrated.push({ rep_id: m.rep_id, rep_name: m.rep_name ?? null });
      continue;
    }
    total += rate;
    counted++;
    const scope = String(m.resolved_scope || '').toLowerCase();
    if (scope && scope !== 'employee') {
      inferred.push({ rep_id: m.rep_id, rep_name: m.rep_name ?? null, from_scope: scope });
    }
  }

  const hourly = counted > 0 ? total : null;
  // Every member's rate is their own, and there is at least one member. An empty
  // crew is not "fully specified" — it is a crew with nothing to specify.
  const fullySpecified = list.length > 0 && inferred.length === 0 && unrated.length === 0;

  const parts: string[] = [];
  if (unrated.length) {
    parts.push(
      // "1 of 2 people has" — the noun follows the group ("of 2"), the verb
      // follows the count. "1 of 2 person has" is what agreeing both with the
      // count produces, and it reads as a bug in a message about bad data.
      `${unrated.length} of ${list.length} people ${unrated.length === 1 ? 'has' : 'have'} no labor rate at all, ` +
      `so they are missing from this total`,
    );
  }
  if (inferred.length) {
    const scopes = [...new Set(inferred.map((i) => i.from_scope))].join(' and ');
    parts.push(
      `${inferred.length} of ${list.length} rates ${inferred.length === 1 ? 'is' : 'are'} the ${scopes} default ` +
      `rather than a rate set for that person`,
    );
  }

  return {
    crew_id: crewId,
    member_count: list.length,
    hourly_cost: hourly,
    // Ten-thousandths of a dollar -> cents. Rounded once, at the boundary.
    hourly_cost_cents: hourly == null ? null : Math.round((hourly / RATE_SCALE) * 100),
    inferred,
    unrated,
    fully_specified: fullySpecified,
    caveat: parts.length ? parts.join('; ') + '.' : null,
  };
}

/**
 * Cost of a crew working for a given number of minutes.
 *
 * Returns null rather than 0 when the crew has no resolvable cost — a job
 * staffed by people with no rates costs an unknown amount, not nothing, and
 * feeding 0 into a margin calculation reports pure profit.
 */
export function crewLaborCostCents(cost: CrewCost, minutes: number): number | null {
  if (cost.hourly_cost == null) return null;
  const mins = Math.max(0, Math.trunc(Number(minutes) || 0));
  return Math.round((cost.hourly_cost * mins) / (RATE_SCALE * 60) * 100);
}
