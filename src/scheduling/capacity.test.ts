import { describe, it, expect } from 'vitest';
import {
  DEFAULT_PRODUCTIVE_MINUTES_PER_DAY,
  parseWorkingDays,
  crewDailyCapacityMinutes,
  crewWeeklyCapacityMinutes,
  utilizationPct,
  netActualMinutes,
  sumNetActualMinutes,
  budgetVariance,
  minutesToHours,
  crewCapacityFromMemberHours,
  distributeWeeklyCapacity,
} from './capacity';

describe('parseWorkingDays', () => {
  it('parses the workday_settings CSV', () => {
    expect(parseWorkingDays('1,2,3,4,5')).toEqual([1, 2, 3, 4, 5]);
  });

  it('sorts, dedupes and ignores out-of-range values', () => {
    expect(parseWorkingDays('5, 1 ,3,3,9,-2')).toEqual([1, 3, 5]);
  });

  it('falls back to Mon-Fri rather than an empty week', () => {
    // An empty week would mean zero capacity, which renders every crew at 0%
    // — the exact bug this module exists to fix.
    for (const input of [null, undefined, '', '   ', 'nonsense']) {
      expect(parseWorkingDays(input as any)).toEqual([1, 2, 3, 4, 5]);
    }
  });

  it('accepts Sunday as a working day', () => {
    expect(parseWorkingDays('0,6')).toEqual([0, 6]);
  });
});

describe('crewDailyCapacityMinutes', () => {
  it('is people times productive minutes', () => {
    expect(crewDailyCapacityMinutes(3, 450)).toBe(1350);
  });

  it('defaults to the productive-minutes constant from migration 0060', () => {
    expect(crewDailyCapacityMinutes(2)).toBe(2 * DEFAULT_PRODUCTIVE_MINUTES_PER_DAY);
  });

  it('is zero for a crew with nobody on it', () => {
    expect(crewDailyCapacityMinutes(0, 450)).toBe(0);
  });

  it('never goes negative on garbage input', () => {
    expect(crewDailyCapacityMinutes(-4, 450)).toBe(0);
    expect(crewDailyCapacityMinutes(3, -450)).toBe(0);
    expect(crewDailyCapacityMinutes(NaN as any, NaN as any)).toBe(0);
  });
});

describe('crewWeeklyCapacityMinutes', () => {
  it('multiplies daily capacity by the number of working days', () => {
    expect(crewWeeklyCapacityMinutes(2, 450, [1, 2, 3, 4, 5])).toBe(4500);
  });

  it('shrinks with a four-day week', () => {
    expect(crewWeeklyCapacityMinutes(2, 450, [1, 2, 3, 4])).toBe(3600);
  });

  it('is not the hardcoded 40 hours the Week view assumes', () => {
    // The crew-lane metric divides by a literal 40h (2400 min) regardless of
    // crew size. A three-person crew has far more than that.
    expect(crewWeeklyCapacityMinutes(3, 450, [1, 2, 3, 4, 5])).toBe(6750);
    expect(crewWeeklyCapacityMinutes(3, 450, [1, 2, 3, 4, 5])).not.toBe(2400);
  });
});

describe('utilizationPct', () => {
  it('is a whole percent', () => {
    expect(utilizationPct(2250, 4500)).toBe(50);
  });

  it('rounds to the nearest percent', () => {
    expect(utilizationPct(1501, 4500)).toBe(33);
  });

  it('can exceed 100 when a crew is over-booked', () => {
    expect(utilizationPct(5400, 4500)).toBe(120);
  });

  it('returns null, not 0, when there is no capacity to divide by', () => {
    // A crew with nobody on it is not "0% utilised" — the number is undefined.
    expect(utilizationPct(0, 0)).toBeNull();
    expect(utilizationPct(600, 0)).toBeNull();
  });

  it('is 0 only when there is real capacity and nothing scheduled', () => {
    expect(utilizationPct(0, 4500)).toBe(0);
  });
});

