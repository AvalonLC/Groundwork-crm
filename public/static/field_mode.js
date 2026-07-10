/**
 * Groundwork CRM — Phase 8 Field / Mobile Mode
 *
 * Provides a narrow, high-utility mobile experience for field roles:
 *   foreman, laborer
 *
 * Activated automatically when:
 *   a) User role is foreman or laborer AND screen width <= 768px
 *   b) User manually activates via show('fieldMode')
 *
 * Field mode surfaces:
 *   - My Schedule (today's assigned jobs)
 *   - Assigned Work Orders (list + detail)
 *   - Time Tracker (clock in/out)
 *   - Job Detail (assigned to me)
 *   - Status Updates (complete, note)
 *   - Completion action (mark WO complete if authorized)
 *
 * Design: reduced density, large tap targets, clear state hierarchy.
 * Uses existing token system — no separate design language.
 */

'use strict';

// ── Field Role Detection ──────────────────────────────────────────────────────
const GW_FIELD_ROLES = ['foreman', 'laborer', 'field_supervisor'];

function _isFieldRole() {
  const rep = window._d1SessionRep || (window.getCurrentRep ? window.getCurrentRep() : null);
  if (!rep) return false;
  return GW_FIELD_ROLES.includes(rep.role);
}

function _isMobile() {
  return window.innerWidth <= 768;
}

function _fieldRoleLabel() {
  const rep = window._d1SessionRep || (window.getCurrentRep ? window.getCurrentRep() : null);
  if (!rep) return '';
  return rep.role === 'foreman' ? 'Foreman' : rep.role === 'field_supervisor' ? 'Foreman' : 'Crew Member';
}

function _currentRep() {
  return window._d1SessionRep || (window.getCurrentRep ? window.getCurrentRep() : null);
}

function _escH(s) {
  return typeof escapeHtml === 'function' ? escapeHtml(s||'') : (s||'').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]));
}

function _todayISO() { return new Date().toISOString().slice(0,10); }

function _fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso + 'T12:00:00');
  return d.toLocaleDateString(undefined, { weekday:'short', month:'short', day:'numeric' });
}

// ── Data helpers — read from state ────────────────────────────────────────────
function _getMyWorkOrders() {
  const rep = _currentRep();
  if (!rep) return [];
  const state = window._avalonState || {};
  const wos = state.workOrders || [];
  // Field mode shows: assigned to me, or any open if supervisor
  const isSupervisor = rep.role === 'foreman' || rep.role === 'field_supervisor';
  const today = _todayISO();
  return wos.filter(wo => {
    if (isSupervisor) return wo.status !== 'cancelled';
    // Laborer: only assigned to me
    return wo.crew && (Array.isArray(wo.crew) ? wo.crew.includes(rep.id) : wo.crew === rep.id);
  }).sort((a,b) => {
    // Today first, then upcoming, then past
    const aToday = a.date === today;
    const bToday = b.date === today;
    if (aToday && !bToday) return -1;
    if (!aToday && bToday) return 1;
    return (a.date || '').localeCompare(b.date || '');
  });
}

function _getMySchedule() {
  const today = _todayISO();
  const wos = _getMyWorkOrders();
  return wos.filter(wo => wo.date === today || wo.date === today);
}

