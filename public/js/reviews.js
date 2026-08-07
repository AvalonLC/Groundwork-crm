/**
 * Groundwork CRM — Reviews Engine
 * reviews.js v20260711p48
 *
 * Features:
 *  - Post-WO trigger: gwTriggerReviewRequest(workOrderId, clientName, clientEmail)
 *  - Review request list with status tracking
 *  - Settings panel (Google URL, auto-send toggle, delay, message template)
 *  - Dashboard widget: recent reviews + star rating summary
 *  - Manual send modal with preview
 */

(function () {
  'use strict';

  // ── State ──────────────────────────────────────────────────────────────────
  let _rvState = {
    tab: 'requests',      // 'requests' | 'settings'
    requests: [],
    settings: null,
    loading: false,
    overlay: null,
  };

  // ── Entry point ────────────────────────────────────────────────────────────
  window.gwReviews = function () {
    _rvInjectCSS();
    const main = document.getElementById('main-content');
    if (!main) return;
    main.innerHTML = _rvShell();
    _rvBindTabNav();
    _rvLoadTab('requests');
  };

  // ── Shell ──────────────────────────────────────────────────────────────────
  function _rvShell() {
    return `
<div class="rv-root">
  <div class="rv-header">
    <div>
      <h2 class="rv-title">${gwIcon('star','22','#F59E0B')} Reviews Engine</h2>
      <p class="rv-subtitle">Track review requests and manage your online reputation</p>
    </div>
    <button class="gw-btn gw-btn-primary" onclick="_rvOpenManualRequest()">
      ${gwIcon('plus','16','#fff')} Send Review Request
    </button>
  </div>

  <!-- summary cards -->
  <div class="rv-cards" id="rv-cards">
    <div class="rv-card rv-card-skeleton"></div>
    <div class="rv-card rv-card-skeleton"></div>
    <div class="rv-card rv-card-skeleton"></div>
    <div class="rv-card rv-card-skeleton"></div>
  </div>

  <!-- tab nav -->
  <div class="rv-tabs">
    <button class="rv-tab rv-tab-active" data-tab="requests">Requests</button>
    <button class="rv-tab" data-tab="settings">Settings</button>
  </div>

  <!-- tab content -->
  <div id="rv-tab-content"></div>
</div>`;
  }

  // ── Tab nav ────────────────────────────────────────────────────────────────
  function _rvBindTabNav() {
    document.querySelectorAll('.rv-tab').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.rv-tab').forEach(b => b.classList.remove('rv-tab-active'));
        btn.classList.add('rv-tab-active');
        _rvLoadTab(btn.dataset.tab);
      });
    });
  }

  window._rvLoadTab = function (tab) {
    _rvState.tab = tab;
    if (tab === 'requests') _rvLoadRequests();
    else if (tab === 'settings') _rvLoadSettings();
  };

  // ── Summary cards ──────────────────────────────────────────────────────────
  async function _rvRenderCards(requests) {
    const total  = requests.length;
    const sent   = requests.filter(r => ['sent','delivered','clicked','reviewed'].includes(r.status)).length;
    const clicked = requests.filter(r => ['clicked','reviewed'].includes(r.status)).length;
    const reviewed = requests.filter(r => r.status === 'reviewed').length;
    const convRate = sent > 0 ? Math.round((reviewed / sent) * 100) : 0;

    const el = document.getElementById('rv-cards');
    if (!el) return;
    el.innerHTML = `
      ${_rvCard('Total Requests', total, 'send', '#6366F1')}
      ${_rvCard('Sent', sent, 'check-circle', '#2D7A55')}
      ${_rvCard('Link Clicked', clicked, 'external-link', '#F59E0B')}
      ${_rvCard('Conversion Rate', convRate + '%', 'trending-up', '#0EA5E9')}
    `;
  }

  function _rvCard(label, val, icon, color) {
    return `
<div class="rv-card">
  <div class="rv-card-icon" style="background:${color}18">${gwIcon(icon,'20',color)}</div>
  <div>
    <div class="rv-card-val">${val}</div>
    <div class="rv-card-label">${label}</div>
  </div>
</div>`;
  }

  // ── Requests tab ───────────────────────────────────────────────────────────
  async function _rvLoadRequests() {
    const content = document.getElementById('rv-tab-content');
    if (!content) return;
    content.innerHTML = `<div class="rv-loading">${gwIcon('loader','20','#2D7A55')} Loading requests…</div>`;

    try {
      const res = await fetch('/api/reviews', { credentials: 'include' });
      if (!res.ok) throw new Error('Failed');
      const data = await res.json();
      _rvState.requests = data.reviews || [];
      _rvRenderCards(_rvState.requests);
      _rvRenderRequestsTable(_rvState.requests, content);
    } catch (e) {
      content.innerHTML = `<div class="rv-empty">Failed to load requests. <button class="rv-link" onclick="_rvLoadTab('requests')">Retry</button></div>`;
    }
  }

  function _rvRenderRequestsTable(requests, container) {
    if (!requests.length) {
      container.innerHTML = `
<div class="rv-empty-state">
  ${gwIcon('star','48','#D1D5DB')}
  <h3>No review requests yet</h3>
  <p>After completing a job, send a review request to your client.<br>You can also trigger them automatically when a work order is marked complete.</p>
  <button class="gw-btn gw-btn-primary" onclick="_rvOpenManualRequest()">
    ${gwIcon('plus','16','#fff')} Send First Request
  </button>
</div>`;
      return;
    }

    // group: pending, sent, completed
    const pending  = requests.filter(r => r.status === 'pending');
    const active   = requests.filter(r => ['sent','delivered','clicked'].includes(r.status));
    const done     = requests.filter(r => ['reviewed','opted_out'].includes(r.status));

    container.innerHTML = `
<div class="rv-section">
  ${pending.length ? `<h4 class="rv-section-title">Pending (${pending.length})</h4>${_rvRowsHtml(pending)}` : ''}
  ${active.length  ? `<h4 class="rv-section-title">Active (${active.length})</h4>${_rvRowsHtml(active)}` : ''}
  ${done.length    ? `<h4 class="rv-section-title">Completed (${done.length})</h4>${_rvRowsHtml(done)}` : ''}
</div>`;
  }

  function _rvRowsHtml(rows) {
    return `
<div class="rv-table-wrap">
  <table class="rv-table">
    <thead>
      <tr>
        <th>Client</th>
        <th>Work Order</th>
        <th>Status</th>
        <th>Sent</th>
        <th>Actions</th>
      </tr>
    </thead>
    <tbody>
      ${rows.map(_rvRow).join('')}
    </tbody>
  </table>
</div>`;
  }

  function _rvRow(r) {
    const statusMap = {
      pending:   { label:'Pending',   color:'#9CA3AF', bg:'#F3F4F6' },
      sent:      { label:'Sent',      color:'#2D7A55', bg:'#F0FAF4' },
      delivered: { label:'Delivered', color:'#0EA5E9', bg:'#E0F2FE' },
      clicked:   { label:'Clicked',   color:'#F59E0B', bg:'#FFFBEB' },
      reviewed:  { label:'Reviewed',  color:'#7C3AED', bg:'#EDE9FE' },
      opted_out: { label:'Opted Out', color:'#6B7280', bg:'#F9FAFB' },
    };
    const s = statusMap[r.status] || statusMap.pending;
    const sentAt = r.sent_at ? new Date(r.sent_at).toLocaleDateString() : '—';

    const canResend = ['pending','sent'].includes(r.status);
    const actions = canResend
      ? `<button class="rv-action-btn" onclick="_rvSendRequest('${r.id}','${_esc(r.client_name)}')" title="Send now">${gwIcon('send','14','#2D7A55')}</button>`
      : '';

    return `
<tr class="rv-row">
  <td>
    <div class="rv-client-name">${_esc(r.client_name)}</div>
    <div class="rv-client-email">${_esc(r.client_email || '')}</div>
  </td>
  <td>${r.work_order_id ? `#${r.work_order_id}` : '—'}</td>
  <td><span class="rv-badge" style="color:${s.color};background:${s.bg}">${s.label}</span></td>
  <td>${sentAt}</td>
  <td class="rv-actions">${actions}</td>
</tr>`;
  }

  // ── Settings tab ───────────────────────────────────────────────────────────
  async function _rvLoadSettings() {
    const content = document.getElementById('rv-tab-content');
    if (!content) return;
    content.innerHTML = `<div class="rv-loading">${gwIcon('loader','20','#2D7A55')} Loading settings…</div>`;

    try {
      const res = await fetch('/api/reviews/settings', { credentials: 'include' });
      if (!res.ok) throw new Error('Failed');
      const data = await res.json();
      _rvState.settings = data.settings || {};
      _rvRenderSettings(content);
    } catch (e) {
      content.innerHTML = `<div class="rv-empty">Failed to load settings.</div>`;
    }
  }

  function _rvRenderSettings(container) {
    const s = _rvState.settings || {};
    const tmpl = s.message_template || _rvDefaultTemplate();

    container.innerHTML = `
<div class="rv-settings-grid">
  <!-- Google link -->
  <div class="rv-settings-card">
    <h4 class="rv-settings-card-title">${gwIcon('external-link','16','#4B5563')} Google Review Link</h4>
    <p class="rv-settings-desc">Paste your Google Maps review URL. Clients will be redirected here after receiving the request.</p>
    <label class="rv-label">Google Review URL</label>
    <input id="rv-google-url" class="rv-input" type="url" placeholder="https://g.page/r/…/review"
      value="${_esc(s.google_review_url || '')}">
    <div style="margin-top:8px;display:flex;gap:8px;align-items:center">
      ${s.google_review_url ? `<a href="${_esc(s.google_review_url)}" target="_blank" class="rv-link">${gwIcon('external-link','12','#2D7A55')} Test link</a>` : ''}
    </div>
  </div>

  <!-- Auto-send -->
  <div class="rv-settings-card">
    <h4 class="rv-settings-card-title">${gwIcon('zap','16','#4B5563')} Auto-Send Settings</h4>
    <p class="rv-settings-desc">Automatically send review requests when a work order is marked complete.</p>

    <label class="rv-toggle-row">
      <div>
        <div class="rv-toggle-label">Auto-send on WO complete</div>
        <div class="rv-toggle-sub">Triggers when work order status → completed</div>
      </div>
      <div class="rv-toggle-switch ${s.auto_send_enabled ? 'rv-toggle-on' : ''}"
           id="rv-toggle-auto" onclick="_rvToggleAutoSend(this)">
        <div class="rv-toggle-knob"></div>
      </div>
    </label>

    <label class="rv-label" style="margin-top:16px">Send delay after WO completion</label>
    <select id="rv-send-delay" class="rv-select">
      <option value="0"    ${s.send_delay_hours==0    ?'selected':''}>Immediately</option>
      <option value="1"    ${s.send_delay_hours==1    ?'selected':''}>1 hour later</option>
      <option value="4"    ${s.send_delay_hours==4    ?'selected':''}>4 hours later</option>
      <option value="24"   ${s.send_delay_hours==24   ?'selected':''}>1 day later</option>
      <option value="48"   ${s.send_delay_hours==48   ?'selected':''}>2 days later</option>
    </select>

    <label class="rv-label" style="margin-top:16px">Minimum rating to request review</label>
    <select id="rv-min-rating" class="rv-select">
      <option value="0" ${s.min_rating_threshold==0?'selected':''}>Always ask (any rating)</option>
      <option value="4" ${s.min_rating_threshold==4?'selected':''}>Only 4+ star jobs</option>
      <option value="5" ${s.min_rating_threshold==5?'selected':''}>Only 5-star jobs</option>
    </select>
  </div>

  <!-- Message template -->
  <div class="rv-settings-card rv-settings-card-wide">
    <h4 class="rv-settings-card-title">${gwIcon('edit','16','#4B5563')} Message Template</h4>
    <p class="rv-settings-desc">
      Use <code>{{client_name}}</code>, <code>{{company_name}}</code>, <code>{{review_link}}</code> as placeholders.
    </p>
    <label class="rv-label">SMS / Email message</label>
    <textarea id="rv-msg-template" class="rv-textarea" rows="6" placeholder="Hi {{client_name}}, thank you for choosing {{company_name}}!…">${_esc(tmpl)}</textarea>
    <div class="rv-template-actions">
      <button class="gw-btn gw-btn-ghost" onclick="_rvPreviewTemplate()">
        ${gwIcon('eye','14','#374151')} Preview
      </button>
      <button class="gw-btn gw-btn-ghost" onclick="_rvResetTemplate()">Reset to default</button>
    </div>
  </div>

  <!-- Save -->
  <div class="rv-settings-footer">
    <button class="gw-btn gw-btn-primary" onclick="_rvSaveSettings()">
      ${gwIcon('save','16','#fff')} Save Settings
    </button>
  </div>
</div>`;
  }

  function _rvDefaultTemplate() {
    return `Hi {{client_name}}, thank you for choosing {{company_name}}! We hope you're happy with the work. If you have a moment, we'd really appreciate a quick review — it helps us grow and helps other homeowners find us.\n\n{{review_link}}\n\nThank you!`;
  }

  window._rvToggleAutoSend = function (el) {
    el.classList.toggle('rv-toggle-on');
  };

  window._rvPreviewTemplate = function () {
    const tmpl = document.getElementById('rv-msg-template')?.value || '';
    const preview = tmpl
      .replace(/\{\{client_name\}\}/g, 'John Smith')
      .replace(/\{\{company_name\}\}/g, 'Groundwork Services')
      .replace(/\{\{review_link\}\}/g, 'https://g.page/r/example/review');
    _rvModal('Template Preview', `<pre class="rv-preview-msg">${_esc(preview)}</pre>`,
      `<button class="gw-btn gw-btn-ghost" onclick="_rvCloseOverlay()">Close</button>`);
  };

  window._rvResetTemplate = function () {
    const ta = document.getElementById('rv-msg-template');
    if (ta) ta.value = _rvDefaultTemplate();
  };

  window._rvSaveSettings = async function () {
    const btn = document.querySelector('.rv-settings-footer .gw-btn-primary');
    const origText = btn?.innerHTML;
    if (btn) btn.innerHTML = `${gwIcon('loader','14','#fff')} Saving…`;

    const payload = {
      google_review_url:    document.getElementById('rv-google-url')?.value.trim() || '',
      auto_send_enabled:    document.getElementById('rv-toggle-auto')?.classList.contains('rv-toggle-on') ? 1 : 0,
      send_delay_hours:     parseInt(document.getElementById('rv-send-delay')?.value || '0'),
      min_rating_threshold: parseInt(document.getElementById('rv-min-rating')?.value || '0'),
      message_template:     document.getElementById('rv-msg-template')?.value || '',
    };

    try {
      const res = await fetch('/api/reviews/settings', {
        method: 'PUT', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error('Save failed');
      _rvState.settings = { ..._rvState.settings, ...payload };
      if (btn) btn.innerHTML = `${gwIcon('check','14','#fff')} Saved!`;
      setTimeout(() => { if (btn) btn.innerHTML = origText; }, 2000);
    } catch (e) {
      if (btn) btn.innerHTML = origText;
      alert('Failed to save settings.');
    }
  };

  // ── Manual request modal ───────────────────────────────────────────────────
  window._rvOpenManualRequest = async function (prefillClientId, prefillWoId) {
    // Load clients for select
    let clients = [];
    try {
      const res = await fetch('/api/clients?limit=500', { credentials: 'include' });
      const d = await res.json();
      clients = d.clients || [];
    } catch (_) {}

    const clientOpts = clients.map(c =>
      `<option value="${c.id}" data-email="${_esc(c.email||'')}"
        ${prefillClientId && c.id==prefillClientId ? 'selected' : ''}
       >${_esc(c.name)}</option>`
    ).join('');

    const body = `
<div class="rv-form">
  <label class="rv-label">Client *</label>
  <select id="rv-req-client" class="rv-select" onchange="_rvOnClientSelect(this)">
    <option value="">— Select client —</option>
    ${clientOpts}
  </select>

  <label class="rv-label" style="margin-top:12px">Email address *</label>
  <input id="rv-req-email" class="rv-input" type="email" placeholder="client@email.com">

  <label class="rv-label" style="margin-top:12px">Work Order # (optional)</label>
  <input id="rv-req-wo" class="rv-input" type="number" placeholder="e.g. 142"
    value="${prefillWoId || ''}">

  <label class="rv-label" style="margin-top:12px">Custom message (optional)</label>
  <textarea id="rv-req-msg" class="rv-textarea" rows="4"
    placeholder="Leave blank to use your template from Settings…"></textarea>

  <div id="rv-req-err" class="rv-err-msg" style="display:none"></div>
</div>`;

    const footer = `
<button class="gw-btn gw-btn-ghost" onclick="_rvCloseOverlay()">Cancel</button>
<button class="gw-btn gw-btn-primary" onclick="_rvSubmitManualRequest()">
  ${gwIcon('send','14','#fff')} Send Request
</button>`;

    _rvModal('Send Review Request', body, footer);

    // Pre-fill email if client was prefilled
    if (prefillClientId) {
      const sel = document.getElementById('rv-req-client');
      if (sel) _rvOnClientSelect(sel);
    }
  };

  window._rvOnClientSelect = function (sel) {
    const opt = sel.options[sel.selectedIndex];
    const email = opt?.dataset?.email || '';
    const emailInput = document.getElementById('rv-req-email');
    if (emailInput && email) emailInput.value = email;
  };

  window._rvSubmitManualRequest = async function () {
    const clientId = document.getElementById('rv-req-client')?.value;
    const email    = document.getElementById('rv-req-email')?.value.trim();
    const woId     = document.getElementById('rv-req-wo')?.value || null;
    const msg      = document.getElementById('rv-req-msg')?.value.trim() || null;
    const errEl    = document.getElementById('rv-req-err');

    if (!clientId || !email) {
      if (errEl) { errEl.textContent = 'Client and email are required.'; errEl.style.display='block'; }
      return;
    }
    if (errEl) errEl.style.display = 'none';

    const btn = document.querySelector('.rv-overlay-footer .gw-btn-primary');
    const orig = btn?.innerHTML;
    if (btn) btn.innerHTML = `${gwIcon('loader','14','#fff')} Sending…`;

    try {
      const res = await fetch('/api/reviews', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ client_id: clientId, client_email: email, work_order_id: woId, custom_message: msg }),
      });
      if (!res.ok) throw new Error('Failed');
      _rvCloseOverlay();
      _rvLoadTab('requests');
    } catch (e) {
      if (btn) btn.innerHTML = orig;
      if (errEl) { errEl.textContent = 'Failed to send request. Try again.'; errEl.style.display='block'; }
    }
  };

  // ── Send existing request ──────────────────────────────────────────────────
  window._rvSendRequest = async function (requestId, clientName) {
    if (!confirm(`Send review request to ${clientName}?`)) return;
    try {
      const res = await fetch(`/api/reviews/${requestId}/send`, {
        method: 'POST', credentials: 'include',
      });
      if (!res.ok) throw new Error('Failed');
      _rvLoadTab('requests');
    } catch (e) {
      alert('Failed to send. Please try again.');
    }
  };

  // ── Post-WO trigger (called from work orders module) ─────────────────────
  /**
   * gwTriggerReviewRequest(workOrderId, clientName, clientEmail)
   * Called automatically when a WO is marked complete.
   * Checks settings.auto_send_enabled before creating request.
   */
  window.gwTriggerReviewRequest = async function (workOrderId, clientName, clientEmail) {
    try {
      // Fetch settings to check auto_send
      const sRes = await fetch('/api/reviews/settings', { credentials: 'include' });
      if (!sRes.ok) return;
      const sData = await sRes.json();
      const settings = sData.settings || {};

      if (!settings.auto_send_enabled) return; // auto-send disabled

      // Create review request (auto-sent server-side)
      await fetch('/api/reviews', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          work_order_id: workOrderId,
          client_email: clientEmail,
          client_name_hint: clientName,
          auto_triggered: true,
        }),
      });
    } catch (e) {
      console.warn('[Reviews] Auto-trigger failed:', e.message);
    }
  };

  // ── Dashboard widget ───────────────────────────────────────────────────────
  /**
   * gwReviewsWidget(containerId)
   * Renders a compact review summary card into the given container.
   * Called by dashboard.js or app_premium.js on the Dashboard view.
   */
  window.gwReviewsWidget = async function (containerId) {
    _rvInjectCSS();                                              /* inject widget styles — must run before rendering */
    const el = document.getElementById(containerId);
    if (!el) return;
    el.innerHTML = `<div class="rv-widget-loading">${gwIcon('loader','16','#2D7A55')} Loading…</div>`;

    try {
      const [reqRes, settRes] = await Promise.all([
        fetch('/api/reviews?limit=5', { credentials: 'include' }),
        fetch('/api/reviews/settings', { credentials: 'include' }),
      ]);
      const reqData  = reqRes.ok  ? await reqRes.json()  : {};
      const settData = settRes.ok ? await settRes.json() : {};

      const reviews  = reqData.reviews  || [];
      const settings = settData.settings || {};
      const total    = reqData.total || reviews.length;
      const reviewed = reviews.filter(r => r.status === 'reviewed').length;
      const convRate = total > 0 ? Math.round((reviewed / total) * 100) : 0;

      el.innerHTML = `
<div class="rv-widget">
  <div class="rv-widget-header">
    ${gwIcon('star','18','#F59E0B')}
    <span class="rv-widget-title">Reviews</span>
    <button class="rv-widget-link" onclick="show('gwReviews')">View all</button>
  </div>
  <div class="rv-widget-stats">
    <div class="rv-widget-stat">
      <div class="rv-widget-stat-val">${total}</div>
      <div class="rv-widget-stat-lbl">Requests</div>
    </div>
    <div class="rv-widget-stat">
      <div class="rv-widget-stat-val">${reviewed}</div>
      <div class="rv-widget-stat-lbl">Reviewed</div>
    </div>
    <div class="rv-widget-stat">
      <div class="rv-widget-stat-val">${convRate}%</div>
      <div class="rv-widget-stat-lbl">Conversion</div>
    </div>
  </div>
  ${settings.google_review_url
    ? `<a href="${_esc(settings.google_review_url)}" target="_blank" class="rv-widget-google-btn">
        ${gwIcon('external-link','13','#2D7A55')} View Google Reviews
       </a>`
    : `<button class="rv-widget-setup-btn" onclick="show('gwReviews')">
        ${gwIcon('settings','13','#6B7280')} Set up Google link
       </button>`
  }
  ${reviews.length ? `
  <div class="rv-widget-recent">
    <div class="rv-widget-recent-title">Recent</div>
    ${reviews.slice(0,3).map(r => `
      <div class="rv-widget-row">
        <span>${_esc(r.client_name)}</span>
        <span class="rv-badge rv-badge-sm" style="color:${_rvStatusColor(r.status)}">${r.status}</span>
      </div>`).join('')}
  </div>` : ''}
</div>`;
    } catch (e) {
      el.innerHTML = `<div class="rv-widget-loading" style="color:#9CA3AF">Reviews unavailable</div>`;
    }
  };

  function _rvStatusColor(status) {
    const colors = { pending:'#9CA3AF', sent:'#2D7A55', delivered:'#0EA5E9', clicked:'#F59E0B', reviewed:'#7C3AED', opted_out:'#6B7280' };
    return colors[status] || '#9CA3AF';
  }

  // ── Modal helper ───────────────────────────────────────────────────────────
  function _rvModal(title, bodyHtml, footerHtml) {
    _rvCloseOverlay();
    const overlay = document.createElement('div');
    overlay.className = 'rv-overlay';
    overlay.innerHTML = `
<div class="rv-modal">
  <div class="rv-modal-header">
    <h3 class="rv-modal-title">${title}</h3>
    <button class="rv-modal-close" onclick="_rvCloseOverlay()">${gwIcon('x','18','#6B7280')}</button>
  </div>
  <div class="rv-modal-body">${bodyHtml}</div>
  <div class="rv-overlay-footer rv-modal-footer">${footerHtml}</div>
</div>`;
    overlay.addEventListener('click', e => { if (e.target === overlay) _rvCloseOverlay(); });
    document.body.appendChild(overlay);
    _rvState.overlay = overlay;
    requestAnimationFrame(() => overlay.classList.add('rv-overlay-visible'));
  }

  window._rvCloseOverlay = function () {
    if (_rvState.overlay) {
      _rvState.overlay.remove();
      _rvState.overlay = null;
    }
  };

  // ── Utilities ──────────────────────────────────────────────────────────────
  function _esc(s) {
    if (!s) return '';
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  // ── CSS ────────────────────────────────────────────────────────────────────
  function _rvInjectCSS() {
    if (document.getElementById('rv-styles')) return;
    const style = document.createElement('style');
    style.id = 'rv-styles';
    style.textContent = `
/* Root */
.rv-root { padding:24px; max-width:1100px; margin:0 auto; }
.rv-header { display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:24px;flex-wrap:wrap;gap:12px; }
.rv-title { font-size:22px;font-weight:700;color:#111827;display:flex;align-items:center;gap:8px;margin:0 0 4px; }
.rv-subtitle { color:#6B7280;font-size:14px;margin:0; }

/* Cards */
.rv-cards { display:grid;grid-template-columns:repeat(4,1fr);gap:16px;margin-bottom:24px; }
.rv-card { background:#fff;border:1px solid #E5E7EB;border-radius:12px;padding:16px;display:flex;align-items:center;gap:14px; }
.rv-card-skeleton { background:#F3F4F6;animation:rv-pulse 1.5s infinite; }
@keyframes rv-pulse { 0%,100%{opacity:1}50%{opacity:.5} }
.rv-card-icon { width:40px;height:40px;border-radius:10px;display:flex;align-items:center;justify-content:center;flex-shrink:0; }
.rv-card-val { font-size:22px;font-weight:700;color:#111827; }
.rv-card-label { font-size:12px;color:#6B7280;margin-top:2px; }

/* Tabs */
.rv-tabs { display:flex;border-bottom:2px solid #E5E7EB;margin-bottom:20px;gap:4px; }
.rv-tab { padding:10px 20px;border:none;background:none;cursor:pointer;font-size:14px;font-weight:500;color:#6B7280;border-bottom:2px solid transparent;margin-bottom:-2px;transition:.15s; }
.rv-tab:hover { color:#374151; }
.rv-tab-active { color:#2D7A55;border-bottom-color:#2D7A55; }

/* Loading / empty */
.rv-loading { display:flex;align-items:center;gap:8px;color:#6B7280;padding:40px 0;justify-content:center; }
.rv-empty { text-align:center;color:#9CA3AF;padding:40px 0;font-size:14px; }
.rv-empty-state { text-align:center;padding:60px 20px;color:#6B7280; }
.rv-empty-state h3 { font-size:18px;font-weight:600;margin:16px 0 8px;color:#374151; }
.rv-empty-state p { font-size:14px;line-height:1.6;margin-bottom:20px; }
.rv-link { color:#2D7A55;font-size:13px;text-decoration:none;cursor:pointer;background:none;border:none; }
.rv-link:hover { text-decoration:underline; }

/* Section */
.rv-section { display:flex;flex-direction:column;gap:20px; }
.rv-section-title { font-size:13px;font-weight:600;color:#6B7280;text-transform:uppercase;letter-spacing:.05em;margin:0 0 8px; }

/* Table */
.rv-table-wrap { overflow-x:auto;border:1px solid #E5E7EB;border-radius:10px;background:#fff; }
.rv-table { width:100%;border-collapse:collapse; }
.rv-table th { padding:10px 14px;text-align:left;font-size:12px;font-weight:600;color:#6B7280;border-bottom:1px solid #E5E7EB;background:#F9FAFB; }
.rv-table td { padding:12px 14px;font-size:14px;color:#374151;border-bottom:1px solid #F3F4F6; }
.rv-table tr:last-child td { border-bottom:none; }
.rv-row:hover { background:#FAFAFA; }
.rv-client-name { font-weight:500;color:#111827; }
.rv-client-email { font-size:12px;color:#9CA3AF;margin-top:2px; }
.rv-badge { display:inline-flex;padding:2px 10px;border-radius:99px;font-size:11px;font-weight:600; }
.rv-badge-sm { padding:2px 8px;font-size:10px; }
.rv-actions { display:flex;gap:6px; }
.rv-action-btn { background:#F0FAF4;border:1px solid #BBF7D0;border-radius:6px;padding:5px 8px;cursor:pointer;transition:.15s; }
.rv-action-btn:hover { background:#D1FAE5; }

/* Settings */
.rv-settings-grid { display:grid;grid-template-columns:repeat(2,1fr);gap:20px; }
.rv-settings-card { background:#fff;border:1px solid #E5E7EB;border-radius:12px;padding:20px; }
.rv-settings-card-wide { grid-column:1/-1; }
.rv-settings-card-title { font-size:15px;font-weight:600;color:#111827;margin:0 0 6px;display:flex;align-items:center;gap:6px; }
.rv-settings-desc { font-size:13px;color:#6B7280;margin:0 0 16px; }
.rv-settings-footer { grid-column:1/-1;display:flex;justify-content:flex-end; }

.rv-label { display:block;font-size:13px;font-weight:500;color:#374151;margin-bottom:4px; }
.rv-input,.rv-select,.rv-textarea { width:100%;padding:9px 12px;border:1px solid #D1D5DB;border-radius:8px;font-size:14px;color:#111827;background:#fff;box-sizing:border-box;transition:.15s; }
.rv-input:focus,.rv-select:focus,.rv-textarea:focus { outline:none;border-color:#2D7A55;box-shadow:0 0 0 3px #D1FAE5; }
.rv-textarea { resize:vertical;min-height:80px;font-family:inherit; }

/* Toggle */
.rv-toggle-row { display:flex;justify-content:space-between;align-items:center;cursor:pointer;gap:12px; }
.rv-toggle-label { font-size:14px;font-weight:500;color:#111827; }
.rv-toggle-sub { font-size:12px;color:#6B7280;margin-top:2px; }
.rv-toggle-switch { width:44px;height:24px;background:#D1D5DB;border-radius:12px;position:relative;transition:.2s;flex-shrink:0;cursor:pointer; }
.rv-toggle-switch.rv-toggle-on { background:#2D7A55; }
.rv-toggle-knob { position:absolute;top:3px;left:3px;width:18px;height:18px;background:#fff;border-radius:50%;transition:.2s;box-shadow:0 1px 3px rgba(0,0,0,.2); }
.rv-toggle-on .rv-toggle-knob { left:23px; }

.rv-template-actions { display:flex;gap:8px;margin-top:10px; }
.rv-preview-msg { white-space:pre-wrap;font-family:inherit;font-size:14px;line-height:1.6;background:#F9FAFB;border:1px solid #E5E7EB;border-radius:8px;padding:16px;margin:0;color:#374151; }

/* Form */
.rv-form { display:flex;flex-direction:column;gap:4px; }
.rv-err-msg { color:#DC2626;font-size:13px;padding:8px 12px;background:#FEF2F2;border-radius:6px;margin-top:8px; }

/* Overlay / Modal */
.rv-overlay { position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:9990;display:flex;align-items:center;justify-content:center;opacity:0;transition:.2s; }
.rv-overlay-visible { opacity:1; }
.rv-modal { background:#fff;border-radius:16px;width:560px;max-width:95vw;max-height:90vh;display:flex;flex-direction:column;box-shadow:0 20px 60px rgba(0,0,0,.2); }
.rv-modal-header { display:flex;justify-content:space-between;align-items:center;padding:20px 24px 16px;border-bottom:1px solid #E5E7EB; }
.rv-modal-title { font-size:18px;font-weight:700;color:#111827;margin:0; }
.rv-modal-close { background:none;border:none;cursor:pointer;padding:4px;border-radius:6px;color:#6B7280;line-height:1; }
.rv-modal-close:hover { background:#F3F4F6; }
.rv-modal-body { padding:20px 24px;overflow-y:auto;flex:1; }
.rv-modal-footer { padding:16px 24px;border-top:1px solid #E5E7EB;display:flex;justify-content:flex-end;gap:10px; }

/* Dashboard widget */
.rv-widget { background:#fff;border:1px solid #E5E7EB;border-radius:12px;padding:16px; }
.rv-widget-header { display:flex;align-items:center;gap:8px;margin-bottom:12px; }
.rv-widget-title { font-size:15px;font-weight:600;color:#111827;flex:1; }
.rv-widget-link { background:none;border:none;color:#2D7A55;font-size:12px;cursor:pointer;font-weight:500; }
.rv-widget-link:hover { text-decoration:underline; }
.rv-widget-stats { display:flex;gap:0;border:1px solid #E5E7EB;border-radius:8px;overflow:hidden;margin-bottom:12px; }
.rv-widget-stat { flex:1;text-align:center;padding:10px 8px;border-right:1px solid #E5E7EB; }
.rv-widget-stat:last-child { border-right:none; }
.rv-widget-stat-val { font-size:20px;font-weight:700;color:#111827; }
.rv-widget-stat-lbl { font-size:11px;color:#6B7280;margin-top:2px; }
.rv-widget-google-btn { display:flex;align-items:center;justify-content:center;gap:6px;text-decoration:none;color:#2D7A55;font-size:13px;font-weight:500;border:1px solid #BBF7D0;border-radius:8px;padding:8px;background:#F0FAF4;width:100%;box-sizing:border-box; }
.rv-widget-setup-btn { display:flex;align-items:center;justify-content:center;gap:6px;color:#6B7280;font-size:13px;font-weight:500;border:1px solid #E5E7EB;border-radius:8px;padding:8px;background:#F9FAFB;width:100%;cursor:pointer; }
.rv-widget-recent { margin-top:12px; }
.rv-widget-recent-title { font-size:11px;font-weight:600;color:#9CA3AF;text-transform:uppercase;letter-spacing:.05em;margin-bottom:6px; }
.rv-widget-row { display:flex;justify-content:space-between;align-items:center;padding:5px 0;border-bottom:1px solid #F3F4F6;font-size:13px; }
.rv-widget-row:last-child { border-bottom:none; }
.rv-widget-loading { display:flex;align-items:center;gap:8px;padding:20px;color:#9CA3AF;font-size:13px;justify-content:center; }

/* Responsive */
@media(max-width:768px) {
  .rv-cards { grid-template-columns:repeat(2,1fr); }
  .rv-settings-grid { grid-template-columns:1fr; }
  .rv-settings-card-wide { grid-column:auto; }
  .rv-root { padding:16px; }
}
@media(max-width:480px) {
  .rv-cards { grid-template-columns:1fr 1fr; }
}
`;
    document.head.appendChild(style);
  }

  console.log('[Groundwork] reviews.js loaded v20260711p48');
})();
