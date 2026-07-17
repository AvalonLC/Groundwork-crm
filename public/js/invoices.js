// ── Groundwork CRM — Invoices v2 ──────────────────────────────────────────────
// Redesigned to match Estimates aesthetic: KPI cards, full action rows,
// Stripe charge-on-file, resend, inline date edit, convert-from-estimate flow
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

/* ── Helpers ──────────────────────────────────────────────────────────────── */
function _invFmt(n) { return '$' + (Number(n)||0).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }
function _invDate(d) {
  if (!d) return '—';
  try { return new Date(d + (d.includes('T') ? '' : 'T00:00:00')).toLocaleDateString('en-US', { month:'short', day:'numeric', year:'numeric' }); }
  catch(e) { return d; }
}
function _invAgo(d) {
  if (!d) return '';
  const ms = Date.now() - new Date(d).getTime();
  const days = Math.floor(ms / 86400000);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 30) return `${days}d ago`;
  return _invDate(d.split('T')[0]);
}
function _invEsc(s) {
  return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}
function _invIsOverdue(inv) {
  return inv.due_date &&
    new Date(inv.due_date + 'T00:00:00') < new Date() &&
    ['sent','viewed','partial'].includes(inv.status);
}

/* ── Status config ──────────────────────────────────────────────────────────── */
const INV_STATUS = {
  draft:       { label:'Draft',       cls:'inv-badge--draft',    icon:'status-draft'    },
  sent:        { label:'Sent',        cls:'inv-badge--sent',     icon:'status-sent'     },
  viewed:      { label:'Viewed',      cls:'inv-badge--viewed',   icon:'status-viewed'   },
  partial:     { label:'Partial',     cls:'inv-badge--partial',  icon:'payment'         },
  paid:        { label:'Paid',        cls:'inv-badge--paid',     icon:'status-accepted' },
  overdue:     { label:'Overdue',     cls:'inv-badge--overdue',  icon:'status-expired'  },
  void:        { label:'Void',        cls:'inv-badge--void',     icon:'status-declined' },
  written_off: { label:'Written Off', cls:'inv-badge--void',     icon:'status-declined' },
};

function _invBadge(status) {
  const s = INV_STATUS[status] || { label: status||'Draft', cls:'inv-badge--draft', icon:'status-draft' };
  return `<span class="inv-badge ${s.cls}">${gwIcon(s.icon,10,'currentColor')}&thinsp;${s.label}</span>`;
}

/* ── State ──────────────────────────────────────────────────────────────────── */
let _invCurrentStatus = '';
let _invAllData = [];

/* ══════════════════════════════════════════════════════════════════════════════
   MAIN ENTRY POINT
══════════════════════════════════════════════════════════════════════════════ */
window.gwInvoices = function() {
  const panel = document.getElementById('view') ||
                document.getElementById('contentArea') ||
                document.getElementById('premiumContent');
  if (!panel) return;
  _invInjectCSS();
  panel.innerHTML = _invShell();
  _invLoadList();
};

/* ── Shell ──────────────────────────────────────────────────────────────────── */
function _invShell() {
  return `
<div class="gwp-shell inv-wrap">

  <!-- ── Header (approved premium style) ── -->
  <header class="gwp-header">
    <div class="gwp-header-left">
      <h1 class="gwp-title">Invoices</h1>
      <span class="gwp-subtitle" id="invSubtitle">Loading…</span>
    </div>
    <div class="gwp-header-actions">
      <button class="gwp-btn-primary" onclick="_invOpenBuilder(null)">
        ${gwIcon('plus',13,'#fff')} New Invoice
      </button>
    </div>
  </header>

  <!-- ── KPI Cards (approved premium style) ── -->
  <div class="gwp-kpi-row" id="invKpiRow">
    <div class="gwp-kpi-card inv-kpi-card--loading"><div class="inv-kpi-shimmer"></div></div>
    <div class="gwp-kpi-card inv-kpi-card--loading"><div class="inv-kpi-shimmer"></div></div>
    <div class="gwp-kpi-card inv-kpi-card--loading"><div class="inv-kpi-shimmer"></div></div>
    <div class="gwp-kpi-card inv-kpi-card--loading"><div class="inv-kpi-shimmer"></div></div>
  </div>

  <!-- ── Filter bar ── -->
  <div class="gwp-filter-bar">
    <div class="gwp-search-wrap">
      <svg class="gwp-search-icon" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="7" cy="7" r="5"/><path d="M14 14l-3.5-3.5"/></svg>
      <input id="invSearchInput" class="gwp-search-input" type="text"
        placeholder="Search client, invoice #, title…" oninput="_invLoadList()" autocomplete="off">
    </div>
    <div class="inv-chip-bar" id="invChipBar">
      <button class="gwp-chip gwp-chip--active" data-s="" onclick="_invSetChip(this,'')">All</button>
      <button class="gwp-chip" data-s="draft" onclick="_invSetChip(this,'draft')">Draft</button>
      <button class="gwp-chip" data-s="sent" onclick="_invSetChip(this,'sent')">Sent</button>
      <button class="gwp-chip" data-s="partial" onclick="_invSetChip(this,'partial')">Partial</button>
      <button class="gwp-chip" data-s="paid" onclick="_invSetChip(this,'paid')">Paid</button>
      <button class="gwp-chip" data-s="overdue" onclick="_invSetChip(this,'overdue')">Overdue</button>
    </div>
  </div>

  <!-- ── List body ── -->
  <div id="invListBody">
    <div class="inv-loading">${gwIcon('hourglass',20,'#9CA3AF')}&ensp;Loading invoices…</div>
  </div>

</div>`;
}

/* ── Chip filter ────────────────────────────────────────────────────────────── */
window._invSetChip = function(btn, status) {
  document.querySelectorAll('#invChipBar .gwp-chip').forEach(c => c.classList.remove('gwp-chip--active'));
  btn.classList.add('gwp-chip--active');
  _invCurrentStatus = status;
  _invLoadList();
};

/* ── Load + render list ─────────────────────────────────────────────────────── */
async function _invLoadList() {
  const search = (document.getElementById('invSearchInput')?.value || '').trim();
  const status = _invCurrentStatus;
  const url = `/api/invoices?limit=500${status ? '&status='+status : ''}${search ? '&q='+encodeURIComponent(search) : ''}`;
  try {
    const res = await fetch(url, { credentials:'include' });
    if (!res.ok) throw new Error('fetch failed');
    _invAllData = await res.json();
  } catch(e) {
    const b = document.getElementById('invListBody');
    if (b) b.innerHTML = '<div class="inv-empty-state"><p>Could not load invoices.</p></div>';
    return;
  }

  _invUpdateKpis(_invAllData);
  _invRenderList(_invAllData);
}

/* ── KPI cards ──────────────────────────────────────────────────────────────── */
function _invUpdateKpis(invoices) {
  const now = Date.now();
  let outstanding = 0, partials = 0, paid = 0, pastDue = 0;
  let nPartial = 0, nPaid = 0, nPastDue = 0, nOutstanding = 0;

  invoices.forEach(inv => {
    const bal = inv.balance_due || 0;
    const amtPaid = inv.amount_paid || 0;
    const isOD = _invIsOverdue(inv);

    if (['sent','viewed','partial','overdue'].includes(inv.status) || isOD) {
      outstanding += bal;
      nOutstanding++;
    }
    if (inv.status === 'partial') {
      partials += amtPaid; // deposits/partial payments collected
      nPartial++;
    }
    if (inv.status === 'paid') {
      paid += inv.total || 0;
      nPaid++;
    }
    if (isOD || inv.status === 'overdue') {
      pastDue += bal;
      nPastDue++;
    }
  });

  const sub = document.getElementById('invSubtitle');
  if (sub) sub.textContent = `${invoices.length} invoice${invoices.length !== 1 ? 's' : ''}`;

  const kpiRow = document.getElementById('invKpiRow');
  if (!kpiRow) return;

  kpiRow.innerHTML = `
    <div class="gwp-kpi-card gwp-kpi-card--click gwp-kpi-card--blue" onclick="_invSetChip(document.querySelector('[data-s=sent]'),'sent')">
      <div class="gwp-kpi-icon gwp-kpi-icon--blue">${gwIcon('invoice',16,'#1D4ED8')}</div>
      <div class="gwp-kpi-body">
        <div class="gwp-kpi-value">${_invFmt(outstanding)}</div>
        <div class="gwp-kpi-label">Outstanding</div>
        <div class="gwp-kpi-sub">${nOutstanding} invoice${nOutstanding!==1?'s':''} open</div>
      </div>
    </div>
    <div class="gwp-kpi-card gwp-kpi-card--click gwp-kpi-card--yellow" onclick="_invSetChip(document.querySelector('[data-s=partial]'),'partial')">
      <div class="gwp-kpi-icon gwp-kpi-icon--yellow">${gwIcon('payment',16,'#92400E')}</div>
      <div class="gwp-kpi-body">
        <div class="gwp-kpi-value">${_invFmt(partials)}</div>
        <div class="gwp-kpi-label">Deposits / Partials</div>
        <div class="gwp-kpi-sub">${nPartial} collecting</div>
      </div>
    </div>
    <div class="gwp-kpi-card gwp-kpi-card--click gwp-kpi-card--green" onclick="_invSetChip(document.querySelector('[data-s=paid]'),'paid')">
      <div class="gwp-kpi-icon gwp-kpi-icon--green">${gwIcon('status-accepted',16,'#166534')}</div>
      <div class="gwp-kpi-body">
        <div class="gwp-kpi-value">${_invFmt(paid)}</div>
        <div class="gwp-kpi-label">Paid</div>
        <div class="gwp-kpi-sub">${nPaid} settled</div>
      </div>
    </div>
    <div class="gwp-kpi-card gwp-kpi-card--click gwp-kpi-card--red ${nPastDue > 0 ? 'inv-kpi-card--pulse' : ''}" onclick="_invSetChip(document.querySelector('[data-s=overdue]'),'overdue')">
      <div class="gwp-kpi-icon gwp-kpi-icon--red">${gwIcon('status-expired',16,'#991B1B')}</div>
      <div class="gwp-kpi-body">
        <div class="gwp-kpi-value">${_invFmt(pastDue)}</div>
        <div class="gwp-kpi-label">Past Due</div>
        <div class="gwp-kpi-sub">${nPastDue} overdue</div>
      </div>
    </div>`;
}

