/* ══════════════════════════════════════════════════════════════════════════
   GROUNDWORK — GOOGLE CALENDAR SYNC (My Day agenda + lead-linked meetings)

   - gwCalSync():        trigger server-side pull from Google → D1
   - gwCalTodayEvents(): today's synced events (from D1, fast)
   - My Day widget:      hour-by-hour agenda for today, click → full calendar
   - Lead meetings:      events matched to a lead render on the lead record
   Server does the heavy lifting (/api/calendar/sync) using the stored
   refresh token, so this works even before the Google tab is opened.
   ══════════════════════════════════════════════════════════════════════════ */

(function () {
  'use strict';

  const SYNC_MIN_INTERVAL_MS = 4 * 60 * 1000; // don't hammer Google — 4 min between syncs
  let _lastSyncAt = 0;
  let _syncInFlight = null;

  function _esc(s) {
    const d = document.createElement('div');
    d.textContent = s == null ? '' : String(s);
    return d.innerHTML;
  }

  async function _api(method, url, body) {
    const r = await fetch(url, {
      method,
      credentials: 'include',
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.ok === false) throw new Error(j.error || ('HTTP ' + r.status));
    return j;
  }

  // ── Sync trigger (throttled; concurrent calls share one request) ──────────
  async function gwCalSync(force) {
    if (_syncInFlight) return _syncInFlight;
    if (!force && Date.now() - _lastSyncAt < SYNC_MIN_INTERVAL_MS) return { skipped: true };
    _syncInFlight = (async () => {
      try {
        const j = await _api('POST', '/api/calendar/sync');
        _lastSyncAt = Date.now();
        window._gwCalLastSync = j.data;
        if (j.data && j.data.tasksCreated > 0 && typeof showToast === 'function') {
          showToast(j.data.tasksCreated + ' follow-up task' + (j.data.tasksCreated > 1 ? 's' : '') + ' created from finished meetings', 'success');
        }
        return j.data;
      } catch (e) {
        // not_connected is normal for reps without Google — stay quiet
        if (!/not_connected/.test(e.message)) console.warn('[CalSync]', e.message);
        window._gwCalSyncError = e.message;
        return { error: e.message };
      } finally {
        _syncInFlight = null;
      }
    })();
    return _syncInFlight;
  }

  async function gwCalEvents(fromIso, toIso, oppId) {
    const p = new URLSearchParams();
    if (fromIso) p.set('from', fromIso);
    if (toIso) p.set('to', toIso);
    if (oppId) p.set('oppId', oppId);
    const j = await _api('GET', '/api/calendar/events?' + p.toString());
    return j.data || [];
  }

  function _dayBounds(d) {
    const s = new Date(d); s.setHours(0, 0, 0, 0);
    const e = new Date(d); e.setHours(23, 59, 59, 999);
    return [s, e];
  }

  function _evStart(ev) {
    if (ev.all_day) {
      const [y, m, dd] = String(ev.start_at).slice(0, 10).split('-').map(Number);
      return new Date(y, m - 1, dd);
    }
    return new Date(ev.start_at);
  }
  function _evEnd(ev) {
    if (!ev.end_at) return _evStart(ev);
    if (ev.all_day) {
      const [y, m, dd] = String(ev.end_at).slice(0, 10).split('-').map(Number);
      return new Date(y, m - 1, dd);
    }
    return new Date(ev.end_at);
  }

  async function gwCalTodayEvents() {
    const [s, e] = _dayBounds(new Date());
    // start_at is stored ISO (UTC or with offset); over-fetch a day each side
    // then filter locally so timezone edges don't drop events.
    const wide = await gwCalEvents(
      new Date(s.getTime() - 86400000).toISOString(),
      new Date(e.getTime() + 86400000).toISOString()
    );
    return wide.filter(ev => {
      const st = _evStart(ev);
      return st >= s && st <= e;
    }).sort((a, b) => _evStart(a) - _evStart(b));
  }

  function _fmtTime(d) {
    return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }).toLowerCase().replace(' ', '');
  }

  // Google event palette (matches integrations.js)
  const _COLORS = { 1:'#7986CB',2:'#33B679',3:'#8E24AA',4:'#E67C73',5:'#F6BF26',6:'#F4511E',7:'#039BE5',8:'#616161',9:'#3F51B5',10:'#0B8043',11:'#D50000' };
  function _evColor(ev) { return (ev.color_id && _COLORS[ev.color_id]) || '#1967D2'; }

  function _findOpp(oppId) {
    if (!oppId) return null;
    const opps = (window._avalonState && window._avalonState.opportunities) || [];
    return opps.find(o => o.id === oppId) || null;
  }

  // ── My Day widget: hour-by-hour agenda ─────────────────────────────────────
  async function gwCalRenderMyDayWidget() {
    const mount = document.getElementById('gw-myday-cal-mount');
    if (!mount) return;

    const connected = typeof isGoogleConnected === 'function' && isGoogleConnected();
    let serverConnected = false;
    try {
      const st = await _api('GET', '/api/google/status');
      serverConnected = !!(st.data && st.data.connected);
    } catch (e) {}

    if (!connected && !serverConnected) {
      mount.innerHTML =
        '<section class="card"><div class="section-head"><h2>My Calendar</h2></div>' +
        '<div style="text-align:center;padding:26px 16px">' +
        '<div style="font-size:13px;font-weight:700;color:var(--gw-ink,#2F3B33);margin-bottom:4px">Google Calendar not connected</div>' +
        '<div style="font-size:12px;color:var(--gw-text-muted,#64748b);margin-bottom:12px">Connect once and your meetings — including booking-page bookings — show up here and on their leads.</div>' +
        '<button class="secondary-btn" style="font-size:12px" onclick="show(\'integrations\')">Connect Google</button>' +
        '</div></section>';
      return;
    }

    // Fire sync in background, render from D1 immediately, re-render when sync lands
    const paint = async () => {
      const m = document.getElementById('gw-myday-cal-mount');
      if (!m) return;
      let evs = [];
      try { evs = await gwCalTodayEvents(); } catch (e) {}
      const now = new Date();
      const allDay = evs.filter(ev => ev.all_day);
      const timed = evs.filter(ev => !ev.all_day);

      let rows = '';
      if (!evs.length) {
        rows = '<div style="text-align:center;padding:22px 12px;color:var(--gw-text-muted,#64748b);font-size:12.5px">Nothing on the calendar today — enjoy the clear day.</div>';
      } else {
        rows = allDay.map(ev => {
          const opp = _findOpp(ev.opp_id);
          return '<div class="gw-cal-md-row" onclick="gwCalOpenEvent(\'' + _esc(ev.id) + '\')" style="cursor:pointer">' +
            '<span class="gw-cal-md-time" style="font-size:10px;font-weight:800;letter-spacing:.4px">ALL DAY</span>' +
            '<span class="gw-cal-md-bar" style="background:' + _evColor(ev) + '"></span>' +
            '<span class="gw-cal-md-body"><span class="gw-cal-md-title">' + _esc(ev.summary) + '</span>' +
            (opp ? '<span class="gw-cal-md-lead">' + _esc(opp.client) + '</span>' : '') + '</span></div>';
        }).join('') +
        timed.map(ev => {
          const st = _evStart(ev), en = _evEnd(ev);
          const live = st <= now && en >= now;
          const past = en < now;
          const opp = _findOpp(ev.opp_id);
          return '<div class="gw-cal-md-row' + (live ? ' gw-cal-md-row--live' : '') + '" onclick="gwCalOpenEvent(\'' + _esc(ev.id) + '\')" style="cursor:pointer' + (past ? ';opacity:.55' : '') + '">' +
            '<span class="gw-cal-md-time">' + _fmtTime(st) + '</span>' +
            '<span class="gw-cal-md-bar" style="background:' + _evColor(ev) + '"></span>' +
            '<span class="gw-cal-md-body">' +
              '<span class="gw-cal-md-title">' + _esc(ev.summary) + (ev.is_booking ? ' <span class="gw-cal-md-chip">Booked online</span>' : '') + '</span>' +
              '<span class="gw-cal-md-sub">' + _fmtTime(st) + ' – ' + _fmtTime(en) +
              (opp ? ' · <a href="javascript:void(0)" onclick="event.stopPropagation();show(\'pipeline\',\'' + _esc(ev.opp_id) + '\')" style="color:var(--gw-teal,#4D8A86);font-weight:700;text-decoration:none">' + _esc(opp.client) + '</a>' : '') +
              (ev.location ? ' · ' + _esc(String(ev.location).split(',')[0]) : '') + '</span>' +
            '</span>' +
            (live ? '<span class="gw-cal-md-live-dot"></span>' : '') +
            '</div>';
        }).join('');
      }

      const syncInfo = window._gwCalLastSync;
      m.innerHTML =
        '<section class="card">' +
        '<div class="section-head"><h2>My Calendar — Today</h2>' +
        '<div style="display:flex;gap:6px;align-items:center">' +
        '<button class="secondary-btn small" style="font-size:11px" onclick="gwCalMyDayRefresh()" title="Pull the latest from Google Calendar">↻ Sync</button>' +
        '<button class="secondary-btn small" style="font-size:11px" onclick="gwCalOpenFull()">Expand</button>' +
        '</div></div>' +
        '<div class="gw-cal-md-list">' + rows + '</div>' +
        (syncInfo && syncInfo.syncedAt ? '<div style="font-size:10.5px;color:var(--gw-text-muted,#94a3b8);padding:6px 2px 0;text-align:right">Synced ' + new Date(syncInfo.syncedAt).toLocaleTimeString(undefined,{hour:'numeric',minute:'2-digit'}) + (syncInfo.matched ? ' · ' + syncInfo.matched + ' linked to leads' : '') + '</div>' : '') +
        '</section>';
    };

    await paint();
    gwCalSync().then(res => { if (res && !res.skipped && !res.error) paint(); });
  }

  window.gwCalMyDayRefresh = async function () {
    if (typeof showToast === 'function') showToast('Syncing with Google Calendar…', 'info');
    const res = await gwCalSync(true);
    if (res && res.error) {
      if (typeof showToast === 'function') showToast('Sync failed: ' + res.error, 'warn');
    } else {
      if (typeof showToast === 'function') showToast('Calendar synced — ' + (res.synced || 0) + ' events', 'success');
    }
    gwCalRenderMyDayWidget();
  };

  // Expand → full calendar (existing month/week/agenda view in Integrations)
  window.gwCalOpenFull = function () {
    window._intActiveTab = 'calendar';
    if (typeof show === 'function') show('integrations');
    setTimeout(() => { if (typeof window.intShowCalendar === 'function') window.intShowCalendar(); }, 400);
  };

  // ── Event detail popover ───────────────────────────────────────────────────
  window.gwCalOpenEvent = async function (id) {
    let ev;
    try {
      const all = await gwCalEvents();
      ev = all.find(x => x.id === id);
    } catch (e) {}
    if (!ev) return;
    const opp = _findOpp(ev.opp_id);
    const st = _evStart(ev), en = _evEnd(ev);
    const attendees = (ev.attendees || []).filter(a => a.email);
    document.getElementById('gw-cal-ev-modal')?.remove();
    const wrap = document.createElement('div');
    wrap.id = 'gw-cal-ev-modal';
    wrap.style.cssText = 'position:fixed;inset:0;background:rgba(15,23,42,.45);z-index:9000;display:flex;align-items:center;justify-content:center;padding:20px';
    wrap.innerHTML =
      '<div style="background:var(--gw-surface,#fff);border-radius:14px;max-width:480px;width:100%;padding:22px;box-shadow:0 18px 50px rgba(0,0,0,.25)" onclick="event.stopPropagation()">' +
      '<div style="display:flex;align-items:flex-start;gap:10px;margin-bottom:10px">' +
      '<span style="width:12px;height:12px;border-radius:4px;background:' + _evColor(ev) + ';flex-shrink:0;margin-top:4px"></span>' +
      '<div style="flex:1"><div style="font-size:16px;font-weight:800;color:var(--gw-ink,#1F2A2B)">' + _esc(ev.summary) + (ev.is_booking ? ' <span class="gw-cal-md-chip">Booked online</span>' : '') + '</div>' +
      '<div style="font-size:12.5px;color:var(--gw-text-muted,#64748b);margin-top:2px">' +
      (ev.all_day ? st.toLocaleDateString(undefined,{weekday:'long',month:'long',day:'numeric'}) + ' · All day'
                  : st.toLocaleDateString(undefined,{weekday:'long',month:'long',day:'numeric'}) + ' · ' + _fmtTime(st) + ' – ' + _fmtTime(en)) +
      '</div></div>' +
      '<button onclick="document.getElementById(\'gw-cal-ev-modal\').remove()" style="background:none;border:none;font-size:18px;cursor:pointer;color:var(--gw-text-muted,#64748b);padding:0">✕</button></div>' +
      (ev.location ? '<div style="font-size:12.5px;color:var(--gw-ink,#2F3B33);margin-bottom:8px">📍 ' + _esc(ev.location) + '</div>' : '') +
      (opp
        ? '<div style="background:var(--gw-bark-25,#f9f8f6);border:1px solid var(--gw-line,#E5E7EB);border-radius:10px;padding:10px 12px;margin-bottom:10px;display:flex;align-items:center;justify-content:space-between;gap:8px">' +
          '<div><div style="font-size:10.5px;font-weight:800;letter-spacing:.5px;color:var(--gw-text-muted,#64748b);text-transform:uppercase">Linked lead</div>' +
          '<div style="font-size:13.5px;font-weight:700;color:var(--gw-ink,#1F2A2B)">' + _esc(opp.client) + '</div></div>' +
          '<button class="secondary-btn" style="font-size:11.5px;padding:6px 12px" onclick="document.getElementById(\'gw-cal-ev-modal\').remove();show(\'pipeline\',\'' + _esc(ev.opp_id) + '\')">Open Lead →</button></div>'
        : '<div style="background:var(--gw-bark-25,#f9f8f6);border:1px dashed var(--gw-line,#CCC9C0);border-radius:10px;padding:10px 12px;margin-bottom:10px;display:flex;align-items:center;justify-content:space-between;gap:8px">' +
          '<span style="font-size:12px;color:var(--gw-text-muted,#64748b)">Not linked to a lead</span>' +
          '<button class="secondary-btn" style="font-size:11.5px;padding:6px 12px" onclick="gwCalLinkPicker(\'' + _esc(ev.id) + '\')">Link to Lead</button></div>') +
      (attendees.length ? '<div style="font-size:11px;font-weight:800;letter-spacing:.5px;color:var(--gw-text-muted,#64748b);text-transform:uppercase;margin-bottom:4px">Attendees</div>' +
        attendees.map(a => '<div style="font-size:12.5px;color:var(--gw-ink,#2F3B33);padding:2px 0">' + _esc(a.name || a.email) + (a.response === 'accepted' ? ' ✓' : '') + '</div>').join('') : '') +
      (ev.description ? '<div style="font-size:12px;color:var(--gw-text-muted,#475569);margin-top:10px;max-height:120px;overflow:auto;white-space:pre-wrap;line-height:1.5">' + _esc(String(ev.description).slice(0, 600)) + '</div>' : '') +
      '<div style="display:flex;gap:8px;margin-top:14px">' +
      (ev.html_link ? '<a href="' + _esc(ev.html_link) + '" target="_blank" class="secondary-btn" style="font-size:12px;text-decoration:none;padding:7px 14px">Open in Google</a>' : '') +
      (ev.hangout_link ? '<a href="' + _esc(ev.hangout_link) + '" target="_blank" class="primary-btn" style="font-size:12px;text-decoration:none;padding:7px 14px">Join Meet</a>' : '') +
      '</div></div>';
    document.body.appendChild(wrap);
    wrap.addEventListener('click', () => wrap.remove());
  };

  // ── Manual lead-link picker ────────────────────────────────────────────────
  window.gwCalLinkPicker = function (eventId) {
    document.getElementById('gw-cal-ev-modal')?.remove();
    const opps = ((window._avalonState && window._avalonState.opportunities) || [])
      .slice().sort((a, b) => String(a.client || '').localeCompare(String(b.client || '')));
    const wrap = document.createElement('div');
    wrap.id = 'gw-cal-link-modal';
    wrap.style.cssText = 'position:fixed;inset:0;background:rgba(15,23,42,.45);z-index:9001;display:flex;align-items:center;justify-content:center;padding:20px';
    wrap.innerHTML =
      '<div style="background:var(--gw-surface,#fff);border-radius:14px;max-width:420px;width:100%;padding:20px;box-shadow:0 18px 50px rgba(0,0,0,.25)" onclick="event.stopPropagation()">' +
      '<div style="font-size:15px;font-weight:800;color:var(--gw-ink,#1F2A2B);margin-bottom:10px">Link meeting to a lead</div>' +
      '<input id="gw-cal-link-search" type="text" placeholder="Search leads…" style="width:100%;padding:9px 12px;border:1.5px solid var(--gw-line,#E5E7EB);border-radius:8px;font-size:13px;box-sizing:border-box;margin-bottom:8px" oninput="gwCalLinkFilter()">' +
      '<div id="gw-cal-link-list" style="max-height:280px;overflow:auto">' +
      opps.map(o => '<div class="gw-cal-link-row" data-name="' + _esc(String(o.client || '').toLowerCase()) + '" onclick="gwCalDoLink(\'' + _esc(eventId) + '\',\'' + _esc(o.id) + '\')" style="padding:8px 10px;border-radius:8px;cursor:pointer;font-size:13px;color:var(--gw-ink,#2F3B33)" onmouseover="this.style.background=\'var(--gw-bark-25,#f9f8f6)\'" onmouseout="this.style.background=\'\'">' +
        '<span style="font-weight:700">' + _esc(o.client || '(no name)') + '</span>' +
        (o.email ? ' <span style="color:var(--gw-text-muted,#94a3b8);font-size:11.5px">' + _esc(o.email) + '</span>' : '') + '</div>').join('') +
      '</div></div>';
    document.body.appendChild(wrap);
    wrap.addEventListener('click', () => wrap.remove());
    setTimeout(() => document.getElementById('gw-cal-link-search')?.focus(), 50);
  };

  window.gwCalLinkFilter = function () {
    const q = (document.getElementById('gw-cal-link-search')?.value || '').toLowerCase();
    document.querySelectorAll('#gw-cal-link-list .gw-cal-link-row').forEach(r => {
      r.style.display = !q || (r.dataset.name || '').includes(q) ? '' : 'none';
    });
  };

  window.gwCalDoLink = async function (eventId, oppId) {
    try {
      await _api('PUT', '/api/calendar/events/' + encodeURIComponent(eventId) + '/link', { oppId });
      if (typeof showToast === 'function') showToast('Meeting linked to lead', 'success');
    } catch (e) {
      if (typeof showToast === 'function') showToast('Link failed: ' + e.message, 'warn');
    }
    document.getElementById('gw-cal-link-modal')?.remove();
    gwCalRenderMyDayWidget();
  };

  // ── Lead-record meetings loader (synced Google meetings for one lead) ─────
  window.gwCalLeadMeetings = async function (oppId) {
    try { return await gwCalEvents(null, null, oppId); } catch (e) { return []; }
  };

  // Paints synced Google meetings into the lead page's Meetings rail.
  // A MutationObserver watches for the mount appearing (lead page render).
  async function _paintLeadMeetings(mount) {
    const oppId = mount.dataset.opp;
    if (!oppId || mount.dataset.painted === oppId) return;
    mount.dataset.painted = oppId;
    let evs = [];
    try { evs = await window.gwCalLeadMeetings(oppId); } catch (e) { return; }
    if (!evs.length) return;
    const now = new Date();
    const upcoming = evs.filter(ev => _evEnd(ev) >= now);
    const past = evs.filter(ev => _evEnd(ev) < now);
    const shown = (upcoming.length ? upcoming.slice(0, 3) : past.slice(-2));
    if (!shown.length) return;
    const m2 = document.getElementById('gw-lead-cal-meetings');
    if (!m2 || m2.dataset.opp !== oppId) return;
    m2.innerHTML =
      '<div style="font-size:10px;font-weight:800;letter-spacing:.5px;color:var(--gw-text-muted,#94a3b8);text-transform:uppercase;margin:6px 0 2px">From Google Calendar</div>' +
      shown.map(ev => {
        const st = _evStart(ev);
        const isPast = _evEnd(ev) < now;
        return '<div onclick="gwCalOpenEvent(\'' + _esc(ev.id) + '\')" style="display:flex;align-items:center;gap:6px;padding:4px 0;font-size:12px;cursor:pointer">' +
          '<span style="width:6px;height:6px;border-radius:50%;flex-shrink:0;background:' + (isPast ? '#6F7E6A' : _evColor(ev)) + '"></span>' +
          '<span style="font-weight:600;color:var(--gw-ink);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + _esc(ev.summary) + '</span>' +
          (ev.is_booking ? '<span class="gw-cal-md-chip" style="flex-shrink:0">Booked</span>' : '') +
          '<span style="margin-left:auto;color:var(--gw-ink-3,#6F7E6A);flex-shrink:0">' +
          st.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + (ev.all_day ? '' : ' ' + _fmtTime(st)) + '</span>' +
          '</div>';
      }).join('');
  }

  const _leadObserver = new MutationObserver(() => {
    const mount = document.getElementById('gw-lead-cal-meetings');
    if (mount && mount.dataset.painted !== mount.dataset.opp) _paintLeadMeetings(mount);
  });
  if (document.body) _leadObserver.observe(document.body, { childList: true, subtree: true });
  else document.addEventListener('DOMContentLoaded', () => _leadObserver.observe(document.body, { childList: true, subtree: true }));

  // Exports
  window.gwCalSync = gwCalSync;
  window.gwCalEvents = gwCalEvents;
  window.gwCalTodayEvents = gwCalTodayEvents;
  window.gwCalRenderMyDayWidget = gwCalRenderMyDayWidget;

  // Background: sync shortly after login so booking-page bookings + follow-up
  // automation run even if the user never opens the calendar.
  let _bootTries = 0;
  const _bootTimer = setInterval(() => {
    _bootTries++;
    if (window._d1SessionRep) {
      clearInterval(_bootTimer);
      setTimeout(() => gwCalSync(), 2500);
    } else if (_bootTries > 40) clearInterval(_bootTimer);
  }, 1500);
})();
