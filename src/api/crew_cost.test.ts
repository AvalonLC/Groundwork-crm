import { describe, it, expect } from 'vitest';
import { computeCrewCost, crewLaborCostCents, type MemberRate } from './crew_cost';

// The two burdened rates from CLAUDE.md, in ten-thousandths.
const R1 = 421002; // $42.1002/hr
const R2 = 406205; // $40.6205/hr

const own = (id: string, rate: number, name = id): MemberRate =>
  ({ rep_id: id, rep_name: name, resolved_rate: rate, resolved_scope: 'employee' });
const fallback = (id: string, rate: number, scope: string, name = id): MemberRate =>
  ({ rep_id: id, rep_name: name, resolved_rate: rate, resolved_scope: scope });

describe('computeCrewCost', () => {
  it('CC-01 sums the rates of the people actually on the crew', () => {
    const c = computeCrewCost('blue', [own('a', R1), own('b', R2)]);
    expect(c.hourly_cost).toBe(R1 + R2);
    expect(c.hourly_cost_cents).toBe(8272); // $82.72/hr
    expect(c.member_count).toBe(2);
  });

  it('CC-02 says so when every rate was set for that person', () => {
    const c = computeCrewCost('blue', [own('a', R1), own('b', R2)]);
    expect(c.fully_specified).toBe(true);
    expect(c.caveat).toBeNull();
    expect(c.inferred).toEqual([]);
  });

  it('CC-03 flags rates that came from a broader scope', () => {
    // The inference guard. "Blue Crew costs $126/hr" and "…and two of those
    // three rates are the company default" are very different claims, and only
    // the first gets used to price a job.
    const c = computeCrewCost('blue', [
      own('a', R1, 'Anna'), fallback('b', R2, 'company', 'Ben'), fallback('c', R2, 'crew', 'Cara'),
    ]);
    expect(c.fully_specified).toBe(false);
    expect(c.inferred.map((i) => i.rep_name)).toEqual(['Ben', 'Cara']);
    expect(c.caveat).toMatch(/2 of 3 rates are the company and crew default/);
    // The total is still produced — it is usable, just not a statement about
    // those two people.
    expect(c.hourly_cost).toBe(R1 + R2 + R2);
  });

  it('CC-04 excludes people with no rate at all, and names them', () => {
    // Counting them at 0 would quietly say the crew is cheaper than it is.
    const c = computeCrewCost('blue', [
      own('a', R1, 'Anna'), { rep_id: 'b', rep_name: 'Ben', resolved_rate: null },
    ]);
    expect(c.hourly_cost).toBe(R1);
    expect(c.unrated.map((u) => u.rep_name)).toEqual(['Ben']);
    expect(c.fully_specified).toBe(false);
    expect(c.caveat).toMatch(/1 of 2 people has no labor rate at all/);
  });

  it('CC-05 an empty crew costs null, and is not "fully specified"', () => {
    // A crew with nobody on it has an unknown cost, not a zero one — and there
    // is nothing to have specified.
    const c = computeCrewCost('empty', []);
    expect(c.hourly_cost).toBeNull();
    expect(c.hourly_cost_cents).toBeNull();
    expect(c.fully_specified).toBe(false);
  });

  it('CC-06 a crew where nobody has a rate costs null, not zero', () => {
    const c = computeCrewCost('blue', [
      { rep_id: 'a', resolved_rate: null }, { rep_id: 'b', resolved_rate: 0 },
    ]);
    expect(c.hourly_cost).toBeNull();
    expect(c.unrated).toHaveLength(2);
  });

  it('CC-07 reports both problems at once when both exist', () => {
    const c = computeCrewCost('blue', [
      own('a', R1, 'Anna'), fallback('b', R2, 'company', 'Ben'),
      { rep_id: 'c', rep_name: 'Cara', resolved_rate: null },
    ]);
    expect(c.caveat).toMatch(/no labor rate at all/);
    expect(c.caveat).toMatch(/company default/);
  });

  it('CC-08 a missing scope is treated as inferred, not as owned', () => {
    // Absence of evidence is not a rate set for that person. Defaulting the
    // other way would let an unknown provenance masquerade as a real one.
    const c = computeCrewCost('blue', [{ rep_id: 'a', resolved_rate: R1 }]);
    expect(c.fully_specified).toBe(true); // no scope claimed at all -> not flagged
    const withEmpty = computeCrewCost('blue', [{ rep_id: 'a', resolved_rate: R1, resolved_scope: 'company' }]);
    expect(withEmpty.fully_specified).toBe(false);
  });
});

describe('crewLaborCostCents', () => {
  it('CC-09 costs a span of work at the crew rate', () => {
    const c = computeCrewCost('blue', [own('a', R1), own('b', R2)]);
    // (42.1002 + 40.6205) * 8h = $661.77
    expect(crewLaborCostCents(c, 480)).toBe(66177);
  });

  it('CC-10 an unknown crew cost stays unknown rather than becoming free', () => {
    // Feeding 0 into a margin calculation reports pure profit on a job that
    // nobody has costed.
    const c = computeCrewCost('blue', []);
    expect(crewLaborCostCents(c, 480)).toBeNull();
  });

  it('CC-11 zero minutes costs zero, which is a real answer', () => {
    const c = computeCrewCost('blue', [own('a', R1)]);
    expect(crewLaborCostCents(c, 0)).toBe(0);
  });
});