/* ── Render list ────────────────────────────────────────────────────────────── */
function _invRenderList(invoices) {
  const body = document.getElementById('invListBody');
  if (!body) return;

  if (!invoices.length) {
    body.innerHTML = `
    <div class="inv-empty-state">
      <div class="inv-empty-icon">${gwIcon('invoice',44,'#D1D5DB')}</div>
      <div class="inv-empty-title">No invoices yet</div>
      <div class="inv-empty-sub">Create your first invoice to start tracking payments.</div>
      <button class="inv-btn-primary" style="margin-top:16px" onclick="_invOpenBuilder(null)">
        ${gwIcon('plus',13,'#fff')} New Invoice
      </button>
    </div>`;
    return;
  }

  // Desktop table
  if (window.innerWidth > 768) {
    body.innerHTML = `
    <div class="inv-table-wrap">
      <table class="inv-table">
        <thead>
          <tr>
            <th>Invoice #</th>
            <th>Client</th>
            <th>Title</th>
            <th>Issued</th>
            <th>Due</th>
            <th style="text-align:right">Total</th>
            <th style="text-align:right">Balance</th>
            <th>Status</th>
            <th style="width:120px"></th>
          </tr>
        </thead>
        <tbody>
          ${invoices.map(inv => {
            const overdue = _invIsOverdue(inv);
            return `
            <tr class="inv-row${overdue ? ' inv-row--overdue' : ''}" onclick="_invOpenDetail('${inv.id}')">
              <td class="inv-num">${_invEsc(inv.invoice_number)}</td>
              <td class="inv-client-cell">
                <div class="inv-client-name">${_invEsc(inv.client_name || '—')}</div>
                ${inv.client_email ? `<div class="inv-client-email">${_invEsc(inv.client_email)}</div>` : ''}
              </td>
              <td class="inv-title-cell">${_invEsc(inv.title || '')}</td>
              <td class="inv-date-cell">${_invAgo(inv.created_at)}</td>
              <td class="inv-due-cell ${overdue ? 'inv-overdue-text' : ''}">${_invDate(inv.due_date)}${overdue ? `<span class="inv-od-pill">${Math.floor((Date.now()-new Date(inv.due_date+'T00:00:00').getTime())/86400000)}d</span>` : ''}</td>
              <td class="inv-amount" style="text-align:right">${_invFmt(inv.total)}</td>
              <td class="inv-balance ${inv.balance_due > 0 ? 'inv-bal-due' : 'inv-bal-zero'}" style="text-align:right">${_invFmt(inv.balance_due)}</td>
              <td>${_invBadge(overdue && inv.status !== 'overdue' ? 'overdue' : inv.status)}</td>
              <td onclick="event.stopPropagation()">
                <div class="inv-row-actions">
                  ${inv.status === 'draft' ? `<button class="inv-action-btn" title="Edit" onclick="_invOpenBuilder('${inv.id}')">${gwIcon('edit',12,'#6B7280')}</button>` : ''}
                  ${['sent','viewed','partial'].includes(inv.status) || overdue ? `<button class="inv-action-btn inv-action-btn--green" title="Record Payment" onclick="_invRecordPaymentModal('${inv.id}')">${gwIcon('payment',12,'#2D7A55')}</button>` : ''}
                  ${['draft','sent','viewed','partial'].includes(inv.status) ? `<button class="inv-action-btn" title="Resend / Email" onclick="_invResendModal('${inv.id}')">${gwIcon('send',12,'#4D8A86')}</button>` : ''}
                  <button class="inv-action-btn" title="View Detail" onclick="_invOpenDetail('${inv.id}')">${gwIcon('eye',12,'#6B7280')}</button>
                </div>
              </td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>
    </div>`;
    return;
  }

  // Mobile cards
  body.innerHTML = `
  <div class="inv-mobile-list">
    ${invoices.map(inv => {
      const overdue = _invIsOverdue(inv);
      return `
      <div class="inv-mobile-card${overdue ? ' inv-mobile-card--overdue' : ''}" onclick="_invOpenDetail('${inv.id}')">
        <div class="inv-mc-top">
          <span class="inv-mc-num">${_invEsc(inv.invoice_number)}</span>
          ${_invBadge(overdue && inv.status !== 'overdue' ? 'overdue' : inv.status)}
        </div>
        <div class="inv-mc-client">${_invEsc(inv.client_name || '—')}</div>
        ${inv.title ? `<div class="inv-mc-title">${_invEsc(inv.title)}</div>` : ''}
        <div class="inv-mc-bottom">
          <span class="inv-mc-total">${_invFmt(inv.total)}</span>
          ${inv.balance_due > 0 ? `<span class="inv-mc-bal inv-mc-bal--due">Bal ${_invFmt(inv.balance_due)}</span>` : `<span class="inv-mc-bal inv-mc-bal--paid">Paid</span>`}
          <span class="inv-mc-date">${overdue ? `<span class="inv-overdue-text">Due ${_invDate(inv.due_date)}</span>` : _invAgo(inv.created_at)}</span>
        </div>
        <div class="inv-mc-actions" onclick="event.stopPropagation()">
          ${['sent','viewed','partial'].includes(inv.status) || overdue ? `<button class="inv-mc-act-btn inv-mc-act-btn--green" onclick="_invRecordPaymentModal('${inv.id}')">${gwIcon('payment',11,'#2D7A55')} Pay</button>` : ''}
          ${['draft','sent','viewed','partial'].includes(inv.status) ? `<button class="inv-mc-act-btn" onclick="_invResendModal('${inv.id}')">${gwIcon('send',11,'#4D8A86')} Resend</button>` : ''}
          <button class="inv-mc-act-btn" onclick="_invOpenBuilder('${inv.id}')">${gwIcon('edit',11,'#6B7280')} Edit</button>
        </div>
      </div>`;
    }).join('')}
  </div>`;
}

/* ══════════════════════════════════════════════════════════════════════════════
   INVOICE DETAIL MODAL
══════════════════════════════════════════════════════════════════════════════ */
async function _invOpenDetail(invId) {
  const overlay = _invCreateOverlay('inv-detail-overlay');
  overlay.innerHTML = `<div class="inv-modal inv-detail-modal">
    <div class="inv-modal-header">
      <div class="inv-modal-title">${gwIcon('invoice',17,'#1C3A2B')} Invoice Detail</div>
      <button class="inv-modal-close" onclick="document.getElementById('inv-detail-overlay').remove()">&times;</button>
    </div>
    <div class="inv-modal-body" id="invDetailBody">
      <div class="inv-loading">${gwIcon('hourglass',20,'#9CA3AF')}&ensp;Loading…</div>
    </div>
  </div>`;
  document.body.appendChild(overlay);

  const res = await fetch(`/api/invoices/${invId}`, { credentials:'include' });
  if (!res.ok) { document.getElementById('invDetailBody').innerHTML = '<div class="inv-empty-state"><p>Invoice not found.</p></div>'; return; }
  const inv = await res.json();
  if (typeof inv.line_items === 'string') try { inv.line_items = JSON.parse(inv.line_items); } catch(_) { inv.line_items = []; }
  _invRenderDetail(inv);
}

function _invRenderDetail(inv) {
  const body = document.getElementById('invDetailBody');
  if (!body) return;
  const overdue = _invIsOverdue(inv);
  const lineItems = Array.isArray(inv.line_items) ? inv.line_items : [];
  const canPay = ['sent','viewed','partial'].includes(inv.status) || overdue;
  const canEdit = ['draft','sent','viewed','partial'].includes(inv.status);

  body.innerHTML = `
  <!-- Status banner -->
  ${overdue ? `<div class="inv-detail-overdue-banner">${gwIcon('status-expired',14,'#991B1B')} This invoice is <strong>${Math.floor((Date.now()-new Date(inv.due_date+'T00:00:00').getTime())/86400000)} days past due</strong> — balance of ${_invFmt(inv.balance_due)} outstanding</div>` : ''}

  <!-- Header row: number + status + actions -->
  <div class="inv-detail-head">
    <div class="inv-detail-head-left">
      <div class="inv-detail-num">${_invEsc(inv.invoice_number)}</div>
      <div style="display:flex;align-items:center;gap:8px;margin-top:4px">
        ${_invBadge(overdue && inv.status !== 'overdue' ? 'overdue' : inv.status)}
        <span class="inv-detail-date-sub">Issued ${_invDate(inv.created_at?.split('T')[0])}</span>
        ${inv.sent_at ? `<span class="inv-detail-date-sub">· Sent ${_invAgo(inv.sent_at)}</span>` : ''}
      </div>
    </div>
    <div class="inv-detail-head-right">
      ${canEdit ? `<button class="inv-btn-secondary" onclick="_invOpenBuilder('${inv.id}',true)">${gwIcon('edit',13)} Edit</button>` : ''}
      ${canPay ? `<button class="inv-btn-primary" onclick="_invRecordPaymentModal('${inv.id}')">${gwIcon('payment',13,'#fff')} Record Payment</button>` : ''}
      ${canEdit ? `<button class="inv-btn-teal" onclick="_invResendModal('${inv.id}')">${gwIcon('send',13,'#fff')} Resend</button>` : ''}
      ${inv.status !== 'void' && inv.status !== 'paid' ? `<button class="inv-btn-ghost" onclick="_invVoid('${inv.id}')" style="color:#9CA3AF">${gwIcon('status-declined',13)} Void</button>` : ''}
    </div>
  </div>

  <!-- Dates (editable) -->
  <div class="inv-detail-dates-bar">
    <div class="inv-detail-date-pill">
      <span class="inv-detail-date-lbl">Due Date</span>
      <input type="date" class="inv-date-inline" id="invDueDateInline" value="${inv.due_date||''}"
        onchange="_invUpdateDueDate('${inv.id}',this.value)">
    </div>
    <div class="inv-detail-date-pill">
      <span class="inv-detail-date-lbl">Terms</span>
      <select class="inv-date-inline inv-date-select" onchange="_invUpdateTerms('${inv.id}',this.value)">
        ${['Due on Receipt','Net 15','Net 30','Net 45','Net 60'].map(t => `<option value="${t}" ${inv.terms===t?'selected':''}>${t}</option>`).join('')}
      </select>
    </div>
    ${inv.due_date ? `<div class="inv-detail-date-pill ${overdue ? 'inv-detail-date-pill--red' : ''}">
      <span class="inv-detail-date-lbl">${overdue ? 'Overdue' : 'Days Until Due'}</span>
      <span style="font-weight:700">${Math.abs(Math.floor((Date.now()-new Date(inv.due_date+'T00:00:00').getTime())/86400000))}d</span>
    </div>` : ''}
  </div>

  <!-- Bill to / From -->
  <div class="inv-detail-parties">
    <div class="inv-detail-party">
      <div class="inv-detail-party-lbl">Bill To</div>
      <div class="inv-detail-party-name">${_invEsc(inv.client_name || '—')}</div>
      ${inv.client_email ? `<div class="inv-detail-party-sub">${gwIcon('email',11,'#9CA3AF')} ${_invEsc(inv.client_email)}</div>` : ''}
      ${inv.client_phone ? `<div class="inv-detail-party-sub">${gwIcon('phone',11,'#9CA3AF')} ${_invEsc(inv.client_phone)}</div>` : ''}
      ${inv.client_address ? `<div class="inv-detail-party-sub">${gwIcon('map-pin',11,'#9CA3AF')} ${_invEsc(inv.client_address)}</div>` : ''}
    </div>
    <div class="inv-detail-party" style="text-align:right">
      <div class="inv-detail-party-lbl">From</div>
      <div class="inv-detail-party-name" id="invFromName">Groundwork</div>
      <div class="inv-detail-party-sub" id="invFromRef">${_invEsc(inv.invoice_number)}</div>
    </div>
  </div>

  <!-- Line items -->
  <div class="inv-li-section">
    <table class="inv-li-table">
      <thead><tr><th>Description</th><th>Qty</th><th>Unit Price</th><th>Total</th></tr></thead>
      <tbody>
        ${lineItems.length ? lineItems.map(li => `
          <tr>
            <td>${_invEsc(li.description||'')}</td>
            <td style="text-align:right">${li.qty||1}${li.unit?' '+li.unit:''}</td>
            <td style="text-align:right">${_invFmt(li.unit_price)}</td>
            <td style="text-align:right;font-weight:600">${_invFmt(li.total)}</td>
          </tr>`).join('') : `<tr><td colspan="4" class="inv-muted" style="text-align:center;padding:20px">No line items</td></tr>`}
      </tbody>
    </table>
  </div>

  <!-- Totals -->
  <div class="inv-totals-right">
    <div class="inv-total-row"><span>Subtotal</span><span>${_invFmt(inv.subtotal)}</span></div>
    ${inv.tax_rate > 0 ? `<div class="inv-total-row"><span>Tax (${inv.tax_rate}%)</span><span>${_invFmt(inv.tax_amount)}</span></div>` : ''}
    ${inv.discount_amount > 0 ? `<div class="inv-total-row" style="color:#16A34A"><span>Discount</span><span>−${_invFmt(inv.discount_amount)}</span></div>` : ''}
    <div class="inv-total-row inv-total-grand"><span>Total</span><span>${_invFmt(inv.total)}</span></div>
    ${inv.amount_paid > 0 ? `<div class="inv-total-row" style="color:#2D7A55"><span>Amount Paid</span><span>${_invFmt(inv.amount_paid)}</span></div>` : ''}
    <div class="inv-total-row inv-balance-final ${inv.balance_due > 0 ? 'inv-bal-due' : 'inv-bal-zero'}">
      <span>Balance Due</span><span>${_invFmt(inv.balance_due)}</span>
    </div>
  </div>

  <!-- Payment history -->
  ${_invPaymentHistory(inv)}

  <!-- Notes -->
  ${inv.notes ? `<div class="inv-detail-notes">${gwIcon('document',13,'#9CA3AF')} ${_invEsc(inv.notes)}</div>` : ''}

  <!-- Portal link -->
  <div class="inv-portal-row">
    <div class="inv-detail-party-lbl" style="margin-bottom:6px">${gwIcon('globe',12,'#9CA3AF')} Client Portal Link</div>
    <div style="display:flex;gap:8px">
      <input class="inv-portal-input" readonly id="invPortalLink_${inv.id}"
        value="${window.location.origin}/invoices/portal/${inv.portal_token||''}">
      <button class="inv-btn-secondary" style="flex-shrink:0" onclick="navigator.clipboard.writeText(document.getElementById('invPortalLink_${inv.id}').value).then(()=>showToast('Link copied','success'))">${gwIcon('copy',13)} Copy</button>
    </div>
  </div>`;

  // Try to load company name for "From"
  if (window._scBrand?.name) {
    const el = document.getElementById('invFromName');
    if (el) el.textContent = window._scBrand.name;
  }
}

function _invPaymentHistory(inv) {
  let payments = [];
  try { payments = JSON.parse(inv.payment_history || '[]'); } catch(_) {}
  if (!payments.length && !inv.amount_paid) return '';
  return `
  <div class="inv-pay-history">
    <div class="inv-pay-hist-title">${gwIcon('payment',13,'#9CA3AF')} Payment History</div>
    ${payments.map(p => `
      <div class="inv-pay-hist-row">
        <div class="inv-pay-hist-left">
          <span class="inv-pay-hist-icon">${gwIcon('status-accepted',12,'#2D7A55')}</span>
          <div>
            <div class="inv-pay-hist-amt">${_invFmt(p.amount)}</div>
            <div class="inv-pay-hist-meta">${_invDate(p.date||p.paid_at)} · ${p.method||'Manual'} ${p.note ? '· '+_invEsc(p.note) : ''}</div>
          </div>
        </div>
        <div class="inv-pay-hist-right">${_invFmt(p.amount)}</div>
      </div>`).join('')}
    ${!payments.length && inv.amount_paid ? `<div class="inv-pay-hist-row"><div class="inv-pay-hist-meta" style="color:#9CA3AF;padding:4px 0">Payment recorded — ${_invFmt(inv.amount_paid)} received</div></div>` : ''}
  </div>`;
}

/* ── Inline date / terms update ─────────────────────────────────────────────── */
window._invUpdateDueDate = async function(invId, val) {
  await fetch(`/api/invoices/${invId}`, { method:'PUT', credentials:'include',
    headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ due_date: val }) });
  showToast('Due date updated', 'success');
  _invLoadList();
};
window._invUpdateTerms = async function(invId, val) {
  await fetch(`/api/invoices/${invId}`, { method:'PUT', credentials:'include',
    headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ terms: val }) });
  showToast('Terms updated', 'success');
  _invLoadList();
};

/* ══════════════════════════════════════════════════════════════════════════════
   RESEND MODAL
══════════════════════════════════════════════════════════════════════════════ */
window._invResendModal = async function(invId) {
  const res = await fetch(`/api/invoices/${invId}`, { credentials:'include' });
  if (!res.ok) return;
  const inv = await res.json();

  const overlay = _invCreateOverlay('inv-resend-overlay');
  overlay.innerHTML = `<div class="inv-modal inv-resend-modal">
    <div class="inv-modal-header">
      <div class="inv-modal-title">${gwIcon('send',17,'#1C3A2B')} Send Invoice</div>
      <button class="inv-modal-close" onclick="document.getElementById('inv-resend-overlay').remove()">&times;</button>
    </div>
    <div class="inv-modal-body">
      <div class="inv-resend-inv-card">
        <div style="font-weight:700;color:#1C3A2B">${_invEsc(inv.invoice_number)}</div>
        <div style="font-size:12px;color:#6B7280;margin-top:2px">${_invEsc(inv.client_name||'—')} · ${_invFmt(inv.balance_due)} due</div>
      </div>
      <div class="inv-field-group" style="margin-top:16px">
        <label class="inv-label">Send To</label>
        <input class="inv-input" type="email" id="invResendEmail" value="${_invEsc(inv.client_email||'')}" placeholder="client@email.com">
      </div>
      <div class="inv-field-group">
        <label class="inv-label">Subject</label>
        <input class="inv-input" type="text" id="invResendSubject" value="Invoice ${_invEsc(inv.invoice_number)} — ${_invFmt(inv.balance_due)} due">
      </div>
      <div class="inv-field-group">
        <label class="inv-label">Message (optional)</label>
        <textarea class="inv-textarea" id="invResendMsg" rows="3" placeholder="Hi [client], please find your invoice attached…"></textarea>
      </div>
      <div class="inv-portal-row" style="margin-top:8px">
        <div class="inv-detail-party-lbl" style="margin-bottom:4px">Portal Link (included automatically)</div>
        <div style="display:flex;gap:8px">
          <input class="inv-portal-input" readonly id="invResendPortalLink" value="${window.location.origin}/invoices/portal/${inv.portal_token||''}">
          <button class="inv-btn-secondary" style="flex-shrink:0" onclick="navigator.clipboard.writeText(document.getElementById('invResendPortalLink').value).then(()=>showToast('Copied','success'))">${gwIcon('copy',12)} Copy</button>
        </div>
      </div>
      <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:20px">
        <button class="inv-btn-ghost" onclick="document.getElementById('inv-resend-overlay').remove()">Cancel</button>
        <button class="inv-btn-teal" onclick="_invDoResend('${invId}')">${gwIcon('send',13,'#fff')} Send Now</button>
      </div>
    </div>
  </div>`;
  document.body.appendChild(overlay);
};

window._invDoResend = async function(invId) {
  const email = document.getElementById('invResendEmail')?.value?.trim();
  if (!email) { showToast('Enter a recipient email', 'error'); return; }
  // Mark as sent in DB
  const markRes = await fetch(`/api/invoices/${invId}/send`, { method:'POST', credentials:'include' });
  if (!markRes.ok) { showToast('Failed to update status', 'error'); return; }

  // Fire email via email module if available
  if (typeof window.gwSendInvoiceEmail === 'function') {
    await window.gwSendInvoiceEmail(invId, email);
  } else {
    showToast('Invoice marked as sent — configure email integration to auto-send', 'success');
  }

  document.getElementById('inv-resend-overlay')?.remove();
  document.getElementById('inv-detail-overlay')?.remove();
  _invLoadList();
};

/* ══════════════════════════════════════════════════════════════════════════════
   RECORD PAYMENT MODAL (with Stripe charge option)
══════════════════════════════════════════════════════════════════════════════ */
window._invRecordPaymentModal = async function(invId) {
  const res = await fetch(`/api/invoices/${invId}`, { credentials:'include' });
  if (!res.ok) return;
  const inv = await res.json();

  // Fetch saved payment methods if client has them
  let payMethods = [];
  if (inv.client_id) {
    try {
      const pmRes = await fetch(`/api/clients/${inv.client_id}/payment-methods`, { credentials:'include' });
      if (pmRes.ok) {
        const pmData = await pmRes.json();
        payMethods = pmData.payment_methods || pmData || [];
      }
    } catch(_) {}
  }

  const overlay = _invCreateOverlay('inv-pay-overlay');
  overlay.innerHTML = `<div class="inv-modal inv-pay-modal" data-inv-id="${invId}">
    <div class="inv-modal-header">
      <div class="inv-modal-title">${gwIcon('payment',17,'#1C3A2B')} Record Payment</div>
      <button class="inv-modal-close" onclick="document.getElementById('inv-pay-overlay').remove()">&times;</button>
    </div>
    <div class="inv-modal-body">

      <!-- Invoice summary pill -->
      <div class="inv-pay-summary-card">
        <div class="inv-pay-sum-row">
          <span>${_invEsc(inv.invoice_number)}</span>
          <strong>${_invEsc(inv.client_name||'—')}</strong>
        </div>
        <div class="inv-pay-sum-row inv-pay-sum-row--totals">
          <div>
            <div class="inv-pay-sum-lbl">Invoice Total</div>
            <div class="inv-pay-sum-val">${_invFmt(inv.total)}</div>
          </div>
          ${inv.amount_paid > 0 ? `<div>
            <div class="inv-pay-sum-lbl">Paid</div>
            <div class="inv-pay-sum-val" style="color:#2D7A55">${_invFmt(inv.amount_paid)}</div>
          </div>` : ''}
          <div>
            <div class="inv-pay-sum-lbl">Balance Due</div>
            <div class="inv-pay-sum-val inv-bal-due">${_invFmt(inv.balance_due)}</div>
          </div>
        </div>
      </div>

      <!-- Pay mode tabs -->
      <div class="inv-pay-mode-tabs" id="invPayModeTabs">
        <button class="inv-pay-mode-tab active" onclick="_invPayTab(this,'manual')" data-mode="manual">${gwIcon('floppy',13)} Record Manually</button>
        <button class="inv-pay-mode-tab" onclick="_invPayTab(this,'stripe')" data-mode="stripe">${gwIcon('payment',13)} Charge Card on File</button>
      </div>

      <!-- Manual form -->
      <div id="invPayManual">
        <div class="inv-field-group" style="margin-top:16px">
          <label class="inv-label">Payment Amount</label>
          <input class="inv-input" type="number" id="invPayAmount" value="${(inv.balance_due||0).toFixed(2)}" min="0.01" step="0.01">
        </div>
        <div class="inv-field-group">
          <label class="inv-label">Payment Method</label>
          <select class="inv-select" id="invPayMethod">
            <option value="check">Check</option>
            <option value="cash">Cash</option>
            <option value="card">Credit Card (manual)</option>
            <option value="ach">ACH / Bank Transfer</option>
            <option value="venmo">Venmo</option>
            <option value="zelle">Zelle</option>
            <option value="stripe">Stripe (online)</option>
            <option value="other">Other</option>
          </select>
        </div>
        <div class="inv-field-group">
          <label class="inv-label">Note (optional)</label>
          <input class="inv-input" type="text" id="invPayNote" placeholder="Check #1234, received…">
        </div>
      </div>

      <!-- Stripe charge panel -->
      <div id="invPayStripe" style="display:none">
        ${payMethods.length ? `
          <div class="inv-stripe-cards">
            <div class="inv-field-group" style="margin-top:16px">
              <label class="inv-label">Card on File</label>
              <select class="inv-select" id="invStripeMethod">
                ${payMethods.map(pm => `<option value="${pm.id}">${pm.label || ((pm.brand||'Card').toUpperCase()+' ···· '+(pm.last4||'????')+(pm.exp_year?' (exp '+pm.exp_month+'/'+pm.exp_year+')':''))}</option>`).join('')}
              </select>
            </div>
            <div class="inv-field-group">
              <label class="inv-label">Charge Amount</label>
              <input class="inv-input" type="number" id="invStripeAmount" value="${(inv.balance_due||0).toFixed(2)}" min="0.01" step="0.01">
            </div>
            <div class="inv-stripe-note">${gwIcon('info',11,'#4D8A86')} Charging will create a Stripe payment and auto-record it here.</div>
          </div>` : `
          <div class="inv-stripe-empty">
            ${gwIcon('payment',28,'#D1D5DB')}
            <div style="font-weight:600;color:#374151;margin-top:8px">No cards on file</div>
            <div style="font-size:12px;color:#9CA3AF;margin-top:4px">Client has not saved a payment method yet. Send the portal link so they can add one, or record the payment manually.</div>
          </div>`}
      </div>

      <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:20px">
        <button class="inv-btn-ghost" onclick="document.getElementById('inv-pay-overlay').remove()">Cancel</button>
        <button class="inv-btn-primary" id="invPaySubmitBtn" onclick="_invSubmitPayment('${invId}')">
          ${gwIcon('payment',13,'#fff')} Record Payment
        </button>
      </div>
    </div>
  </div>`;
  document.body.appendChild(overlay);
};

window._invPayTab = function(btn, mode) {
  document.querySelectorAll('.inv-pay-mode-tab').forEach(t => t.classList.remove('active'));
  btn.classList.add('active');
  document.getElementById('invPayManual').style.display = mode === 'manual' ? '' : 'none';
  document.getElementById('invPayStripe').style.display = mode === 'stripe' ? '' : 'none';
  const submitBtn = document.getElementById('invPaySubmitBtn');
  if (submitBtn) {
    submitBtn.innerHTML = mode === 'stripe'
      ? `${gwIcon('payment',13,'#fff')} Charge Card`
      : `${gwIcon('payment',13,'#fff')} Record Payment`;
    const modal = submitBtn.closest('.inv-modal') || submitBtn.closest('[data-inv-id]');
    const storedId = modal?.dataset?.invId || '';
    submitBtn.onclick = mode === 'stripe'
      ? () => _invChargeStripe(storedId)
      : null;
  }
};

window._invSubmitPayment = async function(invId) {
  const amount = parseFloat(document.getElementById('invPayAmount')?.value || 0);
  const method = document.getElementById('invPayMethod')?.value || 'check';
  const note   = document.getElementById('invPayNote')?.value?.trim() || '';
  if (!amount || amount <= 0) { showToast('Enter a valid amount', 'error'); return; }

  const btn = document.getElementById('invPaySubmitBtn');
  if (btn) { btn.disabled = true; btn.innerHTML = `${gwIcon('hourglass',13,'#fff')} Saving…`; }

  const res = await fetch(`/api/invoices/${invId}/record-payment`, {
    method:'POST', credentials:'include',
    headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ amount, method, note })
  });
  const data = await res.json();
  if (!res.ok) {
    showToast('Failed to record payment', 'error');
    if (btn) { btn.disabled = false; btn.innerHTML = `${gwIcon('payment',13,'#fff')} Record Payment`; }
    return;
  }

  showToast(`${_invFmt(amount)} recorded — ${data.status === 'paid' ? '✓ Invoice fully PAID' : 'Partial payment logged'}`, 'success');
  document.getElementById('inv-pay-overlay')?.remove();
  // Refresh detail if open
  if (document.getElementById('invDetailBody')) {
    const invRes = await fetch(`/api/invoices/${invId}`, { credentials:'include' });
    if (invRes.ok) {
      const inv = await invRes.json();
      if (typeof inv.line_items === 'string') try { inv.line_items = JSON.parse(inv.line_items); } catch(_) {}
      _invRenderDetail(inv);
    }
  }
  _invLoadList();
};

/* Stripe charge-on-file (hooks into existing Stripe session if configured) */
window._invChargeStripe = async function(invId) {
  const pmId = document.getElementById('invStripeMethod')?.value;
  const amountDollars = parseFloat(document.getElementById('invStripeAmount')?.value || 0);
  if (!pmId || !amountDollars) { showToast('Select a card and enter an amount', 'error'); return; }
  const amountCents = Math.round(amountDollars * 100); // backend expects cents

  const btn = document.getElementById('invPaySubmitBtn');
  if (btn) { btn.disabled = true; btn.innerHTML = `${gwIcon('hourglass',13,'#fff')} Charging…`; }

  try {
    const res = await fetch(`/api/invoices/${invId}/charge`, {
      method:'POST', credentials:'include',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ stripe_pm_id: pmId, amount: amountCents })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Charge failed');
    showToast(`Card charged ${_invFmt(amountDollars)} successfully`, 'success');
    document.getElementById('inv-pay-overlay')?.remove();
    document.getElementById('inv-detail-overlay')?.remove();
    _invLoadList();
  } catch(e) {
    showToast(e.message || 'Charge failed — check Stripe integration', 'error');
    if (btn) { btn.disabled = false; btn.innerHTML = `${gwIcon('payment',13,'#fff')} Charge Card`; }
  }
};

/* ══════════════════════════════════════════════════════════════════════════════
   INVOICE BUILDER (Create / Edit)
══════════════════════════════════════════════════════════════════════════════ */
async function _invOpenBuilder(invId, fromDetail) {
  if (fromDetail) document.getElementById('inv-detail-overlay')?.remove();

  const overlay = _invCreateOverlay('inv-builder-overlay');
  overlay.innerHTML = `<div class="inv-modal inv-builder-modal">
    <div class="inv-modal-header">
      <div class="inv-modal-title">${gwIcon('invoice',17,'#1C3A2B')} ${invId ? 'Edit Invoice' : 'New Invoice'}</div>
      <button class="inv-modal-close" onclick="document.getElementById('inv-builder-overlay').remove()">&times;</button>
    </div>
    <div class="inv-modal-body" id="invBuilderBody">
      <div class="inv-loading">${gwIcon('hourglass',20,'#9CA3AF')}&ensp;Loading…</div>
    </div>
  </div>`;
  document.body.appendChild(overlay);

  let inv = null, clients = [];
  try {
    const [clRes, invRes] = await Promise.all([
      fetch('/api/clients?limit=500', { credentials:'include' }),
      invId ? fetch(`/api/invoices/${invId}`, { credentials:'include' }) : Promise.resolve(null)
    ]);
    clients = clRes.ok ? await clRes.json() : [];
    if (invRes) {
      inv = invRes.ok ? await invRes.json() : null;
      if (inv && typeof inv.line_items === 'string') try { inv.line_items = JSON.parse(inv.line_items); } catch(_) { inv.line_items = []; }
    }
  } catch(e) {}
  _invRenderBuilder(inv, clients, invId);
}

function _invRenderBuilder(inv, clients, invId) {
  const body = document.getElementById('invBuilderBody');
  const lineItems = inv?.line_items?.length ? inv.line_items : [{ description:'', qty:1, unit:'', unit_price:0, total:0 }];
  const defaultDue = new Date(); defaultDue.setDate(defaultDue.getDate()+30);
  const defaultDueStr = defaultDue.toISOString().split('T')[0];

  body.innerHTML = `
  <form id="invBuilderForm" onsubmit="event.preventDefault()">
    <div class="inv-builder-grid">

      <!-- Left col: client + meta -->
      <div class="inv-builder-col">
        <div class="inv-field-group">
          <label class="inv-label">Client</label>
          <select class="inv-select" id="invClientId" onchange="_invOnClientChange()">
            <option value="">Select client…</option>
            ${clients.map(cl => `<option value="${cl.id}"
              data-name="${_invEsc(cl.name||'')}" data-email="${_invEsc(cl.email||'')}"
              data-phone="${_invEsc(cl.phone||'')}" data-address="${_invEsc(cl.address||'')}"
              ${inv?.client_id===cl.id?'selected':''}>${_invEsc(cl.name)}</option>`).join('')}
            <option value="__manual__">Enter manually…</option>
          </select>
        </div>
        <div id="invClientManualFields" style="display:${!inv?.client_id||inv?.client_id&&!clients.find(c=>c.id===inv?.client_id)?'block':'none'}">
          <div class="inv-field-group">
            <label class="inv-label">Client Name</label>
            <input class="inv-input" type="text" id="invClientName" value="${_invEsc(inv?.client_name||'')}" placeholder="Name">
          </div>
          <div class="inv-row2">
            <div class="inv-field-group">
              <label class="inv-label">Email</label>
              <input class="inv-input" type="email" id="invClientEmail" value="${_invEsc(inv?.client_email||'')}" placeholder="email@example.com">
            </div>
            <div class="inv-field-group">
              <label class="inv-label">Phone</label>
              <input class="inv-input" type="tel" id="invClientPhone" value="${_invEsc(inv?.client_phone||'')}" placeholder="(555) 555-5555">
            </div>
          </div>
          <div class="inv-field-group">
            <label class="inv-label">Address</label>
            <input class="inv-input" type="text" id="invClientAddress" value="${_invEsc(inv?.client_address||'')}" placeholder="123 Main St…">
          </div>
        </div>

        <div class="inv-field-group">
          <label class="inv-label">Invoice Title</label>
          <input class="inv-input" type="text" id="invTitle" value="${_invEsc(inv?.title||'')}" placeholder="Services for [project]" required>
        </div>

        <div class="inv-row2">
          <div class="inv-field-group">
            <label class="inv-label">Due Date</label>
            <input class="inv-input" type="date" id="invDueDate" value="${inv?.due_date||defaultDueStr}">
          </div>
          <div class="inv-field-group">
            <label class="inv-label">Terms</label>
            <select class="inv-select" id="invTerms">
              ${['Due on Receipt','Net 15','Net 30','Net 45','Net 60'].map(t => `<option value="${t}" ${(!inv?.terms&&t==='Net 30')||inv?.terms===t?'selected':''}>${t}</option>`).join('')}
            </select>
          </div>
        </div>

        <div class="inv-field-group">
          <label class="inv-label">Notes (visible to client)</label>
          <textarea class="inv-textarea" id="invNotes" rows="2" placeholder="Thank you for your business!">${_invEsc(inv?.notes||'')}</textarea>
        </div>
      </div>

      <!-- Right col: line items + totals -->
      <div class="inv-builder-col">
        <div class="inv-field-group">
          <label class="inv-label">${gwIcon('list',12,'#6B7280')} Line Items</label>
          <div id="invLineItemsWrap">
            ${lineItems.map((li, i) => _invLineItemRow(li, i)).join('')}
          </div>
          <button type="button" class="inv-add-line-btn" onclick="_invAddLineItem()">
            ${gwIcon('plus',13,'#2D7A55')} Add Line Item
          </button>
        </div>
        <div class="inv-row2">
          <div class="inv-field-group">
            <label class="inv-label">Tax Rate (%)</label>
            <input class="inv-input" type="number" id="invTaxRate" value="${inv?.tax_rate||0}" min="0" max="100" step="0.01" oninput="_invCalcTotals()">
          </div>
          <div class="inv-field-group">
            <label class="inv-label">Discount ($)</label>
            <input class="inv-input" type="number" id="invDiscount" value="${inv?.discount_amount||0}" min="0" step="0.01" oninput="_invCalcTotals()">
          </div>
        </div>
        <div class="inv-totals-preview" id="invTotalsPreview">
          <div class="inv-total-row"><span>Subtotal</span><span id="invPrevSubtotal">$0.00</span></div>
          <div class="inv-total-row" id="invPrevTaxRow" style="display:none"><span id="invPrevTaxLabel">Tax (0%)</span><span id="invPrevTax">$0.00</span></div>
          <div class="inv-total-row" id="invPrevDiscountRow" style="display:none"><span>Discount</span><span id="invPrevDiscount">−$0.00</span></div>
          <div class="inv-total-row inv-total-grand"><span>Total</span><span id="invPrevTotal">$0.00</span></div>
        </div>
      </div>

    </div>
    <div class="inv-builder-footer">
      <button type="button" class="inv-btn-ghost" onclick="document.getElementById('inv-builder-overlay').remove()">Cancel</button>
      <div style="display:flex;gap:10px">
        <button type="button" class="inv-btn-secondary" onclick="_invSubmitBuilder('${invId||''}','draft')">
          ${gwIcon('floppy',13,'#374151')} Save Draft
        </button>
        <button type="button" class="inv-btn-teal" onclick="_invSubmitBuilder('${invId||''}','sent')">
          ${gwIcon('send',13,'#fff')} Save &amp; Send
        </button>
      </div>
    </div>
  </form>`;

  _invCalcTotals();
}

let _invLineCount = 1;

function _invLineItemRow(li, i) {
  return `<div class="inv-li-row" data-idx="${i}" id="invLiRow_${i}">
    <input class="inv-input inv-li-desc" type="text" placeholder="Description" value="${_invEsc(li.description||'')}" oninput="_invCalcTotals()">
    <input class="inv-input inv-li-qty" type="number" placeholder="Qty" value="${li.qty||1}" min="0" step="any" oninput="_invCalcTotals()">
    <input class="inv-input inv-li-price" type="number" placeholder="Unit $" value="${li.unit_price||0}" min="0" step="0.01" oninput="_invCalcTotals()">
    <div class="inv-li-total" id="invLiTotal_${i}">${_invFmt((li.qty||1)*(li.unit_price||0))}</div>
    <button type="button" class="inv-li-remove" onclick="_invRemoveLineItem(${i})">${gwIcon('trash',11,'#9CA3AF')}</button>
  </div>`;
}

window._invAddLineItem = function() {
  _invLineCount++;
  const wrap = document.getElementById('invLineItemsWrap');
  if (!wrap) return;
  const div = document.createElement('div');
  div.innerHTML = _invLineItemRow({ description:'', qty:1, unit_price:0, total:0 }, _invLineCount);
  wrap.appendChild(div.firstElementChild);
  _invCalcTotals();
};
window._invRemoveLineItem = function(idx) {
  document.getElementById(`invLiRow_${idx}`)?.remove();
  _invCalcTotals();
};
window._invCalcTotals = function() {
  let subtotal = 0;
  document.querySelectorAll('.inv-li-row').forEach((row) => {
    const qty   = parseFloat(row.querySelector('.inv-li-qty')?.value || 1) || 0;
    const price = parseFloat(row.querySelector('.inv-li-price')?.value || 0) || 0;
    const lt = qty * price; subtotal += lt;
    const el = row.querySelector('.inv-li-total');
    if (el) el.textContent = _invFmt(lt);
  });
  const taxRate = parseFloat(document.getElementById('invTaxRate')?.value || 0) || 0;
  const discount = parseFloat(document.getElementById('invDiscount')?.value || 0) || 0;
  const taxAmt = subtotal * taxRate / 100;
  const total = Math.max(0, subtotal + taxAmt - discount);
  const s = id => document.getElementById(id);
  if (s('invPrevSubtotal')) s('invPrevSubtotal').textContent = _invFmt(subtotal);
  if (s('invPrevTax')) s('invPrevTax').textContent = _invFmt(taxAmt);
  if (s('invPrevDiscount')) s('invPrevDiscount').textContent = '−'+_invFmt(discount);
  if (s('invPrevTotal')) s('invPrevTotal').textContent = _invFmt(total);
  if (s('invPrevTaxLabel')) s('invPrevTaxLabel').textContent = `Tax (${taxRate}%)`;
  if (s('invPrevTaxRow')) s('invPrevTaxRow').style.display = taxRate > 0 ? '' : 'none';
  if (s('invPrevDiscountRow')) s('invPrevDiscountRow').style.display = discount > 0 ? '' : 'none';
};
window._invOnClientChange = function() {
  const sel = document.getElementById('invClientId');
  const opt = sel?.options[sel.selectedIndex];
  const manual = document.getElementById('invClientManualFields');
  if (!opt) return;
  if (opt.value === '__manual__' || opt.value === '') {
    if (manual) manual.style.display = 'block';
  } else {
    if (manual) manual.style.display = 'none';
    const fields = ['invClientName','invClientEmail','invClientPhone','invClientAddress'];
    const attrs  = ['data-name','data-email','data-phone','data-address'];
    fields.forEach((id, i) => { const e = document.getElementById(id); if(e) e.value = opt.getAttribute(attrs[i])||''; });
  }
};

function _invCollectBuilder(action) {
  const lineItems = [];
  document.querySelectorAll('.inv-li-row').forEach(row => {
    const desc  = row.querySelector('.inv-li-desc')?.value?.trim() || '';
    const qty   = parseFloat(row.querySelector('.inv-li-qty')?.value || 1) || 1;
    const price = parseFloat(row.querySelector('.inv-li-price')?.value || 0) || 0;
    if (desc || price) lineItems.push({ description: desc, qty, unit_price: price, total: qty*price });
  });
  const taxRate  = parseFloat(document.getElementById('invTaxRate')?.value || 0) || 0;
  const discount = parseFloat(document.getElementById('invDiscount')?.value || 0) || 0;
  const subtotal = lineItems.reduce((s, li) => s + li.total, 0);
  const taxAmt   = subtotal * taxRate / 100;
  const total    = Math.max(0, subtotal + taxAmt - discount);
  const clientSel = document.getElementById('invClientId');
  const clientId = clientSel?.value === '__manual__' ? '' : (clientSel?.value || '');
  return {
    client_id:      clientId,
    client_name:    document.getElementById('invClientName')?.value?.trim() || clientSel?.options[clientSel?.selectedIndex]?.getAttribute('data-name') || '',
    client_email:   document.getElementById('invClientEmail')?.value?.trim() || '',
    client_phone:   document.getElementById('invClientPhone')?.value?.trim() || '',
    client_address: document.getElementById('invClientAddress')?.value?.trim() || '',
    title:          document.getElementById('invTitle')?.value?.trim() || '',
    due_date:       document.getElementById('invDueDate')?.value || '',
    terms:          document.getElementById('invTerms')?.value || 'Net 30',
    notes:          document.getElementById('invNotes')?.value?.trim() || '',
    line_items:     lineItems,
    subtotal, tax_rate: taxRate, tax_amount: taxAmt, discount_amount: discount, total,
    amount_paid: 0, balance_due: total,
    status: action === 'sent' ? 'sent' : 'draft',
    ...(action === 'sent' ? { sent_at: new Date().toISOString() } : {})
  };
}

window._invSubmitBuilder = async function(invId, action) {
  const data = _invCollectBuilder(action);
  if (!data.title) { showToast('Invoice title is required', 'error'); return; }
  const method = invId ? 'PUT' : 'POST';
  const url    = invId ? `/api/invoices/${invId}` : '/api/invoices';
  const res = await fetch(url, { method, credentials:'include', headers:{'Content-Type':'application/json'}, body: JSON.stringify(data) });
  if (!res.ok) { showToast('Failed to save invoice', 'error'); return; }
  showToast(invId ? 'Invoice updated' : 'Invoice created', 'success');
  document.getElementById('inv-builder-overlay')?.remove();
  _invLoadList();
};

/* ── Void / Delete ──────────────────────────────────────────────────────────── */
window._invVoid = async function(invId) {
  if (!confirm('Void this invoice? It cannot be undone.')) return;
  await fetch(`/api/invoices/${invId}`, { method:'PUT', credentials:'include', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ status:'void' }) });
  showToast('Invoice voided', 'success');
  document.getElementById('inv-detail-overlay')?.remove();
  _invLoadList();
};
window._invDelete = async function(invId) {
  if (!confirm('Delete this draft invoice?')) return;
  await fetch(`/api/invoices/${invId}`, { method:'DELETE', credentials:'include' });
  showToast('Invoice deleted', 'success');
  document.getElementById('inv-detail-overlay')?.remove();
  _invLoadList();
};

/* ── Convert Estimate → Invoice (callable from estimates.js) ──────────────── */
window.gwConvertEstimateToInvoice = async function(estimateId, estimateTitle) {
  if (!confirm(`Convert "${estimateTitle||'this estimate'}" to an invoice?\n\nThe estimate will be marked as Invoiced and removed from your active estimates list.`)) return;
  const res = await fetch(`/api/invoices/from-estimate/${estimateId}`, { method:'POST', credentials:'include' });
  const data = await res.json();
  if (!res.ok) { showToast(data.error || 'Failed to convert', 'error'); return; }
  showToast(`Invoice ${data.invoice_number} created successfully`, 'success');
  // Navigate to invoices tab
  if (typeof window.show === 'function') window.show('invoices');
  else if (typeof gwInvoices === 'function') gwInvoices();
};

/* ── Portal ──────────────────────────────────────────────────────────────────── */
window.gwInvoicePortal = async function(token) {
  document.body.innerHTML = `<div style="min-height:100vh;display:flex;align-items:center;justify-content:center;background:#F9FAFB;font-family:'Inter',sans-serif"><div style="text-align:center;color:#9CA3AF">Loading invoice…</div></div>`;
  const [invRes, brandRes] = await Promise.all([
    fetch(`/api/invoices/portal/${token}`),
    fetch('/api/company/branding').catch(() => null)
  ]);
  if (!invRes.ok) { document.body.innerHTML = `<div style="text-align:center;padding:60px;font-family:'Inter',sans-serif;color:#6B7280">Invoice not found or link has expired.</div>`; return; }
  const inv = await invRes.json();
  let brand = {};
  if (brandRes?.ok) {
    try { const _raw = await brandRes.json(); brand = (_raw && _raw.data) ? _raw.data : _raw; } catch (_) {}
  }
  // Public portal viewers have no session — use branding embedded in the invoice payload
  if (inv && inv._brand) brand = { ...brand, ...inv._brand };
  if (typeof inv.line_items === 'string') try { inv.line_items = JSON.parse(inv.line_items); } catch(_) { inv.line_items = []; }
  _invRenderPortal(inv, brand);
};

function _invRenderPortal(inv, brand) {
  const primary = brand.brand_color || '#2D7A55';
  const li = Array.isArray(inv.line_items) ? inv.line_items : [];
  const s = INV_STATUS[inv.status] || INV_STATUS.draft;
  document.body.innerHTML = `
<div style="min-height:100vh;background:#F3F4F6;font-family:'Inter',sans-serif">
  <div style="background:${primary};padding:20px 24px;display:flex;align-items:center;justify-content:space-between;gap:12px">
    <div>
      ${brand.logo_url ? `<img src="${brand.logo_url}" alt="${brand.name||''}" style="height:44px;object-fit:contain">` : `<div style="font-size:22px;font-weight:900;color:#fff">${brand.name||'Groundwork'}</div>`}
      ${brand.tagline ? `<div style="font-size:11px;color:rgba(255,255,255,.72);margin-top:2px;font-style:italic">${brand.tagline}</div>` : ''}
    </div>
    <div style="text-align:right;color:rgba(255,255,255,.8);font-size:12px;line-height:1.6">
      ${brand.address_city ? `<div>${brand.address_city}${brand.address_state?', '+brand.address_state:''}</div>` : ''}
      ${brand.phone ? `<div>${brand.phone}</div>` : ''}
    </div>
  </div>
  <div style="max-width:760px;margin:32px auto;padding:0 16px">
    <div style="background:#fff;border-radius:16px;padding:32px;box-shadow:0 4px 24px rgba(0,0,0,.08)">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:28px;flex-wrap:wrap;gap:12px">
        <div>
          <div style="font-size:24px;font-weight:800;color:#111;margin-bottom:4px">${_invEsc(inv.invoice_number)}</div>
          <div style="font-size:14px;color:#6B7280">${_invEsc(inv.title||'')}</div>
        </div>
        <div><span style="display:inline-flex;align-items:center;gap:5px;padding:6px 14px;border-radius:20px;font-size:13px;font-weight:600;background:${inv.status==='paid'?'#DCFCE7':inv.status==='overdue'?'#FEE2E2':'#F3F4F6'};color:${inv.status==='paid'?'#166534':inv.status==='overdue'?'#991B1B':'#374151'}">${s.label}</span></div>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:20px;margin-bottom:28px">
        <div>
          <div style="font-size:11px;font-weight:700;color:#9CA3AF;text-transform:uppercase;letter-spacing:.06em;margin-bottom:6px">Bill To</div>
          <div style="font-size:15px;font-weight:600;color:#111">${_invEsc(inv.client_name||'—')}</div>
          ${inv.client_email ? `<div style="font-size:13px;color:#6B7280;margin-top:2px">${_invEsc(inv.client_email)}</div>` : ''}
        </div>
        <div>
          <div style="font-size:11px;font-weight:700;color:#9CA3AF;text-transform:uppercase;letter-spacing:.06em;margin-bottom:6px">Invoice Details</div>
          ${inv.due_date ? `<div style="font-size:13px;color:#374151"><span style="color:#9CA3AF">Due:</span> <strong>${_invDate(inv.due_date)}</strong></div>` : ''}
          ${inv.terms ? `<div style="font-size:13px;color:#374151;margin-top:2px"><span style="color:#9CA3AF">Terms:</span> ${inv.terms}</div>` : ''}
        </div>
      </div>
      <table style="width:100%;border-collapse:collapse;margin-bottom:24px">
        <thead><tr style="background:#F9FAFB">${['Description','Qty','Price','Total'].map((h,i) => `<th style="text-align:${i?'right':'left'};padding:10px 12px;font-size:11px;font-weight:700;color:#9CA3AF;text-transform:uppercase;letter-spacing:.06em">${h}</th>`).join('')}</tr></thead>
        <tbody>${li.map(l => `<tr style="border-bottom:1px solid #F3F4F6">
          <td style="padding:12px;font-size:14px;color:#111">${_invEsc(l.description||'')}</td>
          <td style="padding:12px;font-size:14px;color:#374151;text-align:right">${l.qty||1}</td>
          <td style="padding:12px;font-size:14px;color:#374151;text-align:right">${_invFmt(l.unit_price)}</td>
          <td style="padding:12px;font-size:14px;color:#111;font-weight:600;text-align:right">${_invFmt(l.total)}</td>
        </tr>`).join('')||`<tr><td colspan="4" style="padding:20px;text-align:center;color:#9CA3AF;font-size:13px">No line items</td></tr>`}</tbody>
      </table>
      <div style="display:flex;justify-content:flex-end">
        <div style="min-width:240px">
          <div style="display:flex;justify-content:space-between;padding:6px 0;font-size:13px;color:#6B7280"><span>Subtotal</span><span>${_invFmt(inv.subtotal)}</span></div>
          ${inv.tax_rate > 0 ? `<div style="display:flex;justify-content:space-between;padding:6px 0;font-size:13px;color:#6B7280"><span>Tax (${inv.tax_rate}%)</span><span>${_invFmt(inv.tax_amount)}</span></div>` : ''}
          <div style="display:flex;justify-content:space-between;padding:10px 0;font-size:18px;font-weight:800;color:#111;border-top:2px solid #E5E7EB;margin-top:6px"><span>Total</span><span>${_invFmt(inv.total)}</span></div>
          ${inv.amount_paid > 0 ? `<div style="display:flex;justify-content:space-between;padding:6px 0;font-size:13px;color:#2D7A55"><span>Amount Paid</span><span>${_invFmt(inv.amount_paid)}</span></div>` : ''}
          ${inv.balance_due > 0 ? `<div style="display:flex;justify-content:space-between;padding:8px 12px;background:#FEF2F2;border-radius:8px;font-size:15px;font-weight:700;color:#991B1B;margin-top:6px"><span>Balance Due</span><span>${_invFmt(inv.balance_due)}</span></div>` : ''}
        </div>
      </div>
      ${inv.notes ? `<div style="margin-top:24px;padding:16px;background:#F9FAFB;border-radius:8px;font-size:13px;color:#374151;line-height:1.6">${_invEsc(inv.notes)}</div>` : ''}
      ${inv.status === 'paid' ? `<div style="margin-top:24px;text-align:center;padding:20px;background:#DCFCE7;border-radius:12px"><div style="font-size:20px;font-weight:800;color:#166534">Invoice Paid ✓</div><div style="font-size:13px;color:#166534;margin-top:4px">Thank you for your payment!</div></div>` : `<div style="margin-top:24px;text-align:center"><div style="font-size:12px;color:#9CA3AF">To pay, contact ${brand.name||'us'} directly.</div>${brand.phone ? `<div style="font-size:13px;color:#374151;margin-top:4px;font-weight:600">${brand.phone}</div>` : ''}</div>`}
    </div>
    <div style="text-align:center;margin-top:20px;font-size:11px;color:#9CA3AF">Powered by Groundwork CRM</div>
  </div>
</div>`;
}

/* ── Overlay helper ──────────────────────────────────────────────────────────── */
function _invCreateOverlay(id) {
  document.getElementById(id)?.remove();
  const o = document.createElement('div');
  o.id = id; o.className = 'inv-overlay';
  o.addEventListener('click', e => { if (e.target === o) o.remove(); });
  return o;
}

/* ══════════════════════════════════════════════════════════════════════════════
   CSS — matches Estimates design language
══════════════════════════════════════════════════════════════════════════════ */
function _invInjectCSS() {
  const existing = document.getElementById('inv-styles');
  if (existing) existing.remove();
  const style = document.createElement('style');
  style.id = 'inv-styles';
  style.textContent = `

/* ── Wrapper ── */
.inv-wrap { padding: 24px 28px 60px; width: 100%; max-width: none; margin: 0; box-sizing: border-box; }

/* ── Header ── */
.inv-list-header { display:flex; align-items:flex-start; justify-content:space-between; padding:24px 0 0; gap:12px; flex-wrap:wrap; }
.inv-list-header-left { display:flex; align-items:baseline; gap:10px; flex-wrap:wrap; }
.inv-list-title { font-size:26px; font-weight:800; color:var(--gw-ink,#1C3A2B); letter-spacing:-.025em; margin:0; }
.inv-list-subtitle { font-size:13px; color:var(--gw-muted,#6B7280); font-weight:500; }
.inv-list-header-right { display:flex; gap:10px; }

/* ── KPI Row (matches est-kpi-row) ── */
.inv-kpi-row { display:grid; grid-template-columns:repeat(4,1fr); gap:12px; margin:20px 0 16px; }
.inv-kpi-card { background:var(--gw-surface,#fff); border:1.5px solid var(--gw-line,#E5E7EB); border-radius:14px; padding:16px 18px; cursor:pointer; transition:box-shadow .15s,transform .15s; position:relative; overflow:hidden; }
.inv-kpi-card:hover { box-shadow:0 4px 16px rgba(0,0,0,.08); transform:translateY(-1px); }
.inv-kpi-card--loading { min-height:88px; }
.inv-kpi-shimmer { position:absolute; inset:0; background:linear-gradient(90deg,#F3F4F6 25%,#E5E7EB 50%,#F3F4F6 75%); background-size:400% 100%; animation:invShimmer 1.4s infinite; border-radius:14px; }
@keyframes invShimmer { 0%{background-position:100% 0} 100%{background-position:-100% 0} }
.inv-kpi-top { display:flex; align-items:flex-start; justify-content:space-between; margin-bottom:8px; }
.inv-kpi-icon { width:30px; height:30px; border-radius:8px; display:flex; align-items:center; justify-content:center; }
.inv-kpi-icon--blue   { background:#EFF6FF; }
.inv-kpi-icon--amber  { background:#FFFBEB; }
.inv-kpi-icon--green  { background:#F0FDF4; }
.inv-kpi-icon--red    { background:#FEF2F2; }
.inv-kpi-count { font-size:11px; font-weight:700; color:var(--gw-muted,#9CA3AF); margin-top:6px; }
.inv-kpi-value { font-size:22px; font-weight:800; color:var(--gw-ink,#1C3A2B); letter-spacing:-.02em; line-height:1.2; }
.inv-kpi-label { font-size:11px; font-weight:600; color:var(--gw-muted,#6B7280); margin-top:4px; text-transform:uppercase; letter-spacing:.04em; }
.inv-kpi-card--blue   .inv-kpi-value { color:#1D4ED8; }
.inv-kpi-card--amber  .inv-kpi-value { color:#92400E; }
.inv-kpi-card--green  .inv-kpi-value { color:#166534; }
.inv-kpi-card--red    .inv-kpi-value { color:#991B1B; }
.inv-kpi-card--blue   { border-top:3px solid #3B82F6; }
.inv-kpi-card--amber  { border-top:3px solid #F59E0B; }
.inv-kpi-card--green  { border-top:3px solid #22C55E; }
.inv-kpi-card--red    { border-top:3px solid #EF4444; }
.inv-kpi-card--pulse  { animation:invPulse 2s ease-in-out infinite; }
@keyframes invPulse { 0%,100%{box-shadow:0 0 0 0 rgba(239,68,68,.2)} 50%{box-shadow:0 0 0 5px rgba(239,68,68,.0)} }

/* ── Filter bar ── */
.inv-filter-bar { display:flex; align-items:center; gap:12px; margin:0 0 14px; flex-wrap:wrap; }
.inv-search-wrap { display:flex; align-items:center; gap:8px; background:var(--gw-surface,#fff); border:1.5px solid var(--gw-line,#E5E7EB); border-radius:10px; padding:8px 12px; flex:1; min-width:200px; max-width:300px; }
.inv-search-icon { flex-shrink:0; color:#9CA3AF; }
.inv-search-input { border:none; outline:none; font-size:13px; color:var(--gw-ink,#111); background:transparent; width:100%; font-family:inherit; }
.inv-chip-bar { display:flex; gap:4px; flex-wrap:wrap; }
.inv-chip { padding:6px 14px; border:1.5px solid var(--gw-line,#E5E7EB); background:var(--gw-surface,#fff); border-radius:20px; font-size:12px; font-weight:600; color:var(--gw-muted,#6B7280); cursor:pointer; transition:all .15s; font-family:inherit; }
.inv-chip.active, .inv-chip:hover { background:#2D7A55; color:#fff; border-color:#2D7A55; }

/* ── Table ── */
.inv-table-wrap { background:var(--gw-surface,#fff); border:1.5px solid var(--gw-line,#E5E7EB); border-radius:14px; overflow:hidden; }
.inv-table { width:100%; border-collapse:collapse; }
.inv-table thead { background:var(--gw-surface-2,#F9FAFB); }
.inv-table th { padding:10px 14px; font-size:11px; font-weight:700; color:var(--gw-muted,#9CA3AF); text-transform:uppercase; letter-spacing:.05em; text-align:left; border-bottom:1.5px solid var(--gw-line,#E5E7EB); }
.inv-table td { padding:12px 14px; font-size:13px; color:var(--gw-ink,#374151); border-top:1px solid var(--gw-line,#F3F4F6); }
.inv-row { cursor:pointer; transition:background .1s; }
.inv-row:hover { background:var(--gw-surface-2,#F9FAFB); }
.inv-row--overdue { background:rgba(239,68,68,.025); }
.inv-row--overdue:hover { background:rgba(239,68,68,.05); }
.inv-num { font-weight:700; color:#1C3A2B; }
.inv-client-name { font-weight:600; color:var(--gw-ink,#111); }
.inv-client-email { font-size:11px; color:#9CA3AF; margin-top:2px; }
.inv-amount { font-weight:700; color:var(--gw-ink,#111); }
.inv-bal-due { color:#DC2626; font-weight:700; }
.inv-bal-zero { color:#2D7A55; font-weight:600; }
.inv-muted { color:#9CA3AF; }
.inv-overdue-text { color:#DC2626; font-weight:600; }
.inv-od-pill { display:inline-block; background:#FEE2E2; color:#991B1B; font-size:10px; font-weight:700; padding:1px 6px; border-radius:8px; margin-left:5px; vertical-align:middle; }
.inv-due-cell { font-size:13px; }

/* ── Row actions ── */
.inv-row-actions { display:flex; gap:4px; justify-content:flex-end; opacity:0; transition:opacity .15s; }
.inv-row:hover .inv-row-actions { opacity:1; }
.inv-action-btn { width:28px; height:28px; border:1.5px solid var(--gw-line,#E5E7EB); background:var(--gw-surface,#fff); border-radius:7px; cursor:pointer; display:flex; align-items:center; justify-content:center; transition:border-color .15s; padding:0; }
.inv-action-btn:hover { border-color:#9CA3AF; }
.inv-action-btn--green:hover { border-color:#2D7A55; }

/* ── Badge ── */
.inv-badge { display:inline-flex; align-items:center; gap:3px; padding:3px 9px; border-radius:20px; font-size:11px; font-weight:700; text-transform:uppercase; letter-spacing:.03em; white-space:nowrap; }
.inv-badge--draft   { background:#F3F4F6; color:#6B7280; }
.inv-badge--sent    { background:#DBEAFE; color:#1D4ED8; }
.inv-badge--viewed  { background:#E0E7FF; color:#4338CA; }
.inv-badge--partial { background:#FEF3C7; color:#92400E; }
.inv-badge--paid    { background:#DCFCE7; color:#166534; }
.inv-badge--overdue { background:#FEE2E2; color:#991B1B; }
.inv-badge--void    { background:#F3F4F6; color:#9CA3AF; text-decoration:line-through; }

/* ── Empty state ── */
.inv-empty-state { text-align:center; padding:60px 20px; background:var(--gw-surface,#fff); border:1.5px dashed var(--gw-line,#E5E7EB); border-radius:14px; }
.inv-empty-icon { margin-bottom:14px; opacity:.35; }
.inv-empty-title { font-size:17px; font-weight:700; color:var(--gw-ink,#374151); margin-bottom:6px; }
.inv-empty-sub { font-size:13px; color:#9CA3AF; }
.inv-loading { text-align:center; padding:48px; color:#9CA3AF; font-size:13px; display:flex; align-items:center; justify-content:center; gap:8px; }

/* ── Buttons ── */
.inv-btn-primary { display:inline-flex; align-items:center; gap:6px; padding:9px 16px; background:#2D7A55; color:#fff; border:none; border-radius:9px; font-size:13px; font-weight:700; cursor:pointer; font-family:inherit; transition:background .15s; white-space:nowrap; }
.inv-btn-primary:hover { background:#256645; }
.inv-btn-teal { display:inline-flex; align-items:center; gap:6px; padding:9px 16px; background:#4D8A86; color:#fff; border:none; border-radius:9px; font-size:13px; font-weight:700; cursor:pointer; font-family:inherit; transition:background .15s; white-space:nowrap; }
.inv-btn-teal:hover { background:#3d6e6b; }
.inv-btn-secondary { display:inline-flex; align-items:center; gap:6px; padding:9px 16px; background:var(--gw-surface,#fff); color:var(--gw-ink,#374151); border:1.5px solid var(--gw-line,#E5E7EB); border-radius:9px; font-size:13px; font-weight:600; cursor:pointer; font-family:inherit; transition:border-color .15s; white-space:nowrap; }
.inv-btn-secondary:hover { border-color:#9CA3AF; }
.inv-btn-ghost { display:inline-flex; align-items:center; gap:6px; padding:9px 14px; background:transparent; color:var(--gw-muted,#6B7280); border:none; border-radius:9px; font-size:13px; font-weight:600; cursor:pointer; font-family:inherit; }
.inv-btn-ghost:hover { color:var(--gw-ink,#374151); }

/* ── Mobile ── */
.inv-mobile-list { display:flex; flex-direction:column; gap:10px; padding-bottom:80px; }
.inv-mobile-card { background:var(--gw-surface,#fff); border:1.5px solid var(--gw-line,#E5E7EB); border-radius:12px; padding:12px 14px; cursor:pointer; transition:background .1s; }
.inv-mobile-card:active { background:var(--gw-surface-2,#F9FAFB); }
.inv-mobile-card--overdue { border-left:3px solid #EF4444; }
.inv-mc-top { display:flex; align-items:center; justify-content:space-between; margin-bottom:4px; }
.inv-mc-num { font-size:11px; font-weight:700; color:#9CA3AF; }
.inv-mc-client { font-size:14px; font-weight:700; color:var(--gw-ink,#111); margin-bottom:2px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.inv-mc-title { font-size:12px; color:#9CA3AF; margin-bottom:4px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.inv-mc-bottom { display:flex; align-items:center; gap:8px; flex-wrap:wrap; margin-top:4px; }
.inv-mc-total { font-size:14px; font-weight:700; color:var(--gw-ink,#111); flex:1; }
.inv-mc-bal { font-size:11px; font-weight:700; border-radius:20px; padding:2px 8px; }
.inv-mc-bal--due { background:#FEF2F2; color:#DC2626; }
.inv-mc-bal--paid { background:#ECFDF5; color:#065F46; }
.inv-mc-date { font-size:11px; color:#9CA3AF; }
.inv-mc-actions { display:flex; gap:6px; margin-top:10px; padding-top:10px; border-top:1px solid var(--gw-line,#F3F4F6); }
.inv-mc-act-btn { flex:1; padding:7px 4px; border:1.5px solid var(--gw-line,#E5E7EB); background:var(--gw-surface,#fff); border-radius:8px; font-size:11px; font-weight:600; color:var(--gw-muted,#6B7280); cursor:pointer; display:flex; align-items:center; justify-content:center; gap:4px; font-family:inherit; }
.inv-mc-act-btn--green { color:#2D7A55; border-color:rgba(45,122,85,.3); background:#F0FDF4; }

/* ── Modal ── */
.inv-overlay { position:fixed; inset:0; background:rgba(0,0,0,.5); z-index:9990; display:flex; align-items:flex-start; justify-content:center; padding:32px 16px; overflow-y:auto; }
.inv-modal { background:var(--gw-surface,#fff); border-radius:18px; width:100%; position:relative; box-shadow:0 24px 80px rgba(0,0,0,.28); }
.inv-detail-modal  { max-width:760px; }
.inv-builder-modal { max-width:920px; }
.inv-pay-modal     { max-width:460px; }
.inv-resend-modal  { max-width:500px; }
.inv-modal-header { display:flex; align-items:center; justify-content:space-between; padding:18px 24px; border-bottom:1.5px solid var(--gw-line,#F3F4F6); }
.inv-modal-title { display:flex; align-items:center; gap:10px; font-size:16px; font-weight:800; color:#1C3A2B; }
.inv-modal-close { width:32px; height:32px; border:none; background:var(--gw-surface-2,#F3F4F6); border-radius:8px; font-size:18px; cursor:pointer; color:#6B7280; display:flex; align-items:center; justify-content:center; }
.inv-modal-body { padding:24px; }

/* ── Detail modal ── */
.inv-detail-overdue-banner { background:#FEF2F2; border:1.5px solid rgba(239,68,68,.25); border-radius:10px; padding:10px 14px; font-size:13px; color:#991B1B; display:flex; align-items:center; gap:8px; margin-bottom:16px; }
.inv-detail-head { display:flex; align-items:flex-start; justify-content:space-between; gap:16px; flex-wrap:wrap; margin-bottom:16px; }
.inv-detail-head-left {}
.inv-detail-head-right { display:flex; gap:8px; flex-wrap:wrap; }
.inv-detail-num { font-size:22px; font-weight:800; color:#1C3A2B; }
.inv-detail-date-sub { font-size:12px; color:#9CA3AF; }
.inv-detail-dates-bar { display:flex; gap:10px; flex-wrap:wrap; margin-bottom:20px; padding:12px 14px; background:var(--gw-surface-2,#F9FAFB); border-radius:10px; }
.inv-detail-date-pill { display:flex; align-items:center; gap:8px; }
.inv-detail-date-lbl { font-size:10px; font-weight:700; color:#9CA3AF; text-transform:uppercase; letter-spacing:.05em; white-space:nowrap; }
.inv-detail-date-pill--red .inv-detail-date-lbl { color:#DC2626; }
.inv-date-inline { border:none; background:transparent; font-size:13px; font-weight:700; color:var(--gw-ink,#1C3A2B); font-family:inherit; cursor:pointer; outline:none; padding:2px 4px; border-radius:5px; transition:background .15s; }
.inv-date-inline:hover, .inv-date-inline:focus { background:var(--gw-line,#E5E7EB); }
.inv-date-select { appearance:none; -webkit-appearance:none; padding-right:18px; }
.inv-detail-parties { display:grid; grid-template-columns:1fr 1fr; gap:16px; margin-bottom:20px; padding:16px; background:var(--gw-surface-2,#F9FAFB); border-radius:12px; }
.inv-detail-party-lbl { font-size:10px; font-weight:700; color:#9CA3AF; text-transform:uppercase; letter-spacing:.06em; margin-bottom:5px; }
.inv-detail-party-name { font-size:15px; font-weight:700; color:var(--gw-ink,#111); margin-bottom:3px; }
.inv-detail-party-sub { display:flex; align-items:center; gap:5px; font-size:12px; color:#6B7280; margin-top:2px; }
.inv-li-section { margin-bottom:16px; }
.inv-li-table { width:100%; border-collapse:collapse; border:1.5px solid var(--gw-line,#E5E7EB); border-radius:10px; overflow:hidden; }
.inv-li-table thead { background:var(--gw-surface-2,#F9FAFB); }
.inv-li-table th { padding:8px 12px; font-size:11px; font-weight:700; color:#9CA3AF; text-transform:uppercase; letter-spacing:.05em; text-align:right; }
.inv-li-table th:first-child { text-align:left; }
.inv-li-table td { padding:10px 12px; font-size:13px; color:var(--gw-ink,#374151); border-top:1px solid var(--gw-line,#F3F4F6); }
.inv-totals-right { max-width:280px; margin-left:auto; margin-bottom:16px; }
.inv-total-row { display:flex; justify-content:space-between; align-items:center; padding:5px 0; font-size:13px; color:var(--gw-ink,#374151); }
.inv-total-grand { font-size:17px; font-weight:800; color:var(--gw-ink,#111); border-top:2px solid var(--gw-line,#E5E7EB); padding-top:8px; margin-top:4px; }
.inv-balance-final { font-size:15px; font-weight:800; }
.inv-pay-history { background:var(--gw-surface-2,#F9FAFB); border-radius:10px; padding:14px; margin-bottom:14px; }
.inv-pay-hist-title { font-size:11px; font-weight:700; color:#9CA3AF; text-transform:uppercase; letter-spacing:.05em; margin-bottom:10px; display:flex; align-items:center; gap:5px; }
.inv-pay-hist-row { display:flex; align-items:center; justify-content:space-between; margin-bottom:8px; }
.inv-pay-hist-left { display:flex; align-items:center; gap:10px; }
.inv-pay-hist-icon { flex-shrink:0; }
.inv-pay-hist-amt { font-size:14px; font-weight:700; color:#2D7A55; }
.inv-pay-hist-meta { font-size:11px; color:#9CA3AF; margin-top:1px; }
.inv-pay-hist-right { font-size:14px; font-weight:700; color:#2D7A55; }
.inv-detail-notes { padding:12px 14px; background:var(--gw-surface-2,#F9FAFB); border-radius:8px; font-size:13px; color:var(--gw-ink,#374151); display:flex; align-items:flex-start; gap:8px; line-height:1.6; margin-bottom:14px; }
.inv-portal-row { padding-top:14px; border-top:1.5px solid var(--gw-line,#F3F4F6); }
.inv-portal-input { flex:1; padding:8px 12px; border:1.5px solid var(--gw-line,#E5E7EB); border-radius:8px; font-size:12px; color:#9CA3AF; background:var(--gw-surface-2,#F9FAFB); outline:none; font-family:inherit; width:100%; box-sizing:border-box; }

/* ── Resend modal ── */
.inv-resend-inv-card { background:var(--gw-surface-2,#F9FAFB); border-radius:10px; padding:12px 14px; border-left:3px solid #4D8A86; }

/* ── Pay modal ── */
.inv-pay-summary-card { background:var(--gw-surface-2,#F9FAFB); border-radius:10px; padding:14px; }
.inv-pay-sum-row { display:flex; justify-content:space-between; font-size:13px; color:var(--gw-ink,#374151); margin-bottom:4px; align-items:center; }
.inv-pay-sum-row--totals { margin-top:10px; padding-top:10px; border-top:1px solid var(--gw-line,#E5E7EB); }
.inv-pay-sum-lbl { font-size:10px; color:#9CA3AF; text-transform:uppercase; font-weight:700; letter-spacing:.04em; margin-bottom:2px; }
.inv-pay-sum-val { font-size:16px; font-weight:800; color:var(--gw-ink,#111); }
.inv-pay-mode-tabs { display:flex; gap:6px; margin-top:16px; }
.inv-pay-mode-tab { flex:1; padding:9px 12px; border:1.5px solid var(--gw-line,#E5E7EB); background:var(--gw-surface,#fff); border-radius:9px; font-size:12px; font-weight:700; color:var(--gw-muted,#6B7280); cursor:pointer; display:flex; align-items:center; justify-content:center; gap:6px; font-family:inherit; transition:all .15s; }
.inv-pay-mode-tab.active { background:#1C3A2B; color:#fff; border-color:#1C3A2B; }
.inv-stripe-cards {}
.inv-stripe-note { font-size:11px; color:#4D8A86; display:flex; align-items:center; gap:5px; margin-top:8px; }
.inv-stripe-empty { text-align:center; padding:28px 16px; background:var(--gw-surface-2,#F9FAFB); border-radius:10px; margin-top:16px; }

/* ── Builder ── */
.inv-builder-grid { display:grid; grid-template-columns:1fr 1fr; gap:24px; }
.inv-builder-col { display:flex; flex-direction:column; gap:0; }
.inv-field-group { margin-bottom:14px; }
.inv-label { display:block; font-size:10px; font-weight:700; color:#9CA3AF; text-transform:uppercase; letter-spacing:.06em; margin-bottom:5px; }
.inv-input { width:100%; padding:9px 12px; border:1.5px solid var(--gw-line,#E5E7EB); border-radius:9px; font-size:13px; font-family:inherit; color:var(--gw-ink,#111); outline:none; transition:border-color .15s; box-sizing:border-box; background:var(--gw-surface,#fff); }
.inv-input:focus { border-color:#2D7A55; box-shadow:0 0 0 3px rgba(45,122,85,.1); }
.inv-select { width:100%; padding:9px 12px; border:1.5px solid var(--gw-line,#E5E7EB); border-radius:9px; font-size:13px; font-family:inherit; color:var(--gw-ink,#111); outline:none; background:var(--gw-surface,#fff); box-sizing:border-box; }
.inv-textarea { width:100%; padding:9px 12px; border:1.5px solid var(--gw-line,#E5E7EB); border-radius:9px; font-size:13px; font-family:inherit; color:var(--gw-ink,#111); outline:none; resize:vertical; background:var(--gw-surface,#fff); box-sizing:border-box; }
.inv-row2 { display:grid; grid-template-columns:1fr 1fr; gap:12px; }
.inv-add-line-btn { display:flex; align-items:center; gap:6px; padding:8px 12px; background:transparent; border:1.5px dashed var(--gw-line,#D1D5DB); border-radius:9px; font-size:12px; font-weight:600; color:#2D7A55; cursor:pointer; font-family:inherit; width:100%; justify-content:center; margin-top:6px; transition:border-color .15s; }
.inv-add-line-btn:hover { border-color:#2D7A55; background:#F0FAF4; }
.inv-builder-footer { display:flex; align-items:center; justify-content:space-between; padding:16px 24px; border-top:1.5px solid var(--gw-line,#F3F4F6); margin:16px -24px -24px; }
.inv-li-row { display:grid; grid-template-columns:1fr 65px 90px 76px 28px; gap:8px; align-items:center; margin-bottom:8px; }
.inv-li-desc { font-size:13px; }
.inv-li-qty, .inv-li-price { font-size:13px; text-align:right; }
.inv-li-total { font-size:13px; font-weight:700; color:#1C3A2B; text-align:right; }
.inv-li-remove { width:28px; height:28px; border:1.5px solid var(--gw-line,#E5E7EB); background:var(--gw-surface,#fff); border-radius:7px; cursor:pointer; display:flex; align-items:center; justify-content:center; transition:border-color .15s; padding:0; }
.inv-li-remove:hover { border-color:#EF4444; }
.inv-totals-preview { background:var(--gw-surface-2,#F9FAFB); border-radius:10px; padding:14px 16px; margin-top:12px; }

/* ── Responsive ── */
@media (max-width:860px) {
  .inv-kpi-row { grid-template-columns:repeat(2,1fr); }
  .inv-builder-grid { grid-template-columns:1fr; }
}
@media (max-width:640px) {
  .inv-kpi-row { grid-template-columns:repeat(2,1fr); }
  .inv-detail-parties { grid-template-columns:1fr; }
  .inv-detail-head { flex-direction:column; }
  .inv-li-row { grid-template-columns:1fr 55px 75px 62px 28px; }
  .inv-table-wrap { overflow-x:auto; }
}
`;
  document.head.appendChild(style);
}

// Initialize CSS immediately on script load
_invInjectCSS();
