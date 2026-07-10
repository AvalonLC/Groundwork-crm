/**
 * Groundwork CRM — User & Access Management Module
 *
 * Provides:
 *  - Admin → Users: create/edit/deactivate users, assign roles, reset passwords
 *  - Admin → Roles & Permissions: role templates + per-view access matrix
 *  - Admin → Team Members: manage users, roles, permissions, invite flow
 *  - Login audit log (last login, failed attempts)
 *
 * Storage keys:
 *  - avalonUsersV1        → array of user objects
 *  - avalonRolesV1        → array of role objects
 *  - avalonLoginAuditV1   → array of audit log entries
 *  - avalonUserGoogleV1   → object keyed by userId → google connection state
 *
 * IMPORTANT: The REPS array in reps.js remains the authoritative source for
 * live login/permission checks. This module keeps a parallel user database
 * that extends REPS with richer metadata. On user create/edit the REPS array
 * is patched in-memory so changes take effect immediately without a page reload.
 */

// ── Storage Keys ───────────────────────────────────────────────────────────────
const UM_USERS_KEY   = 'avalonUsersV1';
const UM_AUDIT_KEY   = 'avalonLoginAuditV1';
const UM_GOOGLE_KEY  = 'avalonUserGoogleV1';

// ── Role definitions ────────────────────────────────────────────────────────────
// These are the BUILT-IN fallback role definitions. They are used when:
//   1. The company hasn't loaded from D1 yet (pre-login)
//   2. D1 bootstrap failed (network error)
// At login, window._gwRoles is populated from D1 with this company's roles.
// getRoleDefs() always returns the most current source.
// ── GROUNDWORK ROLE MODEL ─────────────────────────────────────────────────────
// Single source of truth for role definitions, default view access, capability
// flags, and data-scope metadata. Derived by all permission UI and canViewTab().
//
// VIEW KEYS map directly to show() route keys used throughout app_premium.js.
// CAPABILITIES are named action/permission flags for future enforcement.
// SCOPE controls data visibility (self / team / all) per domain.
// ─────────────────────────────────────────────────────────────────────────────

const _UM_ROLE_DEFS_DEFAULT = [
  // ── 1. ADMIN ──────────────────────────────────────────────────────────────
  {
    id: 'admin',
    label: 'Owner',
    color: '#4D8A86',
    description: 'Full access to everything. Bypasses all permission gates.',
    defaultViews: ['today','myDashboard','teamView',
      'pipeline','lead','clients','properties','estimates',
      'communications','automations','templates','campaigns',
      'process','forms','scripts','emailTemplates','objections','calculator','ai','academy',
      'financialHub','invoices','payments','deposits','statements','financialActivity',
      'scheduleBoard','dispatchBoard','recurringServices','crewView',
      'workOrderList','workOrderDetail','assetList','assetDetail',
      'maintenanceQueue','inventoryList','materialAllocation','toolsConsumables','timeTracker',
      'revenueAdmin','salesReports','financialReports','opsReports','teamReports',
      'settings','userManagement','integrations','manager','systemConfig','systemTemplates',
      'opsHub','approvalQueue','auditLog','portalAdmin','automationCenter','fieldMode'],
    capabilities: {
      // Sales / Financial
      can_create_lead: true, can_edit_lead: true,
      can_create_estimate: true, can_edit_estimate: true, can_send_estimate: true,
      can_create_invoice: true, can_send_invoice: true, can_record_payment: true,
      // Operations
      can_assign_schedule: true, can_dispatch_crews: true,
      can_edit_work_order: true, can_mark_work_order_complete: true,
      can_edit_time: true, can_approve_time: true,
      can_manage_assets: true, can_manage_inventory: true,
      // Admin
      can_manage_users: true, can_manage_roles: true,
      can_manage_integrations: true, can_edit_system_settings: true,
      can_delete_leads: true,
      // Phase 8 platform capabilities
      can_approve_requests: true, can_manage_automations: true,
      can_view_audit_logs: true, can_manage_portal_access: true,
    },
    scope: { sales: 'all', ops: 'all', financial: 'all', people: 'all' }
  },

  // ── 2. OFFICE MANAGER ─────────────────────────────────────────────────────
  {
    id: 'office_manager',
    label: 'Office Manager',
    color: '#8B6914',
    description: 'Broad business access across Sales, Financial, Ops, and Reports. Limited settings — not equivalent to Admin.',
    defaultViews: ['today','myDashboard','teamView',
      'pipeline','lead','clients','properties','estimates',
      'communications','automations','templates','campaigns',
      'process','forms','scripts','emailTemplates','objections','calculator','ai','academy',
      'financialHub','invoices','payments','deposits','statements','financialActivity',
      'scheduleBoard','dispatchBoard','recurringServices','crewView',
      'workOrderList','workOrderDetail','assetList','assetDetail',
      'maintenanceQueue','inventoryList','materialAllocation','toolsConsumables','timeTracker',
      'revenueAdmin','salesReports','financialReports','opsReports','teamReports',
      'settings','integrations','manager','approvalQueue','auditLog','portalAdmin','automationCenter'],
    capabilities: {
      can_create_lead: true, can_edit_lead: true,
      can_create_estimate: true, can_edit_estimate: true, can_send_estimate: true,
      can_create_invoice: true, can_send_invoice: true, can_record_payment: true,
      can_assign_schedule: true, can_dispatch_crews: true,
      can_edit_work_order: true, can_mark_work_order_complete: true,
      can_edit_time: true, can_approve_time: true,
      can_manage_assets: true, can_manage_inventory: true,
      can_manage_users: false, can_manage_roles: false,
      can_manage_integrations: true, can_edit_system_settings: false,
      can_delete_leads: false,
      // Phase 8 platform capabilities
      can_approve_requests: true, can_manage_automations: true,
      can_view_audit_logs: true, can_manage_portal_access: true,
    },
    scope: { sales: 'all', ops: 'all', financial: 'all', people: 'all' }
  },

  // ── 3. REP (full field-sales default) ─────────────────────────────────────
  {
    id: 'rep',
    label: 'Sales Rep',
    color: '#2D7A55',
    description: 'Full sales workflow — pipeline, estimates, comms, pricing, and all sales enablement. Assign this role if someone both quotes and manages the relationship.',
    defaultViews: ['today','myDashboard',
      'pipeline','lead','clients','properties','estimates',
      'communications','automations','templates','campaigns',
      'process','forms','scripts','emailTemplates','objections','calculator','ai','academy'],
    capabilities: {
      can_create_lead: true, can_edit_lead: true,
      can_create_estimate: true, can_edit_estimate: true, can_send_estimate: true,
      can_create_invoice: false, can_send_invoice: false, can_record_payment: false,
      can_assign_schedule: false, can_dispatch_crews: false,
      can_edit_work_order: false, can_mark_work_order_complete: false,
      can_edit_time: true, can_approve_time: false,
      can_manage_assets: false, can_manage_inventory: false,
      can_manage_users: false, can_manage_roles: false,
      can_manage_integrations: false, can_edit_system_settings: false,
      can_delete_leads: false,
      // Phase 8 platform capabilities
      can_approve_requests: false, can_manage_automations: false,
      can_view_audit_logs: false, can_manage_portal_access: false,
    },
    scope: { sales: 'self', ops: 'self', financial: 'none', people: 'self' }
  },

  // ── 4. ESTIMATOR (quote-only specialist) ──────────────────────────────────
  {
    id: 'estimator',
    label: 'Estimator',
    color: '#5B7FA6',
    description: 'Narrow quote/pricing specialist. Pipeline, estimates, properties, and pricing tools only. Does NOT manage the client relationship — use Rep for that.',
    defaultViews: ['today','pipeline','clients','properties','estimates','calculator','forms'],
    capabilities: {
      can_create_lead: false, can_edit_lead: false,
      can_create_estimate: true, can_edit_estimate: true, can_send_estimate: true,
      can_create_invoice: false, can_send_invoice: false, can_record_payment: false,
      can_assign_schedule: false, can_dispatch_crews: false,
      can_edit_work_order: false, can_mark_work_order_complete: false,
      can_edit_time: false, can_approve_time: false,
      can_manage_assets: false, can_manage_inventory: false,
      can_manage_users: false, can_manage_roles: false,
      can_manage_integrations: false, can_edit_system_settings: false,
      can_delete_leads: false,
      // Phase 8 platform capabilities
      can_approve_requests: false, can_manage_automations: false,
      can_view_audit_logs: false, can_manage_portal_access: false,
    },
    scope: { sales: 'assigned', ops: 'none', financial: 'none', people: 'none' }
  },

  // ── 5. FOREMAN (field lead / crew supervisor) ────────────────────────────
  {
    id: 'foreman',
    label: 'Foreman',
    color: '#6B5EA8',
    description: 'Field lead for daily operations, crew execution, work orders, dispatch, and crew time visibility. No Sales or Financial access.',
    defaultViews: ['today','myDashboard',
      'scheduleBoard','dispatchBoard','recurringServices','crewView',
      'workOrderList','workOrderDetail',
      'assetList','assetDetail','maintenanceQueue','inventoryList','toolsConsumables',
      'timeTracker','opsReports','teamReports','approvalQueue','fieldMode'],
    capabilities: {
      can_create_lead: false, can_edit_lead: false,
      can_create_estimate: false, can_edit_estimate: false, can_send_estimate: false,
      can_create_invoice: false, can_send_invoice: false, can_record_payment: false,
      can_assign_schedule: true, can_dispatch_crews: true,
      can_edit_work_order: true, can_mark_work_order_complete: true,
      can_edit_time: true, can_approve_time: true,
      can_manage_assets: true, can_manage_inventory: true,
      can_manage_users: false, can_manage_roles: false,
      can_manage_integrations: false, can_edit_system_settings: false,
      can_delete_leads: false,
      can_approve_requests: true, can_manage_automations: false,
      can_view_audit_logs: false, can_manage_portal_access: false,
    },
    // Foreman scope: crew-level ops, no financial or sales visibility
    scope: { sales: 'none', ops: 'crew', financial: 'none', people: 'crew' }
  },

  // ── 6. LABORER (self-service field crew member) ──────────────────────────
  {
    id: 'laborer',
    label: 'Laborer',
    color: '#7A7A6E',
    description: 'Self-service field role for assigned jobs, personal schedule, own time tracking, and simple field updates. No dispatch, financial, or admin access.',
    defaultViews: ['today','scheduleBoard','workOrderList','timeTracker','fieldMode'],
    capabilities: {
      can_create_lead: false, can_edit_lead: false,
      can_create_estimate: false, can_edit_estimate: false, can_send_estimate: false,
      can_create_invoice: false, can_send_invoice: false, can_record_payment: false,
      can_assign_schedule: false, can_dispatch_crews: false,
      can_edit_work_order: false, can_mark_work_order_complete: true,
      can_edit_time: true, can_approve_time: false,
      can_manage_assets: false, can_manage_inventory: false,
      can_manage_users: false, can_manage_roles: false,
      can_manage_integrations: false, can_edit_system_settings: false,
      can_delete_leads: false,
      can_approve_requests: false, can_manage_automations: false,
      can_view_audit_logs: false, can_manage_portal_access: false,
    },
    // Laborer scope: self only — cannot see others' time, schedule, or data
    scope: { sales: 'none', ops: 'self', financial: 'none', people: 'self' }
  },

  // ── 7. VIEW ONLY ──────────────────────────────────────────────────────────
  {
    id: 'view_only',
    label: 'View Only',
    color: '#6F7E6A',
    description: 'Read-only stakeholder access. Today and Pipeline visibility only.',
    defaultViews: ['today','pipeline'],
    capabilities: {
      can_create_lead: false, can_edit_lead: false,
      can_create_estimate: false, can_edit_estimate: false, can_send_estimate: false,
      can_create_invoice: false, can_send_invoice: false, can_record_payment: false,
      can_assign_schedule: false, can_dispatch_crews: false,
      can_edit_work_order: false, can_mark_work_order_complete: false,
      can_edit_time: false, can_approve_time: false,
      can_manage_assets: false, can_manage_inventory: false,
      can_manage_users: false, can_manage_roles: false,
      can_manage_integrations: false, can_edit_system_settings: false,
      can_delete_leads: false,
      // Phase 8 platform capabilities
      can_approve_requests: false, can_manage_automations: false,
      can_view_audit_logs: false, can_manage_portal_access: false,
    },
    scope: { sales: 'none', ops: 'none', financial: 'none', people: 'none' }
  }
];

/**
 * Returns the active role definitions for the current company.
 * Priority: D1-sourced window._gwRoles → built-in defaults.
 * This function is the single source of truth for role definitions.
 */
function getRoleDefs() {
  if (window._gwRoles && window._gwRoles.length > 0) {
    return window._gwRoles.map(r => {
      const fallback = _UM_ROLE_DEFS_DEFAULT.find(d => d.id === r.id) || {};
      return {
        id:           r.id,
        label:        r.label,
        color:        r.color || fallback.color || '#6F7E6A',
        description:  r.description || fallback.description || '',
        defaultViews: (r.permissions && Array.isArray(r.permissions.views))
                        ? r.permissions.views
                        : (fallback.defaultViews || []),
        capabilities: Object.assign({}, fallback.capabilities || {}, r.permissions?.capabilities || {}),
        scope:        Object.assign({}, fallback.scope || {}, r.permissions?.scope || {}),
        is_system:    r.is_system || false
      };
    });
  }
  return _UM_ROLE_DEFS_DEFAULT;
}
window.getRoleDefs = getRoleDefs;

// Legacy alias — existing code referencing UM_ROLE_DEFS still works.
// It reads from getRoleDefs() dynamically so it always reflects D1 data.
const UM_ROLE_DEFS = new Proxy([], {
  get(_, prop) {
    const arr = getRoleDefs();
    if (prop === 'length') return arr.length;
    if (prop === 'find') return arr.find.bind(arr);
    if (prop === 'filter') return arr.filter.bind(arr);
    if (prop === 'map') return arr.map.bind(arr);
    if (prop === 'forEach') return arr.forEach.bind(arr);
    if (prop === 'some') return arr.some.bind(arr);
    if (typeof prop === 'string' && !isNaN(Number(prop))) return arr[Number(prop)];
    return arr[prop];
  },
  has(_, prop) { return prop in getRoleDefs(); }
});

// ── Positions list ─────────────────────────────────────────────────────────────
const UM_POSITIONS = [
  'Owner',
  'Sales Manager',
  'Sales Rep',
  'Office Manager',
  'Estimator',
  'Admin Support',
  'Foreman',
  'Crew Lead',
  'Laborer',
  'Technician',
  'Driver',
  'Other'
];

// ── Helpers ────────────────────────────────────────────────────────────────────
function umLoadUsers() {
  // Priority 1: D1-sourced REPS array (populated at login from /api/auth/bootstrap)
  // REPS is now the canonical user list — not localStorage.
  const reps = window.REPS || [];
  if (reps.length > 0) {
    return umBootstrapUsersFromReps();
  }
  // Priority 2: localStorage cache (only used before D1 is ready)
  try {
    const stored = JSON.parse(localStorage.getItem(UM_USERS_KEY) || '[]');
    if (stored.length) return stored;
  } catch(e) {}
  return [];
}

function umBootstrapUsersFromReps() {
  // Maps the D1-hydrated REPS array → user management user objects.
  // This is called every time the user management view opens so it always
  // reflects the current D1 team list — including newly invited reps.
  const reps = window.REPS || [];
  const positionForRole = r =>
    r.role === 'admin'            ? 'Owner' :
    r.role === 'office_manager'   ? 'Office Manager' :
    r.role === 'estimator'        ? 'Estimator' :
    r.role === 'foreman'          ? 'Foreman' :
    r.role === 'field_supervisor' ? 'Foreman' :
    r.role === 'laborer'          ? 'Laborer' :
    r.role === 'view_only'        ? 'View Only' : 'Sales Rep';

  const users = reps.map(r => ({
    id: r.id,
    name: r.name,
    displayName: r.name,
    email: r.email || '',
    phone: '',
    position: positionForRole(r),
    role: r.role,
    color: r.color || '#6F7E6A',
    status: r.active === false ? 'inactive' : 'active',
    password: '',   // never expose hash
    mustResetPin: false,
    failedLoginCount: 0,
    lastLoginAt: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    notes: '',
    _fromD1: true
  }));
  // Also write to localStorage as a cache
  try { localStorage.setItem(UM_USERS_KEY, JSON.stringify(users)); } catch(_) {}
  return users;
}

function umSaveUsers(users) {
  localStorage.setItem(UM_USERS_KEY, JSON.stringify(users));
  // Patch the live REPS array so login + role checks stay in sync
  umSyncRepsFromUsers(users);
}

function umSyncRepsFromUsers(users) {
  if (!window.REPS) return;
  const activeUsers = users.filter(u => u.status === 'active');
  // Update existing REPS in place
  window.REPS.forEach(rep => {
    const u = activeUsers.find(u => u.id === rep.id);
    if (u) {
      rep.name  = u.displayName || u.name;
      rep.role  = u.role;
      rep.color = u.color;
      rep.title = u.position;
    }
  });
  // Add new users that are not yet in REPS
  activeUsers.forEach(u => {
    if (!window.REPS.find(r => r.id === u.id)) {
      window.REPS.push({
        id: u.id,
        name: u.displayName || u.name,
        title: u.position,
        role: u.role,
        avatar: '',
        color: u.color,
        base: null,
        commissionPlan: u.role === 'rep' ? 'ryan' : null
      });
    }
  });
  // Mark deactivated users by removing from REPS
  const activeIds = new Set(activeUsers.map(u => u.id));
  for (let i = window.REPS.length - 1; i >= 0; i--) {
    if (!activeIds.has(window.REPS[i].id)) {
      window.REPS.splice(i, 1);
    }
  }
}

function umLoadAudit() {
  try { return JSON.parse(localStorage.getItem(UM_AUDIT_KEY) || '[]'); }
  catch(e) { return []; }
}

function umAddAuditEntry(entry) {
  const log = umLoadAudit();
  log.unshift({ ...entry, timestamp: new Date().toISOString() });
  // Keep last 200 entries
  if (log.length > 200) log.length = 200;
  localStorage.setItem(UM_AUDIT_KEY, JSON.stringify(log));
}

function umLoadUserGoogle() {
  try { return JSON.parse(localStorage.getItem(UM_GOOGLE_KEY) || '{}'); }
  catch(e) { return {}; }
}

function umSaveUserGoogle(map) {
  localStorage.setItem(UM_GOOGLE_KEY, JSON.stringify(map));
}

