/**
 * See docs/spec/ROLES.md. Only "crew" is grounded in direct evidence
 * (CLAUDE.md: "Crew role: never render margin, wage, or rate fields.").
 * The other three role names and their exact boundaries are inferred —
 * documented as a guess in docs/spec/ROLES.md, not a confirmed contract.
 */
export type Role = "crew" | "crew_lead" | "office" | "owner";

export interface RolePermissions {
  can_see_margin: boolean;
  can_see_wage: boolean;
  can_see_rate: boolean;
  can_see_recovery: boolean;
  can_see_budget_rates: boolean;
  can_manage_receipts: boolean;
  /** Item 4 Stage 2 PR D. Create/edit/submit/void a draft or pending change
   * order, and resolve a needs_review budget-version flag — the same
   * "office can operate day-to-day finance workflows" tier as
   * can_manage_receipts, deliberately reused rather than duplicated for
   * every new workflow. Inferred (not confirmed by Tyler), same status as
   * can_manage_receipts itself — documented here per ROLES.md's existing
   * precedent for inferred boundaries rather than stopping to ask. */
  can_manage_change_orders: boolean;
  /** Approving or rejecting a change order is a stronger financial-control
   * action than creating one: it's the one step that's irreversible
   * (approved is immutable) and atomically creates a new, equally immutable
   * job_budget_versions row. The mandate's "only authorized roles can
   * approve or reject" reads as a narrower gate than "can operate the
   * workflow at all" — modeled here as owner-only, mirroring
   * can_see_budget_rates' existing owner-only precedent in this same table,
   * rather than reusing can_manage_change_orders for approval too. */
  can_approve_change_orders: boolean;
}

/** Field names chosen to match exactly what CLAUDE.md forbids for crew:
 * "never render margin, wage, or rate fields." */
export const ROLE_PERMISSIONS: Record<Role, RolePermissions> = {
  crew: {
    can_see_margin: false, can_see_wage: false, can_see_rate: false,
    can_see_recovery: false, can_see_budget_rates: false, can_manage_receipts: false,
    can_manage_change_orders: false, can_approve_change_orders: false,
  },
  crew_lead: {
    can_see_margin: false, can_see_wage: false, can_see_rate: false,
    can_see_recovery: false, can_see_budget_rates: false, can_manage_receipts: false,
    can_manage_change_orders: false, can_approve_change_orders: false,
  },
  office: {
    can_see_margin: true, can_see_wage: true, can_see_rate: true,
    can_see_recovery: true, can_see_budget_rates: false, can_manage_receipts: true,
    can_manage_change_orders: true, can_approve_change_orders: false,
  },
  owner: {
    can_see_margin: true, can_see_wage: true, can_see_rate: true,
    can_see_recovery: true, can_see_budget_rates: true, can_manage_receipts: true,
    can_manage_change_orders: true, can_approve_change_orders: true,
  },
};

export function canSee(role: Role, field: keyof RolePermissions): boolean {
  return ROLE_PERMISSIONS[role][field];
}

/** The one rule every UI task in Wave 4 must respect (gate_must_include:
 * "crew-cannot-see-margin"). Centralized here so every page calls this
 * instead of re-deriving crew's restrictions independently. */
export function assertCrewCannotSee(role: Role, field: "can_see_margin" | "can_see_wage" | "can_see_rate"): boolean {
  if (role !== "crew") return true;
  return ROLE_PERMISSIONS.crew[field] === false;
}
