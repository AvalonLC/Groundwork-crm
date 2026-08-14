import { describe, it, expect } from 'vitest';
import { canViewCompensation, stripCompensation, validateEquipmentSupport } from './compensation';

/**
 * The rule Tyler set: office staff see compensation only if granted
 * can_view_compensation. Owners and admins by default; crew and standard office
 * roles not.
 */
describe('canViewCompensation', () => {
  it('CV-01 admins and owners see it without the flag', () => {
    expect(canViewCompensation({ role: 'admin' })).toBe(true);
    expect(canViewCompensation({ role: 'owner' })).toBe(true);
    expect(canViewCompensation({ role: 'ADMIN' })).toBe(true); // role strings drift in this schema
  });

  it('CV-02 standard office roles do NOT see it by default', () => {
    // The decision that makes this a permission rather than a role check:
    // office_manager runs the schedule and the invoices and still has no
    // business seeing what the crew is paid unless someone says so.
    expect(canViewCompensation({ role: 'office_manager' })).toBe(false);
    expect(canViewCompensation({ role: 'division_manager' })).toBe(false);
    expect(canViewCompensation({ role: 'rep' })).toBe(false);
  });

  it('CV-03 crew roles never see it by default', () => {
    for (const role of ['foreman', 'laborer', 'mechanic', 'field_supervisor']) {
      expect(canViewCompensation({ role })).toBe(false);
    }
  });

  it('CV-04 the flag grants it to anyone who is given it', () => {
    expect(canViewCompensation({ role: 'office_manager', can_view_compensation: 1 })).toBe(true);
    expect(canViewCompensation({ role: 'foreman', can_view_compensation: true })).toBe(true);
  });

  it('CV-05 access follows the ROLE, so a demotion removes it', () => {
    // Why admins are not backfilled to can_view_compensation = 1 in migration
    // 0074: a stored flag would survive the demotion and silently keep access.
    const wasAdmin = { role: 'office_manager', can_view_compensation: 0 };
    expect(canViewCompensation(wasAdmin)).toBe(false);
  });

  it('CV-06 a missing rep is not permission to see anything', () => {
    expect(canViewCompensation(null)).toBe(false);
    expect(canViewCompensation(undefined)).toBe(false);
    expect(canViewCompensation({})).toBe(false);
  });
});

describe('stripCompensation', () => {
  const payload = {
    rep_id: 'r1', name: 'Mike', wage_cents: 2400, burdened_rate: 421002,
    crew: { name: 'Blue', base_rate: 24, members: [{ id: 'r2', wage_cents: 2200 }] },
    planned_minutes: 480,
  };

  it('CV-07 removes wages, and everything nested under them', () => {
    const out = stripCompensation(payload, false) as any;
    expect(out.wage_cents).toBeUndefined();
    expect(out.burdened_rate).toBeUndefined();
    expect(out.crew.base_rate).toBeUndefined();
    expect(out.crew.members[0].wage_cents).toBeUndefined();
  });

  it('CV-08 keeps everything that is not compensation', () => {
    const out = stripCompensation(payload, false) as any;
    expect(out.name).toBe('Mike');
    expect(out.planned_minutes).toBe(480);
    expect(out.crew.name).toBe('Blue');
    expect(out.crew.members[0].id).toBe('r2');
  });

  it('CV-09 DELETES rather than zeroing', () => {
    // A 0 wage is a claim — "this person is free" — and something downstream
    // will add it up. Absence is the truth: the caller was not told.
    const out = stripCompensation(payload, false) as any;
    expect('wage_cents' in out).toBe(false);
    expect(out.wage_cents).not.toBe(0);
  });

  it('CV-10 passes the payload straight through when allowed', () => {
    expect(stripCompensation(payload, true)).toEqual(payload);
  });

  it('CV-11 survives arrays, nulls and primitives', () => {
    expect(stripCompensation([{ wage_cents: 1 }, { name: 'x' }], false)).toEqual([{}, { name: 'x' }]);
    expect(stripCompensation(null, false)).toBeNull();
    expect(stripCompensation('plain', false)).toBe('plain');
  });
});

describe('validateEquipmentSupport', () => {
  it('CV-12 refuses equipment support in the labor profile while the engine is on', () => {
    // CLAUDE.md calls this the most likely bug in the project. The engine
    // charges equipment separately, so leaving the figure in the labor profile
    // bills the same machine twice — 42.1002 instead of 40.6205. BH-13 asserts
    // exactly that, and this refuses the write rather than failing a fixture later.
    const out = validateEquipmentSupport(500000, true);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toMatch(/bills the same machine twice/);
  });

  it('CV-13 allows 0 while the engine is on', () => {
    expect(validateEquipmentSupport(0, true).ok).toBe(true);
    expect(validateEquipmentSupport(null, true).ok).toBe(true);
    expect(validateEquipmentSupport(undefined, true).ok).toBe(true);
  });

  it('CV-14 allows a real figure while the engine is OFF', () => {
    // Engine off is the legacy model, where equipment cost genuinely does live
    // inside the labor rate. Refusing it there would break the other fixture.
    expect(validateEquipmentSupport(500000, false).ok).toBe(true);
  });
});
