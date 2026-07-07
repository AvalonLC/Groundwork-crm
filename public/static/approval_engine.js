/**
 * Groundwork CRM — Phase 8 Approval Engine
 *
 * Reusable approval system attached to multiple record types.
 * Statuses: pending | approved | rejected | cancelled | resubmitted
 *
 * Storage: localStorage gwApprovals (with D1 sync hook)
 * Public API:
 *   gwApproval.request(opts)      — create approval request
 *   gwApproval.approve(id, opts)  — approve
 *   gwApproval.reject(id, opts)   — reject
 *   gwApproval.cancel(id, opts)   — cancel
 *   gwApproval.resubmit(id, opts) — resubmit rejected
 *   gwApproval.get(id)            — fetch single
 *   gwApproval.list(filter)       — list with optional filter
 *   gwApproval.pendingCount()     — count of open requests
 *   approvalQueue()               — render the Approval Queue view
 *   gwApproval.renderPanel(container, entityType, entityId) — inline panel
 */

'use strict';

const GW_APPROVALS_KEY = 'gwApprovals';

// ── Helpers ───────────────────────────────────────────────────────────────────
function _loadApprovals() {
  try { return JSON.parse(localStorage.getItem(GW_APPROVALS_KEY) || '[]'); } catch(_) { return []; }
}
function _saveApprovals(arr) {
  try { localStorage.setItem(GW_APPROVALS_KEY, JSON.stringify(arr)); } catch(_) {}
}
function _apUid() { return 'apr_' + Date.now() + '_' + Math.random().toString(16).slice(2,6); }
function _apNow() { return new Date().toISOString(); }
function _apActor() {
  const r = window._d1SessionRep || (window.getCurrentRep ? window.getCurrentRep() : null);
  return r ? { id:r.id, name:r.name, role:r.role } : { id:'system', name:'System', role:'system' };
}
function _apLabel(status) {
  return { pending:'Pending', approved:'Approved', rejected:'Rejected', cancelled:'Cancelled', resubmitted:'Resubmitted' }[status] || status;
}
function _apStatusCss(status) {
  return { pending:'ap-status--pending', approved:'ap-status--approved', rejected:'ap-status--rejected', cancelled:'ap-status--cancelled', resubmitted:'ap-status--pending' }[status] || '';
}

