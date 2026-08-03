/**
 * Groundwork CRM — Phase 8 Platform Core
 *
 * Shared registries and platform primitives:
 *   - GW_VIEWS          — canonical view registry (all 50+ views, hub, kind)
 *   - GW_CAP            — capability flag registry with metadata
 *   - GW_AUDIT_TYPES    — audit event type registry
 *   - GW_APPROVAL_TYPES — reusable approval type registry
 *   - GW_TRIGGER_DEFS   — automation trigger registry
 *   - GW_ACTION_DEFS    — automation action registry
 *   - GW_COMMS_TYPES    — communication type registry
 *   - GW_PORTAL_RECORD_TYPES — portal-visible record types
 *   - gwCan(cap)        — live capability check for current user
 *   - gwScope(domain)   — live scope check for current user
 *   - gwAudit(event)    — write an audit event (localStorage + D1 hook)
 *   - gwEmit(event,payload) — cross-hub event bus
 */

'use strict';

// ══════════════════════════════════════════════════════════════════════════════
// 1. VIEW REGISTRY
// ══════════════════════════════════════════════════════════════════════════════
window.GW_VIEWS = {
  // Dashboard
  today:              { label:'Today',             hub:'dashboard', kind:'page' },
  myDashboard:        { label:'My Dashboard',      hub:'dashboard', kind:'page' },
  teamView:           { label:'Team View',          hub:'dashboard', kind:'page' },
  // Sales
  pipeline:           { label:'Pipeline',           hub:'sales',     kind:'board' },
  lead:               { label:'Leads',              hub:'sales',     kind:'record' },
  clients:            { label:'Clients',            hub:'sales',     kind:'list' },
  properties:         { label:'Properties',         hub:'sales',     kind:'list' },
  estimates:          { label:'Estimates',          hub:'sales',     kind:'record' },
  communications:     { label:'Communications',     hub:'sales',     kind:'board' },
  automations:        { label:'Automations',        hub:'platform',  kind:'engine' },
  templates:          { label:'Templates',          hub:'sales',     kind:'list' },
  campaigns:          { label:'Campaigns',          hub:'sales',     kind:'list' },
  process:            { label:'Sales Process',      hub:'sales',     kind:'page' },
  forms:              { label:'Forms',              hub:'sales',     kind:'list' },
  scripts:            { label:'Scripts',            hub:'sales',     kind:'list' },
  emailTemplates:     { label:'Email Templates',    hub:'sales',     kind:'list' },
  objections:         { label:'Objection Handling', hub:'sales',     kind:'list' },
  calculator:         { label:'Pricing Tools',      hub:'sales',     kind:'tool' },
  ai:                 { label:'AI Assistant',       hub:'sales',     kind:'tool' },
  academy:            { label:'Academy',            hub:'sales',     kind:'page' },
  // Financial
  financialHub:       { label:'Financial Overview', hub:'financial', kind:'page' },
  invoices:           { label:'Invoices',           hub:'financial', kind:'record' },
  payments:           { label:'Payments',           hub:'financial', kind:'list' },
  deposits:           { label:'Deposits',           hub:'financial', kind:'list' },
  statements:         { label:'Statements',         hub:'financial', kind:'list' },
  financialActivity:  { label:'Financial Activity', hub:'financial', kind:'list' },
  // Operations
  scheduleBoard:      { label:'Calendar',           hub:'operations', kind:'board' },
  dispatchBoard:      { label:'Dispatch',           hub:'operations', kind:'board' },
  recurringServices:  { label:'Recurring Services', hub:'operations', kind:'list' },
  crewView:           { label:'Crew View',          hub:'operations', kind:'board' },
  workOrderList:      { label:'Work Orders',        hub:'operations', kind:'list' },
  workOrderDetail:    { label:'Work Order',         hub:'operations', kind:'record' },
  assetList:          { label:'Assets',             hub:'operations', kind:'list' },
  assetDetail:        { label:'Asset Detail',       hub:'operations', kind:'record' },
  maintenanceQueue:   { label:'Maintenance',        hub:'operations', kind:'list' },
  inventoryList:      { label:'Inventory',          hub:'operations', kind:'list' },
  materialAllocation: { label:'Material Allocation',hub:'operations', kind:'page' },
  toolsConsumables:   { label:'Tools & Consumables',hub:'operations', kind:'list' },
  timeTracker:        { label:'Time Tracker',       hub:'operations', kind:'tool' },
  // Reports
  revenueAdmin:       { label:'Revenue',            hub:'reports',   kind:'report' },
  teamReports:        { label:'Team Reports',       hub:'reports',   kind:'report' },
  // Settings
  settings:           { label:'General Settings',   hub:'settings',  kind:'page' },
  userManagement:     { label:'Users & Roles',      hub:'settings',  kind:'page' },
  integrations:       { label:'Integrations',       hub:'settings',  kind:'page' },
  manager:            { label:'Manager Tools',      hub:'settings',  kind:'page' },
  systemConfig:       { label:'System Config',      hub:'settings',  kind:'page' },
  systemTemplates:    { label:'Templates & Automations', hub:'settings', kind:'page' },
  // Phase 8
  approvalQueue:      { label:'Approvals',          hub:'platform',  kind:'queue' },
  auditLog:           { label:'Audit Log',          hub:'platform',  kind:'log' },
  fieldMode:          { label:'Field Mode',         hub:'field',     kind:'page' },
  // Platform Admin
  gwTenants:          { label:'Tenants',            hub:'platform_admin', kind:'list' },
  gwLeads:            { label:'Sales Pipeline',     hub:'platform_admin', kind:'board' },
  gwSupport:          { label:'Support & Tickets',  hub:'platform_admin', kind:'list' },
  gwAnnounce:         { label:'Announcements',      hub:'platform_admin', kind:'list' },
  gwBilling:          { label:'Billing & Plans',    hub:'platform_admin', kind:'page' },
  gwPlatformSettings: { label:'Platform Settings',  hub:'platform_admin', kind:'page' },
  superAdmin:         { label:'Platform Overview',  hub:'platform_admin', kind:'page' },
  // Legacy
  statement:          { label:'Account Statement',  hub:'financial', kind:'record' },
  opsHub:             { label:'Operations Hub',     hub:'operations', kind:'page' },
};

