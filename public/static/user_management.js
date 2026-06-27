/**
 * Groundwork CRM — User & Access Management Module
 *
 * Provides:
 *  - Admin → Users: create/edit/deactivate users, assign roles, reset PINs
 *  - Admin → Roles & Permissions: role templates + per-view access matrix
 *  - Admin → Users & Workspace: per-user Google OAuth status + Client ID config
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

// ── Role definitions (built-in) ────────────────────────────────────────────────
const UM_ROLE_DEFS = [
  {
    id: 'admin',
    label: 'Owner / Admin',
    color: '#00d4ff',
    description: 'Full access to all sections including financial data, user management, and settings.',
    defaultViews: ['today','myDashboard','pipeline','lead','clients','process','forms','scripts','templates','objections','calculator','academy','manager','revenueAdmin','integrations','settings','userManagement']
  },
  {
    id: 'office_manager',
    label: 'Office Manager',
    color: '#f59e0b',
    description: 'Operations and admin access. Can see pipeline, clients, and most admin tools.',
    defaultViews: ['today','myDashboard','pipeline','lead','clients','process','forms','scripts','templates','objections','calculator','academy','manager','integrations','settings']
  },
  {
    id: 'rep',
    label: 'Sales Rep',
    color: '#4ade80',
    description: 'Standard rep access. Today, pipeline, clients, and sales toolkit.',
    defaultViews: ['today','myDashboard','pipeline','lead','clients','process','forms','scripts','templates','objections','calculator','academy','settings']
  },
  {
    id: 'estimator',
    label: 'Estimator',
    color: '#a78bfa',
    description: 'Access to pipeline, pricing tools, forms, and process docs.',
    defaultViews: ['today','pipeline','clients','process','forms','calculator','settings']
  },
  {
    id: 'view_only',
    label: 'View Only',
    color: '#94a3b8',
    description: 'Read-only access to Today and Pipeline.',
    defaultViews: ['today','pipeline','settings']
  }
];

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
  try {
    const stored = JSON.parse(localStorage.getItem(UM_USERS_KEY) || '[]');
    if (stored.length) return stored;
  } catch(e) {}
  // Bootstrap from REPS array on first run
  return umBootstrapUsersFromReps();
}

function umBootstrapUsersFromReps() {
  const reps = window.REPS || [];
  const users = reps.map(r => ({
    id: r.id,
    name: r.name,
    displayName: r.name,
    email: r.email || '',
    phone: '',
    position: r.role === 'admin' ? 'Owner' : r.role === 'office_manager' ? 'Office Manager' : 'Sales Rep',
    role: r.role,
    color: r.color,
    status: 'active',
    pin: r.pin || '',
    mustResetPin: false,
    failedLoginCount: 0,
    lastLoginAt: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    notes: ''
  }));
  localStorage.setItem(UM_USERS_KEY, JSON.stringify(users));
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
      rep.pin   = u.pin;
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
        pin: u.pin,
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
  return UM_ROLE_DEFS.find(r => r.id === roleId) || { label: roleId, color: '#64748b', defaultViews: [] };
}

function umColorTile(name, color, size = 36) {
  const letter = (name || '?')[0].toUpperCase();
  return `<span style="display:inline-flex;align-items:center;justify-content:center;width:${size}px;height:${size}px;border-radius:${Math.round(size*0.28)}px;background:${color}22;border:2px solid ${color}66;color:${color};font-weight:800;font-size:${Math.round(size*0.44)}px;flex-shrink:0;letter-spacing:0">${umEscape(letter)}</span>`;
}

function umStatusPill(status) {
  if (status === 'active')   return `<span style="font-size:10px;font-weight:700;color:#4ade80;background:#4ade8018;border:1px solid #4ade8040;border-radius:20px;padding:2px 8px">Active</span>`;
  if (status === 'inactive') return `<span style="font-size:10px;font-weight:700;color:#f87171;background:#f8717118;border:1px solid #f8717140;border-radius:20px;padding:2px 8px">Inactive</span>`;
  return `<span style="font-size:10px;font-weight:700;color:#94a3b8;background:#94a3b818;border:1px solid #94a3b840;border-radius:20px;padding:2px 8px">${umEscape(status)}</span>`;
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
        <div style="font-size:40px;margin-bottom:16px">🔒</div>
        <h2 style="color:#f87171;margin-bottom:10px">Access Restricted</h2>
        <p style="color:#64748b;max-width:420px;margin:0 auto 24px">User Management is restricted to Tyler (Owner / Admin). Ask Tyler if you need access changes.</p>
        <button class="secondary-btn" onclick="show('today')">← Back to Today</button>
      </div>`;
    return;
  }

  const activeTab = tab || 'users';
  const tabs = [
    { id:'users',  label:'👤 Users & Workspace' },
    { id:'roles',  label:'🎭 Roles & Permissions' },
    { id:'audit',  label:'🔍 Login Audit' }
  ];

  viewEl.innerHTML = `
<div class="eyebrow">Admin</div>
<h1>User &amp; Access Management</h1>
<p class="lede" style="margin-bottom:20px">Manage team accounts, roles, permissions, and Google Workspace connections. Changes take effect immediately.</p>

<div class="gw-um-tab-nav">
  ${tabs.map(t => `
  <button onclick="window._umTab('${t.id}')"
    style="padding:8px 16px;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer;transition:all .15s;
    ${activeTab===t.id ? 'background:#00A7E1;color:#fff;border:1.5px solid #00A7E1' : 'background:var(--gw-surface-2);color:var(--gw-muted);border:1.5px solid var(--gw-line)'}"
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

  // ── Shared Client ID config (Google OAuth app credentials) ──────────────
  let globalIntState = {};
  try { globalIntState = JSON.parse(localStorage.getItem('avalonIntegrationsV1') || '{}'); } catch(e) {}
  const sharedClientId = globalIntState.googleClientId || '';

  // ── My Google Connection (for whoever is logged in right now) ─────────────
  const myGc       = currentRep ? googleMap[currentRep.id] : null;
  const myConnected = myGc && myGc.token && Date.now() < (myGc.expiry || 0);
  const myEmail     = myGc?.email || '';

  container.innerHTML = `

<!-- ── My Google Connection ──────────────────────────────────────────────── -->
<div class="gw-um-form-card" style="border-radius:14px;padding:20px;margin-bottom:24px">
  <div style="display:flex;align-items:center;gap:10px;margin-bottom:14px">
    <img src="https://www.google.com/favicon.ico" style="width:20px;height:20px" alt="Google">
    <div style="font-weight:700;font-size:15px;color:#e2e8f0">My Google Workspace</div>
    ${myConnected
      ? `<span style="margin-left:auto;font-size:11px;font-weight:700;color:#4ade80;background:#4ade8015;border:1px solid #4ade8040;border-radius:20px;padding:2px 10px">● Connected</span>`
      : `<span style="margin-left:auto;font-size:11px;font-weight:700;color:#f87171;background:#f8717115;border:1px solid #f8717140;border-radius:20px;padding:2px 10px">○ Not Connected</span>`}
  </div>
  ${myConnected
    ? `<div style="font-size:13px;color:#4ade80;margin-bottom:10px">Signed in as <strong>${umEscape(myEmail)}</strong></div>
       <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px">
         ${[{icon:'✉️',l:'Gmail'},{icon:'📅',l:'Calendar'},{icon:'📁',l:'Drive'}].map(s=>`
         <span style="font-size:12px;background:#4ade8015;border:1px solid #4ade8040;border-radius:6px;padding:3px 10px;color:#4ade80">${s.icon} ${s.l}</span>`).join('')}
       </div>
       <div style="display:flex;gap:8px;flex-wrap:wrap">
         <button class="secondary-btn" style="font-size:12px" onclick="show('integrations')">Open Workspace Hub →</button>
         <button class="danger-btn" style="font-size:12px" onclick="window._umMyDisconnect&&window._umMyDisconnect();userManagement('users')">Disconnect</button>
       </div>`
    : `<p style="color:#64748b;font-size:13px;margin:0 0 12px">Connect your personal Google account to access Gmail, Calendar, and Drive inside the hub.</p>
       ${!sharedClientId
         ? `<div style="font-size:12px;color:#f59e0b;background:#f59e0b15;border:1px solid #f59e0b40;border-radius:8px;padding:10px">
              ⚠ Google Client ID not configured yet. Set it below under <strong>Google OAuth Setup</strong>.
            </div>`
         : `<button class="primary-btn" style="font-size:13px" onclick="window._umMyConnect&&window._umMyConnect().then(()=>userManagement('users'))">Connect My Google Account</button>`
       }`
  }
</div>

<!-- ── Google OAuth Setup (Client ID) ────────────────────────────────────── -->
<div class="gw-info-strip" style="border-radius:12px;padding:16px 18px;margin-bottom:24px">
  <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:12px">
    <div>
      <div style="font-size:13px;font-weight:700;color:#e2e8f0;margin-bottom:2px">🔑 Google OAuth Client ID</div>
      <div style="font-size:11px;color:#475569">Shared across all users. Set once — everyone can then connect their own account.</div>
    </div>
    <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;flex:1;min-width:260px;justify-content:flex-end">
      <input id="um-ws-client-id" type="text"
        value="${umEscape(sharedClientId)}"
        placeholder="1234…apps.googleusercontent.com"
        style="flex:1;min-width:220px;padding:8px 12px;background:var(--gw-surface-3);border:1px solid var(--gw-line);border-radius:8px;color:var(--gw-ink);font-size:12px;box-sizing:border-box">
      <button class="primary-btn" style="font-size:12px;padding:8px 14px;flex-shrink:0" onclick="window._umSaveClientId()">Save</button>
    </div>
  </div>
</div>

<!-- ── Team Users ─────────────────────────────────────────────────────────── -->
<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;flex-wrap:wrap;gap:10px">
  <div style="font-size:13px;font-weight:700;color:#e2e8f0">
    Team Members
    <span style="font-size:12px;color:#64748b;font-weight:400;margin-left:8px">${users.filter(u=>u.status==='active').length} active · ${users.filter(u=>u.status==='inactive').length} inactive</span>
  </div>
  <button class="primary-btn" onclick="window._umOpenUserForm(null)">+ Add User</button>
</div>

<div style="display:flex;flex-direction:column;gap:10px" id="um-user-list">
  ${users.length ? users.map(u => umUserRow(u, googleMap[u.id])).join('') : `<div style="text-align:center;padding:40px;color:#64748b">No users yet. Add your first team member.</div>`}
</div>
`;

  // ── Save Client ID ────────────────────────────────────────────────────────
  window._umSaveClientId = function() {
    const val = document.getElementById('um-ws-client-id')?.value?.trim();
    if (!val) { umToast('Paste a valid Google Client ID first'); return; }
    let st = {};
    try { st = JSON.parse(localStorage.getItem('avalonIntegrationsV1') || '{}'); } catch(e) {}
    st.googleClientId = val;
    localStorage.setItem('avalonIntegrationsV1', JSON.stringify(st));
    umToast('Google Client ID saved ✅');
    umRenderUsers(container);
  };

  // Form logic
  window._umOpenUserForm = function(userId) {
    const users = umLoadUsers();
    const u = userId ? users.find(u => u.id === userId) : null;
    const isEdit = !!u;
    const colors = ['#00d4ff','#4ade80','#f59e0b','#a78bfa','#f472b6','#fb923c','#38bdf8','#34d399'];

    const modal = document.createElement('div');
    modal.id = 'um-user-modal';
    modal.style.cssText = 'position:fixed;inset:0;background:#000000cc;z-index:9999;display:flex;align-items:center;justify-content:center;padding:20px';
    modal.innerHTML = `
<div class="gw-modal-card" style="width:min(520px,100%);max-height:90vh;overflow-y:auto">
  <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:20px">
    <h2 style="margin:0;font-size:18px">${isEdit ? 'Edit User' : 'Add New User'}</h2>
    <button onclick="document.getElementById('um-user-modal').remove()" style="background:none;border:none;color:#64748b;cursor:pointer;font-size:20px;padding:0 4px">✕</button>
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
        <label class="um-label">Login PIN (4 digits) *</label>
        <input id="um-f-pin" class="um-input" type="text" maxlength="4" pattern="[0-9]{4}"
          value="${umEscape(u?.pin||'')}" placeholder="1234" inputmode="numeric"
          oninput="this.value=this.value.replace(/[^0-9]/g,'').slice(0,4)">
        <div style="font-size:11px;color:#475569;margin-top:4px">Used for quick login. Keep it private.</div>
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
      <label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-size:13px;color:#94a3b8">
        <input type="checkbox" id="um-f-reset-pin" ${u?.mustResetPin?'checked':''} style="accent-color:#00A7E1">
        Require PIN reset on next login
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
      const pin     = document.getElementById('um-f-pin')?.value?.trim() || '';
      const status  = document.getElementById('um-f-status')?.value || 'active';
      const color   = document.getElementById('um-f-color')?.value || '#4ade80';
      const notes   = document.getElementById('um-f-notes')?.value?.trim() || '';
      const mustReset = document.getElementById('um-f-reset-pin')?.checked || false;

      if (!name) { umToast('Full name is required'); return; }
      if (!pin || pin.length !== 4) { umToast('PIN must be exactly 4 digits'); return; }

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
        pin,
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
      document.getElementById('um-user-modal')?.remove();
      umToast(`${u.name} ${newStatus === 'active' ? 'reactivated' : 'deactivated'}`);
      userManagement('users');
    };
  };

  window._umResetPin = function(userId) {
    const users = umLoadUsers();
    const u = users.find(u => u.id === userId);
    if (!u) return;
    const newPin = prompt(`Reset PIN for ${u.name}. Enter new 4-digit PIN:`, '');
    if (!newPin) return;
    if (!/^\d{4}$/.test(newPin)) { umToast('PIN must be exactly 4 digits (numbers only)'); return; }
    u.pin = newPin;
    u.mustResetPin = false;
    u.failedLoginCount = 0;
    u.updatedAt = new Date().toISOString();
    umSaveUsers(users);
    umAddAuditEntry({ type: 'pin_reset', userId, userName: u.name, by: window.getCurrentRep?.()?.name || 'Admin' });
    umToast(`PIN reset for ${u.name}`);
    userManagement('users');
  };
}

function umUserRow(u, gc) {
  // gc can be passed in from caller or loaded here as fallback
  if (gc === undefined) { const m = umLoadUserGoogle(); gc = m[u.id]; }
  const role = umRoleDef(u.role);
  const googleConnected = gc && gc.token && Date.now() < (gc.expiry || 0);
  const googleEmail     = gc?.email || '';

  return `
<div class="gw-um-user-row">
  <!-- Main row -->
  <div style="display:flex;align-items:center;gap:14px;padding:14px 18px;flex-wrap:wrap;gap:12px">
    ${umColorTile(u.displayName || u.name, u.color, 42)}
    <div style="flex:1;min-width:160px">
      <div style="font-weight:700;font-size:15px;color:#e2e8f0">${umEscape(u.displayName||u.name)}</div>
      <div style="font-size:12px;color:#64748b;margin-top:1px">${umEscape(u.position)}${u.email ? ' · '+umEscape(u.email) : ''}</div>
    </div>
    <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
      <span style="font-size:11px;font-weight:700;color:${role.color};background:${role.color}18;border:1px solid ${role.color}40;border-radius:20px;padding:2px 10px">${role.label}</span>
      ${umStatusPill(u.status)}
      ${u.mustResetPin ? `<span style="font-size:10px;font-weight:700;color:#f59e0b;background:#f59e0b18;border:1px solid #f59e0b40;border-radius:20px;padding:2px 8px">⚠ PIN Reset</span>` : ''}
    </div>
    <div style="display:flex;gap:8px;margin-left:auto">
      <button class="secondary-btn" style="font-size:12px;padding:6px 12px" onclick="window._umResetPin('${u.id}')">Reset PIN</button>
      <button class="secondary-btn" style="font-size:12px;padding:6px 12px" onclick="window._umOpenUserForm('${u.id}')">Edit</button>
    </div>
  </div>
  <!-- Google status strip -->
  <div style="display:flex;align-items:center;gap:10px;padding:8px 18px;background:${googleConnected?'#4ade8008':'var(--gw-surface)'};border-top:1px solid var(--gw-line);flex-wrap:wrap">
    <img src="https://www.google.com/favicon.ico" style="width:13px;height:13px;opacity:.7" alt="G">
    ${googleConnected
      ? `<span style="font-size:11px;color:#4ade80;font-weight:600">● Google connected as ${umEscape(googleEmail)}</span>
         <div style="display:flex;gap:6px;margin-left:auto">
           ${[['✉️','Gmail'],['📅','Cal'],['📁','Drive']].map(([ic,lb])=>`<span style="font-size:10px;color:#4ade80;background:#4ade8015;border:1px solid #4ade8030;border-radius:4px;padding:1px 6px">${ic} ${lb}</span>`).join('')}
           <button onclick="window._umAdminDisconnectUser('${u.id}')" style="font-size:10px;font-weight:700;color:#f87171;background:#f8717115;border:1px solid #f8717140;border-radius:6px;padding:2px 8px;cursor:pointer;margin-left:4px">Disconnect</button>
         </div>`
      : `<span style="font-size:11px;color:#475569">○ Google not connected</span>
         <span style="font-size:11px;color:var(--gw-muted);margin-left:auto">User connects via Integrations → Google Workspace</span>`
    }
  </div>
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
  <p style="color:#64748b;font-size:13px;margin:0">Control which sections each role can access. Tyler (Owner/Admin) always has full access.</p>
</div>

<!-- Role Cards -->
<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:14px;margin-bottom:28px">
  ${UM_ROLE_DEFS.map(r => `
  <div class="gw-um-role-card" style="border:1px solid ${r.color}40">
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:8px">
      <span style="width:10px;height:10px;border-radius:50%;background:${r.color};flex-shrink:0"></span>
      <div style="font-weight:700;font-size:14px;color:${r.color}">${r.label}</div>
    </div>
    <div style="font-size:12px;color:#64748b;line-height:1.5;margin-bottom:12px">${r.description}</div>
    ${r.id !== 'admin' ? `
    <div style="display:flex;gap:6px;flex-wrap:wrap">
      <button class="secondary-btn" style="font-size:11px;padding:4px 9px" onclick="window._umPreset('${r.id}','full')">Full</button>
      <button class="secondary-btn" style="font-size:11px;padding:4px 9px" onclick="window._umPreset('${r.id}','standard')">Standard</button>
      <button class="secondary-btn" style="font-size:11px;padding:4px 9px" onclick="window._umPreset('${r.id}','view')">View Only</button>
      <button class="secondary-btn" style="font-size:11px;padding:4px 9px" onclick="window._umPreset('${r.id}','default')">↺ Reset</button>
    </div>` : `<div style="font-size:11px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:.05em">Always Full Access</div>`}
  </div>`).join('')}
</div>

<!-- Permission Matrix Table -->
<div class="gw-um-perm-table">
  <table style="width:100%;border-collapse:collapse;min-width:600px">
    <thead>
      <tr style="background:var(--gw-surface);border-bottom:2px solid var(--gw-line)">
        <th style="text-align:left;padding:12px 16px;font-size:12px;color:#64748b;font-weight:600;width:180px">Section</th>
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
          <td colspan="${nonAdminRoles.length+1}" style="padding:8px 16px;font-size:10px;font-weight:800;color:#475569;text-transform:uppercase;letter-spacing:.08em">${group}</td>
        </tr>
        ${gViews.map(v => `
        <tr style="border-bottom:1px solid var(--gw-line)">
          <td style="padding:10px 16px;font-size:13px;color:#cbd5e1">${v.label}</td>
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

<div style="margin-top:12px;font-size:11px;color:#475569">Changes take effect immediately. Settings is always visible for all roles.</div>
`;

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
  <p style="color:#64748b;font-size:13px;margin:0">Each team member connects their own Google account. Connections are isolated — no shared tokens.</p>
</div>

<!-- Client ID config -->
<div class="gw-um-form-card" style="border-radius:12px;padding:18px;margin-bottom:20px">
  <div style="font-weight:700;font-size:14px;color:#e2e8f0;margin-bottom:8px">🔑 Shared Google OAuth Client ID</div>
  <p style="color:#64748b;font-size:12px;margin:0 0 12px">The same Google Cloud Client ID is used across all user connections. Set it once here and every user can connect their own account.</p>
  <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end">
    <div style="flex:1;min-width:260px">
      <label style="font-size:11px;font-weight:600;color:#64748b;text-transform:uppercase;letter-spacing:.05em">Google Client ID</label>
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
  <div style="font-size:12px;font-weight:700;color:#475569;text-transform:uppercase;letter-spacing:.06em;margin-bottom:8px">How Per-User Connections Work</div>
  <div style="font-size:12px;color:#64748b;line-height:1.8">
    Each user connects their own Google account from <strong style="color:#94a3b8">Settings → My Google Connection</strong>.
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
    { label:'Gmail',    icon:'✉️', key:'gmail',    connected: connected && gc?.gmail },
    { label:'Calendar', icon:'📅', key:'calendar', connected: connected && gc?.calendar },
    { label:'Drive',    icon:'📁', key:'drive',    connected: connected && gc?.drive }
  ];

  return `
<div class="gw-um-user-row" style="display:flex;align-items:center;gap:14px;padding:14px 18px;flex-wrap:wrap;gap:12px">
  ${umColorTile(u.displayName||u.name, u.color, 40)}
  <div style="min-width:140px">
    <div style="font-weight:700;font-size:14px;color:#e2e8f0">${umEscape(u.displayName||u.name)}</div>
    <div style="font-size:11px;color:#64748b">${umEscape(u.position)}</div>
  </div>
  <div style="flex:1;min-width:200px">
    ${connected
      ? `<div style="font-size:12px;color:#4ade80;font-weight:600;margin-bottom:6px">● Connected as ${umEscape(email)}</div>`
      : `<div style="font-size:12px;color:#f87171;font-weight:600;margin-bottom:6px">○ Not connected</div>`
    }
    <div style="display:flex;gap:8px;flex-wrap:wrap">
      ${services.map(s => `
      <span style="font-size:11px;color:${s.connected?'#4ade80':'var(--gw-muted)'};background:${s.connected?'#4ade8015':'var(--gw-surface-3)'};border:1px solid ${s.connected?'#4ade8040':'var(--gw-line)'};border-radius:6px;padding:2px 8px">
        ${s.icon} ${s.label}
      </span>`).join('')}
    </div>
    ${connectedAt ? `<div style="font-size:10px;color:#475569;margin-top:4px">Connected ${connectedAt}</div>` : ''}
  </div>
  <div style="display:flex;gap:8px;margin-left:auto">
    ${connected
      ? `<button class="danger-btn" style="font-size:12px;padding:6px 12px" onclick="window._umAdminDisconnectUser('${u.id}')">Disconnect</button>`
      : `<span style="font-size:11px;color:#475569;padding:6px 12px">User connects via their Settings</span>`
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
    login:                    { icon:'🟢', label:'Login' },
    logout:                   { icon:'⚪', label:'Logout' },
    login_failed:             { icon:'🔴', label:'Failed Login' },
    user_created:             { icon:'➕', label:'User Created' },
    user_updated:             { icon:'✏️', label:'User Updated' },
    user_deactivated:         { icon:'🚫', label:'User Deactivated' },
    user_reactivated:         { icon:'♻️', label:'User Reactivated' },
    pin_reset:                { icon:'🔑', label:'PIN Reset' },
    google_disconnected_by_admin: { icon:'🔌', label:'Google Disconnected (Admin)' },
    google_connected:         { icon:'🔗', label:'Google Connected' }
  };

  container.innerHTML = `
<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;flex-wrap:wrap;gap:10px">
  <div>
    <h3 style="margin:0 0 2px;font-size:16px">Login & Security Audit Log</h3>
    <p style="color:#64748b;font-size:12px;margin:0">${log.length} entries · Last 200 events stored locally</p>
  </div>
  ${log.length ? `<button class="secondary-btn" style="font-size:12px" onclick="window._umClearAudit()">Clear Log</button>` : ''}
</div>

${log.length === 0
  ? `<div style="text-align:center;padding:48px;color:#475569">
      <div style="font-size:32px;margin-bottom:12px">📋</div>
      <div>No audit events recorded yet.</div>
      <div style="font-size:12px;margin-top:6px">Events are logged as users log in and admin makes changes.</div>
    </div>`
  : `<div style="display:flex;flex-direction:column;gap:6px">
      ${log.map(entry => {
        const def = iconMap[entry.type] || { icon:'📌', label: entry.type || 'Event' };
        return `
        <div class="gw-um-user-row" style="display:flex;align-items:flex-start;gap:12px;padding:10px 14px;border-radius:8px">
          <span style="font-size:16px;flex-shrink:0;margin-top:1px">${def.icon}</span>
          <div style="flex:1;min-width:0">
            <div style="font-size:13px;color:#e2e8f0;font-weight:600">${def.label}
              ${entry.userName ? `<span style="color:#94a3b8;font-weight:400"> · ${umEscape(entry.userName)}</span>` : ''}
              ${entry.by && entry.by !== entry.userName ? `<span style="font-size:11px;color:#475569"> by ${umEscape(entry.by)}</span>` : ''}
            </div>
            <div style="font-size:11px;color:#475569;margin-top:2px">${umFormatDate(entry.timestamp)}</div>
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
      ? `<span style="font-size:11px;font-weight:700;color:#4ade80;background:#4ade8018;border:1px solid #4ade8040;border-radius:20px;padding:2px 9px;margin-left:auto">● Connected</span>`
      : `<span style="font-size:11px;font-weight:700;color:#f87171;background:#f8717118;border:1px solid #f8717140;border-radius:20px;padding:2px 9px;margin-left:auto">○ Not Connected</span>`
    }
  </div>

  ${connected
    ? `<div style="font-size:13px;color:#4ade80;margin-bottom:12px">Connected as <strong>${umEscape(email)}</strong></div>
       <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px">
         ${[{icon:'✉️',l:'Gmail'},{icon:'📅',l:'Calendar'},{icon:'📁',l:'Drive'}].map(s=>`
         <span style="font-size:12px;background:#4ade8015;border:1px solid #4ade8040;border-radius:6px;padding:3px 10px;color:#4ade80">${s.icon} ${s.l}</span>`).join('')}
       </div>
       <button class="danger-btn" onclick="window._umMyDisconnect()">Disconnect My Google Account</button>`
    : `<p style="color:#64748b;font-size:13px;margin:0 0 14px">Connect your personal Google account to use Gmail, Calendar, and Drive directly from the Sales Hub.</p>
       ${!clientId
         ? `<div style="font-size:13px;color:#f59e0b;background:#f59e0b15;border:1px solid #f59e0b40;border-radius:8px;padding:12px">
              ⚠ Google Client ID not configured. Ask Tyler (Admin) to set it up in <strong>Admin → User Management → Users &amp; Workspace tab</strong>.
            </div>`
         : `<button class="primary-btn" onclick="window._umMyConnect()">Connect My Google Account</button>`
       }`
  }
</section>`;

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
    umToast('Google Client ID not configured. Ask Tyler (Admin) to set it up in User Management → Users & Workspace tab.', 'warn');
    return;
  }

  const scopes = [
    'https://www.googleapis.com/auth/gmail.compose',
    'https://www.googleapis.com/auth/gmail.readonly',
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
      popup.close();

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
      map[rep.id] = {
        token: accessToken,
        expiry: Date.now() + expiresIn * 1000,
        email: googleEmail,
        gmail: true,
        calendar: true,
        drive: true,
        connectedAt: new Date().toISOString()
      };
      umSaveUserGoogle(map);
      umAddAuditEntry({ type: 'google_connected', userId: rep.id, userName: rep.name, by: rep.name });
      umToast(`✅ Google connected as ${googleEmail}`);

      // Refresh whatever view is currently visible
      if (typeof window.integrations === 'function') window.integrations();
      else if (typeof window.show === 'function') window.show('settings');
    } catch(e) {}
  }, 800);
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
      color: #64748b;
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
      color: #e2e8f0;
      font-size: 13px;
      box-sizing: border-box;
      transition: border-color .15s;
      font-family: inherit;
    }
    .um-input:focus {
      outline: none;
      border-color: #00A7E1;
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
