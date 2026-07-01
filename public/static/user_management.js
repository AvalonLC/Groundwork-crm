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
const _UM_ROLE_DEFS_DEFAULT = [
  {
    id: 'admin',
    label: 'Owner / Admin',
    color: '#4D8A86',
    description: 'Full access to all sections including financial data, user management, and settings.',
    defaultViews: ['today','myDashboard','pipeline','lead','clients','process','forms','scripts','templates','objections','calculator','academy','manager','revenueAdmin','integrations','settings','userManagement']
  },
  {
    id: 'office_manager',
    label: 'Office Manager',
    color: '#8B6914',
    description: 'Operations and admin access. Sees ALL leads across all reps. Can manage most settings.',
    defaultViews: ['today','myDashboard','pipeline','lead','clients','process','forms','scripts','templates','objections','calculator','academy','manager','integrations','settings','ai','timeTracker']
  },
  {
    id: 'rep',
    label: 'Sales Rep',
    color: '#2D7A55',
    description: 'Standard rep access. Today, pipeline (own leads), clients, and full sales toolkit.',
    defaultViews: ['today','myDashboard','pipeline','lead','clients','process','forms','scripts','templates','objections','calculator','academy','settings','ai','timeTracker']
  },
  {
    id: 'estimator',
    label: 'Estimator',
    color: '#4D8A86',
    description: 'Access to pipeline, pricing tools, forms, and process docs.',
    defaultViews: ['today','pipeline','clients','process','forms','calculator','settings']
  },
  {
    id: 'view_only',
    label: 'View Only',
    color: '#6F7E6A',
    description: 'Read-only access to Today and Pipeline.',
    defaultViews: ['today','pipeline','settings']
  }
];

/**
 * Returns the active role definitions for the current company.
 * Priority: D1-sourced window._gwRoles → built-in defaults.
 * This function is the single source of truth for role definitions.
 */