// ── Core API ──────────────────────────────────────────────────────────────────
const gwApproval = {

  request(opts) {
    // opts: { type, entityType, entityId, entityLabel, requestedBy?, notes?, approverRole? }
    const actor = _apActor();
    const apr = {
      id:            _apUid(),
      type:          opts.type          || 'estimate',
      entityType:    opts.entityType    || null,
      entityId:      opts.entityId      || null,
      entityLabel:   opts.entityLabel   || opts.entityId || '',
      status:        'pending',
      requestedById: opts.requestedBy?.id   || actor.id,
      requestedByName: opts.requestedBy?.name || actor.name,
      requestedAt:   _apNow(),
      approverId:    null,
      approverName:  null,
      decidedAt:     null,
      approverRole:  opts.approverRole || 'admin',
      notes:         opts.notes || null,
      comment:       null,
      history:       [{ status:'pending', by:actor.name, at:_apNow(), note:opts.notes||null }],
    };
    const all = _loadApprovals();
    all.unshift(apr);
    _saveApprovals(all);
    if (window.gwAudit) gwAudit({ type:'approval_requested', entityType:apr.entityType, entityId:apr.entityId, entityLabel:apr.entityLabel, summary:`${GW_APPROVAL_TYPES[apr.type]?.label||apr.type} approval requested` });
    if (window.gwEmit)  gwEmit('approval_requested', apr);
    this._badgeUpdate();
    return apr;
  },

  approve(id, opts={}) {
    const all = _loadApprovals();
    const apr = all.find(a => a.id === id);
    if (!apr) return null;
    if (!window.gwCan || !gwCan('can_approve_requests')) {
      showToast && showToast('You do not have permission to approve requests.', 'error');
      return null;
    }
    const actor = _apActor();
    apr.status      = 'approved';
    apr.approverId  = actor.id;
    apr.approverName= actor.name;
    apr.decidedAt   = _apNow();
    apr.comment     = opts.comment || null;
    apr.history.push({ status:'approved', by:actor.name, at:_apNow(), note:opts.comment||null });
    _saveApprovals(all);
    if (window.gwAudit) gwAudit({ type:'approval_approved', entityType:apr.entityType, entityId:apr.entityId, entityLabel:apr.entityLabel });
    if (window.gwEmit)  gwEmit('approval_decided', { ...apr, decision:'approved' });
    this._badgeUpdate();
    return apr;
  },

  reject(id, opts={}) {
    const all = _loadApprovals();
    const apr = all.find(a => a.id === id);
    if (!apr) return null;
    if (!window.gwCan || !gwCan('can_approve_requests')) {
      showToast && showToast('You do not have permission to reject requests.', 'error');
      return null;
    }
    const actor = _apActor();
    apr.status      = 'rejected';
    apr.approverId  = actor.id;
    apr.approverName= actor.name;
    apr.decidedAt   = _apNow();
    apr.comment     = opts.comment || null;
    apr.history.push({ status:'rejected', by:actor.name, at:_apNow(), note:opts.comment||null });
    _saveApprovals(all);
    if (window.gwAudit) gwAudit({ type:'approval_rejected', entityType:apr.entityType, entityId:apr.entityId, entityLabel:apr.entityLabel, summary:opts.comment||'Rejected' });
    if (window.gwEmit)  gwEmit('approval_decided', { ...apr, decision:'rejected' });
    this._badgeUpdate();
    return apr;
  },

  cancel(id, opts={}) {
    const all = _loadApprovals();
    const apr = all.find(a => a.id === id);
    if (!apr || apr.status !== 'pending') return null;
    const actor = _apActor();
    apr.status    = 'cancelled';
    apr.decidedAt = _apNow();
    apr.history.push({ status:'cancelled', by:actor.name, at:_apNow(), note:opts.comment||null });
    _saveApprovals(all);
    if (window.gwAudit) gwAudit({ type:'approval_cancelled', entityType:apr.entityType, entityId:apr.entityId });
    this._badgeUpdate();
    return apr;
  },

  resubmit(id, opts={}) {
    const all = _loadApprovals();
    const apr = all.find(a => a.id === id);
    if (!apr || apr.status !== 'rejected') return null;
    const actor = _apActor();
    apr.status      = 'pending';
    apr.approverId  = null;
    apr.approverName= null;
    apr.decidedAt   = null;
    apr.comment     = null;
    apr.history.push({ status:'resubmitted', by:actor.name, at:_apNow(), note:opts.comment||null });
    _saveApprovals(all);
    if (window.gwAudit) gwAudit({ type:'approval_resubmitted', entityType:apr.entityType, entityId:apr.entityId });
    if (window.gwEmit)  gwEmit('approval_resubmitted', apr);
    this._badgeUpdate();
    return apr;
  },

  get(id) { return _loadApprovals().find(a => a.id === id) || null; },

  list(filter={}) {
    return _loadApprovals().filter(a => {
      if (filter.status     && a.status     !== filter.status)     return false;
      if (filter.entityType && a.entityType !== filter.entityType) return false;
      if (filter.entityId   && a.entityId   !== filter.entityId)   return false;
      if (filter.type       && a.type       !== filter.type)       return false;
      return true;
    });
  },

  pendingCount() { return _loadApprovals().filter(a => a.status === 'pending').length; },

  _badgeUpdate() {
    const count = this.pendingCount();
    // Update sidebar badge if nav button exists
    document.querySelectorAll('[data-view="approvalQueue"]').forEach(el => {
      let badge = el.querySelector('.nav-badge');
      if (count > 0) {
        if (!badge) { badge = document.createElement('span'); badge.className = 'nav-badge'; el.appendChild(badge); }
        badge.textContent = count > 99 ? '99+' : count;
      } else {
        badge?.remove();
      }
    });
  },

  // ── Inline entity panel ──────────────────────────────────────────────────
  renderPanel(container, entityType, entityId, entityLabel) {
    if (!container) return;
    const canApprove = window.gwCan ? gwCan('can_approve_requests') : false;
    const pending = this.list({ entityId, status:'pending' });
    const history = this.list({ entityId }).filter(a => a.status !== 'pending');

    let html = '<div class="ap-panel">';

    if (pending.length === 0 && history.length === 0) {
      html += `<div class="ap-panel-empty">No approval requests for this record.</div>`;
      if (canApprove || true) {
        html += `<button class="ap-request-btn" onclick="gwApproval._requestModal('${entityType}','${entityId}','${escapeHtml(entityLabel||entityId)}')">Request Approval</button>`;
      }
    } else {
      pending.forEach(a => {
        html += `
          <div class="ap-item ap-item--pending">
            <div class="ap-item-header">
              <span class="ap-status ap-status--pending">Pending</span>
              <span class="ap-type">${GW_APPROVAL_TYPES[a.type]?.label||a.type}</span>
              <span class="ap-meta">Requested by ${escapeHtml(a.requestedByName)} &middot; ${_apRelTime(a.requestedAt)}</span>
            </div>
            ${a.notes ? `<div class="ap-notes">${escapeHtml(a.notes)}</div>` : ''}
            ${canApprove ? `
            <div class="ap-actions">
              <button class="ap-btn-approve" onclick="gwApproval._decideModal('${a.id}','approve')">Approve</button>
              <button class="ap-btn-reject"  onclick="gwApproval._decideModal('${a.id}','reject')">Reject</button>
            </div>` : ''}
          </div>`;
      });
      history.slice(0,5).forEach(a => {
        html += `
          <div class="ap-item ap-item--${a.status}">
            <div class="ap-item-header">
              <span class="ap-status ${_apStatusCss(a.status)}">${_apLabel(a.status)}</span>
              <span class="ap-type">${GW_APPROVAL_TYPES[a.type]?.label||a.type}</span>
              <span class="ap-meta">${a.status!=='pending'?(a.approverName||'System')+' &middot; ':''} ${_apRelTime(a.decidedAt||a.requestedAt)}</span>
            </div>
            ${a.comment ? `<div class="ap-notes">${escapeHtml(a.comment)}</div>` : ''}
          </div>`;
      });
      html += `<button class="ap-request-btn" onclick="gwApproval._requestModal('${entityType}','${entityId}','${escapeHtml(entityLabel||entityId)}')">+ Request Approval</button>`;
    }
    html += '</div>';
    container.innerHTML = html;
  },

  _requestModal(entityType, entityId, entityLabel) {
    const types = window.GW_APPROVAL_TYPES || {};
    const opts = Object.entries(types).map(([k,v]) => `<option value="${k}">${v.label}</option>`).join('');
    _apShowModal({
      title: 'Request Approval',
      body: `
        <div class="ap-modal-field">
          <label>Approval Type</label>
          <select id="ap-type-sel">${opts}</select>
        </div>
        <div class="ap-modal-field">
          <label>Notes (optional)</label>
          <textarea id="ap-notes-ta" rows="3" placeholder="Context or reason for this request…"></textarea>
        </div>`,
      primaryLabel: 'Submit Request',
      onPrimary: () => {
        const type  = document.getElementById('ap-type-sel')?.value || 'estimate';
        const notes = document.getElementById('ap-notes-ta')?.value || null;
        gwApproval.request({ type, entityType, entityId, entityLabel, notes });
        _apCloseModal();
        showToast && showToast('Approval request submitted.', 'success');
        // Re-render if the panel is still visible
        const panel = document.querySelector('.ap-panel');
        if (panel) gwApproval.renderPanel(panel.parentElement, entityType, entityId, entityLabel);
      }
    });
  },

  _decideModal(approvalId, decision) {
    _apShowModal({
      title: decision === 'approve' ? 'Approve Request' : 'Reject Request',
      body: `
        <div class="ap-modal-field">
          <label>Comment (optional)</label>
          <textarea id="ap-comment-ta" rows="3" placeholder="${decision==='approve'?'Optional approval note…':'Reason for rejection…'}"></textarea>
        </div>`,
      primaryLabel: decision === 'approve' ? 'Confirm Approval' : 'Confirm Rejection',
      primaryCls: decision === 'approve' ? 'ap-btn-approve' : 'ap-btn-reject',
      onPrimary: () => {
        const comment = document.getElementById('ap-comment-ta')?.value || null;
        if (decision === 'approve') gwApproval.approve(approvalId, { comment });
        else                        gwApproval.reject(approvalId, { comment });
        _apCloseModal();
        showToast && showToast(`Request ${decision === 'approve' ? 'approved' : 'rejected'}.`, decision === 'approve' ? 'success' : 'info');
        // Re-render queue if visible
        if (window._currentView === 'approvalQueue') approvalQueue();
      }
    });
  }
};

