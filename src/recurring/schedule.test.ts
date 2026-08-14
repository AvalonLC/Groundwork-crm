import { describe, it, expect } from 'vitest';
import { cadenceDays, planVisits, visitId, addDays, daysBetween, withinWorkOrderHorizon } from './schedule';

const TODAY = '2026-08-17'; // a Monday
const YEAR_OUT = '2027-08-17';

describe('cadenceDays', () => {
  it('GEN-01 an explicit frequency_days beats the named bucket', () => {
    // "Every 10 days" is a real thing a landscaper says and no named bucket
    // expresses it.
    expect(cadenceDays({ frequency: 'weekly', frequency_days: 10 })).toBe(10);
  });

  it('GEN-02 falls back to the named cadence, then to monthly', () => {
    expect(cadenceDays({ frequency: 'weekly' })).toBe(7);
    expect(cadenceDays({ frequency: 'Biweekly' })).toBe(14);
    expect(cadenceDays({ frequency: 'nonsense' })).toBe(30);
    expect(cadenceDays({})).toBe(30);
  });

  it('GEN-03 never returns 0, whatever it is given', () => {
    // A zero interval makes the generator emit the same date forever. The guard
    // in planVisits would stop it, but only after 400 identical rows.
    expect(cadenceDays({ frequency_days: 0 })).toBe(30);
    expect(cadenceDays({ frequency_days: -7 })).toBe(30);
    expect(cadenceDays({ frequency_days: 'abc' as never })).toBe(30);
  });
});

describe('planVisits', () => {
  const base = { from: TODAY, notBefore: TODAY, through: YEAR_OUT, cadence: 7 };

  it('GEN-04 lays a weekly subscription out on the right days', () => {
    const v = planVisits({ ...base, max: 5 });
    expect(v.map((x) => x.date)).toEqual([
      '2026-08-17', '2026-08-24', '2026-08-31', '2026-09-07', '2026-09-14',
    ]);
    expect(v[4].sequence).toBe(5);
  });

  it('GEN-05 a year of weekly visits is about 52, not thousands', () => {
    // The sanity check on the horizon itself. If this ever returns 3,000 the
    // two-tier design has been undone somewhere.
    const v = planVisits(base);
    expect(v.length).toBeGreaterThan(50);
    expect(v.length).toBeLessThan(55);
  });

  it('GEN-06 stops at the subscription end date', () => {
    const v = planVisits({ ...base, endDate: '2026-09-07' });
    expect(v.map((x) => x.date)).toEqual(['2026-08-17', '2026-08-24', '2026-08-31', '2026-09-07']);
  });

  it('GEN-07 never starts before the subscription does', () => {
    const v = planVisits({ ...base, from: '2026-08-01', startDate: '2026-09-01', notBefore: '2026-08-01', max: 3 });
    expect(v[0].date).toBe('2026-09-01');
  });

  it('GEN-08 catches a stale cursor up to today, keeping the rhythm', () => {
    // The common case: a client pauses over winter and nobody touches the
    // record until spring. next_visit_date is months behind.
    //
    // Resetting the cursor to today would be easy and wrong — it silently
    // re-phases every visit for the rest of the year. Advancing in whole
    // cadence steps keeps the client's Monday a Monday.
    const v = planVisits({ from: '2026-03-02', notBefore: TODAY, through: YEAR_OUT, cadence: 7, max: 3 });
    expect(v[0].date).toBe('2026-08-17');
    expect(daysBetween('2026-03-02', v[0].date) % 7).toBe(0); // same day of the week
  });

  it('GEN-09 generates no back-dated work for a long-lapsed subscription', () => {
    // Not one visit before today. A generator that fills in the past creates
    // work nobody did and invoices nobody agreed to.
    const v = planVisits({ from: '2024-01-01', notBefore: TODAY, through: YEAR_OUT, cadence: 30 });
    expect(v.every((x) => daysBetween(TODAY, x.date) >= 0)).toBe(true);
  });

  it('GEN-10 an already-ended subscription generates nothing at all', () => {
    expect(planVisits({ ...base, endDate: '2025-01-01' })).toEqual([]);
  });

  it('GEN-11 is bounded even if the cadence is absurd', () => {
    const v = planVisits({ ...base, cadence: 1, through: '2099-01-01' });
    expect(v.length).toBeLessThanOrEqual(400);
  });

  it('GEN-12 handles a monthly cadence across a leap day without drifting', () => {
    const v = planVisits({ from: '2028-01-31', notBefore: '2028-01-31', through: '2028-06-01', cadence: 30, max: 4 });
    expect(v.map((x) => x.date)).toEqual(['2028-01-31', '2028-03-01', '2028-03-31', '2028-04-30']);
  });
});

describe('visitId', () => {
  it('GEN-13 is deterministic, so re-running generates the same ids', () => {
    // This is what makes the whole thing safe to re-run: two identical runs
    // collide at the database rather than in application logic.
    expect(visitId('cps_abc', '2026-08-17')).toBe(visitId('cps_abc', '2026-08-17'));
    expect(visitId('cps_abc', '2026-08-17')).not.toBe(visitId('cps_abc', '2026-08-24'));
    expect(visitId('cps_abc', '2026-08-17')).not.toBe(visitId('cps_xyz', '2026-08-17'));
  });
});

describe('withinWorkOrderHorizon', () => {
  it('GEN-14 only near visits become work orders', () => {
    expect(withinWorkOrderHorizon('2026-08-17', TODAY, 28)).toBe(true);
    expect(withinWorkOrderHorizon('2026-09-14', TODAY, 28)).toBe(true);   // day 28
    expect(withinWorkOrderHorizon('2026-09-15', TODAY, 28)).toBe(false);  // day 29
  });

  it('GEN-15 a visit in the past is outside the horizon, not inside it', () => {
    // >= 0 rather than a bare magnitude: yesterday is 1 day away and must not
    // qualify, or a missed visit would grow a work order every time the
    // generator runs.
    expect(withinWorkOrderHorizon('2026-08-16', TODAY, 28)).toBe(false);
  });
});

describe('addDays / daysBetween', () => {
  it('GEN-16 are calendar arithmetic, and inverse to each other', () => {
    expect(addDays('2026-08-17', 7)).toBe('2026-08-24');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29'); // leap year
    expect(daysBetween('2026-08-17', addDays('2026-08-17', 45))).toBe(45);
  });

  it('GEN-17 return empty/zero on junk rather than NaN dates', () => {
    expect(addDays('not a date', 1)).toBe('');
    expect(daysBetween('nope', '2026-08-17')).toBe(0);
  });
});