// ══════════════════════════════════════════════════════════════════════════════
// 2. CAPABILITY FLAG REGISTRY
// ══════════════════════════════════════════════════════════════════════════════
window.GW_CAP = {
  // Sales
  can_create_lead:              { label:'Create Leads',           group:'sales' },
  can_edit_lead:                { label:'Edit Leads',             group:'sales' },
  can_delete_leads:             { label:'Delete Leads',           group:'sales' },
  can_create_estimate:          { label:'Create Estimates',       group:'sales' },
  can_edit_estimate:            { label:'Edit Estimates',         group:'sales' },
  can_send_estimate:            { label:'Send Estimates',         group:'sales' },
  // Financial
  can_create_invoice:           { label:'Create Invoices',        group:'financial' },
  can_send_invoice:             { label:'Send Invoices',          group:'financial' },
  can_record_payment:           { label:'Record Payments',        group:'financial' },
  // Operations
  can_assign_schedule:          { label:'Assign Schedule',        group:'operations' },
  can_dispatch_crews:           { label:'Dispatch Crews',         group:'operations' },
  can_edit_work_order:          { label:'Edit Work Orders',       group:'operations' },
  can_mark_work_order_complete: { label:'Complete Work Orders',   group:'operations' },
  can_manage_assets:            { label:'Manage Assets',          group:'operations' },
  can_manage_inventory:         { label:'Manage Inventory',       group:'operations' },
  // People / Time
  can_edit_time:                { label:'Edit Time Entries',      group:'people' },
  can_approve_time:             { label:'Approve Time',           group:'people' },
  // Platform / Admin
  can_manage_users:             { label:'Manage Users',           group:'admin' },
  can_manage_roles:             { label:'Manage Roles',           group:'admin' },
  can_manage_integrations:      { label:'Manage Integrations',    group:'admin' },
  can_edit_system_settings:     { label:'Edit System Settings',   group:'admin' },
  // Phase 8 new caps
  can_approve_requests:         { label:'Approve Requests',       group:'platform' },
  can_manage_automations:       { label:'Manage Automations',     group:'platform' },
  can_view_audit_logs:          { label:'View Audit Logs',        group:'platform' },
  can_manage_portal_access:     { label:'Manage Portal Access',   group:'platform' },
};

