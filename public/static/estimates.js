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
  if (typeof est.tiers === 'string') try { est.tiers = JSON.parse(est.tiers); } catch(e) { est.tiers = []; }
  if (typeof est.sections === 'string') try { est.sections = JSON.parse(est.sections); } catch(e) { est.sections = []; }
  if (typeof est.cost_data === 'string') try { est.cost_data = JSON.parse(est.cost_data); } catch(e) { est.cost_data = {}; }
  if (typeof est.recurring_data === 'string') try { est.recurring_data = JSON.parse(est.recurring_data); } catch(e) { est.recurring_data = {}; }
  if (!Array.isArray(est.line_items)) est.line_items = [];
  if (!Array.isArray(est.attachments)) est.attachments = [];
  if (!Array.isArray(est.payment_schedule)) est.payment_schedule = [];
  if (!Array.isArray(est.tiers)) est.tiers = [];
  if (!est.cost_data || typeof est.cost_data !== 'object') est.cost_data = {};
  if (!est.recurring_data || typeof est.recurring_data !== 'object') est.recurring_data = {};
  if (!est.mode) est.mode = 'simple';
  if (!est.doc_type) est.doc_type = 'onetime';
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
      <td>
        <span class="est-number-tag">${_estEsc(est.est_number || '—')}</span>
        ${_estModeChips(est)}
      </td>
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

