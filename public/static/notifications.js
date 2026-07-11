/**
 * Groundwork CRM — Notification Center
 * notifications.js v20260711p50
 *
 * Features:
 *  - gwNotifBell() — renders the bell icon + unread badge in the topbar
 *  - gwNotifPanel() — slide-in notification panel
 *  - gwNotifCreate(opts) — programmatic notification creator (called by other modules)
 *  - Auto-polls every 60s while app is open
 *  - Click-to-navigate: each notification has an action_url (hash route)
 *  - Mark all read, mark single read on click
 */

(function () {
  'use strict';

  let _nfState = {
    notifications: [],
    unread: 0,
    panelOpen: false,
    pollTimer: null,
    initialized: false,
  };

  // ── Init: mount bell + start polling ──────────────────────────────────────
  window.gwNotifInit = function () {
    if (_nfState.initialized) return;
    _nfState.initialized = true;
    _nfInjectCSS();
    _nfMountBell();
    _nfPoll();
    // Poll every 60s
    _nfState.pollTimer = setInterval(_nfPoll, 60000);
  };

  // ── Mount bell into topbar ─────────────────────────────────────────────────
  function _nfMountBell() {
    // Look for the install button area in topbar to insert before it
    const installBtn = document.getElementById('installBtn');
    if (!installBtn) return;
    const bell = document.createElement('div');
    bell.id = 'gw-notif-bell-wrap';
    bell.innerHTML = `
<button class="gw-notif-bell" id="gwNotifBellBtn" onclick="gwNotifTogglePanel()" aria-label="Notifications" title="Notifications">
  ${gwIcon('bell','18','currentColor')}
  <span class="gw-notif-badge" id="gwNotifBadge" style="display:none">0</span>
</button>`;
    installBtn.parentNode.insertBefore(bell, installBtn);
  }

  // ── Poll notifications ─────────────────────────────────────────────────────
  async function _nfPoll() {
    try {
      const res = await fetch('/api/notifications?limit=30', { credentials: 'include' });
      if (!res.ok) return;
      const data = await res.json();
      _nfState.notifications = data.notifications || [];
      _nfState.unread = data.unread || 0;
      _nfUpdateBadge();
      if (_nfState.panelOpen) _nfRenderPanel();
    } catch (_) {}
  }

  function _nfUpdateBadge() {
    const badge = document.getElementById('gwNotifBadge');
    if (!badge) return;
    if (_nfState.unread > 0) {
      badge.textContent = _nfState.unread > 99 ? '99+' : String(_nfState.unread);
      badge.style.display = 'flex';
    } else {
      badge.style.display = 'none';
    }
  }

  // ── Panel ──────────────────────────────────────────────────────────────────
  window.gwNotifTogglePanel = function () {
    if (_nfState.panelOpen) {
      _nfClosePanel();
    } else {
      _nfOpenPanel();
    }
  };

  function _nfOpenPanel() {
    _nfClosePanel(); // defensive
    _nfState.panelOpen = true;

    const panel = document.createElement('div');
    panel.id = 'gw-notif-panel';
    panel.innerHTML = `
<div class="nf-panel-header">
  <span class="nf-panel-title">${gwIcon('bell','16','#2D7A55')} Notifications</span>
  <div style="display:flex;gap:6px;align-items:center">
    <button class="nf-btn-text" onclick="gwNotifMarkAllRead()">Mark all read</button>
    <button class="nf-close-btn" onclick="_nfClosePanel()">${gwIcon('x','16','#6B7280')}</button>
  </div>
</div>
<div class="nf-panel-body" id="nf-panel-body">
  <div class="nf-loading">${gwIcon('loader','16','#2D7A55')} Loading…</div>
</div>`;

    document.body.appendChild(panel);
    // Close on outside click
    setTimeout(() => {
      document.addEventListener('click', _nfOutsideClick, { once: false });
    }, 50);

    requestAnimationFrame(() => panel.classList.add('nf-panel-visible'));
    _nfRenderPanel();
  }

  function _nfClosePanel() {
    const panel = document.getElementById('gw-notif-panel');
    if (panel) panel.remove();
    _nfState.panelOpen = false;
    document.removeEventListener('click', _nfOutsideClick);
  }
  window._nfClosePanel = _nfClosePanel;

  function _nfOutsideClick(e) {
    const panel = document.getElementById('gw-notif-panel');
    const bell  = document.getElementById('gw-notif-bell-wrap');
    if (panel && !panel.contains(e.target) && bell && !bell.contains(e.target)) {
      _nfClosePanel();
    }
  }

  function _nfRenderPanel() {
    const body = document.getElementById('nf-panel-body');
    if (!body) return;
    const notifs = _nfState.notifications;

    if (!notifs.length) {
      body.innerHTML = `
<div class="nf-empty">
  ${gwIcon('bell','36','#D1D5DB')}
  <p>No notifications yet</p>
  <small>You'll see alerts here for estimates approved, invoices paid, and more.</small>
</div>`;
      return;
    }

    body.innerHTML = notifs.map(_nfRow).join('');
  }

  function _nfRow(n) {
    const iconMap = {
      estimate_approved: { icon:'check-circle', color:'#2D7A55' },
      estimate_declined: { icon:'x-circle',     color:'#DC2626' },
      invoice_paid:      { icon:'dollar-sign',  color:'#2D7A55' },
      wo_completed:      { icon:'tool',          color:'#0EA5E9' },
      new_lead:          { icon:'user-plus',     color:'#7C3AED' },
      review_received:   { icon:'star',          color:'#F59E0B' },
      system:            { icon:'info',          color:'#6B7280' },
    };
    const ic = iconMap[n.type] || iconMap.system;
    const timeAgo = _nfTimeAgo(n.created_at);
    const unreadClass = n.is_read ? '' : 'nf-row-unread';

    return `
<div class="nf-row ${unreadClass}" onclick="gwNotifClick('${n.id}','${_esc(n.action_url)}')" role="button" tabindex="0">
  <div class="nf-row-icon" style="background:${ic.color}18">
    ${gwIcon(ic.icon,'16',ic.color)}
  </div>
  <div class="nf-row-content">
    <div class="nf-row-title">${_esc(n.title)}</div>
    ${n.body ? `<div class="nf-row-body">${_esc(n.body)}</div>` : ''}
    <div class="nf-row-time">${timeAgo}</div>
  </div>
  ${!n.is_read ? '<div class="nf-unread-dot"></div>' : ''}
</div>`;
  }

  // ── Actions ────────────────────────────────────────────────────────────────
  window.gwNotifClick = async function (notifId, actionUrl) {
    // Mark read
    try {
      await fetch(`/api/notifications/${notifId}/read`, { method: 'POST', credentials: 'include' });
      const n = _nfState.notifications.find(n => n.id === notifId);
      if (n && !n.is_read) { n.is_read = 1; _nfState.unread = Math.max(0, _nfState.unread - 1); }
      _nfUpdateBadge();
      _nfRenderPanel();
    } catch (_) {}
    // Navigate
    if (actionUrl) {
      _nfClosePanel();
      const view = actionUrl.replace(/^#/, '');
      if (typeof window.show === 'function' && view) window.show(view);
    }
  };

  window.gwNotifMarkAllRead = async function () {
    try {
      await fetch('/api/notifications/read-all', { method: 'POST', credentials: 'include' });
      _nfState.notifications.forEach(n => { n.is_read = 1; });
      _nfState.unread = 0;
      _nfUpdateBadge();
      _nfRenderPanel();
    } catch (_) {}
  };

  // ── Create notification (called from other modules) ────────────────────────
  /**
   * gwNotifCreate(opts) — fire-and-forget server-side notification creator
   * opts: { type, title, body, entity_type, entity_id, action_url, rep_id }
   */
  window.gwNotifCreate = async function (opts) {
    try {
      await fetch('/api/notifications', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(opts),
      });
      // Refresh poll
      setTimeout(_nfPoll, 500);
    } catch (_) {}
  };

  // ── Helpers ────────────────────────────────────────────────────────────────
  function _nfTimeAgo(ts) {
    if (!ts) return '';
    const diff = Date.now() - new Date(ts).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1)  return 'Just now';
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24)  return `${hrs}h ago`;
    const days = Math.floor(hrs / 24);
    if (days < 7)  return `${days}d ago`;
    return new Date(ts).toLocaleDateString();
  }

  function _esc(s) {
    if (!s) return '';
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  // ── CSS ────────────────────────────────────────────────────────────────────
  function _nfInjectCSS() {
    if (document.getElementById('nf-styles')) return;
    const s = document.createElement('style');
    s.id = 'nf-styles';
    s.textContent = `
/* Bell */
#gw-notif-bell-wrap { position:relative;display:flex;align-items:center; }
.gw-notif-bell { background:none;border:none;cursor:pointer;padding:6px;border-radius:8px;
  color:rgba(255,255,255,.65);display:flex;align-items:center;justify-content:center;position:relative;transition:.15s; }
.gw-notif-bell:hover { background:rgba(255,255,255,.1);color:#fff; }
.gw-notif-badge { position:absolute;top:2px;right:2px;min-width:16px;height:16px;
  background:#DC2626;color:#fff;border-radius:99px;font-size:9px;font-weight:700;
  padding:0 4px;display:flex;align-items:center;justify-content:center;
  border:1.5px solid #111827;line-height:1; }

/* Panel */
#gw-notif-panel { position:fixed;top:52px;right:12px;width:360px;max-width:calc(100vw - 24px);
  background:#fff;border:1px solid #E5E7EB;border-radius:14px;
  box-shadow:0 20px 50px rgba(0,0,0,.18);z-index:9980;
  display:flex;flex-direction:column;max-height:520px;
  opacity:0;transform:translateY(-8px) scale(.97);transition:.2s; }
#gw-notif-panel.nf-panel-visible { opacity:1;transform:translateY(0) scale(1); }

.nf-panel-header { display:flex;justify-content:space-between;align-items:center;
  padding:14px 16px 12px;border-bottom:1px solid #E5E7EB; }
.nf-panel-title { font-size:14px;font-weight:700;color:#111827;display:flex;align-items:center;gap:6px; }
.nf-btn-text { background:none;border:none;color:#2D7A55;font-size:12px;font-weight:500;cursor:pointer;padding:2px 4px; }
.nf-btn-text:hover { text-decoration:underline; }
.nf-close-btn { background:none;border:none;cursor:pointer;padding:4px;border-radius:6px;color:#6B7280;line-height:1; }
.nf-close-btn:hover { background:#F3F4F6; }

.nf-panel-body { overflow-y:auto;flex:1; }
.nf-loading { display:flex;align-items:center;gap:8px;padding:24px;color:#9CA3AF;font-size:13px;justify-content:center; }
.nf-empty { text-align:center;padding:40px 20px;color:#9CA3AF; }
.nf-empty p { font-size:14px;font-weight:500;margin:12px 0 4px;color:#6B7280; }
.nf-empty small { font-size:12px; }

/* Rows */
.nf-row { display:flex;align-items:flex-start;gap:10px;padding:12px 16px;
  cursor:pointer;transition:.12s;position:relative;border-bottom:1px solid #F3F4F6; }
.nf-row:last-child { border-bottom:none; }
.nf-row:hover { background:#F9FAFB; }
.nf-row-unread { background:#FAFFFE; }
.nf-row-icon { width:32px;height:32px;border-radius:8px;display:flex;align-items:center;justify-content:center;flex-shrink:0; }
.nf-row-content { flex:1;min-width:0; }
.nf-row-title { font-size:13px;font-weight:600;color:#111827;line-height:1.4; }
.nf-row-body { font-size:12px;color:#6B7280;margin-top:2px;line-height:1.4;
  overflow:hidden;text-overflow:ellipsis;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical; }
.nf-row-time { font-size:11px;color:#9CA3AF;margin-top:4px; }
.nf-unread-dot { width:7px;height:7px;background:#2D7A55;border-radius:50%;flex-shrink:0;margin-top:4px; }
`;
    document.head.appendChild(s);
  }

  console.log('[Groundwork] notifications.js loaded v20260711p50');
})();