// ══════════════════════════════════════════════════════════════════════════════
// 3. AUDIT EVENT TYPE REGISTRY
// ══════════════════════════════════════════════════════════════════════════════
window.GW_AUDIT_TYPES = {
  // Role / Permission
  role_changed:           'Role changed',
  permission_changed:     'Permission changed',
  user_created:           'User created',
  user_deactivated:       'User deactivated',
  // Approvals
  approval_requested:     'Approval requested',
  approval_approved:      'Approved',
  approval_rejected:      'Rejected',
  approval_cancelled:     'Approval cancelled',
  approval_resubmitted:   'Resubmitted for approval',
  // Records
  status_changed:         'Status changed',
  stage_changed:          'Stage changed',
  assignment_changed:     'Assignment changed',
  estimate_sent:          'Estimate sent',
  estimate_approved:      'Estimate approved',
  estimate_declined:      'Estimate declined',
  invoice_sent:           'Invoice sent',
  invoice_paid:           'Invoice paid',
  work_order_completed:   'Work order completed',
  work_order_reopened:    'Work order reopened',
  time_approved:          'Time entry approved',
  time_rejected:          'Time entry rejected',
  // Automations
  automation_created:     'Automation created',
  automation_updated:     'Automation updated',
  automation_deleted:     'Automation deleted',
  automation_triggered:   'Automation triggered',
  // System
  settings_changed:       'System settings changed',
  integration_changed:    'Integration changed',
  portal_access_granted:  'Portal access granted',
  portal_access_revoked:  'Portal access revoked',
  // Communications
  message_sent:           'Message sent',
  communication_logged:   'Communication logged',
};

// ══════════════════════════════════════════════════════════════════════════════
// 4. APPROVAL TYPE REGISTRY
// ══════════════════════════════════════════════════════════════════════════════
window.GW_APPROVAL_TYPES = {
  estimate:         { label:'Estimate Approval',         entityType:'estimate',    requiredCap:'can_approve_requests' },
  change_order:     { label:'Change Order',              entityType:'change_order', requiredCap:'can_approve_requests' },
  invoice_credit:   { label:'Invoice Credit',            entityType:'invoice',      requiredCap:'can_approve_requests' },
  purchase:         { label:'Purchase Request',          entityType:'purchase',     requiredCap:'can_approve_requests' },
  pto_request:      { label:'PTO Request',               entityType:'pto',          requiredCap:'can_approve_time' },
  work_order_exception: { label:'Work Order Exception',  entityType:'work_order',   requiredCap:'can_mark_work_order_complete' },
  settings_change:  { label:'Admin Settings Change',     entityType:'settings',     requiredCap:'can_edit_system_settings' },
};

// ══════════════════════════════════════════════════════════════════════════════
// 5. AUTOMATION TRIGGER REGISTRY
// ══════════════════════════════════════════════════════════════════════════════
window.GW_TRIGGER_DEFS = [
  { id:'estimate_approved',      label:'Estimate Approved',           hub:'sales',      icon:'check-circle' },
  { id:'estimate_sent',          label:'Estimate Sent',               hub:'sales',      icon:'send' },
  { id:'lead_created',           label:'Lead Created',                hub:'sales',      icon:'user-plus' },
  { id:'lead_stage_changed',     label:'Lead Stage Changed',          hub:'sales',      icon:'arrow-right' },
  { id:'deposit_received',       label:'Deposit Received',            hub:'financial',  icon:'dollar' },
  { id:'invoice_overdue',        label:'Invoice Overdue',             hub:'financial',  icon:'alert' },
  { id:'invoice_paid',           label:'Invoice Paid',                hub:'financial',  icon:'check' },
  { id:'work_order_completed',   label:'Work Order Completed',        hub:'operations', icon:'check-square' },
  { id:'work_order_assigned',    label:'Work Order Assigned',         hub:'operations', icon:'clipboard' },
  { id:'schedule_assigned',      label:'Schedule Assigned',           hub:'operations', icon:'calendar' },
  { id:'time_submitted',         label:'Time Entry Submitted',        hub:'operations', icon:'clock' },
  { id:'pto_requested',          label:'PTO Requested',               hub:'people',     icon:'calendar-off' },
  { id:'pto_approved',           label:'PTO Approved',                hub:'people',     icon:'calendar-check' },
  { id:'user_created',           label:'User Created',                hub:'admin',      icon:'user' },
  { id:'role_changed',           label:'Role Changed',                hub:'admin',      icon:'shield' },
  { id:'client_message',         label:'Client Message Received',     hub:'comms',      icon:'message' },
  { id:'portal_action',          label:'Portal Action',               hub:'portal',     icon:'external-link' },
];

