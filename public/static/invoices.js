// ── Groundwork CRM — Invoices Module ──────────────────────────────────────────
// Full invoice lifecycle: list → create → view → send → payment tracking
// Version: 20260711p47
// Depends on: gw-icons.js, premium.css, app_premium.js (showToast, gwIcon)
// ─────────────────────────────────────────────────────────────────────────────

/* ── Status config ─────────────────────────────────────────────────────────── */
const INV_STATUS = {
  draft:       { label: 'Draft',       cls: 'inv-badge--draft',    icon: 'status-draft'    },
  sent:        { label: 'Sent',        cls: 'inv-badge--sent',     icon: 'status-sent'     },
  viewed:      { label: 'Viewed',      cls: 'inv-badge--viewed',   icon: 'status-viewed'   },
  partial:     { label: 'Partial',     cls: 'inv-badge--partial',  icon: 'payment'         },
  paid:        { label: 'Paid',        cls: 'inv-badge--paid',     icon: 'status-accepted' },
  overdue:     { label: 'Overdue',     cls: 'inv-badge--overdue',  icon: 'status-expired'  },
  void:        { label: 'Void',        cls: 'inv-badge--void',     icon: 'status-declined' },
  written_off: { label: 'Written Off', cls: 'inv-badge--void',     icon: 'status-declined' },
};

