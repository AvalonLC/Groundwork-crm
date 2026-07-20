/**
 * Groundwork CRM — Phase 8 Client Portal Foundation
 *
 * Provides:
 *   - Portal access model (token-based, scoped to client)
 *   - Internal portal management UI (grant/revoke access)
 *   - Portal-facing shell rendered at /portal route
 *   - Limited record visibility: estimates, invoices, deposits, status
 *   - Approve/decline estimate flow from client side
 *
 * Security model:
 *   - Portal tokens stored in gwPortalAccess (localStorage + D1 sync hook)
 *   - Token is a client-specific random string, not an internal session
 *   - Portal views are completely separated from internal navigation
 *   - No internal back-office surfaces exposed to portal
 *
 * Routes:
 *   - Internal: portalAdmin() — manage portal access per client
 *   - External: /portal?token=XXX — renders portal shell
 */

'use strict';

const GW_PORTAL_ACCESS_KEY = 'gwPortalAccess'; // { clientId → { token, clientName, clientEmail, grantedBy, grantedAt, active, visibleTypes[] } }
const GW_PORTAL_ACTIONS_KEY = 'gwPortalActions'; // log of client portal actions

// ── Helpers ───────────────────────────────────────────────────────────────────
function _portalLoad() { try { return JSON.parse(localStorage.getItem(GW_PORTAL_ACCESS_KEY) || '{}'); } catch(_) { return {}; } }
function _portalSave(d) { try { localStorage.setItem(GW_PORTAL_ACCESS_KEY, JSON.stringify(d)); } catch(_) {} }
function _portalToken() { return Array.from(crypto.getRandomValues(new Uint8Array(18))).map(b => b.toString(16).padStart(2,'0')).join(''); }
function _portalActionsLoad() { try { return JSON.parse(localStorage.getItem(GW_PORTAL_ACTIONS_KEY) || '[]'); } catch(_) { return []; } }
function _portalActionsSave(arr) { try { localStorage.setItem(GW_PORTAL_ACTIONS_KEY, JSON.stringify(arr.slice(0,200))); } catch(_) {} }
function _escH(s) { return typeof escapeHtml === 'function' ? escapeHtml(s||'') : (s||'').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c])); }
function _relTime(iso) {
  if (!iso) return '—';
  const diff = Date.now() - new Date(iso).getTime();
  const d = Math.floor(diff / 86400000);
  if (d === 0) return 'Today';
  if (d === 1) return 'Yesterday';
  return new Date(iso).toLocaleDateString(undefined, { month:'short', day:'numeric', year:'numeric' });
}