// ══════════════════════════════════════════════════════════════════════════════
// 6. AUTOMATION ACTION REGISTRY
// ══════════════════════════════════════════════════════════════════════════════
window.GW_ACTION_DEFS = [
  { id:'create_task',           label:'Create Task',                  category:'records' },
  { id:'create_work_order',     label:'Create Work Order',            category:'records' },
  { id:'update_status',         label:'Update Status / Stage',        category:'records' },
  { id:'assign_user',           label:'Assign to User / Team',        category:'records' },
  { id:'notify_user',           label:'Notify User',                  category:'comms' },
  { id:'notify_team',           label:'Notify Team',                  category:'comms' },
  { id:'send_email',            label:'Send Email (Template)',         category:'comms' },
  { id:'send_sms',              label:'Send SMS (Template)',           category:'comms' },
  { id:'log_communication',     label:'Log Communication',            category:'comms' },
  { id:'enqueue_approval',      label:'Request Approval',             category:'workflow' },
  { id:'unlock_scheduling',     label:'Unlock Scheduling',            category:'workflow' },
  { id:'write_audit_event',     label:'Write Audit Event',            category:'workflow' },
  { id:'send_portal_link',      label:'Send Portal Link to Client',   category:'portal' },
  { id:'update_portal_access',  label:'Update Portal Access',         category:'portal' },
];

// ══════════════════════════════════════════════════════════════════════════════
// 7. COMMUNICATION TYPE REGISTRY
// ══════════════════════════════════════════════════════════════════════════════
window.GW_COMMS_TYPES = {
  email:       { label:'Email',          icon:'mail',     color:'#3B6EA5' },
  sms:         { label:'SMS',            icon:'message',  color:'#2D7A55' },
  call:        { label:'Phone Call',     icon:'phone',    color:'#6B5EA8' },
  note:        { label:'Internal Note',  icon:'note',     color:'#8B6914' },
  meeting:     { label:'Meeting',        icon:'users',    color:'#4D8A86' },
  portal_msg:  { label:'Portal Message', icon:'external', color:'#5B7FA6' },
  automated:   { label:'Automated',      icon:'zap',      color:'#7A7A6E' },
};

// ══════════════════════════════════════════════════════════════════════════════
// 8. PORTAL RECORD TYPES
// ══════════════════════════════════════════════════════════════════════════════
window.GW_PORTAL_RECORD_TYPES = {
  estimate:   { label:'Estimate / Proposal', canApprove:true,  canDecline:true  },
  invoice:    { label:'Invoice',             canApprove:false, canDecline:false },
  deposit:    { label:'Deposit Request',     canApprove:true,  canDecline:false },
  statement:  { label:'Account Statement',   canApprove:false, canDecline:false },
  document:   { label:'Document',           canApprove:false, canDecline:false },
  job_status: { label:'Job Status',          canApprove:false, canDecline:false },
};

// ══════════════════════════════════════════════════════════════════════════════
// 9. CAPABILITY CHECK ENGINE
// gwCan(cap) — returns true/false for current logged-in user
// gwScope(domain) — returns 'self'|'team'|'all'|'none' for current user
// ══════════════════════════════════════════════════════════════════════════════

function gwCan(cap) {
  // Get current user
  const rep = window.getCurrentRep ? window.getCurrentRep() : null;
  if (!rep) return false;
  // Admin bypasses all caps
  if (rep.role === 'admin') return true;
  // D1 session rep takes priority
  const sessionRep = window._d1SessionRep;
  if (sessionRep && sessionRep.role === 'admin') return true;
  // Look up role definition
  const roleDefs = window.getRoleDefs ? window.getRoleDefs() : [];
  const roleDef = roleDefs.find(r => r.id === (sessionRep?.role || rep.role));
  if (!roleDef) return false;
  return !!(roleDef.capabilities && roleDef.capabilities[cap]);
}

function gwScope(domain) {
  const rep = window.getCurrentRep ? window.getCurrentRep() : null;
  if (!rep) return 'none';
  if (rep.role === 'admin') return 'all';
  const sessionRep = window._d1SessionRep;
  const role = sessionRep?.role || rep.role;
  const roleDefs = window.getRoleDefs ? window.getRoleDefs() : [];
  const roleDef = roleDefs.find(r => r.id === role);
  if (!roleDef || !roleDef.scope) return 'self';
  return roleDef.scope[domain] || 'none';
}