function getRoleDefs() {
  if (window._gwRoles && window._gwRoles.length > 0) {
    // Map D1 role format to UM format (add defaultViews from permissions.views)
    return window._gwRoles.map(r => ({
      id:           r.id,
      label:        r.label,
      color:        r.color || '#6F7E6A',
      description:  r.description || '',
      defaultViews: (r.permissions && Array.isArray(r.permissions.views))
                      ? r.permissions.views
                      : (_UM_ROLE_DEFS_DEFAULT.find(d => d.id === r.id)?.defaultViews || []),
      // Pass through D1-specific permission flags
      can_see_all_leads:   r.permissions?.can_see_all_leads || false,
      can_manage_users:    r.permissions?.can_manage_users  || false,
      can_view_financials: r.permissions?.can_view_financials || false,
      is_system:           r.is_system || false
    }));
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
  'Field Supervisor',
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
    r.role === 'admin' ? 'Owner' :
    r.role === 'office_manager' ? 'Office Manager' :
    r.role === 'estimator' ? 'Estimator' :
    r.role === 'view_only' ? 'View Only' : 'Sales Rep';

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

// ── All-views list (for permission matrix) ────────────────────────────────────
const UM_ALL_VIEWS = [
  { key:'today',         label:'Today',              group:'Home' },
  { key:'myDashboard',   label:'My Dashboard',        group:'Home' },
  { key:'pipeline',      label:'Pipeline',            group:'Pipeline' },
  { key:'lead',          label:'Add Lead',            group:'Pipeline' },
  { key:'clients',       label:'Clients & Properties',group:'Pipeline' },
  { key:'process',       label:'Sales Process',       group:'Sales Toolkit' },
  { key:'forms',         label:'Forms & Checklists',  group:'Sales Toolkit' },
  { key:'scripts',       label:'Scripts',             group:'Sales Toolkit' },
  { key:'templates',     label:'Email Templates',     group:'Sales Toolkit' },
  { key:'objections',    label:'Objection Handling',  group:'Sales Toolkit' },
  { key:'calculator',    label:'Pricing Tools',       group:'Sales Toolkit' },
  { key:'academy',       label:'Sales Academy',       group:'Learning' },
  { key:'manager',       label:'Manager Tools',       group:'Admin' },
  { key:'revenueAdmin',  label:'Financial Data Hub',  group:'Admin' },
  { key:'integrations',  label:'Integrations',        group:'Admin' },
  { key:'settings',      label:'Settings',            group:'Admin' },
  { key:'userManagement',label:'User Management',     group:'Admin' }
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
        <p style="color:#6F7E6A;max-width:420px;margin:0 auto 24px">User Management is restricted to Tyler (Owner / Admin). Ask Tyler if you need access changes.</p>
        <button class="secondary-btn" onclick="show('today')">← Back to Today</button>
      </div>`;
    return;
  }

  const activeTab = tab || 'users';
  const tabs = [
    { id:'users',  label:'Team Members' },
    { id:'roles',  label:'Roles & Permissions' },
    { id:'audit',  label:'Login Audit' }
  ];

  viewEl.innerHTML = `
<div class="eyebrow">Admin</div>
<h1>User &amp; Access Management</h1>
<p class="lede" style="margin-bottom:20px">Manage team accounts, roles, and permissions. Changes take effect immediately. Google Workspace connections are configured in <button onclick="show('integrations')" style="background:none;border:none;padding:0;color:var(--gds-teal,#4D8A86);font-weight:600;font-size:inherit;cursor:pointer;text-decoration:underline">Integrations</button>.</p>

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

  if (activeTab === 'users')  umRenderUsers(tc);
  else if (activeTab === 'roles') umRenderRoles(tc);
  else if (activeTab === 'audit') umRenderAudit(tc);
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
    <button onclick="document.getElementById('um-user-modal').remove()" style="background:none;border:none;color:#6F7E6A;cursor:pointer;font-size:20px;padding:0 4px">✕</button>
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

      // Persist to D1 so email+password auth works server-side
      const apiPayload = {
        name,
        email,
        role,
        color,
        active: status === 'active' ? 1 : 0,
        ...(password ? { password } : {})
      };
      const apiCall = existingId
        ? window.API?.reps?.update?.(existingId, apiPayload) || fetch(`/api/reps/${existingId}`, { method:'PUT', headers:{'Content-Type':'application/json'}, credentials:'include', body:JSON.stringify(apiPayload) })
        : window.API?.reps?.create?.({ ...apiPayload, id: userId }) || fetch('/api/reps', { method:'POST', headers:{'Content-Type':'application/json'}, credentials:'include', body:JSON.stringify({ ...apiPayload, id: userId }) });
      apiCall.then(r => (r.ok ? null : r.json().then(d => umToast(`Server sync: ${d?.error || 'error'}`)))).catch(() => {});

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
    <button onclick="document.getElementById('um-invite-modal').remove()" style="background:none;border:none;color:#6F7E6A;cursor:pointer;font-size:20px;padding:0 4px">✕</button>
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
      <div style="font-size:12px;color:#4D8A86;font-weight:600;margin-bottom:4px">📧 How it works</div>
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
        body: JSON.stringify({ email, name, inviteRole: role, title: pos, color, message })
      });
      const data = await res.json();
      if (res.ok && data.invited) {
        document.getElementById('um-invite-modal')?.remove();
        umToast(data.emailSent
          ? `Invite sent to ${email}! They'll get an email with a setup link.`
          : `Invite created for ${email}. (Email delivery requires SendGrid setup.)`);
        umAddAuditEntry({ type:'invite_sent', userName:name, by:window.getCurrentRep?.()?.name||'Admin' });
        userManagement('users');
      } else {
        errEl.textContent = data.error || 'Failed to send invite. Please try again.';
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
        body: JSON.stringify({ repId: userId })
      });
      const data = await res.json();
      if (res.ok && data.resent) {
        umToast(data.emailSent
          ? `Invite resent to ${data.email}`
          : `Invite refreshed for ${userName}. (Email delivery requires SendGrid setup.)`);
        userManagement('users');
      } else {
        umToast(data.error || 'Failed to resend invite');
      }
    } catch(e) { umToast('Network error'); }
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
      ${u.mustResetPin && !isPendingInvite ? `<span style="font-size:10px;font-weight:700;color:#8B6914;background:#8B691418;border:1px solid rgba(139,105,20,.25);border-radius:20px;padding:2px 8px">⚠ Pw Reset</span>` : ''}
    </div>
    <div style="display:flex;gap:8px;margin-left:auto;flex-wrap:wrap">
      ${isPendingInvite
        ? `<button class="secondary-btn" style="font-size:12px;padding:6px 12px;color:#8B6914;border-color:#8B691440" onclick="window._umResendInvite('${u.id}','${umEscape(u.name)}')">Resend Invite</button>`
        : `<button class="secondary-btn" style="font-size:12px;padding:6px 12px" onclick="window._umResetPin('${u.id}')">Reset Password</button>`}
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
// TAB 2 — ROLES & PERMISSIONS
// ═══════════════════════════════════════════════════════════════════════════════
function umRenderRoles(container) {
  // We re-use the existing nav permissions system and extend it with userManagement
  const loadNavPerms = window.loadNavPerms || (() => {
    try { return JSON.parse(localStorage.getItem('avalonNavPermissions') || '{}'); } catch(e) { return {}; }
  });
  const saveNavPerms = window.saveNavPerms || ((p) => {
    localStorage.setItem('avalonNavPermissions', JSON.stringify(p));
  });

  const DEFAULT_NAV_PERMS = window.DEFAULT_NAV_PERMS || {
    admin: UM_ALL_VIEWS.map(v=>v.key),
    office_manager: ['today','myDashboard','pipeline','lead','clients','process','forms','scripts','templates','objections','calculator','academy','manager','integrations','settings'],
    rep: ['today','myDashboard','pipeline','lead','clients','process','forms','scripts','templates','objections','calculator','academy','settings'],
    estimator: ['today','pipeline','clients','process','forms','calculator','settings'],
    view_only: ['today','pipeline','settings']
  };

  const perms = loadNavPerms();
  const groups = [...new Set(UM_ALL_VIEWS.map(v => v.group))];

  const nonAdminRoles = UM_ROLE_DEFS.filter(r => r.id !== 'admin');

  container.innerHTML = `
<div style="margin-bottom:20px">
  <h3 style="margin:0 0 4px;font-size:16px">Role Permission Matrix</h3>
  <p style="color:#6F7E6A;font-size:13px;margin:0">Control which sections each role can access. Tyler (Owner/Admin) always has full access.</p>
</div>

<!-- Role Cards -->
<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:14px;margin-bottom:28px">
  ${UM_ROLE_DEFS.map(r => `
  <div class="gw-um-role-card" style="border:1px solid ${r.color}40">
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:8px">
      <span style="width:10px;height:10px;border-radius:50%;background:${r.color};flex-shrink:0"></span>
      <div style="font-weight:700;font-size:14px;color:${r.color}">${r.label}</div>
    </div>
    <div style="font-size:12px;color:#6F7E6A;line-height:1.5;margin-bottom:12px">${r.description}</div>
    ${r.id !== 'admin' ? `
    <div style="display:flex;gap:6px;flex-wrap:wrap">
      <button class="secondary-btn" style="font-size:11px;padding:4px 9px" onclick="window._umPreset('${r.id}','full')">Full</button>
      <button class="secondary-btn" style="font-size:11px;padding:4px 9px" onclick="window._umPreset('${r.id}','standard')">Standard</button>
      <button class="secondary-btn" style="font-size:11px;padding:4px 9px" onclick="window._umPreset('${r.id}','view')">View Only</button>
      <button class="secondary-btn" style="font-size:11px;padding:4px 9px" onclick="window._umPreset('${r.id}','default')">↺ Reset</button>
    </div>` : `<div style="font-size:11px;font-weight:700;color:#6F7E6A;text-transform:uppercase;letter-spacing:.05em">Always Full Access</div>`}
  </div>`).join('')}
</div>

<!-- Permission Matrix Table -->
<div class="gw-um-perm-table">
  <table style="width:100%;border-collapse:collapse;min-width:600px">
    <thead>
      <tr style="background:var(--gw-surface);border-bottom:2px solid var(--gw-line)">
        <th style="text-align:left;padding:12px 16px;font-size:12px;color:#6F7E6A;font-weight:600;width:180px">Section</th>
        ${nonAdminRoles.map(r => `
        <th style="text-align:center;padding:12px 10px;font-size:12px;font-weight:700;color:${r.color}">
          ${r.label}
        </th>`).join('')}
      </tr>
    </thead>
    <tbody>
      ${groups.map(group => {
        const gViews = UM_ALL_VIEWS.filter(v => v.group === group);
        return `
        <tr style="background:var(--gw-surface)">
          <td colspan="${nonAdminRoles.length+1}" style="padding:8px 16px;font-size:10px;font-weight:800;color:#5C6B58;text-transform:uppercase;letter-spacing:.08em">${group}</td>
        </tr>
        ${gViews.map(v => `
        <tr style="border-bottom:1px solid var(--gw-line)">
          <td style="padding:10px 16px;font-size:13px;color:#D6D1C4">${v.label}</td>
          ${nonAdminRoles.map(r => {
            const rolePerms = perms[r.id] || DEFAULT_NAV_PERMS[r.id] || [];
            const checked = rolePerms.includes(v.key);
            const isLocked = v.key === 'settings'; // settings always visible
            return `<td style="text-align:center;padding:8px">
              <input type="checkbox" ${checked?'checked':''} ${isLocked?'disabled title="Always visible"':''}
                onchange="window._umTogglePerm('${r.id}','${v.key}',this.checked)"
                style="width:16px;height:16px;accent-color:${r.color};cursor:${isLocked?'not-allowed':'pointer'}">
            </td>`;
          }).join('')}
        </tr>`).join('')}`;
      }).join('')}
    </tbody>
  </table>
</div>

<div style="margin-top:12px;font-size:11px;color:#5C6B58">Changes take effect immediately. Settings is always visible for all roles.</div>

<!-- ── Action Permissions ─────────────────────────────────────────────── -->
<div style="margin-top:28px">
  <div style="margin-bottom:14px">
    <h4 style="margin:0 0 3px;font-size:14px;font-weight:800;color:var(--gds-ink,#1F2A2B)">Action Permissions</h4>
    <p style="margin:0;font-size:12px;color:var(--gw-muted,#5E6E6F)">Control what destructive or elevated actions each role can perform beyond their nav access.</p>
  </div>
  <div style="background:var(--gw-surface-2,#FAFAF8);border:1px solid var(--gw-line,#E0DDD5);border-radius:12px;overflow:hidden">
    <!-- Header row -->
    <div style="display:grid;grid-template-columns:1fr ${nonAdminRoles.map(()=>'80px').join(' ')};gap:0;padding:10px 16px;border-bottom:1px solid var(--gw-line,#E0DDD5);background:var(--gw-surface,#FFFFFF)">
      <div style="font-size:11px;font-weight:700;color:var(--gw-muted,#5E6E6F);text-transform:uppercase;letter-spacing:.06em">Permission</div>
      ${nonAdminRoles.map(r => `<div style="font-size:11px;font-weight:700;color:${r.color};text-align:center;text-transform:uppercase;letter-spacing:.05em">${r.label.split(' ')[0]}</div>`).join('')}
    </div>
    <!-- can_delete_leads row -->
    <div style="display:grid;grid-template-columns:1fr ${nonAdminRoles.map(()=>'80px').join(' ')};gap:0;padding:12px 16px;align-items:center">
      <div>
        <div style="font-size:13px;font-weight:600;color:var(--gds-ink,#1F2A2B);margin-bottom:2px">Delete Leads</div>
        <div style="font-size:11px;color:var(--gw-muted,#5E6E6F)">Allow this role to permanently delete any lead from the pipeline</div>
      </div>
      ${nonAdminRoles.map(r => {
        // Read current value from D1-sourced role defs
        const roleD1 = window._gwRoles ? window._gwRoles.find(d => d.id === r.id) : null;
        const isOn = !!(roleD1 && roleD1.permissions && roleD1.permissions.can_delete_leads);
        return `<div style="text-align:center">
          <label style="position:relative;display:inline-flex;align-items:center;cursor:pointer" title="${r.label}">
            <input type="checkbox" ${isOn ? 'checked' : ''} id="acp-del-${r.id}"
              onchange="window._umToggleActionPerm('${r.id}','can_delete_leads',this.checked)"
              style="position:absolute;opacity:0;width:0;height:0">
            <span style="
              display:inline-block;width:36px;height:20px;border-radius:10px;
              background:${isOn ? r.color : '#CBD0C8'};
              transition:background .2s;position:relative;flex-shrink:0"
              id="acp-del-track-${r.id}">
              <span style="
                position:absolute;top:2px;left:${isOn ? '18px' : '2px'};
                width:16px;height:16px;border-radius:50%;background:#fff;
                box-shadow:0 1px 3px rgba(0,0,0,.25);transition:left .2s"
                id="acp-del-thumb-${r.id}"></span>
            </span>
          </label>
        </div>`;
      }).join('')}
    </div>
  </div>
  <div style="margin-top:8px;font-size:11px;color:var(--gw-muted,#5E6E6F)">
    <strong>Owner / Admin</strong> can always delete leads regardless of this setting.
  </div>
</div>
`;

  window._umToggleActionPerm = async function(roleId, permKey, enabled) {
    // Update in-memory _gwRoles immediately for instant UI feedback
    if (window._gwRoles) {
      const rd = window._gwRoles.find(r => r.id === roleId);
      if (rd) {
        if (!rd.permissions || typeof rd.permissions !== 'object') rd.permissions = {};
        rd.permissions[permKey] = enabled;
      }
    }
    // Animate toggle
    const track = document.getElementById(`acp-del-track-${roleId}`);
    const thumb = document.getElementById(`acp-del-thumb-${roleId}`);
    const roleDef = (window._gwRoles || []).find(r => r.id === roleId);
    if (track) track.style.background = enabled ? (roleDef?.color || '#4D8A86') : '#CBD0C8';
    if (thumb) thumb.style.left = enabled ? '18px' : '2px';

    // Persist to D1 via PUT /api/roles/:id
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
      umToast(`${permKey === 'can_delete_leads' ? 'Delete Leads' : permKey} ${enabled ? 'enabled' : 'disabled'} for ${roleDef?.label || roleId}`);
    } catch(e) {
      umToast('Failed to save: ' + e.message, 'error');
      // Revert in-memory on failure
      if (window._gwRoles) {
        const rd = window._gwRoles.find(r => r.id === roleId);
        if (rd && rd.permissions) rd.permissions[permKey] = !enabled;
      }
      if (track) track.style.background = !enabled ? (roleDef?.color || '#4D8A86') : '#CBD0C8';
      if (thumb) thumb.style.left = !enabled ? '18px' : '2px';
    }
  };

  window._umTogglePerm = function(roleId, viewKey, enabled) {
    const perms = loadNavPerms();
    if (!perms[roleId]) perms[roleId] = [...(DEFAULT_NAV_PERMS[roleId] || [])];
    if (enabled) {
      if (!perms[roleId].includes(viewKey)) perms[roleId].push(viewKey);
    } else {
      perms[roleId] = perms[roleId].filter(v => v !== viewKey);
    }
    saveNavPerms(perms);
    umToast('Permission updated');
  };

  window._umPreset = function(roleId, preset) {
    const ALL  = UM_ALL_VIEWS.map(v=>v.key);
    const STANDARD = ['today','myDashboard','pipeline','lead','clients','process','forms','scripts','templates','objections','calculator','academy','settings'];
    const VIEW = ['today','pipeline','settings'];
    const DEFAULT = DEFAULT_NAV_PERMS[roleId] || STANDARD;
    const views = preset==='full' ? ALL : preset==='standard' ? STANDARD : preset==='view' ? VIEW : DEFAULT;
    const perms = loadNavPerms();
    perms[roleId] = [...views];
    saveNavPerms(perms);
    const role = umRoleDef(roleId);
    umToast(`${role.label} → ${preset==='full'?'Full Access':preset==='standard'?'Standard':preset==='view'?'View Only':'Defaults'}`);
    umRenderRoles(container);
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
              ⚠ Google Client ID not configured. Ask your Admin to set it up in <strong>Integrations</strong>.
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
    <div id="um-sig-saved-badge" style="display:none;font-size:10px;font-weight:700;color:#2D7A55;background:#2D7A5515;border:1px solid #2D7A5540;border-radius:20px;padding:2px 9px">✓ Saved</div>
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
      ${connected ? '✓ ' : ''}Gmail Sync
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
      ? `<div style="font-size:11px;color:#2D7A55;margin-bottom:8px">✓ Gmail signature fetched${cachedGmailSig ? '' : ' (empty — no signature set in Gmail)'}</div>`
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

    if (status) status.textContent = sig ? '✓ Fetched!' : 'No signature found in Gmail.';

    // Re-render to show the preview
    const container = document.getElementById('um-sig-fetch-btn')?.closest('section')?.parentElement;
    if (container) umRenderSignatureEditor(container);

    if (sig) umToast('Gmail signature fetched ✓', 'ok');
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
      umToast('Signature saved ✓', 'ok');
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
      const sigMsg = gmailSig ? ' (signature synced ✓)' : '';
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