// ── Portal Access API ─────────────────────────────────────────────────────────
const gwPortal = {

  grant(opts) {
    // opts: { clientId, clientName, clientEmail, visibleTypes[], grantedBy }
    if (!window.gwCan || !gwCan('can_manage_portal_access')) {
      showToast && showToast('You do not have permission to manage portal access.', 'error');
      return null;
    }
    const data = _portalLoad();
    const actor = window._d1SessionRep || (window.getCurrentRep ? window.getCurrentRep() : null);
    const record = {
      clientId:     opts.clientId,
      clientName:   opts.clientName   || opts.clientId,
      clientEmail:  opts.clientEmail  || '',
      token:        _portalToken(),
      grantedBy:    actor?.name || 'Admin',
      grantedAt:    new Date().toISOString(),
      active:       true,
      visibleTypes: opts.visibleTypes || ['estimate', 'invoice', 'job_status'],
    };
    data[opts.clientId] = record;
    _portalSave(data);
    if (window.gwAudit) gwAudit({ type:'portal_access_granted', entityType:'client', entityId:opts.clientId, entityLabel:opts.clientName });
    if (window.gwAutomation) gwAutomation.evaluate('portal_action', { action:'grant', clientId:opts.clientId });
    return record;
  },

  revoke(clientId) {
    if (!window.gwCan || !gwCan('can_manage_portal_access')) {
      showToast && showToast('You do not have permission to manage portal access.', 'error');
      return false;
    }
    const data = _portalLoad();
    if (!data[clientId]) return false;
    data[clientId].active = false;
    data[clientId].revokedAt = new Date().toISOString();
    _portalSave(data);
    if (window.gwAudit) gwAudit({ type:'portal_access_revoked', entityType:'client', entityId:clientId, entityLabel:data[clientId].clientName });
    return true;
  },

  regenerateToken(clientId) {
    const data = _portalLoad();
    if (!data[clientId]) return null;
    data[clientId].token = _portalToken();
    data[clientId].tokenRegeneratedAt = new Date().toISOString();
    _portalSave(data);
    return data[clientId].token;
  },

  getByToken(token) {
    const data = _portalLoad();
    return Object.values(data).find(r => r.token === token && r.active) || null;
  },

  getByClient(clientId) {
    return _portalLoad()[clientId] || null;
  },

  list() { return Object.values(_portalLoad()); },

  logAction(token, action, entityType, entityId, entityLabel) {
    const access = this.getByToken(token);
    const actions = _portalActionsLoad();
    actions.unshift({
      id: 'pa_' + Date.now(),
      token,
      clientId:    access?.clientId    || null,
      clientName:  access?.clientName  || null,
      action,
      entityType,
      entityId,
      entityLabel,
      ts: new Date().toISOString(),
    });
    _portalActionsSave(actions);
    if (window.gwWorkflow) gwWorkflow.portalAction(action, entityType, entityId);
  },

  portalLink(clientId) {
    const record = this.getByClient(clientId);
    if (!record || !record.active) return null;
    return window.location.origin + '/portal?token=' + record.token;
  },
};

window.gwPortal = gwPortal;

// ══════════════════════════════════════════════════════════════════════════════
// INTERNAL: Portal Admin View (D1-backed)
// Accessible at show('portalAdmin') — invite portal users, manage roles,
// property scope, disable/reactivate, and review the portal audit trail.
// Data lives in D1 via /api/admin/portal/* (see src/portal.tsx).
// ══════════════════════════════════════════════════════════════════════════════

const GW_PORTAL_ROLES = {
  account_admin: { label: 'Account Admin', desc: 'Full access: estimates, approvals, billing, payments, documents, contacts' },
  billing:       { label: 'Billing',       desc: 'Invoices, payments, payment methods, autopay, documents' },
  project:       { label: 'Project',       desc: 'Projects, schedules, daily updates, documents. No financials' },
  approver:      { label: 'Approver',      desc: 'View and approve estimates, view projects and documents' },
  read_only:     { label: 'Read Only',     desc: 'View everything permitted, take no actions' },
};

async function _portalApi(url, opts = {}) {
  opts.credentials = 'same-origin';
  if (opts.body && typeof opts.body !== 'string') {
    opts.headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {});
    opts.body = JSON.stringify(opts.body);
  }
  const r = await fetch(url, opts);
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || 'Request failed');
  return d;
}

function _portalStatusPill(u) {
  if (u.status === 'active')   return '<span class="portal-pill portal-pill--green">Active</span>';
  if (u.status === 'disabled') return '<span class="portal-pill portal-pill--red">Disabled</span>';
  const expired = u.invite_expires_at && new Date(u.invite_expires_at.replace(' ', 'T') + 'Z').getTime() < Date.now();
  return expired
    ? '<span class="portal-pill portal-pill--amber">Invite Expired</span>'
    : '<span class="portal-pill portal-pill--blue">Invited</span>';
}

