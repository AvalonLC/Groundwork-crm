/**
 * Scheduling capacity — pure functions, no I/O.
 *
 * The point of this module is to keep four things apart that the CRM currently
 * treats as one number:
 *
 *   calendar duration  how long the job blocks on the grid (clock times)
 *   labor capacity     people x productive minutes per working day
 *   budgeted hours     what we sold (estimates.cost_data.rollup.budgeted_hours)
 *   actual hours       what it took (time_entries)
 *
 * Everything here is minutes-in, minutes-out. Hours are a presentation concern
 * and are converted at the UI boundary, the same way money is handled in cents.
 */

/** A shift is not all productive time. See migration 0060. */
export const DEFAULT_PRODUCTIVE_MINUTES_PER_DAY = 450;

/**
 * workday_settings.working_days is a CSV of JS day-of-week (0 = Sunday),
 * e.g. "1,2,3,4,5". Anything unparseable falls back to Mon-Fri rather than to
 * an empty week, because an empty week means zero capacity, which would render
 * every crew at 0% and look like the bug this work exists to fix.
 */
export function parseWorkingDays(csv: string | null | undefined): number[] {
  const days = String(csv ?? '')
    .split(',')
    .map((d) => d.trim())
    // Drop blanks before coercing: Number('') and Number('   ') are both 0,
    // which is a valid day (Sunday), so an empty string would otherwise parse
    // as "Sundays only" instead of falling through to the default.
    .filter((d) => d !== '')
    .map((d) => Number(d))
    .filter((d) => Number.isInteger(d) && d >= 0 && d <= 6);
  const unique = [...new Set(days)].sort((a, b) => a - b);
  return unique.length ? unique : [1, 2, 3, 4, 5];
}

/**
 * One crew, one day. A crew with no members has no capacity — that is a real
 * answer, not an error, and the caller should render it as "no crew assigned"
 * rather than 0%.
 */
export function crewDailyCapacityMinutes(
  memberCount: number,
  productiveMinutesPerDay: number = DEFAULT_PRODUCTIVE_MINUTES_PER_DAY,
): number {
  const people = Math.max(0, Math.trunc(memberCount || 0));
  const perDay = Math.max(0, Math.trunc(productiveMinutesPerDay || 0));
  return people * perDay;
}

/**
 * Weeks in a year, for turning an annual hours profile into a schedulable week.
 *
 * labor_rate_profile stores hours ANNUALLY because that is how the burdened
 * rate is built — wage and support costs are annual, so the divisor must be
 * too. The schedule needs a week. 52 is the conversion, and it is named rather
 * than inlined so the two places that care (capacity here, and anything that
 * later reports weekly cost) cannot pick different numbers.
 *
 * Deliberately not 52.1775 (365.25/7). The extra precision is false: nobody's
 * paid-hours figure is accurate to the sixth of a day it would buy.
 */
export const WEEKS_PER_YEAR = 52;

/** One member's annual billable hours, or null when none could be resolved. */
export interface MemberHours {
  rep_id: string;
  /** From resolveLaborRate.billable_hours (paid - pto - shop - idle). */
  billable_hours: number | null;
}

export interface CrewCapacity {
  daily_minutes: number;
  weekly_minutes: number;
  /**
   * Members counted at the company default because they have no usable hours
   * profile. NAMED, not just counted: "this crew's week is partly a guess" is
   * only actionable if you know whose profile to go and fill in.
   */
  fallback_members: string[];
  /** profile = every member resolved · mixed = some · default = none. */
  source: 'profile' | 'mixed' | 'default';
}

/**
 * A crew's week, summed from the people actually on it.
 *
 * Replaces headcount x productive_minutes_per_day, which could only ever say
 * that all crews of the same size have the same week. A 20-hour part-timer and
 * a full-time foreman counted identically, so every crew at Avalon reported a
 * flat 90h regardless of who was on it — the number was not wrong so much as
 * incapable of being right.
 *
 * The WEEK comes from each person's profile; the DAY is that week divided
 * across the configured working days. That ordering matters: a company that
 * moves to four ten-hour days has not changed anybody's weekly hours, and a
 * per-day constant would have said it had.
 */
export function crewCapacityFromMemberHours(
  members: MemberHours[],
  workingDays: number[],
  productiveMinutesPerDay: number = DEFAULT_PRODUCTIVE_MINUTES_PER_DAY,
): CrewCapacity {
  const days = Math.max(1, workingDays.length);
  const perDay = Math.max(0, Math.trunc(productiveMinutesPerDay || 0));
  const fallbackWeek = perDay * days;

  const fallback_members: string[] = [];
  let weekly = 0;

  for (const member of members || []) {
    const hours = Number(member?.billable_hours);
    // > 1, not > 0: computeBurden substitutes billable = 1 on a misconfigured
    // profile so the rate does not divide by zero, and one billable hour a year
    // is not a week — it would render a crew at several thousand percent and
    // present it as derived from the profile.
    const usable = Number.isFinite(hours) && hours > 1;
    if (usable) {
      weekly += Math.round((hours / WEEKS_PER_YEAR) * 60);
    } else {
      fallback_members.push(String(member?.rep_id ?? ''));
      weekly += fallbackWeek;
    }
  }

  const counted = (members || []).length;
  const source: CrewCapacity['source'] =
    counted === 0 || fallback_members.length === counted
      ? 'default'
      : fallback_members.length === 0
        ? 'profile'
        : 'mixed';

  return {
    weekly_minutes: weekly,
    daily_minutes: Math.round(weekly / days),
    fallback_members,
    source,
  };
}