function umEscape(s) {
  if (!s) return '';
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function umGenId() {
  return 'usr_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2,6);
}

function umFormatDate(iso) {
  if (!iso) return '—';
  try {
    const d = new Date(iso);
    return d.toLocaleDateString('en-US', { month:'short', day:'numeric', year:'numeric' }) + ' ' +
           d.toLocaleTimeString('en-US', { hour:'numeric', minute:'2-digit' });
  } catch(e) { return iso; }
}

function umRoleDef(roleId) {
  return UM_ROLE_DEFS.find(r => r.id === roleId) || { label: roleId, color: '#6F7E6A', defaultViews: [] };
}

function umColorTile(name, color, size = 36) {
  const letter = (name || '?')[0].toUpperCase();
  return `<span style="display:inline-flex;align-items:center;justify-content:center;width:${size}px;height:${size}px;border-radius:${Math.round(size*0.28)}px;background:${color}22;border:2px solid ${color}66;color:${color};font-weight:800;font-size:${Math.round(size*0.44)}px;flex-shrink:0;letter-spacing:0">${umEscape(letter)}</span>`;
}

function umStatusPill(status) {
  if (status === 'active')   return `<span style="font-size:10px;font-weight:700;color:#2D7A55;background:#2D7A5518;border:1px solid #2D7A5540;border-radius:20px;padding:2px 8px">Active</span>`;
  if (status === 'inactive') return `<span style="font-size:10px;font-weight:700;color:#C97B6A;background:#C97B6A18;border:1px solid #C97B6A40;border-radius:20px;padding:2px 8px">Inactive</span>`;
  return `<span style="font-size:10px;font-weight:700;color:#6F7E6A;background:#6F7E6A18;border:1px solid rgba(111,126,106,.25);border-radius:20px;padding:2px 8px">${umEscape(status)}</span>`;
}

// ── Toast helper (uses global showToast if available) ──────────────────────────
function umToast(msg, type = 'ok') {
  if (typeof window.showToast === 'function') { window.showToast(msg); return; }
  alert(msg);
}

// ── All-views list — single source of truth for the permission matrix ─────────
// Each entry: { key, label, hub, kind }
//   key  = show() route key used in app_premium.js
//   hub  = one of the 6 nav hubs (matches nav structure)
//   kind = 'page' | 'report' | 'admin'
const UM_ALL_VIEWS = [
  // ── DASHBOARD ──────────────────────────────────────────────────────────────
  { key:'today',              label:'Today',                   hub:'Dashboard',   kind:'page'   },
  { key:'myDashboard',        label:'My Dashboard',            hub:'Dashboard',   kind:'page'   },
  { key:'teamView',           label:'Team View',               hub:'Dashboard',   kind:'page'   },

  // ── SALES ──────────────────────────────────────────────────────────────────
  { key:'pipeline',           label:'Pipeline',                hub:'Sales',       kind:'page'   },
  { key:'lead',               label:'Leads',                   hub:'Sales',       kind:'page'   },
  { key:'clients',            label:'Clients',                 hub:'Sales',       kind:'page'   },
  { key:'properties',         label:'Properties',              hub:'Sales',       kind:'page'   },
  { key:'estimates',          label:'Estimates',               hub:'Sales',       kind:'page'   },
  { key:'communications',     label:'Communications',          hub:'Sales',       kind:'page'   },
  { key:'automations',        label:'Automations',             hub:'Sales',       kind:'page'   },
  { key:'templates',          label:'Templates',               hub:'Sales',       kind:'page'   },
  { key:'campaigns',          label:'Campaigns / Drips',       hub:'Sales',       kind:'page'   },
  { key:'process',            label:'Sales Process',           hub:'Sales',       kind:'page'   },
  { key:'forms',              label:'Forms & Checklists',      hub:'Sales',       kind:'page'   },
  { key:'scripts',            label:'Scripts',                 hub:'Sales',       kind:'page'   },
  { key:'emailTemplates',     label:'Email Templates',         hub:'Sales',       kind:'page'   },
  { key:'objections',         label:'Objection Handling',      hub:'Sales',       kind:'page'   },
  { key:'calculator',         label:'Pricing Tools',           hub:'Sales',       kind:'page'   },
  { key:'ai',                 label:'AI Assistant',            hub:'Sales',       kind:'page'   },
  { key:'academy',            label:'Academy',                 hub:'Sales',       kind:'page'   },

  // ── FINANCIAL ──────────────────────────────────────────────────────────────
  { key:'financialHub',       label:'Financial Overview',      hub:'Financial',   kind:'page'   },
  { key:'invoices',           label:'Invoices',                hub:'Financial',   kind:'page'   },
  { key:'payments',           label:'Payments',                hub:'Financial',   kind:'page'   },
  { key:'deposits',           label:'Deposits',                hub:'Financial',   kind:'page'   },
  { key:'statements',         label:'Statements',              hub:'Financial',   kind:'page'   },
  { key:'financialActivity',  label:'Activity',                hub:'Financial',   kind:'page'   },

  // ── OPERATIONS ─────────────────────────────────────────────────────────────
  { key:'scheduleBoard',      label:'Calendar',                hub:'Operations',  kind:'page'   },
  { key:'dispatchBoard',      label:'Dispatch',                hub:'Operations',  kind:'page'   },
  { key:'recurringServices',  label:'Recurring Services',      hub:'Operations',  kind:'page'   },
  { key:'crewView',           label:'Crew View',               hub:'Operations',  kind:'page'   },
  { key:'workOrderList',      label:'Work Orders',             hub:'Operations',  kind:'page'   },
  { key:'assetList',          label:'Assets',                  hub:'Operations',  kind:'page'   },
  { key:'maintenanceQueue',   label:'Maintenance',             hub:'Operations',  kind:'page'   },
  { key:'inventoryList',      label:'Inventory',               hub:'Operations',  kind:'page'   },
  { key:'toolsConsumables',   label:'Tools & Consumables',     hub:'Operations',  kind:'page'   },
  { key:'timeTracker',        label:'Time Tracker',            hub:'Operations',  kind:'page'   },

  // ── REPORTS ────────────────────────────────────────────────────────────────
  { key:'revenueAdmin',       label:'Revenue',                 hub:'Reports',     kind:'report' },
  { key:'salesReports',       label:'Sales',                   hub:'Reports',     kind:'report' },
  { key:'financialReports',   label:'Financial',               hub:'Reports',     kind:'report' },
  { key:'opsReports',         label:'Operations',              hub:'Reports',     kind:'report' },
  { key:'teamReports',        label:'Team',                    hub:'Reports',     kind:'report' },

  // ── SETTINGS ───────────────────────────────────────────────────────────────
  { key:'settings',           label:'General Settings',        hub:'Settings',    kind:'admin'  },
  { key:'userManagement',     label:'Employees',           hub:'Settings',    kind:'admin'  },
  { key:'integrations',       label:'Integrations',            hub:'Settings',    kind:'admin'  },
  { key:'manager',            label:'Manager Tools',           hub:'Settings',    kind:'admin'  },
  { key:'systemConfig',       label:'System Config',           hub:'Settings',    kind:'admin'  },
  { key:'systemTemplates',    label:'Templates & Automations', hub:'Settings',    kind:'admin'  },
];

// ── Main entry point ───────────────────────────────────────────────────────────
function userManagement(tab) {
  const currentRep = window.getCurrentRep ? window.getCurrentRep() : null;
  const viewEl = document.getElementById('view');
  if (!viewEl) return;

  // Only admins can access user management
  if (!currentRep || currentRep.role !== 'admin') {
    viewEl.innerHTML = `
      <div style="text-align:center;padding:64px 24px;margin-top:40px">
        <div style="width:48px;height:48px;background:#FAE8E4;border-radius:12px;display:flex;align-items:center;justify-content:center;margin:0 auto 16px"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#7A2E20" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg></div>
        <h2 style="color:#C97B6A;margin-bottom:10px">Access Restricted</h2>
        <p style="color:#6F7E6A;max-width:420px;margin:0 auto 24px">User Management is restricted to the Owner. Ask your Owner if you need access changes.</p>
        <button class="secondary-btn" onclick="show('today')">← Back to Today</button>
      </div>`;
    return;
  }

  const activeTab = tab || 'users';
  const tabs = [
    { id:'users',      label:'Team Members' },
    { id:'crews',      label:'Crews' },
    { id:'onboarding', label:'Onboarding' },
    { id:'roles',      label:'Roles & Permissions' },
    { id:'audit',      label:'Login Audit' }
  ];

  viewEl.innerHTML = `
<div class="eyebrow">Admin</div>
<h1>Employees &amp; Teams</h1>
<p class="lede" style="margin-bottom:20px">Manage employees, crews, roles, and permissions. Changes take effect immediately.</p>

<div class="gw-um-tab-nav">
  ${tabs.map(t => `
  <button onclick="window._umTab('${t.id}')"
    style="padding:8px 16px;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer;transition:all .15s;
    ${activeTab===t.id ? 'background:#4D8A86;color:#fff;border:1.5px solid #4D8A86' : 'background:var(--gw-surface-2);color:var(--gw-muted);border:1.5px solid var(--gw-line)'}"
    onmouseover="if('${activeTab}'!=='${t.id}')this.style.background='var(--gw-surface-3)'"
    onmouseout="if('${activeTab}'!=='${t.id}')this.style.background='var(--gw-surface-2)'">
    ${t.label}
  </button>`).join('')}
</div>

<div id="um-tab-content"></div>
`;

  window._umTab = function(tabId) {
    // Re-render with new tab
    userManagement(tabId);
  };

  const tc = document.getElementById('um-tab-content');
  if (!tc) return;

  if (activeTab === 'users')           umRenderUsers(tc);
  else if (activeTab === 'crews')      umRenderCrews(tc);
  else if (activeTab === 'onboarding') umRenderOnboarding(tc);
  else if (activeTab === 'roles')      umRenderRoles(tc);
  else if (activeTab === 'audit')      umRenderAudit(tc);
}

// ═══════════════════════════════════════════════════════════════════════════════
// TAB 1 — USERS
// ═══════════════════════════════════════════════════════════════════════════════
function umRenderUsers(container) {
  const users    = umLoadUsers();
  const googleMap= umLoadUserGoogle();
  const currentRep = window.getCurrentRep ? window.getCurrentRep() : null;
  // Fetch D1 rep data in background to get invite status and sync
  const companyId = currentRep?.company_id || window._d1SessionRep?.company_id || 'avalon';
  fetch(`/api/reps?companyId=${encodeURIComponent(companyId)}`, { credentials: 'include' })
    .then(r=>r.json())
    .then(d => {
      const d1Reps = d.data || d;
      if (!Array.isArray(d1Reps)) return;
      // Store D1 invite statuses in a map for user row rendering
      window._umD1InviteMap = {};
      d1Reps.forEach(r => {
        window._umD1InviteMap[r.id] = {
          invite_accepted: r.invite_accepted,
          invite_sent_at: r.invite_sent_at,
          email: r.email
        };
        // Also merge pending users into local list if not present
        if (r.invite_accepted === 0) {
          const localUser = users.find(u=>u.id===r.id);
          if (!localUser) {
            users.push({
              id: r.id, name: r.name, displayName: r.name,
              email: r.email||'', phone:'', position: r.title||'Sales Rep',
              role: r.role, color: r.color||'#4D8A86',
              status: 'inactive', mustResetPin: false,
              failedLoginCount:0, lastLoginAt:null,
              createdAt:r.invite_sent_at||new Date().toISOString(),
              updatedAt:r.invite_sent_at||new Date().toISOString(), notes:''
            });
          }
        }
      });
      // Re-render user list with invite badges
      const listEl = document.getElementById('um-user-list');
      if (listEl) {
        listEl.innerHTML = users.length
          ? users.map(u => umUserRow(u, googleMap[u.id])).join('')
          : `<div style="text-align:center;padding:40px;color:#6F7E6A">No users yet. Add your first team member.</div>`;
      }
    }).catch(()=>{});

  container.innerHTML = `
<!-- ── Team Members ──────────────────────────────────────────────────────── -->
<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;flex-wrap:wrap;gap:10px">
  <div style="font-size:13px;font-weight:700;color:#E8E4D9">
    Team Members
    <span style="font-size:12px;color:#6F7E6A;font-weight:400;margin-left:8px">${users.filter(u=>u.status==='active').length} active · ${users.filter(u=>u.status==='inactive').length} inactive</span>
  </div>
  <div style="display:flex;gap:8px">
    <button class="secondary-btn" onclick="window._umOpenInviteForm()" style="display:flex;align-items:center;gap:6px">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></svg>
      Send Invite
    </button>
    <button class="primary-btn" onclick="window._umOpenUserForm(null)">+ Add User</button>
  </div>
</div>

<div style="display:flex;flex-direction:column;gap:10px" id="um-user-list">
  ${users.length ? users.map(u => umUserRow(u, googleMap[u.id])).join('') : `<div style="text-align:center;padding:40px;color:#6F7E6A">No users yet. Add your first team member.</div>`}
</div>
`;

  // Form logic
  window._umOpenUserForm = function(userId) {
    const users = umLoadUsers();
    const u = userId ? users.find(u => u.id === userId) : null;
    const isEdit = !!u;
    const colors = ['#4D8A86','#2D7A55','#8B6914','#4D8A86','#C97B6A','#C97B6A','#4D8A86','#2D7A55'];

    const modal = document.createElement('div');
    modal.id = 'um-user-modal';
    modal.style.cssText = 'position:fixed;inset:0;background:#000000cc;z-index:9999;display:flex;align-items:center;justify-content:center;padding:20px';
    modal.innerHTML = `
<div class="gw-modal-card" style="width:min(520px,100%);max-height:90vh;overflow-y:auto">
  <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:20px">
    <h2 style="margin:0;font-size:18px">${isEdit ? 'Edit User' : 'Add New User'}</h2>
    <button onclick="document.getElementById('um-user-modal').remove()" style="background:none;border:none;color:#6F7E6A;cursor:pointer;font-size:20px;padding:0 4px">&times;</button>
  </div>

  <div style="display:grid;gap:14px">
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
      <div>
        <label class="um-label">Full Name *</label>
        <input id="um-f-name" class="um-input" type="text" value="${umEscape(u?.name||'')}" placeholder="e.g. Ryan Vaillancourt">
      </div>
      <div>
        <label class="um-label">Display Name</label>
        <input id="um-f-display" class="um-input" type="text" value="${umEscape(u?.displayName||u?.name||'')}" placeholder="First name shown in app">
      </div>
    </div>

    <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
      <div>
        <label class="um-label">Email</label>
        <input id="um-f-email" class="um-input" type="email" value="${umEscape(u?.email||'')}" placeholder="ryan@avalon-lc.com">
      </div>
      <div>
        <label class="um-label">Phone</label>
        <input id="um-f-phone" class="um-input" type="tel" value="${umEscape(u?.phone||'')}" placeholder="(555) 000-0000">
      </div>
    </div>

    <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
      <div>
        <label class="um-label">Position / Job Title</label>
        <select id="um-f-position" class="um-input">
          ${UM_POSITIONS.map(p => `<option value="${umEscape(p)}" ${(u?.position||'Sales Rep')===p?'selected':''}>${umEscape(p)}</option>`).join('')}
        </select>
      </div>
      <div>
        <label class="um-label">Role (Access Level) *</label>
        <select id="um-f-role" class="um-input" onchange="window._umRoleChanged(this.value)">
          ${UM_ROLE_DEFS.map(r => `<option value="${r.id}" ${(u?.role||'rep')===r.id?'selected':''}>${r.label}</option>`).join('')}
        </select>
      </div>
    </div>

    <div id="um-role-desc" class="gw-um-role-desc" style="font-size:12px;color:var(--gw-muted);line-height:1.6">
      ${umRoleDef(u?.role||'rep').description}
    </div>

    <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
      <div>
        <label class="um-label">Password${isEdit ? '' : ' *'}</label>
        <input id="um-f-password" class="um-input" type="password"
          placeholder="${isEdit ? 'Leave blank to keep current' : 'Min 4 characters'}" autocomplete="new-password">
        <div style="font-size:11px;color:#5C6B58;margin-top:4px">${isEdit ? 'Leave blank to keep the existing password.' : 'User logs in with their email + this password.'}</div>
      </div>
      <div>
        <label class="um-label">Status</label>
        <select id="um-f-status" class="um-input">
          <option value="active"   ${(u?.status||'active')==='active'   ?'selected':''}>Active</option>
          <option value="inactive" ${(u?.status||'active')==='inactive' ?'selected':''}>Inactive</option>
        </select>
      </div>
    </div>

    <div>
      <label class="um-label">Profile Color</label>
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:6px" id="um-color-picker">
        ${colors.map(c => `
        <button type="button" onclick="window._umPickColor('${c}')" id="um-clr-${c.replace('#','')}"
          style="width:30px;height:30px;border-radius:8px;background:${c}22;border:2px solid ${(u?.color||colors[0])===c ? c : 'var(--gw-line)'};cursor:pointer;transition:all .12s;position:relative"
          title="${c}">
          <span style="width:14px;height:14px;border-radius:50%;background:${c};display:block;margin:auto"></span>
          ${(u?.color||colors[0])===c ? `<span style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:${c};font-size:14px">✓</span>` : ''}
        </button>`).join('')}
      </div>
      <input type="hidden" id="um-f-color" value="${umEscape(u?.color||colors[0])}">
    </div>

    <div>
      <label class="um-label">Notes (internal)</label>
      <textarea id="um-f-notes" class="um-input" rows="2" placeholder="Optional internal notes about this user" style="resize:vertical">${umEscape(u?.notes||'')}</textarea>
    </div>

    <div style="display:flex;gap:8px;margin-top:8px;align-items:center">
      <label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-size:13px;color:#6F7E6A">
        <input type="checkbox" id="um-f-reset-pin" ${u?.mustResetPin?'checked':''} style="accent-color:#4D8A86">
        Require password reset on next login
      </label>
    </div>
  </div>

  <div style="display:flex;gap:10px;margin-top:24px;justify-content:flex-end;flex-wrap:wrap">
    ${isEdit && u?.id !== 'tyler' ? `<button class="danger-btn" style="margin-right:auto" onclick="window._umToggleActive('${u.id}')">
      ${u?.status==='active' ? 'Deactivate User' : 'Reactivate User'}
    </button>` : ''}
    <button class="secondary-btn" onclick="document.getElementById('um-user-modal').remove()">Cancel</button>
    <button class="primary-btn" onclick="window._umSaveUser('${u?.id||''}')">
      ${isEdit ? 'Save Changes' : 'Create User'}
    </button>
  </div>
</div>`;
    document.body.appendChild(modal);

    window._umRoleChanged = function(roleId) {
      const desc = document.getElementById('um-role-desc');
      if (desc) desc.textContent = umRoleDef(roleId).description;
    };

    window._umPickColor = function(color) {
      document.getElementById('um-f-color').value = color;
      document.querySelectorAll('[id^="um-clr-"]').forEach(btn => {
        const btnColor = '#' + btn.id.replace('um-clr-','');
        btn.style.border = `2px solid ${color === btnColor ? btnColor : 'var(--gw-line)'}`;
        btn.innerHTML = `<span style="width:14px;height:14px;border-radius:50%;background:${btnColor};display:block;margin:auto"></span>${color===btnColor ? `<span style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:${btnColor};font-size:14px">✓</span>` : ''}`;
      });
    };

    window._umSaveUser = function(existingId) {
      const name    = document.getElementById('um-f-name')?.value?.trim() || '';
      const display = document.getElementById('um-f-display')?.value?.trim() || '';
      const email   = document.getElementById('um-f-email')?.value?.trim() || '';
      const phone   = document.getElementById('um-f-phone')?.value?.trim() || '';
      const pos     = document.getElementById('um-f-position')?.value || 'Sales Rep';
      const role    = document.getElementById('um-f-role')?.value || 'rep';
      const password = document.getElementById('um-f-password')?.value || '';
      const status  = document.getElementById('um-f-status')?.value || 'active';
      const color   = document.getElementById('um-f-color')?.value || '#2D7A55';
      const notes   = document.getElementById('um-f-notes')?.value?.trim() || '';
      const mustReset = document.getElementById('um-f-reset-pin')?.checked || false;

      if (!name) { umToast('Full name is required'); return; }
      if (!existingId && password.length < 4) { umToast('Password must be at least 4 characters'); return; }

      const users = umLoadUsers();
      const userId = existingId || umGenId();
      const now = new Date().toISOString();

      const existingIdx = users.findIndex(u => u.id === userId);
      const userData = {
        id: userId,
        name,
        displayName: display || name.split(' ')[0],
        email,
        phone,
        position: pos,
        role,
        color,
        status,
        ...(password ? { password } : {}),
        mustResetPin: mustReset,
        failedLoginCount: existingIdx >= 0 ? (users[existingIdx].failedLoginCount || 0) : 0,
        lastLoginAt: existingIdx >= 0 ? users[existingIdx].lastLoginAt : null,
        createdAt: existingIdx >= 0 ? users[existingIdx].createdAt : now,
        updatedAt: now,
        notes
      };

      if (existingIdx >= 0) {
        users[existingIdx] = userData;
      } else {
        users.push(userData);
      }

      umSaveUsers(users);
      umAddAuditEntry({ type: existingId ? 'user_updated' : 'user_created', userId, userName: name, by: window.getCurrentRep?.()?.name || 'Admin' });

      // Phase 8: gwAudit + gwWorkflow hooks for role/permission changes
      const prevUser = existingIdx >= 0 ? users[existingIdx] : null;
      const prevRole = prevUser?.role;
      if (typeof window.gwAudit === 'function') {
        window.gwAudit({ type: existingId ? 'user_updated' : 'user_created', entityType:'rep', entityId:userId, entityLabel:name, meta:{ role } });
      }
      if (existingId && prevRole && prevRole !== role && typeof window.gwWorkflow === 'object') {
        window.gwWorkflow.roleChanged({ entityId:userId, entityLabel:name, from:prevRole, to:role, by:window.getCurrentRep?.()?.name||'Admin' });
      }
      if (existingId && prevRole !== role && typeof window.gwAudit === 'function') {
        window.gwAudit({ type:'permission_changed', entityType:'rep', entityId:userId, entityLabel:name, meta:{ from:prevRole, to:role } });
      }

      // Persist to D1 so email+password auth works server-side
      const apiPayload = {
        name,
        title: pos,
        email,
        role,
        color,
        active: status === 'active' ? 1 : 0,
        ...(password ? { password } : {})
      };
      const apiCall = existingId
        ? window.API?.reps?.update?.(existingId, apiPayload) || fetch(`/api/reps/${existingId}`, { method:'PUT', headers:{'Content-Type':'application/json'}, credentials:'include', body:JSON.stringify(apiPayload) })
        : window.API?.reps?.create?.({ ...apiPayload, id: userId }) || fetch('/api/reps', { method:'POST', headers:{'Content-Type':'application/json'}, credentials:'include', body:JSON.stringify({ ...apiPayload, id: userId }) });
      apiCall.then(r => {
        if (r.ok) {
          // Refresh REPS from D1 so the new user persists across reloads
          const currentRep = window.getCurrentRep ? window.getCurrentRep() : null;
          const companyId = currentRep?.company_id || window._d1SessionRep?.company_id || 'avalon';
          fetch(`/api/reps?companyId=${encodeURIComponent(companyId)}`, { credentials: 'include' })
            .then(r2 => r2.json())
            .then(d => { if (d.data && Array.isArray(d.data)) window.REPS = d.data; })
            .catch(() => {});
        } else {
          r.json().then(d => umToast(`Save failed: ${d?.error || 'Server error — user may not have been saved'}`)).catch(() => umToast('Save failed: Server error'));
        }
      }).catch(() => umToast('Network error — user may not have been saved'));

      document.getElementById('um-user-modal')?.remove();
      umToast(existingId ? `${name} updated` : `${name} added`);
      userManagement('users');
    };

    window._umToggleActive = function(userId) {
      const users = umLoadUsers();
      const u = users.find(u => u.id === userId);
      if (!u) return;
      if (u.id === 'tyler') { umToast("Can't deactivate the Owner account"); return; }
      const newStatus = u.status === 'active' ? 'inactive' : 'active';
      if (newStatus === 'inactive' && !confirm(`Deactivate ${u.name}? They will no longer be able to log in.`)) return;
      u.status = newStatus;
      u.updatedAt = new Date().toISOString();
      umSaveUsers(users);
      umAddAuditEntry({ type: newStatus === 'inactive' ? 'user_deactivated' : 'user_reactivated', userId, userName: u.name, by: window.getCurrentRep?.()?.name || 'Admin' });
      // Sync active state to D1
      fetch(`/api/reps/${userId}`, { method:'PUT', headers:{'Content-Type':'application/json'}, credentials:'include',
        body: JSON.stringify({ active: newStatus === 'active' ? 1 : 0 }) }).catch(() => {});
      document.getElementById('um-user-modal')?.remove();
      umToast(`${u.name} ${newStatus === 'active' ? 'reactivated' : 'deactivated'}`);
      userManagement('users');
    };
  };

  window._umResetPin = function(userId) {
    const users = umLoadUsers();
    const u = users.find(u => u.id === userId);
    if (!u) return;
    const newPw = prompt(`Reset password for ${u.name}.\nEnter a new password (min 4 characters):`, '');
    if (newPw === null) return; // cancelled
    if (!newPw || newPw.length < 4) { umToast('Password must be at least 4 characters'); return; }
    u.password = newPw;
    u.mustResetPin = false;
    u.failedLoginCount = 0;
    u.updatedAt = new Date().toISOString();
    umSaveUsers(users);
    umAddAuditEntry({ type: 'pin_reset', userId, userName: u.name, by: window.getCurrentRep?.()?.name || 'Admin' });
    // Sync new password to D1
    fetch(`/api/reps/${userId}`, { method:'PUT', headers:{'Content-Type':'application/json'}, credentials:'include',
      body: JSON.stringify({ password: newPw }) }).catch(() => {});
    umToast(`Password reset for ${u.name}`);
    userManagement('users');
  };

  // ── Invite Team Member modal ──────────────────────────────────────────────
  window._umOpenInviteForm = function() {
    const modal = document.createElement('div');
    modal.id = 'um-invite-modal';
    modal.style.cssText = 'position:fixed;inset:0;background:#000000cc;z-index:9999;display:flex;align-items:center;justify-content:center;padding:20px';
    modal.innerHTML = `
<div class="gw-modal-card" style="width:min(520px,100%);max-height:90vh;overflow-y:auto">
  <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:20px">
    <div>
      <h2 style="margin:0 0 4px;font-size:18px">Invite Team Member</h2>
      <p style="margin:0;font-size:13px;color:#6F7E6A">Send a magic-link invite so they can set their own password.</p>
    </div>
    <button onclick="document.getElementById('um-invite-modal').remove()" style="background:none;border:none;color:#6F7E6A;cursor:pointer;font-size:20px;padding:0 4px">&times;</button>
  </div>

  <div style="display:grid;gap:14px">
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
      <div>
        <label class="um-label">Full Name *</label>
        <input id="inv-f-name" class="um-input" type="text" placeholder="e.g. Sarah Johnson">
      </div>
      <div>
        <label class="um-label">Email Address *</label>
        <input id="inv-f-email" class="um-input" type="email" placeholder="sarah@company.com">
      </div>
    </div>

    <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
      <div>
        <label class="um-label">Position / Job Title</label>
        <select id="inv-f-position" class="um-input">
          ${UM_POSITIONS.map(p => `<option value="${umEscape(p)}">${umEscape(p)}</option>`).join('')}
        </select>
      </div>
      <div>
        <label class="um-label">Role (Access Level) *</label>
        <select id="inv-f-role" class="um-input" onchange="window._umInvRoleChanged(this.value)">
          ${UM_ROLE_DEFS.map(r => `<option value="${r.id}" ${r.id==='rep'?'selected':''}>${r.label}</option>`).join('')}
        </select>
      </div>
    </div>

    <div id="inv-role-desc" class="gw-um-role-desc" style="font-size:12px;color:var(--gw-muted);line-height:1.6">
      ${UM_ROLE_DEFS.find(r=>r.id==='rep')?.description || ''}
    </div>

    <div>
      <label class="um-label">Profile Color</label>
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:6px" id="inv-color-picker">
        ${['#4D8A86','#2D7A55','#8B6914','#C97B6A','#6F7E6A'].map((c,i) => `
        <button type="button" onclick="window._umInvPickColor('${c}')" id="inv-clr-${c.replace('#','')}"
          style="width:30px;height:30px;border-radius:8px;background:${c}22;border:2px solid ${i===0?c:'var(--gw-line)'};cursor:pointer;transition:all .12s;position:relative" title="${c}">
          <span style="width:14px;height:14px;border-radius:50%;background:${c};display:block;margin:auto"></span>
          ${i===0?`<span style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:${c};font-size:14px">✓</span>`:''}
        </button>`).join('')}
      </div>
      <input type="hidden" id="inv-f-color" value="#4D8A86">
    </div>

    <div>
      <label class="um-label">Personal Message <span style="font-weight:400;color:#5C6B58">(optional)</span></label>
      <textarea id="inv-f-message" class="um-input" rows="2"
        placeholder="Add a personal note that will appear in the invite email…"
        style="resize:vertical"></textarea>
    </div>

    <div style="background:#4D8A8610;border:1px solid #4D8A8630;border-radius:10px;padding:12px 14px">
      <div style="font-size:12px;color:#4D8A86;font-weight:600;margin-bottom:4px">How it works</div>
      <div style="font-size:12px;color:#5C6B58;line-height:1.6">
        We'll send them an email with a secure magic link. When they click it, they'll land on a setup page to confirm their name and create their own password. They'll be active and ready to log in immediately.
      </div>
    </div>
  </div>

  <div id="inv-error" style="display:none;color:#C97B6A;font-size:13px;margin-top:10px;padding:10px 14px;background:#C97B6A10;border-radius:8px;border:1px solid #C97B6A30"></div>

  <div style="display:flex;gap:10px;margin-top:24px;justify-content:flex-end">
    <button class="secondary-btn" onclick="document.getElementById('um-invite-modal').remove()">Cancel</button>
    <button class="primary-btn" id="inv-send-btn" onclick="window._umSendInvite()">
      Send Invite →
    </button>
  </div>
</div>`;
    document.body.appendChild(modal);

    window._umInvRoleChanged = function(roleId) {
      const desc = document.getElementById('inv-role-desc');
      if (desc) desc.textContent = umRoleDef(roleId).description;
    };
    window._umInvPickColor = function(color) {
      document.getElementById('inv-f-color').value = color;
      document.querySelectorAll('[id^="inv-clr-"]').forEach(btn => {
        const btnColor = '#' + btn.id.replace('inv-clr-','');
        btn.style.border = `2px solid ${color === btnColor ? btnColor : 'var(--gw-line)'}`;
        btn.innerHTML = `<span style="width:14px;height:14px;border-radius:50%;background:${btnColor};display:block;margin:auto"></span>${color===btnColor?`<span style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:${btnColor};font-size:14px">✓</span>`:''}`;
      });
    };
  };

  window._umSendInvite = async function() {
    const name    = document.getElementById('inv-f-name')?.value?.trim() || '';
    const email   = document.getElementById('inv-f-email')?.value?.trim() || '';
    const pos     = document.getElementById('inv-f-position')?.value || 'Sales Rep';
    const role    = document.getElementById('inv-f-role')?.value || 'rep';
    const color   = document.getElementById('inv-f-color')?.value || '#4D8A86';
    const message = document.getElementById('inv-f-message')?.value?.trim() || '';
    const errEl   = document.getElementById('inv-error');
    const btn     = document.getElementById('inv-send-btn');

    if (!name) { errEl.textContent='Full name is required.'; errEl.style.display='block'; return; }
    if (!email || !email.includes('@')) { errEl.textContent='A valid email address is required.'; errEl.style.display='block'; return; }

    btn.disabled = true; btn.textContent = 'Sending…';
    errEl.style.display = 'none';

    try {
      const res = await fetch('/api/auth/invite', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ email, name, inviteRole: role, title: pos, color, message })
      });
      const data = await res.json();
      const payload = data.data || data;
      if (res.ok && payload.invited) {
        document.getElementById('um-invite-modal')?.remove();
        umToast(payload.emailSent
          ? `Invite sent to ${email}! They'll get an email with a setup link.`
          : `Invite created for ${email}. (Email delivery requires SendGrid setup.)`);
        umAddAuditEntry({ type:'invite_sent', userName:name, by:window.getCurrentRep?.()?.name||'Admin' });
        userManagement('users');
      } else {
        errEl.textContent = data.error || payload.error || 'Failed to send invite. Please try again.';
        errEl.style.display = 'block';
        btn.disabled = false; btn.textContent = 'Send Invite →';
      }
    } catch(e) {
      errEl.textContent = 'Network error. Please check your connection.';
      errEl.style.display = 'block';
      btn.disabled = false; btn.textContent = 'Send Invite →';
    }
  };

  window._umResendInvite = async function(userId, userName) {
    if (!confirm(`Resend invite to ${userName}?`)) return;
    try {
      const res = await fetch('/api/auth/resend-invite', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ repId: userId })
      });
      const data = await res.json();
      const payload = data.data || data;
      if (res.ok && payload.resent) {
        umToast(payload.emailSent
          ? `Invite resent to ${payload.email}`
          : `Invite refreshed for ${userName}. (Email delivery requires SendGrid setup.)`);
        userManagement('users');
      } else {
        umToast(data.error || payload.error || 'Failed to resend invite');
      }
    } catch(e) { umToast('Network error: ' + e.message); }
  };

  // Send onboarding packet shortcut — switches to onboarding tab with email pre-filled
  window._umSendOnboardingTo = function(email, name) {
    userManagement('onboarding');
    // After re-render, inject the email
    setTimeout(() => {
      const emailEl = document.getElementById('ob-send-email');
      const selEl   = document.getElementById('ob-send-select');
      if (emailEl) emailEl.value = email;
      if (selEl) {
        // Try to match a select option
        for (let i = 0; i < selEl.options.length; i++) {
          if (selEl.options[i].value === email) { selEl.value = email; break; }
        }
      }
      // Scroll to send section
      const statusEl = document.getElementById('ob-send-status');
      if (statusEl) statusEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
      umToast(`Onboarding tab open — ready to send to ${name}`);
    }, 120);
  };
}

