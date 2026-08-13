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