/**
 * Split a week's capacity across its working days so the parts sum to the whole.
 *
 * Needed because the week view reports the week as the sum of the days it is
 * showing — which is right, since a week that starts on a Wednesday genuinely
 * has fewer working days in it. But a single rounded per-day figure multiplied
 * back up does not return the week: 3072 minutes over 5 days rounds to 614 a
 * day, and 614 x 5 is 3070. Two minutes, every week, always downward.
 *
 * Largest-remainder: every day gets the floor, and the leftover minutes go one
 * each to the earliest days. Exact by construction, integers throughout.
 */
export function distributeWeeklyCapacity(weeklyMinutes: number, dayCount: number): number[] {
  const days = Math.max(0, Math.trunc(dayCount || 0));
  if (days === 0) return [];
  const total = Math.max(0, Math.trunc(weeklyMinutes || 0));
  const base = Math.floor(total / days);
  let remainder = total - base * days;
  return Array.from({ length: days }, () => {
    const extra = remainder > 0 ? 1 : 0;
    remainder -= extra;
    return base + extra;
  });
}

/** One crew across the working days that fall in the given week. */
export function crewWeeklyCapacityMinutes(
  memberCount: number,
  productiveMinutesPerDay: number = DEFAULT_PRODUCTIVE_MINUTES_PER_DAY,
  workingDays: number[] = [1, 2, 3, 4, 5],
): number {
  return crewDailyCapacityMinutes(memberCount, productiveMinutesPerDay) * workingDays.length;
}

/**
 * Utilisation as a whole percent.
 *
 * Returns null — not 0 — when there is no capacity to divide by. A crew with
 * nobody on it is not "0% utilised"; the number is undefined, and showing 0%
 * is exactly the misleading output the Week view produces today.
 */
export function utilizationPct(scheduledMinutes: number, capacityMinutes: number): number | null {
  const cap = Math.max(0, Math.trunc(capacityMinutes || 0));
  if (cap === 0) return null;
  const scheduled = Math.max(0, Math.trunc(scheduledMinutes || 0));
  return Math.round((scheduled / cap) * 100);
}

/**
 * Actual minutes worked, net of breaks.
 *
 * time_entries.duration_min is GROSS: clock-out stores raw wall-clock elapsed
 * (src/index.tsx clock-out handlers) and ending a break only accumulates into
 * time_entries.break_minutes — nothing ever subtracts one from the other, and
 * the timesheet roll-up reports the two as separate columns. Summing
 * duration_min alone therefore overstates actual hours by exactly the break
 * time, which would make every budget-vs-actual comparison read high.
 */
export function netActualMinutes(durationMin: number, breakMinutes: number = 0): number {
  const gross = Math.max(0, Math.trunc(durationMin || 0));
  const breaks = Math.max(0, Math.trunc(breakMinutes || 0));
  return Math.max(0, gross - breaks);
}

/** Sum net actual minutes across a set of time entries. */
export function sumNetActualMinutes(
  entries: Array<{ duration_min?: number | null; break_minutes?: number | null }>,
): number {
  return (entries || []).reduce(
    (total, e) => total + netActualMinutes(Number(e?.duration_min || 0), Number(e?.break_minutes || 0)),
    0,
  );
}

/**
 * Variance between what was sold and what it took.
 *
 * `budgetMinutes` is null whenever the job did not come from an estimate
 * carrying a cost-engine rollup, so callers must be able to distinguish "no
 * budget to compare against" from "on budget". Returning null for both the
 * variance and the percentage keeps that distinction instead of implying the
 * job landed exactly on target.
 */
export function budgetVariance(
  budgetMinutes: number | null | undefined,
  actualMinutes: number,
): { varianceMinutes: number | null; variancePct: number | null; overBudget: boolean } {
  const actual = Math.max(0, Math.trunc(actualMinutes || 0));
  if (budgetMinutes == null) {
    return { varianceMinutes: null, variancePct: null, overBudget: false };
  }
  const budget = Math.max(0, Math.trunc(budgetMinutes));
  const varianceMinutes = actual - budget;
  const variancePct = budget === 0 ? null : Math.round((varianceMinutes / budget) * 100);
  return { varianceMinutes, variancePct, overBudget: varianceMinutes > 0 };
}

/** Minutes to hours for display. Kept here so rounding is consistent. */
export function minutesToHours(minutes: number, decimals = 1): number {
  const m = Math.max(0, Math.trunc(minutes || 0));
  const factor = 10 ** decimals;
  return Math.round((m / 60) * factor) / factor;
}