describe('netActualMinutes', () => {
  it('subtracts breaks from gross clock time', () => {
    // duration_min is raw wall-clock elapsed; break_minutes accumulates
    // separately and is never subtracted anywhere in the codebase.
    expect(netActualMinutes(480, 30)).toBe(450);
  });

  it('is unchanged when no break was taken', () => {
    expect(netActualMinutes(480, 0)).toBe(480);
    expect(netActualMinutes(480)).toBe(480);
  });

  it('treats a null break as zero', () => {
    expect(netActualMinutes(480, null as any)).toBe(480);
  });

  it('never goes negative if breaks somehow exceed the entry', () => {
    expect(netActualMinutes(20, 45)).toBe(0);
  });

  it('sums across entries net of each entry own breaks', () => {
    expect(
      sumNetActualMinutes([
        { duration_min: 480, break_minutes: 30 },
        { duration_min: 240, break_minutes: 15 },
        { duration_min: 60, break_minutes: null },
      ]),
    ).toBe(450 + 225 + 60);
  });

  it('handles an empty set', () => {
    expect(sumNetActualMinutes([])).toBe(0);
    expect(sumNetActualMinutes(undefined as any)).toBe(0);
  });
});

describe('budgetVariance', () => {
  it('is positive when the job ran over', () => {
    const v = budgetVariance(480, 600);
    expect(v.varianceMinutes).toBe(120);
    expect(v.variancePct).toBe(25);
    expect(v.overBudget).toBe(true);
  });

  it('is negative when the job came in under', () => {
    const v = budgetVariance(480, 360);
    expect(v.varianceMinutes).toBe(-120);
    expect(v.variancePct).toBe(-25);
    expect(v.overBudget).toBe(false);
  });

  it('distinguishes "no budget" from "on budget"', () => {
    // Jobs not created from an estimate carry no cost-engine rollup, so there
    // is nothing to compare against — that must not read as landing on target.
    const none = budgetVariance(null, 600);
    expect(none.varianceMinutes).toBeNull();
    expect(none.variancePct).toBeNull();
    expect(none.overBudget).toBe(false);

    const onTarget = budgetVariance(600, 600);
    expect(onTarget.varianceMinutes).toBe(0);
    expect(onTarget.variancePct).toBe(0);
  });

  it('returns a null percentage against a zero budget rather than dividing by zero', () => {
    const v = budgetVariance(0, 120);
    expect(v.varianceMinutes).toBe(120);
    expect(v.variancePct).toBeNull();
    expect(v.overBudget).toBe(true);
  });
});

describe('minutesToHours', () => {
  it('converts at the display boundary', () => {
    expect(minutesToHours(450)).toBe(7.5);
    expect(minutesToHours(4500)).toBe(75);
  });

  it('rounds to one decimal by default', () => {
    expect(minutesToHours(451)).toBe(7.5);
    expect(minutesToHours(455)).toBe(7.6);
  });

  it('honours an explicit precision', () => {
    expect(minutesToHours(455, 2)).toBe(7.58);
    expect(minutesToHours(450, 0)).toBe(8);
  });
});