/* ── Currency formatter ────────────────────────────────────────────────────── */
function _invFmt(n) { return '$' + (Number(n)||0).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }
function _invDate(d) { if(!d) return '—'; const dt=new Date(d+'T00:00:00'); return dt.toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'}); }
function _invAgo(d) { if(!d) return ''; const ms=Date.now()-new Date(d).getTime(); const days=Math.floor(ms/86400000); return days===0?'Today':days===1?'Yesterday':`${days}d ago`; }
function _invBadge(status) {
  const s = INV_STATUS[status] || { label: status, cls: 'inv-badge--draft', icon: 'status-draft' };
  return `<span class="inv-badge ${s.cls}">${gwIcon(s.icon,11,'currentColor')}&nbsp;${s.label}</span>`;
}

/* ── Days overdue badge ────────────────────────────────────────────────────── */
function _invOverdueBadge(inv) {
  if (!['sent','viewed','partial'].includes(inv.status)) return '';
  if (!inv.due_date) return '';
  const days = Math.floor((Date.now() - new Date(inv.due_date+'T00:00:00').getTime()) / 86400000);
  if (days <= 0) return '';
  return `<span class="inv-overdue-badge">${days}d overdue</span>`;
}

/* ── Main invoice list ──────────────────────────────────────────────────────── */
window.gwInvoices = function() {
  const panel = document.getElementById('contentArea') || document.getElementById('premiumContent');
  if (!panel) return;
  panel.innerHTML = _invListSkeleton();
  _invLoadList();
};

function _invListSkeleton() {
  return `
<div class="inv-wrap">
  <div class="inv-topbar">
    <div class="inv-topbar-left">
      <div class="inv-title-row">
        ${gwIcon('invoice',22,'#1C3A2B')}
        <h1 class="inv-page-title">Invoices</h1>
      </div>
    </div>
    <div class="inv-topbar-right">
      <button class="inv-btn-secondary" onclick="_invOpenBuilder(null)">
        ${gwIcon('plus',14)} New Invoice
      </button>
    </div>
  </div>

  <div class="inv-filter-bar">
    <div class="inv-search-wrap">
      ${gwIcon('search',14,'#9CA3AF')}
      <input class="inv-search-input" type="text" placeholder="Search invoices…"
        id="invSearchInput" oninput="_invLoadList()" autocomplete="off">
    </div>
    <div class="inv-status-tabs" id="invStatusTabs">
      <button class="inv-tab active" data-status="" onclick="_invSetTab(this,'')">All</button>
      <button class="inv-tab" data-status="draft" onclick="_invSetTab(this,'draft')">Draft</button>
      <button class="inv-tab" data-status="sent" onclick="_invSetTab(this,'sent')">Sent</button>
      <button class="inv-tab" data-status="partial" onclick="_invSetTab(this,'partial')">Partial</button>
      <button class="inv-tab" data-status="paid" onclick="_invSetTab(this,'paid')">Paid</button>
      <button class="inv-tab" data-status="overdue" onclick="_invSetTab(this,'overdue')">Overdue</button>
    </div>
  </div>

  <div class="inv-summary-row" id="invSummaryRow">
    <div class="inv-summary-card">
      <div class="inv-sum-label">Total Outstanding</div>
      <div class="inv-sum-value" id="invSumOutstanding">—</div>
    </div>
    <div class="inv-summary-card inv-sum-overdue">
      <div class="inv-sum-label">Overdue</div>
      <div class="inv-sum-value" id="invSumOverdue">—</div>
    </div>
    <div class="inv-summary-card inv-sum-paid">
      <div class="inv-sum-label">Paid (30d)</div>
      <div class="inv-sum-value" id="invSumPaid">—</div>
    </div>
    <div class="inv-summary-card">
      <div class="inv-sum-label">Total Invoiced</div>
      <div class="inv-sum-value" id="invSumTotal">—</div>
    </div>
  </div>

  <div id="invListBody">
    <div class="inv-loading">${gwIcon('hourglass',20,'#9CA3AF')}&nbsp;Loading invoices…</div>
  </div>
</div>`;
}

let _invCurrentStatus = '';

function _invSetTab(btn, status) {
  document.querySelectorAll('.inv-tab').forEach(t => t.classList.remove('active'));
  btn.classList.add('active');
  _invCurrentStatus = status;
  _invLoadList();
}

async function _invLoadList() {
  const search = (document.getElementById('invSearchInput')?.value || '').trim();
  const status = _invCurrentStatus;
  let url = `/api/invoices?limit=200${status ? '&status='+status : ''}${search ? '&q='+encodeURIComponent(search) : ''}`;
  const res = await fetch(url, { credentials: 'include' });
  if (!res.ok) { document.getElementById('invListBody').innerHTML = '<div class="inv-empty">Failed to load invoices.</div>'; return; }
  const invoices = await res.json();

  // Update summary cards
  _invUpdateSummary(invoices);

  const body = document.getElementById('invListBody');
  if (!invoices.length) {
    body.innerHTML = `<div class="inv-empty">
      <div class="inv-empty-icon">${gwIcon('invoice',48,'var(--gw-text-muted,#9CA3AF)')}</div>
      <div class="inv-empty-title">No invoices yet</div>
      <div class="inv-empty-sub">Create your first invoice to start tracking payments.</div>
      <button class="inv-btn-secondary" style="margin-top:16px" onclick="_invOpenBuilder(null)">
        ${gwIcon('plus',14)} Create Invoice
      </button>
    </div>`;
    return;
  }

  body.innerHTML = `<div class="inv-table-wrap">
    <table class="inv-table">
      <thead>
        <tr>
          <th>Invoice #</th>
          <th>Client</th>
          <th>Title</th>
          <th>Date</th>
          <th>Due</th>
          <th>Total</th>
          <th>Balance Due</th>
          <th>Status</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        ${invoices.map(inv => `
          <tr class="inv-row" onclick="_invOpenDetail('${inv.id}')">
            <td class="inv-num">${inv.invoice_number}</td>
            <td class="inv-client">${inv.client_name||'<span class="inv-muted">No client</span>'}</td>
            <td class="inv-title-cell">${inv.title||''}</td>
            <td class="inv-date-cell">${_invAgo(inv.created_at)}</td>
            <td class="inv-due-cell ${inv.due_date && new Date(inv.due_date+'T00:00:00')<new Date() && ['sent','viewed','partial'].includes(inv.status) ? 'inv-overdue-text' : ''}">${_invDate(inv.due_date)}</td>
            <td class="inv-amount">${_invFmt(inv.total)}</td>
            <td class="inv-balance ${inv.balance_due > 0 ? 'inv-bal-due' : 'inv-bal-zero'}">${_invFmt(inv.balance_due)}</td>
            <td>${_invBadge(inv.status)} ${_invOverdueBadge(inv)}</td>
            <td class="inv-actions-cell" onclick="event.stopPropagation()">
              <div class="inv-actions">
                <button class="inv-action-btn" title="View" onclick="_invOpenDetail('${inv.id}')">${gwIcon('eye',13,'#6B7280')}</button>
                ${inv.status==='draft' ? `<button class="inv-action-btn" title="Edit" onclick="_invOpenBuilder('${inv.id}')">${gwIcon('edit',13,'#6B7280')}</button>` : ''}
                ${inv.status==='draft' ? `<button class="inv-action-btn inv-action-send" title="Send" onclick="_invSend('${inv.id}')">${gwIcon('send',13,'#2D7A55')}</button>` : ''}
              </div>
            </td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  </div>`;
}

function _invUpdateSummary(invoices) {
  const now = Date.now();
  const thirtyDaysAgo = now - 30*24*3600*1000;
  let outstanding = 0, overdue = 0, paid30 = 0, totalInvoiced = 0;
  invoices.forEach(inv => {
    totalInvoiced += inv.total||0;
    outstanding += inv.balance_due||0;
    if (inv.due_date && new Date(inv.due_date+'T00:00:00').getTime() < now && ['sent','viewed','partial'].includes(inv.status)) {
      overdue += inv.balance_due||0;
    }
    if (inv.status==='paid' && new Date(inv.paid_at||inv.updated_at).getTime() > thirtyDaysAgo) {
      paid30 += inv.amount_paid||0;
    }
  });
  const el = (id, v) => { const e = document.getElementById(id); if(e) e.textContent = _invFmt(v); };
  el('invSumOutstanding', outstanding);
  el('invSumOverdue', overdue);
  el('invSumPaid', paid30);
  el('invSumTotal', totalInvoiced);
}

/* ── Invoice Detail Modal ───────────────────────────────────────────────────── */
async function _invOpenDetail(invId) {
  const overlay = _invCreateOverlay('inv-detail-overlay');
  overlay.innerHTML = `<div class="inv-modal inv-detail-modal">
    <div class="inv-modal-header">
      <div class="inv-modal-title">${gwIcon('invoice',18,'#1C3A2B')} Invoice Detail</div>
      <button class="inv-modal-close" onclick="document.getElementById('inv-detail-overlay').remove()">×</button>
    </div>
    <div class="inv-modal-body" id="invDetailBody">
      <div class="inv-loading">${gwIcon('hourglass',20,'#9CA3AF')}&nbsp;Loading…</div>
    </div>
  </div>`;
  document.body.appendChild(overlay);

  const res = await fetch(`/api/invoices/${invId}`, { credentials: 'include' });
  if (!res.ok) { document.getElementById('invDetailBody').innerHTML = '<div class="inv-empty">Invoice not found.</div>'; return; }
  const inv = await res.json();
  _invRenderDetail(inv);
}

function _invRenderDetail(inv) {
  const body = document.getElementById('invDetailBody');
  const s = INV_STATUS[inv.status] || INV_STATUS.draft;
  const lineItems = Array.isArray(inv.line_items) ? inv.line_items : [];

  body.innerHTML = `
  <div class="inv-detail-top">
    <div class="inv-detail-meta">
      <div class="inv-detail-num">${inv.invoice_number}</div>
      <div class="inv-detail-status">${_invBadge(inv.status)}</div>
      <div class="inv-detail-date">Created ${_invAgo(inv.created_at)}</div>
    </div>
    <div class="inv-detail-actions">
      ${inv.status==='draft' ? `<button class="inv-btn-secondary" onclick="_invOpenBuilder('${inv.id}',true)">${gwIcon('edit',13)} Edit</button>` : ''}
      ${inv.status==='draft' ? `<button class="inv-btn-primary" onclick="_invSend('${inv.id}',true)">${gwIcon('send',13)} Send Invoice</button>` : ''}
      ${['sent','viewed','partial'].includes(inv.status) ? `<button class="inv-btn-primary" onclick="_invRecordPaymentModal('${inv.id}')">${gwIcon('payment',13)} Record Payment</button>` : ''}
      ${inv.status==='draft' ? `<button class="inv-btn-danger" onclick="_invDelete('${inv.id}')">${gwIcon('trash',13)} Delete</button>` : ''}
      ${inv.status!=='void' && inv.status!=='paid' ? `<button class="inv-btn-ghost" onclick="_invVoid('${inv.id}')">${gwIcon('status-declined',13)} Void</button>` : ''}
    </div>
  </div>

  <div class="inv-detail-grid">
    <div class="inv-detail-section">
      <div class="inv-detail-section-title">${gwIcon('user',14,'#6B7280')} Bill To</div>
      <div class="inv-detail-client-name">${inv.client_name||'—'}</div>
      ${inv.client_email ? `<div class="inv-detail-client-sub">${gwIcon('email',11,'#9CA3AF')} ${inv.client_email}</div>` : ''}
      ${inv.client_phone ? `<div class="inv-detail-client-sub">${gwIcon('phone',11,'#9CA3AF')} ${inv.client_phone}</div>` : ''}
      ${inv.client_address ? `<div class="inv-detail-client-sub">${gwIcon('map-pin',11,'#9CA3AF')} ${inv.client_address}</div>` : ''}
    </div>
    <div class="inv-detail-section">
      <div class="inv-detail-section-title">${gwIcon('calendar',14,'#6B7280')} Dates</div>
      <div class="inv-detail-kv"><span>Created</span><span>${_invDate(inv.created_at?.split('T')[0])}</span></div>
      ${inv.due_date ? `<div class="inv-detail-kv"><span>Due</span><span class="${new Date(inv.due_date+'T00:00:00')<new Date()&&['sent','viewed','partial'].includes(inv.status)?'inv-overdue-text':''}">${_invDate(inv.due_date)}</span></div>` : ''}
      ${inv.sent_at ? `<div class="inv-detail-kv"><span>Sent</span><span>${_invAgo(inv.sent_at)}</span></div>` : ''}
      ${inv.paid_at ? `<div class="inv-detail-kv"><span>Paid</span><span>${_invAgo(inv.paid_at)}</span></div>` : ''}
      <div class="inv-detail-kv"><span>Terms</span><span>${inv.terms||'Net 30'}</span></div>
    </div>
  </div>

  <div class="inv-line-items-section">
    <div class="inv-detail-section-title">${gwIcon('list',14,'#6B7280')} Line Items</div>
    <table class="inv-li-table">
      <thead><tr><th>Description</th><th>Qty</th><th>Unit Price</th><th>Total</th></tr></thead>
      <tbody>
        ${lineItems.map(li => `
          <tr>
            <td>${li.description||''}</td>
            <td>${li.qty||1} ${li.unit||''}</td>
            <td>${_invFmt(li.unit_price)}</td>
            <td>${_invFmt(li.total)}</td>
          </tr>
        `).join('') || '<tr><td colspan="4" class="inv-muted" style="text-align:center;padding:16px">No line items</td></tr>'}
      </tbody>
    </table>
  </div>

  <div class="inv-totals-section">
    <div class="inv-totals-grid">
      <div class="inv-total-row"><span>Subtotal</span><span>${_invFmt(inv.subtotal)}</span></div>
      ${inv.tax_rate > 0 ? `<div class="inv-total-row"><span>Tax (${inv.tax_rate}%)</span><span>${_invFmt(inv.tax_amount)}</span></div>` : ''}
      ${inv.discount_amount > 0 ? `<div class="inv-total-row inv-discount"><span>Discount</span><span>−${_invFmt(inv.discount_amount)}</span></div>` : ''}
      <div class="inv-total-row inv-total-grand"><span>Total</span><span>${_invFmt(inv.total)}</span></div>
      ${inv.amount_paid > 0 ? `<div class="inv-total-row inv-paid-row"><span>Amount Paid</span><span>${_invFmt(inv.amount_paid)}</span></div>` : ''}
      <div class="inv-total-row inv-balance-row"><span>Balance Due</span><span class="${inv.balance_due > 0 ? 'inv-bal-due' : 'inv-bal-zero'}">${_invFmt(inv.balance_due)}</span></div>
    </div>
  </div>

  ${inv.notes ? `<div class="inv-detail-notes"><div class="inv-detail-section-title">${gwIcon('document',14,'#6B7280')} Notes</div><p>${inv.notes}</p></div>` : ''}

  <div class="inv-portal-link-section">
    <div class="inv-detail-section-title">${gwIcon('globe',14,'#6B7280')} Client Portal Link</div>
    <div class="inv-portal-link-row">
      <input class="inv-portal-link-input" readonly value="${window.location.origin}/invoices/portal/${inv.portal_token}" id="invPortalLinkInput_${inv.id}">
      <button class="inv-btn-secondary" onclick="navigator.clipboard.writeText(document.getElementById('invPortalLinkInput_${inv.id}').value).then(()=>showToast('Link copied','success'))">${gwIcon('copy',13)} Copy</button>
    </div>
  </div>`;
}

/* ── Invoice Builder (Create / Edit) ─────────────────────────────────────────── */
async function _invOpenBuilder(invId, fromDetail) {
  // Close detail if open
  if (fromDetail) document.getElementById('inv-detail-overlay')?.remove();

  const overlay = _invCreateOverlay('inv-builder-overlay');
  overlay.innerHTML = `<div class="inv-modal inv-builder-modal">
    <div class="inv-modal-header">
      <div class="inv-modal-title">${gwIcon('invoice',18,'#1C3A2B')} ${invId ? 'Edit Invoice' : 'New Invoice'}</div>
      <button class="inv-modal-close" onclick="document.getElementById('inv-builder-overlay').remove()">×</button>
    </div>
    <div class="inv-modal-body" id="invBuilderBody">
      <div class="inv-loading">${gwIcon('hourglass',20,'#9CA3AF')}&nbsp;Loading…</div>
    </div>
  </div>`;
  document.body.appendChild(overlay);

  let inv = null;
  let clients = [];
  try {
    const [clRes, invRes] = await Promise.all([
      fetch('/api/clients?limit=500', { credentials: 'include' }),
      invId ? fetch(`/api/invoices/${invId}`, { credentials: 'include' }) : Promise.resolve(null)
    ]);
    clients = clRes.ok ? await clRes.json() : [];
    if (invRes) inv = invRes.ok ? await invRes.json() : null;
  } catch(e) {}

  _invRenderBuilder(inv, clients, invId);
}

function _invRenderBuilder(inv, clients, invId) {
  const body = document.getElementById('invBuilderBody');
  const lineItems = (inv?.line_items || [{ description: '', qty: 1, unit: '', unit_price: 0, total: 0 }]);

  // Default due date: 30 days out
  const defaultDue = new Date(); defaultDue.setDate(defaultDue.getDate()+30);
  const defaultDueStr = defaultDue.toISOString().split('T')[0];

  body.innerHTML = `
  <form id="invBuilderForm" onsubmit="_invSubmitBuilder(event,'${invId||''}')">
    <div class="inv-builder-grid">
      <div class="inv-builder-col">

        <div class="inv-field-group">
          <label class="inv-label">Client</label>
          <select class="inv-select" id="invClientId" onchange="_invOnClientChange()">
            <option value="">Select client…</option>
            ${clients.map(cl => `<option value="${cl.id}" data-name="${cl.name||''}" data-email="${cl.email||''}" data-phone="${cl.phone||''}" data-address="${cl.address||''}" ${inv?.client_id===cl.id?'selected':''}>${cl.name}</option>`).join('')}
            <option value="__manual__">Enter manually…</option>
          </select>
        </div>

        <div id="invClientManualFields" style="display:${!inv?.client_id||inv?.client_id&&!clients.find(c=>c.id===inv?.client_id)?'block':'none'}">
          <div class="inv-field-group">
            <label class="inv-label">Client Name</label>
            <input class="inv-input" type="text" id="invClientName" value="${inv?.client_name||''}" placeholder="Client name">
          </div>
          <div class="inv-row2">
            <div class="inv-field-group">
              <label class="inv-label">Email</label>
              <input class="inv-input" type="email" id="invClientEmail" value="${inv?.client_email||''}" placeholder="email@example.com">
            </div>
            <div class="inv-field-group">
              <label class="inv-label">Phone</label>
              <input class="inv-input" type="tel" id="invClientPhone" value="${inv?.client_phone||''}" placeholder="(555) 555-5555">
            </div>
          </div>
          <div class="inv-field-group">
            <label class="inv-label">Address</label>
            <input class="inv-input" type="text" id="invClientAddress" value="${inv?.client_address||''}" placeholder="123 Main St, City, VA 22180">
          </div>
        </div>

        <div class="inv-field-group">
          <label class="inv-label">Invoice Title</label>
          <input class="inv-input" type="text" id="invTitle" value="${inv?.title||''}" placeholder="Services for [project name]" required>
        </div>

        <div class="inv-row2">
          <div class="inv-field-group">
            <label class="inv-label">Due Date</label>
            <input class="inv-input" type="date" id="invDueDate" value="${inv?.due_date||defaultDueStr}">
          </div>
          <div class="inv-field-group">
            <label class="inv-label">Terms</label>
            <select class="inv-select" id="invTerms">
              <option value="Due on Receipt" ${inv?.terms==='Due on Receipt'?'selected':''}>Due on Receipt</option>
              <option value="Net 15" ${inv?.terms==='Net 15'?'selected':''}>Net 15</option>
              <option value="Net 30" ${!inv?.terms||inv?.terms==='Net 30'?'selected':''}>Net 30</option>
              <option value="Net 45" ${inv?.terms==='Net 45'?'selected':''}>Net 45</option>
              <option value="Net 60" ${inv?.terms==='Net 60'?'selected':''}>Net 60</option>
            </select>
          </div>
        </div>

        <div class="inv-field-group">
          <label class="inv-label">Notes (visible to client)</label>
          <textarea class="inv-textarea" id="invNotes" rows="2" placeholder="Thank you for your business!">${inv?.notes||''}</textarea>
        </div>

      </div>

      <div class="inv-builder-col">
        <div class="inv-field-group">
          <label class="inv-label">${gwIcon('list',13,'#374151')} Line Items</label>
          <div id="invLineItemsWrap">
            ${lineItems.map((li, i) => _invLineItemRow(li, i)).join('')}
          </div>
          <button type="button" class="inv-add-line-btn" onclick="_invAddLineItem()">
            ${gwIcon('plus',13,'#2D7A55')} Add Line Item
          </button>
        </div>

        <div class="inv-tax-row">
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
        <button type="submit" class="inv-btn-secondary" id="invSaveDraftBtn" data-action="draft">
          ${gwIcon('floppy',13,'#374151')} Save Draft
        </button>
        <button type="button" class="inv-btn-primary" onclick="_invSubmitAndSend()">
          ${gwIcon('send',13,'#fff')} Save & Send
        </button>
      </div>
    </div>
  </form>`;

  _invCalcTotals();
}

function _invLineItemRow(li, i) {
  return `<div class="inv-li-row" data-idx="${i}" id="invLiRow_${i}">
    <input class="inv-input inv-li-desc" type="text" placeholder="Description" value="${li.description||''}" oninput="_invCalcTotals()">
    <input class="inv-input inv-li-qty" type="number" placeholder="Qty" value="${li.qty||1}" min="0" step="any" oninput="_invCalcTotals()">
    <input class="inv-input inv-li-price" type="number" placeholder="Unit $" value="${li.unit_price||0}" min="0" step="0.01" oninput="_invCalcTotals()">
    <div class="inv-li-total" id="invLiTotal_${i}">${_invFmt((li.qty||1)*(li.unit_price||0))}</div>
    <button type="button" class="inv-li-remove" onclick="_invRemoveLineItem(${i})">${gwIcon('trash',12,'#9CA3AF')}</button>
  </div>`;
}

let _invLineCount = 1;

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
  document.querySelectorAll('.inv-li-row').forEach((row, i) => {
    const qty = parseFloat(row.querySelector('.inv-li-qty')?.value || 1) || 0;
    const price = parseFloat(row.querySelector('.inv-li-price')?.value || 0) || 0;
    const lineTotal = qty * price;
    subtotal += lineTotal;
    const totalEl = row.querySelector('.inv-li-total');
    if (totalEl) totalEl.textContent = _invFmt(lineTotal);
  });
  const taxRate = parseFloat(document.getElementById('invTaxRate')?.value || 0) || 0;
  const discount = parseFloat(document.getElementById('invDiscount')?.value || 0) || 0;
  const taxAmt = subtotal * taxRate / 100;
  const total = subtotal + taxAmt - discount;

  const el = (id, v) => { const e=document.getElementById(id); if(e) e.textContent=v; };
  el('invPrevSubtotal', _invFmt(subtotal));
  el('invPrevTax', _invFmt(taxAmt));
  el('invPrevDiscount', '−'+_invFmt(discount));
  el('invPrevTotal', _invFmt(Math.max(0, total)));
  el('invPrevTaxLabel', `Tax (${taxRate}%)`);
  const taxRow = document.getElementById('invPrevTaxRow');
  const discRow = document.getElementById('invPrevDiscountRow');
  if (taxRow) taxRow.style.display = taxRate > 0 ? '' : 'none';
  if (discRow) discRow.style.display = discount > 0 ? '' : 'none';
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
    // Auto-fill name/email/phone from client data
    const name = opt.getAttribute('data-name') || '';
    const email = opt.getAttribute('data-email') || '';
    const phone = opt.getAttribute('data-phone') || '';
    const addr  = opt.getAttribute('data-address') || '';
    ['invClientName','invClientEmail','invClientPhone','invClientAddress'].forEach((id, i) => {
      const e = document.getElementById(id); if(e) e.value = [name,email,phone,addr][i];
    });
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
  const taxRate = parseFloat(document.getElementById('invTaxRate')?.value || 0) || 0;
  const discount = parseFloat(document.getElementById('invDiscount')?.value || 0) || 0;
  const subtotal = lineItems.reduce((s, li) => s + li.total, 0);
  const taxAmt = subtotal * taxRate / 100;
  const total = Math.max(0, subtotal + taxAmt - discount);
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
    status: action === 'sent' ? 'sent' : 'draft'
  };
}

window._invSubmitBuilder = async function(e, invId) {
  e?.preventDefault();
  const data = _invCollectBuilder('draft');
  if (!data.title) { showToast('Invoice title is required', 'error'); return; }
  const btn = document.getElementById('invSaveDraftBtn');
  if (btn) { btn.disabled = true; btn.innerHTML = `${gwIcon('hourglass',13)} Saving…`; }

  const method = invId ? 'PUT' : 'POST';
  const url    = invId ? `/api/invoices/${invId}` : '/api/invoices';
  const res = await fetch(url, { method, credentials: 'include', headers: {'Content-Type':'application/json'}, body: JSON.stringify(data) });
  if (!res.ok) { showToast('Failed to save invoice', 'error'); if(btn){btn.disabled=false;btn.innerHTML=`${gwIcon('floppy',13)} Save Draft`;} return; }

  showToast(invId ? 'Invoice updated' : 'Invoice created', 'success');
  document.getElementById('inv-builder-overlay')?.remove();
  _invLoadList();
};

window._invSubmitAndSend = async function() {
  const data = _invCollectBuilder('sent');
  if (!data.title) { showToast('Invoice title is required', 'error'); return; }
  data.status = 'sent';
  data.sent_at = new Date().toISOString();
  const invId = document.querySelector('#invBuilderForm')?.dataset?.invId || '';
  const method = invId ? 'PUT' : 'POST';
  const url    = invId ? `/api/invoices/${invId}` : '/api/invoices';
  const res = await fetch(url, { method, credentials: 'include', headers: {'Content-Type':'application/json'}, body: JSON.stringify(data) });
  if (!res.ok) { showToast('Failed to save invoice', 'error'); return; }
  showToast('Invoice saved and marked as sent', 'success');
  document.getElementById('inv-builder-overlay')?.remove();
  _invLoadList();
};

/* ── Send Invoice ───────────────────────────────────────────────────────────── */
async function _invSend(invId, fromDetail) {
  const res = await fetch(`/api/invoices/${invId}/send`, { method: 'POST', credentials: 'include' });
  if (!res.ok) { showToast('Failed to send invoice', 'error'); return; }
  showToast('Invoice marked as sent', 'success');
  if (fromDetail) {
    const detRes = await fetch(`/api/invoices/${invId}`, { credentials: 'include' });
    if (detRes.ok) _invRenderDetail(await detRes.json());
  }
  _invLoadList();
}

/* ── Record Payment Modal ───────────────────────────────────────────────────── */
async function _invRecordPaymentModal(invId) {
  // Get current invoice
  const res = await fetch(`/api/invoices/${invId}`, { credentials: 'include' });
  if (!res.ok) return;
  const inv = await res.json();

  const overlay = _invCreateOverlay('inv-pay-overlay');
  overlay.innerHTML = `<div class="inv-modal inv-pay-modal">
    <div class="inv-modal-header">
      <div class="inv-modal-title">${gwIcon('payment',18,'#1C3A2B')} Record Payment</div>
      <button class="inv-modal-close" onclick="document.getElementById('inv-pay-overlay').remove()">×</button>
    </div>
    <div class="inv-modal-body">
      <div class="inv-pay-summary">
        <div class="inv-pay-row"><span>Invoice</span><strong>${inv.invoice_number}</strong></div>
        <div class="inv-pay-row"><span>Client</span><strong>${inv.client_name||'—'}</strong></div>
        <div class="inv-pay-row"><span>Total</span><strong>${_invFmt(inv.total)}</strong></div>
        <div class="inv-pay-row inv-pay-balance"><span>Balance Due</span><strong class="inv-bal-due">${_invFmt(inv.balance_due)}</strong></div>
      </div>
      <div class="inv-field-group" style="margin-top:20px">
        <label class="inv-label">Payment Amount</label>
        <input class="inv-input" type="number" id="invPayAmount" value="${inv.balance_due||0}" min="0.01" step="0.01" placeholder="0.00">
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
          <option value="other">Other</option>
        </select>
      </div>
      <div class="inv-field-group">
        <label class="inv-label">Note (optional)</label>
        <input class="inv-input" type="text" id="invPayNote" placeholder="Check #1234, received 7/11/26…">
      </div>
      <div class="inv-builder-footer" style="border-top:none;padding-top:0">
        <button class="inv-btn-ghost" onclick="document.getElementById('inv-pay-overlay').remove()">Cancel</button>
        <button class="inv-btn-primary" onclick="_invSubmitPayment('${invId}')">
          ${gwIcon('payment',13,'#fff')} Record Payment
        </button>
      </div>
    </div>
  </div>`;
  document.body.appendChild(overlay);
}

window._invSubmitPayment = async function(invId) {
  const amount = parseFloat(document.getElementById('invPayAmount')?.value || 0);
  const method = document.getElementById('invPayMethod')?.value || 'check';
  const note   = document.getElementById('invPayNote')?.value?.trim() || '';
  if (!amount || amount <= 0) { showToast('Enter a valid amount', 'error'); return; }

  const res = await fetch(`/api/invoices/${invId}/record-payment`, {
    method: 'POST', credentials: 'include',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ amount, method, note })
  });
  const data = await res.json();
  if (!res.ok) { showToast('Failed to record payment', 'error'); return; }

  showToast(`Payment of ${_invFmt(amount)} recorded — ${data.status === 'paid' ? 'Invoice PAID' : 'Partial payment'}`, 'success');
  document.getElementById('inv-pay-overlay')?.remove();

  // Refresh detail if open
  const detailBody = document.getElementById('invDetailBody');
  if (detailBody) {
    const invRes = await fetch(`/api/invoices/${invId}`, { credentials: 'include' });
    if (invRes.ok) _invRenderDetail(await invRes.json());
  }
  _invLoadList();
};

/* ── Void & Delete ──────────────────────────────────────────────────────────── */
window._invVoid = async function(invId) {
  if (!confirm('Void this invoice? It cannot be undone.')) return;
  await fetch(`/api/invoices/${invId}`, { method: 'PUT', credentials: 'include', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ status: 'void', voided_at: new Date().toISOString() }) });
  showToast('Invoice voided', 'success');
  document.getElementById('inv-detail-overlay')?.remove();
  _invLoadList();
};

window._invDelete = async function(invId) {
  if (!confirm('Delete this draft invoice?')) return;
  await fetch(`/api/invoices/${invId}`, { method: 'DELETE', credentials: 'include' });
  showToast('Invoice deleted', 'success');
  document.getElementById('inv-detail-overlay')?.remove();
  _invLoadList();
};

/* ── Convert Estimate → Invoice (callable from estimates.js) ─────────────────── */
window.gwConvertEstimateToInvoice = async function(estimateId, estimateTitle) {
  if (!confirm(`Convert "${estimateTitle||'this estimate'}" to an invoice?`)) return;
  const res = await fetch(`/api/invoices/from-estimate/${estimateId}`, { method: 'POST', credentials: 'include' });
  const data = await res.json();
  if (!res.ok) { showToast(data.error || 'Failed to convert', 'error'); return; }
  showToast(`Invoice ${data.invoice_number} created`, 'success');
  // Switch to invoices tab if available
  if (typeof gwInvoices === 'function') gwInvoices();
};

/* ── Public Invoice Portal Page (loaded at /invoices/portal/:token) ─────────── */
window.gwInvoicePortal = async function(token) {
  document.body.innerHTML = `<div style="min-height:100vh;display:flex;align-items:center;justify-content:center;background:#F9FAFB;font-family:'Inter',sans-serif">
    <div style="text-align:center;color:#9CA3AF">Loading invoice…</div>
  </div>`;

  const [invRes, brandRes] = await Promise.all([
    fetch(`/api/invoices/portal/${token}`),
    fetch('/api/company/branding').catch(() => null)
  ]);
  if (!invRes.ok) {
    document.body.innerHTML = `<div style="text-align:center;padding:60px;font-family:'Inter',sans-serif;color:#6B7280">Invoice not found or link has expired.</div>`;
    return;
  }
  const inv = await invRes.json();
  const brand = brandRes?.ok ? await brandRes.json() : {};
  _invRenderPortal(inv, brand);
};

function _invRenderPortal(inv, brand) {
  const primaryColor = brand.brand_color || '#2D7A55';
  const lineItems = Array.isArray(inv.line_items) ? inv.line_items : [];
  const s = INV_STATUS[inv.status] || INV_STATUS.draft;

  document.body.innerHTML = `
<div style="min-height:100vh;background:#F3F4F6;font-family:'Inter',sans-serif">
  <div style="background:${primaryColor};padding:20px 24px;display:flex;align-items:center;justify-content:space-between;gap:12px">
    <div>
      ${brand.logo_url ? `<img src="${brand.logo_url}" alt="${brand.name||''}" style="height:44px;object-fit:contain">` :
        `<div style="font-size:22px;font-weight:900;color:#fff">${brand.name||'Groundwork'}</div>`}
      ${brand.tagline ? `<div style="font-size:12px;color:rgba(255,255,255,.75);margin-top:2px;font-style:italic">${brand.tagline}</div>` : ''}
    </div>
    <div style="text-align:right;color:rgba(255,255,255,.85);font-size:12px;line-height:1.6">
      ${brand.address_city ? `<div>${brand.address_city}${brand.address_state?', '+brand.address_state:''}</div>` : ''}
      ${brand.phone ? `<div>${brand.phone}</div>` : ''}
    </div>
  </div>

  <div style="max-width:760px;margin:32px auto;padding:0 16px">
    <div style="background:#fff;border-radius:16px;padding:32px;box-shadow:0 4px 24px rgba(0,0,0,.08)">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:28px;flex-wrap:wrap;gap:12px">
        <div>
          <div style="font-size:24px;font-weight:800;color:#111;margin-bottom:4px">${inv.invoice_number}</div>
          <div style="font-size:14px;color:#6B7280">${inv.title||''}</div>
        </div>
        <div>
          <span style="display:inline-flex;align-items:center;gap:5px;padding:6px 14px;border-radius:20px;font-size:13px;font-weight:600;background:${inv.status==='paid'?'#DCFCE7':inv.status==='overdue'?'#FEE2E2':'#F3F4F6'};color:${inv.status==='paid'?'#166534':inv.status==='overdue'?'#991B1B':'#374151'}">
            ${s.label}
          </span>
        </div>
      </div>

      <div style="display:grid;grid-template-columns:1fr 1fr;gap:20px;margin-bottom:28px">
        <div>
          <div style="font-size:11px;font-weight:700;color:#9CA3AF;text-transform:uppercase;letter-spacing:.06em;margin-bottom:6px">Bill To</div>
          <div style="font-size:15px;font-weight:600;color:#111">${inv.client_name||'—'}</div>
          ${inv.client_email ? `<div style="font-size:13px;color:#6B7280;margin-top:2px">${inv.client_email}</div>` : ''}
          ${inv.client_address ? `<div style="font-size:13px;color:#6B7280;margin-top:2px">${inv.client_address}</div>` : ''}
        </div>
        <div>
          <div style="font-size:11px;font-weight:700;color:#9CA3AF;text-transform:uppercase;letter-spacing:.06em;margin-bottom:6px">Invoice Details</div>
          ${inv.due_date ? `<div style="font-size:13px;color:#374151"><span style="color:#9CA3AF">Due:</span> <strong>${_invDate(inv.due_date)}</strong></div>` : ''}
          ${inv.terms ? `<div style="font-size:13px;color:#374151;margin-top:2px"><span style="color:#9CA3AF">Terms:</span> ${inv.terms}</div>` : ''}
        </div>
      </div>

      <table style="width:100%;border-collapse:collapse;margin-bottom:24px">
        <thead>
          <tr style="background:#F9FAFB">
            <th style="text-align:left;padding:10px 12px;font-size:11px;font-weight:700;color:#9CA3AF;text-transform:uppercase;letter-spacing:.06em">Description</th>
            <th style="text-align:right;padding:10px 12px;font-size:11px;font-weight:700;color:#9CA3AF;text-transform:uppercase;letter-spacing:.06em">Qty</th>
            <th style="text-align:right;padding:10px 12px;font-size:11px;font-weight:700;color:#9CA3AF;text-transform:uppercase;letter-spacing:.06em">Price</th>
            <th style="text-align:right;padding:10px 12px;font-size:11px;font-weight:700;color:#9CA3AF;text-transform:uppercase;letter-spacing:.06em">Total</th>
          </tr>
        </thead>
        <tbody>
          ${lineItems.map(li => `
            <tr style="border-bottom:1px solid #F3F4F6">
              <td style="padding:12px;font-size:14px;color:#111">${li.description||''}</td>
              <td style="padding:12px;font-size:14px;color:#374151;text-align:right">${li.qty||1}</td>
              <td style="padding:12px;font-size:14px;color:#374151;text-align:right">${_invFmt(li.unit_price)}</td>
              <td style="padding:12px;font-size:14px;color:#111;font-weight:600;text-align:right">${_invFmt(li.total)}</td>
            </tr>
          `).join('') || `<tr><td colspan="4" style="padding:20px;text-align:center;color:#9CA3AF;font-size:13px">No line items</td></tr>`}
        </tbody>
      </table>

      <div style="display:flex;justify-content:flex-end">
        <div style="min-width:240px">
          <div style="display:flex;justify-content:space-between;padding:6px 0;font-size:13px;color:#6B7280">
            <span>Subtotal</span><span>${_invFmt(inv.subtotal)}</span>
          </div>
          ${inv.tax_rate > 0 ? `<div style="display:flex;justify-content:space-between;padding:6px 0;font-size:13px;color:#6B7280"><span>Tax (${inv.tax_rate}%)</span><span>${_invFmt(inv.tax_amount)}</span></div>` : ''}
          ${inv.discount_amount > 0 ? `<div style="display:flex;justify-content:space-between;padding:6px 0;font-size:13px;color:#6B7280"><span>Discount</span><span>−${_invFmt(inv.discount_amount)}</span></div>` : ''}
          <div style="display:flex;justify-content:space-between;padding:10px 0;font-size:18px;font-weight:800;color:#111;border-top:2px solid #E5E7EB;margin-top:6px">
            <span>Total</span><span>${_invFmt(inv.total)}</span>
          </div>
          ${inv.amount_paid > 0 ? `<div style="display:flex;justify-content:space-between;padding:6px 0;font-size:13px;color:#2D7A55"><span>Amount Paid</span><span>${_invFmt(inv.amount_paid)}</span></div>` : ''}
          ${inv.balance_due > 0 ? `<div style="display:flex;justify-content:space-between;padding:8px 12px;background:#FEF2F2;border-radius:8px;font-size:15px;font-weight:700;color:#991B1B;margin-top:6px"><span>Balance Due</span><span>${_invFmt(inv.balance_due)}</span></div>` : ''}
        </div>
      </div>

      ${inv.notes ? `<div style="margin-top:24px;padding:16px;background:#F9FAFB;border-radius:8px;font-size:13px;color:#374151;line-height:1.6">${inv.notes}</div>` : ''}

      ${inv.status === 'paid' ? `
        <div style="margin-top:24px;text-align:center;padding:20px;background:#DCFCE7;border-radius:12px">
          <div style="font-size:20px;font-weight:800;color:#166534">Invoice Paid</div>
          <div style="font-size:13px;color:#166534;margin-top:4px">Thank you for your payment!</div>
        </div>
      ` : `
        <div style="margin-top:24px;text-align:center">
          <div style="font-size:12px;color:#9CA3AF">To pay by check or bank transfer, contact ${brand.name||'us'} directly.</div>
          ${brand.phone ? `<div style="font-size:13px;color:#374151;margin-top:4px;font-weight:600">${brand.phone}</div>` : ''}
        </div>
      `}
    </div>

    <div style="text-align:center;margin-top:20px;font-size:11px;color:#9CA3AF">
      Powered by Groundwork CRM
    </div>
  </div>
</div>`;
}

/* ── Helper: create overlay ──────────────────────────────────────────────────── */
function _invCreateOverlay(id) {
  document.getElementById(id)?.remove();
  const overlay = document.createElement('div');
  overlay.id = id;
  overlay.className = 'inv-overlay';
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
  return overlay;
}

/* ── CSS injection ───────────────────────────────────────────────────────────── */
(function _invInjectCSS() {
  if (document.getElementById('inv-styles')) return;
  const style = document.createElement('style');
  style.id = 'inv-styles';
  style.textContent = `
/* ── Invoice wrapper ── */
.inv-wrap { padding: 0 0 40px; max-width: 1200px; }
.inv-topbar { display: flex; align-items: center; justify-content: space-between; padding: 24px 0 0; gap: 12px; flex-wrap: wrap; }
.inv-topbar-left { display: flex; align-items: center; gap: 12px; }
.inv-title-row { display: flex; align-items: center; gap: 10px; }
.inv-page-title { font-size: 22px; font-weight: 800; color: #1C3A2B; letter-spacing: -.02em; }
.inv-topbar-right { display: flex; gap: 10px; }

/* ── Filter bar ── */
.inv-filter-bar { display: flex; align-items: center; gap: 12px; margin: 16px 0 12px; flex-wrap: wrap; }
.inv-search-wrap { display: flex; align-items: center; gap: 8px; background: #fff; border: 1.5px solid #E5E7EB; border-radius: 10px; padding: 8px 12px; flex: 1; min-width: 200px; max-width: 320px; }
.inv-search-input { border: none; outline: none; font-size: 13px; color: #111; background: transparent; width: 100%; font-family: inherit; }
.inv-status-tabs { display: flex; gap: 4px; flex-wrap: wrap; }
.inv-tab { padding: 6px 14px; border: 1.5px solid #E5E7EB; background: #fff; border-radius: 20px; font-size: 12px; font-weight: 600; color: #6B7280; cursor: pointer; transition: all .15s; font-family: inherit; }
.inv-tab.active, .inv-tab:hover { background: #2D7A55; color: #fff; border-color: #2D7A55; }

/* ── Summary cards ── */
.inv-summary-row { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-bottom: 16px; }
.inv-summary-card { background: #fff; border: 1.5px solid #E5E7EB; border-radius: 12px; padding: 14px 16px; }
.inv-sum-label { font-size: 11px; font-weight: 700; color: #9CA3AF; text-transform: uppercase; letter-spacing: .06em; margin-bottom: 4px; }
.inv-sum-value { font-size: 20px; font-weight: 800; color: #1C3A2B; letter-spacing: -.02em; }
.inv-sum-overdue .inv-sum-value { color: #DC2626; }
.inv-sum-paid .inv-sum-value { color: #2D7A55; }

/* ── Table ── */
.inv-table-wrap { background: #fff; border: 1.5px solid #E5E7EB; border-radius: 14px; overflow: hidden; }
.inv-table { width: 100%; border-collapse: collapse; }
.inv-table thead { background: #F9FAFB; }
.inv-table th { padding: 10px 14px; font-size: 11px; font-weight: 700; color: #9CA3AF; text-transform: uppercase; letter-spacing: .06em; text-align: left; }
.inv-table td { padding: 12px 14px; font-size: 13px; color: #374151; border-top: 1px solid #F3F4F6; }
.inv-row { cursor: pointer; transition: background .1s; }
.inv-row:hover { background: #F9FAFB; }
.inv-num { font-weight: 700; color: #1C3A2B; font-size: 13px; }
.inv-client { font-weight: 600; color: #111; }
.inv-amount { font-weight: 700; color: #111; }
.inv-bal-due { color: #DC2626; font-weight: 700; }
.inv-bal-zero { color: #2D7A55; font-weight: 600; }
.inv-muted { color: #9CA3AF; }
.inv-overdue-text { color: #DC2626; font-weight: 600; }
.inv-overdue-badge { display: inline-block; background: #FEE2E2; color: #991B1B; font-size: 10px; font-weight: 700; padding: 2px 7px; border-radius: 10px; margin-left: 5px; vertical-align: middle; }

/* ── Badge ── */
.inv-badge { display: inline-flex; align-items: center; gap: 4px; padding: 3px 9px; border-radius: 12px; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .04em; }
.inv-badge--draft   { background: #F3F4F6; color: #6B7280; }
.inv-badge--sent    { background: #DBEAFE; color: #1D4ED8; }
.inv-badge--viewed  { background: #E0E7FF; color: #4338CA; }
.inv-badge--partial { background: #FEF3C7; color: #92400E; }
.inv-badge--paid    { background: #DCFCE7; color: #166534; }
.inv-badge--overdue { background: #FEE2E2; color: #991B1B; }
.inv-badge--void    { background: #F3F4F6; color: #9CA3AF; text-decoration: line-through; }

/* ── Actions ── */
.inv-actions-cell { width: 80px; }
.inv-actions { display: flex; gap: 4px; justify-content: flex-end; opacity: 0; transition: opacity .15s; }
.inv-row:hover .inv-actions { opacity: 1; }
.inv-action-btn { width: 28px; height: 28px; border: 1.5px solid #E5E7EB; background: #fff; border-radius: 7px; cursor: pointer; display: flex; align-items: center; justify-content: center; transition: border-color .15s; }
.inv-action-btn:hover { border-color: #9CA3AF; }
.inv-action-send:hover { border-color: #2D7A55 !important; }

/* ── Empty state ── */
.inv-empty { text-align: center; padding: 60px 20px; background: #fff; border: 1.5px dashed #E5E7EB; border-radius: 14px; }
.inv-empty-icon { margin-bottom: 12px; opacity: .4; }
.inv-empty-title { font-size: 17px; font-weight: 700; color: #374151; margin-bottom: 6px; }
.inv-empty-sub { font-size: 13px; color: #9CA3AF; }
.inv-loading { text-align: center; padding: 40px; color: #9CA3AF; font-size: 13px; display: flex; align-items: center; justify-content: center; gap: 8px; }

/* ── Buttons ── */
.inv-btn-primary { display: inline-flex; align-items: center; gap: 6px; padding: 9px 16px; background: #2D7A55; color: #fff; border: none; border-radius: 9px; font-size: 13px; font-weight: 700; cursor: pointer; font-family: inherit; transition: background .15s; }
.inv-btn-primary:hover { background: #256645; }
.inv-btn-secondary { display: inline-flex; align-items: center; gap: 6px; padding: 9px 16px; background: #fff; color: #374151; border: 1.5px solid #E5E7EB; border-radius: 9px; font-size: 13px; font-weight: 700; cursor: pointer; font-family: inherit; transition: border-color .15s; }
.inv-btn-secondary:hover { border-color: #9CA3AF; }
.inv-btn-ghost { display: inline-flex; align-items: center; gap: 6px; padding: 9px 16px; background: transparent; color: #6B7280; border: 1.5px solid transparent; border-radius: 9px; font-size: 13px; font-weight: 600; cursor: pointer; font-family: inherit; }
.inv-btn-ghost:hover { color: #374151; }
.inv-btn-danger { display: inline-flex; align-items: center; gap: 6px; padding: 9px 16px; background: #FEE2E2; color: #DC2626; border: none; border-radius: 9px; font-size: 13px; font-weight: 700; cursor: pointer; font-family: inherit; }
.inv-btn-danger:hover { background: #FCA5A5; }

/* ── Modal ── */
.inv-overlay { position: fixed; inset: 0; background: rgba(0,0,0,.5); z-index: 9990; display: flex; align-items: flex-start; justify-content: center; padding: 40px 16px; overflow-y: auto; }
.inv-modal { background: #fff; border-radius: 18px; width: 100%; position: relative; box-shadow: 0 24px 80px rgba(0,0,0,.3); }
.inv-detail-modal { max-width: 740px; }
.inv-builder-modal { max-width: 900px; }
.inv-pay-modal { max-width: 440px; }
.inv-modal-header { display: flex; align-items: center; justify-content: space-between; padding: 20px 24px; border-bottom: 1.5px solid #F3F4F6; }
.inv-modal-title { display: flex; align-items: center; gap: 10px; font-size: 16px; font-weight: 800; color: #1C3A2B; }
.inv-modal-close { width: 32px; height: 32px; border: none; background: #F3F4F6; border-radius: 8px; font-size: 18px; cursor: pointer; color: #6B7280; display: flex; align-items: center; justify-content: center; }
.inv-modal-body { padding: 24px; }

/* ── Detail modal ── */
.inv-detail-top { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; flex-wrap: wrap; margin-bottom: 20px; }
.inv-detail-meta { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.inv-detail-num { font-size: 20px; font-weight: 800; color: #1C3A2B; }
.inv-detail-date { font-size: 12px; color: #9CA3AF; }
.inv-detail-actions { display: flex; gap: 8px; flex-wrap: wrap; }
.inv-detail-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-bottom: 20px; padding: 16px; background: #F9FAFB; border-radius: 12px; }
.inv-detail-section-title { display: flex; align-items: center; gap: 6px; font-size: 11px; font-weight: 700; color: #9CA3AF; text-transform: uppercase; letter-spacing: .06em; margin-bottom: 8px; }
.inv-detail-client-name { font-size: 16px; font-weight: 700; color: #111; margin-bottom: 4px; }
.inv-detail-client-sub { display: flex; align-items: center; gap: 5px; font-size: 12px; color: #6B7280; margin-top: 2px; }
.inv-detail-kv { display: flex; justify-content: space-between; font-size: 13px; color: #374151; margin-bottom: 4px; }
.inv-detail-kv span:first-child { color: #9CA3AF; }

/* ── Line items table in detail ── */
.inv-line-items-section { margin-bottom: 16px; }
.inv-li-table { width: 100%; border-collapse: collapse; border: 1.5px solid #E5E7EB; border-radius: 10px; overflow: hidden; }
.inv-li-table thead { background: #F9FAFB; }
.inv-li-table th { padding: 8px 12px; font-size: 11px; font-weight: 700; color: #9CA3AF; text-transform: uppercase; letter-spacing: .06em; text-align: right; }
.inv-li-table th:first-child { text-align: left; }
.inv-li-table td { padding: 10px 12px; font-size: 13px; color: #374151; border-top: 1px solid #F3F4F6; text-align: right; }
.inv-li-table td:first-child { text-align: left; color: #111; }

/* ── Totals ── */
.inv-totals-section, .inv-totals-preview { margin-top: 12px; }
.inv-totals-grid { max-width: 260px; margin-left: auto; }
.inv-total-row { display: flex; justify-content: space-between; align-items: center; padding: 5px 0; font-size: 13px; color: #374151; }
.inv-total-grand { font-size: 16px; font-weight: 800; color: #111; border-top: 2px solid #E5E7EB; padding-top: 8px; margin-top: 4px; }
.inv-paid-row { color: #2D7A55; font-weight: 600; }
.inv-balance-row { font-size: 15px; font-weight: 700; }
.inv-discount { color: #16A34A; }
.inv-totals-preview { background: #F9FAFB; border-radius: 10px; padding: 14px 16px; margin-top: 16px; }

/* ── Builder ── */
.inv-builder-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; }
.inv-builder-col { display: flex; flex-direction: column; gap: 0; }
.inv-field-group { margin-bottom: 14px; }
.inv-label { display: block; font-size: 11px; font-weight: 700; color: #6B7280; text-transform: uppercase; letter-spacing: .06em; margin-bottom: 5px; }
.inv-input { width: 100%; padding: 9px 12px; border: 1.5px solid #E5E7EB; border-radius: 9px; font-size: 13px; font-family: inherit; color: #111; outline: none; transition: border-color .15s; }
.inv-input:focus { border-color: #2D7A55; box-shadow: 0 0 0 3px rgba(45,122,85,.1); }
.inv-select { width: 100%; padding: 9px 12px; border: 1.5px solid #E5E7EB; border-radius: 9px; font-size: 13px; font-family: inherit; color: #111; outline: none; background: #fff; }
.inv-textarea { width: 100%; padding: 9px 12px; border: 1.5px solid #E5E7EB; border-radius: 9px; font-size: 13px; font-family: inherit; color: #111; outline: none; resize: vertical; }
.inv-row2 { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.inv-tax-row { margin-bottom: 14px; }
.inv-add-line-btn { display: flex; align-items: center; gap: 6px; padding: 8px 12px; background: transparent; border: 1.5px dashed #D1D5DB; border-radius: 9px; font-size: 12px; font-weight: 600; color: #2D7A55; cursor: pointer; font-family: inherit; width: 100%; justify-content: center; margin-top: 8px; transition: border-color .15s; }
.inv-add-line-btn:hover { border-color: #2D7A55; background: #F0FAF4; }
.inv-builder-footer { display: flex; align-items: center; justify-content: space-between; padding: 16px 24px; border-top: 1.5px solid #F3F4F6; margin: 16px -24px -24px; }

/* ── Line item builder rows ── */
.inv-li-row { display: grid; grid-template-columns: 1fr 70px 90px 80px 28px; gap: 8px; align-items: center; margin-bottom: 8px; }
.inv-li-desc { font-size: 13px; }
.inv-li-qty, .inv-li-price { font-size: 13px; text-align: right; }
.inv-li-total { font-size: 13px; font-weight: 600; color: #1C3A2B; text-align: right; }
.inv-li-remove { width: 28px; height: 28px; border: 1.5px solid #E5E7EB; background: #fff; border-radius: 7px; cursor: pointer; display: flex; align-items: center; justify-content: center; transition: border-color .15s; padding: 0; }
.inv-li-remove:hover { border-color: #EF4444; }

/* ── Detail notes / portal ── */
.inv-detail-notes { margin-top: 16px; padding: 14px; background: #F9FAFB; border-radius: 10px; font-size: 13px; color: #374151; line-height: 1.6; }
.inv-portal-link-section { margin-top: 20px; padding-top: 16px; border-top: 1.5px solid #F3F4F6; }
.inv-portal-link-row { display: flex; gap: 8px; margin-top: 8px; }
.inv-portal-link-input { flex: 1; padding: 9px 12px; border: 1.5px solid #E5E7EB; border-radius: 9px; font-size: 12px; color: #6B7280; background: #F9FAFB; outline: none; }

/* ── Pay modal ── */
.inv-pay-summary { background: #F9FAFB; border-radius: 10px; padding: 14px; margin-bottom: 4px; }
.inv-pay-row { display: flex; justify-content: space-between; font-size: 13px; color: #374151; margin-bottom: 4px; }
.inv-pay-balance { font-size: 15px; font-weight: 700; color: #111; margin-top: 6px; padding-top: 8px; border-top: 1px solid #E5E7EB; }

@media(max-width:640px) {
  .inv-builder-grid { grid-template-columns: 1fr; }
  .inv-summary-row { grid-template-columns: 1fr 1fr; }
  .inv-detail-grid { grid-template-columns: 1fr; }
  .inv-li-row { grid-template-columns: 1fr 55px 75px 65px 28px; }
  .inv-table-wrap { overflow-x: auto; }
}
`;
  document.head.appendChild(style);
})();

console.log('[Groundwork] invoices.js loaded v20260711p47');