window.gwCan   = gwCan;
window.gwScope = gwScope;

// ══════════════════════════════════════════════════════════════════════════════
// 10. AUDIT ENGINE
// gwAudit(event) — writes a structured audit event
// Events are stored in localStorage (gwAuditLog) and optionally pushed to D1.
// ══════════════════════════════════════════════════════════════════════════════

const GW_AUDIT_KEY = 'gwAuditLog';
const GW_AUDIT_MAX = 500; // rolling window

function gwAudit(event) {
  // event: { type, entityType?, entityId?, entityLabel?, summary, meta? }
  const rep = window._d1SessionRep || (window.getCurrentRep ? window.getCurrentRep() : null);
  const entry = {
    id:          'aud_' + Date.now() + '_' + Math.random().toString(16).slice(2,6),
    type:        event.type || 'unknown',
    entityType:  event.entityType  || null,
    entityId:    event.entityId    || null,
    entityLabel: event.entityLabel || null,
    summary:     event.summary     || GW_AUDIT_TYPES[event.type] || event.type,
    actorId:     rep?.id   || null,
    actorName:   rep?.name || 'System',
    actorRole:   rep?.role || null,
    ts:          new Date().toISOString(),
    meta:        event.meta || null,
  };

  // Write to localStorage rolling log
  try {
    let log = [];
    try { log = JSON.parse(localStorage.getItem(GW_AUDIT_KEY) || '[]'); } catch(_) {}
    log.unshift(entry);
    if (log.length > GW_AUDIT_MAX) log.length = GW_AUDIT_MAX;
    localStorage.setItem(GW_AUDIT_KEY, JSON.stringify(log));
  } catch(_) {}

  // Fire-and-forget to D1 if available
  if (window._d1Ready && window.DB) {
    fetch('/api/audit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify(entry)
    }).catch(() => {});
  }

  // Emit to internal bus so other modules can react
  gwEmit('audit:event', entry);

  return entry;
}

window.gwAudit = gwAudit;

// ══════════════════════════════════════════════════════════════════════════════
// 11. CROSS-HUB EVENT BUS
// gwEmit(eventType, payload) — broadcast platform event
// gwOn(eventType, handler)   — subscribe to platform event
// ══════════════════════════════════════════════════════════════════════════════

const _gwBusListeners = {};

function gwEmit(type, payload) {
  const handlers = _gwBusListeners[type] || [];
  handlers.forEach(fn => { try { fn(payload); } catch(_) {} });
  // Also dispatch as DOM custom event for loose coupling
  try {
    document.dispatchEvent(new CustomEvent('gw:' + type, { detail: payload, bubbles: false }));
  } catch(_) {}
}

function gwOn(type, handler) {
  if (!_gwBusListeners[type]) _gwBusListeners[type] = [];
  _gwBusListeners[type].push(handler);
}

function gwOff(type, handler) {
  if (!_gwBusListeners[type]) return;
  _gwBusListeners[type] = _gwBusListeners[type].filter(h => h !== handler);
}

window.gwEmit = gwEmit;
window.gwOn   = gwOn;
window.gwOff  = gwOff;

// ══════════════════════════════════════════════════════════════════════════════
// 12. COMMUNICATIONS REGISTRY
// Central record for any logged communication tied to an entity.
// ══════════════════════════════════════════════════════════════════════════════

const GW_COMMS_KEY = 'gwCommunicationsLog';

function gwLogComm(comm) {
  // comm: { type, entityType, entityId, entityLabel, subject?, body?, channel?, fromId?, toId?, automationId?, status }
  const rep = window._d1SessionRep || (window.getCurrentRep ? window.getCurrentRep() : null);
  const entry = {
    id:          'comm_' + Date.now() + '_' + Math.random().toString(16).slice(2,6),
    type:        comm.type        || 'note',
    entityType:  comm.entityType  || null,
    entityId:    comm.entityId    || null,
    entityLabel: comm.entityLabel || null,
    subject:     comm.subject     || null,
    body:        comm.body        || null,
    channel:     comm.channel     || comm.type || 'note',
    fromId:      comm.fromId      || rep?.id || null,
    fromName:    comm.fromName    || rep?.name || 'System',
    toId:        comm.toId        || null,
    automationId:comm.automationId|| null,
    status:      comm.status      || 'sent',
    ts:          new Date().toISOString(),
  };
  try {
    let log = [];
    try { log = JSON.parse(localStorage.getItem(GW_COMMS_KEY) || '[]'); } catch(_) {}
    log.unshift(entry);
    if (log.length > 1000) log.length = 1000;
    localStorage.setItem(GW_COMMS_KEY, JSON.stringify(log));
  } catch(_) {}
  gwAudit({ type:'communication_logged', entityType:entry.entityType, entityId:entry.entityId, entityLabel:entry.entityLabel, summary:`${GW_COMMS_TYPES[entry.type]?.label||entry.type} sent` });
  return entry;
}

