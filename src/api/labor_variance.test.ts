import { describe, it, expect } from 'vitest';
import { computeLaborVariance, shouldLockRate } from './labor_variance';

// $42.1002/hr and $40.6205/hr — the two burdened rates from CLAUDE.md, in
// ten-thousandths. Using the project's own figures rather than round numbers
// keeps the arithmetic honest about its rounding.
const RATE_OLD = 421002;
const RATE_NEW = 406205;

describe('computeLaborVariance', () => {
  it('LV-01 sold uses the FROZEN rate and cost uses the current one', () => {
    // The rule in one assertion. Eight hours sold at the old rate stays sold at
    // the old rate forever; what it costs today is a separate number.
    const v = computeLaborVariance({ lockedRate: RATE_OLD, currentRate: RATE_NEW, minutes: 480 });
    expect(v.sold_cents).toBe(33680);   // 42.1002 * 8h
    expect(v.cost_cents).toBe(32496);   // 40.6205 * 8h
    expect(v.variance_cents).toBe(-1184); // costs less than sold
    expect(v.reason).toBeNull();
  });

  it('LV-02 a positive variance means the job costs MORE than it was sold for', () => {
    // The direction matters — this is the number someone acts on.
    const v = computeLaborVariance({ lockedRate: RATE_NEW, currentRate: RATE_OLD, minutes: 480 });
    expect(v.variance_cents).toBeGreaterThan(0);
    expect(v.variance_pct).toBeGreaterThan(0);
  });

  it('LV-03 reports the variance as a percentage of what was sold', () => {
    const v = computeLaborVariance({ lockedRate: 400000, currentRate: 440000, minutes: 600 });
    expect(v.sold_cents).toBe(40000);
    expect(v.cost_cents).toBe(44000);
    expect(v.variance_pct).toBe(10);
  });

  it('LV-04 an unlocked estimate reports cost but NOT a variance', () => {
    // Everything created before this mechanism existed. Reporting variance as 0
    // would claim the job is exactly on target, which is a stronger statement
    // than "we never recorded what it was sold at".
    const v = computeLaborVariance({ lockedRate: null, currentRate: RATE_NEW, minutes: 480 });
    expect(v.cost_cents).toBe(32496);
    expect(v.sold_cents).toBeNull();
    expect(v.variance_cents).toBeNull();
    expect(v.reason).toMatch(/never locked one|nothing to compare/);
  });

  it('LV-05 no current rate means the real cost is unknown, and says so', () => {
    const v = computeLaborVariance({ lockedRate: RATE_OLD, currentRate: null, minutes: 480 });
    expect(v.sold_cents).toBe(33680);
    expect(v.cost_cents).toBeNull();
    expect(v.reason).toMatch(/No current labor rate/);
  });

  it('LV-06 every null carries a reason', () => {
    // So a caller never has to guess whether a figure is zero or absent — the
    // same distinction utilizationPct and budgetVariance already keep.
    for (const input of [
      { lockedRate: null, currentRate: null, minutes: 480 },
      { lockedRate: RATE_OLD, currentRate: RATE_NEW, minutes: 0 },
      { lockedRate: null, currentRate: RATE_NEW, minutes: 480 },
    ]) {
      const v = computeLaborVariance(input);
      if (v.variance_cents === null) expect(v.reason).toBeTruthy();
    }
  });

  it('LV-07 zero minutes is "nothing yet", not "on budget"', () => {
    const v = computeLaborVariance({ lockedRate: RATE_OLD, currentRate: RATE_NEW, minutes: 0 });
    expect(v.variance_cents).toBeNull();
    expect(v.reason).toMatch(/No labor recorded/);
  });

  it('LV-08 rounds to whole cents once, not at every step', () => {
    // Three chained divisions would each round and the error would compound
    // across a season of jobs.
    const v = computeLaborVariance({ lockedRate: 333333, currentRate: 333333, minutes: 7 });
    expect(Number.isInteger(v.sold_cents)).toBe(true);
    expect(v.variance_cents).toBe(0); // identical rates cannot drift apart
  });

  it('LV-09 junk rates are treated as absent rather than as zero', () => {
    const v = computeLaborVariance({ lockedRate: -5, currentRate: NaN, minutes: 480 });
    expect(v.sold_cents).toBeNull();
    expect(v.cost_cents).toBeNull();
    expect(v.reason).toBeTruthy();
  });
});

describe('shouldLockRate', () => {
  it('LV-10 locks when the estimate reaches the customer', () => {
    for (const status of ['sent', 'accepted', 'approved', 'invoiced']) {
      expect(shouldLockRate(status, null)).toBe(true);
    }
  });

  it('LV-11 does not lock a draft', () => {
    // A draft is still being priced and should follow current rates. New and
    // revised estimates use the updated rates — Tyler's rule.
    expect(shouldLockRate('draft', null)).toBe(false);
    expect(shouldLockRate('changes_requested', null)).toBe(false);
    expect(shouldLockRate('declined', null)).toBe(false);
  });

  it('LV-12 NEVER re-locks an estimate that already has a rate', () => {
    // The subtle one. Re-sending an estimate must not re-lock it at today's
    // rate — that is silent recalculation of customer pricing wearing a
    // different hat, and it is exactly what the rule forbids.
    expect(shouldLockRate('sent', 421002)).toBe(false);
    expect(shouldLockRate('accepted', 421002)).toBe(false);
  });

  it('LV-13 a zero or null stored rate is not a lock', () => {
    expect(shouldLockRate('sent', 0)).toBe(true);
    expect(shouldLockRate('sent', null)).toBe(true);
  });
});