window.gwApproval = gwApproval;

// ── Modal helpers ─────────────────────────────────────────────────────────────
function _apShowModal({ title, body, primaryLabel, primaryCls='ap-btn-approve', onPrimary }) {
  let overlay = document.getElementById('gw-ap-overlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'gw-ap-overlay';
    overlay.className = 'gw-modal-overlay';
    document.body.appendChild(overlay);
  }
  overlay.innerHTML = `
    <div class="gw-modal" style="max-width:460px">
      <div class="gw-modal-header">
        <h3 class="gw-modal-title">${title}</h3>
        <button class="gw-modal-close" onclick="_apCloseModal()">&#x2715;</button>
      </div>
      <div class="gw-modal-body">${body}</div>
      <div class="gw-modal-footer">
        <button class="secondary-btn" onclick="_apCloseModal()">Cancel</button>
        <button class="${primaryCls}" id="ap-modal-primary">${primaryLabel}</button>
      </div>
    </div>`;
  overlay.style.display = 'flex';
  document.getElementById('ap-modal-primary').onclick = onPrimary;
  overlay.onclick = e => { if (e.target === overlay) _apCloseModal(); };
}
function _apCloseModal() {
  const overlay = document.getElementById('gw-ap-overlay');
  if (overlay) overlay.style.display = 'none';
}
window._apCloseModal = _apCloseModal;

