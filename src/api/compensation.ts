/**
 * Who may see what people are paid.
 *
 * One rule, in one place, applied server-side. Wages that reach the browser
 * have leaked whatever the CSS says — a field user can open devtools, and a
 * payload that carries the number has already told them. Same reasoning as
 * hidesMoney() in src/scheduling/api.ts, which strips job VALUE for field roles;
 * this strips what PEOPLE COST, which is a stricter question with a different
 * answer.
 *
 * The rule, from Tyler:
 *
 *   owners and admins        yes, by virtue of the role
 *   anyone with the flag     yes
 *   everyone else            no — crew and standard office roles included
 */

/** Roles that see compensation without needing the flag. */
const COMPENSATION_ROLES = ['admin', 'owner'];

/**
 * Access is derived from the role at read time and only falls back to the flag.
 *
 * Deliberately not backfilled onto admins as a stored 1: demoting someone from
 * admin to office_manager has to remove the access, and a stored flag would
 * silently keep it. The role is the live fact.
 */
export function canViewCompensation(
  rep: { role?: string | null; can_view_compensation?: number | boolean | null; is_super_admin?: number | boolean | null } | null | undefined,
): boolean {
  if (!rep) return false;
  if (rep.is_super_admin === 1 || rep.is_super_admin === true) return true;
  if (COMPENSATION_ROLES.includes(String(rep.role || '').toLowerCase())) return true;
  return rep.can_view_compensation === 1 || rep.can_view_compensation === true;
}

/** Fields that are compensation, wherever they appear. */
const COMPENSATION_FIELDS = [
  'wage_cents', 'wage', 'base_rate', 'hourly_rate', 'burdened_rate',
  'burdened_rate_cents', 'labor_cost_cents', 'labor_cost',
  'benefits_monthly_cents', 'comp_rate', 'tax_rate',
];

/**
 * Remove compensation from a payload, recursively.
 *
 * Deleted, not zeroed. A 0 wage is a claim — "this person is free" — that
 * something downstream will happily add up. Absence is the truth: the caller was
 * not told.
 */
export function stripCompensation<T>(payload: T, allowed: boolean): T {
  if (allowed || payload == null || typeof payload !== 'object') return payload;
  if (Array.isArray(payload)) return payload.map((v) => stripCompensation(v, allowed)) as unknown as T;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(payload as Record<string, unknown>)) {
    if (COMPENSATION_FIELDS.includes(k)) continue;
    out[k] = v && typeof v === 'object' ? stripCompensation(v, allowed) : v;
  }
  return out as T;
}

/**
 * The equipment double-count guard, as a function rather than a comment.
 *
 * CLAUDE.md calls this the most likely bug in the project, and the shape of it
 * is simple: support_equipment_annual is the old way of burying equipment cost
 * inside the labor rate. When the equipment engine is active it charges
 * equipment separately, so leaving that figure in the labor profile bills the
 * same machine twice.
 *
 *   engine off -> burdened rate 42.1002 (1.754x)
 *   engine on  -> burdened rate 40.6205 (1.693x)
 *
 * Test BH-13 asserts exactly that and is not to be modified. This refuses the
 * write that would break it, rather than letting a bad row in and failing a
 * fixture later.
 */
export function validateEquipmentSupport(
  supportEquipmentAnnualCents: number | null | undefined,
  equipmentEngineActive: boolean,
): { ok: true } | { ok: false; error: string } {
  const cents = Number(supportEquipmentAnnualCents || 0);
  if (equipmentEngineActive && cents !== 0) {
    return {
      ok: false,
      error:
        'support_equipment_annual_cents must be 0 while the equipment engine is active — ' +
        'the engine already charges equipment separately, and leaving it in the labor ' +
        'profile bills the same machine twice.',
    };
  }
  return { ok: true };
}
