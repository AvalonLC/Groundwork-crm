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
// INTERNAL: Portal Admin View
// Accessible at show('portalAdmin') — manage access per client
// ══════════════════════════════════════════════════════════════════════════════
function portalAdmin() {
  const view = document.getElementById('view');
  if (!view) return;

  const canManage = window.gwCan ? gwCan('can_manage_portal_access') : false;
  const allAccess = gwPortal.list();
  const active    = allAccess.filter(r => r.active);
  const inactive  = allAccess.filter(r => !r.active);
  const actions   = _portalActionsLoad().slice(0, 20);

  const typeBadge = t => `<span class="portal-type-chip">${(window.GW_PORTAL_RECORD_TYPES && GW_PORTAL_RECORD_TYPES[t]?.label) || t}</span>`;

  function accessRow(r) {
    const link = gwPortal.portalLink(r.clientId);
    return `
      <div class="portal-row">
        <div class="portal-row-left">
          <div class="portal-client-name">${_escH(r.clientName)}</div>
          <div class="portal-client-email">${_escH(r.clientEmail)}</div>
          <div class="portal-row-meta">
            Granted by ${_escH(r.grantedBy)} &middot; ${_relTime(r.grantedAt)}
          </div>
          <div class="portal-type-chips">${(r.visibleTypes||[]).map(typeBadge).join('')}</div>
        </div>
        <div class="portal-row-right">
          ${r.active ? `
            <button class="secondary-btn portal-link-btn" onclick="_portalCopyLink('${r.token}')">Copy Link</button>
            <button class="secondary-btn" onclick="_portalRegenToken('${r.clientId}')">Regenerate Token</button>
            ${canManage ? `<button class="secondary-btn portal-revoke-btn" onclick="_portalRevoke('${r.clientId}')">Revoke Access</button>` : ''}
          ` : `<span class="portal-revoked-label">Access Revoked</span>`}
        </div>
      </div>`;
  }

  function actionRow(a) {
    return `
      <div class="portal-action-row">
        <span class="portal-action-label">${_escH(a.action)}</span>
        <span class="portal-action-client">${_escH(a.clientName||a.clientId||'')}</span>
        <span class="portal-action-entity">${_escH(a.entityLabel||a.entityId||'')}</span>
        <span class="portal-action-time">${_relTime(a.ts)}</span>
      </div>`;
  }

  view.innerHTML = `
    <div class="view-wrap">
      <div class="page-header">
        <div>
          <h1 class="page-title">Client Portal Access</h1>
          <p class="page-sub">Control which clients have portal access and what they can see.</p>
        </div>
        ${canManage ? `<button class="primary-btn" onclick="_portalGrantModal()">+ Grant Portal Access</button>` : ''}
      </div>

      <div class="portal-info-banner">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="6.5"/><line x1="8" y1="7" x2="8" y2="11"/><circle cx="8" cy="5" r=".5" fill="currentColor" stroke="none"/></svg>
        Clients access the portal via a secure link. They can view estimates, invoices, and job status. No internal CRM data is exposed.
      </div>

      <div class="portal-section">
        <h2 class="portal-section-title">Active Access (${active.length})</h2>
        ${active.length === 0 ? '<div class="portal-empty">No clients currently have portal access.</div>' : active.map(accessRow).join('')}
      </div>

      ${inactive.length > 0 ? `
      <div class="portal-section" style="margin-top:24px">
        <h2 class="portal-section-title">Revoked Access (${inactive.length})</h2>
        ${inactive.map(accessRow).join('')}
      </div>` : ''}

      <div class="portal-section" style="margin-top:28px">
        <h2 class="portal-section-title">Recent Portal Activity</h2>
        ${actions.length === 0
          ? '<div class="portal-empty">No portal actions recorded yet.</div>'
          : `<div class="portal-action-header"><span>Action</span><span>Client</span><span>Record</span><span>Date</span></div>` + actions.map(actionRow).join('')}
      </div>
    </div>`;
}

window.portalAdmin = portalAdmin;

// ── Internal helpers wired to HTML ────────────────────────────────────────────
window._portalCopyLink = function(token) {
  const url = window.location.origin + '/portal?token=' + token;
  if (navigator.clipboard) {
    navigator.clipboard.writeText(url).then(() => { showToast && showToast('Portal link copied to clipboard.', 'success'); });
  } else {
    showToast && showToast(url, 'info');
  }
};