function _apRelTime(iso) {
  if (!iso) return '';
  const diff = Date.now() - new Date(iso).getTime();
  const min = Math.floor(diff/60000);
  if (min < 2)   return 'just now';
  if (min < 60)  return `${min}m ago`;
  const hr = Math.floor(min/60);
  if (hr < 24)   return `${hr}h ago`;
  const d = Math.floor(hr/24);
  if (d < 7)     return `${d}d ago`;
  return new Date(iso).toLocaleDateString(undefined, { month:'short', day:'numeric' });
}

// ══════════════════════════════════════════════════════════════════════════════
// APPROVAL QUEUE VIEW
// ══════════════════════════════════════════════════════════════════════════════
function approvalQueue() {
  const view = document.getElementById('view');
  if (!view) return;

  const canApprove = window.gwCan ? gwCan('can_approve_requests') : false;
  const allApprovals = gwApproval.list();
  const pending   = allApprovals.filter(a => a.status === 'pending');
  const decided   = allApprovals.filter(a => a.status !== 'pending');

  const escH = s => typeof escapeHtml === 'function' ? escapeHtml(s||'') : (s||'').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]));

  function rowHtml(a, showActions) {
    const typeLabel = (window.GW_APPROVAL_TYPES && GW_APPROVAL_TYPES[a.type]?.label) || a.type;
    return `
      <div class="ap-row" data-id="${a.id}">
        <div class="ap-row-left">
          <span class="ap-status ${_apStatusCss(a.status)}">${_apLabel(a.status)}</span>
          <div class="ap-row-info">
            <strong class="ap-row-entity">${escH(a.entityLabel||a.entityId)}</strong>
            <span class="ap-row-type">${typeLabel} &middot; ${a.entityType||''}</span>
            <span class="ap-row-meta">Requested by ${escH(a.requestedByName)} &middot; ${_apRelTime(a.requestedAt)}</span>
            ${a.notes ? `<span class="ap-row-notes">${escH(a.notes)}</span>` : ''}
          </div>
        </div>
        <div class="ap-row-right">
          ${(showActions && canApprove) ? `
            <button class="ap-btn-approve" onclick="gwApproval._decideModal('${a.id}','approve')">Approve</button>
            <button class="ap-btn-reject"  onclick="gwApproval._decideModal('${a.id}','reject')">Reject</button>
            <button class="secondary-btn ap-btn-sm" onclick="gwApproval.cancel('${a.id}');approvalQueue()">Cancel</button>
          ` : (a.decidedAt ? `<span class="ap-meta">${a.approverName||''} &middot; ${_apRelTime(a.decidedAt)}</span>` : '')}
          ${(!showActions && a.status==='rejected') ? `<button class="secondary-btn ap-btn-sm" onclick="gwApproval.resubmit('${a.id}');approvalQueue()">Resubmit</button>` : ''}
        </div>
      </div>`;
  }

  view.innerHTML = `
    <div class="view-wrap">
      <div class="page-header">
        <div>
          <h1 class="page-title">Approval Queue</h1>
          <p class="page-sub">Manage pending approval requests across all record types.</p>
        </div>
      </div>

      <div class="ap-queue-stats">
        <div class="ap-stat-card">
          <div class="ap-stat-num">${pending.length}</div>
          <div class="ap-stat-label">Pending</div>
        </div>
        <div class="ap-stat-card">
          <div class="ap-stat-num">${allApprovals.filter(a=>a.status==='approved').length}</div>
          <div class="ap-stat-label">Approved</div>
        </div>
        <div class="ap-stat-card">
          <div class="ap-stat-num">${allApprovals.filter(a=>a.status==='rejected').length}</div>
          <div class="ap-stat-label">Rejected</div>
        </div>
      </div>

      <div class="ap-section">
        <h2 class="ap-section-title">Pending (${pending.length})</h2>
        ${pending.length === 0
          ? '<div class="ap-empty">No pending approval requests.</div>'
          : pending.map(a => rowHtml(a, true)).join('')}
      </div>

      <div class="ap-section" style="margin-top:28px">
        <h2 class="ap-section-title">Recent Decisions</h2>
        ${decided.length === 0
          ? '<div class="ap-empty">No decisions yet.</div>'
          : decided.slice(0,20).map(a => rowHtml(a, false)).join('')}
      </div>
    </div>`;

  gwApproval._badgeUpdate();
}

window.approvalQueue = approvalQueue;