function gwGetComms(filter) {
  // filter: { entityId?, entityType?, type? }
  try {
    const log = JSON.parse(localStorage.getItem(GW_COMMS_KEY) || '[]');
    return log.filter(c => {
      if (filter?.entityId   && c.entityId   !== filter.entityId)   return false;
      if (filter?.entityType && c.entityType !== filter.entityType) return false;
      if (filter?.type       && c.type       !== filter.type)       return false;
      return true;
    });
  } catch(_) { return []; }
}

window.gwLogComm  = gwLogComm;
window.gwGetComms = gwGetComms;

// ══════════════════════════════════════════════════════════════════════════════
// 13. CROSS-HUB WORKFLOW HOOKS
// Called by domain modules when key business events happen.
// These emit to the event bus and trigger automation evaluation.
// ══════════════════════════════════════════════════════════════════════════════

window.gwWorkflow = {
  estimateApproved(estimateId, estimateLabel) {
    gwAudit({ type:'estimate_approved', entityType:'estimate', entityId:estimateId, entityLabel:estimateLabel });
    gwEmit('estimate_approved', { estimateId, estimateLabel });
    if (window.gwAutomation?.evaluate) gwAutomation.evaluate('estimate_approved', { estimateId });
  },
  depositReceived(invoiceId, amount) {
    gwAudit({ type:'invoice_paid', entityType:'invoice', entityId:invoiceId, summary:`Deposit of $${amount} received` });
    gwEmit('deposit_received', { invoiceId, amount });
    if (window.gwAutomation?.evaluate) gwAutomation.evaluate('deposit_received', { invoiceId, amount });
  },
  workOrderCompleted(woId, woLabel) {
    gwAudit({ type:'work_order_completed', entityType:'work_order', entityId:woId, entityLabel:woLabel });
    gwEmit('work_order_completed', { woId, woLabel });
    if (window.gwAutomation?.evaluate) gwAutomation.evaluate('work_order_completed', { woId, woLabel });
  },
  roleChanged(userId, oldRole, newRole) {
    gwAudit({ type:'role_changed', entityType:'user', entityId:userId, summary:`Role changed from ${oldRole} to ${newRole}`, meta:{oldRole,newRole} });
    gwEmit('role_changed', { userId, oldRole, newRole });
  },
  ptoApproved(userId, ptoId) {
    gwAudit({ type:'approval_approved', entityType:'pto', entityId:ptoId, summary:'PTO approved' });
    gwEmit('pto_approved', { userId, ptoId });
    if (window.gwAutomation?.evaluate) gwAutomation.evaluate('pto_approved', { userId, ptoId });
  },
  communicationSent(comm) {
    gwLogComm(comm);
    gwEmit('communication_sent', comm);
    if (window.gwAutomation?.evaluate) gwAutomation.evaluate('client_message', comm);
  },
  permissionChanged(userId, changes) {
    gwAudit({ type:'permission_changed', entityType:'user', entityId:userId, summary:'Permissions updated', meta:changes });
    gwEmit('permission_changed', { userId, changes });
  },
  automationEdited(ruleId, ruleLabel, action) {
    gwAudit({ type:`automation_${action}`, entityType:'automation', entityId:ruleId, entityLabel:ruleLabel });
    gwEmit('automation_edited', { ruleId, ruleLabel, action });
  },
  portalAction(action, entityType, entityId) {
    gwAudit({ type:'approval_approved', entityType, entityId, summary:`Portal ${action} on ${entityType}` });
    gwEmit('portal_action', { action, entityType, entityId });
    if (window.gwAutomation?.evaluate) gwAutomation.evaluate('portal_action', { action, entityType, entityId });
  },
};

console.info('[GW Platform Core] Phase 8 platform layer initialized.');