// Small type indicator under the number: Proposal (advanced mode) / Recurring
function _estModeChips(est) {
  const chips = [];
  if (est.mode === 'advanced') chips.push(`<span title="Advanced proposal — overview & option tiers" style="display:inline-block;margin-top:3px;padding:1px 6px;border-radius:8px;font-size:10px;font-weight:700;letter-spacing:.3px;background:rgba(77,138,134,.16);color:#4D8A86;border:1px solid rgba(77,138,134,.35)">PROPOSAL</span>`);
  if (est.doc_type === 'recurring') chips.push(`<span title="Recurring / maintenance contract" style="display:inline-block;margin-top:3px;padding:1px 6px;border-radius:8px;font-size:10px;font-weight:700;letter-spacing:.3px;background:rgba(201,123,106,.14);color:#C97B6A;border:1px solid rgba(201,123,106,.35)">RECURRING</span>`);
  return chips.length ? `<div style="display:flex;gap:4px;flex-wrap:wrap">${chips.join('')}</div>` : '';
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
  const isAccepted = est.status === 'accepted' || est.status === 'approved' || est.status === 'invoiced';
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
  // Schedule to Job — always prominent. Before acceptance = yellow "hold" (flips
  // green automatically when the client accepts, like a traffic light).
  const schedBtn = est.work_order_id
    ? `<button class="est-detail-action-primary ${isAccepted ? 'est-sched-btn--green' : 'est-sched-btn--hold'}" onclick="typeof workOrderDetail==='function'?workOrderDetail('${_estEsc(est.work_order_id)}'):(typeof _sbOpenVisitModal==='function'?_sbOpenVisitModal('${_estEsc(est.work_order_id)}'):window.show('scheduleBoard'))">
        <span class="est-traffic-dot ${isAccepted ? 'est-traffic-dot--green' : 'est-traffic-dot--yellow'}"></span>
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><rect x="2" y="3" width="12" height="11" rx="1.5"/><path d="M5 1v4M11 1v4M2 7h12"/></svg> View Scheduled Job</button>`
    : `<button class="est-detail-action-primary ${isAccepted ? 'est-sched-btn--green' : 'est-sched-btn--hold'}" onclick="_estScheduleToJob('${_estEsc(est.id)}','${_estEsc(est.status)}')">
        <span class="est-traffic-dot ${isAccepted ? 'est-traffic-dot--green' : 'est-traffic-dot--yellow'}"></span>
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><rect x="2" y="3" width="12" height="11" rx="1.5"/><path d="M5 1v4M11 1v4M2 7h12"/></svg> ${isAccepted ? 'Schedule to Job' : 'Schedule to Job (Hold)'}</button>`;
  primaryAction = primaryAction + (primaryAction ? ' ' : '') + schedBtn;

  // All secondary actions visible — no "More ▾" dropdown
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
    ${est.status !== 'invoiced' && est.status !== 'accepted' ? `<button class="est-detail-action-btn" onclick="_estConvertToInvoice('${_estEsc(est.id)}')">
      <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><rect x="1" y="1" width="14" height="14" rx="1.5"/><path d="M4 8h8M4 5h5M4 11h6"/></svg> Convert to Invoice
    </button>` : ''}
    <button class="est-detail-action-btn est-detail-action-btn--danger" onclick="_estDeleteConfirm('${_estEsc(est.id)}')">
      <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M2 4h12M6 4V2h4v2M4 4l1 10h6l1-10"/></svg> Delete
    </button>`;

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

      <!-- Line Items — internal view: cost/rate, qty/hr, budgeted hours, taxes, total -->
      <section class="est-detail-section">
        <h2 class="est-detail-section-title">Pricing Breakdown <span class="est-internal-tag" title="Customers see only Item, Qty and Total">Internal view</span></h2>
        ${est.line_items.length ? `
        <table class="est-detail-line-table">
          <thead>
            <tr>
              <th>Item / Description</th>
              <th class="est-col-num">Cost/Rate</th>
              <th class="est-col-num">Qty/Hr</th>
              <th class="est-col-num" title="Not visible to the client — internal only">Budgeted Hours <span class="est-col-internal-dot" title="Internal only">●</span></th>
              <th class="est-col-num">Taxes</th>
              <th class="est-col-num">Total</th>
            </tr>
          </thead>
          <tbody>
            ${est.line_items.map(li => {
              const qty = Number(li.qty || 1);
              const rate = Number(li.rate || li.unit || 0);
              const budgetHrs = qty * Number(li.unit_time || 0);
              const taxPct = Number(est.tax_pct || 0);
              return `
            <tr>
              <td>
                <div class="est-li-name">${_estEsc(li.name || li.description || '—')}</div>
                ${li.desc || li.description2 ? `<div class="est-li-desc">${_estEsc(li.desc || li.description2)}</div>` : ''}
                ${li.group && li.group !== 'General' ? `<div class="est-li-desc" style="font-size:11px;opacity:.75">${_estEsc(li.group)}</div>` : ''}
              </td>
              <td class="est-col-num">${_estFmt(rate)}${li.unit_cost ? `<div class="est-li-desc" style="font-size:11px" title="Your unit cost">cost ${_estFmt(li.unit_cost)}</div>` : ''}</td>
              <td class="est-col-num">${qty}${li.unit ? ` <span style="font-size:11px;color:var(--gw-text-muted)">${_estEsc(li.unit)}</span>` : ''}</td>
              <td class="est-col-num est-col-internal">${budgetHrs > 0 ? budgetHrs.toFixed(2) + ' h' : '—'}</td>
              <td class="est-col-num">${taxPct > 0 ? taxPct + '%' : '—'}</td>
              <td class="est-col-num est-li-total">${_estFmt(qty * rate)}</td>
            </tr>`;}).join('')}
          </tbody>
        </table>
        <div class="est-detail-totals">
          ${(() => { const bh = est.line_items.reduce((s, li) => s + Number(li.qty || 1) * Number(li.unit_time || 0), 0) || Number(est.cost_data?.rollup?.budgeted_hours || 0); return bh > 0 ? `<div class="est-totals-row est-col-internal" title="Internal only — not shown to the client"><span>Budgeted Hours <span class="est-col-internal-dot">●</span></span><span>${bh.toFixed(2)} h</span></div>` : ''; })()}
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
  actions.push(`<button onclick="_estConvertToJob('${id}');_estCloseMenu()">Convert to Job / Event</button>`);
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
    mode: 'simple', doc_type: 'onetime', overview: '', tiers: [],
    cost_data: {}, recurring_data: {},
  };
  if (!Array.isArray(_estDraft.payment_schedule)) _estDraft.payment_schedule = [];

  // Always open on the customer-facing document tab
  _estBuilderTab = 'document';

  // NEW estimates: auto-fill company default Terms & Conditions / customer notes
  // (set in Settings → Company → Estimate & Proposal Defaults). Cached per session;
  // fetched in the background and applied only while the fields are still empty.
  if (!est) {
    const applyDefaults = (d) => {
      if (!d || !_estDraft || _estDraft.id) return;
      if (d.terms && !_estDraft.terms) {
        _estDraft.terms = d.terms;
        const el = document.getElementById('est-terms');
        if (el && !el.value) el.value = d.terms;
      }
      if (d.customer_notes && !_estDraft.customer_notes) {
        _estDraft.customer_notes = d.customer_notes;
        const el = document.getElementById('est-customer-notes');
        if (el && !el.value) el.value = d.customer_notes;
      }
      if ((d.terms || d.customer_notes) && typeof _estPvQueue === 'function') _estPvQueue();
    };
    if (window._estDefaults) applyDefaults(window._estDefaults);
    else {
      fetch('/api/estimate-defaults', { credentials: 'include' })
        .then(r => r.json())
        .then(j => { window._estDefaults = (j && j.data) || {}; applyDefaults(window._estDefaults); })
        .catch(() => {});
    }
  }

  // Load price book + pricing settings in the background for the picker & engine
  _estPBEnsure();

  // Load estimate templates in the background, then refresh the template picker
  _estTplLoad().then(() => {
    const sel = document.getElementById('est-tpl-select');
    if (sel && _estTemplates.length) {
      const cur = sel.value;
      sel.innerHTML = `<option value="">Choose a template…</option>` + _estTemplates.map(t => `<option value="${_estEsc(t.id)}">${_estEsc(_estTplOptLabel(t))}</option>`).join('');
      sel.value = cur;
    }
  });

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

  const tab = _estBuilderTab === 'workbench' ? 'workbench' : 'document';
  const pvOn = tab === 'document' && _estPvEnabled();
  const engineSelling = est.cost_data?.rollup?.selling_price;

  // #view is overflow:auto (a scroll container that never actually scrolls —
  // the window does), which silently disables position:sticky for the preview
  // and rail. Override it while the builder is open; auto-restore after.
  view.style.setProperty('overflow', 'visible', 'important');
  if (!window._estViewOverflowWatch) {
    window._estViewOverflowWatch = new MutationObserver(() => {
      const v = document.getElementById('view');
      if (v && v.style.overflow === 'visible' && !document.getElementById('est-builder-shell') && !document.getElementById('pr-builder-shell')) v.style.removeProperty('overflow');
    });
    window._estViewOverflowWatch.observe(view, { childList: true });
  }

  view.innerHTML = `
  <style>
    #est-builder-shell.est-builder-shell--pv { grid-template-columns: minmax(0,1fr) minmax(400px,46%) !important; max-width: 1900px !important; margin: 0 auto !important; }
    #est-pv-doc .est-portal-content { grid-template-columns: 1fr !important; padding: 26px 22px !important; max-width: none !important; }
    #est-pv-doc .est-portal-doc { padding-right: 0 !important; }
    #est-pv-doc .est-portal-panel { position: static !important; margin-top: 18px; }
    .est-btab { padding: 8px 16px; border: none; border-radius: 8px; cursor: pointer; font-size: 12.5px; font-weight: 800; display: flex; align-items: center; gap: 7px; background: transparent; color: var(--gw-text-subtle,#6F7E6A); transition: background .15s; }
    .est-btab--active { background: var(--gw-surface,#fff); color: var(--gw-text,#2F3B33); box-shadow: 0 1px 4px rgba(0,0,0,.1); }
    .est-btab-badge { font-size: 10px; font-weight: 800; padding: 1px 7px; border-radius: 99px; background: rgba(45,122,85,.12); color: var(--gw-action,#2D7A55); }
  </style>
  <div class="est-builder-shell ${pvOn ? 'est-builder-shell--pv' : ''}" id="est-builder-shell">

    <!-- Builder Main Canvas -->
    <div class="est-builder-main">

      <!-- Top Nav -->
      <div class="est-builder-topnav" style="flex-wrap:wrap">
        <button class="est-back-btn" onclick="${isEdit ? `estimateDetail('${_estEsc(est.id)}')` : 'estimates()'}">
          <svg width="13" height="13" viewBox="0 0 14 14" fill="none"><path d="M9 11L4 7l5-4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>
          ${isEdit ? 'Detail' : 'Estimates'}
        </button>
        <div class="est-builder-topnav-title">
          ${isEdit ? `Edit ${_estEsc(est.est_number || 'Estimate')}` : 'New Estimate'}
        </div>
        <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
          <div class="est-mode-toggle" style="display:flex;border:1px solid var(--gw-border,#DDD8CE);border-radius:8px;overflow:hidden" title="Simple = a clean quote. Advanced = full proposal with overview and Good/Better/Best options.">
            <button type="button" onclick="_estSetMode('simple')" style="padding:6px 12px;border:none;cursor:pointer;font-size:12px;font-weight:700;background:${est.mode!=='advanced'?'var(--gw-action,#2D7A55)':'transparent'};color:${est.mode!=='advanced'?'#fff':'var(--gw-text,#2F3B33)'}">Simple</button>
            <button type="button" onclick="_estSetMode('advanced')" style="padding:6px 12px;border:none;cursor:pointer;font-size:12px;font-weight:700;background:${est.mode==='advanced'?'var(--gw-action,#2D7A55)':'transparent'};color:${est.mode==='advanced'?'#fff':'var(--gw-text,#2F3B33)'}">Proposal</button>
          </div>
          <div class="est-mode-toggle" style="display:flex;border:1px solid var(--gw-border,#DDD8CE);border-radius:8px;overflow:hidden">
            <button type="button" onclick="_estSetDocType('onetime')" style="padding:6px 12px;border:none;cursor:pointer;font-size:12px;font-weight:700;background:${est.doc_type!=='recurring'?'var(--gw-ink,#2F3B33)':'transparent'};color:${est.doc_type!=='recurring'?'#fff':'var(--gw-text,#2F3B33)'}">One-Time</button>
            <button type="button" onclick="_estSetDocType('recurring')" style="padding:6px 12px;border:none;cursor:pointer;font-size:12px;font-weight:700;background:${est.doc_type==='recurring'?'var(--gw-ink,#2F3B33)':'transparent'};color:${est.doc_type==='recurring'?'#fff':'var(--gw-text,#2F3B33)'}">Recurring</button>
          </div>
          <button type="button" class="est-btn-secondary" style="font-size:12px;padding:6px 12px" onclick="_estOpenAiGen()">✨ Generate with AI</button>
          <div class="est-builder-save-state" id="est-save-state"></div>
        </div>
      </div>

      <!-- Builder Tabs: customer document vs internal pricing workbench -->
      <div style="display:flex;align-items:center;gap:12px;margin-bottom:16px;flex-wrap:wrap">
        <div style="display:flex;gap:4px;background:var(--gw-bg,#EDEAE2);border:1px solid var(--gw-border,#E4E0D6);border-radius:11px;padding:4px" role="tablist">
          <button type="button" class="est-btab ${tab==='document'?'est-btab--active':''}" id="est-btab-document" onclick="_estSetBuilderTab('document')" role="tab">📄 ${est.mode==='advanced' ? 'Proposal' : 'Estimate'} <span style="font-weight:600;opacity:.7">· what the customer sees</span></button>
          <button type="button" class="est-btab ${tab==='workbench'?'est-btab--active':''}" id="est-btab-workbench" onclick="_estSetBuilderTab('workbench')" role="tab">🔒 Pricing Workbench ${engineSelling ? `<span class="est-btab-badge">${_estFmt(engineSelling)}</span>` : `<span style="font-weight:600;opacity:.7">· internal</span>`}</button>
        </div>
        ${tab === 'document' ? `
        <button type="button" class="est-btn-secondary" style="font-size:12px;padding:7px 13px;margin-left:auto${pvOn ? ';background:var(--gw-action,#2D7A55);color:#fff;border-color:transparent' : ''}" onclick="_estTogglePv()" title="Show the branded customer document side-by-side, updating live as you type">${pvOn ? '✓ Live Preview' : '👁 Live Preview'}</button>` : ''}
      </div>

      ${tab === 'document' ? `
      <!-- Context banner -->
      <div style="display:flex;gap:10px;align-items:center;background:rgba(45,122,85,.07);border:1px solid rgba(45,122,85,.22);border-radius:10px;padding:10px 14px;margin-bottom:16px;font-size:12.5px;color:var(--gw-text,#2F3B33)">
        <span style="font-size:15px">📄</span>
        <span><b>Customer-facing.</b> Everything on this tab appears on the customer's document${pvOn ? ' — watch it update live on the right' : ' — turn on Live Preview to see it exactly as they will'}. Build your costs & margin in the <a href="javascript:void(0)" onclick="_estSetBuilderTab('workbench')" style="color:var(--gw-action,#2D7A55);font-weight:800">Pricing Workbench</a>.</span>
      </div>
      ${est.mode === 'advanced'
        ? `<div style="display:flex;gap:10px;align-items:center;background:rgba(77,138,134,.08);border:1px solid rgba(77,138,134,.3);border-radius:10px;padding:9px 14px;margin:-8px 0 16px;font-size:12px;color:var(--gw-text,#2F3B33)"><span style="font-size:14px">✨</span><span><b>Proposal mode</b> — the customer gets a <b>branded cover page</b>, an <b>Overview</b> section, and <b>Good / Better / Best option tiers</b> they can pick from. Switch to Simple for a quick single-price quote.</span></div>`
        : `<div style="display:flex;gap:10px;align-items:center;background:rgba(140,140,140,.06);border:1px dashed var(--gw-border,#DDD8CE);border-radius:10px;padding:9px 14px;margin:-8px 0 16px;font-size:12px;color:var(--gw-text-subtle,#5A675F)"><span style="font-size:14px">⚡</span><span><b>Simple mode</b> — a clean, single-price quote. Switch to <a href="javascript:void(0)" onclick="_estSetMode('advanced')" style="color:var(--gw-action,#2D7A55);font-weight:800">Proposal</a> for a branded cover page, overview, and Good / Better / Best options.</span></div>`}

      <!-- Section: Templates -->
      <section class="est-builder-section" style="padding:14px 18px">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap">
          <div>
            <div style="font-size:13px;font-weight:800">Templates</div>
            <div style="font-size:11.5px;color:var(--gw-text-subtle,#8A948C)">Quick-fill the whole document from a saved template, or save this one for reuse.</div>
          </div>
          <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
            <select id="est-tpl-select" class="est-input" style="font-size:12.5px;min-width:190px;width:auto">
              <option value="">${(_estTemplates||[]).length ? 'Choose a template…' : 'No templates saved yet'}</option>
              ${(_estTemplates||[]).map(t => `<option value="${_estEsc(t.id)}">${_estEsc(_estTplOptLabel(t))}</option>`).join('')}
            </select>
            <button type="button" class="est-btn-secondary" style="font-size:12px;padding:7px 11px" onclick="_estTplApply()">Apply</button>
            <button type="button" class="est-btn-secondary" style="font-size:12px;padding:7px 11px" onclick="_estTplSave()">Save as template</button>
            ${(_estTemplates||[]).length ? `<button type="button" style="border:none;background:transparent;font-size:11.5px;color:#B4482E;cursor:pointer;text-decoration:underline" onclick="_estTplDelete()">Delete selected</button>` : ''}
          </div>
        </div>
      </section>

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
        <div style="font-size:11.5px;color:var(--gw-text-subtle,#8A948C);margin-top:6px">💡 Start typing an item name to pull it from your <b>price book</b> — cost and man-hours auto-fill into the Pricing Workbench. Use <a href="javascript:void(0)" onclick="_estSetBuilderTab('workbench')" style="color:var(--gw-action,#2D7A55);font-weight:700">the workbench</a> to price this job, then push the total back here.</div>
      </section>

      ${est.mode === 'advanced' ? `
      <!-- Section: Overview + Tiers (Proposal mode) -->
      <section class="est-builder-section" id="est-section-advanced">
        <h3 class="est-builder-section-title"><span class="est-builder-section-num">5</span> Proposal Overview &amp; Option Tiers</h3>
        <p class="est-builder-section-hint">Proposal mode — add an executive overview and up to 3 pricing options (Good / Better / Best). The customer picks a tier in the portal.</p>
        <div class="est-builder-field-group" style="margin-bottom:14px">
          <label class="est-label">Overview / Executive Summary</label>
          <textarea id="est-overview" class="est-input" rows="4" placeholder="Why this project, your approach, what makes your company the right choice…" oninput="_estDraftField('overview',this.value)">${_estEsc(est.overview || '')}</textarea>
        </div>
        <div id="est-tiers-wrap"></div>
        <button type="button" class="est-btn-secondary" style="font-size:12.5px;margin-top:8px" onclick="_estTierAdd()">+ Add option tier</button>
      </section>` : ''}

      <!-- Section: Pricing Config -->
      <section class="est-builder-section">
        <h3 class="est-builder-section-title">
          <span class="est-builder-section-num">${est.mode === 'advanced' ? 6 : 5}</span>
          Discount, Tax &amp; Deposit
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
          <span class="est-builder-section-num">${est.mode === 'advanced' ? 7 : 6}</span>
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
          <span class="est-builder-section-num">${est.mode === 'advanced' ? 8 : 7}</span>
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
            <p class="est-field-hint">Auto-filled from your company defaults (<a href="javascript:void(0)" onclick="show&&show('systemConfig')" style="color:var(--gw-action,#2D7A55);font-weight:700">Settings → Estimate &amp; Proposal Defaults</a>) — edit freely for this document</p>
            <textarea id="est-terms" class="est-input est-textarea--md" rows="5" placeholder="Standard terms: payment schedule, cancellation policy, warranty…" oninput="_estDraftField('terms',this.value)">${_estEsc(est.terms)}</textarea>
          </div>
        </div>
      </section>
      ` : `
      <!-- ══════════════ PRICING WORKBENCH TAB (internal) ══════════════ -->
      <div style="display:flex;gap:10px;align-items:center;background:rgba(47,59,51,.05);border:1px solid var(--gw-border,#DDD8CE);border-radius:10px;padding:10px 14px;margin-bottom:16px;font-size:12.5px;color:var(--gw-text,#2F3B33)">
        <span style="font-size:15px">🔒</span>
        <span><b>Internal only — the customer never sees this tab.</b> This is your spreadsheet replacement: build the true job cost here, then push the recommended price to the <a href="javascript:void(0)" onclick="_estSetBuilderTab('document')" style="color:var(--gw-action,#2D7A55);font-weight:800">${est.mode==='advanced' ? 'Proposal' : 'Estimate'} tab</a>.</span>
      </div>

      <!-- Workbench: Line item cost inputs -->
      <section class="est-builder-section">
        <h3 class="est-builder-section-title"><span class="est-builder-section-num">A</span> Materials &amp; Unit Times</h3>
        <p class="est-builder-section-hint">The line items from the document, with their price-book cost and man-hour data. Edit qty here or pick items from the price book on the document tab.</p>
        <div id="est-wb-lines"></div>
      </section>

      ${est.doc_type === 'recurring' ? `
      <!-- Workbench: Recurring Contract Calculator -->
      <section class="est-builder-section" id="est-section-recurring">
        <h3 class="est-builder-section-title"><span class="est-builder-section-num">B</span> Recurring Contract Calculator</h3>
        <p class="est-builder-section-hint">Maintenance / contract pricing — each service × visits per year, priced with your maintenance division rates, rolled into a monthly payment with yearly escalation.</p>
        <div id="est-recurring-wrap"></div>
      </section>` : ''}

      <!-- Workbench: Job Cost Engine -->
      <section class="est-builder-section" id="est-section-engine">
        <h3 class="est-builder-section-title" style="display:flex;align-items:center;gap:8px"><span class="est-builder-section-num">${est.doc_type === 'recurring' ? 'C' : 'B'}</span> Job Cost Engine</h3>
        <p class="est-builder-section-hint">Direct cost → overhead recovery → break-even → profit → recommended selling price. Rates come from <a href="javascript:void(0)" onclick="show&&show('pricing')" style="color:var(--gw-action,#2D7A55);font-weight:700">Services &amp; Pricing → Job Cost Settings</a>.</p>
        <div id="est-engine-wrap"></div>
      </section>
      `}

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

    ${pvOn ? `
    <!-- Right: LIVE PREVIEW — the branded customer document, updating as you type -->
    <div style="position:sticky;top:14px;align-self:start;min-width:0" id="est-pv-rail">
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:8px">
        <div style="font-size:12px;font-weight:800;letter-spacing:.05em;text-transform:uppercase;color:var(--gw-text-subtle,#6F7E6A)">Live Preview</div>
        <span style="font-size:10.5px;font-weight:700;background:#E7F2EA;color:#1E5E3E;padding:2px 9px;border-radius:99px">Exactly what the customer sees</span>
        <div id="est-summary-content" style="display:none"></div>
        <span style="margin-left:auto;font-size:13px;font-weight:900;font-variant-numeric:tabular-nums" id="est-pv-total"></span>
      </div>
      <div id="est-pv-doc" style="background:#F4F1EA;border:1px solid var(--gw-border,#DDD8CE);border-radius:14px;overflow-y:auto;max-height:calc(100vh - 90px);box-shadow:0 10px 40px rgba(17,57,49,.10)"></div>
    </div>` : `
    <!-- Right Rail: Live Summary -->
    <div class="est-builder-rail" id="est-builder-rail">
      <div class="est-rail-card est-rail-card--sticky" id="est-builder-summary">
        <div class="est-rail-card-title">${tab === 'workbench' ? 'Quote Summary' : 'Estimate Summary'}</div>
        <div id="est-summary-content">
          <!-- Rendered by _estCalcTotals -->
        </div>
        <div class="est-builder-rail-actions">
          <button class="est-btn-primary est-btn-sm" onclick="_estSaveBuilder('save')">${isEdit ? 'Update' : 'Create'}</button>
          <button class="est-btn-secondary est-btn-sm" onclick="_estPortalPreviewBuilder()">Preview</button>
        </div>
      </div>
    </div>`}

  </div>`;

  // Render tab-specific dynamic regions
  if (tab === 'document') {
    _estRenderLineRows();
    _estRenderAttachmentList();
    if (est.mode === 'advanced') _estRenderTiers();
  } else {
    _estRenderWbLines();
    if (est.doc_type === 'recurring') _estRenderRecurring();
    _estRenderEngine();
  }
  _estCalcTotals();
  if (pvOn) { _estPvBrandEnsure(); _estPvRender(); }
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
  // Workbench tab: update ext cells + section subtotals in place
  if (field === 'qty') {
    const li = _estDraft.line_items[idx];
    const c = document.getElementById(`est-wb-cost-${idx}`), h = document.getElementById(`est-wb-hrs-${idx}`);
    if (c) c.textContent = _estFmt(Number(li.qty || 1) * Number(li.unit_cost || 0));
    if (h) h.textContent = (Number(li.qty || 1) * Number(li.unit_time || 0)).toFixed(2) + ' h';
    if (typeof _estWbRefreshTotals === 'function' && document.getElementById('est-wb-grand-cost')) _estWbRefreshTotals();
  }
  _estCalcTotals();
}