async function portalAdmin() {
  const view = document.getElementById('view');
  if (!view) return;

  view.innerHTML = '<div class="gwp-shell gwp-shell--narrow" style="padding-top:40px;text-align:center;color:var(--gw-text-muted,#9aa5a0);font-size:13px">Loading portal users...</div>';

  let users = [], audit = [];
  try {
    const [uRes, aRes] = await Promise.all([
      _portalApi('/api/admin/portal/users'),
      _portalApi('/api/admin/portal/audit'),
    ]);
    users = uRes.data || [];
    audit = (aRes.data || []).slice(0, 20);
  } catch (e) {
    view.innerHTML = '<div class="gwp-shell gwp-shell--narrow" style="padding-top:40px"><div class="gwp-empty"><div class="gwp-empty-title">Could not load portal data</div><div class="gwp-empty-sub">' + _escH(e.message) + '</div></div></div>';
    return;
  }

  const activeUsers   = users.filter(u => u.status === 'active');
  const invitedUsers  = users.filter(u => u.status === 'invited');
  const disabledUsers = users.filter(u => u.status === 'disabled');

  const fmtEvent = t => (t || '').replace(/^portal_/, '').replace(/_/g, ' ').replace(/^\w/, c => c.toUpperCase());

  function userRow(u) {
    const mems = (u.memberships || []).map(m =>
      `<span class="portal-type-chip">${_escH(m.client_name)} &middot; ${_escH((GW_PORTAL_ROLES[m.role] || {}).label || m.role)}${m.all_properties ? '' : ' &middot; limited properties'}</span>`
    ).join('');
    const lastLogin = u.last_login_at ? _relTime(u.last_login_at.replace(' ', 'T') + 'Z') : 'Never';
    const actions = [];
    if (u.status !== 'disabled' && u.status !== 'active') {
      actions.push(`<button class="secondary-btn" onclick="_portalResend('${_escH(u.id)}')">Resend Invite</button>`);
    }
    if (u.status === 'disabled') {
      actions.push(`<button class="secondary-btn" onclick="_portalReactivate('${_escH(u.id)}')">Reactivate</button>`);
    } else {
      actions.push(`<button class="secondary-btn portal-revoke-btn" onclick="_portalDisable('${_escH(u.id)}','${_escH(u.email)}')">Disable</button>`);
    }
    return `
      <div class="portal-row">
        <div class="portal-row-left">
          <div class="portal-client-name">${_escH(u.name)} ${_portalStatusPill(u)}</div>
          <div class="portal-client-email">${_escH(u.email)}</div>
          <div class="portal-row-meta">Last login: ${_escH(lastLogin)}${u.phone ? ' &middot; ' + _escH(u.phone) : ''}</div>
          <div class="portal-type-chips">${mems}</div>
        </div>
        <div class="portal-row-right">${actions.join('')}</div>
      </div>`;
  }

  function auditRow(a) {
    return `
      <div class="portal-action-row">
        <span class="portal-action-label">${_escH(fmtEvent(a.event_type))}</span>
        <span class="portal-action-client">${_escH(a.actor_type || '')}</span>
        <span class="portal-action-entity">${_escH(a.entity_label || a.entity_id || '')}</span>
        <span class="portal-action-time">${_relTime((a.created_at || '').replace(' ', 'T') + 'Z')}</span>
      </div>`;
  }

  view.innerHTML = `
    <style>
      .portal-pill{display:inline-block;font-size:10.5px;font-weight:700;border-radius:20px;padding:2px 9px;margin-left:8px;vertical-align:middle}
      .portal-pill--green{background:rgba(61,169,116,.15);color:#3DA974}
      .portal-pill--blue{background:rgba(77,138,186,.15);color:#5B9BD1}
      .portal-pill--amber{background:rgba(216,158,58,.15);color:#D89E3A}
      .portal-pill--red{background:rgba(200,90,80,.15);color:#D07A72}
    </style>
    <div class="gwp-shell gwp-shell--narrow" style="padding-top:20px">
      <header class="gwp-header" style="margin-bottom:16px">
        <div class="gwp-header-left">
          <h1 class="gwp-title">Client Portal</h1>
          <span class="gwp-subtitle">Invite clients to their secure portal and control what each person can see and do.</span>
        </div>
        <div class="gwp-header-actions">
          <button class="gwp-btn-primary" onclick="_portalInviteModal()">+ Invite Portal User</button>
        </div>
      </header>

      <div class="gwp-kpi-row gwp-kpi-row--3" style="margin-bottom:16px">
        <div class="gwp-kpi-card gwp-kpi-card--green">
          <div class="gwp-kpi-icon gwp-kpi-icon--green"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><polyline points="16 11 18 13 22 9"/></svg></div>
          <div class="gwp-kpi-body">
            <div class="gwp-kpi-value">${activeUsers.length}</div>
            <div class="gwp-kpi-label">Active Users</div>
            <div class="gwp-kpi-sub">signed up and able to log in</div>
          </div>
        </div>
        <div class="gwp-kpi-card gwp-kpi-card--blue">
          <div class="gwp-kpi-icon gwp-kpi-icon--blue"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></svg></div>
          <div class="gwp-kpi-body">
            <div class="gwp-kpi-value">${invitedUsers.length}</div>
            <div class="gwp-kpi-label">Pending Invites</div>
            <div class="gwp-kpi-sub">waiting on activation</div>
          </div>
        </div>
        <div class="gwp-kpi-card ${disabledUsers.length ? 'gwp-kpi-card--red' : 'gwp-kpi-card--muted'}">
          <div class="gwp-kpi-icon ${disabledUsers.length ? 'gwp-kpi-icon--red' : 'gwp-kpi-icon--muted'}"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><line x1="17" y1="8" x2="23" y2="14"/><line x1="23" y1="8" x2="17" y2="14"/></svg></div>
          <div class="gwp-kpi-body">
            <div class="gwp-kpi-value">${disabledUsers.length}</div>
            <div class="gwp-kpi-label">Disabled</div>
            <div class="gwp-kpi-sub">access removed</div>
          </div>
        </div>
      </div>

      <div class="gwp-banner">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0"><circle cx="8" cy="8" r="6.5"/><line x1="8" y1="7" x2="8" y2="11"/><circle cx="8" cy="5" r=".5" fill="currentColor" stroke="none"/></svg>
        Portal users sign in with their own email and password at <strong style="margin:0 4px">/portal/login</strong>. Each user only sees the clients and properties you grant.
      </div>

      <div class="portal-section" style="margin-top:20px">
        <div class="gwp-sect-label">Portal Users (${users.length})</div>
        ${users.length === 0
          ? '<div class="gwp-empty" style="padding:28px 20px"><div class="gwp-empty-title">No portal users yet</div><div class="gwp-empty-sub">Invite a client contact to give them secure portal access.</div><div class="gwp-empty-actions"><button class="gwp-btn-primary" onclick="_portalInviteModal()">+ Invite Portal User</button></div></div>'
          : users.map(userRow).join('')}
      </div>

      <div class="portal-section" style="margin-top:28px">
        <div class="gwp-sect-label">Recent Portal Activity</div>
        ${audit.length === 0
          ? '<div class="gwp-empty" style="padding:28px 20px"><div class="gwp-empty-title">No activity yet</div><div class="gwp-empty-sub">Logins, invites, and access changes will appear here.</div></div>'
          : '<div class="portal-action-header"><span>Event</span><span>Actor</span><span>Detail</span><span>Date</span></div>' + audit.map(auditRow).join('')}
      </div>
    </div>`;
}

