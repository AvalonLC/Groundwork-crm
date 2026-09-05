import { describe, it, expect } from 'vitest';
import { canInvoice, INVOICE_CAPABILITIES, type InvoiceCapability } from './invoice-access';

/**
 * Every route under /api/invoices was requireAuth-only — no role check at all.
 * Any authenticated rep of any role could create, edit, delete, send, record a
 * payment against, or CHARGE A SAVED CARD on any invoice in their company. The
 * only thing in the way was a client-side nav gate.
 *
 * The matrix is asserted cell by cell rather than by spot-checking the
 * interesting cases: a permission table that is only partially covered is one
 * where a future edit can widen a gate without any test turning red.
 */

const ROLES = [
  'admin', 'office_manager', 'estimator', 'rep',
  'foreman', 'field_supervisor', 'laborer', 'mechanic',
  'division_manager', 'view_only', 'unknown_custom_role', '',
] as const;

// Read across: read, from_estimate, record_payment, manage, issue, charge_card
const EXPECTED: Record<string, Record<InvoiceCapability, boolean>> = {
  admin:               { read: true,  create_from_estimate: true,  record_payment: true,  manage: true,  issue: true,  charge_card: true  },
  office_manager:      { read: true,  create_from_estimate: true,  record_payment: true,  manage: true,  issue: true,  charge_card: true  },
  // Estimator and rep convert their own won estimates and record payments from
  // the client-detail screen. They do not create, edit, delete, send or charge.
  estimator:           { read: true,  create_from_estimate: true,  record_payment: true,  manage: false, issue: false, charge_card: false },
  rep:                 { read: true,  create_from_estimate: true,  record_payment: true,  manage: false, issue: false, charge_card: false },
  foreman:             { read: false, create_from_estimate: false, record_payment: false, manage: false, issue: false, charge_card: false },
  field_supervisor:    { read: false, create_from_estimate: false, record_payment: false, manage: false, issue: false, charge_card: false },
  laborer:             { read: false, create_from_estimate: false, record_payment: false, manage: false, issue: false, charge_card: false },
  mechanic:            { read: false, create_from_estimate: false, record_payment: false, manage: false, issue: false, charge_card: false },
  division_manager:    { read: false, create_from_estimate: false, record_payment: false, manage: false, issue: false, charge_card: false },
  view_only:           { read: false, create_from_estimate: false, record_payment: false, manage: false, issue: false, charge_card: false },
  unknown_custom_role: { read: false, create_from_estimate: false, record_payment: false, manage: false, issue: false, charge_card: false },
  '':                  { read: false, create_from_estimate: false, record_payment: false, manage: false, issue: false, charge_card: false },
};

describe('canInvoice — the full role x capability matrix', () => {
  for (const role of ROLES) {
    for (const cap of INVOICE_CAPABILITIES) {
      const want = EXPECTED[role][cap];
      it(`IA-${role || 'empty'}/${cap} -> ${want}`, () => {
        expect(canInvoice(role, cap)).toBe(want);
      });
    }
  }
});

describe('canInvoice — the cases that motivated the design', () => {
  it('IX-01 a rep can still convert an estimate to an invoice', () => {
    // estimates.js:2337, from four always-rendered buttons on a tab reps have.
    // Excluding them kills the flow on a button that stays visible and clickable.
    expect(canInvoice('rep', 'create_from_estimate')).toBe(true);
    expect(canInvoice('estimator', 'create_from_estimate')).toBe(true);
  });

  it('IX-02 a rep can still record a payment from the client detail screen', () => {
    // app_premium.js:6227 -> :6403 lists the client's invoices, then opens the
    // record-payment modal. Needs read AND record_payment together.
    expect(canInvoice('rep', 'read')).toBe(true);
    expect(canInvoice('rep', 'record_payment')).toBe(true);
  });

  it('IX-03 a rep can never charge a saved card', () => {
    expect(canInvoice('rep', 'charge_card')).toBe(false);
    expect(canInvoice('estimator', 'charge_card')).toBe(false);
  });

  it('IX-04 sending is as privileged as charging, because sending can charge', () => {
    // POST /:id/send contains the autopay branch (src/index.tsx:9399) — it can
    // take money off a saved card. It is not "just email".
    for (const role of ['rep', 'estimator', 'foreman', 'view_only']) {
      expect(canInvoice(role, 'issue')).toBe(false);
    }
    expect(canInvoice('admin', 'issue')).toBe(true);
    expect(canInvoice('office_manager', 'issue')).toBe(true);
  });

  it('IX-05 a field role gets nothing at all', () => {
    for (const cap of INVOICE_CAPABILITIES) {
      expect(canInvoice('laborer', cap)).toBe(false);
      expect(canInvoice('foreman', cap)).toBe(false);
    }
  });

  it('IX-06 an unrecognised or missing role is denied, never defaulted open', () => {
    for (const cap of INVOICE_CAPABILITIES) {
      expect(canInvoice('brand_new_custom_role', cap)).toBe(false);
      expect(canInvoice(undefined as any, cap)).toBe(false);
      expect(canInvoice(null as any, cap)).toBe(false);
    }
  });

  it('IX-07 role matching tolerates casing and surrounding whitespace', () => {
    // reps.role is free-text TEXT with no CHECK constraint (0001_initial_schema).
    expect(canInvoice(' Admin ', 'charge_card')).toBe(true);
    expect(canInvoice('OFFICE_MANAGER', 'manage')).toBe(true);
  });

  it('IX-08 owner is honoured as an admin synonym', () => {
    // Used as one at src/index.tsx:11234 and app_premium.js:3334.
    expect(canInvoice('owner', 'charge_card')).toBe(true);
  });

  it('IX-09 a super admin bypasses every capability', () => {
    // Matches requireSuperAdmin (src/index.tsx:780) and the gate at :1050.
    for (const cap of INVOICE_CAPABILITIES) {
      expect(canInvoice('laborer', cap, { isSuperAdmin: true })).toBe(true);
    }
  });

  it('IX-10 isSuperAdmin false or absent changes nothing', () => {
    expect(canInvoice('laborer', 'read', { isSuperAdmin: false })).toBe(false);
    expect(canInvoice('laborer', 'read', {})).toBe(false);
  });

  it('IX-11 an unknown capability is denied rather than allowed through', () => {
    expect(canInvoice('admin', 'not_a_capability' as InvoiceCapability)).toBe(false);
  });
});