function _estRenderLineRows() {
  const container = document.getElementById('est-line-rows');
  if (!container) { if (typeof _estRenderWbLines === 'function') _estRenderWbLines(); return; }
  if (!_estDraft) return;
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
    <div class="est-line-col est-line-col--desc" style="position:relative">
      <input class="est-line-input est-line-input--name" type="text" placeholder="Item or service name — type to search price book" value="${_estEsc(li.name || li.description || '')}" autocomplete="off" oninput="_estUpdateLine(${i},'name',this.value);_estPBSuggest(${i},this.value)" onblur="setTimeout(()=>{const s=document.getElementById('est-pb-suggest-${i}');if(s)s.innerHTML='';},250)">
      <div class="est-pb-suggest" id="est-pb-suggest-${i}" style="position:absolute;top:100%;left:0;right:0;z-index:50"></div>
      <input class="est-line-input est-line-input--desc" type="text" placeholder="Description (optional)" value="${_estEsc(li.desc || li.description2 || '')}" oninput="_estUpdateLine(${i},'desc',this.value)">
      ${li.price_item_id ? `<div style="font-size:10.5px;color:var(--gw-action,#2D7A55);font-weight:700;margin-top:2px">📘 ${_estEsc(li.unit || '')} · cost ${_estFmt(li.unit_cost || 0)} · ${li.unit_time || 0}h/unit</div>` : ''}
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

  // Live-refresh the internal Job Cost Engine numbers
  if (typeof _estEngineCalc === 'function') _estEngineCalc();

  // Live preview: refresh the branded document + the header total (debounced)
  const pvTotal = document.getElementById('est-pv-total');
  if (pvTotal) pvTotal.textContent = _estFmt(total);
  if (typeof _estPvQueue === 'function') _estPvQueue();
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
  body.innerHTML = _estPortalContentHtml(est, brand, true);
}

