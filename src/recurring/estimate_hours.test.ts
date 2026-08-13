import { describe, it, expect } from 'vitest';
import { recurringHoursFromServices, hoursPerVisitFromRecurringData } from './estimate_hours';

/**
 * The bug these cover: estimate -> work-order conversion read
 * cost_data.rollup.budgeted_hours, which a recurring estimate never writes, so
 * recurring jobs converted with zero budget hours. The tempting fix — reading
 * recurring_data.rollup.yearly_hours instead — is worse, and the first test
 * below pins the distinction so nobody "simplifies" it back.
 */
describe('recurringHoursFromServices', () => {
  it('returns per-visit hours, not the yearly total', () => {
    // A weekly two-hour mow: 52 visits a year, 104 man-hours a year.
    const r = recurringHoursFromServices([{ name: 'Mow', occurrences: 52, man_hours: 2 }]);
    expect(r.yearlyHours).toBe(104);
    expect(r.visitsPerYear).toBe(52);
    // The number that goes on ONE work order is 2 — the length of one visit.
    // If this ever reads 104, a single mow is claiming thirteen working days.
    expect(r.hoursPerVisit).toBe(2);
  });

  it('weights the average by how often each service actually happens', () => {
    // 30 mows at 2h + 4 fertilisations at 1h = 64h over 34 visits.
    // A plain mean of the two man_hours values would give 1.5, which under-reads
    // every visit because it treats four fertilisations as equal in weight to
    // thirty mows.
    const r = recurringHoursFromServices([
      { name: 'Mow', occurrences: 30, man_hours: 2 },
      { name: 'Fertilise', occurrences: 4, man_hours: 1 },
    ]);
    expect(r.yearlyHours).toBe(64);
    expect(r.visitsPerYear).toBe(34);
    expect(r.hoursPerVisit).toBe(1.88); // 64/34 = 1.882..., rounded to cents-of-an-hour
  });

  it('is null, not 0, when the hours are unknowable', () => {
    // Zero would be a claim that a visit takes no time, and would flow into
    // work_orders.duration_hours as a real budget. Null lets the caller leave
    // the column NULL, which is what "we never costed this" should look like.
    expect(recurringHoursFromServices([]).hoursPerVisit).toBeNull();
    expect(recurringHoursFromServices(null).hoursPerVisit).toBeNull();
    expect(recurringHoursFromServices([{ occurrences: 12, man_hours: 0 }]).hoursPerVisit).toBeNull();
    expect(recurringHoursFromServices([{ occurrences: 0, man_hours: 3 }]).hoursPerVisit).toBeNull();
  });

  it('ignores junk values rather than propagating NaN', () => {
    // These come out of a JSON blob a browser wrote, so the types are whatever
    // the client last put there. A single NaN here would make budgetHours NaN
    // and the INSERT would store it as NULL or throw depending on the driver.
    const r = recurringHoursFromServices([
      { occurrences: 'twelve' as never, man_hours: 2 },
      { occurrences: 10, man_hours: null },
      { occurrences: -5 as never, man_hours: 4 },
      { occurrences: 10, man_hours: 3 },
    ]);
    expect(Number.isFinite(r.hoursPerVisit as number)).toBe(true);
    expect(r.visitsPerYear).toBe(20); // the two valid occurrence counts
    expect(r.yearlyHours).toBe(30); // only the last line contributes hours
    expect(r.hoursPerVisit).toBe(1.5);
  });
});

describe('hoursPerVisitFromRecurringData', () => {
  it('reads the service lines out of the stored JSON string', () => {
    const stored = JSON.stringify({
      services: [{ name: 'Irrigation check', occurrences: 12, man_hours: 1.5 }],
      // A rollup written by an older client is deliberately NOT consulted: it
      // carries yearly_hours, and trusting it is the exact mistake this avoids.
      rollup: { yearly_hours: 18, yearly_cost: 900 },
    });
    expect(hoursPerVisitFromRecurringData(stored)).toBe(1.5);
  });

  it('accepts an already-parsed object as well as a string', () => {
    expect(hoursPerVisitFromRecurringData({ services: [{ occurrences: 4, man_hours: 6 }] })).toBe(6);
  });

  it('returns null on malformed JSON instead of throwing', () => {
    // json_extract raises on malformed JSON and so does JSON.parse; the
    // conversion endpoint must survive a corrupt blob, because failing here
    // would block the user from converting an estimate at all.
    expect(hoursPerVisitFromRecurringData('{"services": [')).toBeNull();
    expect(hoursPerVisitFromRecurringData('')).toBeNull();
    expect(hoursPerVisitFromRecurringData(null)).toBeNull();
    expect(hoursPerVisitFromRecurringData(undefined)).toBeNull();
  });

  it('returns null for a one-off estimate that has no recurring_data', () => {
    // doc_type gates this in the handler, but the guard belongs here too: an
    // empty blob must not become 0 hours on a job that had real cost_data.
    expect(hoursPerVisitFromRecurringData('{}')).toBeNull();
  });
});
