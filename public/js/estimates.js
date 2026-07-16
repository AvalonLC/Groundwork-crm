// ══════════════════════════════════════════════════════════════════════════════
// Groundwork CRM — Estimates System (p45)
// estimates.js — Estimate List, Builder, Detail, Portal Preview
// ══════════════════════════════════════════════════════════════════════════════

'use strict';

// ── Shared Utilities ──────────────────────────────────────────────────────────

function _estFmt(v) {
  const n = Number(v || 0);
  return isNaN(n) ? '—' : '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function _estDate(d) {
  if (!d) return '—';
  try { return new Date(d + (d.includes('T') ? '' : 'T00:00:00')).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }); }
  catch (e) { return d; }
}

function _estRelDate(d) {
  if (!d) return '';
  const ms = Date.now() - new Date(d).getTime();
  const mins = Math.floor(ms / 60000);
  if (mins < 2) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days}d ago`;
  return _estDate(d);
}

function _estInitials(name) {
  return (name || '?').split(' ').map(w => w[0]).slice(0, 2).join('').toUpperCase();
}

function _estEsc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function _estUID() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function _estStatusConfig(status) {
  const map = {
    draft:             { label: 'Draft',             cls: 'est-badge--draft',    icon: 'status-draft' },
    sent:              { label: 'Sent',               cls: 'est-badge--sent',     icon: 'status-sent' },
    viewed:            { label: 'Viewed',             cls: 'est-badge--viewed',   icon: 'status-viewed' },
    accepted:          { label: 'Accepted',           cls: 'est-badge--accepted', icon: 'status-accepted' },
    declined:          { label: 'Declined',           cls: 'est-badge--declined', icon: 'status-declined' },
    changes_requested: { label: 'Changes Requested',  cls: 'est-badge--changes',  icon: 'status-changes' },
    expired:           { label: 'Expired',            cls: 'est-badge--expired',  icon: 'status-expired' },
    invoiced:          { label: 'Invoiced',           cls: 'est-badge--invoiced', icon: 'status-invoiced' },
  };
  return map[status] || { label: status || 'Draft', cls: 'est-badge--draft', icon: '·' };
}

function _estNormalize(est) {
  if (!est) return est;
  if (typeof est.line_items === 'string') try { est.line_items = JSON.parse(est.line_items); } catch(e) { est.line_items = []; }
  if (typeof est.attachments === 'string') try { est.attachments = JSON.parse(est.attachments); } catch(e) { est.attachments = []; }
  if (typeof est.payment_schedule === 'string') try { est.payment_schedule = JSON.parse(est.payment_schedule); } catch(e) { est.payment_schedule = []; }
  if (!Array.isArray(est.line_items)) est.line_items = [];
  if (!Array.isArray(est.attachments)) est.attachments = [];
  if (!Array.isArray(est.payment_schedule)) est.payment_schedule = [];
  return est;
}

// ── In-Memory Draft State ─────────────────────────────────────────────────────

let _estDraft = null;
let _estSavePending = false;
let _estSaveTimer = null;

// ── ESTIMATES LIST PAGE ───────────────────────────────────────────────────────

async function estimates() {
  const view = document.getElementById('view');
  if (!view) return;

  view.innerHTML = `
  <div class="est-list-shell">
    <div class="est-list-header">
      <div class="est-list-header-left">
        <h1 class="est-list-title">Estimates</h1>
        <span class="est-list-subtitle" id="est-list-subtitle">Loading…</span>
      </div>
      <div class="est-list-header-right">
        <button class="est-btn-primary" onclick="_estNewEstimate()">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="8" y1="2" x2="8" y2="14"/><line x1="2" y1="8" x2="14" y2="8"/></svg>
          New Estimate
        </button>
      </div>
    </div>

    <!-- KPI Row -->
    <div class="est-kpi-row" id="est-kpi-row">
      <div class="est-kpi-card est-kpi-card--loading"><div class="est-kpi-shimmer"></div></div>
      <div class="est-kpi-card est-kpi-card--loading"><div class="est-kpi-shimmer"></div></div>
      <div class="est-kpi-card est-kpi-card--loading"><div class="est-kpi-shimmer"></div></div>
      <div class="est-kpi-card est-kpi-card--loading"><div class="est-kpi-shimmer"></div></div>
      <div class="est-kpi-card est-kpi-card--loading"><div class="est-kpi-shimmer"></div></div>
    </div>

    <!-- Filter Bar -->
    <div class="est-filter-bar">
      <div class="est-search-wrap">
        <svg class="est-search-icon" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="7" cy="7" r="5"/><path d="M14 14l-3.5-3.5"/></svg>
        <input id="est-search" class="est-search-input" type="text" placeholder="Search customer, number, title…" oninput="_estListFilter()">
      </div>
      <select id="est-filter-status" class="est-filter-select" onchange="_estListFilter()">
        <option value="">All statuses</option>
        <option value="draft">Draft</option>
        <option value="sent">Sent</option>
        <option value="viewed">Viewed</option>
        <option value="accepted">Accepted</option>
        <option value="declined">Declined</option>
        <option value="changes_requested">Changes Requested</option>
        <option value="expired">Expired</option>
        <option value="invoiced">Invoiced</option>
      </select>
      <select id="est-filter-rep" class="est-filter-select" onchange="_estListFilter()">
        <option value="">All reps</option>
        ${(window.REPS || []).filter(r => !['field','tech'].includes(r.role)).map(r => `<option value="${_estEsc(r.id)}">${_estEsc(r.name)}</option>`).join('')}
      </select>
      <div class="est-filter-chips" id="est-filter-chips">
        <button class="est-chip est-chip--active" data-chip="all" onclick="_estChipFilter(this,'')">All</button>
        <button class="est-chip" data-chip="follow_up" onclick="_estChipFilter(this,'follow_up')">Follow-up needed</button>
        <button class="est-chip" data-chip="viewed" onclick="_estChipFilter(this,'viewed')">Viewed</button>
        <button class="est-chip" data-chip="accepted" onclick="_estChipFilter(this,'accepted')">Accepted</button>
        <button class="est-chip" data-chip="draft" onclick="_estChipFilter(this,'draft')">Draft</button>
      </div>
    </div>

    <!-- Table -->
    <div class="est-table-wrap">
      <table class="est-table" id="est-table">
        <thead>
          <tr>
            <th style="width:100px">Number</th>
            <th>Customer</th>
            <th>Title / Service</th>
            <th style="width:110px">Total</th>
            <th style="width:120px">Status</th>
            <th style="width:140px">Engagement</th>
            <th style="width:100px">Updated</th>
            <th style="width:90px"></th>
          </tr>
        </thead>
        <tbody id="est-table-body">
          <tr><td colspan="8" class="est-table-loading">
            <div class="est-spinner"></div> Loading estimates…
          </td></tr>
        </tbody>
      </table>
    </div>

    <!-- Empty State -->
    <div class="est-empty-state" id="est-empty-state" style="display:none">
      <div class="est-empty-icon">${gwIcon('estimate',48,'var(--gw-text-muted,#9CA3AF)')}</div>
      <div class="est-empty-title">No estimates yet</div>
      <div class="est-empty-sub">Create your first estimate to get started</div>
      <button class="est-btn-primary" onclick="_estNewEstimate()">New Estimate</button>
    </div>

    <!-- Preview Drawer -->
    <div class="est-preview-drawer" id="est-preview-drawer" style="display:none">
      <div class="est-preview-drawer-inner" id="est-preview-drawer-inner">
        <div class="est-preview-drawer-header">
          <span id="est-preview-drawer-title">Estimate</span>
          <button class="est-preview-drawer-close" onclick="_estCloseDrawer()">✕</button>
        </div>
        <div id="est-preview-drawer-body"></div>
      </div>
    </div>
  </div>`;

  // Load KPIs and list in parallel
  _estLoadKpis();
  _estLoadList();
}

// Active chip filter state
let _estActiveChip = '';

function _estChipFilter(el, chip) {
  _estActiveChip = chip;
  document.querySelectorAll('.est-chip').forEach(c => c.classList.remove('est-chip--active'));
  el.classList.add('est-chip--active');
  // If chip maps to a status, set status filter
  const statusMap = { viewed: 'viewed', accepted: 'accepted', draft: 'draft' };
  const statusSel = document.getElementById('est-filter-status');
  if (statusSel) statusSel.value = statusMap[chip] || '';
  _estLoadList();
}

async function _estLoadKpis() {
  try {
    const r = await fetch('/api/estimates/kpis', { credentials: 'include' });
    if (!r.ok) return;
    const { data } = await r.json();
    const kpiRow = document.getElementById('est-kpi-row');
    if (!kpiRow) return;

    const all = Object.values(data).reduce((s, v) => s + (v.cnt || 0), 0);
    const allVal = Object.values(data).reduce((s, v) => s + (v.val || 0), 0);
    const pending = (data.sent?.cnt || 0) + (data.viewed?.cnt || 0) + (data.changes_requested?.cnt || 0);
    const pendingVal = (data.sent?.val || 0) + (data.viewed?.val || 0) + (data.changes_requested?.val || 0);
    const accepted = data.accepted?.cnt || 0;
    const acceptedVal = data.accepted?.val || 0;
    const draft = data.draft?.cnt || 0;
    const declined = data.declined?.cnt || 0;

    kpiRow.innerHTML = `
      <div class="est-kpi-card" onclick="_estChipFilter(document.querySelector('[data-chip=all]'),'')">
        <div class="est-kpi-icon est-kpi-icon--blue">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="2" y="1" width="12" height="14" rx="1.5"/><path d="M5 5h6M5 8h6M5 11h4"/></svg>
        </div>
        <div class="est-kpi-body">
          <div class="est-kpi-value">${all}</div>
          <div class="est-kpi-label">Total Active</div>
          <div class="est-kpi-sub">${_estFmt(allVal)} pipeline</div>
        </div>
      </div>
      <div class="est-kpi-card est-kpi-card--yellow" onclick="_estChipFilter(document.querySelector('[data-chip=follow_up]'),'follow_up')">
        <div class="est-kpi-icon est-kpi-icon--yellow">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="8" cy="8" r="7"/><path d="M8 4v4l3 2"/></svg>
        </div>
        <div class="est-kpi-body">
          <div class="est-kpi-value">${pending}</div>
          <div class="est-kpi-label">Awaiting Response</div>
          <div class="est-kpi-sub">${_estFmt(pendingVal)} pending</div>
        </div>
      </div>
      <div class="est-kpi-card" onclick="_estChipFilter(document.querySelector('[data-chip=accepted]'),'accepted')">
        <div class="est-kpi-icon est-kpi-icon--green">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M2 8l4 4 8-8"/></svg>
        </div>
        <div class="est-kpi-body">
          <div class="est-kpi-value">${accepted}</div>
          <div class="est-kpi-label">Accepted / Won</div>
          <div class="est-kpi-sub">${_estFmt(acceptedVal)} won</div>
        </div>
      </div>
      <div class="est-kpi-card est-kpi-card--muted">
        <div class="est-kpi-icon est-kpi-icon--muted">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 1h8a1 1 0 011 1v12a1 1 0 01-1 1H4a1 1 0 01-1-1V2a1 1 0 011-1z"/><path d="M5 5h6M5 8h4"/></svg>
        </div>
        <div class="est-kpi-body">
          <div class="est-kpi-value">${draft}</div>
          <div class="est-kpi-label">Drafts</div>
          <div class="est-kpi-sub">Not yet sent</div>
        </div>
      </div>
      <div class="est-kpi-card est-kpi-card--red">
        <div class="est-kpi-icon est-kpi-icon--red">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8"><line x1="4" y1="4" x2="12" y2="12"/><line x1="12" y1="4" x2="4" y2="12"/></svg>
        </div>
        <div class="est-kpi-body">
          <div class="est-kpi-value">${declined}</div>
          <div class="est-kpi-label">Declined</div>
          <div class="est-kpi-sub">This period</div>
        </div>
      </div>`;
  } catch (e) {
    console.warn('[_estLoadKpis]', e);
  }
}

// Cache for list
let _estListData = [];

async function _estLoadList() {
  const statusSel = document.getElementById('est-filter-status');
  const repSel    = document.getElementById('est-filter-rep');
  const searchEl  = document.getElementById('est-search');
  const params = new URLSearchParams();
  const status = statusSel?.value || '';
  const rep    = repSel?.value || '';
  const q      = searchEl?.value?.trim() || '';
  if (status) params.set('status', status);
  if (rep)    params.set('rep_id', rep);
  if (q)      params.set('q', q);
  // follow_up chip: sent/viewed without recent follow-up
  const isFollowUp = _estActiveChip === 'follow_up';

  const tbody = document.getElementById('est-table-body');
  const subtitle = document.getElementById('est-list-subtitle');
  if (tbody) tbody.innerHTML = `<tr><td colspan="8" class="est-table-loading"><div class="est-spinner"></div> Loading…</td></tr>`;

  try {
    const r = await fetch(`/api/estimates?${params}`, { credentials: 'include' });
    if (!r.ok) throw new Error('API error');
    const { data } = await r.json();
    let rows = (data || []).map(_estNormalize);

    // Follow-up filter: sent or viewed but not responded
    if (isFollowUp) {
      rows = rows.filter(e => ['sent','viewed'].includes(e.status));
    }

    _estListData = rows;
    _estRenderTable(rows);
    if (subtitle) subtitle.textContent = `${rows.length} estimate${rows.length !== 1 ? 's' : ''}`;
  } catch (e) {
    console.warn('[_estLoadList]', e);
    if (tbody) tbody.innerHTML = `<tr><td colspan="8" class="est-table-error">Failed to load estimates. <button onclick="_estLoadList()" class="est-link">Retry</button></td></tr>`;
  }
}

function _estListFilter() {
  clearTimeout(_estSaveTimer);
  _estSaveTimer = setTimeout(_estLoadList, 280);
}

function _estRenderTable(rows) {
  const tbody = document.getElementById('est-table-body');
  const emptyState = document.getElementById('est-empty-state');
  if (!tbody) return;

  if (!rows.length) {
    tbody.innerHTML = '';
    if (emptyState) emptyState.style.display = 'flex';
    document.querySelector('.est-table-wrap').style.display = 'none';
    return;
  }
  if (emptyState) emptyState.style.display = 'none';
  document.querySelector('.est-table-wrap').style.display = '';

  tbody.innerHTML = rows.map(est => {
    const sc = _estStatusConfig(est.status);
    const engagementHtml = _estEngagementChips(est);
    const total = _estFmt(est.total);
    return `
    <tr class="est-table-row" data-id="${_estEsc(est.id)}" onclick="_estRowClick('${_estEsc(est.id)}')">
      <td><span class="est-number-tag">${_estEsc(est.est_number || '—')}</span></td>
      <td>
        <div class="est-row-client">${_estEsc(est.client_name || '—')}</div>
        ${est.property_addr ? `<div class="est-row-prop">${_estEsc(est.property_addr)}</div>` : ''}
      </td>
      <td>
        <div class="est-row-title">${_estEsc(est.title || est.client_name || 'Estimate')}</div>
        ${est.assigned_to ? `<div class="est-row-rep">${_estRepName(est.assigned_to)}</div>` : ''}
      </td>
      <td class="est-row-total">${total}</td>
      <td><span class="est-badge ${sc.cls}">${sc.label}</span></td>
      <td>${engagementHtml}</td>
      <td class="est-row-date">${_estRelDate(est.updated_at)}</td>
      <td onclick="event.stopPropagation()">
        <div class="est-row-actions">
          <button class="est-row-action" title="Open" onclick="estimateDetail('${_estEsc(est.id)}')">
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M7 2H3a1 1 0 00-1 1v10a1 1 0 001 1h10a1 1 0 001-1V9"/><path d="M10 1h5v5"/><line x1="15" y1="1" x2="7" y2="9"/></svg>
          </button>
          <button class="est-row-action" title="Edit" onclick="estimateBuilder('${_estEsc(est.id)}')">
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M11 2l3 3-9 9H2v-3l9-9z"/></svg>
          </button>
          <div class="est-row-more-wrap">
            <button class="est-row-action" title="More" onclick="_estRowMoreMenu(this,'${_estEsc(est.id)}','${_estEsc(est.status)}')">
              <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="8" cy="3" r="1"/><circle cx="8" cy="8" r="1"/><circle cx="8" cy="13" r="1"/></svg>
            </button>
          </div>
        </div>
      </td>
    </tr>`;
  }).join('');
}

function _estEngagementChips(est) {
  const chips = [];
  if (est.sent_at) chips.push(`<span class="est-eng-chip est-eng-chip--sent" title="Sent ${_estDate(est.sent_at)}">Sent</span>`);
  if (est.viewed_at) chips.push(`<span class="est-eng-chip est-eng-chip--viewed" title="Viewed ${_estDate(est.viewed_at)}">Viewed</span>`);
  if (est.accepted_at) chips.push(`<span class="est-eng-chip est-eng-chip--accepted" title="Accepted ${_estDate(est.accepted_at)}">Accepted</span>`);
  if (est.declined_at) chips.push(`<span class="est-eng-chip est-eng-chip--declined" title="Declined ${_estDate(est.declined_at)}">Declined</span>`);
  if (est.changes_at) chips.push(`<span class="est-eng-chip est-eng-chip--changes" title="Changes ${_estDate(est.changes_at)}">Changes</span>`);
  if (!chips.length && !est.sent_at) chips.push(`<span class="est-eng-chip est-eng-chip--none">Not sent</span>`);
  return `<div class="est-eng-chips">${chips.join('')}</div>`;
}

function _estRepName(id) {
  const rep = (window.REPS || []).find(r => r.id === id);
  return rep ? `<svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="8" cy="6" r="4"/><path d="M1 14a7 7 0 0114 0"/></svg> ${_estEsc(rep.name)}` : '';
}

function _estRowClick(id) {
  _estOpenDrawer(id);
}

async function _estOpenDrawer(id) {
  const drawer = document.getElementById('est-preview-drawer');
  const body   = document.getElementById('est-preview-drawer-body');
  const title  = document.getElementById('est-preview-drawer-title');
  if (!drawer || !body) return;

  // Highlight row
  document.querySelectorAll('.est-table-row').forEach(r => r.classList.remove('est-table-row--active'));
  const row = document.querySelector(`.est-table-row[data-id="${id}"]`);
  if (row) row.classList.add('est-table-row--active');

  drawer.style.display = 'flex';
  body.innerHTML = `<div class="est-drawer-loading"><div class="est-spinner"></div></div>`;

  try {
    const r = await fetch(`/api/estimates/${id}`, { credentials: 'include' });
    if (!r.ok) throw new Error('Not found');
    const { data: est } = await r.json();
    _estNormalize(est);
    const sc = _estStatusConfig(est.status);
    if (title) title.textContent = est.est_number || 'Estimate';

    body.innerHTML = `
      <div class="est-drawer-header">
        <div class="est-drawer-num">${_estEsc(est.est_number || '—')}</div>
        <span class="est-badge ${sc.cls}">${sc.label}</span>
      </div>
      <div class="est-drawer-client">
        <div class="est-drawer-avatar">${_estInitials(est.client_name)}</div>
        <div>
          <div class="est-drawer-client-name">${_estEsc(est.client_name || '—')}</div>
          ${est.property_addr ? `<div class="est-drawer-client-prop">${_estEsc(est.property_addr)}</div>` : ''}
        </div>
      </div>
      <div class="est-drawer-financials">
        <div class="est-drawer-fin-row">
          <span>Subtotal</span><span>${_estFmt(est.subtotal)}</span>
        </div>
        ${est.discount_amt > 0 ? `<div class="est-drawer-fin-row"><span>Discount</span><span class="est-text-green">−${_estFmt(est.discount_amt)}</span></div>` : ''}
        ${est.tax_amt > 0 ? `<div class="est-drawer-fin-row"><span>Tax</span><span>${_estFmt(est.tax_amt)}</span></div>` : ''}
        <div class="est-drawer-fin-row est-drawer-fin-total">
          <span>Total</span><span>${_estFmt(est.total)}</span>
        </div>
        ${est.deposit_amt > 0 ? `
        <div class="est-drawer-deposit">
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="8" cy="8" r="7"/><path d="M8 5v3l2 2"/></svg>
          Deposit due: <strong>${_estFmt(est.deposit_amt)}</strong>
        </div>` : ''}
      </div>
      ${_estEngagementChips(est)}
      ${est.title ? `<div class="est-drawer-section"><div class="est-drawer-label">Title</div><div>${_estEsc(est.title)}</div></div>` : ''}
      ${est.scope_of_work ? `<div class="est-drawer-section"><div class="est-drawer-label">Scope</div><div class="est-drawer-scope">${_estEsc(est.scope_of_work).replace(/\n/g,'<br>')}</div></div>` : ''}
      ${est.line_items.length ? `
      <div class="est-drawer-section">
        <div class="est-drawer-label">Line Items (${est.line_items.length})</div>
        ${est.line_items.map(li => `
          <div class="est-drawer-line">
            <span>${_estEsc(li.name || li.description || '—')}</span>
            <span>${_estFmt(Number(li.qty || 1) * Number(li.rate || 0))}</span>
          </div>`).join('')}
      </div>` : ''}
      <div class="est-drawer-actions">
        <button class="est-btn-primary est-btn-sm" onclick="estimateDetail('${_estEsc(est.id)}')">Open Detail</button>
        <button class="est-btn-secondary est-btn-sm" onclick="estimateBuilder('${_estEsc(est.id)}')">Edit</button>
        ${est.status === 'draft' || est.status === 'viewed' ? `<button class="est-btn-secondary est-btn-sm" onclick="_estSendModal('${_estEsc(est.id)}','${_estEsc(est.client_email||'')}','${_estEsc(est.client_name||'')}')">Send</button>` : ''}
        <button class="est-btn-ghost est-btn-sm" onclick="_estDuplicate('${_estEsc(est.id)}')">Duplicate</button>
      </div>`;
  } catch (e) {
    body.innerHTML = `<div class="est-drawer-error">Failed to load estimate.</div>`;
  }
}

function _estCloseDrawer() {
  const drawer = document.getElementById('est-preview-drawer');
  if (drawer) drawer.style.display = 'none';
  document.querySelectorAll('.est-table-row').forEach(r => r.classList.remove('est-table-row--active'));
}

function _estRowMoreMenu(btn, id, status) {
  // Remove any open menu
  document.querySelectorAll('.est-more-menu').forEach(m => m.remove());
  const menu = document.createElement('div');
  menu.className = 'est-more-menu';
  const actions = [];
  if (status === 'draft' || status === 'viewed' || status === 'changes_requested') {
    actions.push(`<button onclick="_estSendModal('${id}','','');_estCloseMenu()">Send to Customer</button>`);
  }
  if (status === 'accepted') {
    actions.push(`<button onclick="_estConvertToInvoice('${id}');_estCloseMenu()">Convert to Invoice</button>`);
  }
  actions.push(`<button onclick="_estDuplicate('${id}');_estCloseMenu()">Duplicate</button>`);
  actions.push(`<button onclick="estimateBuilder('${id}')">Edit</button>`);
  actions.push(`<button class="est-more-menu--danger" onclick="_estDeleteConfirm('${id}')">Delete</button>`);
  menu.innerHTML = actions.join('');
  btn.closest('.est-row-more-wrap').appendChild(menu);
  setTimeout(() => document.addEventListener('click', _estCloseMenu, { once: true }), 50);
}

function _estCloseMenu() {
  document.querySelectorAll('.est-more-menu').forEach(m => m.remove());
}

// ── ESTIMATE DETAIL PAGE ──────────────────────────────────────────────────────

async function estimateDetail(id) {
  const view = document.getElementById('view');
  if (!view) return;

  if (!id) {
    // No ID — show list
    return estimates();
  }

  // Show skeleton
  view.innerHTML = `
  <div class="est-detail-shell">
    <div class="est-detail-main">
      <div class="est-detail-skeleton">
        <div class="est-detail-skeleton-bar" style="width:60%;height:28px;margin-bottom:12px"></div>
        <div class="est-detail-skeleton-bar" style="width:40%;height:18px;margin-bottom:24px"></div>
        <div class="est-detail-skeleton-bar" style="width:100%;height:120px;margin-bottom:12px"></div>
        <div class="est-detail-skeleton-bar" style="width:100%;height:200px"></div>
      </div>
    </div>
    <div class="est-detail-rail">
      <div class="est-detail-skeleton-bar" style="width:100%;height:180px;margin-bottom:12px"></div>
      <div class="est-detail-skeleton-bar" style="width:100%;height:120px"></div>
    </div>
  </div>`;

  try {
    const r = await fetch(`/api/estimates/${id}`, { credentials: 'include' });
    if (!r.ok) throw new Error('Not found');
    const { data: est } = await r.json();
    _estNormalize(est);
    _estRenderDetail(est);
  } catch (e) {
    view.innerHTML = `<div style="padding:40px;text-align:center;color:var(--gw-text-muted)">
      <div style="margin-bottom:12px;opacity:0.4">${gwIcon('estimate',40,'var(--gw-text-muted,#6B7280)')}</div>
      <div style="font-size:16px;font-weight:600;margin-bottom:8px">Estimate not found</div>
      <button class="est-btn-primary" onclick="estimates()">Back to Estimates</button>
    </div>`;
  }
}

function _estRenderDetail(est) {
  const view = document.getElementById('view');
  if (!view) return;

  const sc = _estStatusConfig(est.status);
  const repName = _estRepName(est.assigned_to || est.rep_id);
  const subtotal = Number(est.subtotal || 0);
  const discAmt = Number(est.discount_amt || 0);
  const taxAmt = Number(est.tax_amt || 0);
  const total = Number(est.total || 0);
  const depositAmt = Number(est.deposit_amt || 0);

  // Primary action config
  let primaryAction = '';
  let secondaryActions = '';
  if (est.status === 'draft') {
    primaryAction = `<button class="est-detail-action-primary" onclick="_estSendModal('${_estEsc(est.id)}','${_estEsc(est.client_email||'')}','${_estEsc(est.client_name||'')}')">
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><rect x="1" y="3" width="14" height="10" rx="1.5"/><path d="M1 6l7 4 7-4"/></svg> Send to Customer</button>`;
  } else if (est.status === 'sent' || est.status === 'viewed' || est.status === 'changes_requested') {
    primaryAction = `<button class="est-detail-action-primary" onclick="_estSendModal('${_estEsc(est.id)}','${_estEsc(est.client_email||'')}','${_estEsc(est.client_name||'')}')">
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><rect x="1" y="3" width="14" height="10" rx="1.5"/><path d="M1 6l7 4 7-4"/></svg> Resend</button>`;
  } else if (est.status === 'accepted') {
    primaryAction = `<button class="est-detail-action-primary est-detail-action-primary--green" onclick="_estConvertToInvoice('${_estEsc(est.id)}')">
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><rect x="1" y="1" width="14" height="14" rx="1.5"/><path d="M4 8h8M4 5h5M4 11h6"/></svg> Convert to Invoice</button>`;
  }

  secondaryActions = `
    <button class="est-detail-action-btn" onclick="estimateBuilder('${_estEsc(est.id)}')">
      <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M11 2l3 3-9 9H2v-3l9-9z"/></svg> Edit
    </button>
    ${est.client_email ? `<button class="est-detail-action-btn" onclick="typeof window.gwSendEstimateEmail==='function'&&window.gwSendEstimateEmail('${_estEsc(est.id)}')">
      <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><rect x="1" y="3" width="14" height="10" rx="1.5"/><path d="M1 6l7 4 7-4"/></svg> Email
    </button>` : ''}
    <button class="est-detail-action-btn" onclick="_estPortalPreview('${_estEsc(est.id)}')">
      <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M1 8s3-5 7-5 7 5 7 5-3 5-7 5-7-5-7-5z"/><circle cx="8" cy="8" r="2"/></svg> Preview
    </button>
    <button class="est-detail-action-btn" onclick="_estDuplicate('${_estEsc(est.id)}')">
      <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><rect x="5" y="5" width="9" height="9" rx="1"/><path d="M2 11V3a1 1 0 011-1h8"/></svg> Duplicate
    </button>
    <div class="est-more-wrap-inline">
      <button class="est-detail-action-btn" onclick="_estDetailMoreMenu(this,'${_estEsc(est.id)}','${_estEsc(est.status)}')">More ▾</button>
    </div>`;

  // Engagement timeline
  const engagementItems = _estBuildEngagementTimeline(est);

  view.innerHTML = `
  <div class="est-detail-shell">

    <!-- Main Column -->
    <div class="est-detail-main">

      <!-- Back nav -->
      <div class="est-detail-nav">
        <button class="est-back-btn" onclick="estimates()">
          <svg width="13" height="13" viewBox="0 0 14 14" fill="none"><path d="M9 11L4 7l5-4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>
          Estimates
        </button>
      </div>

      <!-- Header -->
      <div class="est-detail-header">
        <div class="est-detail-header-left">
          <div class="est-detail-num">${_estEsc(est.est_number || 'EST')}</div>
          <h1 class="est-detail-title">${_estEsc(est.title || `Estimate for ${est.client_name || '—'}`)}</h1>
          <div class="est-detail-meta">
            <span class="est-badge ${sc.cls}">${sc.label}</span>
            <span class="est-detail-meta-item">
              <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="2" y="3" width="12" height="12" rx="1.5"/><path d="M5 1v4M11 1v4M2 7h12"/></svg>
              ${_estDate(est.estimate_date || est.created_at)}
            </span>
            ${est.expiry_date ? `<span class="est-detail-meta-item ${_estIsExpired(est.expiry_date) ? 'est-text-red' : ''}">
              <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="8" cy="8" r="7"/><path d="M8 4v4l3 2"/></svg>
              ${_estIsExpired(est.expiry_date) ? 'Expired' : 'Valid until'} ${_estDate(est.expiry_date)}
            </span>` : ''}
            ${est.assigned_to || est.rep_id ? `<span class="est-detail-meta-item">${_estRepName(est.assigned_to || est.rep_id)}</span>` : ''}
          </div>
        </div>
        <div class="est-detail-header-right">
          <div class="est-detail-total-badge">${_estFmt(total)}</div>
        </div>
      </div>

      <!-- Action Row -->
      <div class="est-detail-actions">
        ${primaryAction}
        <div class="est-detail-secondary-actions">
          ${secondaryActions}
        </div>
      </div>

      ${est.change_request ? `
      <div class="est-changes-banner">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M8 1L1 14h14L8 1z"/><path d="M8 6v4M8 11v1"/></svg>
        <div><strong>Changes requested:</strong> ${_estEsc(est.change_request)}</div>
      </div>` : ''}

      ${est.decline_reason ? `
      <div class="est-declined-banner">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="8" cy="8" r="7"/><path d="M5 5l6 6M11 5l-6 6"/></svg>
        <div><strong>Decline reason:</strong> ${_estEsc(est.decline_reason)}</div>
      </div>` : ''}

      <!-- Scope of Work -->
      ${est.scope_of_work ? `
      <section class="est-detail-section">
        <h2 class="est-detail-section-title">Scope of Work</h2>
        <div class="est-detail-scope">${_estEsc(est.scope_of_work).replace(/\n/g,'<br>')}</div>
      </section>` : ''}

      <!-- Line Items -->
      <section class="est-detail-section">
        <h2 class="est-detail-section-title">Pricing Breakdown</h2>
        ${est.line_items.length ? `
        <table class="est-detail-line-table">
          <thead>
            <tr>
              <th>Item / Description</th>
              <th class="est-col-num">Qty</th>
              <th class="est-col-num">Rate</th>
              <th class="est-col-num">Total</th>
            </tr>
          </thead>
          <tbody>
            ${est.line_items.map(li => `
            <tr>
              <td>
                <div class="est-li-name">${_estEsc(li.name || li.description || '—')}</div>
                ${li.desc || li.description2 ? `<div class="est-li-desc">${_estEsc(li.desc || li.description2)}</div>` : ''}
              </td>
              <td class="est-col-num">${li.qty || 1}</td>
              <td class="est-col-num">${_estFmt(li.rate || li.unit || 0)}</td>
              <td class="est-col-num est-li-total">${_estFmt(Number(li.qty || 1) * Number(li.rate || li.unit || 0))}</td>
            </tr>`).join('')}
          </tbody>
        </table>
        <div class="est-detail-totals">
          <div class="est-totals-row"><span>Subtotal</span><span>${_estFmt(subtotal)}</span></div>
          ${discAmt > 0 ? `<div class="est-totals-row est-text-green"><span>Discount</span><span>−${_estFmt(discAmt)}</span></div>` : ''}
          ${taxAmt > 0 ? `<div class="est-totals-row"><span>Tax (${est.tax_pct || 0}%)</span><span>${_estFmt(taxAmt)}</span></div>` : ''}
          <div class="est-totals-row est-totals-total"><span>Total</span><span>${_estFmt(total)}</span></div>
          ${depositAmt > 0 ? `
          <div class="est-deposit-callout">
            <div class="est-deposit-callout-label">Deposit Required (${est.deposit_pct || 30}%)</div>
            <div class="est-deposit-callout-amount">${_estFmt(depositAmt)}</div>
            <div class="est-deposit-callout-sub">Due at signing · ${_estFmt(total - depositAmt)} remaining after deposit</div>
          </div>` : ''}
        </div>` : `
        <div class="est-detail-empty-section">No line items — <button class="est-link" onclick="estimateBuilder('${_estEsc(est.id)}')">add items in editor</button></div>`}
      </section>

      <!-- Attachments -->
      ${est.attachments.length ? `
      <section class="est-detail-section">
        <h2 class="est-detail-section-title">Attachments (${est.attachments.length})</h2>
        <div class="est-attachment-gallery">
          ${est.attachments.map(a => _estAttachmentCard(a)).join('')}
        </div>
      </section>` : ''}

      <!-- Customer Notes -->
      ${est.customer_notes ? `
      <section class="est-detail-section">
        <h2 class="est-detail-section-title">Notes for Customer</h2>
        <div class="est-detail-notes">${_estEsc(est.customer_notes).replace(/\n/g,'<br>')}</div>
      </section>` : ''}

      <!-- Terms -->
      ${est.terms ? `
      <section class="est-detail-section">
        <h2 class="est-detail-section-title">Terms &amp; Conditions</h2>
        <div class="est-detail-terms">${_estEsc(est.terms).replace(/\n/g,'<br>')}</div>
      </section>` : ''}

      <!-- Internal Notes -->
      ${est.internal_notes ? `
      <section class="est-detail-section est-section-internal">
        <h2 class="est-detail-section-title">Internal Notes <span class="est-internal-tag">Internal only</span></h2>
        <div class="est-detail-notes est-detail-notes--internal">${_estEsc(est.internal_notes).replace(/\n/g,'<br>')}</div>
      </section>` : ''}

    </div>

    <!-- Right Rail -->
    <aside class="est-detail-rail">

      <!-- Engagement Signals -->
      <div class="est-rail-card">
        <div class="est-rail-card-title">Engagement</div>
        ${engagementItems.length ? `<div class="est-engagement-timeline">${engagementItems.join('')}</div>` : `<div class="est-rail-empty">Not sent yet</div>`}
        <div class="est-rail-actions-minor" style="margin-top:10px">
          <button class="est-link" onclick="_estPortalPreview('${_estEsc(est.id)}')">
            <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M1 8s3-5 7-5 7 5 7 5-3 5-7 5-7-5-7-5z"/><circle cx="8" cy="8" r="2"/></svg>
            Customer preview
          </button>
          ${est.portal_token ? `
          <button class="est-link" onclick="_estCopyPortalLink('${_estEsc(est.portal_token)}')">
            <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M6 9a3 3 0 004.24.35L13 6.59A3 3 0 008.76 2.35L7 4.1"/><path d="M10 7a3 3 0 00-4.24-.35L3 9.41a3 3 0 004.24 4.24L9 12"/></svg>
            Copy portal link
          </button>` : ''}
        </div>
      </div>

      <!-- Financial Summary -->
      <div class="est-rail-card est-rail-card--fin">
        <div class="est-rail-card-title">Financial Summary</div>
        <div class="est-rail-fin-row"><span>Total</span><strong>${_estFmt(total)}</strong></div>
        ${depositAmt > 0 ? `
        <div class="est-rail-fin-row est-rail-fin-deposit">
          <span>Deposit (${est.deposit_pct || 30}%)</span><strong>${_estFmt(depositAmt)}</strong>
        </div>
        <div class="est-rail-fin-row" style="color:var(--gw-text-muted);font-size:12px">
          <span>Balance after deposit</span><span>${_estFmt(total - depositAmt)}</span>
        </div>` : ''}
        ${est.invoice_id ? `<div class="est-rail-tag est-rail-tag--invoiced">Invoiced</div>` : ''}
      </div>

      <!-- Customer Context -->
      <div class="est-rail-card">
        <div class="est-rail-card-title">Customer</div>
        <div class="est-rail-client-row">
          <div class="est-rail-avatar">${_estInitials(est.client_name)}</div>
          <div>
            <div class="est-rail-client-name">${_estEsc(est.client_name || '—')}</div>
            ${est.client_email ? `<div class="est-rail-client-detail">
              <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="1" y="3" width="14" height="10" rx="1.5"/><path d="M1 6l7 4 7-4"/></svg>
              <a class="est-link" onclick="_gwOpenMessageModal({type:'email',to:'${_estEsc(est.client_email)}',subject:'Re: ${_estEsc(est.est_number)} Estimate'})">${_estEsc(est.client_email)}</a>
            </div>` : ''}
            ${est.client_phone ? `<div class="est-rail-client-detail">
              <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M13 11l-2 2a12 12 0 01-8-8l2-2-2-4 4-1 2 3-2 2a9 9 0 004 4l2-2 3 2-1 4z"/></svg>
              <a class="est-link" onclick="_gwOpenMessageModal({type:'sms',to:'${_estEsc(est.client_phone)}'})">${_estEsc(est.client_phone)}</a>
            </div>` : ''}
          </div>
        </div>
        ${est.property_addr ? `
        <div class="est-rail-prop">
          <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M8 2l6 5v7H2V7l6-5z"/></svg>
          ${_estEsc(est.property_addr)}
        </div>` : ''}
        ${est.client_id ? `
        <div style="margin-top:8px">
          <button class="est-link" onclick="show('customerDetail','${_estEsc(est.client_id)}')">View customer record →</button>
        </div>` : ''}
      </div>

      <!-- Quick Status Overrides (internal use) -->
      ${(est.status === 'sent' || est.status === 'viewed') ? `
      <div class="est-rail-card">
        <div class="est-rail-card-title">Mark Result</div>
        <div class="est-rail-status-btns">
          <button class="est-rail-status-btn est-rail-status-btn--accept" onclick="_estAcceptInternal('${_estEsc(est.id)}')">${gwIcon('status-accepted',14)} Mark Accepted</button>
          <button class="est-rail-status-btn est-rail-status-btn--decline" onclick="_estDeclineModal('${_estEsc(est.id)}')">${gwIcon('status-declined',14)} Mark Declined</button>
        </div>
      </div>` : ''}

    </aside>
  </div>`;

  // Sticky scroll behavior
  setTimeout(() => {
    const actionsEl = view.querySelector('.est-detail-actions');
    if (!actionsEl) return;
    const threshold = actionsEl.offsetTop - 60;
    window.addEventListener('scroll', function _estScroll() {
      if (!document.getElementById('view')?.querySelector('.est-detail-actions')) {
        window.removeEventListener('scroll', _estScroll);
        return;
      }
      actionsEl.classList.toggle('est-detail-actions--sticky', window.scrollY > threshold);
    }, { passive: true });
  }, 100);
}

function _estBuildEngagementTimeline(est) {
  const items = [];
  if (est.accepted_at) items.push(`<div class="est-eng-event est-eng-event--accepted"><span class="est-eng-dot"></span><div><strong>Accepted</strong><div class="est-eng-time">${_estRelDate(est.accepted_at)}</div></div></div>`);
  if (est.declined_at) items.push(`<div class="est-eng-event est-eng-event--declined"><span class="est-eng-dot"></span><div><strong>Declined</strong><div class="est-eng-time">${_estRelDate(est.declined_at)}</div></div></div>`);
  if (est.changes_at)  items.push(`<div class="est-eng-event est-eng-event--changes"><span class="est-eng-dot"></span><div><strong>Changes Requested</strong><div class="est-eng-time">${_estRelDate(est.changes_at)}</div></div></div>`);
  if (est.viewed_at)   items.push(`<div class="est-eng-event est-eng-event--viewed"><span class="est-eng-dot"></span><div><strong>Viewed by customer</strong><div class="est-eng-time">${_estRelDate(est.viewed_at)}</div></div></div>`);
  if (est.sent_at)     items.push(`<div class="est-eng-event est-eng-event--sent"><span class="est-eng-dot"></span><div><strong>Sent</strong> ${est.send_method ? `via ${est.send_method}` : ''}<div class="est-eng-time">${_estRelDate(est.sent_at)}</div></div></div>`);
  if (est.created_at)  items.push(`<div class="est-eng-event"><span class="est-eng-dot est-eng-dot--muted"></span><div><strong>Created</strong><div class="est-eng-time">${_estRelDate(est.created_at)}</div></div></div>`);
  return items;
}

function _estIsExpired(dateStr) {
  if (!dateStr) return false;
  return new Date(dateStr + 'T23:59:59') < new Date();
}

function _estAttachmentCard(a) {
  const name = a.name || 'Attachment';
  const isImg = /\.(jpg|jpeg|png|gif|webp|svg)$/i.test(name) || (a.type||'').startsWith('image/');
  return `
  <div class="est-attachment-card">
    ${isImg && a.url ? `
    <div class="est-attachment-thumb" style="background-image:url(${_estEsc(a.url)})"></div>` : `
    <div class="est-attachment-icon">
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
    </div>`}
    <div class="est-attachment-name">${_estEsc(name)}</div>
    ${a.url ? `<a class="est-attachment-open" href="${_estEsc(a.url)}" target="_blank" rel="noopener">Open</a>` : ''}
  </div>`;
}

function _estDetailMoreMenu(btn, id, status) {
  document.querySelectorAll('.est-more-menu').forEach(m => m.remove());
  const menu = document.createElement('div');
  menu.className = 'est-more-menu est-more-menu--inline';
  const actions = [`<button onclick="_estDuplicate('${id}');_estCloseMenu()">Duplicate</button>`];
  if (status !== 'invoiced') actions.push(`<button onclick="_estConvertToInvoice('${id}');_estCloseMenu()">Convert to Invoice</button>`);
  actions.push(`<button class="est-more-menu--danger" onclick="_estDeleteConfirm('${id}')">Delete</button>`);
  menu.innerHTML = actions.join('');
  btn.closest('.est-more-wrap-inline').appendChild(menu);
  setTimeout(() => document.addEventListener('click', _estCloseMenu, { once: true }), 50);
}

// ── ESTIMATE BUILDER ──────────────────────────────────────────────────────────

async function estimateBuilder(id) {
  const view = document.getElementById('view');
  if (!view) return;

  view.innerHTML = `
  <div class="est-builder-shell" id="est-builder-shell">
    <div class="est-builder-main">
      <div class="est-builder-loading"><div class="est-spinner"></div><span>Loading builder…</span></div>
    </div>
    <div class="est-builder-rail" id="est-builder-rail">
      <div class="est-rail-card"><div class="est-detail-skeleton-bar" style="height:200px"></div></div>
    </div>
  </div>`;

  let est = null;
  if (id) {
    try {
      const r = await fetch(`/api/estimates/${id}`, { credentials: 'include' });
      if (r.ok) {
        const { data } = await r.json();
        est = _estNormalize(data);
      }
    } catch (e) { console.warn('[estimateBuilder] fetch error', e); }
  }

  // Initialize draft
  _estDraft = est ? { ...est } : {
    id: null,
    est_number: '',
    title: '',
    client_id: '', client_name: '', client_email: '', client_phone: '', client_address: '',
    property_id: '', property_addr: '',
    opp_id: '',
    assigned_to: '', rep_id: '',
    status: 'draft',
    estimate_date: new Date().toISOString().slice(0, 10),
    expiry_date: '',
    scope_of_work: '',
    line_items: [],
    subtotal: 0, discount_pct: 0, discount_amt: 0,
    tax_pct: 0, tax_amt: 0, total: 0,
    deposit_pct: 30, deposit_amt: 0,
    payment_schedule: [],
    attachments: [],
    customer_notes: '', internal_notes: '', terms: '',
  };
  if (!Array.isArray(_estDraft.payment_schedule)) _estDraft.payment_schedule = [];

  _estRenderBuilder();
}

// ── CREATE ESTIMATE DIRECTLY FROM A LEAD ─────────────────────────────────────
// Called from the lead Quick Actions bar. Prefills client/contact/property and
// links the estimate back to the opportunity via opp_id.
async function estimateBuilderForLead(oppId) {
  const opps = (window._avalonState && window._avalonState.opportunities) ||
               (typeof state !== 'undefined' && state.opportunities) || [];
  const o = opps.find(x => x.id === oppId);

  // Navigate to the estimates area so back-buttons behave, then open builder
  await estimateBuilder(); // initializes a fresh _estDraft (no fetch when no id)

  if (o && _estDraft) {
    _estDraft.opp_id       = o.id;
    _estDraft.client_id    = o.clientId || '';
    _estDraft.client_name  = o.client || '';
    _estDraft.client_email = o.email || '';
    _estDraft.client_phone = o.phone || '';
    _estDraft.client_address = o.address || '';
    _estDraft.property_addr  = o.address || '';
    _estDraft.title = o.project || o.serviceLine || (o.client ? `Estimate for ${o.client}` : '');
    if (o.repId) _estDraft.assigned_to = o.repId;
    _estRenderBuilder();
    if (typeof showToast === 'function') showToast(`New estimate started for ${o.client || 'lead'} — linked to this lead`, 'success');
  } else if (!o) {
    if (typeof showToast === 'function') showToast('Lead not found — starting a blank estimate', 'info');
  }
}

function _estRenderBuilder() {
  const view = document.getElementById('view');
  if (!view) return;
  const est = _estDraft;
  const isEdit = !!(est && est.id);
  const sc = _estStatusConfig(est.status);
  const repOptions = (window.REPS || []).filter(r => !['field','tech'].includes(r.role))
    .map(r => `<option value="${_estEsc(r.id)}" ${est.assigned_to === r.id || est.rep_id === r.id ? 'selected' : ''}>${_estEsc(r.name)}</option>`).join('');

  view.innerHTML = `
  <div class="est-builder-shell" id="est-builder-shell">

    <!-- Builder Main Canvas -->
    <div class="est-builder-main">

      <!-- Top Nav -->
      <div class="est-builder-topnav">
        <button class="est-back-btn" onclick="${isEdit ? `estimateDetail('${_estEsc(est.id)}')` : 'estimates()'}">
          <svg width="13" height="13" viewBox="0 0 14 14" fill="none"><path d="M9 11L4 7l5-4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>
          ${isEdit ? 'Detail' : 'Estimates'}
        </button>
        <div class="est-builder-topnav-title">
          ${isEdit ? `Edit ${_estEsc(est.est_number || 'Estimate')}` : 'New Estimate'}
        </div>
        <div class="est-builder-save-state" id="est-save-state"></div>
      </div>

      <!-- Section: Customer & Property -->
      <section class="est-builder-section" id="est-section-customer">
        <h3 class="est-builder-section-title">
          <span class="est-builder-section-num">1</span>
          Customer &amp; Property
        </h3>
        <div class="est-builder-customer-grid">
          <div class="est-builder-field-group">
            <label class="est-label">Customer <span class="est-required">*</span></label>
            <div class="est-customer-selector" id="est-customer-selector">
              ${est.client_name ? `
              <div class="est-customer-selected">
                <div class="est-customer-avatar">${_estInitials(est.client_name)}</div>
                <div class="est-customer-info">
                  <div class="est-customer-name">${_estEsc(est.client_name)}</div>
                  ${est.client_email ? `<div class="est-customer-detail">${_estEsc(est.client_email)}</div>` : ''}
                  ${est.client_phone ? `<div class="est-customer-detail">${_estEsc(est.client_phone)}</div>` : ''}
                </div>
                <button class="est-customer-change" onclick="_estClearCustomer()">Change</button>
              </div>` : `
              <div class="est-customer-search-wrap">
                <svg class="est-search-icon" width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="7" cy="7" r="5"/><path d="M14 14l-3.5-3.5"/></svg>
                <input id="est-client-search" class="est-customer-search-input" type="text" placeholder="Search customer…" oninput="_estClientSearch(this.value)">
              </div>
              <div id="est-client-results" class="est-client-results"></div>`}
            </div>
            <input type="hidden" id="est-client-id" value="${_estEsc(est.client_id)}">
            <input type="hidden" id="est-client-name" value="${_estEsc(est.client_name)}">
            <input type="hidden" id="est-client-email" value="${_estEsc(est.client_email)}">
            <input type="hidden" id="est-client-phone" value="${_estEsc(est.client_phone)}">
            <input type="hidden" id="est-client-address" value="${_estEsc(est.client_address)}">
          </div>
          <div class="est-builder-field-group">
            <label class="est-label">Property Address</label>
            <textarea id="est-property-addr" class="est-input est-textarea--sm" rows="3" placeholder="Property or service address…" oninput="_estDraftField('property_addr',this.value)">${_estEsc(est.property_addr)}</textarea>
          </div>
        </div>
      </section>

      <!-- Section: Estimate Details -->
      <section class="est-builder-section">
        <h3 class="est-builder-section-title">
          <span class="est-builder-section-num">2</span>
          Estimate Details
        </h3>
        <div class="est-builder-meta-grid">
          <div class="est-builder-field-group est-builder-field-group--wide">
            <label class="est-label">Estimate Title</label>
            <input id="est-title" class="est-input" type="text" placeholder="e.g. Full Sprinkler System Installation" value="${_estEsc(est.title)}" oninput="_estDraftField('title',this.value)">
          </div>
          <div class="est-builder-field-group">
            <label class="est-label">Estimate Date</label>
            <input id="est-estimate-date" class="est-input" type="date" value="${_estEsc(est.estimate_date)}" oninput="_estDraftField('estimate_date',this.value)">
          </div>
          <div class="est-builder-field-group">
            <label class="est-label">Expiry Date <span style="color:var(--gw-text-muted);font-weight:400">(optional)</span></label>
            <input id="est-expiry-date" class="est-input" type="date" value="${_estEsc(est.expiry_date)}" oninput="_estDraftField('expiry_date',this.value)">
          </div>
          <div class="est-builder-field-group">
            <label class="est-label">Assigned Rep</label>
            <select id="est-assigned-to" class="est-input" onchange="_estDraftField('assigned_to',this.value)">
              <option value="">Unassigned</option>
              ${repOptions}
            </select>
          </div>
          <div class="est-builder-field-group">
            <label class="est-label">Status</label>
            <select id="est-status" class="est-input" onchange="_estDraftField('status',this.value)">
              <option value="draft" ${est.status==='draft'?'selected':''}>Draft</option>
              <option value="sent" ${est.status==='sent'?'selected':''}>Sent</option>
              <option value="accepted" ${est.status==='accepted'?'selected':''}>Accepted</option>
              <option value="declined" ${est.status==='declined'?'selected':''}>Declined</option>
            </select>
          </div>
        </div>
      </section>

      <!-- Section: Scope of Work -->
      <section class="est-builder-section">
        <h3 class="est-builder-section-title">
          <span class="est-builder-section-num">3</span>
          Scope of Work
        </h3>
        <p class="est-builder-section-hint">Describe the full scope of work, project phases, and what's included. This appears prominently on the customer estimate.</p>
        <textarea id="est-scope" class="est-input est-scope-textarea" rows="8" placeholder="Describe the work in detail…&#10;&#10;Example:&#10;• Site preparation and layout&#10;• Installation of mainline and lateral pipes&#10;• Controller programming and testing&#10;• Final walkthrough and documentation" oninput="_estDraftField('scope_of_work',this.value)">${_estEsc(est.scope_of_work)}</textarea>
      </section>

      <!-- Section: Line Items -->
      <section class="est-builder-section">
        <h3 class="est-builder-section-title">
          <span class="est-builder-section-num">4</span>
          Line Items
        </h3>
        <div class="est-line-editor" id="est-line-editor">
          <div class="est-line-editor-header">
            <div class="est-line-col est-line-col--handle"></div>
            <div class="est-line-col est-line-col--desc">Item / Description</div>
            <div class="est-line-col est-line-col--qty">Qty</div>
            <div class="est-line-col est-line-col--rate">Rate</div>
            <div class="est-line-col est-line-col--total">Total</div>
            <div class="est-line-col est-line-col--del"></div>
          </div>
          <div id="est-line-rows"></div>
        </div>
        <button class="est-add-line-btn" onclick="_estAddLine()">
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="8" y1="2" x2="8" y2="14"/><line x1="2" y1="8" x2="14" y2="8"/></svg>
          Add line item
        </button>
      </section>

      <!-- Section: Pricing Config -->
      <section class="est-builder-section">
        <h3 class="est-builder-section-title">
          <span class="est-builder-section-num">5</span>
          Pricing &amp; Deposit
        </h3>
        <div class="est-pricing-grid">
          <div class="est-builder-field-group">
            <label class="est-label">Discount (%)</label>
            <input id="est-discount-pct" class="est-input" type="number" min="0" max="100" step="0.1" value="${est.discount_pct || 0}" oninput="_estDraftField('discount_pct',parseFloat(this.value)||0);_estCalcTotals()">
          </div>
          <div class="est-builder-field-group">
            <label class="est-label">Tax Rate (%)</label>
            <input id="est-tax-pct" class="est-input" type="number" min="0" max="100" step="0.01" value="${est.tax_pct || 0}" oninput="_estDraftField('tax_pct',parseFloat(this.value)||0);_estCalcTotals()">
          </div>
          <div class="est-builder-field-group">
            <label class="est-label">Deposit Required (%)</label>
            <input id="est-deposit-pct" class="est-input" type="number" min="0" max="100" step="1" value="${est.deposit_pct || 30}" oninput="_estDraftField('deposit_pct',parseFloat(this.value)||30);_estCalcTotals()">
          </div>
        </div>

        <!-- Custom Payment Schedule -->
        <div class="est-payment-schedule" id="est-payment-schedule" style="margin-top:18px;padding-top:16px;border-top:1px dashed var(--gw-border,#E4E0D6)">
          ${_estPaySchedHtml()}
        </div>
      </section>

      <!-- Section: Attachments -->
      <section class="est-builder-section">
        <h3 class="est-builder-section-title">
          <span class="est-builder-section-num">6</span>
          Photos &amp; Documents
        </h3>
        <p class="est-builder-section-hint">Upload site photos, plans, reference images, or documents. These appear in the customer estimate.</p>
        <div class="est-upload-zone" id="est-upload-zone" onclick="document.getElementById('est-file-input').click()" ondragover="event.preventDefault();this.classList.add('est-upload-zone--drag')" ondragleave="this.classList.remove('est-upload-zone--drag')" ondrop="_estHandleDrop(event)">
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
          <div class="est-upload-text">Drop files here or <span class="est-upload-link">browse</span></div>
          <div class="est-upload-hint">Images, PDFs, documents up to 25MB</div>
          <input type="file" id="est-file-input" style="display:none" multiple accept="image/*,.pdf,.doc,.docx,.xls,.xlsx" onchange="_estHandleFiles(this.files)">
        </div>
        <div class="est-attachment-list" id="est-attachment-list"></div>
      </section>

      <!-- Section: Notes & Terms -->
      <section class="est-builder-section">
        <h3 class="est-builder-section-title">
          <span class="est-builder-section-num">7</span>
          Notes &amp; Terms
        </h3>
        <div class="est-notes-grid">
          <div class="est-builder-field-group">
            <label class="est-label">Notes for Customer</label>
            <p class="est-field-hint">Visible to customer on the estimate</p>
            <textarea id="est-customer-notes" class="est-input est-textarea--md" rows="5" placeholder="Payment terms, special instructions, what to expect…" oninput="_estDraftField('customer_notes',this.value)">${_estEsc(est.customer_notes)}</textarea>
          </div>
          <div class="est-builder-field-group">
            <label class="est-label">Internal Notes</label>
            <p class="est-field-hint">Only visible to your team</p>
            <textarea id="est-internal-notes" class="est-input est-textarea--md" rows="5" placeholder="Job complexity notes, crew requirements, materials…" oninput="_estDraftField('internal_notes',this.value)">${_estEsc(est.internal_notes)}</textarea>
          </div>
          <div class="est-builder-field-group est-builder-field-group--wide">
            <label class="est-label">Terms &amp; Conditions</label>
            <textarea id="est-terms" class="est-input est-textarea--md" rows="5" placeholder="Standard terms: payment schedule, cancellation policy, warranty…" oninput="_estDraftField('terms',this.value)">${_estEsc(est.terms)}</textarea>
          </div>
        </div>
      </section>

      <!-- Bottom Action Bar -->
      <div class="est-builder-footer">
        <button class="est-btn-ghost" onclick="${isEdit ? `estimateDetail('${_estEsc(est.id)}')` : 'estimates()'}">Cancel</button>
        <div class="est-builder-footer-right">
          <button class="est-btn-secondary" onclick="_estSaveBuilder('draft')">Save Draft</button>
          <button class="est-btn-secondary" onclick="_estPortalPreviewBuilder()">
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M1 8s3-5 7-5 7 5 7 5-3 5-7 5-7-5-7-5z"/><circle cx="8" cy="8" r="2"/></svg>
            Preview
          </button>
          <button class="est-btn-primary" onclick="_estSaveBuilder('save')">
            ${isEdit ? 'Update Estimate' : 'Create Estimate'}
          </button>
        </div>
      </div>

    </div>

    <!-- Right Rail: Live Summary -->
    <div class="est-builder-rail" id="est-builder-rail">
      <div class="est-rail-card est-rail-card--sticky" id="est-builder-summary">
        <div class="est-rail-card-title">Estimate Summary</div>
        <div id="est-summary-content">
          <!-- Rendered by _estCalcTotals -->
        </div>
        <div class="est-builder-rail-actions">
          <button class="est-btn-primary est-btn-sm" onclick="_estSaveBuilder('save')">${isEdit ? 'Update' : 'Create'}</button>
          <button class="est-btn-secondary est-btn-sm" onclick="_estPortalPreviewBuilder()">Preview</button>
        </div>
      </div>
    </div>

  </div>`;

  // Render initial line items
  _estRenderLineRows();
  _estRenderAttachmentList();
  _estCalcTotals();
}

function _estDraftField(field, value) {
  if (!_estDraft) return;
  _estDraft[field] = value;
}

function _estAddLine() {
  if (!_estDraft) return;
  _estDraft.line_items = _estDraft.line_items || [];
  _estDraft.line_items.push({ id: _estUID(), name: '', desc: '', qty: 1, rate: 0, total: 0 });
  _estRenderLineRows();
  _estCalcTotals();
}

function _estRemoveLine(idx) {
  if (!_estDraft) return;
  _estDraft.line_items.splice(idx, 1);
  _estRenderLineRows();
  _estCalcTotals();
}

function _estUpdateLine(idx, field, value) {
  if (!_estDraft || !_estDraft.line_items[idx]) return;
  _estDraft.line_items[idx][field] = field === 'qty' || field === 'rate' ? (parseFloat(value) || 0) : value;
  _estDraft.line_items[idx].total = (_estDraft.line_items[idx].qty || 1) * (_estDraft.line_items[idx].rate || 0);
  // Update total display in same row
  const totalEl = document.getElementById(`est-li-total-${idx}`);
  if (totalEl) totalEl.textContent = _estFmt(_estDraft.line_items[idx].total);
  _estCalcTotals();
}

function _estRenderLineRows() {
  const container = document.getElementById('est-line-rows');
  if (!container || !_estDraft) return;
  const items = _estDraft.line_items || [];
  if (!items.length) {
    container.innerHTML = `<div class="est-line-empty">No items yet — click "Add line item" below</div>`;
    return;
  }
  container.innerHTML = items.map((li, i) => `
  <div class="est-line-row" data-idx="${i}" id="est-line-row-${i}">
    <div class="est-line-drag-handle" title="Drag to reorder">
      <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor"><rect x="1" y="2" width="10" height="1.5" rx="1"/><rect x="1" y="5.25" width="10" height="1.5" rx="1"/><rect x="1" y="8.5" width="10" height="1.5" rx="1"/></svg>
    </div>
    <div class="est-line-col est-line-col--desc">
      <input class="est-line-input est-line-input--name" type="text" placeholder="Item or service name" value="${_estEsc(li.name || li.description || '')}" oninput="_estUpdateLine(${i},'name',this.value)">
      <input class="est-line-input est-line-input--desc" type="text" placeholder="Description (optional)" value="${_estEsc(li.desc || li.description2 || '')}" oninput="_estUpdateLine(${i},'desc',this.value)">
    </div>
    <div class="est-line-col est-line-col--qty">
      <input class="est-line-input est-line-input--num" type="number" min="0" step="0.1" value="${li.qty || 1}" oninput="_estUpdateLine(${i},'qty',this.value)">
    </div>
    <div class="est-line-col est-line-col--rate">
      <input class="est-line-input est-line-input--num" type="number" min="0" step="0.01" placeholder="0.00" value="${li.rate || li.unit || ''}" oninput="_estUpdateLine(${i},'rate',this.value)">
    </div>
    <div class="est-line-col est-line-col--total" id="est-li-total-${i}">${_estFmt((li.qty || 1) * (li.rate || li.unit || 0))}</div>
    <div class="est-line-col est-line-col--del">
      <button class="est-line-del" onclick="_estRemoveLine(${i})" title="Remove">
        <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><polyline points="3 6 13 6"/><path d="M5 6V4a1 1 0 011-1h4a1 1 0 011 1v2"/><rect x="3" y="6" width="10" height="8" rx="1"/></svg>
      </button>
    </div>
  </div>`).join('');
}

function _estCalcTotals() {
  if (!_estDraft) return;
  const items = _estDraft.line_items || [];
  const subtotal = items.reduce((s, li) => s + Number(li.qty || 1) * Number(li.rate || li.unit || 0), 0);
  const discPct = Number(_estDraft.discount_pct || 0);
  const discAmt = subtotal * (discPct / 100);
  const taxPct  = Number(_estDraft.tax_pct || 0);
  const taxAmt  = (subtotal - discAmt) * (taxPct / 100);
  const total   = subtotal - discAmt + taxAmt;
  const depPct  = Number(_estDraft.deposit_pct || 30);
  const depAmt  = total * (depPct / 100);

  _estDraft.subtotal = subtotal;
  _estDraft.discount_amt = discAmt;
  _estDraft.tax_amt = taxAmt;
  _estDraft.total = total;
  _estDraft.deposit_amt = depAmt;

  const summaryEl = document.getElementById('est-summary-content');
  if (summaryEl) {
    summaryEl.innerHTML = `
      <div class="est-summary-client">
        ${_estDraft.client_name ? `
        <div class="est-summary-client-name">${_estEsc(_estDraft.client_name)}</div>
        ${_estDraft.property_addr ? `<div class="est-summary-client-prop">${_estEsc(_estDraft.property_addr)}</div>` : ''}
        ` : `<div class="est-summary-client-empty">No customer selected</div>`}
      </div>
      <div class="est-summary-divider"></div>
      <div class="est-summary-row"><span>Subtotal</span><span>${_estFmt(subtotal)}</span></div>
      ${discAmt > 0 ? `<div class="est-summary-row est-text-green"><span>Discount (${discPct}%)</span><span>−${_estFmt(discAmt)}</span></div>` : ''}
      ${taxAmt > 0 ? `<div class="est-summary-row"><span>Tax (${taxPct}%)</span><span>${_estFmt(taxAmt)}</span></div>` : ''}
      <div class="est-summary-total"><span>Total</span><span>${_estFmt(total)}</span></div>
      ${depAmt > 0 ? `
      <div class="est-summary-deposit">
        <div class="est-summary-deposit-label">Deposit required (${depPct}%)</div>
        <div class="est-summary-deposit-amount">${_estFmt(depAmt)}</div>
      </div>` : ''}
      <div class="est-summary-items-count">${items.length} line item${items.length !== 1 ? 's' : ''}</div>`;
  }

  // Keep payment-schedule dollar amounts in sync with the new total
  if (Array.isArray(_estDraft.payment_schedule) && _estDraft.payment_schedule.length) {
    const active = document.activeElement;
    const inSched = active && active.closest && active.closest('#est-payment-schedule');
    if (!inSched) _estPaySchedRefresh();
  }
}

// Client search for builder
let _estClientSearchTimer = null;
function _estClientSearch(q) {
  clearTimeout(_estClientSearchTimer);
  _estClientSearchTimer = setTimeout(async () => {
    const resultsEl = document.getElementById('est-client-results');
    if (!resultsEl) return;
    if (!q.trim()) { resultsEl.innerHTML = ''; return; }
    try {
      const clients = (state.clients || []).filter(c => {
        const name = (c.name || c.firstName + ' ' + c.lastName || '').toLowerCase();
        return name.includes(q.toLowerCase()) || (c.email||'').toLowerCase().includes(q.toLowerCase());
      }).slice(0, 8);
      resultsEl.innerHTML = clients.length
        ? clients.map(c => `
          <div class="est-client-result" onclick="_estSelectClient(${JSON.stringify(_estEsc(c.id||c.clientId||''))},${JSON.stringify(_estEsc(c.name||(c.firstName+' '+c.lastName)||''))},${JSON.stringify(_estEsc(c.email||''))},${JSON.stringify(_estEsc(c.phone||''))},${JSON.stringify(_estEsc(c.address||c.street||''))})">
            <div class="est-client-result-avatar">${_estInitials(c.name||(c.firstName+' '+c.lastName))}</div>
            <div>
              <div class="est-client-result-name">${_estEsc(c.name||(c.firstName+' '+c.lastName)||'—')}</div>
              ${c.email ? `<div class="est-client-result-sub">${_estEsc(c.email)}</div>` : ''}
            </div>
          </div>`).join('')
        : `<div class="est-client-result-empty">No matches. <button class="est-link" onclick="_estManualCustomer()">Enter manually</button></div>`;
    } catch(e) {
      resultsEl.innerHTML = `<div class="est-client-result-empty">Search error</div>`;
    }
  }, 200);
}

function _estSelectClient(id, name, email, phone, address) {
  if (!_estDraft) return;
  _estDraft.client_id = id;
  _estDraft.client_name = name;
  _estDraft.client_email = email;
  _estDraft.client_phone = phone;
  _estDraft.client_address = address;
  // Re-render customer block
  const sel = document.getElementById('est-customer-selector');
  if (sel) {
    sel.innerHTML = `
    <div class="est-customer-selected">
      <div class="est-customer-avatar">${_estInitials(name)}</div>
      <div class="est-customer-info">
        <div class="est-customer-name">${_estEsc(name)}</div>
        ${email ? `<div class="est-customer-detail">${_estEsc(email)}</div>` : ''}
        ${phone ? `<div class="est-customer-detail">${_estEsc(phone)}</div>` : ''}
      </div>
      <button class="est-customer-change" onclick="_estClearCustomer()">Change</button>
    </div>`;
  }
  _estCalcTotals();
}

function _estClearCustomer() {
  if (!_estDraft) return;
  _estDraft.client_id = ''; _estDraft.client_name = '';
  _estDraft.client_email = ''; _estDraft.client_phone = '';
  const sel = document.getElementById('est-customer-selector');
  if (sel) sel.innerHTML = `
    <div class="est-customer-search-wrap">
      <svg class="est-search-icon" width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="7" cy="7" r="5"/><path d="M14 14l-3.5-3.5"/></svg>
      <input id="est-client-search" class="est-customer-search-input" type="text" placeholder="Search customer…" oninput="_estClientSearch(this.value)">
    </div>
    <div id="est-client-results" class="est-client-results"></div>`;
  _estCalcTotals();
}

function _estManualCustomer() {
  const name = prompt('Customer name:');
  if (!name) return;
  const email = prompt('Email (optional):') || '';
  const phone = prompt('Phone (optional):') || '';
  _estSelectClient('', name, email, phone, '');
}

// Attachments
function _estHandleFiles(files) {
  if (!_estDraft || !files.length) return;
  Array.from(files).forEach(file => {
    const attachment = {
      id: _estUID(),
      name: file.name,
      type: file.type,
      size: file.size,
      url: '',  // Would be uploaded in production
      localUrl: URL.createObjectURL(file),
    };
    _estDraft.attachments = _estDraft.attachments || [];
    _estDraft.attachments.push(attachment);
    showToast(`${file.name} added`, 'success');
  });
  _estRenderAttachmentList();
}

function _estHandleDrop(e) {
  e.preventDefault();
  e.currentTarget.classList.remove('est-upload-zone--drag');
  if (e.dataTransfer?.files) _estHandleFiles(e.dataTransfer.files);
}

function _estRemoveAttachment(id) {
  if (!_estDraft) return;
  _estDraft.attachments = (_estDraft.attachments || []).filter(a => a.id !== id);
  _estRenderAttachmentList();
}

function _estRenderAttachmentList() {
  const list = document.getElementById('est-attachment-list');
  if (!list || !_estDraft) return;
  const attachments = _estDraft.attachments || [];
  if (!attachments.length) { list.innerHTML = ''; return; }
  list.innerHTML = `<div class="est-attachment-gallery est-attachment-gallery--builder">
    ${attachments.map(a => {
      const isImg = /\.(jpg|jpeg|png|gif|webp|svg)$/i.test(a.name) || (a.type||'').startsWith('image/');
      const previewUrl = a.localUrl || a.url || '';
      return `
      <div class="est-attachment-card est-attachment-card--builder" id="att-${_estEsc(a.id)}">
        ${isImg && previewUrl ? `<div class="est-attachment-thumb" style="background-image:url(${_estEsc(previewUrl)})"></div>`
        : `<div class="est-attachment-icon"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/></svg></div>`}
        <div class="est-attachment-name">${_estEsc(a.name)}</div>
        <button class="est-attachment-remove" onclick="_estRemoveAttachment('${_estEsc(a.id)}')" title="Remove">✕</button>
      </div>`;
    }).join('')}
  </div>`;
}

// Save Builder
// ── CUSTOM PAYMENT SCHEDULE (builder section) ────────────────────────────────
// Lets the rep define any number of payments with a % each; must total 100%.

function _estPaySchedHtml() {
  const sched = (_estDraft && Array.isArray(_estDraft.payment_schedule)) ? _estDraft.payment_schedule : [];
  const total = Number(_estDraft?.total || 0);
  const sum = sched.reduce((s, p) => s + (Number(p.pct) || 0), 0);
  const ok = Math.abs(sum - 100) <= 0.01;
  const sumColor = sched.length === 0 ? 'var(--gw-text-subtle,#8A948C)' : (ok ? '#1E5E3E' : '#B4482E');

  const rows = sched.map((p, i) => {
    const amt = total > 0 ? (total * (Number(p.pct) || 0) / 100) : 0;
    return `
    <div class="est-paysched-row" style="display:flex;gap:8px;align-items:center;margin-bottom:8px">
      <input class="est-input" type="text" placeholder="Payment ${i + 1} label (e.g. Deposit, At start, On completion)" value="${_estEsc(p.label || '')}" style="flex:1" oninput="_estPaySchedField(${i},'label',this.value)">
      <div style="position:relative;width:104px;flex:none">
        <input class="est-input" type="number" min="0" max="100" step="0.1" value="${p.pct != null ? p.pct : ''}" placeholder="%" style="width:100%;padding-right:26px" oninput="_estPaySchedField(${i},'pct',parseFloat(this.value)||0)">
        <span style="position:absolute;right:10px;top:50%;transform:translateY(-50%);font-size:12px;color:var(--gw-text-subtle,#8A948C);pointer-events:none">%</span>
      </div>
      <span style="width:92px;flex:none;text-align:right;font-size:12.5px;color:var(--gw-text-subtle,#6F7E6A);font-variant-numeric:tabular-nums">${total > 0 ? _estFmt(amt) : '—'}</span>
      <button type="button" title="Remove payment" style="border:none;background:transparent;color:#B4482E;cursor:pointer;font-size:16px;line-height:1;padding:4px" onclick="_estPaySchedRemove(${i})">×</button>
    </div>`;
  }).join('');

  return `
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">
      <div>
        <div style="font-size:13px;font-weight:700;color:var(--gw-text,#1F2A2B)">Custom Payment Schedule <span style="font-weight:500;color:var(--gw-text-subtle,#8A948C)">(optional)</span></div>
        <div style="font-size:11.5px;color:var(--gw-text-subtle,#8A948C)">Split the total into any number of payments — percentages must add up to 100%.</div>
      </div>
      <span id="est-paysched-sum" style="font-size:12.5px;font-weight:800;color:${sumColor};white-space:nowrap;font-variant-numeric:tabular-nums">${sched.length ? sum.toFixed(sum % 1 ? 1 : 0) + '% / 100%' + (ok ? ' ✓' : '') : 'No custom schedule'}</span>
    </div>
    ${rows}
    <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
      <button type="button" class="est-btn-secondary" style="font-size:12.5px;padding:7px 12px" onclick="_estPaySchedAdd()">+ Add payment</button>
      ${sched.length === 0 ? `
        <button type="button" style="border:1px dashed var(--gw-border,#CFC9BC);background:transparent;border-radius:8px;font-size:12px;padding:7px 12px;cursor:pointer;color:var(--gw-text-subtle,#5A675F)" onclick="_estPaySchedPreset([['Deposit',50],['On completion',50]])">50 / 50</button>
        <button type="button" style="border:1px dashed var(--gw-border,#CFC9BC);background:transparent;border-radius:8px;font-size:12px;padding:7px 12px;cursor:pointer;color:var(--gw-text-subtle,#5A675F)" onclick="_estPaySchedPreset([['Deposit',34],['Mid-project',33],['On completion',33]])">Thirds</button>
        <button type="button" style="border:1px dashed var(--gw-border,#CFC9BC);background:transparent;border-radius:8px;font-size:12px;padding:7px 12px;cursor:pointer;color:var(--gw-text-subtle,#5A675F)" onclick="_estPaySchedPreset([['Deposit',30],['On completion',70]])">30 / 70</button>` : `
        <button type="button" style="border:none;background:transparent;font-size:12px;cursor:pointer;color:#B4482E;text-decoration:underline" onclick="_estPaySchedClear()">Clear schedule</button>
        ${!ok ? `<span style="font-size:11.5px;color:#B4482E">Must total 100% before it can be saved.</span>` : ''}`}
    </div>`;
}

function _estPaySchedRefresh() {
  const wrap = document.getElementById('est-payment-schedule');
  if (wrap) wrap.innerHTML = _estPaySchedHtml();
}

function _estPaySchedField(i, key, val) {
  if (!_estDraft || !Array.isArray(_estDraft.payment_schedule) || !_estDraft.payment_schedule[i]) return;
  _estDraft.payment_schedule[i][key] = val;
  if (key === 'pct') {
    // Live-update only the sum badge + amounts so typing isn't interrupted
    const sched = _estDraft.payment_schedule;
    const sum = sched.reduce((s, p) => s + (Number(p.pct) || 0), 0);
    const ok = Math.abs(sum - 100) <= 0.01;
    const badge = document.getElementById('est-paysched-sum');
    if (badge) {
      badge.textContent = sum.toFixed(sum % 1 ? 1 : 0) + '% / 100%' + (ok ? ' ✓' : '');
      badge.style.color = ok ? '#1E5E3E' : '#B4482E';
    }
  }
}

function _estPaySchedAdd() {
  if (!_estDraft) return;
  if (!Array.isArray(_estDraft.payment_schedule)) _estDraft.payment_schedule = [];
  const sched = _estDraft.payment_schedule;
  const sum = sched.reduce((s, p) => s + (Number(p.pct) || 0), 0);
  sched.push({ label: '', pct: Math.max(0, Math.round((100 - sum) * 10) / 10) });
  _estPaySchedRefresh();
}

function _estPaySchedRemove(i) {
  if (!_estDraft || !Array.isArray(_estDraft.payment_schedule)) return;
  _estDraft.payment_schedule.splice(i, 1);
  _estPaySchedRefresh();
}

function _estPaySchedPreset(pairs) {
  if (!_estDraft) return;
  _estDraft.payment_schedule = pairs.map(([label, pct]) => ({ label, pct }));
  _estPaySchedRefresh();
}

function _estPaySchedClear() {
  if (!_estDraft) return;
  _estDraft.payment_schedule = [];
  _estPaySchedRefresh();
}

async function _estSaveBuilder(action) {
  if (!_estDraft) return;

  // Enforce payment-schedule 100% rule before saving
  const _sched = Array.isArray(_estDraft.payment_schedule) ? _estDraft.payment_schedule.filter(p => (p.label || '').trim() || Number(p.pct)) : [];
  if (_sched.length) {
    const _sum = _sched.reduce((s, p) => s + (Number(p.pct) || 0), 0);
    if (Math.abs(_sum - 100) > 0.01) {
      showToast(`Payment schedule must total 100% (currently ${_sum.toFixed(1)}%)`, 'error');
      const wrap = document.getElementById('est-payment-schedule');
      if (wrap) wrap.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }
  }
  _estDraft.payment_schedule = _sched;

  const saveState = document.getElementById('est-save-state');
  if (saveState) saveState.textContent = 'Saving…';

  // Collect any un-bound fields
  _estDraft.title         = document.getElementById('est-title')?.value || _estDraft.title;
  _estDraft.scope_of_work = document.getElementById('est-scope')?.value || _estDraft.scope_of_work;
  _estDraft.estimate_date = document.getElementById('est-estimate-date')?.value || _estDraft.estimate_date;
  _estDraft.expiry_date   = document.getElementById('est-expiry-date')?.value || _estDraft.expiry_date;
  _estDraft.assigned_to   = document.getElementById('est-assigned-to')?.value || _estDraft.assigned_to;
  _estDraft.status        = document.getElementById('est-status')?.value || _estDraft.status;
  _estDraft.customer_notes  = document.getElementById('est-customer-notes')?.value || _estDraft.customer_notes;
  _estDraft.internal_notes  = document.getElementById('est-internal-notes')?.value || _estDraft.internal_notes;
  _estDraft.terms           = document.getElementById('est-terms')?.value || _estDraft.terms;
  _estDraft.property_addr   = document.getElementById('est-property-addr')?.value || _estDraft.property_addr;

  _estCalcTotals();

  const isEdit = !!_estDraft.id;
  const method = isEdit ? 'PUT' : 'POST';
  const url    = isEdit ? `/api/estimates/${_estDraft.id}` : '/api/estimates';

  try {
    const r = await fetch(url, {
      method,
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(_estDraft),
    });
    if (!r.ok) throw new Error('Save failed');
    const { data } = await r.json();

    if (!isEdit && data?.id) {
      _estDraft.id = data.id;
      _estDraft.est_number = data.est_number;
      _estDraft.portal_token = data.portal_token;
    }

    // Persist the custom payment schedule via its dedicated endpoint
    if (_estDraft.id) {
      try {
        await fetch(`/api/estimates/${_estDraft.id}/payment-schedule`, {
          method: 'PUT',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ payment_schedule: _estDraft.payment_schedule || [] }),
        });
      } catch (e) { console.warn('[payment-schedule save]', e); }
    }

    if (saveState) saveState.textContent = 'Saved ✓';
    setTimeout(() => { if (saveState) saveState.textContent = ''; }, 3000);

    showToast(isEdit ? 'Estimate updated' : 'Estimate created', 'success');

    if (action === 'save' && _estDraft.id) {
      estimateDetail(_estDraft.id);
    }
  } catch (e) {
    console.error('[_estSaveBuilder]', e);
    if (saveState) saveState.textContent = 'Save failed';
    showToast('Failed to save estimate', 'error');
  }
}

function _estPortalPreviewBuilder() {
  // Save draft first then preview
  _estSaveBuilder('draft').then(() => {
    if (_estDraft?.id) _estPortalPreview(_estDraft.id);
  });
}

// ── SEND MODAL ────────────────────────────────────────────────────────────────

function _estSendModal(estId, clientEmail, clientName) {
  // Close any existing
  document.getElementById('est-send-modal')?.remove();
  const modal = document.createElement('div');
  modal.id = 'est-send-modal';
  modal.className = 'est-modal-overlay';
  modal.innerHTML = `
  <div class="est-modal-panel">
    <div class="est-modal-header">
      <div class="est-modal-title">Send Estimate</div>
      <button class="est-modal-close" onclick="document.getElementById('est-send-modal').remove()">✕</button>
    </div>
    <div class="est-modal-body">
      <div class="est-modal-field">
        <label class="est-label">Send to</label>
        <input id="est-send-to" class="est-input" type="email" value="${_estEsc(clientEmail)}" placeholder="customer@email.com">
      </div>
      <div class="est-modal-field">
        <label class="est-label">Subject</label>
        <input id="est-send-subject" class="est-input" type="text" value="Your Groundwork Estimate is ready to review">
      </div>
      <div class="est-modal-field">
        <label class="est-label">Message</label>
        <textarea id="est-send-message" class="est-input est-textarea--md" rows="5">Hi ${_estEsc(clientName || 'there')},\n\nYour estimate is ready for review. Please click the link below to view, accept, or request changes.\n\nThank you for choosing Groundwork!</textarea>
      </div>
      <div class="est-modal-field est-send-method-row">
        <label class="est-label">Also send via SMS</label>
        <label class="est-toggle"><input type="checkbox" id="est-send-sms"><span class="est-toggle-track"></span></label>
      </div>
    </div>
    <div class="est-modal-footer">
      <button class="est-btn-ghost" onclick="document.getElementById('est-send-modal').remove()">Cancel</button>
      <button class="est-btn-primary" onclick="_estDoSend('${_estEsc(estId)}')">
        <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><rect x="1" y="3" width="14" height="10" rx="1.5"/><path d="M1 6l7 4 7-4"/></svg>
        Send Estimate
      </button>
    </div>
  </div>`;
  modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });
  document.body.appendChild(modal);
}

async function _estDoSend(estId) {
  const to      = document.getElementById('est-send-to')?.value?.trim();
  const message = document.getElementById('est-send-message')?.value?.trim();
  const sendSms = document.getElementById('est-send-sms')?.checked;

  if (!to) { showToast('Please enter recipient email', 'error'); return; }

  try {
    // If Gmail connected, send via Gmail
    if (typeof gmailSendEmail === 'function' && typeof isGoogleConnected === 'function' && isGoogleConnected()) {
      const subject = document.getElementById('est-send-subject')?.value || 'Your Estimate is ready';
      await gmailSendEmail(to, subject, message);
    }

    await fetch(`/api/estimates/${estId}/send`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ method: sendSms ? 'both' : 'email' }),
    });

    document.getElementById('est-send-modal')?.remove();
    showToast('Estimate sent successfully', 'success');
    // Refresh current view
    setTimeout(() => estimateDetail(estId), 300);
  } catch (e) {
    showToast('Failed to send estimate', 'error');
  }
}

// ── PORTAL PREVIEW ────────────────────────────────────────────────────────────

async function _estPortalPreview(estId) {
  // Remove existing
  document.getElementById('est-portal-modal')?.remove();

  const modal = document.createElement('div');
  modal.id = 'est-portal-modal';
  modal.className = 'est-portal-overlay';
  modal.innerHTML = `
  <div class="est-portal-shell">
    <div class="est-portal-topbar">
      <div class="est-portal-topbar-left">
        <div class="est-portal-brand" id="est-portal-brand-name">…</div>
        <span class="est-portal-preview-tag">Preview Mode</span>
      </div>
      <button class="est-portal-close-btn" onclick="document.getElementById('est-portal-modal').remove()">
        ${gwIcon('close',14)}
        Exit Preview
      </button>
    </div>
    <div class="est-portal-body" id="est-portal-body">
      <div class="est-portal-loading"><div class="est-spinner"></div> Loading preview…</div>
    </div>
  </div>`;
  document.body.appendChild(modal);

  try {
    // Fetch estimate and branding in parallel
    const [estRes, brandRes] = await Promise.all([
      fetch(`/api/estimates/${estId}`, { credentials: 'include' }),
      fetch('/api/company/branding', { credentials: 'include' }).catch(()=>null)
    ]);
    if (!estRes.ok) throw new Error('Not found');
    const { data: est } = await estRes.json();
    _estNormalize(est);

    // Load branding
    let brand = { name: 'Groundwork', logo_url: '', tagline: '', brand_color: '#2D7A55', brand_accent: '#4D8A86', address_line1: '', address_city: '', address_state: '', phone: '', website: '' };
    if (brandRes && brandRes.ok) {
      const _raw = await brandRes.json();
      const bd = (_raw && _raw.data) ? _raw.data : _raw;
      if (bd && bd.name !== undefined) brand = { ...brand, ...bd };
    }
    // Public portal viewers have no session — use the branding embedded in the estimate payload
    if (est && est._brand) brand = { ...brand, ...est._brand };
    // Fall back to window._scBrand if already loaded (authenticated app context)
    else if (window._scBrand && window._scBrand.name) brand = { ...brand, ...window._scBrand };

    // Update topbar brand name/logo
    const brandEl = document.getElementById('est-portal-brand-name');
    if (brandEl) {
      if (brand.logo_url) {
        brandEl.innerHTML = `<img src="${_estEsc(brand.logo_url)}" alt="${_estEsc(brand.name)}" style="max-height:36px;max-width:160px;object-fit:contain">`;
      } else {
        brandEl.textContent = brand.name || 'Groundwork';
      }
    }

    _estRenderPortal(est, brand);
  } catch (e) {
    const body = document.getElementById('est-portal-body');
    if (body) body.innerHTML = `<div style="padding:40px;text-align:center">Failed to load estimate preview</div>`;
  }
}

function _estRenderPortal(est, brand) {
  const body = document.getElementById('est-portal-body');
  if (!body) return;

  // Resolve brand defaults
  brand = brand || { name:'Groundwork', logo_url:'', tagline:'', brand_color:'#2D7A55', address_line1:'', address_city:'', address_state:'', phone:'', website:'' };
  const companyName   = brand.name || 'Groundwork';
  const companyLogo   = brand.logo_url || '';
  const companyColor  = brand.brand_color || '#2D7A55';
  const companyTagline= brand.tagline || '';
  const companyAddr   = [brand.address_line1, brand.address_city && brand.address_state ? `${brand.address_city}, ${brand.address_state}` : (brand.address_city || brand.address_state)].filter(Boolean).join(' · ');
  const companyPhone  = brand.phone || '';
  const companyWeb    = brand.website || '';

  const subtotal = Number(est.subtotal || 0);
  const discAmt  = Number(est.discount_amt || 0);
  const taxAmt   = Number(est.tax_amt || 0);
  const total    = Number(est.total || 0);
  const depAmt   = Number(est.deposit_amt || 0);
  const depPct   = Number(est.deposit_pct || 30);
  const sc       = _estStatusConfig(est.status);

  body.innerHTML = `
  <div class="est-portal-content">
    <!-- Left: Document -->
    <div class="est-portal-doc">
      <div class="est-portal-doc-header">
        <div>
          ${companyLogo
            ? `<div class="est-portal-company-logo"><img src="${_estEsc(companyLogo)}" alt="${_estEsc(companyName)}" style="max-height:48px;max-width:180px;object-fit:contain"></div>`
            : `<div class="est-portal-company-name" style="color:${companyColor}">${_estEsc(companyName)}</div>`}
          ${companyTagline ? `<div class="est-portal-company-tagline">${_estEsc(companyTagline)}</div>` : ''}
          <div class="est-portal-est-meta">
            <span>${_estEsc(est.est_number || 'EST')}</span>
            <span>·</span>
            <span>${_estDate(est.estimate_date || est.created_at)}</span>
          </div>
        </div>
        <div style="text-align:right">
          <span class="est-badge ${sc.cls}">${sc.label}</span>
          ${(companyAddr || companyPhone) ? `
          <div style="margin-top:8px;font-size:11px;color:var(--gw-text-muted,#9CA3AF);line-height:1.6">
            ${companyAddr ? `<div>${_estEsc(companyAddr)}</div>` : ''}
            ${companyPhone ? `<div>${_estEsc(companyPhone)}</div>` : ''}
            ${companyWeb ? `<div>${_estEsc(companyWeb)}</div>` : ''}
          </div>` : ''}
        </div>
      </div>

      <div class="est-portal-greeting">
        <h2>Hello, ${_estEsc((est.client_name || 'there').split(' ')[0])} <span class="est-portal-wave">${gwIcon('wave',22,'var(--gw-primary,#2D7A55)')}</span></h2>
        <p>Your estimate is ready for review. Please look it over and let us know how you'd like to proceed.</p>
      </div>

      ${est.property_addr ? `
      <div class="est-portal-property">
        <div class="est-portal-property-label">Property / Service Location</div>
        <div class="est-portal-property-addr">${_estEsc(est.property_addr)}</div>
      </div>` : ''}

      ${est.scope_of_work ? `
      <div class="est-portal-section">
        <h3 class="est-portal-section-title">Scope of Work</h3>
        <div class="est-portal-scope">${_estEsc(est.scope_of_work).replace(/\n/g,'<br>')}</div>
      </div>` : ''}

      ${est.line_items.length ? `
      <div class="est-portal-section">
        <h3 class="est-portal-section-title">Pricing Breakdown</h3>
        <div class="est-portal-line-table">
          <div class="est-portal-line-header">
            <span>Item</span>
            <span>Qty</span>
            <span>Rate</span>
            <span>Total</span>
          </div>
          ${est.line_items.map(li => `
          <div class="est-portal-line-row">
            <div>
              <div class="est-portal-li-name">${_estEsc(li.name || li.description || '—')}</div>
              ${li.desc ? `<div class="est-portal-li-desc">${_estEsc(li.desc)}</div>` : ''}
            </div>
            <div class="est-portal-li-num">${li.qty || 1}</div>
            <div class="est-portal-li-num">${_estFmt(li.rate || li.unit || 0)}</div>
            <div class="est-portal-li-num est-portal-li-total">${_estFmt(Number(li.qty||1)*Number(li.rate||li.unit||0))}</div>
          </div>`).join('')}
        </div>
      </div>` : ''}

      ${est.attachments.length ? `
      <div class="est-portal-section">
        <h3 class="est-portal-section-title">Attachments</h3>
        <div class="est-portal-attachments">
          ${est.attachments.map(a => _estAttachmentCard(a)).join('')}
        </div>
      </div>` : ''}

      ${est.customer_notes ? `
      <div class="est-portal-section">
        <h3 class="est-portal-section-title">Notes</h3>
        <div class="est-portal-notes">${_estEsc(est.customer_notes).replace(/\n/g,'<br>')}</div>
      </div>` : ''}

      ${est.terms ? `
      <div class="est-portal-section">
        <h3 class="est-portal-section-title">Terms &amp; Conditions</h3>
        <div class="est-portal-terms">${_estEsc(est.terms).replace(/\n/g,'<br>')}</div>
      </div>` : ''}
    </div>

    <!-- Right: Action Panel -->
    <div class="est-portal-panel">
      <div class="est-portal-panel-inner">
        <div class="est-portal-totals">
          <div class="est-portal-totals-title">Estimate Summary</div>
          <div class="est-portal-totals-row"><span>Subtotal</span><span>${_estFmt(subtotal)}</span></div>
          ${discAmt > 0 ? `<div class="est-portal-totals-row est-text-green"><span>Discount</span><span>−${_estFmt(discAmt)}</span></div>` : ''}
          ${taxAmt > 0 ? `<div class="est-portal-totals-row"><span>Tax</span><span>${_estFmt(taxAmt)}</span></div>` : ''}
          <div class="est-portal-totals-grand"><span>Total</span><span>${_estFmt(total)}</span></div>
        </div>

        ${depAmt > 0 ? `
        <div class="est-portal-deposit-callout">
          <div class="est-portal-deposit-icon">${gwIcon('payment',24,'#2D7A55')}</div>
          <div>
            <div class="est-portal-deposit-title">Deposit Required</div>
            <div class="est-portal-deposit-amount">${_estFmt(depAmt)}</div>
            <div class="est-portal-deposit-sub">${depPct}% due at acceptance · ${_estFmt(total - depAmt)} balance remaining</div>
          </div>
        </div>` : ''}

        <div class="est-portal-cta-stack">
          <button class="est-portal-cta-primary" onclick="_estPortalAccept('${_estEsc(est.id)}')">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M2 8l4 4 8-8"/></svg>
            ${depAmt > 0 ? `Accept &amp; Pay Deposit` : 'Accept Estimate'}
          </button>
          <button class="est-portal-cta-secondary" onclick="_estPortalChanges('${_estEsc(est.id)}')">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M3 8h10M9 4l4 4-4 4"/></svg>
            Request Changes
          </button>
          <button class="est-portal-cta-text" onclick="_estPortalDecline('${_estEsc(est.id)}')">Decline</button>
        </div>

        ${est.expiry_date ? `
        <div class="est-portal-expiry">
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="8" cy="8" r="7"/><path d="M8 4v4l3 2"/></svg>
          ${_estIsExpired(est.expiry_date) ? '<span class="est-text-red">Expired</span>' : `Valid until ${_estDate(est.expiry_date)}`}
        </div>` : ''}
      </div>
    </div>
  </div>`;
}

async function _estPortalAccept(estId) {
  try {
    await fetch(`/api/estimates/${estId}/accept`, { method: 'POST', credentials: 'include' });
    showToast('Estimate accepted — great!', 'success');
    document.getElementById('est-portal-modal')?.remove();
    setTimeout(() => estimateDetail(estId), 300);
  } catch (e) { showToast('Error', 'error'); }
}

function _estPortalDecline(estId) {
  const reason = prompt('Reason for declining (optional):');
  if (reason === null) return; // Cancelled
  fetch(`/api/estimates/${estId}/decline`, {
    method: 'POST', credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ reason }),
  }).then(() => {
    showToast('Estimate declined', 'info');
    document.getElementById('est-portal-modal')?.remove();
    setTimeout(() => estimateDetail(estId), 300);
  }).catch(() => showToast('Error', 'error'));
}

function _estPortalChanges(estId) {
  const msg = prompt('What changes would you like? Please describe:');
  if (!msg) return;
  fetch(`/api/estimates/${estId}/changes`, {
    method: 'POST', credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: msg }),
  }).then(() => {
    showToast('Changes requested — we\'ll be in touch', 'info');
    document.getElementById('est-portal-modal')?.remove();
    setTimeout(() => estimateDetail(estId), 300);
  }).catch(() => showToast('Error', 'error'));
}

// ── ESTIMATE ACTIONS ──────────────────────────────────────────────────────────

function _estNewEstimate() {
  estimateBuilder(null);
}

async function _estDuplicate(estId) {
  try {
    const r = await fetch(`/api/estimates/${estId}/duplicate`, { method: 'POST', credentials: 'include' });
    if (!r.ok) throw new Error('Duplicate failed');
    const { data } = await r.json();
    showToast(`Duplicated as ${data.est_number}`, 'success');
    setTimeout(() => estimateBuilder(data.id), 300);
  } catch (e) {
    showToast('Failed to duplicate estimate', 'error');
  }
}

async function _estDeleteConfirm(estId) {
  _estCloseMenu();
  if (!confirm('Delete this estimate? This cannot be undone.')) return;
  try {
    await fetch(`/api/estimates/${estId}`, { method: 'DELETE', credentials: 'include' });
    showToast('Estimate deleted', 'info');
    estimates();
  } catch (e) {
    showToast('Failed to delete', 'error');
  }
}

async function _estAcceptInternal(estId) {
  if (!confirm('Mark this estimate as accepted?')) return;
  try {
    await fetch(`/api/estimates/${estId}/accept`, { method: 'POST', credentials: 'include' });
    showToast('Estimate marked accepted', 'success');
    estimateDetail(estId);
  } catch (e) { showToast('Error', 'error'); }
}

function _estDeclineModal(estId) {
  const reason = prompt('Reason for declining (optional):');
  if (reason === null) return;
  fetch(`/api/estimates/${estId}/decline`, {
    method: 'POST', credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ reason }),
  }).then(() => {
    showToast('Estimate marked declined', 'info');
    estimateDetail(estId);
  }).catch(() => showToast('Error', 'error'));
}

async function _estConvertToInvoice(estId) {
  // Confirm before converting
  if (!confirm('Convert this estimate to an invoice? The estimate will be marked as invoiced and removed from the active list.')) return;

  // Show progress toast
  showToast('Converting to invoice…', 'info');

  try {
    const r = await fetch(`/api/invoices/from-estimate/${estId}`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' }
    });

    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      showToast(err.error || 'Conversion failed — please try again', 'error');
      return;
    }

    const data = await r.json();

    // Audit log
    if (typeof window.gwAudit === 'function') {
      window.gwAudit({ type: 'estimate_converted', entityType: 'estimate', entityId: estId, entityLabel: data.invoice_number });
    }

    showToast(`Invoice ${data.invoice_number} created successfully!`, 'success');

    // Close the detail drawer if open
    if (typeof _estCloseDrawer === 'function') _estCloseDrawer();

    // Refresh estimates list (estimate now shows as invoiced / hidden)
    setTimeout(() => {
      if (typeof estimates === 'function') {
        estimates();
      }
    }, 600);

    // Navigate to invoices tab after a brief delay so user sees success toast
    setTimeout(() => {
      if (typeof window.show === 'function') {
        window.show('invoices');
      } else if (typeof window.gwInvoices === 'function') {
        window.gwInvoices();
      }
    }, 1200);

  } catch (e) {
    console.error('Convert to invoice error:', e);
    showToast('Network error — could not convert estimate', 'error');
  }
}

function _estCopyPortalLink(token) {
  const link = `${window.location.origin}/portal/estimate/${token}`;
  if (navigator.clipboard) {
    navigator.clipboard.writeText(link).then(() => showToast('Portal link copied!', 'success')).catch(() => _estFallbackCopy(link));
  } else {
    _estFallbackCopy(link);
  }
}

function _estFallbackCopy(text) {
  const ta = document.createElement('textarea');
  ta.value = text;
  document.body.appendChild(ta);
  ta.select();
  document.execCommand('copy');
  ta.remove();
  showToast('Link copied!', 'success');
}

// ── ROUTE EXPORTS ─────────────────────────────────────────────────────────────

window.estimates       = estimates;
window.estimateDetail  = estimateDetail;
window.estimateBuilder = estimateBuilder;
window.estimateBuilderForLead = estimateBuilderForLead;
window._estPaySchedField  = _estPaySchedField;
window._estPaySchedAdd    = _estPaySchedAdd;
window._estPaySchedRemove = _estPaySchedRemove;
window._estPaySchedPreset = _estPaySchedPreset;
window._estPaySchedClear  = _estPaySchedClear;
window._estPaySchedRefresh = _estPaySchedRefresh;
window._estPortalPreview = _estPortalPreview;
window._estNewEstimate = _estNewEstimate;
window._estDuplicate   = _estDuplicate;
window._estDeleteConfirm = _estDeleteConfirm;
window._estSendModal   = _estSendModal;
window._estDoSend      = _estDoSend;
window._estPortalAccept   = _estPortalAccept;
window._estPortalDecline  = _estPortalDecline;
window._estPortalChanges  = _estPortalChanges;
window._estConvertToInvoice = _estConvertToInvoice;
window._estCopyPortalLink = _estCopyPortalLink;
window._estAcceptInternal = _estAcceptInternal;
window._estDeclineModal   = _estDeclineModal;
window._estRowClick    = _estRowClick;
window._estOpenDrawer  = _estOpenDrawer;
window._estCloseDrawer = _estCloseDrawer;
window._estRowMoreMenu = _estRowMoreMenu;
window._estCloseMenu   = _estCloseMenu;
window._estDetailMoreMenu = _estDetailMoreMenu;
window._estLoadList    = _estLoadList;
window._estListFilter  = _estListFilter;
window._estChipFilter  = _estChipFilter;
window._estAddLine     = _estAddLine;
window._estRemoveLine  = _estRemoveLine;
window._estUpdateLine  = _estUpdateLine;
window._estCalcTotals  = _estCalcTotals;
window._estSaveBuilder = _estSaveBuilder;
window._estPortalPreviewBuilder = _estPortalPreviewBuilder;
window._estClientSearch = _estClientSearch;
window._estSelectClient = _estSelectClient;
window._estClearCustomer = _estClearCustomer;
window._estManualCustomer = _estManualCustomer;
window._estHandleFiles = _estHandleFiles;
window._estHandleDrop  = _estHandleDrop;
window._estRemoveAttachment = _estRemoveAttachment;
window._estDraftField  = _estDraftField;