describe('crewCapacityFromMemberHours', () => {
  const FOUR_DAY = [1, 2, 3, 4];
  const FIVE_DAY = [1, 2, 3, 4, 5];
  const m = (rep_id: string, billable_hours: number | null) => ({ rep_id, billable_hours });

  it('CAP-01 sums each member\'s own hours instead of multiplying a headcount', () => {
    // The bug this replaces. crewDailyCapacityMinutes(3, 450) says every crew of
    // three has the same week, whoever is on it — a 30-hour part-timer and a
    // full-time foreman counted identically. Avalon's board read a flat 90h for
    // every crew because that is literally all the old figure could say.
    const cap = crewCapacityFromMemberHours(
      [m('a', 1622), m('b', 1622), m('c', 1040)], FOUR_DAY, 450,
    );
    // 1622/52 = 31.19h/wk -> 1872 min; 1040/52 = 20h/wk -> 1200 min.
    expect(cap.weekly_minutes).toBe(1872 + 1872 + 1200);
    expect(cap.source).toBe('profile');
    expect(cap.fallback_members).toEqual([]);
    // Two identical crews of three are no longer forced to the same number.
    const other = crewCapacityFromMemberHours([m('d', 1622), m('e', 1622), m('f', 1622)], FOUR_DAY, 450);
    expect(other.weekly_minutes).not.toBe(cap.weekly_minutes);
  });

  it('CAP-02 spreads the week across the configured working days', () => {
    // "the weeks set in work week based on start and stop, days" — a four-day
    // company works the same hours in fewer, longer days. The WEEK is what the
    // employee profile states; the day is the week divided by how many days
    // are worked, not an independent constant.
    const four = crewCapacityFromMemberHours([m('a', 1622)], FOUR_DAY, 450);
    const five = crewCapacityFromMemberHours([m('a', 1622)], FIVE_DAY, 450);
    expect(four.weekly_minutes).toBe(five.weekly_minutes);
    expect(four.daily_minutes).toBeGreaterThan(five.daily_minutes);
    expect(four.daily_minutes).toBe(Math.round(four.weekly_minutes / 4));
  });

  it('CAP-03 falls back to the company day for anyone with no profile, and NAMES them', () => {
    // Same rule as allocation_run's `unrated`: a person with no rate is not
    // free, and a person with no hours profile is not a zero-hour worker.
    // Silently treating them as either understates or overstates the crew, and
    // the scheduler cannot tell which without being told who.
    const cap = crewCapacityFromMemberHours([m('a', 1622), m('b', null)], FOUR_DAY, 450);
    expect(cap.fallback_members).toEqual(['b']);
    expect(cap.source).toBe('mixed');
    // b contributes a full company week: 450 x 4 days.
    expect(cap.weekly_minutes).toBe(1872 + 450 * 4);
  });

  it('CAP-04 says so when NOBODY on the crew has a profile', () => {
    // This is today's behaviour for every crew, and it must remain honest
    // rather than looking like a derived number.
    const cap = crewCapacityFromMemberHours([m('a', null), m('b', null)], FOUR_DAY, 450);
    expect(cap.source).toBe('default');
    expect(cap.fallback_members).toEqual(['a', 'b']);
    expect(cap.weekly_minutes).toBe(2 * 450 * 4);
    // Identical to what the old headcount formula produced, so nothing regresses
    // for a company that has not filled in a single employee profile.
    expect(cap.weekly_minutes).toBe(crewWeeklyCapacityMinutes(2, 450, FOUR_DAY));
  });

  it('CAP-05 an empty crew has no capacity, and that is an answer not an error', () => {
    const cap = crewCapacityFromMemberHours([], FOUR_DAY, 450);
    expect(cap.weekly_minutes).toBe(0);
    expect(cap.daily_minutes).toBe(0);
    expect(cap.source).toBe('default');
  });

  it('CAP-06 treats a nonsense hours figure as no profile rather than as fact', () => {
    // computeBurden substitutes billable = 1 when a profile is misconfigured
    // (paid <= pto + shop + idle) so the rate does not divide by zero. One
    // billable hour a YEAR is not a schedulable week, and letting it through
    // would show a crew at several thousand percent and call it derived.
    for (const bad of [0, 1, -40, NaN, Infinity] as any[]) {
      const cap = crewCapacityFromMemberHours([m('a', bad)], FOUR_DAY, 450);
      expect(cap.fallback_members, String(bad)).toEqual(['a']);
      expect(cap.weekly_minutes, String(bad)).toBe(450 * 4);
    }
  });

  it('CAP-07 is integer minutes throughout', () => {
    // 1622/52 does not divide evenly; nothing downstream should ever receive a
    // fraction of a minute, for the same reason money is integer cents.
    const cap = crewCapacityFromMemberHours([m('a', 1622), m('b', 999)], [1, 2, 3], 450);
    expect(Number.isInteger(cap.weekly_minutes)).toBe(true);
    expect(Number.isInteger(cap.daily_minutes)).toBe(true);
  });
});

describe('distributeWeeklyCapacity', () => {
  it('CAP-08 the days sum to the week, exactly', () => {
    // The drift this exists to stop: the week view reports the week as the sum
    // of the days it shows, so a single rounded per-day figure loses minutes
    // every week, always downward.
    for (const [weekly, days] of [[3072, 5], [3070, 4], [1, 5], [0, 5], [4999, 3], [1872, 7]] as const) {
      const parts = distributeWeeklyCapacity(weekly, days);
      expect(parts).toHaveLength(days);
      expect(parts.reduce((a, b) => a + b, 0), `${weekly}/${days}`).toBe(weekly);
      expect(parts.every(Number.isInteger)).toBe(true);
    }
  });

  it('CAP-09 spreads the remainder rather than dumping it on one day', () => {
    // 3072 over 5 is 614.4: four days of 614 and one of 616 would be a lie
    // about Friday. Three days get the extra minute instead.
    expect(distributeWeeklyCapacity(3072, 5)).toEqual([615, 615, 614, 614, 614]);
    expect(Math.max(...distributeWeeklyCapacity(3072, 5)) - Math.min(...distributeWeeklyCapacity(3072, 5))).toBe(1);
  });

  it('CAP-10 a week with no working days is empty, not a division by zero', () => {
    expect(distributeWeeklyCapacity(3072, 0)).toEqual([]);
  });
});