window._portalRevoke = function(clientId) {
  if (!confirm('Revoke portal access for this client? Their link will stop working immediately.')) return;
  gwPortal.revoke(clientId);
  showToast && showToast('Portal access revoked.', 'success');
  portalAdmin();
};

window._portalRegenToken = function(clientId) {
  if (!confirm('Regenerate token? The old portal link will stop working.')) return;
  const token = gwPortal.regenerateToken(clientId);
  if (token) { showToast && showToast('Token regenerated. Share the new link with your client.', 'success'); portalAdmin(); }
};

window._portalGrantModal = function() {
  // Build client list from state
  const state = window._avalonState || {};
  const clients = (state.clients || []).filter(c => c && c.name);
  const types = window.GW_PORTAL_RECORD_TYPES || {};
  const clientOpts = clients.length
    ? clients.map(c => `<option value="${_escH(c.id)}" data-name="${_escH(c.name)}" data-email="${_escH(c.email||'')}">${_escH(c.name)}</option>`).join('')
    : '<option value="">— No clients found —</option>';
  const typeCheckboxes = Object.entries(types).map(([k,v]) =>
    `<label class="portal-modal-type-row"><input type="checkbox" value="${k}" checked> ${_escH(v.label)}</label>`
  ).join('');

  let overlay = document.getElementById('gw-portal-overlay');
  if (!overlay) { overlay = document.createElement('div'); overlay.id = 'gw-portal-overlay'; overlay.className = 'gw-modal-overlay'; document.body.appendChild(overlay); }
  overlay.innerHTML = `
    <div class="gw-modal" style="max-width:480px">
      <div class="gw-modal-header">
        <h3 class="gw-modal-title">Grant Portal Access</h3>
        <button class="gw-modal-close" onclick="_portalCloseModal()">&#x2715;</button>
      </div>
      <div class="gw-modal-body">
        <div class="auto-modal-field">
          <label>Client</label>
          ${clients.length
            ? `<select id="portal-m-client">${clientOpts}</select>`
            : `<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
                <input id="portal-m-cid"   placeholder="Client ID" style="padding:8px;border:1px solid var(--gw-line);border-radius:6px;font-size:13px">
                <input id="portal-m-cname" placeholder="Client Name" style="padding:8px;border:1px solid var(--gw-line);border-radius:6px;font-size:13px">
               </div>`}
        </div>
        <div class="auto-modal-field">
          <label>Client Email (for link delivery)</label>
          <input id="portal-m-email" type="email" placeholder="client@example.com">
        </div>
        <div class="auto-modal-field">
          <label>Visible Record Types</label>
          <div class="auto-modal-actions-list">${typeCheckboxes}</div>
        </div>
      </div>
      <div class="gw-modal-footer">
        <button class="secondary-btn" onclick="_portalCloseModal()">Cancel</button>
        <button class="primary-btn" id="portal-m-save">Grant Access</button>
      </div>
    </div>`;
  overlay.style.display = 'flex';
  overlay.onclick = e => { if (e.target === overlay) _portalCloseModal(); };

  document.getElementById('portal-m-save').onclick = () => {
    let clientId, clientName, clientEmail;
    if (clients.length) {
      const sel = document.getElementById('portal-m-client');
      const opt = sel?.selectedOptions[0];
      clientId   = sel?.value;
      clientName = opt?.dataset.name || clientId;
      clientEmail = opt?.dataset.email || document.getElementById('portal-m-email')?.value?.trim() || '';
    } else {
      clientId   = document.getElementById('portal-m-cid')?.value?.trim();
      clientName = document.getElementById('portal-m-cname')?.value?.trim();
      clientEmail= document.getElementById('portal-m-email')?.value?.trim() || '';
    }
    if (!clientId) { showToast && showToast('Please select or enter a client.', 'error'); return; }
    const visibleTypes = [...document.querySelectorAll('.portal-modal-type-row input:checked')].map(cb => cb.value);
    const record = gwPortal.grant({ clientId, clientName, clientEmail, visibleTypes });
    if (record) {
      _portalCloseModal();
      showToast && showToast('Portal access granted. Copy the link to share.', 'success');
      portalAdmin();
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