function umUserRow(u, gc) {
  // gc can be passed in from caller or loaded here as fallback
  if (gc === undefined) { const m = umLoadUserGoogle(); gc = m[u.id]; }
  const role = umRoleDef(u.role);
  const googleConnected = gc && gc.token && Date.now() < (gc.expiry || 0);
  const googleEmail     = gc?.email || '';

  // Check invite status from D1 data
  const d1Info = (window._umD1InviteMap || {})[u.id];
  const isPendingInvite = d1Info && d1Info.invite_accepted === 0;
  const inviteSentAt = d1Info?.invite_sent_at;

  return `
<div class="gw-um-user-row" style="${isPendingInvite ? 'opacity:0.85;border:1px solid #8B691430' : ''}">
  <!-- Main row -->
  <div style="display:flex;align-items:center;gap:14px;padding:14px 18px;flex-wrap:wrap;gap:12px">
    ${umColorTile(u.displayName || u.name, u.color, 42)}
    <div style="flex:1;min-width:160px">
      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
        <span style="font-weight:700;font-size:15px;color:#E8E4D9">${umEscape(u.displayName||u.name)}</span>
        ${isPendingInvite
          ? `<span style="font-size:10px;font-weight:700;color:#8B6914;background:#8B691418;border:1px solid rgba(139,105,20,.35);border-radius:20px;padding:2px 8px">⏳ Invite Pending</span>`
          : ''}
      </div>
      <div style="font-size:12px;color:#6F7E6A;margin-top:2px">
        ${umEscape(u.position)}${u.email ? ' · '+umEscape(u.email) : ''}
        ${isPendingInvite && inviteSentAt ? ` · Sent ${umFormatDate(inviteSentAt)}` : ''}
      </div>
    </div>
    <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
      <span style="font-size:11px;font-weight:700;color:${role.color};background:${role.color}18;border:1px solid ${role.color}40;border-radius:20px;padding:2px 10px">${role.label}</span>
      ${isPendingInvite
        ? `<span style="font-size:10px;font-weight:700;color:#8B6914;background:#8B691418;border:1px solid rgba(139,105,20,.25);border-radius:20px;padding:2px 8px">Not Active</span>`
        : umStatusPill(u.status)}
      ${u.mustResetPin && !isPendingInvite ? `<span style="font-size:10px;font-weight:700;color:#8B6914;background:#8B691418;border:1px solid rgba(139,105,20,.25);border-radius:20px;padding:2px 8px">Pw Reset</span>` : ''}
    </div>
    <div style="display:flex;gap:8px;margin-left:auto;flex-wrap:wrap">
      ${isPendingInvite
        ? `<button class="secondary-btn" style="font-size:12px;padding:6px 12px;color:#8B6914;border-color:#8B691440" onclick="window._umResendInvite('${u.id}','${umEscape(u.name)}')">Resend Invite</button>`
        : `<button class="secondary-btn" style="font-size:12px;padding:6px 12px" onclick="window._umResetPin('${u.id}')">Reset Password</button>`}
      <button class="secondary-btn" style="font-size:12px;padding:6px 12px;color:#4D8A86;border-color:#4D8A8640" onclick="window._umSendOnboardingTo('${umEscape(u.email||'')}','${umEscape(u.name)}')" title="Send onboarding packet">✉ Onboarding</button>
      <button class="secondary-btn" style="font-size:12px;padding:6px 12px" onclick="window._umOpenUserForm('${u.id}')">Edit</button>
    </div>
  </div>
  ${isPendingInvite
    ? `<!-- Invite pending strip -->
       <div style="display:flex;align-items:center;gap:10px;padding:8px 18px;background:#8B691408;border-top:1px solid #8B691420;flex-wrap:wrap">
         <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#8B6914" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="opacity:.7"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></svg>
         <span style="font-size:11px;color:#8B6914;font-weight:600">Invite email sent — waiting for user to set up their account</span>
         <span style="font-size:11px;color:var(--gw-muted);margin-left:auto">${u.email||''}</span>
       </div>`
    : `<!-- Google status strip -->
       <div style="display:flex;align-items:center;gap:10px;padding:8px 18px;background:${googleConnected?'#2D7A5508':'var(--gw-surface)'};border-top:1px solid var(--gw-line);flex-wrap:wrap">
         <img src="https://www.google.com/favicon.ico" style="width:13px;height:13px;opacity:.7" alt="G">
         ${googleConnected
           ? `<span style="font-size:11px;color:#2D7A55;font-weight:600">● Google connected as ${umEscape(googleEmail)}</span>
              <div style="display:flex;gap:6px;margin-left:auto">
                ${[['Gmail'],['Cal'],['Drive']].map(([lb])=>`<span style="font-size:10px;color:#2D7A55;background:#2D7A5515;border:1px solid #2D7A5530;border-radius:4px;padding:1px 6px">${lb}</span>`).join('')}
                <button onclick="window._umAdminDisconnectUser('${u.id}')" style="font-size:10px;font-weight:700;color:#C97B6A;background:#C97B6A15;border:1px solid #C97B6A40;border-radius:6px;padding:2px 8px;cursor:pointer;margin-left:4px">Disconnect</button>
              </div>`
           : `<span style="font-size:11px;color:#5C6B58">○ Google not connected</span>
              <span style="font-size:11px;color:var(--gw-muted);margin-left:auto">User connects via Integrations → Google Workspace</span>`
         }
       </div>`
  }
</div>`;
}