window.portalAdmin = portalAdmin;

// ── Admin actions ─────────────────────────────────────────────────────────────
window._portalResend = async function(id) {
  try {
    const d = await _portalApi('/api/admin/portal/users/' + id + '/resend', { method: 'POST' });
    showToast && showToast(d.email_sent ? 'Invitation email sent.' : 'New invite link created (email not sent — copy it from the invite dialog).', 'success');
    portalAdmin();
  } catch (e) { showToast && showToast(e.message, 'error'); }
};

window._portalDisable = async function(id, email) {
  if (!confirm('Disable portal access for ' + email + '? They will be signed out immediately.')) return;
  try {
    await _portalApi('/api/admin/portal/users/' + id + '/disable', { method: 'POST' });
    showToast && showToast('Portal access disabled.', 'success');
    portalAdmin();
  } catch (e) { showToast && showToast(e.message, 'error'); }
};

window._portalReactivate = async function(id) {
  try {
    const d = await _portalApi('/api/admin/portal/users/' + id + '/reactivate', { method: 'POST' });
    showToast && showToast(d.status === 'active' ? 'User reactivated.' : 'User set back to invited — resend the invite so they can activate.', 'success');
    portalAdmin();
  } catch (e) { showToast && showToast(e.message, 'error'); }
};