// Shared customer-document renderer — used by the full-screen portal preview
// (interactive=true: live Accept/Decline buttons) AND the builder's live
// side-by-side preview (interactive=false: buttons shown but inert).
function _estPortalContentHtml(est, brand, interactive) {
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

  const isProposal = est.mode === 'advanced';

  return `
  <div class="est-portal-content">
    <!-- Left: Document -->
    <div class="est-portal-doc" style="${isProposal ? 'padding-top:0' : ''}">
      ${isProposal ? `
      <!-- PROPOSAL COVER BAND — the visual difference between a simple estimate and a high-level proposal -->
      <div style="background:linear-gradient(135deg, ${companyColor} 0%, ${companyColor}D9 60%, ${companyColor}B3 100%);color:#fff;border-radius:0 0 18px 18px;padding:34px 34px 28px;margin:0 -1px 26px">
        <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:16px;flex-wrap:wrap">
          <div>
            ${companyLogo ? `<div style="background:#fff;border-radius:10px;padding:7px 12px;display:inline-block;margin-bottom:14px"><img src="${_estEsc(companyLogo)}" alt="${_estEsc(companyName)}" style="max-height:40px;max-width:160px;object-fit:contain;display:block"></div>` : `<div style="font-size:19px;font-weight:900;letter-spacing:.02em;margin-bottom:12px">${_estEsc(companyName)}</div>`}
            <div style="font-size:11px;font-weight:800;letter-spacing:.22em;text-transform:uppercase;opacity:.85;margin-bottom:6px">Project Proposal</div>
            <div style="font-size:24px;font-weight:900;line-height:1.2;max-width:520px">${_estEsc(est.title || 'Your Project')}</div>
            ${companyTagline ? `<div style="font-size:12.5px;opacity:.85;margin-top:8px">${_estEsc(companyTagline)}</div>` : ''}
          </div>
          <div style="text-align:right;font-size:11.5px;line-height:1.7;opacity:.92">
            <div style="margin-bottom:6px"><span class="est-badge ${sc.cls}" style="background:#fff">${sc.label}</span></div>
            <div style="font-weight:800">${_estEsc(est.est_number || 'EST')}</div>
            <div>${_estDate(est.estimate_date || est.created_at)}</div>
            <div style="margin-top:6px">Prepared for</div>
            <div style="font-weight:800;font-size:13px">${_estEsc(est.client_name || 'You')}</div>
            ${companyPhone ? `<div style="margin-top:6px">${_estEsc(companyPhone)}</div>` : ''}
            ${companyWeb ? `<div>${_estEsc(companyWeb)}</div>` : ''}
          </div>
        </div>
      </div>` : ''}
      <div class="est-portal-doc-header" ${isProposal ? 'style="display:none"' : ''}>
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
        <p>${isProposal ? 'Thank you for the opportunity — here is our full proposal for your project. Review the options below and choose the one that fits best.' : 'Your estimate is ready for review. Please look it over and let us know how you\'d like to proceed.'}</p>
      </div>


      ${est.property_addr ? `
      <div class="est-portal-property">
        <div class="est-portal-property-label">Property / Service Location</div>
        <div class="est-portal-property-addr">${_estEsc(est.property_addr)}</div>
      </div>` : ''}

      ${est.mode === 'advanced' && est.overview ? `
      <div class="est-portal-section">
        <h3 class="est-portal-section-title">Overview</h3>
        <div class="est-portal-scope">${_estEsc(est.overview).replace(/\n/g,'<br>')}</div>
      </div>` : ''}

      ${est.scope_of_work ? `
      <div class="est-portal-section">
        <h3 class="est-portal-section-title">Scope of Work</h3>
        <div class="est-portal-scope">${_estEsc(est.scope_of_work).replace(/\n/g,'<br>')}</div>
      </div>` : ''}

      ${est.mode === 'advanced' && Array.isArray(est.tiers) && est.tiers.length ? `
      <div class="est-portal-section">
        <h3 class="est-portal-section-title">Your Options</h3>
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px">
          ${est.tiers.map(t => `
          <div style="border:1.5px solid ${t.recommended ? (brand.brand_color || '#2D7A55') : 'var(--gw-border,#E4E0D6)'};border-radius:12px;padding:16px 14px;position:relative;text-align:center">
            ${t.recommended ? `<div style="position:absolute;top:-9px;left:50%;transform:translateX(-50%);background:${brand.brand_color || '#2D7A55'};color:#fff;font-size:9.5px;font-weight:800;letter-spacing:.06em;padding:2px 10px;border-radius:99px;white-space:nowrap">RECOMMENDED</div>` : ''}
            <div style="font-weight:800;font-size:14px;margin-bottom:6px">${_estEsc(t.name || 'Option')}</div>
            ${t.desc ? `<div style="font-size:12px;color:var(--gw-text-muted,#6F7E6A);line-height:1.5;margin-bottom:10px">${_estEsc(t.desc).replace(/\n/g,'<br>')}</div>` : ''}
            <div style="font-size:20px;font-weight:900;color:${brand.brand_color || '#2D7A55'}">${_estFmt(t.total || 0)}</div>
          </div>`).join('')}
        </div>
      </div>` : ''}

      ${est.line_items.length ? `
      <div class="est-portal-section">
        <h3 class="est-portal-section-title">Pricing Breakdown</h3>
        <!-- Customer view: Item → Qty → Total only (no rate) -->
        <div class="est-portal-line-table est-portal-line-table--simple">
          <div class="est-portal-line-header">
            <span>Item</span>
            <span>Qty</span>
            <span>Total</span>
          </div>
          ${est.line_items.map(li => `
          <div class="est-portal-line-row">
            <div>
              <div class="est-portal-li-name">${_estEsc(li.name || li.description || '—')}</div>
              ${li.desc ? `<div class="est-portal-li-desc">${_estEsc(li.desc)}</div>` : ''}
            </div>
            <div class="est-portal-li-num">${li.qty || 1}</div>
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
          <button class="est-portal-cta-primary" ${interactive ? `onclick="_estPortalAccept('${_estEsc(est.id)}')"` : 'style="pointer-events:none" tabindex="-1"'}>
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M2 8l4 4 8-8"/></svg>
            ${depAmt > 0 ? `Accept &amp; Pay Deposit` : 'Accept Estimate'}
          </button>
          <button class="est-portal-cta-secondary" ${interactive ? `onclick="_estPortalChanges('${_estEsc(est.id)}')"` : 'style="pointer-events:none" tabindex="-1"'}>
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M3 8h10M9 4l4 4-4 4"/></svg>
            Request Changes
          </button>
          <button class="est-portal-cta-text" ${interactive ? `onclick="_estPortalDecline('${_estEsc(est.id)}')"` : 'style="pointer-events:none" tabindex="-1"'}>Decline</button>
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

// ═══════════════════════════════════════════════════════════════════════════
// PRICE BOOK INTEGRATION — line-item picker fed by /api/price-items
// ═══════════════════════════════════════════════════════════════════════════

let _estPB = null;          // cached price book items
let _estPS = null;          // cached pricing settings (job cost engine params)

async function _estPBEnsure() {
  if (!_estPB) {
    try {
      const r = await fetch('/api/price-items?all=1', { credentials: 'include' });
      const j = await r.json();
      _estPB = j.data || [];
    } catch (e) { _estPB = []; }
  }
  if (!_estPS) {
    try {
      const r = await fetch('/api/pricing-settings', { credentials: 'include' });
      const j = await r.json();
      _estPS = j.data || {};
    } catch (e) { _estPS = {}; }
  }
  return _estPB;
}

function _estPBSuggest(idx, q) {
  const box = document.getElementById(`est-pb-suggest-${idx}`);
  if (!box) return;
  q = (q || '').trim().toLowerCase();
  if (q.length < 2 || !Array.isArray(_estPB) || !_estPB.length) { box.innerHTML = ''; return; }
  const hits = _estPB.filter(p => (p.name || '').toLowerCase().includes(q)).slice(0, 8);
  if (!hits.length) { box.innerHTML = ''; return; }
  box.innerHTML = `<div style="background:var(--gw-surface,#fff);border:1px solid var(--gw-border,#DDD8CE);border-radius:9px;box-shadow:0 8px 24px rgba(0,0,0,.13);overflow:hidden;margin-top:2px">
    ${hits.map(p => `<div onmousedown="_estPBPick(${idx},'${_estEsc(p.id)}')" style="padding:8px 12px;cursor:pointer;font-size:12.5px;display:flex;justify-content:space-between;gap:10px;border-bottom:1px solid var(--gw-border,#F0EDE5)" onmouseover="this.style.background='var(--gw-bg,#F4F1EA)'" onmouseout="this.style.background=''">
      <span><b>${_estEsc(p.name)}</b> <span style="color:var(--gw-text-subtle,#8A948C)">· ${_estEsc(p.category)}${p.unit ? ' · ' + _estEsc(p.unit) : ''}</span></span>
      <span style="white-space:nowrap;color:var(--gw-text-subtle,#6F7E6A)">${_estFmt(p.unit_cost)}${p.unit_time ? ' · ' + p.unit_time + 'h' : ''}</span>
    </div>`).join('')}
  </div>`;
}

function _estPBPick(idx, pbId) {
  const p = (_estPB || []).find(x => x.id === pbId);
  if (!p || !_estDraft || !_estDraft.line_items[idx]) return;
  const li = _estDraft.line_items[idx];
  li.name = p.name;
  li.price_item_id = p.id;
  li.unit = p.unit || '';
  li.unit_cost = Number(p.unit_cost || 0);
  li.unit_time = Number(p.unit_time || 0);
  li.item_type = p.item_type || 'material';
  if (!li.group || li.group === 'General') li.group = p.category || 'General';
  // Default customer rate: cost marked up to hit the company's rev/hour goal is
  // engine work — as a starting point, rate = cost (engine sets selling price)
  if (!li.rate) li.rate = Number(p.unit_cost || 0);
  _estRenderLineRows();
  _estCalcTotals();
}

window._estPBSuggest = _estPBSuggest;
window._estPBPick = _estPBPick;

// ═══════════════════════════════════════════════════════════════════════════
// MODE / DOC TYPE toggles
// ═══════════════════════════════════════════════════════════════════════════

function _estSetMode(m) {
  if (!_estDraft) return;
  _estDraft.mode = m;
  if (m === 'advanced' && !Array.isArray(_estDraft.tiers)) _estDraft.tiers = [];
  _estRenderBuilder();
}
function _estSetDocType(t) {
  if (!_estDraft) return;
  _estDraft.doc_type = t;
  if (t === 'recurring' && (!_estDraft.recurring_data || !Array.isArray(_estDraft.recurring_data.services))) {
    _estDraft.recurring_data = { services: [], years: 3, ...( _estDraft.recurring_data || {}) };
    if (!Array.isArray(_estDraft.recurring_data.services)) _estDraft.recurring_data.services = [];
  }
  _estRenderBuilder();
}
window._estSetMode = _estSetMode;
window._estSetDocType = _estSetDocType;

// ═══════════════════════════════════════════════════════════════════════════
// OPTION TIERS (Advanced mode) — Good / Better / Best
// ═══════════════════════════════════════════════════════════════════════════

function _estRenderTiers() {
  const wrap = document.getElementById('est-tiers-wrap');
  if (!wrap || !_estDraft) return;
  const tiers = _estDraft.tiers || [];
  if (!tiers.length) {
    wrap.innerHTML = `<div style="font-size:12.5px;color:var(--gw-text-subtle,#8A948C);padding:10px 0">No option tiers yet — the main line items above act as the single price. Add tiers to offer Good / Better / Best choices.</div>`;
    return;
  }
  wrap.innerHTML = `<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:12px">
    ${tiers.map((t, i) => `
    <div style="border:1.5px solid ${t.recommended ? 'var(--gw-action,#2D7A55)' : 'var(--gw-border,#DDD8CE)'};border-radius:12px;padding:14px;position:relative">
      ${t.recommended ? `<div style="position:absolute;top:-9px;left:12px;background:var(--gw-action,#2D7A55);color:#fff;font-size:9.5px;font-weight:800;letter-spacing:.06em;padding:2px 9px;border-radius:99px">RECOMMENDED</div>` : ''}
      <input class="est-input" style="font-weight:800;margin-bottom:6px" placeholder="Tier name (e.g. Better)" value="${_estEsc(t.name || '')}" oninput="_estTierField(${i},'name',this.value)">
      <textarea class="est-input" rows="2" placeholder="What's included in this option…" style="font-size:12px;margin-bottom:6px" oninput="_estTierField(${i},'desc',this.value)">${_estEsc(t.desc || '')}</textarea>
      <input class="est-input" type="number" min="0" step="0.01" placeholder="Price" value="${t.total || ''}" oninput="_estTierField(${i},'total',parseFloat(this.value)||0)">
      <div style="display:flex;gap:8px;margin-top:8px;align-items:center">
        <label style="font-size:11.5px;display:flex;gap:4px;align-items:center;cursor:pointer"><input type="checkbox" ${t.recommended ? 'checked' : ''} onchange="_estTierRecommend(${i},this.checked)"> Recommended</label>
        <button type="button" style="margin-left:auto;border:none;background:none;color:#B4482E;cursor:pointer;font-size:12px" onclick="_estTierRemove(${i})">Remove</button>
      </div>
    </div>`).join('')}
  </div>`;
}

function _estTierAdd() {
  if (!_estDraft) return;
  _estDraft.tiers = _estDraft.tiers || [];
  const names = ['Good', 'Better', 'Best'];
  _estDraft.tiers.push({ id: _estUID(), name: names[_estDraft.tiers.length] || `Option ${_estDraft.tiers.length + 1}`, desc: '', line_items: [], total: 0, recommended: _estDraft.tiers.length === 1 });
  _estRenderTiers();
}
function _estTierField(i, k, v) { if (_estDraft?.tiers?.[i]) _estDraft.tiers[i][k] = v; }
function _estTierRecommend(i, on) {
  if (!_estDraft?.tiers) return;
  _estDraft.tiers.forEach((t, j) => t.recommended = on && j === i);
  _estRenderTiers();
}
function _estTierRemove(i) { if (_estDraft?.tiers) { _estDraft.tiers.splice(i, 1); _estRenderTiers(); } }
window._estTierAdd = _estTierAdd; window._estTierField = _estTierField;
window._estTierRecommend = _estTierRecommend; window._estTierRemove = _estTierRemove;

// ═══════════════════════════════════════════════════════════════════════════
// JOB COST ENGINE — the internal calculator that replaces the job spreadsheet.
// Replicates the TEMPLATE math:
//   materials (+ tax, + plant warranty) + misc + setup pay + equipment
//   + labor (budgeted hrs × labor rate) = direct cost
//   + OHR (budgeted hrs × ohr rate)     = break-even price (BEP)
//   + profit (BEP × profit%)            = selling price
//   budgeted hrs = productive unit-time hrs + non-productive (1.5/person/day)
// ═══════════════════════════════════════════════════════════════════════════

function _estEngineData() {
  if (!_estDraft.cost_data || typeof _estDraft.cost_data !== 'object') _estDraft.cost_data = {};
  const cd = _estDraft.cost_data;
  const ps = _estPS || {};
  if (cd.crew_size == null) cd.crew_size = ps.crew_size_default ?? 3;
  if (cd.setup_hours == null) cd.setup_hours = ps.setup_hours_default ?? 0;
  if (cd.equipment_cost == null) cd.equipment_cost = 0;
  if (cd.contingency == null) cd.contingency = ps.contingency_default ?? 50;
  if (cd.disposal == null) cd.disposal = ps.disposal_default ?? 35;
  if (cd.pickup == null) cd.pickup = ps.pickup_default ?? 10;
  return cd;
}

// Effective engine rates: company defaults (_estPS) overridable per-estimate via cd.rates
function _estEngineRates(cd) {
  const ps = _estPS || {};
  const o = (cd && cd.rates) || {};
  const pick = (k, d) => { const v = o[k]; return (v === '' || v == null || isNaN(Number(v))) ? Number(ps[k] ?? d) : Number(v); };
  return {
    tax_pct: pick('tax_pct', 6), warranty_pct: pick('warranty_pct', 10),
    labor_rate: pick('labor_rate', 27.25), ohr_rate: pick('ohr_rate', 35.08),
    profit_pct: pick('profit_pct', 22), setup_pay_rate: pick('setup_pay_rate', 35.58),
    rev_per_hour_goal: pick('rev_per_hour_goal', 86.13), workday_hours: pick('workday_hours', 10),
    nonprod_hours_per_person_day: pick('nonprod_hours_per_person_day', 1.5),
  };
}

function _estEngineCalc() {
  const wrap = document.getElementById('est-engine-results');
  if (!_estDraft) return null;
  const ps = _estPS || {};
  const cd = _estEngineData();
  const items = _estDraft.line_items || [];

  // Materials & unit-time roll-up from line items
  let matCost = 0, plantCost = 0, prodHours = 0;
  for (const li of items) {
    const qty = Number(li.qty || 1);
    const uc = Number(li.unit_cost || 0);
    const ut = Number(li.unit_time || 0);
    const cost = qty * uc;
    if ((li.item_type || 'material') === 'plant') plantCost += cost; else matCost += cost;
    prodHours += qty * ut;
  }
  const R = _estEngineRates(cd);
  const taxPct = R.tax_pct, warrPct = R.warranty_pct;
  const matTax = (matCost + plantCost) * taxPct / 100;
  const warranty = plantCost * warrPct / 100;
  const misc = Number(cd.contingency || 0) + Number(cd.disposal || 0) + Number(cd.pickup || 0);
  const setupPay = Number(cd.setup_hours || 0) * R.setup_pay_rate;
  const equip = Number(cd.equipment_cost || 0);

  // Crew / schedule → non-productive hours
  const crew = Math.max(1, Number(cd.crew_size || ps.crew_size_default || 3));
  const dayHrs = R.workday_hours;
  const days = prodHours > 0 ? Math.max(0.5, Math.ceil((prodHours / dayHrs / crew) * 2) / 2) : 0;
  const nonprod = R.nonprod_hours_per_person_day * crew * days;
  const budgetHrs = prodHours + nonprod;

  const laborRate = R.labor_rate, ohrRate = R.ohr_rate;
  const labor = budgetHrs * laborRate;
  const ohr = budgetHrs * ohrRate;

  const direct = matCost + plantCost + matTax + warranty + misc + setupPay + equip + labor;
  const bep = direct + ohr;
  const profitPct = R.profit_pct;
  const profit = bep * profitPct / 100;
  const selling = bep + profit;
  const revHr = budgetHrs > 0 ? selling / budgetHrs : 0;
  const goal = R.rev_per_hour_goal;

  const rollup = { mat_cost: matCost, plant_cost: plantCost, mat_tax: matTax, warranty, misc, setup_pay: setupPay,
    equipment: equip, prod_hours: prodHours, nonprod_hours: nonprod, budgeted_hours: budgetHrs, days, crew,
    labor, ohr, direct_cost: direct, bep, profit, selling_price: selling, rev_per_hour: revHr };
  cd.rollup = rollup;

  // Keep the Pricing Workbench tab badge (recommended price) live
  const wbTabBtn = document.getElementById('est-btab-workbench');
  if (wbTabBtn) {
    let badge = wbTabBtn.querySelector('.est-btab-badge');
    if (selling > 0) {
      if (!badge) {
        wbTabBtn.querySelector('span')?.remove(); // drop the "· internal" hint
        badge = document.createElement('span');
        badge.className = 'est-btab-badge';
        wbTabBtn.appendChild(badge);
      }
      badge.textContent = _estFmt(selling);
    }
  }

  if (wrap) {
    const row = (l, v, hl) => `<div style="display:flex;justify-content:space-between;font-size:12.5px;padding:3px 0;${hl ? 'font-weight:800;border-top:1.5px solid var(--gw-border,#DDD8CE);margin-top:4px;padding-top:7px' : ''}"><span>${l}</span><span style="font-variant-numeric:tabular-nums">${v}</span></div>`;
    const revOk = revHr >= goal;
    const gap = _estDraft.total > 0 ? _estDraft.total - selling : 0;
    wrap.innerHTML = `
      ${row('Materials', _estFmt(matCost))}
      ${plantCost > 0 ? row('Plant material', _estFmt(plantCost)) : ''}
      ${row(`Materials tax (${taxPct}%)`, _estFmt(matTax))}
      ${plantCost > 0 ? row(`Plant warranty (${warrPct}%)`, _estFmt(warranty)) : ''}
      ${row('Misc (contingency + disposal + pick-up)', _estFmt(misc))}
      ${setupPay > 0 ? row('Setup / estimator pay', _estFmt(setupPay)) : ''}
      ${equip > 0 ? row('Equipment rental', _estFmt(equip)) : ''}
      ${row(`Labor — ${budgetHrs.toFixed(1)} hrs (${prodHours.toFixed(1)} productive + ${nonprod.toFixed(1)} non-productive) × ${_estFmt(laborRate)}`, _estFmt(labor))}
      ${row('DIRECT COST', _estFmt(direct), true)}
      ${row(`Overhead recovery — ${budgetHrs.toFixed(1)} hrs × ${_estFmt(ohrRate)}`, _estFmt(ohr))}
      ${row('BREAK-EVEN PRICE', _estFmt(bep), true)}
      ${row(`Profit (${profitPct}%)`, _estFmt(profit))}
      ${row('RECOMMENDED SELLING PRICE', _estFmt(selling), true)}
      <div style="display:flex;gap:14px;margin-top:10px;flex-wrap:wrap">
        <span style="font-size:11.5px;padding:4px 10px;border-radius:99px;background:${revOk ? '#E7F2EA' : '#FBEDEA'};color:${revOk ? '#1E5E3E' : '#A6543F'};font-weight:800">${_estFmt(revHr)}/man-hr ${revOk ? '≥' : '<'} ${_estFmt(goal)} goal ${revOk ? '✓' : '⚠'}</span>
        <span style="font-size:11.5px;padding:4px 10px;border-radius:99px;background:var(--gw-bg,#F4F1EA);font-weight:700">${crew}-person crew · ~${days} day${days !== 1 ? 's' : ''}</span>
        ${_estDraft.total > 0 ? `<span style="font-size:11.5px;padding:4px 10px;border-radius:99px;background:${gap >= 0 ? '#E7F2EA' : '#FBEDEA'};color:${gap >= 0 ? '#1E5E3E' : '#A6543F'};font-weight:700">Quoted ${_estFmt(_estDraft.total)} (${gap >= 0 ? '+' : ''}${_estFmt(gap)} vs recommended)</span>` : ''}
      </div>
      <button type="button" class="est-btn-secondary" style="font-size:12px;margin-top:10px" onclick="_estEngineApplyPrice()">Use ${_estFmt(selling)} as the quote total →</button>`;
  }
  return rollup;
}

function _estRenderEngine() {
  const wrap = document.getElementById('est-engine-wrap');
  if (!wrap || !_estDraft) return;
  const cd = _estEngineData();
  const inp = (id, label, val, step) => `
    <div>
      <label style="font-size:11.5px;font-weight:700;display:block;margin-bottom:2px">${label}</label>
      <input class="est-input" type="number" min="0" step="${step || 'any'}" value="${val}" style="font-size:12.5px;padding:7px 9px"
        oninput="_estEngineField('${id}',parseFloat(this.value)||0)">
    </div>`;
  wrap.innerHTML = `
    <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:10px;margin-bottom:12px">
      ${inp('crew_size', 'Crew size', cd.crew_size, 1)}
      ${inp('setup_hours', 'Setup hours', cd.setup_hours)}
      ${inp('equipment_cost', 'Equipment rental $', cd.equipment_cost)}
      ${inp('contingency', 'Contingency $', cd.contingency)}
      ${inp('disposal', 'Disposal $', cd.disposal)}
      ${inp('pickup', 'Material pick-up $', cd.pickup)}
    </div>
    <div id="est-rates-wrap" style="margin-bottom:12px"></div>
    <div id="est-engine-results" style="background:var(--gw-bg,#FAF8F3);border:1px solid var(--gw-border,#EEE9DF);border-radius:10px;padding:14px 16px"></div>`;
  _estRenderRates();
  _estEngineCalc();
}

// ── Per-estimate rate overrides panel (profit %, OHR, labor rate, tax, etc.) ──
const _EST_RATE_FIELDS = [
  ['profit_pct', 'Profit %', '%'],
  ['ohr_rate', 'Overhead recovery $/hr', '$'],
  ['labor_rate', 'Labor rate $/hr', '$'],
  ['tax_pct', 'Sales tax %', '%'],
  ['warranty_pct', 'Plant warranty %', '%'],
  ['setup_pay_rate', 'Setup pay $/hr', '$'],
  ['rev_per_hour_goal', 'Rev/man-hr goal $', '$'],
  ['workday_hours', 'Workday hours', 'h'],
  ['nonprod_hours_per_person_day', 'Non-prod hrs/person/day', 'h'],
];

function _estRenderRates() {
  const wrap = document.getElementById('est-rates-wrap');
  if (!wrap || !_estDraft) return;
  const cd = _estEngineData();
  const ps = _estPS || {};
  const ov = cd.rates || {};
  const nOver = Object.keys(ov).filter(k => ov[k] !== '' && ov[k] != null && !isNaN(Number(ov[k]))).length;
  const open = !!cd._rates_open || nOver > 0;
  const R = _estEngineRates(cd);
  const defaults = { tax_pct: 6, warranty_pct: 10, labor_rate: 27.25, ohr_rate: 35.08, profit_pct: 22, setup_pay_rate: 35.58, rev_per_hour_goal: 86.13, workday_hours: 10, nonprod_hours_per_person_day: 1.5 };
  wrap.innerHTML = `
    <div style="border:1px solid ${nOver ? 'rgba(180,120,40,.45)' : 'var(--gw-border,#EEE9DF)'};border-radius:10px;overflow:hidden;background:${nOver ? 'rgba(240,180,80,.06)' : 'var(--gw-surface,#fff)'}">
      <button type="button" onclick="_estRatesToggle()" style="width:100%;display:flex;align-items:center;gap:8px;border:none;background:transparent;padding:10px 14px;cursor:pointer;font-size:12.5px;font-weight:800;color:var(--gw-text,#2F3B33);text-align:left">
        <span style="font-size:13px">${open ? '▾' : '▸'}</span> Rates for this estimate
        ${nOver
          ? `<span style="font-size:10.5px;font-weight:800;background:#F5E6C8;color:#8A5A18;padding:2px 9px;border-radius:99px">${nOver} custom rate${nOver !== 1 ? 's' : ''}</span>`
          : `<span style="font-size:11px;font-weight:600;color:var(--gw-text-subtle,#8A948C)">using company defaults</span>`}
        <span style="margin-left:auto;font-size:11px;font-weight:600;color:var(--gw-text-subtle,#8A948C)">Profit ${R.profit_pct}% · OHR ${_estFmt(R.ohr_rate)} · Labor ${_estFmt(R.labor_rate)} · Tax ${R.tax_pct}%</span>
      </button>
      ${open ? `
      <div style="padding:2px 14px 12px">
        <div style="font-size:11.5px;color:var(--gw-text-subtle,#8A948C);margin-bottom:9px">Adjust any rate for <b>this estimate only</b> — blank = company default (set in <a href="javascript:void(0)" onclick="show&&show('pricing')" style="color:var(--gw-action,#2D7A55);font-weight:700">Job Cost Settings</a>). Overrides save with the estimate and its templates.</div>
        <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(165px,1fr));gap:10px">
          ${_EST_RATE_FIELDS.map(([k, label]) => {
            const isOver = ov[k] !== '' && ov[k] != null && !isNaN(Number(ov[k]));
            const defVal = Number(ps[k] ?? defaults[k]);
            return `
            <div>
              <label style="font-size:11px;font-weight:700;display:block;margin-bottom:2px;${isOver ? 'color:#8A5A18' : ''}">${label}${isOver ? ' ✎' : ''}</label>
              <input class="est-input" type="number" min="0" step="any" placeholder="${defVal}" value="${isOver ? ov[k] : ''}"
                style="font-size:12.5px;padding:7px 9px;${isOver ? 'border-color:rgba(180,120,40,.55);background:rgba(240,180,80,.08)' : ''}"
                oninput="_estRateField('${k}',this.value)">
            </div>`;
          }).join('')}
        </div>
        ${nOver ? `<button type="button" style="margin-top:10px;border:none;background:transparent;font-size:11.5px;color:#B4482E;cursor:pointer;text-decoration:underline" onclick="_estRatesReset()">Reset all to company defaults</button>` : ''}
      </div>` : ''}
    </div>`;
}

function _estRatesToggle() {
  const cd = _estEngineData();
  cd._rates_open = !cd._rates_open;
  _estRenderRates();
}
function _estRateField(k, v) {
  const cd = _estEngineData();
  if (!cd.rates || typeof cd.rates !== 'object') cd.rates = {};
  if (v === '' || v == null || isNaN(Number(v))) delete cd.rates[k]; else cd.rates[k] = Number(v);
  cd._rates_open = true;
  // Live-update the header badge + rate summary in place (no re-render → input keeps focus)
  const wrap = document.getElementById('est-rates-wrap');
  if (wrap) {
    const btn = wrap.querySelector('button');
    if (btn) {
      const nOver = Object.keys(cd.rates).filter(x => cd.rates[x] !== '' && cd.rates[x] != null && !isNaN(Number(cd.rates[x]))).length;
      const spans = btn.querySelectorAll('span');
      // spans[1] = badge/"using company defaults", spans[2] = rate summary
      if (spans[1]) {
        if (nOver) {
          spans[1].textContent = `${nOver} custom rate${nOver !== 1 ? 's' : ''}`;
          spans[1].style.cssText = 'font-size:10.5px;font-weight:800;background:#F5E6C8;color:#8A5A18;padding:2px 9px;border-radius:99px';
        } else {
          spans[1].textContent = 'using company defaults';
          spans[1].style.cssText = 'font-size:11px;font-weight:600;color:var(--gw-text-subtle,#8A948C)';
        }
      }
      if (spans[2]) {
        const R = _estEngineRates(cd);
        spans[2].textContent = `Profit ${R.profit_pct}% · OHR ${_estFmt(R.ohr_rate)} · Labor ${_estFmt(R.labor_rate)} · Tax ${R.tax_pct}%`;
      }
    }
  }
  _estCalcTotals();          // re-runs engine + recurring + preview
  if (typeof _estRecurCalc === 'function' && _estDraft?.doc_type === 'recurring' && document.getElementById('est-recur-summary')) _estRecurCalc();
}
function _estRatesReset() {
  const cd = _estEngineData();
  cd.rates = {};
  _estRenderRates();
  _estCalcTotals();
  if (typeof _estRecurCalc === 'function' && _estDraft?.doc_type === 'recurring' && document.getElementById('est-recur-summary')) _estRecurCalc();
}
window._estRatesToggle = _estRatesToggle;
window._estRateField = _estRateField;
window._estRatesReset = _estRatesReset;

function _estEngineField(k, v) {
  const cd = _estEngineData();
  cd[k] = v;
  _estEngineCalc();
}

// Apply the engine's recommended selling price to the quote by scaling line
// item rates proportionally (keeps the customer-facing breakdown intact).
function _estEngineApplyPrice() {
  const cd = _estDraft?.cost_data;
  const target = cd?.rollup?.selling_price;
  if (!target || !_estDraft) return;
  const items = _estDraft.line_items || [];
  const current = items.reduce((s, li) => s + Number(li.qty || 1) * Number(li.rate || 0), 0);
  if (current > 0) {
    const k = target / current;
    for (const li of items) { li.rate = Math.round(Number(li.rate || 0) * k * 100) / 100; li.total = (li.qty || 1) * li.rate; }
  } else if (items.length) {
    // Distribute evenly by cost weight, or flat if no costs
    const costs = items.map(li => Number(li.qty || 1) * Number(li.unit_cost || 0));
    const costSum = costs.reduce((a, b) => a + b, 0);
    items.forEach((li, i) => {
      const share = costSum > 0 ? costs[i] / costSum : 1 / items.length;
      li.rate = Math.round((target * share / Number(li.qty || 1)) * 100) / 100;
      li.total = (li.qty || 1) * li.rate;
    });
  } else {
    _estDraft.line_items = [{ id: _estUID(), name: _estDraft.title || 'Project total', desc: '', qty: 1, rate: Math.round(target * 100) / 100, total: target }];
  }
  _estRenderLineRows();
  _estCalcTotals();
  if (typeof showToast === 'function') showToast('Quote priced from the cost engine', 'success');
}
window._estEngineField = _estEngineField;
window._estEngineApplyPrice = _estEngineApplyPrice;

// ═══════════════════════════════════════════════════════════════════════════
// RECURRING CONTRACT CALCULATOR — replaces the maintenance TEMPLATE sheets.
// Each service: materials + man-hrs × (maint labor + maint OHR), × visits/year.
// Yearly total → profit → selling → ÷12 monthly, with escalation years 2-3.
// ═══════════════════════════════════════════════════════════════════════════

function _estRecurData() {
  if (!_estDraft.recurring_data || typeof _estDraft.recurring_data !== 'object') _estDraft.recurring_data = {};
  const rd = _estDraft.recurring_data;
  if (!Array.isArray(rd.services)) rd.services = [];
  if (rd.years == null) rd.years = 3;
  return rd;
}

function _estRenderRecurring() {
  const wrap = document.getElementById('est-recurring-wrap');
  if (!wrap || !_estDraft) return;
  const rd = _estRecurData();
  const rows = rd.services.map((s, i) => `
    <div style="display:grid;grid-template-columns:2fr .9fr .9fr .9fr 1fr 30px;gap:8px;align-items:center;margin-bottom:8px">
      <input class="est-input" placeholder="Service (e.g. Mowing, Mulch refresh, Spring cleanup)" value="${_estEsc(s.name || '')}" style="font-size:12.5px" oninput="_estRecurField(${i},'name',this.value)">
      <input class="est-input" type="number" min="0" step="1" placeholder="Visits/yr" title="Visits per year" value="${s.occurrences ?? ''}" style="font-size:12.5px" oninput="_estRecurField(${i},'occurrences',parseFloat(this.value)||0)">
      <input class="est-input" type="number" min="0" step="0.1" placeholder="Man-hrs" title="Man-hours per visit" value="${s.man_hours ?? ''}" style="font-size:12.5px" oninput="_estRecurField(${i},'man_hours',parseFloat(this.value)||0)">
      <input class="est-input" type="number" min="0" step="0.01" placeholder="Mat $/visit" title="Materials $ per visit" value="${s.materials ?? ''}" style="font-size:12.5px" oninput="_estRecurField(${i},'materials',parseFloat(this.value)||0)">
      <span id="est-recur-line-${i}" style="text-align:right;font-size:12px;font-weight:700;font-variant-numeric:tabular-nums;color:var(--gw-text-subtle,#5A675F)"></span>
      <button type="button" style="border:none;background:none;color:#B4482E;cursor:pointer;font-size:15px" onclick="_estRecurRemove(${i})">×</button>
    </div>`).join('');
  wrap.innerHTML = `
    <div style="display:grid;grid-template-columns:2fr .9fr .9fr .9fr 1fr 30px;gap:8px;font-size:10.5px;font-weight:800;text-transform:uppercase;letter-spacing:.04em;color:var(--gw-text-subtle,#8A948C);margin-bottom:5px">
      <span>Service</span><span>Visits / yr</span><span>Man-hrs / visit</span><span>Materials $ / visit</span><span style="text-align:right">Yearly cost</span><span></span>
    </div>
    ${rows || '<div style="font-size:12.5px;color:var(--gw-text-subtle,#8A948C);padding:6px 0">No services yet — add each recurring service below.</div>'}
    <button type="button" class="est-btn-secondary" style="font-size:12.5px;margin:6px 0 12px" onclick="_estRecurAdd()">+ Add service</button>
    <div id="est-recur-rates" style="margin-bottom:10px"></div>
    <div id="est-recur-summary" style="background:var(--gw-bg,#FAF8F3);border:1px solid var(--gw-border,#EEE9DF);border-radius:10px;padding:14px 16px"></div>`;
  _estRecurRenderRates();
  _estRecurCalc();
}

// Effective recurring rates: company defaults overridable per-estimate via rd.rates
function _estRecurRates(rd) {
  const ps = _estPS || {};
  const o = (rd && rd.rates) || {};
  const pick = (k, d) => { const v = o[k]; return (v === '' || v == null || isNaN(Number(v))) ? Number(ps[k] ?? d) : Number(v); };
  return {
    maint_labor_rate: pick('maint_labor_rate', 26.83), maint_ohr_rate: pick('maint_ohr_rate', 22.62),
    maint_profit_pct: pick('maint_profit_pct', 22), escalation_pct: pick('escalation_pct', 3),
    tax_pct: pick('tax_pct', 6),
  };
}
function _estRecurRateField(k, v) {
  const rd = _estRecurData();
  if (!rd.rates || typeof rd.rates !== 'object') rd.rates = {};
  if (v === '' || v == null || isNaN(Number(v))) delete rd.rates[k]; else rd.rates[k] = Number(v);
  _estRecurCalc();
  if (typeof _estPvQueue === 'function') _estPvQueue();
}
window._estRecurRateField = _estRecurRateField;

// Rates panel for the recurring calculator — rendered once (not on every calc)
// so typing in a rate field never loses focus.
function _estRecurRenderRates() {
  const wrap = document.getElementById('est-recur-rates');
  if (!wrap || !_estDraft) return;
  const rd = _estRecurData();
  const ps = _estPS || {};
  const ov = rd.rates || {};
  const defaults = { maint_labor_rate: 26.83, maint_ohr_rate: 22.62, maint_profit_pct: 22, escalation_pct: 3, tax_pct: 6 };
  const fields = [
    ['maint_labor_rate', 'Maint. labor $/hr'], ['maint_ohr_rate', 'Maint. OHR $/hr'],
    ['maint_profit_pct', 'Profit %'], ['escalation_pct', 'Escalation %/yr'], ['tax_pct', 'Materials tax %'],
  ];
  const nOver = fields.filter(([k]) => ov[k] !== '' && ov[k] != null && !isNaN(Number(ov[k]))).length;
  wrap.innerHTML = `
    <div style="border:1px solid ${nOver ? 'rgba(180,120,40,.45)' : 'var(--gw-border,#EEE9DF)'};border-radius:10px;padding:11px 14px;background:${nOver ? 'rgba(240,180,80,.06)' : 'var(--gw-surface,#fff)'}">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
        <span style="font-size:12px;font-weight:800">Rates for this contract</span>
        ${nOver
          ? `<span style="font-size:10.5px;font-weight:800;background:#F5E6C8;color:#8A5A18;padding:2px 9px;border-radius:99px">${nOver} custom</span>`
          : `<span style="font-size:11px;font-weight:600;color:var(--gw-text-subtle,#8A948C)">using company defaults</span>`}
        <span style="margin-left:auto;font-size:11px;color:var(--gw-text-subtle,#8A948C)">blank = default from <a href="javascript:void(0)" onclick="show&&show('pricing')" style="color:var(--gw-action,#2D7A55);font-weight:700">Job Cost Settings</a></span>
      </div>
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:9px">
        ${fields.map(([k, label]) => {
          const isOver = ov[k] !== '' && ov[k] != null && !isNaN(Number(ov[k]));
          const defVal = Number(ps[k] ?? defaults[k]);
          return `
          <div>
            <label style="font-size:11px;font-weight:700;display:block;margin-bottom:2px;${isOver ? 'color:#8A5A18' : ''}">${label}${isOver ? ' ✎' : ''}</label>
            <input class="est-input" type="number" min="0" step="any" placeholder="${defVal}" value="${isOver ? ov[k] : ''}"
              style="font-size:12px;padding:6px 8px;${isOver ? 'border-color:rgba(180,120,40,.55);background:rgba(240,180,80,.08)' : ''}"
              oninput="_estRecurRateField('${k}',this.value)">
          </div>`;
        }).join('')}
      </div>
    </div>`;
}
window._estRecurRenderRates = _estRecurRenderRates;

function _estRecurCalc() {
  const rd = _estRecurData();
  const RR = _estRecurRates(rd);
  const laborR = RR.maint_labor_rate, ohrR = RR.maint_ohr_rate;
  const profitPct = RR.maint_profit_pct, escPct = RR.escalation_pct;
  const taxPct = RR.tax_pct;
  const _rOver = (k) => { const o = (rd.rates || {})[k]; return o !== '' && o != null && !isNaN(Number(o)); };

  let yearlyCost = 0, yearlyHours = 0;
  rd.services.forEach((s, i) => {
    const occ = Number(s.occurrences || 0), mh = Number(s.man_hours || 0), mat = Number(s.materials || 0);
    const perVisit = mat * (1 + taxPct / 100) + mh * (laborR + ohrR);
    const yr = perVisit * occ;
    yearlyCost += yr;
    yearlyHours += mh * occ;
    const el = document.getElementById(`est-recur-line-${i}`);
    if (el) el.textContent = yr > 0 ? _estFmt(yr) : '—';
  });
  const profit = yearlyCost * profitPct / 100;
  const selling = yearlyCost + profit;
  const monthly = selling / 12;
  const years = Math.max(1, Math.min(5, Number(rd.years || 3)));
  let escRows = '';
  for (let y = 1; y <= years; y++) {
    const f = Math.pow(1 + escPct / 100, y - 1);
    escRows += `<div style="display:flex;justify-content:space-between;font-size:12.5px;padding:2px 0"><span>Year ${y}${y > 1 ? ` (+${escPct}%/yr)` : ''}</span><span style="font-variant-numeric:tabular-nums"><b>${_estFmt(selling * f)}</b> / yr · ${_estFmt(selling * f / 12)} / mo</span></div>`;
  }
  rd.rollup = { yearly_cost: yearlyCost, yearly_hours: yearlyHours, profit, yearly_selling: selling, monthly, escalation_pct: escPct, years };

  const sm = document.getElementById('est-recur-summary');
  if (sm) sm.innerHTML = `
    <div style="display:flex;justify-content:space-between;font-size:12.5px;padding:3px 0"><span>Yearly break-even (materials + tax + labor ${_estFmt(laborR)} + OHR ${_estFmt(ohrR)})</span><span style="font-variant-numeric:tabular-nums">${_estFmt(yearlyCost)}</span></div>
    <div style="display:flex;justify-content:space-between;font-size:12.5px;padding:3px 0"><span>Profit (${profitPct}%)</span><span style="font-variant-numeric:tabular-nums">${_estFmt(profit)}</span></div>
    <div style="display:flex;justify-content:space-between;font-size:13px;font-weight:800;padding:7px 0 3px;border-top:1.5px solid var(--gw-border,#DDD8CE);margin-top:4px"><span>CONTRACT PRICE</span><span style="font-variant-numeric:tabular-nums">${_estFmt(selling)} / yr — ${_estFmt(monthly)} / month</span></div>
    <div style="font-size:11px;color:var(--gw-text-subtle,#8A948C);margin:2px 0 8px">${yearlyHours.toFixed(1)} man-hours per year across ${rd.services.length} service${rd.services.length !== 1 ? 's' : ''}</div>
    ${escRows}
    <div style="display:flex;gap:8px;align-items:center;margin-top:10px;flex-wrap:wrap">
      <label style="font-size:11.5px;font-weight:700">Contract years <input type="number" min="1" max="5" value="${years}" style="width:52px;padding:4px 6px;border:1px solid var(--gw-border,#DDD8CE);border-radius:6px;font-size:12px" oninput="_estRecurYears(parseInt(this.value)||3)"></label>
      <button type="button" class="est-btn-secondary" style="font-size:12px" onclick="_estRecurApply()">Use ${_estFmt(monthly)}/mo as the quote →</button>
    </div>`;
}

function _estRecurAdd() { _estRecurData().services.push({ name: '', occurrences: 0, man_hours: 0, materials: 0 }); _estRenderRecurring(); }
function _estRecurRemove(i) { _estRecurData().services.splice(i, 1); _estRenderRecurring(); }
function _estRecurField(i, k, v) { const rd = _estRecurData(); if (rd.services[i]) { rd.services[i][k] = v; _estRecurCalc(); } }
function _estRecurYears(y) { _estRecurData().years = y; _estRecurCalc(); }
function _estRecurApply() {
  const rd = _estRecurData();
  const r = rd.rollup;
  if (!r || !r.monthly || !_estDraft) return;
  _estDraft.line_items = rd.services.filter(s => (s.name || '').trim()).map(s => {
    const occ = Number(s.occurrences || 0);
    const RR = _estRecurRates(rd);
    const perVisit = Number(s.materials || 0) * (1 + RR.tax_pct / 100) + Number(s.man_hours || 0) * (RR.maint_labor_rate + RR.maint_ohr_rate);
    const sell = perVisit * (1 + RR.maint_profit_pct / 100);
    return { id: _estUID(), name: s.name, desc: `${occ} visit${occ !== 1 ? 's' : ''} per year`, qty: occ, rate: Math.round(sell * 100) / 100, total: occ * sell };
  });
  _estDraft.customer_notes = (_estDraft.customer_notes || '').includes('per month') ? _estDraft.customer_notes :
    `Contract price: ${_estFmt(r.yearly_selling)} per year, billed at ${_estFmt(r.monthly)} per month.` + (r.years > 1 ? ` Years 2–${r.years} escalate ${r.escalation_pct}% annually.` : '') + (_estDraft.customer_notes ? '\n\n' + _estDraft.customer_notes : '');
  _estRenderLineRows();
  _estCalcTotals();
  const notesEl = document.getElementById('est-customer-notes');
  if (notesEl) notesEl.value = _estDraft.customer_notes;
  if (typeof showToast === 'function') showToast('Contract pricing applied to the quote', 'success');
}
window._estRecurAdd = _estRecurAdd; window._estRecurRemove = _estRecurRemove;
window._estRecurField = _estRecurField; window._estRecurYears = _estRecurYears;
window._estRecurApply = _estRecurApply;

// ═══════════════════════════════════════════════════════════════════════════
// ✨ AI QUOTE GENERATOR — reads the lead's conversations + the price book and
// drafts a tiered quote. Review-before-apply: nothing touches the draft until
// the user clicks Apply.
// ═══════════════════════════════════════════════════════════════════════════

let _estAiResult = null;

function _estOpenAiGen() {
  if (!_estDraft) return;
  const old = document.getElementById('est-ai-modal'); if (old) old.remove();
  const div = document.createElement('div');
  div.id = 'est-ai-modal';
  div.style.cssText = 'position:fixed;inset:0;background:rgba(20,26,22,.45);z-index:1000;display:flex;align-items:center;justify-content:center;padding:20px';
  div.onclick = e => { if (e.target === div) div.remove(); };
  div.innerHTML = `
    <div style="background:var(--gw-surface,#fff);border-radius:14px;max-width:680px;width:100%;max-height:88vh;overflow:auto;padding:22px;box-shadow:0 18px 50px rgba(0,0,0,.25)">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:4px">
        <h2 style="font-size:17px;font-weight:800;margin:0">✨ AI Quote Generator</h2>
        <button onclick="document.getElementById('est-ai-modal').remove()" style="border:none;background:none;font-size:20px;cursor:pointer;color:var(--gw-text-subtle,#8A948C)">✕</button>
      </div>
      <div style="font-size:12.5px;color:var(--gw-text-subtle,#8A948C);margin-bottom:14px">
        Reads the linked lead's conversation history (calls, emails, texts), matches the work to your price book and job-cost formulas, and drafts a quote${_estDraft.opp_id ? '' : ' — <b>no lead linked</b>, so describe the job below'}.
      </div>
      <label style="font-size:12px;font-weight:700;display:block;margin-bottom:3px">Extra notes for the AI (optional)</label>
      <textarea id="est-ai-notes" class="est-input" rows="3" placeholder="e.g. ~2,000 sqft of beds, customer wants low-maintenance plants, sloped backyard with drainage issue…"></textarea>
      <div style="display:flex;gap:16px;align-items:center;margin:12px 0;flex-wrap:wrap">
        <label style="font-size:12.5px;font-weight:700">Options
          <select id="est-ai-tiers" class="est-input" style="width:auto;display:inline-block;margin-left:6px;padding:6px 10px;font-size:12.5px">
            <option value="1">Single price</option>
            <option value="2">2 tiers</option>
            <option value="3" selected>3 tiers (Good / Better / Best)</option>
          </select>
        </label>
        <label style="font-size:12.5px;display:flex;gap:6px;align-items:center;cursor:pointer"><input type="checkbox" id="est-ai-market"> Include market-rate sanity check</label>
      </div>
      <div id="est-ai-result"></div>
      <div id="est-ai-err" style="display:none;margin:10px 0;padding:9px 12px;background:#FBEDEA;color:#A6543F;border-radius:8px;font-size:12.5px"></div>
      <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:12px">
        <button class="est-btn-secondary" onclick="document.getElementById('est-ai-modal').remove()">Cancel</button>
        <button class="est-btn-primary" id="est-ai-go" onclick="_estAiRun()">Generate Quote</button>
      </div>
    </div>`;
  document.body.appendChild(div);
}

async function _estAiRun() {
  const btn = document.getElementById('est-ai-go');
  const errEl = document.getElementById('est-ai-err');
  if (errEl) errEl.style.display = 'none';
  if (btn) { btn.disabled = true; btn.textContent = 'Thinking… (up to 60s)'; }
  try {
    const r = await fetch('/api/ai/generate-quote', {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        opp_id: _estDraft.opp_id || null,
        notes: (document.getElementById('est-ai-notes') || {}).value || '',
        tier_count: parseInt((document.getElementById('est-ai-tiers') || {}).value || '3'),
        market_check: !!(document.getElementById('est-ai-market') || {}).checked,
        doc_type: _estDraft.doc_type || 'onetime',
      }),
    });
    const j = await r.json();
    if (!r.ok || !j.ok) throw new Error(j.message || j.error || 'Generation failed');
    _estAiResult = j.data;
    _estAiRenderResult();
  } catch (e) {
    if (errEl) { errEl.textContent = e.message || 'Generation failed'; errEl.style.display = 'block'; }
  }
  if (btn) { btn.disabled = false; btn.textContent = 'Regenerate'; }
}

function _estAiRenderResult() {
  const box = document.getElementById('est-ai-result');
  const d = _estAiResult;
  if (!box || !d) return;
  const tiers = d.tiers || [];
  box.innerHTML = `
    <div style="border:1px solid var(--gw-border,#DDD8CE);border-radius:12px;padding:16px;margin-top:6px">
      <div style="font-size:14px;font-weight:800;margin-bottom:4px">${_estEsc(d.title || 'Generated quote')}</div>
      <div style="font-size:12.5px;color:var(--gw-text-subtle,#5A675F);margin-bottom:10px;white-space:pre-wrap">${_estEsc(d.scope_summary || '')}</div>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:10px">
        ${tiers.map(t => `
        <div style="border:1.5px solid ${t.recommended ? 'var(--gw-action,#2D7A55)' : 'var(--gw-border,#DDD8CE)'};border-radius:10px;padding:11px">
          <div style="font-size:12.5px;font-weight:800">${_estEsc(t.name)}${t.recommended ? ' ⭐' : ''}</div>
          <div style="font-size:16px;font-weight:800;margin:3px 0">${_estFmt(t.total)}</div>
          <div style="font-size:11px;color:var(--gw-text-subtle,#8A948C)">${(t.line_items || []).length} items · ${Number(t.man_hours || 0).toFixed(1)} man-hrs</div>
          <div style="font-size:11px;color:var(--gw-text-subtle,#8A948C);margin-top:3px">${_estEsc((t.desc || '').slice(0, 90))}</div>
        </div>`).join('')}
      </div>
      ${d.pricing_notes ? `<div style="font-size:11.5px;color:var(--gw-text-subtle,#6F7E6A);margin-top:10px;padding:9px 11px;background:var(--gw-bg,#F4F1EA);border-radius:8px;white-space:pre-wrap">${_estEsc(d.pricing_notes)}</div>` : ''}
      <div style="display:flex;gap:8px;margin-top:12px;flex-wrap:wrap">
        <button class="est-btn-primary" style="font-size:12.5px" onclick="_estAiApply()">✓ Apply to this estimate</button>
        ${d.email ? `<span style="font-size:11.5px;color:var(--gw-text-subtle,#8A948C);align-self:center">Email + SMS drafts included — saved to notes on apply</span>` : ''}
      </div>
    </div>`;
}

function _estAiApply() {
  const d = _estAiResult;
  if (!d || !_estDraft) return;
  const tiers = d.tiers || [];
  const rec = tiers.find(t => t.recommended) || tiers[0];

  if (d.title && !_estDraft.title) _estDraft.title = d.title;
  if (d.scope_summary) _estDraft.scope_of_work = d.scope_summary;

  if (tiers.length > 1) {
    // Multi-tier → advanced mode with option tiers; recommended tier's items as main lines
    _estDraft.mode = 'advanced';
    _estDraft.tiers = tiers.map(t => ({ id: t.id || _estUID(), name: t.name, desc: t.desc || '', line_items: t.line_items || [], total: Number(t.total || 0), recommended: !!t.recommended }));
  }
  if (rec) {
    _estDraft.line_items = (rec.line_items || []).map(li => ({
      id: li.id || _estUID(), name: li.name || '', desc: li.note || '',
      qty: Number(li.qty || 1), rate: Number(li.rate || 0),
      total: Number(li.qty || 1) * Number(li.rate || 0),
      price_item_id: li.price_item_id || null,
      unit: li.unit || '', unit_cost: Number(li.unit_cost || 0), unit_time: Number(li.unit_time || 0),
    }));
  }
  // Stash comms drafts + meta
  if (d.email || d.sms) {
    const drafts = [d.email ? `— AI email draft —\nSubject: ${d.email.subject}\n${d.email.body}` : '', d.sms ? `— AI SMS draft —\n${d.sms}` : ''].filter(Boolean).join('\n\n');
    _estDraft.internal_notes = drafts + (_estDraft.internal_notes ? '\n\n' + _estDraft.internal_notes : '');
  }
  _estDraft.ai_meta = d.ai_meta || { generated: true, at: new Date().toISOString() };

  document.getElementById('est-ai-modal')?.remove();
  _estRenderBuilder();
  if (typeof showToast === 'function') showToast('AI quote applied — review every number before sending', 'success');
}
window._estOpenAiGen = _estOpenAiGen;
window._estAiRun = _estAiRun;
window._estAiApply = _estAiApply;

// ═══════════════════════════════════════════════════════════════════════════
// CONVERT TO JOB — estimate → work order (+ scheduling)
// ═══════════════════════════════════════════════════════════════════════════

async function _estConvertToJob(estId) {
  if (!confirm('Create a work order (job) from this estimate? Materials and budgeted hours carry over.')) return;
  return _estDoConvertToJob(estId, {});
}
window._estConvertToJob = _estConvertToJob;

// Schedule to Job — one-click scheduling from the estimate detail page.
// If the client hasn't accepted yet, the job is created as a YELLOW "hold";
// it flips GREEN (scheduled) automatically the moment the client accepts.
function _estScheduleToJob(estId, status) {
  const isAccepted = status === 'accepted' || status === 'approved' || status === 'invoiced';
  document.getElementById('est-sched-modal')?.remove();
  const modal = document.createElement('div');
  modal.id = 'est-sched-modal';
  modal.className = 'est-modal-overlay';
  modal.innerHTML = `
  <div class="est-modal" style="max-width:440px" onclick="event.stopPropagation()">
    <div class="est-modal-header">
      <h3 style="display:flex;align-items:center;gap:8px;margin:0">
        <span class="est-traffic-dot ${isAccepted ? 'est-traffic-dot--green' : 'est-traffic-dot--yellow'}" style="width:12px;height:12px"></span>
        Schedule to Job
      </h3>
      <button class="est-modal-close" onclick="document.getElementById('est-sched-modal').remove()">✕</button>
    </div>
    <div class="est-modal-body">
      ${!isAccepted ? `
      <div style="background:var(--gw-warning-bg,#FEF7E0);border:1px solid var(--gw-warning-border,#F5D889);border-radius:8px;padding:10px 12px;font-size:12.5px;line-height:1.5;margin-bottom:14px;color:var(--gw-warning,#8B6914)">
        <strong>Hold:</strong> the client hasn't accepted yet, so this day will be reserved with a <strong style="color:#B45309">yellow hold</strong> on the schedule. It turns <strong style="color:#15803D">green</strong> automatically when they accept — and is released if they decline.
      </div>` : `
      <div style="background:var(--gw-emerald-tint,#E7F4EC);border:1px solid var(--gw-emerald-border,#BBDFC9);border-radius:8px;padding:10px 12px;font-size:12.5px;line-height:1.5;margin-bottom:14px;color:var(--gw-emerald,#1A6042)">
        Estimate accepted — this job will be scheduled as <strong>confirmed (green)</strong>.
      </div>`}
      <label style="display:block;font-size:12px;font-weight:700;margin-bottom:4px">Date${isAccepted ? '' : ' to hold'}</label>
      <input type="date" id="est-sched-date" class="est-input" value="" style="margin-bottom:10px">
      <label style="display:block;font-size:12px;font-weight:700;margin-bottom:4px">Start time (optional)</label>
      <input type="time" id="est-sched-time" class="est-input" style="margin-bottom:14px">
      <div style="display:flex;gap:8px;justify-content:flex-end">
        <button class="est-btn-ghost" onclick="document.getElementById('est-sched-modal').remove()">Cancel</button>
        <button class="est-btn-primary" id="est-sched-go" onclick="_estSchedSubmit('${_estEsc(estId)}', ${isAccepted ? 'false' : 'true'})">
          ${isAccepted ? 'Schedule Job' : 'Place Hold on Day'}
        </button>
      </div>
    </div>
  </div>`;
  modal.onclick = () => modal.remove();
  document.body.appendChild(modal);
  setTimeout(() => document.getElementById('est-sched-date')?.focus(), 60);
}
window._estScheduleToJob = _estScheduleToJob;

async function _estSchedSubmit(estId, hold) {
  const date = document.getElementById('est-sched-date')?.value || '';
  const time = document.getElementById('est-sched-time')?.value || '';
  if (!date) { showToast('Pick a date first', 'error'); return; }
  document.getElementById('est-sched-modal')?.remove();
  return _estDoConvertToJob(estId, { scheduled_date: date, scheduled_time: time || null, hold: !!hold });
}
window._estSchedSubmit = _estSchedSubmit;

async function _estDoConvertToJob(estId, body) {
  try {
    const r = await fetch(`/api/estimates/${estId}/convert-to-job`, {
      method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}),
    });
    const j = await r.json();
    if (r.status === 409) { showToast('Already converted — opening the existing work order', 'info'); if (j.work_order_id && typeof workOrderDetail === 'function') workOrderDetail(j.work_order_id); return; }
    if (!r.ok || !j.ok) throw new Error(j.error || 'Conversion failed');
    if (typeof window.gwAudit === 'function') window.gwAudit({ type: 'estimate_converted_job', entityType: 'estimate', entityId: estId, entityLabel: j.wo_number });
    if (window._sbState) window._sbState.loaded = false; // refresh schedule board data
    showToast(j.hold ? `${j.wo_number} placed on HOLD — turns green when the client accepts` : `Work order ${j.wo_number} created!`, 'success');
    setTimeout(() => estimateDetail(estId), 700);
  } catch (e) {
    showToast(e.message || 'Could not convert to job', 'error');
  }
}
window._estDoConvertToJob = _estDoConvertToJob;

// ═══════════════════════════════════════════════════════════════════════════
// BUILDER TABS — "Document" (customer-facing) vs "Pricing Workbench" (internal)
// ═══════════════════════════════════════════════════════════════════════════

let _estBuilderTab = 'document';

function _estSetBuilderTab(t) {
  _estBuilderTab = t === 'workbench' ? 'workbench' : 'document';
  _estRenderBuilder();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}
window._estSetBuilderTab = _estSetBuilderTab;

// ═══════════════════════════════════════════════════════════════════════════
// LIVE PREVIEW — branded customer document rendered side-by-side, debounced
// ═══════════════════════════════════════════════════════════════════════════

function _estPvEnabled() {
  try { return localStorage.getItem('gw_est_pv') !== '0'; } catch (e) { return true; }
}
function _estTogglePv() {
  try { localStorage.setItem('gw_est_pv', _estPvEnabled() ? '0' : '1'); } catch (e) {}
  _estRenderBuilder();
}
window._estTogglePv = _estTogglePv;

let _estPvBrand = null;
async function _estPvBrandEnsure() {
  if (_estPvBrand) { _estPvRender(); return _estPvBrand; }
  // Prefer already-loaded app branding
  if (window._scBrand && window._scBrand.name) { _estPvBrand = { ...window._scBrand }; _estPvRender(); return _estPvBrand; }
  try {
    const r = await fetch('/api/company/branding', { credentials: 'include' });
    if (r.ok) {
      const raw = await r.json();
      const bd = (raw && raw.data) ? raw.data : raw;
      if (bd && bd.name !== undefined) _estPvBrand = bd;
    }
  } catch (e) {}
  if (!_estPvBrand) _estPvBrand = {};
  _estPvRender();
  return _estPvBrand;
}

let _estPvTimer = null;
function _estPvQueue() {
  if (!document.getElementById('est-pv-doc')) return;
  clearTimeout(_estPvTimer);
  _estPvTimer = setTimeout(_estPvRender, 250);
}
window._estPvQueue = _estPvQueue;

function _estPvRender() {
  const box = document.getElementById('est-pv-doc');
  if (!box || !_estDraft) return;
  const brand = _estPvBrand || (window._scBrand && window._scBrand.name ? window._scBrand : {}) || {};
  // Snapshot the draft with normalized arrays so the shared renderer is safe
  const est = { ..._estDraft };
  est.line_items = Array.isArray(est.line_items) ? est.line_items : [];
  est.attachments = Array.isArray(est.attachments) ? est.attachments : [];
  est.tiers = Array.isArray(est.tiers) ? est.tiers : [];
  box.innerHTML = _estPortalContentHtml(est, brand, false);
}
window._estPvRender = _estPvRender;

// ═══════════════════════════════════════════════════════════════════════════
// PRICING WORKBENCH — internal cost table (mirrors the estimate spreadsheet):
// each line item with its price-book cost, unit time, extended cost and hours.
// ═══════════════════════════════════════════════════════════════════════════

function _estRenderWbLines() {
  const wrap = document.getElementById('est-wb-lines');
  if (!wrap || !_estDraft) return;
  const items = _estDraft.line_items || [];
  if (!items.length) {
    wrap.innerHTML = `<div style="border:1px dashed var(--gw-border,#DDD8CE);border-radius:10px;padding:20px;text-align:center;font-size:12.5px;color:var(--gw-text-subtle,#8A948C)">No line items yet — add them on the <a href="javascript:void(0)" onclick="_estSetBuilderTab('document')" style="color:var(--gw-action,#2D7A55);font-weight:700">document tab</a> (type a name to pull from the price book), or add a costed row here.</div>
    <button type="button" class="est-add-line-btn" onclick="_estWbAddLine()" style="margin-top:10px">+ Add costed line</button>`;
    return;
  }
  const head = (t, align) => `<span style="font-size:10.5px;font-weight:800;text-transform:uppercase;letter-spacing:.04em;color:var(--gw-text-subtle,#8A948C);${align ? 'text-align:right' : ''}">${t}</span>`;
  const GRID = '2fr .95fr .8fr .6fr .85fr .75fr .85fr .85fr 26px';
  const groupOptions = _estWbGroups();

  // Group lines like the spreadsheet sections (Landscaping / Hardscaping / Misc / Equipment)
  const groups = [];
  const byGroup = {};
  items.forEach((li, i) => {
    const g = (li.group || '').trim() || 'General';
    if (!byGroup[g]) { byGroup[g] = []; groups.push(g); }
    byGroup[g].push(i);
  });

  let totCost = 0, totHours = 0;
  const row = (i) => {
    const li = items[i];
    const qty = Number(li.qty || 1), uc = Number(li.unit_cost || 0), ut = Number(li.unit_time || 0);
    const extCost = qty * uc, extHrs = qty * ut;
    return `
    <div style="display:grid;grid-template-columns:${GRID};gap:7px;align-items:center;margin-bottom:7px">
      <div style="position:relative">
        <input class="est-input" style="font-size:12.5px" placeholder="Item — type to search price book" autocomplete="off" value="${_estEsc(li.name || '')}"
          oninput="_estUpdateLine(${i},'name',this.value);_estPBSuggest(${i},this.value)"
          onblur="setTimeout(()=>{const s=document.getElementById('est-pb-suggest-${i}');if(s)s.innerHTML='';},250)">
        <div id="est-pb-suggest-${i}" style="position:absolute;top:100%;left:0;right:0;z-index:50"></div>
      </div>
      <select class="est-input" title="Cost section (like your sheet's sections)" style="font-size:12px;padding:7px 6px" onchange="_estWbSetGroup(${i},this.value)">
        ${groupOptions.map(g => `<option value="${_estEsc(g)}" ${((li.group||'').trim()||'General')===g?'selected':''}>${_estEsc(g)}</option>`).join('')}
        <option value="__new__">+ New section…</option>
      </select>
      <select class="est-input" style="font-size:12px;padding:7px 6px" onchange="_estWbField(${i},'item_type',this.value)">
        ${['material','plant','labor','equipment','service'].map(t => `<option value="${t}" ${(li.item_type||'material')===t?'selected':''}>${t.charAt(0).toUpperCase()+t.slice(1)}</option>`).join('')}
      </select>
      <input class="est-input" type="number" min="0" step="0.1" title="Quantity" value="${li.qty ?? 1}" style="font-size:12.5px" oninput="_estUpdateLine(${i},'qty',this.value)">
      <input class="est-input" type="number" min="0" step="0.01" title="Unit cost (what YOU pay)" value="${li.unit_cost ?? ''}" placeholder="Unit cost" style="font-size:12.5px" oninput="_estWbField(${i},'unit_cost',parseFloat(this.value)||0)">
      <input class="est-input" type="number" min="0" step="0.05" title="Man-hours per unit" value="${li.unit_time ?? ''}" placeholder="Hrs/unit" style="font-size:12.5px" oninput="_estWbField(${i},'unit_time',parseFloat(this.value)||0)">
      <span style="text-align:right;font-size:12px;font-weight:700;font-variant-numeric:tabular-nums" id="est-wb-cost-${i}">${_estFmt(extCost)}</span>
      <span style="text-align:right;font-size:12px;font-variant-numeric:tabular-nums;color:var(--gw-text-subtle,#5A675F)" id="est-wb-hrs-${i}">${extHrs.toFixed(2)} h</span>
      <button type="button" style="border:none;background:none;color:#B4482E;cursor:pointer;font-size:15px" title="Remove line" onclick="_estRemoveLine(${i})">×</button>
    </div>`;
  };

  const sections = groups.map(g => {
    let gCost = 0, gHrs = 0;
    byGroup[g].forEach(i => {
      const li = items[i];
      const qty = Number(li.qty || 1);
      gCost += (li.item_type || 'material') === 'labor' ? 0 : qty * Number(li.unit_cost || 0);
      gHrs += qty * Number(li.unit_time || 0);
    });
    totCost += gCost; totHours += gHrs;
    return `
    <div style="border:1px solid var(--gw-border,#EEE9DF);border-radius:10px;padding:11px 12px 8px;margin-bottom:12px;background:var(--gw-surface,#fff)">
      <div style="font-size:11.5px;font-weight:800;text-transform:uppercase;letter-spacing:.05em;color:var(--gw-text,#2F3B33);margin-bottom:8px">${_estEsc(g)}</div>
      ${byGroup[g].map(row).join('')}
      <div style="display:grid;grid-template-columns:${GRID};gap:7px;border-top:1px dashed var(--gw-border,#DDD8CE);padding-top:7px">
        <span style="font-size:11.5px;font-weight:800;grid-column:1/7;background:rgba(240,220,120,.28);border-radius:5px;padding:3px 8px">Total ${_estEsc(g)}:</span>
        <span data-wbg-cost="${_estEsc(g)}" style="text-align:right;font-size:12px;font-weight:800;font-variant-numeric:tabular-nums;align-self:center">${_estFmt(gCost)}</span>
        <span data-wbg-hrs="${_estEsc(g)}" style="text-align:right;font-size:12px;font-weight:800;font-variant-numeric:tabular-nums;align-self:center">${gHrs.toFixed(2)} h</span><span></span>
      </div>
      <button type="button" class="est-add-line-btn" style="margin-top:8px;font-size:12px" onclick="_estWbAddLine('${_estEsc(g)}')">+ Add line to ${_estEsc(g)}</button>
    </div>`;
  }).join('');

  wrap.innerHTML = `
    <div style="display:grid;grid-template-columns:${GRID};gap:7px;margin-bottom:6px;padding:0 12px">
      ${head('Item / Material')}${head('Section')}${head('Type')}${head('Qty')}${head('Unit cost')}${head('Hrs / unit')}${head('Ext. cost', 1)}${head('Ext. hours', 1)}<span></span>
    </div>
    ${sections}
    <div style="display:grid;grid-template-columns:${GRID};gap:7px;border-top:2px solid var(--gw-text,#2F3B33);padding:9px 12px 0;margin-top:2px">
      <span style="font-size:12px;font-weight:900;grid-column:1/7">MATERIAL &amp; UNIT TOTALS — ALL SECTIONS</span>
      <span id="est-wb-grand-cost" style="text-align:right;font-size:12.5px;font-weight:900;font-variant-numeric:tabular-nums">${_estFmt(totCost)}</span>
      <span id="est-wb-grand-hrs" style="text-align:right;font-size:12.5px;font-weight:900;font-variant-numeric:tabular-nums">${totHours.toFixed(2)} h</span><span></span>
    </div>
    <div style="display:flex;gap:10px;align-items:center;margin-top:10px;flex-wrap:wrap">
      <button type="button" class="est-add-line-btn" onclick="_estWbAddLine()">+ Add costed line</button>
      <button type="button" class="est-btn-secondary" style="font-size:12px;padding:7px 11px" onclick="_estWbNewGroup()">+ New section</button>
      <span style="font-size:11.5px;color:var(--gw-text-subtle,#8A948C)">Items pull cost &amp; man-hours from the <a href="javascript:void(0)" onclick="show&&show('pricing')" style="color:var(--gw-action,#2D7A55);font-weight:700">price book</a> — import/export your whole price list there.</span>
    </div>`;
}

// Section (group) helpers — mirrors the spreadsheet's cost sections
const _EST_WB_DEFAULT_GROUPS = ['Landscaping', 'Hardscaping / Drainage', 'Miscellaneous', 'Equipment Rental'];
function _estWbGroups() {
  const set = [];
  const add = (g) => { g = (g || '').trim(); if (g && !set.includes(g)) set.push(g); };
  (_estDraft?.line_items || []).forEach(li => add(li.group || 'General'));
  if (!set.length) add('General');
  _EST_WB_DEFAULT_GROUPS.forEach(add);
  (_estPB || []).forEach(p => add(p.category));
  return set;
}
function _estWbSetGroup(i, g) {
  if (!_estDraft?.line_items?.[i]) return;
  if (g === '__new__') {
    const name = prompt('New section name (e.g. "Irrigation", "Lighting"):');
    if (!name || !name.trim()) { _estRenderWbLines(); return; }
    g = name.trim();
  }
  _estDraft.line_items[i].group = g;
  _estRenderWbLines();
  _estCalcTotals();
}
function _estWbNewGroup() {
  const name = prompt('New section name (e.g. "Irrigation", "Lighting"):');
  if (!name || !name.trim()) return;
  _estWbAddLine(name.trim());
}
window._estWbSetGroup = _estWbSetGroup;
window._estWbNewGroup = _estWbNewGroup;
window._estRenderWbLines = _estRenderWbLines;

function _estWbField(i, k, v) {
  if (!_estDraft?.line_items?.[i]) return;
  _estDraft.line_items[i][k] = v;
  // Update extended cells in place, then recalc the engine
  const li = _estDraft.line_items[i];
  const c = document.getElementById(`est-wb-cost-${i}`), h = document.getElementById(`est-wb-hrs-${i}`);
  if (c) c.textContent = _estFmt(Number(li.qty || 1) * Number(li.unit_cost || 0));
  if (h) h.textContent = (Number(li.qty || 1) * Number(li.unit_time || 0)).toFixed(2) + ' h';
  _estWbRefreshTotals();
  _estCalcTotals();
}

// Live-update section subtotals + grand totals without re-rendering (keeps input focus)
function _estWbRefreshTotals() {
  const items = _estDraft?.line_items || [];
  const per = {}; let tc = 0, th = 0;
  for (const li of items) {
    const g = (li.group || '').trim() || 'General';
    const qty = Number(li.qty || 1);
    const cost = (li.item_type || 'material') === 'labor' ? 0 : qty * Number(li.unit_cost || 0);
    const hrs = qty * Number(li.unit_time || 0);
    per[g] = per[g] || { c: 0, h: 0 }; per[g].c += cost; per[g].h += hrs;
    tc += cost; th += hrs;
  }
  document.querySelectorAll('[data-wbg-cost]').forEach(el => { const g = el.getAttribute('data-wbg-cost'); if (per[g]) el.textContent = _estFmt(per[g].c); });
  document.querySelectorAll('[data-wbg-hrs]').forEach(el => { const g = el.getAttribute('data-wbg-hrs'); if (per[g]) el.textContent = per[g].h.toFixed(2) + ' h'; });
  const gc = document.getElementById('est-wb-grand-cost'), gh = document.getElementById('est-wb-grand-hrs');
  if (gc) gc.textContent = _estFmt(tc);
  if (gh) gh.textContent = th.toFixed(2) + ' h';
}
window._estWbField = _estWbField;

function _estWbAddLine(group) {
  if (!_estDraft) return;
  _estDraft.line_items = _estDraft.line_items || [];
  _estDraft.line_items.push({ id: _estUID(), name: '', desc: '', qty: 1, rate: 0, total: 0, unit_cost: 0, unit_time: 0, item_type: 'material', group: group || 'General' });
  _estRenderWbLines();
}
window._estWbAddLine = _estWbAddLine;

// ═══════════════════════════════════════════════════════════════════════════
// ESTIMATE TEMPLATES — save/apply/delete full document templates.
// Reuses /api/proposal-templates storage with content.kind='estimate'.
// ═══════════════════════════════════════════════════════════════════════════

let _estTemplates = [];

function _estTplOptLabel(t) {
  const c = t.content || {};
  const bits = [];
  bits.push(c.mode === 'advanced' ? 'Proposal' : 'Simple');
  if (c.doc_type === 'recurring') bits.push('Recurring');
  if ((c.line_items || []).length) bits.push(`${c.line_items.length} line${c.line_items.length !== 1 ? 's' : ''}`);
  return `${t.name} — ${bits.join(' · ')}`;
}
window._estTplOptLabel = _estTplOptLabel;

async function _estTplLoad() {
  try {
    const r = await fetch('/api/proposal-templates', { credentials: 'include' });
    const j = await r.json();
    _estTemplates = (j.data || []).filter(t => t.content && t.content.kind === 'estimate');
  } catch (e) { _estTemplates = []; }
  return _estTemplates;
}

async function _estTplSave() {
  if (!_estDraft) return;
  const name = prompt('Template name (e.g. "Mulch Refresh — Standard", "Maintenance Contract"):', _estDraft.title || '');
  if (!name || !name.trim()) return;
  const d = _estDraft;
  const content = {
    kind: 'estimate',
    mode: d.mode || 'simple', doc_type: d.doc_type || 'onetime',
    title: d.title || '', scope_of_work: d.scope_of_work || '', overview: d.overview || '',
    line_items: (d.line_items || []).map(li => ({ ...li })),
    tiers: (d.tiers || []).map(t => ({ ...t })),
    recurring_data: d.recurring_data && Object.keys(d.recurring_data).length ? JSON.parse(JSON.stringify(d.recurring_data)) : {},
    cost_data: (() => { const cd = { ...(d.cost_data || {}) }; delete cd.rollup; delete cd._rates_open; return cd; })(),
    discount_pct: d.discount_pct || 0, tax_pct: d.tax_pct || 0, deposit_pct: d.deposit_pct ?? 30,
    payment_schedule: (d.payment_schedule || []).map(p => ({ ...p })),
    customer_notes: d.customer_notes || '', terms: d.terms || '',
  };
  try {
    const r = await fetch('/api/proposal-templates', {
      method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: name.trim(), description: 'Estimate template', content }),
    });
    if (!r.ok) throw new Error();
    await _estTplLoad();
    _estRenderBuilder();
    showToast(`Template "${name.trim()}" saved`, 'success');
  } catch (e) { showToast('Failed to save template', 'error'); }
}
window._estTplSave = _estTplSave;

function _estTplApply() {
  const sel = document.getElementById('est-tpl-select');
  const t = _estTemplates.find(x => x.id === sel?.value);
  if (!t) { showToast('Choose a template first', 'info'); return; }
  const c = t.content || {};
  if (!confirm(`Apply "${t.name}"? This fills the document content (title, scope, line items, pricing, notes, terms). Your customer selection is kept.`)) return;
  const d = _estDraft;
  d.mode = c.mode || 'simple';
  d.doc_type = c.doc_type || 'onetime';
  if (c.title) d.title = c.title;
  d.scope_of_work = c.scope_of_work || '';
  d.overview = c.overview || '';
  d.line_items = (c.line_items || []).map(li => ({ ...li, id: _estUID() }));
  d.tiers = (c.tiers || []).map(x => ({ ...x, id: _estUID() }));
  d.recurring_data = c.recurring_data ? JSON.parse(JSON.stringify(c.recurring_data)) : {};
  d.cost_data = c.cost_data ? { ...c.cost_data } : {};
  d.discount_pct = c.discount_pct || 0;
  d.tax_pct = c.tax_pct || 0;
  d.deposit_pct = c.deposit_pct ?? 30;
  d.payment_schedule = (c.payment_schedule || []).map(p => ({ ...p }));
  // Keep existing (e.g. company-default) terms/notes when the template has none
  d.customer_notes = c.customer_notes || d.customer_notes || '';
  d.terms = c.terms || d.terms || '';
  _estRenderBuilder();
  showToast(`Template "${t.name}" applied — review and adjust`, 'success');
}
window._estTplApply = _estTplApply;

async function _estTplDelete() {
  const sel = document.getElementById('est-tpl-select');
  const t = _estTemplates.find(x => x.id === sel?.value);
  if (!t) { showToast('Choose a template first', 'info'); return; }
  if (!confirm(`Delete template "${t.name}"? This cannot be undone.`)) return;
  try {
    await fetch(`/api/proposal-templates/${t.id}`, { method: 'DELETE', credentials: 'include' });
    await _estTplLoad();
    _estRenderBuilder();
    showToast('Template deleted', 'info');
  } catch (e) { showToast('Failed to delete', 'error'); }
}
window._estTplDelete = _estTplDelete;