// ═══════════════════════════════════════════════════════════════════════════════
// TAB 2 — CREWS (Manage crews + assign to divisions)
// ═══════════════════════════════════════════════════════════════════════════════
async function umRenderCrews(container) {
  container.innerHTML = `<div style="padding:32px;text-align:center;color:var(--gw-text-muted)">Loading crews…</div>`;
  let crews = [], allReps = [];
  try {
    const [cr, rr] = await Promise.all([
      fetch('/api/crews', { credentials:'include' }).then(r=>r.json()),
      fetch('/api/reps', { credentials:'include' }).then(r=>r.json()),
    ]);
    crews   = cr.ok  ? (cr.data  || []) : [];
    allReps = rr.ok  ? (rr.data  || rr.reps || []) : [];
    window._sbState = window._sbState || {};
    window._sbState.crews = crews;
    window._gwAllReps = allReps;
  } catch(e) {}

  const PALETTE = ['#22c55e','#3b82f6','#f59e0b','#ef4444','#8b5cf6','#ec4899','#14b8a6','#f97316','#6366f1','#84cc16'];
  const DIVISIONS = ['General','Landscaping','Lawn Care','Hardscape','Snow & Ice','Maintenance','Irrigation','Install','Other'];

  function renderCrewList() {
    const listEl = document.getElementById('um-crew-list');
    if (!listEl) return;
    listEl.innerHTML = crews.length ? crews.map(cr => {
      const memberNames = (cr.members||[]).map(m => {
        const rep = allReps.find(r=>r.id===m.repId); return rep?.name||m.repId;
      }).join(', ');
      const memberCount = (cr.members||[]).length;
      return `
        <div class="um-crew-card" style="border-left:4px solid ${cr.color}">
          <div class="um-crew-card-header">
            <span class="um-crew-dot" style="background:${cr.color}"></span>
            <div class="um-crew-info">
              <strong style="font-size:14px;color:var(--gw-text,#E8E4D9)">${umEscape(cr.name)}</strong>
              ${cr.division ? `<span class="um-crew-division">${umEscape(cr.division)}</span>` : ''}
            </div>
            <div class="um-crew-member-count">${memberCount} member${memberCount!==1?'s':''}</div>
            <button onclick="umEditCrew('${cr.id}')" style="padding:6px 14px;border-radius:7px;border:1px solid var(--gw-border,#2a3a27);background:var(--gw-surface,#1a2318);color:var(--gw-text,#E8E4D9);font-size:12px;font-weight:600;cursor:pointer">✏ Edit</button>
            <button onclick="umDeleteCrew('${cr.id}')" style="padding:6px 14px;border-radius:7px;border:1px solid #ef444440;background:#ef444410;color:#ef4444;font-size:12px;font-weight:600;cursor:pointer">🗑 Delete</button>
          </div>
          <div class="um-crew-members-preview">
            ${memberNames
              ? memberNames.split(', ').map(n=>`<span style="display:inline-block;background:var(--gw-surface-3,#1f2d1c);border:1px solid var(--gw-border,#2a3a27);border-radius:20px;padding:2px 10px;font-size:12px;margin:2px 4px 2px 0">${umEscape(n)}</span>`).join('')
              : '<span style="color:var(--gw-text-muted,#6F7E6A);font-size:12px;font-style:italic">No members yet — click Edit to add employees</span>'}
          </div>
        </div>`;
    }).join('') : `<p style="color:var(--gw-text-muted);padding:20px 0">No crews yet. Create your first crew below.</p>`;
  }

  container.innerHTML = `
    <div style="padding:24px 0">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:20px">
        <h2 style="font-size:18px;font-weight:700;margin:0">Crews</h2>
        <button id="um-new-crew-btn" class="rp-btn rp-btn--primary" onclick="document.getElementById('um-new-crew-form').style.display='block';this.style.display='none'">+ New Crew</button>
      </div>

      <!-- New Crew Form -->
      <div id="um-new-crew-form" style="display:none;background:var(--gw-surface-2);border:1px solid var(--gw-border);border-radius:12px;padding:20px;margin-bottom:24px">
        <h3 style="font-size:15px;font-weight:700;margin:0 0 16px">Create New Crew</h3>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px">
          <label style="display:flex;flex-direction:column;gap:4px;font-size:12px;font-weight:600;color:var(--gw-text-muted)">
            Crew Name
            <input class="rp-input" id="um-new-crew-name" placeholder="e.g. Alpha Crew">
          </label>
          <label style="display:flex;flex-direction:column;gap:4px;font-size:12px;font-weight:600;color:var(--gw-text-muted)">
            Division
            <select class="rp-input" id="um-new-crew-div">
              <option value="">— No division —</option>
              ${DIVISIONS.map(d=>`<option>${d}</option>`).join('')}
            </select>
          </label>
        </div>
        <div style="margin-bottom:12px">
          <span style="font-size:12px;font-weight:600;color:var(--gw-text-muted);display:block;margin-bottom:6px">Crew Color</span>
          <div style="display:flex;gap:8px;flex-wrap:wrap" id="um-new-crew-palette">
            ${PALETTE.map((c,i)=>`<button class="sb-color-swatch${i===0?' selected':''}" style="background:${c};width:26px;height:26px;border-radius:50%;border:${i===0?'3px solid #fff':'2px solid transparent'};outline:${i===0?'2px solid '+c:'none'};cursor:pointer" data-color="${c}" onclick="umPickNewCrewColor('${c}',this)"></button>`).join('')}
          </div>
        </div>
        <div style="margin-bottom:16px">
          <span style="font-size:12px;font-weight:600;color:var(--gw-text-muted);display:block;margin-bottom:6px">Members</span>
          <div id="um-new-crew-members" style="display:flex;flex-wrap:wrap;gap:6px;min-height:32px;margin-bottom:6px"></div>
          <div style="display:flex;gap:8px">
            <select class="rp-input" id="um-new-crew-emp-sel" style="flex:1">
              <option value="">+ Add member…</option>
              ${allReps.filter(r=>r.active!==false&&r.active!==0).map(r=>`<option value="${r.id}" data-role="${r.role||'laborer'}">${umEscape(r.name)} (${r.role||'rep'})</option>`).join('')}
            </select>
            <select class="rp-input" id="um-new-crew-emp-role" style="width:120px">
              <option value="laborer">Laborer</option>
              <option value="foreman">Foreman</option>
            </select>
            <button class="rp-btn-sm" onclick="umAddNewCrewMember()">Add</button>
          </div>
        </div>
        <div style="display:flex;gap:8px">
          <button class="rp-btn" onclick="document.getElementById('um-new-crew-form').style.display='none';document.getElementById('um-new-crew-btn').style.display=''">Cancel</button>
          <button class="rp-btn rp-btn--primary" onclick="umSaveNewCrew()">Create Crew</button>
        </div>
      </div>

      <!-- Crew List -->
      <div id="um-crew-list"></div>
    </div>

    <style>
      .um-crew-card { background:var(--gw-surface-2);border:1px solid var(--gw-border);border-radius:10px;padding:14px 16px;margin-bottom:12px; }
      .um-crew-card-header { display:flex;align-items:center;gap:10px; }
      .um-crew-dot { width:12px;height:12px;border-radius:50%;flex-shrink:0; }
      .um-crew-info { flex:1;min-width:0; }
      .um-crew-division { font-size:11px;background:var(--gw-surface-3);color:var(--gw-text-muted);padding:2px 8px;border-radius:20px;margin-left:6px; }
      .um-crew-member-count { font-size:12px;color:var(--gw-text-muted);white-space:nowrap; }
      .um-crew-members-preview { font-size:12px;color:var(--gw-text-muted);margin-top:8px;padding-top:8px;border-top:1px solid var(--gw-border); }
      .um-member-chip { display:inline-flex;align-items:center;gap:5px;background:var(--gw-surface-3);border:1px solid var(--gw-border);border-radius:16px;padding:3px 8px;font-size:12px; }
    </style>`;

  renderCrewList();

  // Track new crew selected color
  window._umNewCrewColor = PALETTE[0];
  window._umNewCrewMembers = [];

  window.umPickNewCrewColor = function(color, btn) {
    window._umNewCrewColor = color;
    document.querySelectorAll('#um-new-crew-palette .sb-color-swatch').forEach(b => {
      b.style.border = '2px solid transparent'; b.style.outline = 'none';
    });
    btn.style.border = '3px solid #fff'; btn.style.outline = '2px solid ' + color;
  };

  window.umAddNewCrewMember = function() {
    const sel = document.getElementById('um-new-crew-emp-sel');
    const roleSel = document.getElementById('um-new-crew-emp-role');
    if (!sel?.value) return;
    if (window._umNewCrewMembers.find(m=>m.repId===sel.value)) return;
    const rep = allReps.find(r=>r.id===sel.value);
    window._umNewCrewMembers.push({ repId: sel.value, crewRole: roleSel?.value||'laborer', name: rep?.name||sel.value });
    const el = document.getElementById('um-new-crew-members');
    if (el) {
      const chip = document.createElement('span');
      chip.className = 'um-member-chip';
      chip.dataset.repId = sel.value;
      chip.innerHTML = `${umEscape(rep?.name||sel.value)} <em style="font-size:10px;opacity:.6">${roleSel?.value||'laborer'}</em> <button onclick="umRemoveNewCrewMember('${sel.value}',this.parentElement)" style="background:none;border:none;cursor:pointer;padding:0;font-size:14px;line-height:1;opacity:.5">×</button>`;
      el.appendChild(chip);
    }
    sel.value = '';
  };

  window.umRemoveNewCrewMember = function(repId, chip) {
    window._umNewCrewMembers = window._umNewCrewMembers.filter(m=>m.repId!==repId);
    chip?.remove();
  };

  window.umSaveNewCrew = async function() {
    const name = document.getElementById('um-new-crew-name')?.value?.trim();
    if (!name) { umToast('Crew name required','error'); return; }
    const div = document.getElementById('um-new-crew-div')?.value||null;
    try {
      const r = await fetch('/api/crews', {
        method:'POST', headers:{'Content-Type':'application/json'}, credentials:'include',
        body: JSON.stringify({ name, color: window._umNewCrewColor, division: div||null, members: window._umNewCrewMembers })
      });
      const d = await r.json();
      if (!d.ok) throw new Error(d.error);
      umToast('Crew created!','ok');
      // Refresh crews
      const cr2 = await fetch('/api/crews', { credentials:'include' }).then(r2=>r2.json());
      crews = cr2.data||[];
      window._sbState && (window._sbState.crews = crews);
      window._sbState && (window._sbState.loaded = false);
      renderCrewList();
      document.getElementById('um-new-crew-form').style.display='none';
      document.getElementById('um-new-crew-btn').style.display='';
      window._umNewCrewMembers = [];
      document.getElementById('um-new-crew-members').innerHTML='';
      document.getElementById('um-new-crew-name').value='';
    } catch(e) { umToast('Error: '+e.message,'error'); }
  };

  window.umDeleteCrew = async function(crewId) {
    if (!confirm('Delete this crew? Jobs using it will keep the crew reference but the crew will be inactive.')) return;
    await fetch('/api/crews/'+crewId, { method:'DELETE', credentials:'include' });
    const cr2 = await fetch('/api/crews', { credentials:'include' }).then(r=>r.json());
    crews = cr2.data||[];
    window._sbState && (window._sbState.crews = crews);
    window._sbState && (window._sbState.loaded = false);
    renderCrewList();
    umToast('Crew deleted','ok');
  };

  window.umEditCrew = function(crewId) {
    const crew = crews.find(c=>c.id===crewId);
    if (!crew) return;

    // Deep-copy members so cancel doesn't mutate
    let editMembers = (crew.members||[]).map(m=>({ ...m }));
    let editColor = crew.color || PALETTE[0];

    // Remove any existing modal
    document.getElementById('um-edit-crew-modal')?.remove();

    const modal = document.createElement('div');
    modal.id = 'um-edit-crew-modal';
    modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:9999;display:flex;align-items:center;justify-content:center;padding:16px';

    function buildMemberChips() {
      return editMembers.map(m => {
        const rep = allReps.find(r=>r.id===m.repId);
        const nm  = rep?.name || m.repId;
        return `<span class="um-member-chip" data-rep="${m.repId}">
          <span style="font-weight:600">${umEscape(nm)}</span>
          <span style="font-size:10px;opacity:.6;margin-left:3px">${m.crewRole||'laborer'}</span>
          <button onclick="umEditCrewRemoveMember('${m.repId}')" style="background:none;border:none;cursor:pointer;padding:0 0 0 4px;font-size:15px;line-height:1;opacity:.5;color:inherit">×</button>
        </span>`;
      }).join('');
    }

    const activeReps = allReps.filter(r=>r.active!==false&&r.active!==0);

    modal.innerHTML = `
    <div style="background:var(--gw-surface,#1a2318);border:1px solid var(--gw-border,#2a3a27);border-radius:16px;width:100%;max-width:540px;max-height:90vh;overflow-y:auto;box-shadow:0 24px 60px rgba(0,0,0,.5)">
      <!-- Header -->
      <div style="display:flex;align-items:center;justify-content:space-between;padding:20px 24px;border-bottom:1px solid var(--gw-border,#2a3a27)">
        <h2 style="margin:0;font-size:17px;font-weight:700;color:var(--gw-text,#E8E4D9)">Edit Crew</h2>
        <button onclick="document.getElementById('um-edit-crew-modal').remove()" style="background:none;border:none;cursor:pointer;font-size:20px;color:var(--gw-text-muted,#6F7E6A);line-height:1;padding:4px">×</button>
      </div>

      <!-- Body -->
      <div style="padding:24px">

        <!-- Name + Division -->
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:16px">
          <label style="display:flex;flex-direction:column;gap:5px;font-size:12px;font-weight:600;color:var(--gw-text-muted,#6F7E6A)">
            Crew Name
            <input class="rp-input" id="ec-name" value="${umEscape(crew.name)}" placeholder="Crew name" style="font-size:14px">
          </label>
          <label style="display:flex;flex-direction:column;gap:5px;font-size:12px;font-weight:600;color:var(--gw-text-muted,#6F7E6A)">
            Division
            <select class="rp-input" id="ec-div" style="font-size:14px">
              <option value="">— No division —</option>
              ${DIVISIONS.map(d=>`<option ${crew.division===d?'selected':''}>${umEscape(d)}</option>`).join('')}
            </select>
          </label>
        </div>

        <!-- Color -->
        <div style="margin-bottom:16px">
          <div style="font-size:12px;font-weight:600;color:var(--gw-text-muted,#6F7E6A);margin-bottom:8px">Crew Color</div>
          <div style="display:flex;gap:8px;flex-wrap:wrap" id="ec-palette">
            ${PALETTE.map(c=>`<button onclick="umEditCrewPickColor('${c}',this)" style="width:28px;height:28px;border-radius:50%;background:${c};border:${c===editColor?'3px solid #fff':'2px solid transparent'};outline:${c===editColor?'2px solid '+c:'none'};cursor:pointer;flex-shrink:0"></button>`).join('')}
          </div>
        </div>

        <!-- Members -->
        <div style="margin-bottom:20px">
          <div style="font-size:12px;font-weight:600;color:var(--gw-text-muted,#6F7E6A);margin-bottom:8px">Members</div>
          <div id="ec-members" style="display:flex;flex-wrap:wrap;gap:6px;min-height:36px;padding:8px;background:var(--gw-surface-2,#131c11);border:1px solid var(--gw-border,#2a3a27);border-radius:8px;margin-bottom:8px">
            ${editMembers.length ? buildMemberChips() : '<span style="font-size:12px;color:var(--gw-text-muted,#6F7E6A)">No members yet — add below</span>'}
          </div>
          <div style="display:flex;gap:8px">
            <select class="rp-input" id="ec-emp-sel" style="flex:1;font-size:13px">
              <option value="">+ Add employee…</option>
              ${activeReps.map(r=>`<option value="${r.id}">${umEscape(r.name)} (${r.role||'rep'})</option>`).join('')}
            </select>
            <select class="rp-input" id="ec-emp-role" style="width:110px;font-size:13px">
              <option value="laborer">Laborer</option>
              <option value="foreman">Foreman</option>
            </select>
            <button class="rp-btn-sm" onclick="umEditCrewAddMember()">Add</button>
          </div>
        </div>

        <!-- Error -->
        <div id="ec-error" style="display:none;color:#ef4444;font-size:13px;margin-bottom:12px"></div>

        <!-- Footer -->
        <div style="display:flex;gap:8px;justify-content:flex-end">
          <button class="rp-btn" onclick="document.getElementById('um-edit-crew-modal').remove()">Cancel</button>
          <button class="rp-btn rp-btn--primary" onclick="umSaveEditCrew('${crewId}')">Save Changes</button>
        </div>
      </div>
    </div>`;

    document.body.appendChild(modal);
    // close on backdrop click
    modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });

    // ── helpers scoped to this modal ──────────────────────────────────────────
    window.umEditCrewPickColor = function(color, btn) {
      editColor = color;
      document.querySelectorAll('#ec-palette button').forEach(b => {
        b.style.border = '2px solid transparent'; b.style.outline = 'none';
      });
      btn.style.border = '3px solid #fff'; btn.style.outline = '2px solid ' + color;
    };

    window.umEditCrewAddMember = function() {
      const sel = document.getElementById('ec-emp-sel');
      const roleSel = document.getElementById('ec-emp-role');
      if (!sel?.value) return;
      if (editMembers.find(m=>m.repId===sel.value)) { umToast('Already in crew'); return; }
      const rep = allReps.find(r=>r.id===sel.value);
      editMembers.push({ repId: sel.value, crewRole: roleSel?.value||'laborer', name: rep?.name||sel.value });
      const el = document.getElementById('ec-members');
      if (el) el.innerHTML = buildMemberChips();
      sel.value = '';
    };

    window.umEditCrewRemoveMember = function(repId) {
      editMembers = editMembers.filter(m=>m.repId!==repId);
      const el = document.getElementById('ec-members');
      if (el) el.innerHTML = editMembers.length ? buildMemberChips() : '<span style="font-size:12px;color:var(--gw-text-muted,#6F7E6A)">No members yet</span>';
    };

    window.umSaveEditCrew = async function(crewId) {
      const name = document.getElementById('ec-name')?.value?.trim();
      const div  = document.getElementById('ec-div')?.value || null;
      const errEl = document.getElementById('ec-error');
      if (!name) { errEl.textContent='Crew name is required'; errEl.style.display='block'; return; }
      errEl.style.display = 'none';
      try {
        await fetch('/api/crews/'+crewId, {
          method:'PUT', headers:{'Content-Type':'application/json'}, credentials:'include',
          body: JSON.stringify({ name, color: editColor, division: div||null })
        });
        await fetch('/api/crews/'+crewId+'/members', {
          method:'PUT', headers:{'Content-Type':'application/json'}, credentials:'include',
          body: JSON.stringify({ members: editMembers })
        });
        const cr2 = await fetch('/api/crews', { credentials:'include' }).then(r=>r.json());
        crews = cr2.data||[];
        window._sbState && (window._sbState.crews = crews);
        window._sbState && (window._sbState.loaded = false);
        renderCrewList();
        document.getElementById('um-edit-crew-modal')?.remove();
        umToast('Crew updated!');
      } catch(e) { errEl.textContent='Error: '+e.message; errEl.style.display='block'; }
    };
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// TAB 3 — ONBOARDING PACKET BUILDER
// ═══════════════════════════════════════════════════════════════════════════════
const LS_ONBOARD_KEY = 'avalonOnboardingPacket';

function umLoadOnboardPacket() {
  try {
    const raw = localStorage.getItem(LS_ONBOARD_KEY);
    if (raw) return JSON.parse(raw);
  } catch(_) {}
  // Default packet — mirrors Avalon's existing Google Drawing
  return {
    companyName: 'Avalon Landscape Construction',
    contactEmail: 'Admin@avalon-lc.com',
    websiteUrl: 'https://avalon-lc.com',
    logoUrl: '',
    welcomeMsg: 'Welcome to the team! Please complete the following steps to get started.',
    steps: [
      { label: 'Complete legal forms', links: [
          { text: 'W-4 Form',       url: '' },
          { text: 'Payroll Form',   url: '' },
          { text: 'I-9 Form',       url: '' },
          { text: 'VA-4 Form',      url: '' }
        ]
      },
      { label: 'Review and sign the employee agreement', links: [
          { text: 'Employee Agreement Form', url: '' }
        ]
      },
      { label: 'Fill out the uniform / swag form to receive your company gear', links: [
          { text: 'Swag & Uniform Form', url: '' }
        ]
      },
      { label: 'Print and turn in all forms — or email completed forms to begin employment', links: [] }
    ]
  };
}

function umSaveOnboardPacket(packet) {
  try { localStorage.setItem(LS_ONBOARD_KEY, JSON.stringify(packet)); } catch(_) {}
}