// ── Invite modal ──────────────────────────────────────────────────────────────
window._portalInviteModal = async function() {
  let clients = [];
  try {
    const d = await _portalApi('/api/clients');
    clients = (d.data || []).filter(c => c && c.name);
  } catch (_) {}

  const clientOpts = clients.map(c =>
    `<option value="${_escH(c.id)}" data-email="${_escH(c.email || '')}">${_escH(c.name)}</option>`
  ).join('');
  const roleOpts = Object.entries(GW_PORTAL_ROLES).map(([k, v], i) =>
    `<option value="${k}"${k === 'account_admin' ? ' selected' : ''}>${_escH(v.label)}</option>`
  ).join('');

  let overlay = document.getElementById('gw-portal-overlay');
  if (!overlay) { overlay = document.createElement('div'); overlay.id = 'gw-portal-overlay'; overlay.className = 'gw-modal-overlay'; document.body.appendChild(overlay); }
  overlay.innerHTML = `
    <div class="gw-modal" style="max-width:500px">
      <div class="gw-modal-header">
        <h3 class="gw-modal-title">Invite Portal User</h3>
        <button class="gw-modal-close" onclick="_portalCloseModal()">&#x2715;</button>
      </div>
      <div class="gw-modal-body">
        <div class="auto-modal-field">
          <label>Client Account</label>
          <select id="portal-m-client">${clientOpts || '<option value="">No clients found</option>'}</select>
        </div>
        <div class="auto-modal-field">
          <label>Contact Name</label>
          <input id="portal-m-name" placeholder="Jane Smith">
        </div>
        <div class="auto-modal-field">
          <label>Email (their portal login)</label>
          <input id="portal-m-email" type="email" placeholder="client@example.com">
        </div>
        <div class="auto-modal-field">
          <label>Phone (optional)</label>
          <input id="portal-m-phone" placeholder="(555) 555-5555">
        </div>
        <div class="auto-modal-field">
          <label>Role</label>
          <select id="portal-m-role">${roleOpts}</select>
          <div id="portal-m-roledesc" style="font-size:11.5px;color:var(--gw-text-muted,#9aa5a0);margin-top:5px">${_escH(GW_PORTAL_ROLES.account_admin.desc)}</div>
        </div>
        <div class="auto-modal-field">
          <label>Property Access</label>
          <label style="display:flex;align-items:center;gap:8px;font-size:13px;cursor:pointer"><input type="checkbox" id="portal-m-allprops" checked> All properties on this account</label>
          <div id="portal-m-props" style="display:none;margin-top:8px;max-height:150px;overflow:auto;border:1px solid var(--gw-line,#2e4040);border-radius:8px;padding:8px"></div>
        </div>
        <div id="portal-m-result" style="display:none;margin-top:10px;font-size:12.5px;padding:10px 12px;border-radius:8px;background:rgba(61,169,116,.1);color:#3DA974;word-break:break-all"></div>
      </div>
      <div class="gw-modal-footer">
        <button class="secondary-btn" onclick="_portalCloseModal()">Cancel</button>
        <button class="primary-btn" id="portal-m-save">Send Invitation</button>
      </div>
    </div>`;
  overlay.style.display = 'flex';
  overlay.onclick = e => { if (e.target === overlay) _portalCloseModal(); };

  const clientSel = document.getElementById('portal-m-client');
  const emailInp  = document.getElementById('portal-m-email');
  const roleSel   = document.getElementById('portal-m-role');
  const allProps  = document.getElementById('portal-m-allprops');
  const propsBox  = document.getElementById('portal-m-props');

  function prefillEmail() {
    const opt = clientSel.selectedOptions[0];
    if (opt && opt.dataset.email && !emailInp.value) emailInp.value = opt.dataset.email;
  }
  prefillEmail();
  clientSel.onchange = () => { prefillEmail(); if (!allProps.checked) loadProps(); };
  roleSel.onchange = () => { document.getElementById('portal-m-roledesc').textContent = (GW_PORTAL_ROLES[roleSel.value] || {}).desc || ''; };

  async function loadProps() {
    propsBox.innerHTML = '<div style="font-size:12px;color:var(--gw-text-muted,#9aa5a0)">Loading properties...</div>';
    try {
      const d = await _portalApi('/api/admin/portal/clients/' + clientSel.value + '/properties');
      const rows = d.data || [];
      propsBox.innerHTML = rows.length
        ? rows.map(p => {
            const addr = [p.street, p.city, p.state].filter(Boolean).join(', ');
            return `<label style="display:flex;align-items:center;gap:8px;font-size:12.5px;padding:4px 0;cursor:pointer"><input type="checkbox" class="portal-m-prop" value="${_escH(p.id)}" checked> ${_escH(p.label || addr || p.id)}${addr && p.label ? ' <span style="color:var(--gw-text-muted,#9aa5a0)">' + _escH(addr) + '</span>' : ''}</label>`;
          }).join('')
        : '<div style="font-size:12px;color:var(--gw-text-muted,#9aa5a0)">No properties on this client.</div>';
    } catch (e) { propsBox.innerHTML = '<div style="font-size:12px;color:#D07A72">' + _escH(e.message) + '</div>'; }
  }
  allProps.onchange = () => {
    propsBox.style.display = allProps.checked ? 'none' : 'block';
    if (!allProps.checked) loadProps();
  };

  document.getElementById('portal-m-save').onclick = async () => {
    const btn = document.getElementById('portal-m-save');
    const body = {
      client_id: clientSel.value,
      name: document.getElementById('portal-m-name').value.trim(),
      email: emailInp.value.trim(),
      phone: document.getElementById('portal-m-phone').value.trim(),
      role: roleSel.value,
      all_properties: allProps.checked,
    };
    if (!allProps.checked) {
      body.property_ids = [...document.querySelectorAll('.portal-m-prop:checked')].map(cb => cb.value);
    }
    if (!body.client_id || !body.name || !body.email) {
      showToast && showToast('Client, name, and email are required.', 'error');
      return;
    }
    btn.disabled = true; btn.textContent = 'Sending...';
    try {
      const d = await _portalApi('/api/admin/portal/users', { method: 'POST', body });
      const res = document.getElementById('portal-m-result');
      if (d.email_sent) {
        showToast && showToast('Invitation sent to ' + body.email + '.', 'success');
        _portalCloseModal();
        portalAdmin();
      } else if (d.invite_link) {
        res.style.display = 'block';
        res.innerHTML = 'Invite created but email delivery is not configured. Share this link directly:<br><strong>' + _escH(d.invite_link) + '</strong>';
        btn.textContent = 'Done';
        btn.disabled = false;
        btn.onclick = () => { _portalCloseModal(); portalAdmin(); };
      } else {
        showToast && showToast('Access updated for existing user.', 'success');
        _portalCloseModal();
        portalAdmin();
      }
    } catch (e) {
      showToast && showToast(e.message, 'error');
      btn.disabled = false; btn.textContent = 'Send Invitation';
    }
  };
};