// ── Field Mode: Main View ─────────────────────────────────────────────────────
function fieldMode() {
  const view = document.getElementById('view');
  if (!view) return;

  const rep = _currentRep();
  const isSupervisor = rep?.role === 'foreman' || rep?.role === 'field_supervisor';
  const myWOs = _getMyWorkOrders();
  const todayWOs = myWOs.filter(wo => wo.date === _todayISO());
  const upcomingWOs = myWOs.filter(wo => wo.date > _todayISO()).slice(0,5);

  const canComplete = window.gwCan ? gwCan('can_mark_work_order_complete') : isSupervisor;

  function woCard(wo, isToday=false) {
    const statusClass = {
      'scheduled':'field-wo-status--scheduled',
      'in_progress':'field-wo-status--active',
      'complete':'field-wo-status--done',
      'pending':'field-wo-status--pending',
    }[wo.status] || '';
    const statusLabel = {
      'scheduled':'Scheduled', 'in_progress':'In Progress', 'complete':'Complete', 'pending':'Pending'
    }[wo.status] || (wo.status||'Open');

    return `
      <div class="field-wo-card ${isToday?'field-wo-card--today':''}">
        <div class="field-wo-card-header">
          <div>
            <div class="field-wo-title">${_escH(wo.title||('Work Order #'+wo.id.slice(-4)))}</div>
            <div class="field-wo-meta">${_escH(wo.address||wo.client||'')}</div>
          </div>
          <span class="field-wo-status ${statusClass}">${statusLabel}</span>
        </div>
        ${wo.date ? `<div class="field-wo-date">${_fmtDate(wo.date)}${wo.startTime?' at '+wo.startTime:''}</div>` : ''}
        ${wo.notes ? `<div class="field-wo-notes">${_escH(wo.notes.slice(0,120))}${wo.notes.length>120?'…':''}</div>` : ''}
        <div class="field-wo-actions">
          <button class="field-action-btn" onclick="_fieldWODetail('${wo.id}')">View Details</button>
          ${(canComplete && wo.status !== 'complete') ? `
            <button class="field-action-btn field-action-btn--primary" onclick="_fieldCompleteWO('${wo.id}')">Mark Complete</button>
          ` : ''}
        </div>
      </div>`;
  }

  view.innerHTML = `
    <div class="field-mode-wrap">
      <div class="field-header">
        <div>
          <h1 class="field-title">Field Mode</h1>
          <p class="field-sub">${_escH(rep?.name||'Field User')} &middot; ${_fieldRoleLabel()}</p>
        </div>
        <button class="field-exit-btn" onclick="show('today')" title="Exit Field Mode">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M10 3l-5 5 5 5"/></svg>
          Full App
        </button>
      </div>

      <!-- Quick actions strip -->
      <div class="field-quick-actions">
        <button class="field-quick-btn" onclick="show('timeTracker')">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="13" r="7"/><path d="M12 9v4l2.5 2"/><path d="M9 1h6M12 1v3"/></svg>
          <span>Time</span>
        </button>
        <button class="field-quick-btn" onclick="show('workOrderList')">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2"/><rect x="9" y="3" width="6" height="4" rx="1"/><path d="M9 12h6M9 16h4"/></svg>
          <span>Orders</span>
        </button>
        ${isSupervisor ? `
        <button class="field-quick-btn" onclick="show('scheduleBoard')">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/></svg>
          <span>Schedule</span>
        </button>
        <button class="field-quick-btn" onclick="show('crewView')">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="9" cy="7" r="3"/><circle cx="15" cy="7" r="3"/><path d="M3 21c0-3.3 2.7-6 6-6h6c3.3 0 6 2.7 6 6"/></svg>
          <span>Crew</span>
        </button>` : ''}
      </div>

      <!-- Today's jobs -->
      <div class="field-section">
        <h2 class="field-section-title">Today (${todayWOs.length})</h2>
        ${todayWOs.length === 0
          ? '<div class="field-empty">No jobs assigned for today.</div>'
          : todayWOs.map(wo => woCard(wo, true)).join('')}
      </div>

      <!-- Upcoming -->
      ${upcomingWOs.length > 0 ? `
      <div class="field-section">
        <h2 class="field-section-title">Upcoming</h2>
        ${upcomingWOs.map(wo => woCard(wo, false)).join('')}
      </div>` : ''}

      <!-- Notes / quick log -->
      <div class="field-section">
        <h2 class="field-section-title">Quick Field Note</h2>
        <div class="field-note-area">
          <textarea id="field-note-input" class="field-note-input" rows="3" placeholder="Log a quick note, issue, or update…"></textarea>
          <button class="field-action-btn field-action-btn--primary" onclick="_fieldLogNote()">Log Note</button>
        </div>
      </div>
    </div>`;
}