function umRenderOnboarding(container) {
  const packet = umLoadOnboardPacket();
  const users  = umLoadUsers().filter(u => u.status === 'active');

  // ── Helpers ──────────────────────────────────────────────────────────────
  function esc(s) { return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

  // Step icons by index
  const STEP_ICONS = ['📋','✍️','👕','📬','📎','📁','🔑','📞'];

  function stepRowHtml(step, si) {
    const icon = STEP_ICONS[si] || '📌';
    const linkInputs = step.links.map((lk, li) => `
      <div style="display:flex;gap:8px;align-items:center;margin-bottom:6px;background:#F8F9FB;border:1px solid #E5E9F0;border-radius:8px;padding:8px 10px">
        <span style="font-size:14px;flex-shrink:0;opacity:.5">🔗</span>
        <input type="text" placeholder="Link label" value="${esc(lk.text)}"
          oninput="window._obUpdateLink(${si},${li},'text',this.value)"
          style="flex:0 0 130px;font-size:12px;padding:5px 9px;border:1px solid #D8DEE8;border-radius:6px;background:#fff;color:var(--gds-ink);outline:none;transition:border .15s"
          onfocus="this.style.borderColor='#4D8A86'" onblur="this.style.borderColor='#D8DEE8'">
        <input type="url" placeholder="https://..." value="${esc(lk.url)}"
          oninput="window._obUpdateLink(${si},${li},'url',this.value)"
          style="flex:1;font-size:12px;padding:5px 9px;border:1px solid #D8DEE8;border-radius:6px;background:#fff;color:var(--gds-ink);outline:none;transition:border .15s"
          onfocus="this.style.borderColor='#4D8A86'" onblur="this.style.borderColor='#D8DEE8'">
        <button onclick="window._obRemoveLink(${si},${li})"
          style="background:#FEF2F2;border:1px solid #FECACA;border-radius:6px;cursor:pointer;color:#DC2626;font-size:13px;padding:3px 8px;line-height:1;transition:all .15s"
          onmouseover="this.style.background='#FEE2E2'" onmouseout="this.style.background='#FEF2F2'" title="Remove">×</button>
      </div>`).join('');
    return `
    <div id="ob-step-${si}" style="background:#FFFFFF;border:1px solid #E5E9F0;border-radius:12px;padding:0;margin-bottom:10px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.04)">
      <!-- Step header bar -->
      <div style="background:linear-gradient(135deg,#F0F7F6 0%,#EAF4F3 100%);border-bottom:1px solid #DCF0EE;padding:12px 14px;display:flex;align-items:center;gap:10px">
        <span style="flex-shrink:0;width:28px;height:28px;border-radius:8px;background:linear-gradient(135deg,#4D8A86,#3a6e6b);color:#fff;font-size:12px;font-weight:800;display:flex;align-items:center;justify-content:center;box-shadow:0 2px 6px rgba(77,138,134,.35)">${si+1}</span>
        <span style="font-size:16px;flex-shrink:0">${icon}</span>
        <input type="text" value="${esc(step.label)}"
          oninput="window._obUpdateStep(${si},'label',this.value)"
          style="flex:1;font-size:13px;font-weight:600;padding:5px 10px;border:1px solid #C8DDD9;border-radius:7px;background:#fff;color:var(--gds-ink);outline:none;transition:border .15s;box-shadow:inset 0 1px 2px rgba(0,0,0,.04)"
          onfocus="this.style.borderColor='#4D8A86';this.style.boxShadow='0 0 0 3px rgba(77,138,134,.12)'"
          onblur="this.style.borderColor='#C8DDD9';this.style.boxShadow='inset 0 1px 2px rgba(0,0,0,.04)'">
        <button onclick="window._obRemoveStep(${si})"
          style="background:none;border:none;cursor:pointer;color:#9CA3AF;font-size:20px;padding:0 4px;line-height:1;flex-shrink:0;transition:color .15s"
          onmouseover="this.style.color='#DC2626'" onmouseout="this.style.color='#9CA3AF'" title="Remove step">×</button>
      </div>
      <!-- Links area -->
      <div id="ob-links-${si}" style="padding:12px 14px 10px 14px">
        ${linkInputs}
        <button onclick="window._obAddLink(${si})"
          style="font-size:11px;padding:5px 12px;border-radius:6px;border:1.5px dashed #A8D0CC;background:none;color:#4D8A86;cursor:pointer;font-weight:600;transition:all .15s;width:100%;text-align:center"
          onmouseover="this.style.background='#F0FAF8';this.style.borderColor='#4D8A86'"
          onmouseout="this.style.background='none';this.style.borderColor='#A8D0CC'">
          + Add Link
        </button>
      </div>
    </div>`;
  }

  function previewHtml(p) {
    const initial = esc((p.companyName||'A')[0].toUpperCase());
    const stepBlocks = p.steps.map((s,i) => {
      const icon = STEP_ICONS[i] || '📌';
      const links = s.links.filter(l=>l.text||l.url);
      const linkLine = links.map(l =>
        l.url
          ? `<a href="${esc(l.url)}" style="display:inline-flex;align-items:center;gap:5px;color:#2D7F7B;font-weight:600;text-decoration:none;background:#EAF6F5;border:1px solid #C0E0DE;border-radius:5px;padding:3px 9px;font-size:12px;margin:2px 3px 2px 0">
               <span style="font-size:11px">🔗</span>${esc(l.text||l.url)}
             </a>`
          : `<span style="display:inline-flex;align-items:center;gap:4px;color:#2D7F7B;font-weight:600;background:#EAF6F5;border:1px solid #C0E0DE;border-radius:5px;padding:3px 9px;font-size:12px;margin:2px 3px 2px 0">${esc(l.text)}</span>`
      ).join('');
      return `
        <div style="display:flex;gap:14px;padding:14px 0;border-bottom:1px solid #F0F4F8;align-items:flex-start">
          <div style="flex-shrink:0;margin-top:1px">
            <div style="width:30px;height:30px;border-radius:50%;background:linear-gradient(135deg,#4D8A86,#3a6e6b);color:#fff;font-size:11px;font-weight:800;display:flex;align-items:center;justify-content:center;box-shadow:0 2px 8px rgba(77,138,134,.3)">${i+1}</div>
          </div>
          <div style="flex:1">
            <div style="display:flex;align-items:center;gap:6px;margin-bottom:${links.length?'6':'0'}px">
              <span style="font-size:15px">${icon}</span>
              <span style="font-size:13px;font-weight:600;color:#1A2020">${esc(s.label)}</span>
            </div>
            ${links.length ? `<div style="margin-left:2px">${linkLine}</div>` : ''}
          </div>
        </div>`;
    }).join('');

    const footerDomain = p.websiteUrl ? p.websiteUrl.replace(/^https?:\/\//,'') : '';

    return `
      <div style="border-radius:14px;overflow:hidden;border:1px solid #D4DAE5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;box-shadow:0 4px 20px rgba(0,0,0,.08)">
        <!-- Header with gradient -->
        <div style="background:linear-gradient(135deg,#0F1F1E 0%,#1A3332 50%,#1C3D3A 100%);padding:22px 24px;display:flex;align-items:center;gap:16px;position:relative;overflow:hidden">
          <div style="position:absolute;top:-20px;right:-20px;width:100px;height:100px;border-radius:50%;background:rgba(58,184,197,.12)"></div>
          <div style="position:absolute;bottom:-30px;right:60px;width:70px;height:70px;border-radius:50%;background:rgba(77,138,134,.15)"></div>
          ${p.logoUrl
            ? `<img src="${esc(p.logoUrl)}" style="height:48px;border-radius:8px;box-shadow:0 2px 8px rgba(0,0,0,.3)" alt="logo">`
            : `<div style="width:48px;height:48px;border-radius:10px;background:linear-gradient(135deg,#3AB8C5,#2D9AA8);display:flex;align-items:center;justify-content:center;font-size:22px;font-weight:900;color:#fff;box-shadow:0 4px 12px rgba(58,184,197,.4);flex-shrink:0">${initial}</div>`}
          <div style="z-index:1">
            <div style="color:rgba(255,255,255,.6);font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.15em;margin-bottom:3px">Employee Onboarding</div>
            <div style="color:#fff;font-size:17px;font-weight:800;text-transform:uppercase;letter-spacing:.04em;line-height:1.1">${esc(p.companyName)}</div>
          </div>
          <div style="margin-left:auto;z-index:1">
            <div style="background:rgba(58,184,197,.2);border:1px solid rgba(58,184,197,.4);border-radius:20px;padding:4px 12px">
              <span style="color:#3AB8C5;font-size:10px;font-weight:700;letter-spacing:.08em">NEW HIRE</span>
            </div>
          </div>
        </div>
        <!-- Welcome message -->
        ${p.welcomeMsg ? `
        <div style="background:linear-gradient(135deg,#F7FAF9,#F0F7F6);padding:14px 24px;border-bottom:1px solid #E0ECEB;display:flex;gap:10px;align-items:flex-start">
          <span style="font-size:16px;flex-shrink:0;margin-top:1px">👋</span>
          <p style="margin:0;font-size:13px;color:#2D4D4B;line-height:1.55;font-style:italic">${esc(p.welcomeMsg)}</p>
        </div>` : ''}
        <!-- Steps -->
        <div style="background:#fff;padding:4px 24px 8px">${stepBlocks}</div>
        <!-- Footer info bar -->
        ${p.contactEmail ? `
        <div style="background:#F7FAF9;border-top:1px solid #E0ECEB;padding:12px 24px;display:flex;align-items:center;gap:8px">
          <span style="font-size:14px">📩</span>
          <span style="font-size:12px;color:#4A6360">Submit completed forms to <strong style="color:#2D4D4B">${esc(p.contactEmail)}</strong> to begin employment.</span>
        </div>` : ''}
        <!-- Bottom brand bar -->
        ${p.websiteUrl ? `
        <div style="background:linear-gradient(135deg,#3AB8C5,#2D9AA8);padding:11px 24px;display:flex;align-items:center;justify-content:center;gap:12px">
          <span style="color:rgba(255,255,255,.7);font-size:12px">🌐</span>
          <a href="${esc(p.websiteUrl)}" style="color:#fff;font-size:13px;font-weight:700;text-decoration:none;letter-spacing:.02em">${esc(footerDomain)}</a>
          <span style="color:rgba(255,255,255,.4);font-size:11px">·</span>
          <span style="color:rgba(255,255,255,.7);font-size:12px">Powered by Groundwork CRM</span>
        </div>` : ''}
      </div>`;
  }

  // ── Render ────────────────────────────────────────────────────────────────
  container.innerHTML = `
<style>
  .ob-card { background:#fff;border:1px solid #E5E9F0;border-radius:14px;margin-bottom:16px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,.05) }
  .ob-card-header { background:linear-gradient(135deg,#F8F9FC 0%,#F2F5FA 100%);border-bottom:1px solid #E5E9F0;padding:13px 18px;display:flex;align-items:center;gap:10px }
  .ob-card-header-icon { font-size:16px }
  .ob-card-header-label { font-size:11px;font-weight:800;color:#4A5568;text-transform:uppercase;letter-spacing:.1em }
  .ob-card-body { padding:16px 18px }
  .ob-field-label { font-size:11px;font-weight:600;color:#6B7280;display:block;margin-bottom:5px;letter-spacing:.02em }
  .ob-input { width:100%;font-size:13px;padding:8px 11px;border:1px solid #D1D5DB;border-radius:8px;background:#FAFBFC;color:var(--gds-ink);outline:none;transition:all .15s;box-sizing:border-box }
  .ob-input:focus { border-color:#4D8A86;box-shadow:0 0 0 3px rgba(77,138,134,.12);background:#fff }
  .ob-textarea { width:100%;font-size:12.5px;padding:8px 11px;border:1px solid #D1D5DB;border-radius:8px;background:#FAFBFC;color:var(--gds-ink);resize:vertical;outline:none;transition:all .15s;box-sizing:border-box;line-height:1.5 }
  .ob-textarea:focus { border-color:#4D8A86;box-shadow:0 0 0 3px rgba(77,138,134,.12);background:#fff }
  .ob-field-row { margin-bottom:12px }
  .ob-field-row:last-child { margin-bottom:0 }
  .ob-add-step-btn { width:100%;padding:10px;border-radius:10px;border:2px dashed #B2D4D1;background:linear-gradient(135deg,#F0FAF8,#EAF6F5);color:#4D8A86;font-size:13px;font-weight:700;cursor:pointer;transition:all .2s;margin-top:6px;letter-spacing:.01em }
  .ob-add-step-btn:hover { border-color:#4D8A86;background:linear-gradient(135deg,#E0F7F4,#D8F4F0);box-shadow:0 2px 8px rgba(77,138,134,.15) }
  .ob-send-btn { padding:10px 22px;border-radius:9px;background:linear-gradient(135deg,#4D8A86,#3a6e6b);color:#fff;border:none;font-size:13px;font-weight:700;cursor:pointer;white-space:nowrap;letter-spacing:.02em;transition:all .2s;box-shadow:0 2px 8px rgba(77,138,134,.3) }
  .ob-send-btn:hover { background:linear-gradient(135deg,#3a6e6b,#2d5655);box-shadow:0 4px 14px rgba(77,138,134,.4);transform:translateY(-1px) }
  .ob-send-btn:active { transform:translateY(0) }
  .ob-section-badge { display:inline-flex;align-items:center;gap:5px;font-size:10px;font-weight:700;color:#4D8A86;background:#EAF6F5;border:1px solid #C0E0DE;border-radius:20px;padding:2px 9px;letter-spacing:.05em }
  .ob-auto-save-note { font-size:11px;color:#9CA3AF;display:flex;align-items:center;gap:6px;padding:10px 0 0 }
</style>

<div style="display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:28px;align-items:start">

  <!-- ════════════ LEFT: Packet Builder ════════════ -->
  <div>
    <!-- Page header -->
    <div style="margin-bottom:20px">
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:4px">
        <h3 style="margin:0;font-size:16px;font-weight:800;color:var(--gds-ink)">Onboarding Packet</h3>
        <span class="ob-section-badge">✏️ Builder</span>
      </div>
      <p style="margin:0;font-size:12px;color:#6B7280;line-height:1.5">Configure the packet sent to every new hire. All changes save to this browser automatically.</p>
    </div>

    <!-- Company Info card -->
    <div class="ob-card">
      <div class="ob-card-header">
        <span class="ob-card-header-icon">🏢</span>
        <span class="ob-card-header-label">Company Info</span>
      </div>
      <div class="ob-card-body" style="display:grid;gap:0">
        <div class="ob-field-row">
          <label class="ob-field-label">Company Name</label>
          <input type="text" id="ob-company" value="${esc(packet.companyName)}" class="ob-input"
            oninput="window._obField('companyName',this.value)" placeholder="Your company name">
        </div>
        <div class="ob-field-row" style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
          <div>
            <label class="ob-field-label">Contact / Admin Email</label>
            <input type="email" id="ob-email" value="${esc(packet.contactEmail)}" class="ob-input"
              oninput="window._obField('contactEmail',this.value)" placeholder="admin@company.com">
          </div>
          <div>
            <label class="ob-field-label">Website URL</label>
            <input type="url" id="ob-website" value="${esc(packet.websiteUrl)}" class="ob-input"
              oninput="window._obField('websiteUrl',this.value)" placeholder="https://...">
          </div>
        </div>
        <div class="ob-field-row">
          <label class="ob-field-label">Welcome Message <span style="font-weight:400;opacity:.7">(optional)</span></label>
          <textarea id="ob-welcome" rows="2" class="ob-textarea"
            oninput="window._obField('welcomeMsg',this.value)"
            placeholder="Welcome to the team! Here's everything you need to get started.">${esc(packet.welcomeMsg)}</textarea>
        </div>
      </div>
    </div>

    <!-- Steps card -->
    <div class="ob-card">
      <div class="ob-card-header" style="justify-content:space-between">
        <div style="display:flex;align-items:center;gap:10px">
          <span class="ob-card-header-icon">📋</span>
          <span class="ob-card-header-label">Onboarding Steps</span>
        </div>
        <span style="font-size:11px;color:#9CA3AF;font-weight:500">${packet.steps.length} step${packet.steps.length!==1?'s':''}</span>
      </div>
      <div class="ob-card-body">
        <div id="ob-steps-list">
          ${packet.steps.map((s,i) => stepRowHtml(s,i)).join('')}
        </div>
        <button class="ob-add-step-btn" onclick="window._obAddStep()">＋ Add Step</button>
      </div>
    </div>

    <div class="ob-auto-save-note">
      <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><circle cx="6" cy="6" r="5.5" stroke="#9CA3AF"/><path d="M6 3.5v3l2 1.5" stroke="#9CA3AF" stroke-linecap="round"/></svg>
      Changes save to this browser automatically · Use <strong style="color:#4D8A86;margin:0 3px">✉ Onboarding</strong> on any team member card to pre-fill the send form
    </div>
  </div>

  <!-- ════════════ RIGHT: Preview + Send ════════════ -->
  <div>
    <!-- Preview header -->
    <div style="margin-bottom:16px;display:flex;align-items:center;justify-content:space-between">
      <div>
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:4px">
          <h3 style="margin:0;font-size:16px;font-weight:800;color:var(--gds-ink)">Live Preview</h3>
          <span class="ob-section-badge">👁 Real-time</span>
        </div>
        <p style="margin:0;font-size:12px;color:#6B7280">Exactly what your new hire receives.</p>
      </div>
    </div>

    <!-- Preview frame with subtle shadow -->
    <div style="border-radius:16px;padding:2px;background:linear-gradient(135deg,#E0ECEB,#D8E8F4);box-shadow:0 8px 32px rgba(0,0,0,.1)">
      <div id="ob-preview" style="border-radius:14px;overflow:hidden">
        ${previewHtml(packet)}
      </div>
    </div>

    <!-- Send panel card -->
    <div class="ob-card" style="margin-top:20px">
      <div class="ob-card-header">
        <span class="ob-card-header-icon">✉️</span>
        <span class="ob-card-header-label">Send Onboarding Packet</span>
      </div>
      <div class="ob-card-body">
        <p style="margin:0 0 12px;font-size:12.5px;color:#6B7280;line-height:1.5">Choose a team member or enter any email address to send the packet directly.</p>

        <!-- Team member picker -->
        <div class="ob-field-row">
          <label class="ob-field-label">Quick-fill from team</label>
          <div style="position:relative">
            <select id="ob-send-select" onchange="document.getElementById('ob-send-email').value=this.value"
              style="width:100%;font-size:12.5px;padding:8px 32px 8px 11px;border:1px solid #D1D5DB;border-radius:8px;background:#FAFBFC;color:var(--gds-ink);outline:none;cursor:pointer;appearance:none;transition:all .15s"
              onfocus="this.style.borderColor='#4D8A86';this.style.boxShadow='0 0 0 3px rgba(77,138,134,.12)'"
              onblur="this.style.borderColor='#D1D5DB';this.style.boxShadow='none'">
              <option value="">— Pick team member —</option>
              ${users.map(u => `<option value="${esc(u.email||'')}">${esc(u.name)}${u.email?' · '+esc(u.email):''}</option>`).join('')}
            </select>
            <svg style="position:absolute;right:10px;top:50%;transform:translateY(-50%);pointer-events:none;color:#9CA3AF" width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M3.5 5.5L7 9l3.5-3.5" stroke="#9CA3AF" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
          </div>
        </div>

        <!-- Email + Send row -->
        <div class="ob-field-row">
          <label class="ob-field-label">Or enter email directly</label>
          <div style="display:flex;gap:8px">
            <div style="flex:1;position:relative">
              <svg style="position:absolute;left:10px;top:50%;transform:translateY(-50%)" width="14" height="14" viewBox="0 0 14 14" fill="none"><rect x="1" y="3" width="12" height="8" rx="1.5" stroke="#9CA3AF" stroke-width="1.2"/><path d="M1 4.5l6 4 6-4" stroke="#9CA3AF" stroke-width="1.2"/></svg>
              <input type="email" id="ob-send-email" placeholder="hire@example.com"
                style="width:100%;font-size:12.5px;padding:8px 11px 8px 30px;border:1px solid #D1D5DB;border-radius:8px;background:#FAFBFC;color:var(--gds-ink);outline:none;transition:all .15s;box-sizing:border-box"
                onfocus="this.style.borderColor='#4D8A86';this.style.boxShadow='0 0 0 3px rgba(77,138,134,.12)';this.style.background='#fff'"
                onblur="this.style.borderColor='#D1D5DB';this.style.boxShadow='none';this.style.background='#FAFBFC'">
            </div>
            <button class="ob-send-btn" onclick="window._obSendPacket()">Send ✉</button>
          </div>
        </div>

        <!-- Status message -->
        <div id="ob-send-status" style="min-height:22px;font-size:12px;transition:all .2s"></div>
      </div>
    </div>
  </div>

</div>
`;

  // ── Helpers — live packet mutation + preview refresh ──────────────────────
  let _obPacket = JSON.parse(JSON.stringify(packet));

  function _obRefreshPreview() {
    umSaveOnboardPacket(_obPacket);
    const prev = document.getElementById('ob-preview');
    if (prev) prev.innerHTML = previewHtml(_obPacket);
  }
  function _obRefreshSteps() {
    const list = document.getElementById('ob-steps-list');
    if (list) list.innerHTML = _obPacket.steps.map((s,i) => stepRowHtml(s,i)).join('');
    // Update step count badge
    const countBadge = document.querySelector('.ob-card-header [style*="color:#9CA3AF"]');
    if (countBadge) countBadge.textContent = `${_obPacket.steps.length} step${_obPacket.steps.length!==1?'s':''}`;
    _obRefreshPreview();
  }

  window._obField = function(key, val) {
    _obPacket[key] = val;
    _obRefreshPreview();
  };
  window._obUpdateStep = function(si, key, val) {
    _obPacket.steps[si][key] = val;
    _obRefreshPreview();
  };
  window._obAddStep = function() {
    _obPacket.steps.push({ label: 'New step — describe what to do', links: [] });
    _obRefreshSteps();
  };
  window._obRemoveStep = function(si) {
    _obPacket.steps.splice(si, 1);
    _obRefreshSteps();
  };
  window._obUpdateLink = function(si, li, key, val) {
    _obPacket.steps[si].links[li][key] = val;
    _obRefreshPreview();
  };
  window._obAddLink = function(si) {
    _obPacket.steps[si].links.push({ text: '', url: '' });
    _obRefreshSteps();
  };
  window._obRemoveLink = function(si, li) {
    _obPacket.steps[si].links.splice(li, 1);
    _obRefreshSteps();
  };
  window._obSendPacket = async function() {
    const emailEl = document.getElementById('ob-send-email');
    const statusEl = document.getElementById('ob-send-status');
    const email = (emailEl?.value || '').trim();
    if (!email) {
      if (statusEl) statusEl.innerHTML = '<span style="display:inline-flex;align-items:center;gap:6px;background:#FEF3C7;border:1px solid #FCD34D;border-radius:6px;padding:5px 10px;color:#92400E;font-weight:600">⚠️ Enter an email address first.</span>';
      return;
    }
    if (statusEl) statusEl.innerHTML = '<span style="display:inline-flex;align-items:center;gap:6px;background:#F0F9FF;border:1px solid #BAE6FD;border-radius:6px;padding:5px 10px;color:#0369A1;font-weight:600"><svg width="14" height="14" viewBox="0 0 14 14" fill="none" style="animation:spin 1s linear infinite"><circle cx="7" cy="7" r="5" stroke="#0369A1" stroke-width="2" stroke-dasharray="22" stroke-dashoffset="10"/></svg>Sending packet…</span><style>@keyframes spin{to{transform:rotate(360deg)}}</style>';
    // Build plain-text version of the packet for the email body
    const p = _obPacket;
    const stepsText = p.steps.map((s,i) => {
      const linkParts = s.links.filter(l=>l.text||l.url).map(l => l.url ? `${l.text}: ${l.url}` : l.text);
      return `Step ${i+1}) ${s.label}${linkParts.length ? '\n   ' + linkParts.join('\n   ') : ''}`;
    }).join('\n\n');
    const bodyText = [
      `${p.welcomeMsg || ''}`,
      `\n${stepsText}`,
      p.contactEmail ? `\nPrint and return all forms or email to ${p.contactEmail} to begin employment.` : '',
      p.websiteUrl ? `\n${p.websiteUrl}` : ''
    ].join('\n').trim();
    try {
      const res = await fetch('/api/invite', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          name: email.split('@')[0],
          email,
          role: 'laborer',
          isOnboarding: true,
          onboardingSubject: `Welcome to ${p.companyName} — Onboarding Packet`,
          onboardingBody: bodyText
        })
      });
      const j = await res.json();
      if (statusEl) {
        if (j.emailSent || j.ok !== false) {
          statusEl.innerHTML = `<span style="display:inline-flex;align-items:center;gap:6px;background:#ECFDF5;border:1px solid #6EE7B7;border-radius:6px;padding:5px 10px;color:#065F46;font-weight:600">✅ Packet sent to ${email}</span>`;
          if (emailEl) emailEl.value = '';
          const sel = document.getElementById('ob-send-select');
          if (sel) sel.value = '';
          setTimeout(() => { if (statusEl) statusEl.innerHTML = ''; }, 5000);
        } else {
          statusEl.innerHTML = `<span style="display:inline-flex;align-items:center;gap:6px;background:#FEF2F2;border:1px solid #FECACA;border-radius:6px;padding:5px 10px;color:#991B1B;font-weight:600">❌ ${j.error || 'Send failed — check Integrations.'}</span>`;
        }
      }
    } catch(e) {
      if (statusEl) statusEl.innerHTML = `<span style="display:inline-flex;align-items:center;gap:6px;background:#FEF2F2;border:1px solid #FECACA;border-radius:6px;padding:5px 10px;color:#991B1B;font-weight:600">❌ Network error: ${e.message}</span>`;
    }
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// TAB 3 — ROLES & PERMISSIONS
// ═══════════════════════════════════════════════════════════════════════════════
// ── Company-default nav perms (stored separately from live perms) ──────────
const LS_COMPANY_DEFAULTS_KEY = 'avalonCompanyRoleDefaults';
function _umLoadCompanyDefaults() {
  try { return JSON.parse(localStorage.getItem(LS_COMPANY_DEFAULTS_KEY) || 'null') || null; } catch(_){ return null; }
}
function _umSaveCompanyDefaults(d) {
  localStorage.setItem(LS_COMPANY_DEFAULTS_KEY, JSON.stringify(d));
}
// Checks if a role has been customised away from the factory default
function _umRoleIsCustomized(roleId, companyDefaults, factoryDefaults) {
  if (!companyDefaults || !companyDefaults[roleId]) return false;
  const factory = (factoryDefaults[roleId] || []).slice().sort().join(',');
  const company = (companyDefaults[roleId] || []).slice().sort().join(',');
  return factory !== company;
}

function umRenderRoles(container) {
  const loadNavPerms = window.loadNavPerms || (() => {
    try { return JSON.parse(localStorage.getItem('avalonNavPermissions') || '{}'); } catch(e) { return {}; }
  });
  const saveNavPerms = window.saveNavPerms || ((p) => {
    localStorage.setItem('avalonNavPermissions', JSON.stringify(p));
  });

  // ── Hub color map ──────────────────────────────────────────────────────────
  const HUB_META = {
    Dashboard:   { color: '#3A7CA5', bg: '#EAF3FA', icon: '' },
    Sales:       { color: '#2D7A55', bg: '#EAF4EE', icon: '' },
    Financial:   { color: '#8B6914', bg: '#F8F3E6', icon: '' },
    Operations:  { color: '#6B5EA8', bg: '#F0EDF8', icon: '' },
    Reports:     { color: '#5B7FA6', bg: '#EDF1F7', icon: '' },
    Settings:    { color: '#6F7E6A', bg: '#F2F3EF', icon: '' }
  };
  const KIND_LABEL = { page: '', report: 'Report', admin: 'Admin' };

  // ── Factory defaults (built-in, never user-modified) ──────────────────────
  const FACTORY_NAV_PERMS = window.DEFAULT_NAV_PERMS || {
    admin: UM_ALL_VIEWS.map(v => v.key),
    office_manager: ['today','myDashboard','teamView',
      'pipeline','lead','clients','properties','estimates','communications','automations','templates','campaigns','process','forms','scripts','emailTemplates','objections','calculator','ai','academy',
      'financialHub','invoices','payments','deposits','statements','financialActivity',
      'scheduleBoard','dispatchBoard','recurringServices','crewView','workOrderList','workOrderDetail','assetList','assetDetail','maintenanceQueue','inventoryList','materialAllocation','toolsConsumables','timeTracker',
      'revenueAdmin','salesReports','financialReports','opsReports','teamReports',
      'settings','userManagement','integrations','manager'],
    rep: ['today','myDashboard',
      'pipeline','lead','clients','properties','estimates','communications','automations','templates','campaigns','process','forms','scripts','emailTemplates','objections','calculator','ai','academy'],
    estimator: ['today','pipeline','clients','properties','estimates','calculator','forms'],
    foreman: ['today','myDashboard',
      'scheduleBoard','dispatchBoard','recurringServices','crewView',
      'workOrderList','workOrderDetail','assetList','assetDetail',
      'maintenanceQueue','inventoryList','toolsConsumables','timeTracker',
      'opsReports','teamReports'],
    laborer: ['today','scheduleBoard','workOrderList','timeTracker'],
    // Legacy alias — kept so old D1 rows with field_supervisor still resolve
    field_supervisor: ['today','myDashboard',
      'scheduleBoard','dispatchBoard','recurringServices','crewView',
      'workOrderList','workOrderDetail','assetList','assetDetail',
      'maintenanceQueue','inventoryList','toolsConsumables','timeTracker',
      'opsReports','teamReports'],
    view_only: ['today','pipeline']
  };

  // ── Company defaults (user-saved, used as "Default" preset baseline) ───────
  let companyDefaults = _umLoadCompanyDefaults() || { ...FACTORY_NAV_PERMS };

  // The "live" per-session overrides — what's currently checked in the matrix
  const perms = loadNavPerms();

  const HUB_ORDER = ['Dashboard','Sales','Financial','Operations','Reports','Settings'];
  const hubs = HUB_ORDER.filter(h => UM_ALL_VIEWS.some(v => v.hub === h));
  const nonAdminRoles = UM_ROLE_DEFS.filter(r => r.id !== 'admin');

  // Role group metadata for the visual role cards
  const ROLE_GROUP = {
    office_manager: { group: 'Management', icon: '' },
    rep:            { group: 'Sales',      icon: '' },
    estimator:      { group: 'Sales',      icon: '' },
    foreman:        { group: 'Field',      icon: '' },
    laborer:        { group: 'Field',      icon: '' },
    view_only:      { group: 'Other',      icon: '' },
    // Legacy fallback
    field_supervisor: { group: 'Field',   icon: '' }
  };

  // Helper: get effective perms for a role (live override → company default → factory)
  function effectivePerms(roleId) {
    if (perms[roleId]) return perms[roleId];
    if (companyDefaults[roleId]) return companyDefaults[roleId];
    return FACTORY_NAV_PERMS[roleId] || [];
  }

  // Helper: is there a company-level customization for this role?
  function roleHasCompanyDefault(roleId) {
    return !!(_umLoadCompanyDefaults() || {})[roleId];
  }

  container.innerHTML = `
<style>
  .rp-page-header { margin-bottom:24px }
  .rp-page-title { font-size:17px;font-weight:800;color:var(--gds-ink,#1F2A2B);margin:0 0 4px }
  .rp-page-sub { font-size:12.5px;color:#6B7280;margin:0;line-height:1.5 }

  /* Role Cards */
  .rp-role-grid { display:grid;grid-template-columns:repeat(auto-fill,minmax(195px,1fr));gap:12px;margin-bottom:28px }
  .rp-role-card { background:#fff;border:1.5px solid var(--gw-line,#E0DDD5);border-radius:14px;padding:15px 15px 12px;box-shadow:0 1px 3px rgba(0,0,0,.05);transition:box-shadow .15s;position:relative;overflow:hidden }
  .rp-role-card:hover { box-shadow:0 4px 14px rgba(0,0,0,.09) }
  .rp-role-card-accent { position:absolute;top:0;left:0;right:0;height:3px;border-radius:14px 14px 0 0 }
  .rp-role-badge { display:inline-flex;align-items:center;gap:4px;font-size:10px;font-weight:700;padding:2px 7px;border-radius:10px;margin-bottom:8px;text-transform:uppercase;letter-spacing:.06em }
  .rp-role-name { font-size:13px;font-weight:800;margin-bottom:5px }
  .rp-role-desc { font-size:11px;color:#6B7280;line-height:1.45;margin-bottom:12px }
  .rp-preset-row { display:flex;gap:4px;flex-wrap:wrap }
  .rp-preset-btn { font-size:10px;padding:3px 9px;border-radius:6px;border:1px solid var(--gw-line,#E0DDD5);background:#F9FAFB;color:#374151;cursor:pointer;font-weight:600;transition:all .15s;white-space:nowrap }
  .rp-preset-btn:hover { background:#F0F0ED;border-color:#9CA3AF }
  .rp-preset-btn.danger:hover { background:#FEF2F2;border-color:#FECACA;color:#DC2626 }
  .rp-preset-btn.primary { background:#4D8A86;color:#fff;border-color:#4D8A86 }
  .rp-preset-btn.primary:hover { background:#3a6e6b;border-color:#3a6e6b }
  .rp-custom-badge { display:inline-flex;align-items:center;gap:3px;font-size:9px;font-weight:700;padding:2px 6px;border-radius:8px;background:#FEF3C7;color:#92400E;border:1px solid #FCD34D;margin-left:4px;vertical-align:middle }

  /* Section dividers between role groups in matrix */
  .rp-group-divider { border-top:3px solid transparent;display:flex;align-items:center;gap:8px;padding:5px 0 3px }

  /* Matrix table */
  .rp-matrix-wrap { overflow-x:auto;border:1px solid var(--gw-line,#E0DDD5);border-radius:14px;box-shadow:0 1px 4px rgba(0,0,0,.05) }
  .rp-matrix-table { width:100%;border-collapse:collapse;min-width:800px }
  .rp-matrix-table thead { position:sticky;top:0;z-index:10 }
  .rp-col-view { width:200px;min-width:160px;position:sticky;left:0;z-index:5 }

  /* Action perms */
  .rp-action-card { background:#fff;border:1px solid var(--gw-line,#E0DDD5);border-radius:14px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.05) }
  .rp-action-header { background:linear-gradient(135deg,#F8F9FC,#F2F5FA);border-bottom:1px solid var(--gw-line,#E0DDD5);padding:13px 18px;display:flex;align-items:center;gap:8px }
  .rp-action-row { padding:13px 18px;border-bottom:1px solid #F3F4F6;display:grid;align-items:center;gap:0 }
  .rp-action-row:last-child { border-bottom:none }

  /* Save defaults banner */
  .rp-save-banner { background:linear-gradient(135deg,#ECFDF5,#D1FAE5);border:1px solid #6EE7B7;border-radius:12px;padding:14px 18px;margin-top:20px;display:flex;align-items:center;gap:14px }
  .rp-info-strip { background:#F0F7F6;border:1px solid #C0E0DE;border-radius:10px;padding:11px 16px;font-size:11.5px;color:#2D4D4B;line-height:1.6;margin-top:16px }
</style>

<!-- Page header -->
<div class="rp-page-header">
  <div style="display:flex;align-items:center;gap:12px;margin-bottom:5px">
    <h3 class="rp-page-title">Roles &amp; Permissions</h3>
    <span style="display:inline-flex;align-items:center;gap:5px;font-size:10px;font-weight:700;color:#4D8A86;background:#EAF6F5;border:1px solid #C0E0DE;border-radius:20px;padding:2px 9px;letter-spacing:.05em">Live</span>
  </div>
  <p class="rp-page-sub">Control which views each role can access. Use <strong>Set as Company Default</strong> to save your preferred access levels as the baseline for new hires — future role assignments will start from those defaults.</p>
</div>

<!-- ══ Role Cards ══════════════════════════════════════════════════════════ -->
<div class="rp-role-grid">
  <!-- Admin card — special -->
  ${(() => {
    const r = UM_ROLE_DEFS.find(x => x.id === 'admin');
    if (!r) return '';
    return `<div class="rp-role-card" style="border-color:${r.color}50;background:linear-gradient(135deg,#F0FAF9,#E6F5F4)">
      <div class="rp-role-card-accent" style="background:${r.color}"></div>
      <div class="rp-role-badge" style="background:${r.color}18;color:${r.color}">Owner</div>
      <div class="rp-role-name" style="color:${r.color}">${r.label}</div>
      <div class="rp-role-desc">${r.description||''}</div>
      <div style="font-size:10px;font-weight:700;color:${r.color};text-transform:uppercase;letter-spacing:.07em;padding:5px 8px;background:${r.color}12;border-radius:6px;text-align:center">Always Full Access — No Restrictions</div>
    </div>`;
  })()}

  <!-- Non-admin role cards -->
  ${nonAdminRoles.map(r => {
    const meta = ROLE_GROUP[r.id] || { group: 'Other', icon: '' };
    const isCustomized = _umRoleIsCustomized(r.id, _umLoadCompanyDefaults(), FACTORY_NAV_PERMS);
    const viewCount = effectivePerms(r.id).length;
    return `<div class="rp-role-card" id="rpc-${r.id}" style="border-color:${r.color}40">
      <div class="rp-role-card-accent" style="background:linear-gradient(90deg,${r.color},${r.color}88)"></div>
      <div style="display:flex;align-items:center;gap:6px;margin-bottom:7px">
        <div class="rp-role-badge" style="background:${r.color}15;color:${r.color}">${meta.group}</div>
        ${isCustomized ? `<span class="rp-custom-badge">Custom</span>` : ''}
      </div>
      <div class="rp-role-name" style="color:${r.color}">${r.label}</div>
      <div class="rp-role-desc">${r.description||''}</div>
      <div style="font-size:10px;color:#9CA3AF;margin-bottom:10px">${viewCount} view${viewCount!==1?'s':''} enabled</div>
      <div class="rp-preset-row">
        <button class="rp-preset-btn" onclick="window._umPreset('${r.id}','full')" title="Grant access to all views">All ✓</button>
        <button class="rp-preset-btn" onclick="window._umPreset('${r.id}','company')" title="Reset to your saved company defaults">Company Default</button>
        <button class="rp-preset-btn danger" onclick="window._umPreset('${r.id}','none')" title="Remove all view access">None ✕</button>
      </div>
      <div style="margin-top:8px;padding-top:8px;border-top:1px solid #F3F4F6">
        <button class="rp-preset-btn primary" onclick="window._umSaveRoleAsDefault('${r.id}')" title="Save current permission set as company default for this role">Set as Company Default</button>
        ${isCustomized ? `<button class="rp-preset-btn danger" style="margin-left:4px" onclick="window._umResetToFactory('${r.id}')" title="Revert to Groundwork built-in defaults">↺ Factory</button>` : ''}
      </div>
    </div>`;
  }).join('')}
</div>

<!-- ══ Company Defaults Banner ════════════════════════════════════════════ -->
<div id="rp-company-defaults-banner" style="${_umLoadCompanyDefaults() ? '' : 'display:none'}">
  <div class="rp-save-banner">
    <span style="width:22px;height:22px;flex-shrink:0"></span>
    <div style="flex:1">
      <div style="font-size:13px;font-weight:700;color:#065F46;margin-bottom:2px">Company Defaults Active</div>
      <div style="font-size:12px;color:#047857;line-height:1.4">Your custom role defaults are saved. New team members assigned a role will receive your company's access baseline, not the Groundwork factory defaults. Use <strong>↺ Factory</strong> on any role card to revert a role.</div>
    </div>
    <button class="rp-preset-btn danger" onclick="window._umClearAllCompanyDefaults()" style="flex-shrink:0">Clear All Defaults</button>
  </div>
</div>

<!-- ══ Permission Matrix ═══════════════════════════════════════════════════ -->
<div style="margin:24px 0 12px;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px">
  <div>
    <h4 style="margin:0 0 3px;font-size:14px;font-weight:800;color:var(--gds-ink,#1F2A2B)">View Access Matrix</h4>
    <p style="margin:0;font-size:12px;color:#6B7280">Check or uncheck views per role. Changes apply immediately. Use role cards above to set/save defaults.</p>
  </div>
  <div style="display:flex;align-items:center;gap:8px">
    <span style="font-size:11px;color:#9CA3AF">Jump to hub:</span>
    ${['Dashboard','Sales','Financial','Operations','Reports','Settings'].map(h => {
      const hm = HUB_META[h];
      return `<a href="#rp-hub-${h}" style="font-size:10px;font-weight:700;color:${hm.color};background:${hm.bg};border:1px solid ${hm.color}30;padding:3px 8px;border-radius:8px;text-decoration:none">${h}</a>`;
    }).join('')}
  </div>
</div>

<div class="rp-matrix-wrap">
  <table class="rp-matrix-table">
    <thead>
      <!-- Role group headers -->
      <tr style="background:#F8F9FC;border-bottom:1px solid #E5E9F0">
        <th class="rp-col-view" style="padding:10px 16px;text-align:left;font-size:10px;font-weight:700;color:#6B7280;text-transform:uppercase;letter-spacing:.08em;background:#F8F9FC">View</th>
        <!-- Management group -->
        <th colspan="1" style="text-align:center;padding:8px 4px;font-size:9px;font-weight:800;color:#8B6914;text-transform:uppercase;letter-spacing:.08em;border-left:2px solid #8B691420">Mgmt</th>
        <!-- Sales group -->
        <th colspan="2" style="text-align:center;padding:8px 4px;font-size:9px;font-weight:800;color:#2D7A55;text-transform:uppercase;letter-spacing:.08em;border-left:2px solid #2D7A5520">Sales</th>
        <!-- Field group -->
        <th colspan="2" style="text-align:center;padding:8px 4px;font-size:9px;font-weight:800;color:#6B5EA8;text-transform:uppercase;letter-spacing:.08em;border-left:2px solid #6B5EA820">Field</th>
        <!-- Other -->
        <th colspan="1" style="text-align:center;padding:8px 4px;font-size:9px;font-weight:800;color:#6F7E6A;text-transform:uppercase;letter-spacing:.08em;border-left:2px solid #6F7E6A20">Other</th>
      </tr>
      <!-- Role name headers -->
      <tr style="background:#fff;border-bottom:2px solid #E5E9F0">
        <th class="rp-col-view" style="padding:10px 16px;text-align:left;background:#fff"></th>
        ${nonAdminRoles.map((r,i) => {
          const isGroupStart = i === 0 || ROLE_GROUP[r.id]?.group !== ROLE_GROUP[nonAdminRoles[i-1]?.id]?.group;
          const custIcon = _umRoleIsCustomized(r.id, _umLoadCompanyDefaults(), FACTORY_NAV_PERMS) ? ' *' : '';
          return `<th style="text-align:center;padding:8px 6px;min-width:80px;${isGroupStart?'border-left:2px solid '+r.color+'30':''}">
            <div style="font-size:11px;font-weight:800;color:${r.color};line-height:1.2">${r.label.split(' ').map((w,wi)=>wi===0?w:`<br><span style="font-weight:600">${w}</span>`).join('')}${custIcon}</div>
            <div style="font-size:9px;color:#9CA3AF;margin-top:2px">${effectivePerms(r.id).length} views</div>
          </th>`;
        }).join('')}
      </tr>
    </thead>
    <tbody>
      ${hubs.map(hub => {
        const hMeta = HUB_META[hub] || { color: '#6F7E6A', bg: '#F5F5F0', icon: '•' };
        const hViews = UM_ALL_VIEWS.filter(v => v.hub === hub);
        return `
        <!-- Hub header row -->
        <tr id="rp-hub-${hub}">
          <td colspan="${nonAdminRoles.length + 1}" style="padding:0">
            <div style="display:flex;align-items:center;gap:8px;padding:8px 16px;background:linear-gradient(135deg,${hMeta.bg},${hMeta.bg}CC);border-top:2px solid ${hMeta.color}25;border-bottom:1px solid ${hMeta.color}20">
              <span style="font-size:10px;font-weight:800;color:${hMeta.color};text-transform:uppercase;letter-spacing:.12em">${hub}</span>
              <span style="font-size:10px;color:${hMeta.color}80;margin-left:auto">${hViews.length} view${hViews.length!==1?'s':''}</span>
            </div>
          </td>
        </tr>
        <!-- View rows -->
        ${hViews.map((v,vi) => {
          const kindBadge = v.kind && v.kind !== 'page'
            ? `<span style="margin-left:6px;font-size:9px;padding:1px 5px;border-radius:4px;background:${hMeta.bg};color:${hMeta.color};border:1px solid ${hMeta.color}35;font-weight:700;text-transform:uppercase;letter-spacing:.04em">${KIND_LABEL[v.kind]||v.kind}</span>`
            : '';
          const rowBg = vi % 2 === 0 ? 'transparent' : 'rgba(0,0,0,.015)';
          return `
        <tr style="border-bottom:1px solid #F3F4F6;background:${rowBg}" class="rp-view-row" onmouseover="this.style.background='#F9FDF9'" onmouseout="this.style.background='${rowBg}'">
          <td class="rp-col-view" style="padding:8px 16px;font-size:12px;color:var(--gds-ink,#1F2A2B);background:${rowBg};border-right:1px solid #F0F0ED">
            ${v.label}${kindBadge}
          </td>
          ${nonAdminRoles.map((r,ri) => {
            const isGroupStart = ri === 0 || ROLE_GROUP[r.id]?.group !== ROLE_GROUP[nonAdminRoles[ri-1]?.id]?.group;
            const rolePerms = effectivePerms(r.id);
            const checked = rolePerms.includes(v.key);
            return `<td style="text-align:center;padding:7px 4px;${isGroupStart?'border-left:2px solid '+r.color+'20':''}">
              <input type="checkbox" ${checked ? 'checked' : ''}
                onchange="window._umTogglePerm('${r.id}','${v.key}',this.checked)"
                style="width:16px;height:16px;accent-color:${r.color};cursor:pointer;border-radius:3px">
            </td>`;
          }).join('')}
        </tr>`;
        }).join('')}`;
      }).join('')}
    </tbody>
  </table>
</div>

<div class="rp-info-strip" style="margin-bottom:0">
  <strong>Tip:</strong> After customizing a role's checkboxes, click <strong>Set as Company Default</strong> on that role's card to save it as the starting point for all future hires in that role. Changes to live checkboxes take effect immediately for existing users — defaults only apply to new assignments.
</div>

<!-- ══ Action Permissions ═════════════════════════════════════════════════ -->
<div style="margin-top:28px">
  <div style="margin-bottom:14px">
    <h4 style="margin:0 0 3px;font-size:14px;font-weight:800;color:var(--gds-ink,#1F2A2B)">Action Permissions</h4>
    <p style="margin:0;font-size:12px;color:#6B7280">Control destructive or elevated actions beyond nav access. These override individual capability flags.</p>
  </div>

  <div class="rp-action-card">
    <!-- Header -->
    <div class="rp-action-header">

      <span style="font-size:11px;font-weight:800;color:#4A5568;text-transform:uppercase;letter-spacing:.1em">Capability Toggles</span>
    </div>

    <!-- Grid: Permission label + per-role toggle columns -->
    <!-- Sub-header row -->
    <div class="rp-action-row" style="background:#FAFBFC;padding:9px 18px;border-bottom:2px solid #E5E9F0"
      style="grid-template-columns:1fr ${nonAdminRoles.map(()=>'72px').join(' ')}">
      <div style="font-size:10px;font-weight:700;color:#6B7280;text-transform:uppercase;letter-spacing:.08em;grid-column:1">Permission</div>
      ${nonAdminRoles.map((r,i) => {
        const isGroupStart = i === 0 || ROLE_GROUP[r.id]?.group !== ROLE_GROUP[nonAdminRoles[i-1]?.id]?.group;
        return `<div style="text-align:center;font-size:10px;font-weight:800;color:${r.color};${isGroupStart?'border-left:2px solid '+r.color+'30;padding-left:4px':''}">${r.label.split(' / ')[0].split(' ')[0]}</div>`;
      }).join('')}
    </div>

    ${[
      { key:'can_delete_leads',   label:'Delete Leads',     desc:'Permanently delete leads from the pipeline' },
      { key:'can_send_invoice',   label:'Send Invoices',    desc:'Send invoices to clients from Financial hub' },
      { key:'can_approve_time',   label:'Approve Time',     desc:'Approve or reject time entries for crew' },
      { key:'can_dispatch_crews', label:'Dispatch Crews',   desc:'Assign and dispatch crews from the dispatch board' },
      { key:'can_manage_users',   label:'Manage Users',     desc:'Add, edit, and deactivate team member accounts' }
    ].map((cap, capIdx) => `
    <div class="rp-action-row" style="grid-template-columns:1fr ${nonAdminRoles.map(()=>'72px').join(' ')};${capIdx%2===1?'background:#FAFBFC':''}">
      <div>
        <div style="font-size:12.5px;font-weight:600;color:var(--gds-ink,#1F2A2B);margin-bottom:2px">${cap.label}</div>
        <div style="font-size:11px;color:#6B7280">${cap.desc}</div>
      </div>
      ${nonAdminRoles.map((r,ri) => {
        const roleD1 = window._gwRoles ? window._gwRoles.find(d => d.id === r.id) : null;
        const caps2 = (roleD1 && roleD1.permissions && roleD1.permissions.capabilities) || (roleD1 && roleD1.permissions) || {};
        const defCap = (getRoleDefs().find(d=>d.id===r.id)||{}).capabilities||{};
        const isOn = (cap.key in caps2) ? !!caps2[cap.key] : !!defCap[cap.key];
        const isGroupStart = ri === 0 || ROLE_GROUP[r.id]?.group !== ROLE_GROUP[nonAdminRoles[ri-1]?.id]?.group;
        return `<div style="text-align:center;${isGroupStart?'border-left:2px solid '+r.color+'20':''}">
          <label style="position:relative;display:inline-flex;align-items:center;cursor:pointer" title="${r.label}: ${cap.label}">
            <input type="checkbox" ${isOn?'checked':''} id="acp-${cap.key}-${r.id}"
              onchange="window._umToggleActionPerm('${r.id}','${cap.key}',this.checked)"
              style="position:absolute;opacity:0;width:0;height:0">
            <span style="display:inline-block;width:36px;height:20px;border-radius:10px;background:${isOn?r.color:'#D1D5DB'};transition:background .2s;position:relative;flex-shrink:0;box-shadow:inset 0 1px 2px rgba(0,0,0,.1)" id="acp-track-${cap.key}-${r.id}">
              <span style="position:absolute;top:2px;left:${isOn?'18px':'2px'};width:16px;height:16px;border-radius:50%;background:#fff;box-shadow:0 1px 4px rgba(0,0,0,.2);transition:left .18s" id="acp-thumb-${cap.key}-${r.id}"></span>
            </span>
          </label>
        </div>`;
      }).join('')}
    </div>`).join('')}
  </div>

  <div style="margin-top:8px;font-size:11px;color:#6B7280">
    <strong>Owner</strong> always retains all capabilities regardless of these settings.
  </div>
</div>
`;

  // ── Wire up all event handlers ────────────────────────────────────────────
  window._umTogglePerm = function(roleId, viewKey, enabled) {
    const p = loadNavPerms();
    if (!p[roleId]) p[roleId] = [...effectivePerms(roleId)];
    if (enabled) { if (!p[roleId].includes(viewKey)) p[roleId].push(viewKey); }
    else { p[roleId] = p[roleId].filter(v => v !== viewKey); }
    saveNavPerms(p);
    // Update view count badge in header + card
    const th = document.querySelector(`th[data-role="${roleId}"] .rp-view-count`);
    if (th) th.textContent = p[roleId].length + ' views';
  };

  window._umPreset = function(roleId, preset) {
    const ALL     = UM_ALL_VIEWS.map(v => v.key);
    const COMPANY = (companyDefaults[roleId]) || FACTORY_NAV_PERMS[roleId] || [];
    const views   = preset === 'full' ? ALL : preset === 'none' ? [] : COMPANY;
    const p = loadNavPerms();
    p[roleId] = [...views];
    saveNavPerms(p);
    const role = umRoleDef(roleId);
    const label = preset === 'full' ? 'Full Access' : preset === 'none' ? 'No Access' : 'Company Default';
    umToast(`${role.label} → ${label}`);
    umRenderRoles(container);
  };

  window._umSaveRoleAsDefault = function(roleId) {
    const p = loadNavPerms();
    const current = p[roleId] ? [...p[roleId]] : [...effectivePerms(roleId)];
    const cd = _umLoadCompanyDefaults() || { ...FACTORY_NAV_PERMS };
    cd[roleId] = current;
    _umSaveCompanyDefaults(cd);
    companyDefaults = cd;
    const role = umRoleDef(roleId);
    umToast(`✅ "${role.label}" company default saved — ${current.length} views`);
    // Show banner
    const banner = document.getElementById('rp-company-defaults-banner');
    if (banner) banner.style.display = '';
    // Refresh card to show Custom badge
    umRenderRoles(container);
  };

  window._umResetToFactory = function(roleId) {
    if (!confirm(`Reset "${umRoleDef(roleId).label}" to Groundwork built-in defaults? This removes your company customization for this role.`)) return;
    const cd = _umLoadCompanyDefaults() || {};
    delete cd[roleId];
    _umSaveCompanyDefaults(Object.keys(cd).length ? cd : null);
    if (Object.keys(cd).length === 0) localStorage.removeItem(LS_COMPANY_DEFAULTS_KEY);
    companyDefaults = _umLoadCompanyDefaults() || { ...FACTORY_NAV_PERMS };
    // Also reset live perms for this role
    const p = loadNavPerms();
    delete p[roleId];
    saveNavPerms(p);
    umToast(`${umRoleDef(roleId).label} → Factory defaults restored`);
    umRenderRoles(container);
  };

  window._umClearAllCompanyDefaults = function() {
    if (!confirm('Clear ALL company role defaults? All roles will revert to Groundwork built-in factory defaults.')) return;
    localStorage.removeItem(LS_COMPANY_DEFAULTS_KEY);
    companyDefaults = { ...FACTORY_NAV_PERMS };
    const banner = document.getElementById('rp-company-defaults-banner');
    if (banner) banner.style.display = 'none';
    umToast('All company defaults cleared — using factory defaults');
    umRenderRoles(container);
  };

  window._umToggleActionPerm = async function(roleId, permKey, enabled) {
    if (window._gwRoles) {
      const rd = window._gwRoles.find(r => r.id === roleId);
      if (rd) {
        if (!rd.permissions || typeof rd.permissions !== 'object') rd.permissions = {};
        rd.permissions[permKey] = enabled;
      }
    }
    const track = document.getElementById(`acp-track-${permKey}-${roleId}`);
    const thumb = document.getElementById(`acp-thumb-${permKey}-${roleId}`);
    const roleDef2 = (window._gwRoles || []).find(r => r.id === roleId) || umRoleDef(roleId);
    if (track) track.style.background = enabled ? (roleDef2?.color || '#4D8A86') : '#D1D5DB';
    if (thumb) thumb.style.left = enabled ? '18px' : '2px';
    try {
      const rd = window._gwRoles ? window._gwRoles.find(r => r.id === roleId) : null;
      const currentPerms = (rd && rd.permissions) ? { ...rd.permissions } : {};
      currentPerms[permKey] = enabled;
      const res = await fetch(`/api/roles/${roleId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ permissions: currentPerms })
      });
      const j = await res.json();
      if (j.ok === false) throw new Error(j.error || 'Save failed');
      umToast(`${roleDef2?.label || roleId}: ${permKey.replace('can_','').replace(/_/g,' ')} ${enabled?'enabled':'disabled'}`);
    } catch(e) {
      umToast('Save failed: ' + e.message, 'error');
      if (window._gwRoles) {
        const rd = window._gwRoles.find(r => r.id === roleId);
        if (rd && rd.permissions) rd.permissions[permKey] = !enabled;
      }
      if (track) track.style.background = !enabled ? (roleDef2?.color || '#4D8A86') : '#D1D5DB';
      if (thumb) thumb.style.left = !enabled ? '18px' : '2px';
    }
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// TAB 3 — WORKSPACE CONNECTIONS (per-user Google)
// ═══════════════════════════════════════════════════════════════════════════════
function umRenderWorkspace(container) {
  const users = umLoadUsers().filter(u => u.status === 'active');
  const googleMap = umLoadUserGoogle();

  // Load global integration state for GOOGLE_CLIENT_ID
  let globalIntState = {};
  try { globalIntState = JSON.parse(localStorage.getItem('avalonIntegrationsV1') || '{}'); } catch(e) {}
  const sharedClientId = globalIntState.googleClientId || '';

  container.innerHTML = `
<div style="margin-bottom:20px">
  <h3 style="margin:0 0 4px;font-size:16px">Team Google Workspace Connections</h3>
  <p style="color:#6F7E6A;font-size:13px;margin:0">Each team member connects their own Google account. Connections are isolated — no shared tokens.</p>
</div>

<!-- Client ID config -->
<div class="gw-um-form-card" style="border-radius:12px;padding:18px;margin-bottom:20px">
  <div style="font-weight:700;font-size:14px;color:#E8E4D9;margin-bottom:8px">Shared Google OAuth Client ID</div>
  <p style="color:#6F7E6A;font-size:12px;margin:0 0 12px">The same Google Cloud Client ID is used across all user connections. Set it once here and every user can connect their own account.</p>
  <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end">
    <div style="flex:1;min-width:260px">
      <label style="font-size:11px;font-weight:600;color:#6F7E6A;text-transform:uppercase;letter-spacing:.05em">Google Client ID</label>
      <input id="um-ws-client-id" type="text"
        value="${umEscape(sharedClientId)}"
        placeholder="1234567890-abc...apps.googleusercontent.com"
        style="width:100%;margin-top:6px;padding:10px 12px;background:var(--gw-surface-3);border:1px solid var(--gw-line);border-radius:8px;color:var(--gw-ink);font-size:13px;box-sizing:border-box">
    </div>
    <button class="primary-btn" onclick="window._umSaveClientId()">Save Client ID</button>
  </div>
</div>

<!-- User Connection Grid -->
<div style="display:flex;flex-direction:column;gap:10px" id="um-ws-grid">
  ${users.map(u => umWorkspaceRow(u, googleMap[u.id], sharedClientId)).join('')}
</div>

<div class="gw-info-strip" style="margin-top:20px;border-radius:10px">
  <div style="font-size:12px;font-weight:700;color:#5C6B58;text-transform:uppercase;letter-spacing:.06em;margin-bottom:8px">How Per-User Connections Work</div>
  <div style="font-size:12px;color:#6F7E6A;line-height:1.8">
    Each user connects their own Google account from <strong style="color:#6F7E6A">Settings → My Google Connection</strong>.
    The token is stored under their user ID so Gmail, Calendar, and Drive actions always use their own account.
    Admin can see connection status here but cannot see another user's emails or files.
  </div>
</div>
`;

  window._umSaveClientId = function() {
    const val = document.getElementById('um-ws-client-id')?.value?.trim();
    if (!val) { umToast('Paste a valid Google Client ID first'); return; }
    const cur = globalIntState;
    cur.googleClientId = val;
    localStorage.setItem('avalonIntegrationsV1', JSON.stringify(cur));
    umToast('Google Client ID saved');
    umRenderWorkspace(container);
  };

}

// Hoisted so it's available from umUserRow onclick regardless of which tab rendered
window._umAdminDisconnectUser = function(userId) {
  const users = umLoadUsers();
  const u = users.find(u => u.id === userId);
  if (!confirm(`Disconnect Google for ${u?.name||userId}? They will need to reconnect.`)) return;
  const map = umLoadUserGoogle();
  delete map[userId];
  umSaveUserGoogle(map);
  umAddAuditEntry({ type: 'google_disconnected_by_admin', userId, userName: u?.name||userId, by: window.getCurrentRep?.()?.name || 'Admin' });
  umToast(`Google disconnected for ${u?.name||userId}`);
  // Re-render users tab so Google strip updates
  userManagement('users');
};

function umWorkspaceRow(u, gc, clientId) {
  const connected = gc && gc.token && Date.now() < (gc.expiry || 0);
  const email     = gc?.email || '';
  const connectedAt = gc?.connectedAt ? umFormatDate(gc.connectedAt) : null;

  const services = [
    { label:'Gmail',    icon:'G',  key:'gmail',    connected: connected && gc?.gmail },
    { label:'Calendar', icon:'C',  key:'calendar', connected: connected && gc?.calendar },
    { label:'Drive',    icon:'D',  key:'drive',    connected: connected && gc?.drive }
  ];

  return `
<div class="gw-um-user-row" style="display:flex;align-items:center;gap:14px;padding:14px 18px;flex-wrap:wrap;gap:12px">
  ${umColorTile(u.displayName||u.name, u.color, 40)}
  <div style="min-width:140px">
    <div style="font-weight:700;font-size:14px;color:#E8E4D9">${umEscape(u.displayName||u.name)}</div>
    <div style="font-size:11px;color:#6F7E6A">${umEscape(u.position)}</div>
  </div>
  <div style="flex:1;min-width:200px">
    ${connected
      ? `<div style="font-size:12px;color:#2D7A55;font-weight:600;margin-bottom:6px">● Connected as ${umEscape(email)}</div>`
      : `<div style="font-size:12px;color:#C97B6A;font-weight:600;margin-bottom:6px">○ Not connected</div>`
    }
    <div style="display:flex;gap:8px;flex-wrap:wrap">
      ${services.map(s => `
      <span style="font-size:11px;color:${s.connected?'#2D7A55':'var(--gw-muted)'};background:${s.connected?'#2D7A5515':'var(--gw-surface-3)'};border:1px solid ${s.connected?'#2D7A5540':'var(--gw-line)'};border-radius:6px;padding:2px 8px">
        ${s.icon} ${s.label}
      </span>`).join('')}
    </div>
    ${connectedAt ? `<div style="font-size:10px;color:#5C6B58;margin-top:4px">Connected ${connectedAt}</div>` : ''}
  </div>
  <div style="display:flex;gap:8px;margin-left:auto">
    ${connected
      ? `<button class="danger-btn" style="font-size:12px;padding:6px 12px" onclick="window._umAdminDisconnectUser('${u.id}')">Disconnect</button>`
      : `<span style="font-size:11px;color:#5C6B58;padding:6px 12px">User connects via their Settings</span>`
    }
  </div>
</div>`;
}

// ═══════════════════════════════════════════════════════════════════════════════
// TAB 4 — LOGIN AUDIT
// ═══════════════════════════════════════════════════════════════════════════════
function umRenderAudit(container) {
  const log = umLoadAudit();

  const iconMap = {
    login:                    { icon:'in',   label:'Login',                    color:'#2D7A55' },
    logout:                   { icon:'out',  label:'Logout',                   color:'#5E6E6F' },
    login_failed:             { icon:'fail', label:'Failed Login',             color:'#7A2E20' },
    user_created:             { icon:'new',  label:'User Created',             color:'#2C5F57' },
    user_updated:             { icon:'edit', label:'User Updated',             color:'#4D8A86' },
    user_deactivated:         { icon:'off',  label:'User Deactivated',         color:'#8B3A2A' },
    user_reactivated:         { icon:'on',   label:'User Reactivated',         color:'#2D7A55' },
    pin_reset:                { icon:'pw',   label:'Password Reset',           color:'#5E6E6F' },
    google_disconnected_by_admin: { icon:'dc', label:'Google Disconnected (Admin)', color:'#8B3A2A' },
    google_connected:         { icon:'gc',   label:'Google Connected',         color:'#2D7A55' }
  };

  container.innerHTML = `
<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;flex-wrap:wrap;gap:10px">
  <div>
    <h3 style="margin:0 0 2px;font-size:16px">Login & Security Audit Log</h3>
    <p style="color:var(--gds-muted,#5E6E6F);font-size:12px;margin:0">${log.length} entries · Last 200 events stored locally</p>
  </div>
  ${log.length ? `<button class="secondary-btn" style="font-size:12px" onclick="window._umClearAudit()">Clear Log</button>` : ''}
</div>

${log.length === 0
  ? `<div style="text-align:center;padding:48px;color:var(--gds-muted,#5E6E6F)">
      <div style="width:40px;height:40px;background:#EEF4F3;border-radius:10px;display:flex;align-items:center;justify-content:center;margin:0 auto 12px">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#204A43" stroke-width="2"><path d="M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2"/><rect x="9" y="3" width="6" height="4" rx="1"/><path d="M9 12h6M9 16h4"/></svg>
      </div>
      <div style="font-weight:600;color:var(--gds-ink,#1F2A2B);margin-bottom:4px">No audit events recorded yet.</div>
      <div style="font-size:12px">Events are logged as users log in and admin makes changes.</div>
    </div>`
  : `<div style="display:flex;flex-direction:column;gap:6px">
      ${log.map(entry => {
        const def = iconMap[entry.type] || { icon:'evt', label: entry.type || 'Event', color:'#5E6E6F' };
        return `
        <div class="gw-um-user-row" style="display:flex;align-items:flex-start;gap:12px;padding:10px 14px;border-radius:8px">
          <span style="flex-shrink:0;margin-top:1px;width:26px;height:26px;border-radius:6px;background:${def.color}18;display:inline-flex;align-items:center;justify-content:center;font-size:9px;font-weight:800;letter-spacing:.02em;text-transform:uppercase;color:${def.color}">${def.icon}</span>
          <div style="flex:1;min-width:0">
            <div style="font-size:13px;color:var(--gds-ink,#1F2A2B);font-weight:600">${def.label}
              ${entry.userName ? `<span style="color:var(--gds-muted,#5E6E6F);font-weight:400"> · ${umEscape(entry.userName)}</span>` : ''}
              ${entry.by && entry.by !== entry.userName ? `<span style="font-size:11px;color:var(--gds-muted,#5E6E6F)"> by ${umEscape(entry.by)}</span>` : ''}
            </div>
            <div style="font-size:11px;color:var(--gds-muted,#5E6E6F);margin-top:2px">${umFormatDate(entry.timestamp)}</div>
          </div>
        </div>`;
      }).join('')}
    </div>`
}
`;

  window._umClearAudit = function() {
    if (!confirm('Clear entire audit log? This cannot be undone.')) return;
    localStorage.removeItem(UM_AUDIT_KEY);
    umToast('Audit log cleared');
    umRenderAudit(container);
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// MY GOOGLE CONNECTION — called from Settings or per-user context
// Allows a non-admin to connect/disconnect their own Google account
// Stores the token under avalonUserGoogleV1[userId]
// ═══════════════════════════════════════════════════════════════════════════════
function umRenderMyGoogleConnection(container) {
  const currentRep = window.getCurrentRep ? window.getCurrentRep() : null;
  if (!currentRep) return;

  let globalIntState = {};
  try { globalIntState = JSON.parse(localStorage.getItem('avalonIntegrationsV1') || '{}'); } catch(e) {}
  const clientId = globalIntState.googleClientId || '';

  const map = umLoadUserGoogle();
  const gc = map[currentRep.id];
  const connected = gc && gc.token && Date.now() < (gc.expiry || 0);
  const email = gc?.email || '';

  container.innerHTML = `
<section class="card" style="border:1px solid var(--gw-line)">
  <div style="display:flex;align-items:center;gap:12px;margin-bottom:14px">
    <img src="https://www.google.com/favicon.ico" style="width:24px;height:24px" alt="Google">
    <h3 style="margin:0;font-size:15px">My Google Workspace Connection</h3>
    ${connected
      ? `<span style="font-size:11px;font-weight:700;color:#2D7A55;background:#2D7A5518;border:1px solid #2D7A5540;border-radius:20px;padding:2px 9px;margin-left:auto">● Connected</span>`
      : `<span style="font-size:11px;font-weight:700;color:#C97B6A;background:#C97B6A18;border:1px solid #C97B6A40;border-radius:20px;padding:2px 9px;margin-left:auto">○ Not Connected</span>`
    }
  </div>

  ${connected
    ? `<div style="font-size:13px;color:#2D7A55;margin-bottom:12px">Connected as <strong>${umEscape(email)}</strong></div>
       <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px">
         ${[{l:'Gmail'},{l:'Calendar'},{l:'Drive'}].map(s=>`
         <span style="font-size:12px;background:#2D7A5515;border:1px solid #2D7A5540;border-radius:6px;padding:3px 10px;color:#2D7A55">${s.icon} ${s.l}</span>`).join('')}
       </div>
       <button class="danger-btn" onclick="window._umMyDisconnect()">Disconnect My Google Account</button>`
    : `<p style="color:#6F7E6A;font-size:13px;margin:0 0 14px">Connect your personal Google account to use Gmail, Calendar, and Drive directly from the Sales Hub.</p>
       ${!clientId
         ? `<div style="font-size:13px;color:#8B6914;background:rgba(139,105,20,.09);border:1px solid rgba(139,105,20,.25);border-radius:8px;padding:12px">
              Google Client ID not configured. Ask your Admin to set it up in <strong>Integrations</strong>.
            </div>`
         : `<button class="primary-btn" onclick="window._umMyConnect()">Connect My Google Account</button>`
       }`
  }
</section>`;

  // Append signature editor panel below the Google connection card
  const sigWrap = document.createElement('div');
  sigWrap.style.marginTop = '14px';
  container.appendChild(sigWrap);
  umRenderSignatureEditor(sigWrap);
}

// ═══════════════════════════════════════════════════════════════════════════════
// EMAIL SIGNATURE EDITOR
// Lets each rep set/edit their email signature, with a "Fetch from Gmail" button
// that pulls it from the Gmail Settings API (sendAs), and a manual HTML textarea
// fallback. Saves to D1 via PUT /api/reps/:id { email_signature }.
// ═══════════════════════════════════════════════════════════════════════════════
function umRenderSignatureEditor(container) {
  const rep = window.getCurrentRep ? window.getCurrentRep() : null;
  if (!rep) return;

  // Check for a cached Gmail signature in localStorage
  const map  = umLoadUserGoogle();
  const gc   = map[rep.id];
  const cachedGmailSig = gc?.signature ?? null;   // null = never fetched, '' = fetched but empty
  const connected = gc && gc.token && Date.now() < (gc.expiry || 0);

  // Current saved signature: prefer D1 value on rep object
  const savedSig = rep.email_signature || '';

  container.innerHTML = `
<section class="card" style="border:1px solid var(--gw-line)">
  <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:4px">
    <h3 style="margin:0;font-size:15px;display:flex;align-items:center;gap:8px">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2z"></path><polyline points="22,6 12,13 2,6"></polyline></svg>
      Email Signature
    </h3>
    <div id="um-sig-saved-badge" style="display:none;font-size:10px;font-weight:700;color:#2D7A55;background:#2D7A5515;border:1px solid #2D7A5540;border-radius:20px;padding:2px 9px">Saved</div>
  </div>
  <p style="font-size:12px;color:#6F7E6A;margin:0 0 14px">
    This signature is automatically appended to every email you send from Groundwork.
    ${connected
      ? `<br><strong style="color:#2D7A55">Google is connected</strong> — you can sync directly from Gmail.`
      : `<br><span style="color:#8B6914">Connect Google above to auto-sync your Gmail signature.</span>`}
  </p>

  <!-- Source toggle tabs -->
  <div style="display:flex;gap:4px;margin-bottom:14px;background:var(--gw-surface-3);border-radius:8px;padding:3px;width:fit-content">
    <button id="um-sig-tab-gmail" onclick="umSigSwitchTab('gmail')"
      style="padding:6px 14px;border-radius:6px;border:none;font-size:12px;font-weight:700;cursor:pointer;transition:all .15s;
      background:${connected && (cachedGmailSig || cachedGmailSig==='') ? 'var(--gw-surface)' : 'transparent'};
      color:${connected ? 'var(--gw-ink,#1F2A2B)' : '#6F7E6A'}">
      ${connected ? 'Connected: ' : ''}Gmail Sync
    </button>
    <button id="um-sig-tab-manual" onclick="umSigSwitchTab('manual')"
      style="padding:6px 14px;border-radius:6px;border:none;font-size:12px;font-weight:700;cursor:pointer;transition:all .15s;
      background:${!connected ? 'var(--gw-surface)' : 'transparent'};color:var(--gw-ink,#1F2A2B)">
      Manual Editor
    </button>
  </div>

  <!-- Gmail Sync panel -->
  <div id="um-sig-panel-gmail" style="display:${connected ? 'block' : 'none'}">
    ${connected ? `
    <div style="margin-bottom:12px;display:flex;align-items:center;gap:10px">
      <button onclick="umFetchGmailSig()" id="um-sig-fetch-btn"
        style="padding:8px 16px;background:linear-gradient(135deg,#4285F4,#1a73e8);border:none;border-radius:8px;color:#fff;font-size:12px;font-weight:700;cursor:pointer;display:flex;align-items:center;gap:6px">
        <img src="https://www.google.com/favicon.ico" style="width:14px;height:14px">
        Fetch from Gmail
      </button>
      <span id="um-sig-fetch-status" style="font-size:11px;color:#6F7E6A"></span>
    </div>
    ${cachedGmailSig
      ? `<div style="font-size:11px;color:#2D7A55;margin-bottom:8px">Gmail signature fetched${cachedGmailSig ? '' : ' (empty — no signature set in Gmail)'}</div>`
      : cachedGmailSig === ''
      ? `<div style="font-size:11px;color:#8B6914;margin-bottom:8px">ⓘ No signature found in Gmail — use Manual Editor below or set one in Gmail settings.</div>`
      : `<div style="font-size:11px;color:#6F7E6A;margin-bottom:8px">Click "Fetch from Gmail" to pull your current Gmail signature.</div>`
    }
    <!-- Preview of fetched sig -->
    ${cachedGmailSig ? `
    <div style="padding:12px;background:var(--gw-surface-3);border:1px solid var(--gw-line);border-radius:8px;font-size:12px;line-height:1.6;color:var(--gw-ink,#1F2A2B);max-height:140px;overflow-y:auto;margin-bottom:12px" id="um-sig-gmail-preview">
      ${cachedGmailSig}
    </div>
    <div style="display:flex;gap:8px">
      <button onclick="umSaveSigFromGmail()" style="padding:8px 18px;background:#2D7A55;border:none;border-radius:8px;color:#fff;font-size:12px;font-weight:700;cursor:pointer">
        Use This Signature →
      </button>
      <button onclick="umSigSwitchTab('manual')" style="padding:8px 14px;background:transparent;border:1px solid var(--gw-line);border-radius:8px;color:#6F7E6A;font-size:12px;font-weight:600;cursor:pointer">
        Edit Manually Instead
      </button>
    </div>` : ''}
    ` : ''}
  </div>

  <!-- Manual editor panel -->
  <div id="um-sig-panel-manual" style="display:${!connected ? 'block' : 'none'}">
    <div style="font-size:11px;color:#6F7E6A;margin-bottom:6px">
      Paste HTML from Gmail (Gmail → Settings → Signature → copy source), or type plain text.
      <a href="https://mail.google.com/mail/u/0/#settings/general" target="_blank" style="color:#4D8A86;text-decoration:underline">Open Gmail Settings →</a>
    </div>
    <textarea id="um-sig-manual-input" rows="6"
      style="width:100%;padding:9px 12px;background:var(--gw-surface-3);border:1px solid var(--gw-line);border-radius:8px;color:var(--gw-ink,#1F2A2B);font-size:12px;resize:vertical;font-family:monospace;box-sizing:border-box"
      placeholder="Paste signature HTML here, or type plain text…"
    >${umEscape(savedSig)}</textarea>
    <div style="margin-top:8px;display:flex;gap:8px;align-items:center">
      <button onclick="umSaveSigManual()" style="padding:8px 18px;background:#2D7A55;border:none;border-radius:8px;color:#fff;font-size:12px;font-weight:700;cursor:pointer">
        Save Signature
      </button>
      <button onclick="umSigPreviewManual()" style="padding:8px 14px;background:transparent;border:1px solid var(--gw-line);border-radius:8px;color:#6F7E6A;font-size:12px;font-weight:600;cursor:pointer">
        Preview
      </button>
      ${savedSig ? `<button onclick="umClearSig()" style="padding:8px 14px;background:transparent;border:1px solid #C97B6A40;border-radius:8px;color:#C97B6A;font-size:12px;font-weight:600;cursor:pointer">Clear</button>` : ''}
    </div>
    <!-- Preview output -->
    <div id="um-sig-manual-preview" style="display:none;margin-top:10px;padding:12px;background:var(--gw-surface-3);border:1px solid var(--gw-line);border-radius:8px;font-size:12px;line-height:1.6;color:var(--gw-ink,#1F2A2B)"></div>
  </div>

  <!-- Currently active signature -->
  ${savedSig ? `
  <div style="margin-top:16px;padding-top:14px;border-top:1px solid var(--gw-line)">
    <div style="font-size:10px;font-weight:700;color:#6F7E6A;text-transform:uppercase;letter-spacing:.05em;margin-bottom:8px">Active Signature</div>
    <div style="padding:10px 12px;background:var(--gw-surface-3);border:1px solid #2D7A5540;border-radius:8px;font-size:12px;line-height:1.6;color:var(--gw-ink,#1F2A2B);max-height:100px;overflow:hidden">${savedSig}</div>
  </div>` : ''}
</section>`;
}

// Signature editor helpers
function umSigSwitchTab(tab) {
  const gmail  = document.getElementById('um-sig-panel-gmail');
  const manual = document.getElementById('um-sig-panel-manual');
  const tabG   = document.getElementById('um-sig-tab-gmail');
  const tabM   = document.getElementById('um-sig-tab-manual');
  if (gmail)  gmail.style.display  = tab === 'gmail'  ? 'block' : 'none';
  if (manual) manual.style.display = tab === 'manual' ? 'block' : 'none';
  const activeStyle   = 'padding:6px 14px;border-radius:6px;border:none;font-size:12px;font-weight:700;cursor:pointer;background:var(--gw-surface);color:var(--gw-ink,#1F2A2B)';
  const inactiveStyle = 'padding:6px 14px;border-radius:6px;border:none;font-size:12px;font-weight:700;cursor:pointer;background:transparent;color:#6F7E6A';
  if (tabG) tabG.style.cssText = tab === 'gmail'  ? activeStyle : inactiveStyle;
  if (tabM) tabM.style.cssText = tab === 'manual' ? activeStyle : inactiveStyle;
}

async function umFetchGmailSig() {
  const btn = document.getElementById('um-sig-fetch-btn');
  const status = document.getElementById('um-sig-fetch-status');
  if (btn) { btn.textContent = 'Fetching…'; btn.disabled = true; }
  if (status) status.textContent = '';

  const rep = window.getCurrentRep ? window.getCurrentRep() : null;
  if (!rep) { if (btn) { btn.innerHTML = '<img src="https://www.google.com/favicon.ico" style="width:14px;height:14px"> Fetch from Gmail'; btn.disabled = false; } return; }

  try {
    // Use integrations.js helper if available (has access to current token)
    let sig = '';
    if (typeof window.gmailRefreshSignature === 'function') {
      sig = await window.gmailRefreshSignature();
    } else {
      // Direct fetch using token from user record
      const map = umLoadUserGoogle();
      const gc  = map[rep.id];
      if (!gc?.token) throw new Error('No token');
      const r = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/settings/sendAs', {
        headers: { Authorization: `Bearer ${gc.token}` }
      });
      if (!r.ok) throw new Error(`Gmail API ${r.status}`);
      const j = await r.json();
      const primary = (j.sendAs||[]).find(s=>s.isDefault) || (j.sendAs||[])[0];
      sig = primary?.signature || '';
      // Cache it
      map[rep.id].signature = sig;
      umSaveUserGoogle(map);
    }

    if (status) status.textContent = sig ? 'Fetched!' : 'No signature found in Gmail.';

    // Re-render to show the preview
    const container = document.getElementById('um-sig-fetch-btn')?.closest('section')?.parentElement;
    if (container) umRenderSignatureEditor(container);

    if (sig) umToast('Gmail signature fetched', 'ok');
    else umToast('No signature found in Gmail — use Manual Editor', 'warn');
  } catch(e) {
    if (status) status.textContent = 'Error: ' + e.message;
    umToast('Could not fetch Gmail signature: ' + e.message, 'error');
  } finally {
    if (btn) { btn.innerHTML = '<img src="https://www.google.com/favicon.ico" style="width:14px;height:14px"> Fetch from Gmail'; btn.disabled = false; }
  }
}

async function umSaveSigFromGmail() {
  const rep = window.getCurrentRep ? window.getCurrentRep() : null;
  if (!rep) return;
  const map = umLoadUserGoogle();
  const sig = map[rep.id]?.signature || '';
  await _umSaveSigToD1(rep, sig);
}

async function umSaveSigManual() {
  const rep = window.getCurrentRep ? window.getCurrentRep() : null;
  if (!rep) return;
  const val = document.getElementById('um-sig-manual-input')?.value || '';
  await _umSaveSigToD1(rep, val);
}

async function _umSaveSigToD1(rep, sig) {
  try {
    const res = await fetch(`/api/reps/${rep.id}`, {
      method: 'PUT',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email_signature: sig })
    });
    const j = await res.json();
    if (j.ok) {
      // Update the in-memory rep record so compose picks it up immediately
      if (window.getCurrentRep) {
        const cr = window.getCurrentRep();
        if (cr) cr.email_signature = sig;
      }
      umToast('Signature saved', 'ok');
      const badge = document.getElementById('um-sig-saved-badge');
      if (badge) { badge.style.display = 'inline-flex'; setTimeout(() => { badge.style.display = 'none'; }, 3000); }
      // Re-render to show active signature
      const container = document.getElementById('um-sig-manual-input')?.closest('section')?.parentElement
                     || document.getElementById('um-sig-gmail-preview')?.closest('section')?.parentElement;
      if (container) umRenderSignatureEditor(container);
    } else {
      umToast(j.error || 'Could not save signature', 'error');
    }
  } catch(e) {
    umToast('Network error saving signature', 'error');
  }
}

async function umClearSig() {
  if (!confirm('Remove your email signature?')) return;
  const rep = window.getCurrentRep ? window.getCurrentRep() : null;
  if (!rep) return;
  await _umSaveSigToD1(rep, '');
}

function umSigPreviewManual() {
  const val = document.getElementById('um-sig-manual-input')?.value || '';
  const preview = document.getElementById('um-sig-manual-preview');
  if (!preview) return;
  if (!val) { preview.style.display = 'none'; return; }
  preview.innerHTML = val;
  preview.style.display = 'block';
}

// ═══════════════════════════════════════════════════════════════════════════════
// Per-user Google connect / disconnect — module-level so always available
// regardless of which view rendered first. Called from Integrations view,
// Settings widget, and User Management workspace tab.
// ═══════════════════════════════════════════════════════════════════════════════
async function umMyConnect() {
  const clientId = (() => {
    try { return JSON.parse(localStorage.getItem('avalonIntegrationsV1') || '{}').googleClientId || ''; } catch(e) { return ''; }
  })();
  if (!clientId) {
    umToast('Google Client ID not configured. Ask your Admin to set it up in Integrations.', 'warn');
    return;
  }

  const scopes = [
    'https://www.googleapis.com/auth/gmail.compose',
    'https://www.googleapis.com/auth/gmail.readonly',
    'https://www.googleapis.com/auth/gmail.settings.basic',
    'https://www.googleapis.com/auth/calendar.events',
    'https://www.googleapis.com/auth/calendar.readonly',
    'https://www.googleapis.com/auth/drive.readonly',
    'email', 'profile'
  ].join(' ');

  const state  = Math.random().toString(36).slice(2);
  // NOTE: nonce must NOT be sent with response_type=token (implicit flow).
  // It is only valid for id_token flows. Including it causes Error 400.
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: `${location.origin}/auth/google/callback`,
    response_type: 'token',
    scope: scopes,
    state,
    prompt: 'select_account'
  });

  const popup = window.open(
    `https://accounts.google.com/o/oauth2/v2/auth?${params}`,
    'google_oauth',
    'width=520,height=600,scrollbars=yes,resizable=yes'
  );
  if (!popup) { umToast('Popup blocked — allow popups for this site', 'warn'); return; }

  umToast('Google sign-in window opened…');

  const timer = setInterval(async () => {
    try {
      if (popup.closed) { clearInterval(timer); return; }
      let hash = '';
      try { hash = popup.location.hash; } catch(e) { return; } // cross-origin until redirect
      if (!hash) return;
      const hp = new URLSearchParams(hash.replace(/^#/, ''));
      const accessToken = hp.get('access_token');
      const expiresIn   = parseInt(hp.get('expires_in') || '3600');
      if (!accessToken) return;
      clearInterval(timer);
      if (!popup.closed) popup.close();

      // Fetch the Google account email for this token
      let googleEmail = '';
      try {
        const res  = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
          headers: { Authorization: `Bearer ${accessToken}` }
        });
        const info = await res.json();
        googleEmail = info.email || '';
      } catch(e) {}

      // Store under this user's ID only
      const rep = window.getCurrentRep ? window.getCurrentRep() : null;
      if (!rep) return;
      const map = umLoadUserGoogle();
      // Try to fetch Gmail sendAs signature right away
      let gmailSig = '';
      try {
        const sigRes = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/settings/sendAs', {
          headers: { Authorization: `Bearer ${accessToken}` }
        });
        if (sigRes.ok) {
          const sigJ = await sigRes.json();
          const primary = (sigJ.sendAs || []).find(s => s.isDefault) || (sigJ.sendAs || [])[0];
          gmailSig = primary?.signature || '';
        }
      } catch(sigErr) { /* scope may not be granted yet — silent */ }

      map[rep.id] = {
        token: accessToken,
        expiry: Date.now() + expiresIn * 1000,
        email: googleEmail,
        gmail: true,
        calendar: true,
        drive: true,
        signature: gmailSig,
        connectedAt: new Date().toISOString()
      };
      umSaveUserGoogle(map);
      umAddAuditEntry({ type: 'google_connected', userId: rep.id, userName: rep.name, by: rep.name });
      const sigMsg = gmailSig ? ' (signature synced)' : '';
      umToast(`Google connected as ${googleEmail}${sigMsg}`);

      // Refresh whatever view is currently visible
      if (typeof window.integrations === 'function') window.integrations();
      else if (typeof window.show === 'function') window.show('settings');
    } catch(e) {}
  }, 800);

  // Safety: kill the poller after 2 minutes regardless
  setTimeout(() => {
    clearInterval(timer);
    if (!popup.closed) popup.close();
  }, 120000);
}

function umMyDisconnect() {
  const rep = window.getCurrentRep ? window.getCurrentRep() : null;
  if (!rep) return;
  if (!confirm('Disconnect your Google account? You will need to reconnect to use Gmail, Calendar, and Drive.')) return;
  const map = umLoadUserGoogle();
  delete map[rep.id];
  umSaveUserGoogle(map);
  // Also clear the legacy shared slot so it doesn't bleed through the fallback
  try {
    const intState = JSON.parse(localStorage.getItem('avalonIntegrationsV1') || '{}');
    delete intState.googleToken;
    delete intState.googleExpiry;
    delete intState.googleEmail;
    localStorage.setItem('avalonIntegrationsV1', JSON.stringify(intState));
  } catch(e) {}
  umAddAuditEntry({ type: 'google_disconnected', userId: rep.id, userName: rep.name, by: rep.name });
  umToast('Google account disconnected');
  // Refresh the visible view
  if (typeof window.integrations === 'function') window.integrations();
  else if (typeof window.show === 'function') window.show('settings');
}

// Expose on window immediately — available as soon as user_management.js loads,
// regardless of which view has rendered. This is the single source of truth
// for per-user Google connect/disconnect across Integrations, Settings, and
// User Management workspace tab.
window._umMyConnect    = umMyConnect;
window._umMyDisconnect = umMyDisconnect;

// ── Helper: get current user's Google token (used by integrations.js patches) ──
window.umGetUserGoogleToken = function() {
  const rep = window.getCurrentRep ? window.getCurrentRep() : null;
  if (!rep) return null;
  const map = umLoadUserGoogle();
  const gc  = map[rep.id];
  if (!gc || !gc.token || Date.now() >= (gc.expiry || 0)) return null;
  return gc.token;
};

window.umGetUserGoogleEmail = function() {
  const rep = window.getCurrentRep ? window.getCurrentRep() : null;
  if (!rep) return '';
  const map = umLoadUserGoogle();
  return map[rep.id]?.email || '';
};

window.umIsUserGoogleConnected = function() {
  return !!window.umGetUserGoogleToken();
};

// ── Intercept login to record audit events ─────────────────────────────────────
(function patchLoginAudit() {
  // Wait for loginRep / logoutRep to be defined by reps.js, then wrap them
  function tryPatch() {
    if (window.loginRep && !window.loginRep._auditPatched) {
      const _orig = window.loginRep;
      window.loginRep = function(repId) {
        _orig(repId);
        const u = (window.REPS||[]).find(r=>r.id===repId);
        umAddAuditEntry({ type: 'login', userId: repId, userName: u?.name||repId, by: u?.name||repId });
      };
      window.loginRep._auditPatched = true;
    }
    if (window.logoutRep && !window.logoutRep._auditPatched) {
      const _orig = window.logoutRep;
      window.logoutRep = function() {
        const rep = window.getCurrentRep ? window.getCurrentRep() : null;
        _orig();
        if (rep) umAddAuditEntry({ type: 'logout', userId: rep.id, userName: rep.name, by: rep.name });
      };
      window.logoutRep._auditPatched = true;
    }
  }
  // Try immediately and again after a short delay (scripts load order)
  tryPatch();
  setTimeout(tryPatch, 500);
})();

// ── CSS for form inputs ────────────────────────────────────────────────────────
(function injectUmStyles() {
  if (document.getElementById('um-styles')) return;
  const style = document.createElement('style');
  style.id = 'um-styles';
  style.textContent = `
    .um-label {
      display: block;
      font-size: 11px;
      font-weight: 600;
      color: #6F7E6A;
      text-transform: uppercase;
      letter-spacing: .05em;
      margin-bottom: 6px;
    }
    .um-input {
      width: 100%;
      padding: 10px 12px;
      background: var(--gw-surface-3);
      border: 1px solid var(--gw-line);
      border-radius: 8px;
      color: #E8E4D9;
      font-size: 13px;
      box-sizing: border-box;
      transition: border-color .15s;
      font-family: inherit;
    }
    .um-input:focus {
      outline: none;
      border-color: #4D8A86;
    }
    .um-input option {
      background: var(--gw-surface-3);
    }
  `;
  document.head.appendChild(style);
})();

// ── Expose to global scope ────────────────────────────────────────────────────
window.userManagement = userManagement;
window.umRenderMyGoogleConnection = umRenderMyGoogleConnection;
window.umLoadUsers = umLoadUsers;
window.umSaveUsers = umSaveUsers;
window.umAddAuditEntry = umAddAuditEntry;
window.umLoadUserGoogle = umLoadUserGoogle;
window.umSaveUserGoogle = umSaveUserGoogle;
window.umRenderSignatureEditor = umRenderSignatureEditor;
window.umFetchGmailSig  = umFetchGmailSig;
window.umSaveSigFromGmail = umSaveSigFromGmail;
window.umSaveSigManual  = umSaveSigManual;
window.umSigPreviewManual = umSigPreviewManual;
window.umSigSwitchTab   = umSigSwitchTab;
window.umClearSig       = umClearSig;