window._portalCloseModal = function() {
  const o = document.getElementById('gw-portal-overlay');
  if (o) o.style.display = 'none';
};

// ══════════════════════════════════════════════════════════════════════════════
// PORTAL SHELL (rendered when URL contains /portal or ?gwportal=1)
// Checks token, shows limited external-facing view.
// Called automatically on page load if the URL matches.
// ══════════════════════════════════════════════════════════════════════════════
function _gwCheckPortalRoute() {
  const params = new URLSearchParams(window.location.search);
  const token = params.get('token');
  const isPortal = window.location.pathname.startsWith('/portal') || params.get('gwportal');
  if (!isPortal && !token) return;

  // Hide internal app shell
  const app = document.getElementById('app') || document.querySelector('.layout');
  if (app) app.style.display = 'none';

  // Render portal shell into body
  const shell = document.createElement('div');
  shell.id = 'gw-portal-shell';
  document.body.appendChild(shell);

  const access = token ? gwPortal.getByToken(token) : null;

  if (!access) {
    shell.innerHTML = `
      <div class="portal-shell">
        <header class="portal-header">
          <div class="portal-brand">Groundwork</div>
        </header>
        <div class="portal-body">
          <div class="portal-error-state">
            <div class="portal-error-icon">
              <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><circle cx="12" cy="16" r=".5" fill="currentColor"/></svg>
            </div>
            <h2>Link Not Found</h2>
            <p>This portal link is invalid or has expired. Please contact your service provider for a new link.</p>
          </div>
        </div>
      </div>`;
    return;
  }

  // Valid access — render portal content
  const visibleTypes = access.visibleTypes || ['estimate', 'invoice', 'job_status'];

  shell.innerHTML = `
    <div class="portal-shell">
      <header class="portal-header">
        <div class="portal-brand">Groundwork</div>
        <div class="portal-client-badge">${_escH(access.clientName)}</div>
      </header>
      <div class="portal-body">
        <div class="portal-welcome">
          <h1 class="portal-welcome-title">Your Project Portal</h1>
          <p class="portal-welcome-sub">View your estimates, invoices, and job updates below.</p>
        </div>
        <nav class="portal-nav" id="portal-nav">
          ${visibleTypes.includes('estimate') ? `<button class="portal-nav-btn portal-nav-btn--active" onclick="_portalShowSection('estimates',this)">Estimates</button>` : ''}
          ${visibleTypes.includes('invoice')  ? `<button class="portal-nav-btn" onclick="_portalShowSection('invoices',this)">Invoices</button>` : ''}
          ${visibleTypes.includes('deposit')  ? `<button class="portal-nav-btn" onclick="_portalShowSection('deposits',this)">Deposits</button>` : ''}
          ${visibleTypes.includes('job_status') ? `<button class="portal-nav-btn" onclick="_portalShowSection('status',this)">Job Status</button>` : ''}
        </nav>
        <div class="portal-content" id="portal-content">
          ${_renderPortalEstimates(access)}
        </div>
      </div>
      <footer class="portal-footer">
        Powered by Groundwork CRM &middot; Secure client portal
      </footer>
    </div>`;
}