// ── Field WO Detail ───────────────────────────────────────────────────────────
window._fieldWODetail = function(woId) {
  const state = window._avalonState || {};
  const wo = (state.workOrders||[]).find(w => w.id === woId);
  if (!wo) { showToast && showToast('Work order not found.', 'error'); return; }

  const view = document.getElementById('view');
  if (!view) return;

  const isSupervisor = _currentRep()?.role === 'foreman' || _currentRep()?.role === 'field_supervisor';
  const canComplete = window.gwCan ? gwCan('can_mark_work_order_complete') : isSupervisor;

  const checklist = wo.checklist || [];

  view.innerHTML = `
    <div class="field-mode-wrap">
      <div class="field-header">
        <button class="field-exit-btn" onclick="fieldMode()">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M10 3l-5 5 5 5"/></svg>
          Back
        </button>
      </div>

      <div class="field-wo-detail">
        <h2 class="field-wo-detail-title">${_escH(wo.title||('Work Order #'+wo.id.slice(-4)))}</h2>
        <div class="field-wo-detail-meta">
          ${wo.address ? `<div><strong>Location:</strong> ${_escH(wo.address)}</div>` : ''}
          ${wo.client  ? `<div><strong>Client:</strong> ${_escH(wo.client)}</div>` : ''}
          ${wo.date    ? `<div><strong>Date:</strong> ${_fmtDate(wo.date)}</div>` : ''}
          ${wo.startTime ? `<div><strong>Start Time:</strong> ${_escH(wo.startTime)}</div>` : ''}
          <div><strong>Status:</strong> ${_escH(wo.status||'Open')}</div>
        </div>

        ${wo.notes ? `<div class="field-wo-detail-notes">${_escH(wo.notes)}</div>` : ''}

        ${checklist.length > 0 ? `
        <div class="field-checklist">
          <h3 class="field-checklist-title">Checklist</h3>
          ${checklist.map((item,i) => `
            <label class="field-checklist-item">
              <input type="checkbox" ${item.done?'checked':''} onchange="_fieldCheckItem('${woId}',${i},this.checked)">
              <span>${_escH(item.label||item)}</span>
            </label>`).join('')}
        </div>` : ''}

        <div class="field-detail-actions">
          ${(canComplete && wo.status !== 'complete') ? `
            <button class="field-action-btn field-action-btn--primary field-action-btn--large" onclick="_fieldCompleteWO('${woId}')">
              Mark Work Order Complete
            </button>` : ''}
          ${wo.status === 'complete' ? `<div class="field-complete-badge">Work Order Complete</div>` : ''}
        </div>

        <div class="field-section" style="margin-top:24px">
          <h3 class="field-section-title">Add Note</h3>
          <div class="field-note-area">
            <textarea id="field-detail-note" class="field-note-input" rows="3" placeholder="Add a job note, update, or issue…"></textarea>
            <button class="field-action-btn" onclick="_fieldLogDetailNote('${woId}')">Log Note</button>
          </div>
        </div>
      </div>
    </div>`;
};

// ── Field actions ─────────────────────────────────────────────────────────────
window._fieldCompleteWO = function(woId) {
  if (!confirm('Mark this work order as complete?')) return;
  const state = window._avalonState || {};
  const wo = (state.workOrders||[]).find(w => w.id === woId);
  if (!wo) return;
  wo.status = 'complete';
  wo.completedAt = new Date().toISOString();
  window.saveState && saveState();
  if (window.gwWorkflow) gwWorkflow.workOrderCompleted(woId, wo.title||woId);
  showToast && showToast('Work order marked complete.', 'success');
  fieldMode();
};

window._fieldCheckItem = function(woId, itemIdx, done) {
  const state = window._avalonState || {};
  const wo = (state.workOrders||[]).find(w => w.id === woId);
  if (!wo || !wo.checklist) return;
  if (typeof wo.checklist[itemIdx] === 'object') {
    wo.checklist[itemIdx].done = done;
  } else {
    wo.checklist[itemIdx] = { label: wo.checklist[itemIdx], done };
  }
  window.saveState && saveState();
};

window._fieldLogNote = function() {
  const input = document.getElementById('field-note-input');
  const text = input?.value?.trim();
  if (!text) return;
  if (window.gwAudit) gwAudit({ type:'communication_logged', summary:'Field note logged: ' + text.slice(0,80) });
  if (window.gwLogComm) gwLogComm({ type:'note', subject:'Field Note', body:text });
  input.value = '';
  showToast && showToast('Note logged.', 'success');
};

window._fieldLogDetailNote = function(woId) {
  const input = document.getElementById('field-detail-note');
  const text = input?.value?.trim();
  if (!text) return;
  const state = window._avalonState || {};
  const wo = (state.workOrders||[]).find(w => w.id === woId);
  if (wo) {
    wo.notes = (wo.notes ? wo.notes + '\n---\n' : '') + new Date().toLocaleString() + ': ' + text;
    window.saveState && saveState();
  }
  if (window.gwLogComm) gwLogComm({ type:'note', entityType:'work_order', entityId:woId, subject:'Field Note', body:text });
  input.value = '';
  showToast && showToast('Note logged.', 'success');
};

// ── Auto-activate field mode ──────────────────────────────────────────────────
// If user is a field role and on mobile, redirect default landing to fieldMode
function _gwMaybeFieldMode() {
  if (_isFieldRole() && _isMobile()) {
    // Override the initial route to field mode
    const orig = window.show;
    window._gwFieldModeReady = true;
    // Don't override show() — just set a flag so _initialRoute can pick it up
  }
}

// Called from app_premium.js _initialRoute — field roles land on fieldDashboard on all screen sizes
window._gwShouldStartFieldMode = function() {
  return _isFieldRole();
};

