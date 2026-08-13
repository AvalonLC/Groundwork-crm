/**
 * Budgeted hours for a work order created from a RECURRING estimate.
 *
 * A one-off estimate stores its labor in cost_data.rollup.budgeted_hours, and
 * estimate -> work-order conversion reads exactly that. A recurring estimate
 * never writes cost_data — it writes recurring_data.rollup — so conversion read
 * a key that was not there and every recurring job landed with NO budget hours.
 *
 * The obvious repair is wrong. recurring_data.rollup.yearly_hours is the man-
 * hours for a WHOLE YEAR of visits (public/js/estimates.js: `yearlyHours +=
 * mh * occ`). Putting it on a single work order would say a weekly two-hour mow
 * takes 104 hours — worse than the zero it replaced, because zero at least
 * reads as "unknown" while 104 reads as a real number and would blow up crew
 * capacity, budget-vs-actual and job costing together.
 *
 * What a single work order wants is hours for ONE VISIT. Each service line
 * carries `occurrences` — the field is literally labelled "Visits/yr" in the
 * estimate builder — and `man_hours`, the labor for one visit of that service.
 * So visits per year is the sum of occurrences, and the hours a typical visit
 * costs is the total man-hours divided by that.
 *
 * This reads the service lines rather than the rollup on purpose: the rollup is
 * written by the browser and only contains what the client happened to compute
 * at save time, whereas the service lines are the input the user actually typed
 * and are present on estimates saved before this code existed.
 *
 * NOTE: this is the conversion path for turning a recurring estimate into ONE
 * job. It is a reasonable average, not a schedule. The real answer for
 * recurring work is a subscription plus generated per-visit work orders, each
 * carrying its own plan's hours; this exists so the single-job path stops
 * lying, not to replace that.
 */

export interface RecurringService {
  occurrences?: number | string | null;
  man_hours?: number | string | null;
}

export interface RecurringHours {
  /** Total visits across a year — the sum of every service line's occurrences. */
  visitsPerYear: number;
  /** Man-hours for a whole year of visits. Matches rollup.yearly_hours. */
  yearlyHours: number;
  /**
   * Average man-hours for one visit, or null when it cannot be known.
   *
   * null — not 0 — when there are no services, no occurrences or no hours.
   * "We do not know how long a visit takes" and "a visit takes no time" are
   * different claims, and the caller must be able to leave the column NULL
   * rather than assert the second one.
   */
  hoursPerVisit: number | null;
}

/** Coerce a JSON-sourced number, rejecting NaN/Infinity/negatives. */
function num(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

export function recurringHoursFromServices(services: unknown): RecurringHours {
  const rows: RecurringService[] = Array.isArray(services) ? services : [];
  let visitsPerYear = 0;
  let yearlyHours = 0;
  for (const s of rows) {
    const occurrences = num(s?.occurrences);
    const manHours = num(s?.man_hours);
    visitsPerYear += occurrences;
    yearlyHours += manHours * occurrences;
  }
  const hoursPerVisit =
    visitsPerYear > 0 && yearlyHours > 0
      ? Math.round((yearlyHours / visitsPerYear) * 100) / 100
      : null;
  return { visitsPerYear, yearlyHours, hoursPerVisit };
}

/**
 * Parse an estimate's recurring_data and return the per-visit hours.
 *
 * Takes the raw column value because that is what the conversion handler has,
 * and swallows malformed JSON: a broken blob means "no budget hours", which the
 * caller already handles, and must never take down the conversion itself.
 */
export function hoursPerVisitFromRecurringData(recurringData: unknown): number | null {
  let parsed: any = recurringData;
  if (typeof recurringData === 'string') {
    try {
      parsed = JSON.parse(recurringData || '{}');
    } catch {
      return null;
    }
  }
  return recurringHoursFromServices(parsed?.services).hoursPerVisit;
}