function _renderPortalEstimates(access) {
  // In a real deployment these would come from D1 filtered by client.
  // For foundation, render a clear empty/placeholder state with the approve UI pattern.
  return `
    <div class="portal-section-content">
      <h2 class="portal-section-heading">Estimates &amp; Proposals</h2>
      <div class="portal-record-empty">
        <p>Your estimates will appear here once your service provider shares them with you.</p>
        <p class="portal-record-empty-sub">You'll be able to review, approve, or decline each proposal directly from this page.</p>
      </div>
    </div>`;
}

window._portalShowSection = function(section, btn) {
  document.querySelectorAll('.portal-nav-btn').forEach(b => b.classList.remove('portal-nav-btn--active'));
  btn.classList.add('portal-nav-btn--active');
  const content = document.getElementById('portal-content');
  if (!content) return;
  const labels = { estimates:'Estimates & Proposals', invoices:'Invoices', deposits:'Deposit Requests', status:'Job Status' };
  content.innerHTML = `
    <div class="portal-section-content">
      <h2 class="portal-section-heading">${labels[section]||section}</h2>
      <div class="portal-record-empty">
        <p>No ${labels[section]||section} available yet.</p>
        <p class="portal-record-empty-sub">Your service provider will share items here as your project progresses.</p>
      </div>
    </div>`;
};

// Auto-init portal route on load
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', _gwCheckPortalRoute);
} else {
  _gwCheckPortalRoute();
}

console.info('[GW Client Portal] Phase 8 portal foundation initialized.');