// Listen for resize — if a field user switches to mobile, offer field mode
window.addEventListener('resize', () => {
  if (_isFieldRole() && _isMobile() && window._currentView && window._currentView !== 'fieldMode') {
    // Subtle: add field mode button to topbar if not already there
    _gwInjectFieldModeButton();
  }
});

function _gwInjectFieldModeButton() {
  if (document.getElementById('gw-field-mode-btn')) return;
  const topbar = document.querySelector('.topbar');
  if (!topbar) return;
  const btn = document.createElement('button');
  btn.id = 'gw-field-mode-btn';
  btn.className = 'field-mode-topbar-btn';
  btn.title = 'Switch to Field Mode';
  btn.innerHTML = `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M8 1v6h6"/><circle cx="8" cy="8" r="7"/></svg> Field`;
  btn.onclick = () => { if (window.show) show('fieldMode'); };
  topbar.insertBefore(btn, topbar.querySelector('.topbar-settings'));
}

// On field roles, inject the field mode button
document.addEventListener('DOMContentLoaded', () => {
  setTimeout(() => {
    if (_isFieldRole()) _gwInjectFieldModeButton();
  }, 1500);
});

window.fieldMode = fieldMode;

// Audit log view (accessible from Settings for admin/office_manager)
function auditLog() {
  const view = document.getElementById('view');
  if (!view) return;

  const canView = window.gwCan ? gwCan('can_view_audit_logs') : true;
  if (!canView) {
    view.innerHTML = `<div style="padding:48px 24px;text-align:center;color:var(--gw-muted)">You do not have permission to view audit logs.</div>`;
    return;
  }

  let log = [];
  try { log = JSON.parse(localStorage.getItem('gwAuditLog') || '[]'); } catch(_) {}

  const typeLabel = t => (window.GW_AUDIT_TYPES && GW_AUDIT_TYPES[t]) || t?.replace(/_/g,' ');
  const relTime = iso => {
    if (!iso) return '';
    const diff = Date.now() - new Date(iso).getTime();
    const min = Math.floor(diff/60000);
    if (min < 2) return 'just now';
    if (min < 60) return min + 'm ago';
    const hr = Math.floor(min/60);
    if (hr < 24) return hr + 'h ago';
    const d = Math.floor(hr/24);
    if (d < 7) return d + 'd ago';
    return new Date(iso).toLocaleDateString(undefined, { month:'short', day:'numeric', year:'numeric' });
  };

  // Filter state
  const filterTypes = window._auditFilterType || '';

  const filtered = filterTypes
    ? log.filter(e => e.type === filterTypes)
    : log;

  const typeOptions = [...new Set(log.map(e => e.type))].sort();

  view.innerHTML = `
    <div class="view-wrap">
      <div class="page-header">
        <div>
          <h1 class="page-title">Audit Log</h1>
          <p class="page-sub">Track role changes, approvals, status changes, and system events.</p>
        </div>
      </div>

      <div class="audit-toolbar">
        <select class="audit-filter-select" onchange="window._auditFilterType=this.value;auditLog()">
          <option value="">All event types (${log.length})</option>
          ${typeOptions.map(t => `<option value="${t}" ${filterTypes===t?'selected':''}>${typeLabel(t)}</option>`).join('')}
        </select>
        <span class="audit-count">${filtered.length} event${filtered.length!==1?'s':''}</span>
      </div>

      ${filtered.length === 0
        ? '<div class="audit-empty">No audit events recorded yet. Events are logged automatically as actions happen across the platform.</div>'
        : `<div class="audit-log-list">
            ${filtered.map(e => `
              <div class="audit-row">
                <div class="audit-row-icon">
                  <div class="audit-type-dot"></div>
                </div>
                <div class="audit-row-body">
                  <div class="audit-row-top">
                    <span class="audit-row-summary">${_escH(e.summary || typeLabel(e.type))}</span>
                    <span class="audit-row-time">${relTime(e.ts)}</span>
                  </div>
                  <div class="audit-row-meta">
                    ${e.actorName ? `<span>${_escH(e.actorName)}</span>` : ''}
                    ${e.entityLabel||e.entityId ? `<span>&middot; ${_escH(e.entityLabel||e.entityId)}</span>` : ''}
                    ${e.entityType ? `<span class="audit-entity-type">${_escH(e.entityType)}</span>` : ''}
                  </div>
                </div>
              </div>`).join('')}
          </div>`}
    </div>`;
}

window.auditLog = auditLog;

console.info('[GW Field Mode] Phase 8 field/mobile foundation initialized.');
