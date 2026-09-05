/**
 * Who may do what to an invoice.
 *
 * Every route under /api/invoices was `requireAuth` and nothing else — any
 * authenticated rep of any role could create, edit, delete, send, record a
 * payment against, or charge a saved card on any invoice in their company. The
 * only thing in the way was a client-side nav check, which is a UI convenience,
 * not an authorization boundary: `curl` with a session cookie went straight
 * through.
 *
 * These ten routes are not one permission. They run from "look at a list" to
 * "take money off a customer's card", so a single blanket gate is either too
 * loose at the top or breaks working screens at the bottom. Two flows in
 * particular are reachable by field-facing roles today and must keep working:
 *
 *   estimates.js:2337 — a rep or estimator converting a won estimate, from four
 *   always-rendered buttons on a tab those roles have.
 *
 *   app_premium.js:6227 -> :6403 — the client-detail "+ Record Payment" button,
 *   on a tab those roles also have. It needs `read` and `record_payment`
 *   together, since it lists the client's invoices before opening the modal.
 *
 * A pure predicate rather than middleware, deliberately: the invoice routes are
 * registered inline on the top-level `app` in src/index.tsx, so the sub-router
 * harness in src/api/rates.test.ts (which swaps requireAuth on a mounted Hono)
 * cannot be reused. The in-house precedent for a permission that is unit-
 * testable without HTTP is canViewCompensation in src/api/compensation.ts.
 */

export const INVOICE_CAPABILITIES = [
  'read',
  'create_from_estimate',
  'record_payment',
  'manage',
  'issue',
  'charge_card',
] as const;

export type InvoiceCapability = (typeof INVOICE_CAPABILITIES)[number];

/**
 * Roles are listed per capability rather than capabilities per role, so adding
 * a route means answering one question — who may do this — instead of editing
 * every role's entry and hoping none were missed.
 *
 * `reps.role` is free-text TEXT with no CHECK constraint (0001_initial_schema),
 * so anything not named here is denied. Failing closed is the point: a tenant
 * inventing a custom role must not silently acquire the ability to charge cards.
 */
const ALLOWED: Record<InvoiceCapability, readonly string[]> = {
  // Reads feed screens field-facing roles legitimately use: the client-detail
  // invoice section, the email composer's document picker, and the
  // record-payment picker. Denying them yields a silently empty list, not an
  // error the user can act on.
  read: ['admin', 'owner', 'office_manager', 'estimator', 'rep'],

  // The rep estimate-conversion flow.
  create_from_estimate: ['admin', 'owner', 'office_manager', 'estimator', 'rep'],

  // Logging an offline payment (cash/cheque) taken in the field. Note this does
  // move amount_paid_cents and can flip an invoice to paid — it is a real
  // financial control, kept open to reps because the client-detail button that
  // drives it is on a screen they have. If that is ever narrowed, the button at
  // app_premium.js:6227 has to be hidden in the same change or reps are left
  // with a control that only produces a 403.
  record_payment: ['admin', 'owner', 'office_manager', 'estimator', 'rep'],

  // Create, edit, delete. Only ever driven from the invoices tab, which is
  // admin/office_manager by default.
  manage: ['admin', 'owner', 'office_manager'],

  // Sending. As privileged as charging, and easy to misread as "just email":
  // POST /:id/send contains the autopay branch (src/index.tsx:9399), so sending
  // an invoice can take money off a saved card.
  issue: ['admin', 'owner', 'office_manager'],

  // Charging a card on file. The tightest gate; one caller, invoices.js:743.
  charge_card: ['admin', 'owner', 'office_manager'],
};

/**
 * `owner` appears above alongside `admin` because the codebase already treats
 * it as an admin synonym (src/index.tsx:11234, app_premium.js:3334) even though
 * no migration seeds it.
 */
export function canInvoice(
  role: string | null | undefined,
  capability: InvoiceCapability,
  opts: { isSuperAdmin?: boolean } = {},
): boolean {
  // Matches requireSuperAdmin (src/index.tsx:780) and the gate at :1050. The
  // client uses a narrower rule (is_super_admin AND company_id ===
  // 'groundwork_platform'); the server being broader is intentional, since
  // c.var.isSuperAdmin is already the trusted server-side signal.
  if (opts.isSuperAdmin) return true;

  const allowed = ALLOWED[capability];
  if (!allowed) return false; // unknown capability: deny, never default open

  const normalised = String(role ?? '').trim().toLowerCase();
  if (!normalised) return false;

  return allowed.includes(normalised);
}
