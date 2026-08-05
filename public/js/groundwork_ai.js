/* ═══════════════════════════════════════════════════════════════════════════
   GROUNDWORK AI — persistent in-app copilot + business coach
   Floating orb (bottom-right) + right-side assistant panel.
   Tabs: Home · Suggestions · Coach · Setup (Getting Started) · Chat
   Data: GET /api/ai/assistant/context (deterministic, no LLM — always works)
         POST /api/ai/assistant (context-aware chat, needs AI key)
   Tenant safety: all data comes from server session-scoped endpoints.
   ═══════════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';
  if (window.gwAI) return; // mount once

  var Z_ORB = 8500, Z_PANEL = 8501; // below copilot tours (9400) & confetti (9900)
  var CTX_TTL = 5 * 60 * 1000;      // refresh context every 5 min
  var state = {
    open: false, tab: 'home', ctx: null, ctxAt: 0, loading: false,
    checklist: null, chat: [], chatBusy: false, oppId: null, oppLabel: '',
    setupPending: false
  };

  function ic(name, size, color) {
    try { if (typeof gwIcon === 'function') return gwIcon(name, size, color); } catch (e) {}
    return '';
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function rep() { return window._d1SessionRep || null; }
  function isMgr() { var r = rep(); return !!(r && (r.role === 'admin' || r.role === 'office_manager')); }
  function isAdmin() { var r = rep(); return !!(r && r.role === 'admin'); }
  function money(n) { return '$' + Number(n || 0).toLocaleString(); }

  /* ── Record-context tracking: lead detail is show('pipeline', oppId) ────── */
  function hookShow() {
    if (window._gwAiShowHooked || typeof window.show !== 'function') return;
    var orig = window.show;
    window.show = function (viewName, param) {
      try {
        if (viewName === 'pipeline' && param) {
          state.oppId = param;
          try {
            var o = (window.state && window.state.opportunities || []).find(function (x) { return x.id === param; });
            state.oppLabel = o ? (o.client || '') : '';
          } catch (e) { state.oppLabel = ''; }
        } else {
          state.oppId = null; state.oppLabel = '';
        }
      } catch (e) {}
      var r = orig.apply(this, arguments);
      try { if (state.open) renderCtxLine(); } catch (e) {}
      return r;
    };
    window._gwAiShowHooked = true;
  }

  /* ── Context fetch (deterministic snapshot + recommendation cards) ──────── */
  function loadCtx(force) {
    if (!force && state.ctx && (Date.now() - state.ctxAt) < CTX_TTL) return Promise.resolve(state.ctx);
    state.loading = true; setOrbThinking(true);
    return fetch('/api/ai/assistant/context', { credentials: 'include' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (raw) {
        var d = raw && raw.data ? raw.data : raw;
        if (d && Array.isArray(d.recommendations)) { state.ctx = d; state.ctxAt = Date.now(); updateBadge(); }
        state.loading = false; setOrbThinking(false);
        return state.ctx;
      })
      .catch(function () { state.loading = false; setOrbThinking(false); return state.ctx; });
  }

  /* ── Unread badge = high-priority recs not yet seen ─────────────────────── */
  function seenKey() { var r = rep(); return 'gwAiSeen_' + (r ? r.company_id : 'x'); }
  function seenSet() { try { return JSON.parse(localStorage.getItem(seenKey()) || '[]'); } catch (e) { return []; } }
  function markAllSeen() {
    if (!state.ctx) return;
    try {
      var ids = state.ctx.recommendations.map(function (r) { return r.id; });
      localStorage.setItem(seenKey(), JSON.stringify(ids.slice(0, 50)));
    } catch (e) {}
    updateBadge();
  }
  function unreadCount() {
    if (!state.ctx) return 0;
    var seen = seenSet();
    return state.ctx.recommendations.filter(function (r) { return r.priority === 'high' && seen.indexOf(r.id) === -1; }).length;
  }
  function updateBadge() {
    var b = document.getElementById('gwAiBadge');
    if (!b) return;
    var n = unreadCount();
    b.style.display = (n > 0 && !state.open) ? 'flex' : 'none';
    b.textContent = n > 9 ? '9+' : String(n);
  }

  /* ── Orb ────────────────────────────────────────────────────────────────── */
  function mountOrb() {
    if (document.getElementById('gwAiOrb')) return;
    var orb = document.createElement('button');
    orb.id = 'gwAiOrb';
    orb.type = 'button';
    orb.setAttribute('aria-label', 'Open Groundwork AI assistant');
    orb.setAttribute('title', 'Groundwork AI');
    orb.innerHTML = '<span id="gwAiOrbIcon" style="display:flex">' + ic('sparkle', 24, '#fff') + '</span>' +
      '<span id="gwAiBadge" style="display:none;position:absolute;top:-3px;right:-3px;min-width:19px;height:19px;border-radius:10px;background:#C0392B;color:#fff;font-size:10.5px;font-weight:900;align-items:center;justify-content:center;padding:0 5px;border:2px solid #fff"></span>';
    orb.onclick = function () { toggle(); };
    document.body.appendChild(orb);
    injectCSS();
    updateBadge();
  }
  function setOrbThinking(on) {
    var orb = document.getElementById('gwAiOrb');
    if (orb) orb.classList[on ? 'add' : 'remove']('gw-ai-thinking');
  }

  /* ── Panel shell ────────────────────────────────────────────────────────── */
  var TABS = [
    { id: 'home',        label: 'Home',        icon: 'home' },
    { id: 'suggestions', label: 'Suggestions', icon: 'idea' },
    { id: 'coach',       label: 'Coach',       icon: 'reports' },
    { id: 'setup',       label: 'Setup',       icon: 'rocket', adminOnly: true },
    { id: 'chat',        label: 'Chat',        icon: 'sparkle' }
  ];

  function open(tab) {
    if (tab) state.tab = tab;
    state.open = true;
    mountPanel();
    loadCtx(false).then(function () { renderTab(); });
    if (state.tab === 'setup') loadChecklist(true).then(function () { if (state.tab === 'setup') renderTab(); });
    var orb = document.getElementById('gwAiOrb');
    if (orb) orb.setAttribute('aria-expanded', 'true');
    updateBadge();
  }
  function close() {
    state.open = false;
    var p = document.getElementById('gwAiPanel');
    if (p) { p.classList.remove('gw-ai-in'); setTimeout(function () { p.remove(); }, 180); }
    var orb = document.getElementById('gwAiOrb');
    if (orb) orb.setAttribute('aria-expanded', 'false');
    markAllSeen();
  }
  function toggle() { state.open ? close() : open(); }

  function mountPanel() {
    if (document.getElementById('gwAiPanel')) { renderTab(); return; }
    var p = document.createElement('div');
    p.id = 'gwAiPanel';
    p.setAttribute('role', 'dialog');
    p.setAttribute('aria-label', 'Groundwork AI assistant');
    p.innerHTML =
      '<div class="gw-ai-head">' +
        '<div style="display:flex;align-items:center;gap:10px">' +
          '<div style="width:34px;height:34px;border-radius:10px;background:rgba(255,255,255,.15);display:flex;align-items:center;justify-content:center">' + ic('sparkle', 18, '#fff') + '</div>' +
          '<div><div style="font-size:15px;font-weight:800">Groundwork AI</div><div id="gwAiCtxLine" style="font-size:11px;opacity:.85"></div></div>' +
        '</div>' +
        '<button onclick="window.gwAI.close()" aria-label="Close assistant" style="background:none;border:none;color:#fff;font-size:20px;cursor:pointer;line-height:1;padding:4px">✕</button>' +
      '</div>' +
      '<div class="gw-ai-tabs" role="tablist">' + TABS.filter(function (t) { return !t.adminOnly || isAdmin(); }).map(function (t) {
        return '<button role="tab" data-gwai-tab="' + t.id + '" onclick="window.gwAI.open(\'' + t.id + '\')">' + ic(t.icon, 13, 'currentColor') + '<span>' + t.label + '</span></button>';
      }).join('') + '</div>' +
      '<div id="gwAiBody" class="gw-ai-body"></div>';
    document.body.appendChild(p);
    requestAnimationFrame(function () { p.classList.add('gw-ai-in'); });
    document.addEventListener('keydown', escClose);
    renderCtxLine();
    renderTab();
  }
  function escClose(e) {
    if (e.key === 'Escape' && state.open && !document.getElementById('gwCpTour')) close();
  }
  function renderCtxLine() {
    var el = document.getElementById('gwAiCtxLine');
    if (!el) return;
    var view = window._currentView || 'dashboard';
    var bits = [];
    if (state.ctx && state.ctx.company) bits.push(state.ctx.company);
    bits.push(state.oppId && state.oppLabel ? ('Viewing lead: ' + state.oppLabel) : ('On: ' + view));
    el.textContent = bits.join(' · ');
  }

  /* ── Tab rendering ──────────────────────────────────────────────────────── */
  function renderTab() {
    var body = document.getElementById('gwAiBody');
    if (!body) return;
    document.querySelectorAll('[data-gwai-tab]').forEach(function (b) {
      b.classList[b.getAttribute('data-gwai-tab') === state.tab ? 'add' : 'remove']('gw-ai-tab-on');
    });
    renderCtxLine();
    if (state.tab === 'home') body.innerHTML = renderHome();
    else if (state.tab === 'suggestions') body.innerHTML = renderSuggestions();
    else if (state.tab === 'coach') body.innerHTML = renderCoach();
    else if (state.tab === 'setup') { body.innerHTML = renderSetup(); if (!state.checklist) loadChecklist(false).then(function () { if (state.tab === 'setup') renderTab(); }); }
    else if (state.tab === 'chat') { body.innerHTML = renderChat(); wireChat(); }
  }

  function card(r, i) {
    var pc = r.priority === 'high' ? '#C0392B' : (r.priority === 'low' ? '#6B7280' : '#B8860B');
    var pbg = r.priority === 'high' ? '#FDF0EE' : (r.priority === 'low' ? '#F3F4F6' : '#FFFBEB');
    var acts = (r.actions || []).slice(0, 3).map(function (a, j) {
      return '<button onclick="window.gwAI._act(' + i + ',' + j + ')" class="gw-ai-actbtn' + (j === 0 ? ' gw-ai-actbtn-pri' : '') + '">' + esc(a.label) + '</button>';
    }).join('');
    var snoozeBtn = '<button onclick="window.gwAI.snooze(\'' + esc(r.id) + '\',this)" title="Hide this suggestion for 7 days" style="margin-left:auto;background:none;border:none;color:#9CA3AF;font-size:10.5px;font-weight:700;cursor:pointer;font-family:inherit;text-decoration:underline;padding:0;align-self:center">Snooze 7d</button>';
    return '<div class="gw-ai-card" data-gwai-rec="' + esc(r.id) + '">' +
      '<div style="display:flex;justify-content:space-between;gap:8px;align-items:flex-start">' +
        '<div style="font-size:13.5px;font-weight:800;color:#1F2937;line-height:1.35">' + esc(r.title) + '</div>' +
        '<span style="flex-shrink:0;font-size:10px;font-weight:900;letter-spacing:.04em;text-transform:uppercase;color:' + pc + ';background:' + pbg + ';padding:3px 8px;border-radius:8px">' + esc(r.priority) + '</span>' +
      '</div>' +
      '<div style="font-size:12.5px;color:#4B5563;margin-top:5px;line-height:1.5">' + esc(r.summary) + '</div>' +
      (r.why ? '<details style="margin-top:6px"><summary style="font-size:11px;font-weight:700;color:#2D7A55;cursor:pointer;list-style:none">Why it matters</summary><div style="font-size:11.5px;color:#6B7280;margin-top:4px;line-height:1.5">' + esc(r.why) + '</div></details>' : '') +
      '<div style="display:flex;gap:6px;margin-top:9px;flex-wrap:wrap">' + acts + snoozeBtn + '</div>' +
    '</div>';
  }

  function snooze(recId, btn) {
    if (btn) { btn.disabled = true; btn.textContent = 'Snoozing…'; }
    fetch('/api/ai/assistant/snooze', {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ recId: recId, days: 7 })
    }).then(function (r) {
      if (!r.ok) throw new Error('snooze failed');
      // Remove from local state + fade the card out
      if (state.ctx && state.ctx.recommendations) {
        state.ctx.recommendations = state.ctx.recommendations.filter(function (x) { return x.id !== recId; });
      }
      var el = document.querySelector('[data-gwai-rec="' + recId + '"]');
      if (el) { el.style.transition = 'opacity .25s'; el.style.opacity = '0'; setTimeout(function () { if (state.open) renderTab(); }, 260); }
      else if (state.open) renderTab();
      updateBadge();
      toast('Snoozed for 7 days.');
    }).catch(function () {
      if (btn) { btn.disabled = false; btn.textContent = 'Snooze 7d'; }
      toast("Couldn't snooze — try again.", true);
    });
  }

  function renderHome() {
    var c = state.ctx;
    if (!c) return loadingHTML();
    var recs = c.recommendations || [];
    var top = recs.slice(0, 3);
    var quick =
      '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">' +
        '<button class="gw-ai-quick" onclick="window.gwAI.open(\'suggestions\')">' + ic('idea', 15, '#2D7A55') + '<span>All suggestions' + (recs.length ? ' (' + recs.length + ')' : '') + '</span></button>' +
        '<button class="gw-ai-quick" onclick="window.gwAI.open(\'chat\')">' + ic('sparkle', 15, '#2D7A55') + '<span>Ask a question</span></button>' +
        (isMgr() ? '<button class="gw-ai-quick" onclick="window.gwAI.open(\'coach\')">' + ic('reports', 15, '#2D7A55') + '<span>Business coach</span></button>' : '') +
        (isAdmin() ? '<button class="gw-ai-quick" onclick="window.gwAI.open(\'setup\')">' + ic('rocket', 15, '#2D7A55') + '<span>Getting Started</span></button>' : '') +
      '</div>';
    return '' +
      '<div class="gw-ai-sect">What I see</div>' +
      '<div class="gw-ai-pulse">' +
        '<div><div class="gw-ai-pulse-n">' + (c.pipeline ? c.pipeline.open : 0) + '</div><div class="gw-ai-pulse-l">Open leads</div></div>' +
        '<div><div class="gw-ai-pulse-n">' + money(c.pipeline ? c.pipeline.value : 0) + '</div><div class="gw-ai-pulse-l">Pipeline value</div></div>' +
        '<div><div class="gw-ai-pulse-n" style="color:' + (recs.length ? '#B8860B' : '#2D7A55') + '">' + recs.length + '</div><div class="gw-ai-pulse-l">Needs attention</div></div>' +
      '</div>' +
      '<div class="gw-ai-sect">What I suggest</div>' +
      (top.length ? top.map(function (r) { return card(r, recs.indexOf(r)); }).join('') :
        '<div class="gw-ai-empty">' + ic('trophy', 22, '#2D7A55') + '<div>Nothing urgent — your pipeline is in good shape. Check the Coach tab for growth ideas.</div></div>') +
      '<div class="gw-ai-sect">What I can do</div>' + quick;
  }

  function renderSuggestions() {
    var c = state.ctx;
    if (!c) return loadingHTML();
    var recs = c.recommendations || [];
    if (!recs.length) return '<div class="gw-ai-empty">' + ic('trophy', 22, '#2D7A55') + '<div>All clear. No overdue follow-ups, stale leads, or unanswered estimates right now.' + (c.snoozed ? ' (' + c.snoozed + ' snoozed)' : '') + '</div></div>' + '<button class="gw-ai-refresh" onclick="window.gwAI.refresh()">Refresh suggestions</button>';
    var snoozeNote = c.snoozed ? '<div style="font-size:10.5px;color:#9CA3AF;text-align:center;margin-top:8px">' + c.snoozed + ' suggestion' + (c.snoozed > 1 ? 's' : '') + ' snoozed — they return automatically after 7 days.</div>' : '';
    return '<div style="font-size:11.5px;color:#6B7280;margin-bottom:10px">Built from your live CRM data — follow-ups, lead activity, estimates, tasks' + (isMgr() ? ', invoices and pipeline flow' : '') + '.</div>' +
      recs.map(function (r, i) { return card(r, i); }).join('') +
      '<button class="gw-ai-refresh" onclick="window.gwAI.refresh()">Refresh suggestions</button>' + snoozeNote;
  }

  function renderCoach() {
    var c = state.ctx;
    if (!c) return loadingHTML();
    var recs = (c.recommendations || []);
    var coachTypes = ['overdue_invoices', 'stage_stagnation', 'stale_lead', 'estimate_no_response'];
    var coach = recs.filter(function (r) { return coachTypes.indexOf(r.type) !== -1; });
    var intro = '<div class="gw-ai-coachintro">' + ic('reports', 16, '#1C3A2B') +
      '<div><b>Coach view</b> — patterns in your ' + esc(c.business_type || 'field services') + ' business that deserve owner-level attention, not just rep-level follow-up.</div></div>';
    var pulse = '<div class="gw-ai-pulse" style="margin-bottom:12px">' +
      '<div><div class="gw-ai-pulse-n">' + (c.pipeline ? c.pipeline.open : 0) + '</div><div class="gw-ai-pulse-l">Open deals</div></div>' +
      '<div><div class="gw-ai-pulse-n">' + money(c.pipeline ? c.pipeline.value : 0) + '</div><div class="gw-ai-pulse-l">In pipeline</div></div>' +
      '<div><div class="gw-ai-pulse-n">' + coach.length + '</div><div class="gw-ai-pulse-l">Risk signals</div></div></div>';
    var tips = '<div class="gw-ai-sect">Habits that compound</div><div class="gw-ai-card" style="font-size:12.5px;color:#4B5563;line-height:1.6">' +
      '<div style="margin-bottom:6px">' + ic('lightning', 13, '#B8860B') + ' <b>Same-day follow-up</b> — leads contacted within 24h close dramatically more often.</div>' +
      '<div style="margin-bottom:6px">' + ic('pointer', 13, '#2D7A55') + ' <b>Always book the next step</b> — never end a touch without the next one scheduled.</div>' +
      '<div>' + ic('invoice', 13, '#5B7FA6') + ' <b>Invoice on completion day</b> — collection odds fall every week you wait.</div></div>';
    return intro + pulse +
      (coach.length ? '<div class="gw-ai-sect">What needs your attention</div>' + coach.map(function (r) { return card(r, recs.indexOf(r)); }).join('') : '<div class="gw-ai-empty">' + ic('trophy', 22, '#2D7A55') + '<div>No structural risks detected right now.</div></div>') +
      tips +
      (c.ai_enabled ? '<button class="gw-ai-refresh" onclick="window.gwAI.askCoach()">Ask the coach about my pipeline</button>' : '');
  }

  /* ── Setup tab (Getting Started lives here now) ─────────────────────────── */
  function loadChecklist(force) {
    if (state.checklist && !force) return Promise.resolve(state.checklist);
    return fetch('/api/onboarding/checklist', { credentials: 'include' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (raw) {
        var d = raw && raw.data ? raw.data : raw;
        if (d && Array.isArray(d.items)) state.checklist = d;
        return state.checklist;
      }).catch(function () { return state.checklist; });
  }

  function renderSetup() {
    var d = state.checklist;
    if (!d) return loadingHTML();
    var pct = d.total ? Math.round(d.done / d.total * 100) : 0;
    var head = '<div class="gw-ai-setuphead">' +
      '<div style="display:flex;justify-content:space-between;align-items:center;font-size:12.5px;font-weight:800;color:#1C3A2B"><span>Getting Started</span><span>' + d.done + ' / ' + d.total + '</span></div>' +
      '<div style="margin-top:7px;height:7px;background:#E5E7EB;border-radius:4px;overflow:hidden"><div style="height:100%;width:' + pct + '%;background:linear-gradient(90deg,#2D7A55,#4D8A86);border-radius:4px;transition:width .3s"></div></div></div>';
    var rows = d.items.map(function (it) {
      var hasTour = window.gwCopilot && window.gwCopilot.TOURS && window.gwCopilot.TOURS[it.id];
      var btns = '';
      if (!it.done) {
        btns = '<div style="display:flex;gap:5px;flex-wrap:wrap;margin-top:7px">' +
          (hasTour ? '<button class="gw-ai-actbtn gw-ai-actbtn-pri" onclick="window.gwAI._tour(\'' + esc(it.id) + '\')">' + ic('sparkle', 11, 'currentColor') + ' Show me</button>' : '') +
          (it.view ? '<button class="gw-ai-actbtn" onclick="window.gwAI._go(\'' + esc(it.view) + '\')">' + esc(it.cta || 'Open') + '</button>' : '') +
          '<button class="gw-ai-actbtn" data-gwai-done="' + esc(it.id) + '" onclick="window.gwAI.markDone(\'' + esc(it.id) + '\',true,this)">Mark done</button></div>';
      } else if (it.manual_done && !it.auto_done) {
        btns = '<button style="background:none;border:none;color:#9CA3AF;font-size:10.5px;font-weight:700;cursor:pointer;font-family:inherit;text-decoration:underline;padding:0;margin-top:5px" data-gwai-done="' + esc(it.id) + '" onclick="window.gwAI.markDone(\'' + esc(it.id) + '\',false,this)">Undo</button>';
      }
      return '<div class="gw-ai-setuprow' + (it.done ? ' gw-ai-setupdone' : '') + '">' +
        '<div class="gw-ai-check' + (it.done ? ' on' : '') + '">✓</div>' +
        '<div style="flex:1;min-width:0"><div style="font-size:13px;font-weight:700;color:#1F2937' + (it.done ? ';text-decoration:line-through' : '') + '">' + esc(it.title) + '</div>' +
        '<div style="font-size:11.5px;color:#6B7280;margin-top:2px">' + esc(it.description || '') + '</div>' + btns + '</div></div>';
    }).join('');
    return head + rows;
  }

  function markDone(stepId, done, btn) {
    if (btn && btn.dataset.saving === '1') return;
    // Optimistic: flip local state + re-render immediately
    var it = (state.checklist && state.checklist.items || []).find(function (x) { return x.id === stepId; });
    var prev = it ? { done: it.done, manual_done: it.manual_done } : null;
    if (btn) { btn.dataset.saving = '1'; btn.disabled = true; btn.textContent = done ? 'Saving…' : 'Undoing…'; }
    if (it) {
      it.done = done || it.auto_done; it.manual_done = done;
      state.checklist.done = state.checklist.items.filter(function (x) { return x.done; }).length;
      if (state.tab === 'setup') renderTab();
    }
    var persist = (window._gwGSPersistDone) ? window._gwGSPersistDone(stepId, done)
      : fetch('/api/onboarding/checklist/' + encodeURIComponent(stepId), { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ done: !!done }) }).then(function (r) { return r.ok; }).catch(function () { return false; });
    Promise.resolve(persist).then(function (ok) {
      if (ok) {
        // Confirm from server truth so refresh-survival is verified, not assumed
        loadChecklist(true).then(function () { if (state.tab === 'setup') renderTab(); });
        try { if (done && window.gwCopilot) window.gwCopilot.checkCelebrate(); } catch (e) {}
      } else {
        if (it && prev) { it.done = prev.done; it.manual_done = prev.manual_done; state.checklist.done = state.checklist.items.filter(function (x) { return x.done; }).length; }
        if (state.tab === 'setup') renderTab();
        toast("Couldn't save — check your connection and try again.", true);
      }
    });
  }

  /* ── Chat tab ───────────────────────────────────────────────────────────── */
  function renderChat() {
    var aiOn = !state.ctx || state.ctx.ai_enabled !== false;
    var msgs = state.chat.map(function (m) {
      if (m.role === 'user') return '<div class="gw-ai-msg gw-ai-msg-u">' + esc(m.text) + '</div>';
      return '<div class="gw-ai-msg gw-ai-msg-a">' + esc(m.text) +
        (m.tour ? '<div style="margin-top:8px"><button class="gw-ai-actbtn gw-ai-actbtn-pri" onclick="window.gwAI._tour(\'' + esc(m.tour) + '\')">' + ic('sparkle', 11, 'currentColor') + ' Show me how</button></div>' : '') + '</div>';
    }).join('');
    var chips = !state.chat.length ? '<div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:10px">' +
      ['What should I focus on today?', 'Which leads are at risk?', 'How do I send an estimate?'].map(function (q) {
        return '<button class="gw-ai-chip" onclick="window.gwAI.ask(\'' + esc(q).replace(/'/g, "\\'") + '\')">' + esc(q) + '</button>';
      }).join('') + '</div>' : '';
    var offNote = !aiOn ? '<div class="gw-ai-coachintro" style="background:#FFFBEB;border-color:#FDE68A">' + ic('idea', 15, '#92400E') + '<div>AI chat isn\'t enabled for your company yet — everything else in this panel still works. An admin can enable it in Settings.</div></div>' : '';
    return offNote +
      '<div id="gwAiMsgs" style="display:flex;flex-direction:column;gap:8px;min-height:60px;margin-bottom:12px">' +
      (msgs || '<div style="font-size:12.5px;color:#6B7280;line-height:1.55">Ask me anything about your CRM, your pipeline, or how to get things done. I can see the page you\'re on' + (state.oppLabel ? ' — including the lead <b>' + esc(state.oppLabel) + '</b>' : '') + '.</div>') +
      (state.chatBusy ? '<div class="gw-ai-msg gw-ai-msg-a" style="opacity:.6">Thinking…</div>' : '') + '</div>' +
      chips +
      '<div style="display:flex;gap:7px">' +
        '<input id="gwAiInput" type="text" placeholder="Ask Groundwork AI…" aria-label="Ask Groundwork AI" ' + (aiOn ? '' : 'disabled ') + 'style="flex:1;border:1.5px solid #D1D5DB;border-radius:11px;padding:10px 13px;font-size:13px;font-family:inherit;outline:none">' +
        '<button id="gwAiSend" ' + (aiOn ? '' : 'disabled ') + 'style="background:linear-gradient(135deg,#1C3A2B,#2D7A55);border:none;border-radius:11px;color:#fff;padding:10px 16px;font-size:13px;font-weight:800;cursor:pointer;font-family:inherit">Send</button></div>';
  }
  function wireChat() {
    var inp = document.getElementById('gwAiInput'), btn = document.getElementById('gwAiSend');
    if (!inp || !btn) return;
    var go = function () { var v = inp.value.trim(); if (v) { inp.value = ''; ask(v); } };
    btn.onclick = go;
    inp.onkeydown = function (e) { if (e.key === 'Enter') go(); };
    if (!state.chatBusy) try { inp.focus(); } catch (e) {}
  }
  function ask(question) {
    if (state.chatBusy) return;
    state.tab = 'chat';
    state.chat.push({ role: 'user', text: question });
    state.chatBusy = true; renderTab(); setOrbThinking(true);
    fetch('/api/ai/assistant', {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: question, view: window._currentView || '', oppId: state.oppId || undefined })
    }).then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
      .then(function (res) {
        var d = res.j && res.j.data ? res.j.data : res.j;
        if (res.ok && d && d.answer) state.chat.push({ role: 'ai', text: d.answer, tour: d.tour || null });
        else state.chat.push({ role: 'ai', text: (d && d.message) || 'I hit a snag — try again in a moment.' });
      })
      .catch(function () { state.chat.push({ role: 'ai', text: 'Network hiccup — try again.' }); })
      .then(function () {
        state.chatBusy = false; setOrbThinking(false);
        if (state.tab === 'chat') { renderTab(); var m = document.getElementById('gwAiMsgs'); if (m) m.scrollTop = m.scrollHeight; }
      });
  }
  function askCoach() { open('chat'); ask('Look at my current pipeline signals and coach me: what are the top 2 things I should fix this week and why?'); }

  /* ── Action dispatcher (user-approved quick actions) ────────────────────── */
  function runAction(a) {
    if (!a || !a.kind) return;
    var p = a.payload || {};
    if (a.kind === 'open_lead' && p.oppId) { close(); if (typeof window.show === 'function') window.show('pipeline', p.oppId); }
    else if (a.kind === 'open_view' && p.view) { close(); if (typeof window.show === 'function') window.show(p.view); }
    else if (a.kind === 'start_tour' && p.tour) { close(); if (window.gwCopilot) window.gwCopilot.startTour(p.tour); }
    else if (a.kind === 'draft_email' && p.oppId) {
      close();
      if (typeof window.gwAiFollowupOpen === 'function') window.gwAiFollowupOpen({ oppId: p.oppId, oppLabel: p.oppLabel || '' });
      else if (typeof window.show === 'function') window.show('pipeline', p.oppId);
    }
    else if (a.kind === 'create_task') {
      var due = new Date(Date.now() + 86400000).toISOString().slice(0, 10); // tomorrow
      fetch('/api/tasks', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: p.title || 'Follow up', taskType: 'follow_up',
          linkedRecordType: p.linkedRecordType || '', linkedRecordId: p.linkedRecordId || '', linkedRecordLabel: p.linkedRecordLabel || '',
          dueDate: due, priority: 'high', source: 'groundwork_ai'
        })
      }).then(function (r) {
        if (r.ok) { toast('Task created for tomorrow: ' + (p.title || 'Follow up')); loadCtx(true).then(function () { if (state.open) renderTab(); }); }
        else toast("Couldn't create the task — try again.", true);
      }).catch(function () { toast("Couldn't create the task — try again.", true); });
    }
  }
  function actByIndex(recIdx, actIdx) {
    var r = state.ctx && state.ctx.recommendations && state.ctx.recommendations[recIdx];
    if (r && r.actions && r.actions[actIdx]) runAction(r.actions[actIdx]);
  }

  /* ── Misc UI ────────────────────────────────────────────────────────────── */
  function loadingHTML() {
    return '<div style="display:flex;flex-direction:column;align-items:center;gap:10px;padding:40px 0;color:#6B7280;font-size:12.5px"><div class="gw-ai-spin"></div>Reading your CRM…</div>';
  }
  function toast(msg, isErr) {
    var t = document.createElement('div');
    t.textContent = msg;
    var lift = window.innerWidth <= 768 ? '150px' : '96px'; // clear mobile nav + orb
    t.style.cssText = 'position:fixed;bottom:' + lift + ';right:22px;z-index:9950;background:' + (isErr ? '#C0392B' : '#1C3A2B') + ';color:#fff;font-size:12.5px;font-weight:700;padding:11px 16px;border-radius:11px;box-shadow:0 8px 28px rgba(0,0,0,.25);max-width:300px;font-family:inherit';
    document.body.appendChild(t);
    setTimeout(function () { t.style.transition = 'opacity .4s'; t.style.opacity = '0'; setTimeout(function () { t.remove(); }, 450); }, 3200);
  }

  function injectCSS() {
    if (document.getElementById('gwAiCSS')) return;
    var s = document.createElement('style');
    s.id = 'gwAiCSS';
    s.textContent = '' +
      '#gwAiOrb{position:fixed;bottom:22px;right:22px;z-index:' + Z_ORB + ';width:56px;height:56px;border-radius:50%;border:none;cursor:pointer;background:linear-gradient(135deg,#1C3A2B,#2D7A55);display:flex;align-items:center;justify-content:center;box-shadow:0 8px 28px rgba(29,58,43,.4);transition:transform .18s,box-shadow .18s;font-family:inherit}' +
      '#gwAiOrb:hover,#gwAiOrb:focus-visible{transform:translateY(-3px) scale(1.05);box-shadow:0 12px 36px rgba(29,58,43,.5)}' +
      '#gwAiOrb:focus-visible{outline:3px solid #4D8A86;outline-offset:2px}' +
      '#gwAiOrb.gw-ai-thinking #gwAiOrbIcon{animation:gwAiPulse 1.1s ease-in-out infinite}' +
      '@keyframes gwAiPulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.55;transform:scale(.88)}}' +
      '#gwAiPanel{position:fixed;top:0;right:0;bottom:0;z-index:' + Z_PANEL + ';width:min(420px,100vw);background:#fff;box-shadow:-12px 0 48px rgba(0,0,0,.22);display:flex;flex-direction:column;transform:translateX(102%);transition:transform .2s ease;font-family:inherit}' +
      '#gwAiPanel.gw-ai-in{transform:translateX(0)}' +
      '.gw-ai-head{background:linear-gradient(135deg,#1C3A2B,#2D7A55);color:#fff;padding:16px 18px;display:flex;justify-content:space-between;align-items:center;flex-shrink:0}' +
      '.gw-ai-tabs{display:flex;border-bottom:1.5px solid #E5E7EB;flex-shrink:0;background:#FAFAF8}' +
      '.gw-ai-tabs button{flex:1;display:flex;flex-direction:column;align-items:center;gap:3px;padding:9px 4px 8px;border:none;background:none;cursor:pointer;font-size:10.5px;font-weight:800;color:#6B7280;font-family:inherit;border-bottom:2.5px solid transparent}' +
      '.gw-ai-tabs button.gw-ai-tab-on{color:#2D7A55;border-bottom-color:#2D7A55;background:#fff}' +
      '.gw-ai-body{flex:1;overflow-y:auto;padding:16px 18px 22px}' +
      '.gw-ai-sect{font-size:10.5px;font-weight:900;letter-spacing:.07em;text-transform:uppercase;color:#9CA3AF;margin:14px 0 8px}' +
      '.gw-ai-sect:first-child{margin-top:0}' +
      '.gw-ai-pulse{display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;background:#F7F9F7;border:1.5px solid #E8EDE8;border-radius:13px;padding:12px 10px;text-align:center}' +
      '.gw-ai-pulse-n{font-size:16px;font-weight:900;color:#1C3A2B}' +
      '.gw-ai-pulse-l{font-size:10px;font-weight:700;color:#6B7280;margin-top:2px}' +
      '.gw-ai-card{background:#fff;border:1.5px solid #E5E7EB;border-radius:13px;padding:13px 14px;margin-bottom:9px}' +
      '.gw-ai-actbtn{background:#F0FAF4;border:1.5px solid rgba(45,122,85,.2);color:#2D7A55;font-size:11px;font-weight:800;padding:6px 11px;border-radius:9px;cursor:pointer;font-family:inherit;white-space:nowrap;display:inline-flex;align-items:center;gap:4px}' +
      '.gw-ai-actbtn-pri{background:#2D7A55;border-color:#2D7A55;color:#fff}' +
      '.gw-ai-actbtn:disabled{opacity:.55;cursor:default}' +
      '.gw-ai-quick{display:flex;align-items:center;gap:8px;background:#fff;border:1.5px solid #E5E7EB;border-radius:11px;padding:11px 12px;font-size:12px;font-weight:800;color:#1F2937;cursor:pointer;font-family:inherit;text-align:left}' +
      '.gw-ai-quick:hover{border-color:#2D7A55;background:#F7FBF8}' +
      '.gw-ai-empty{display:flex;flex-direction:column;align-items:center;gap:8px;text-align:center;padding:22px 14px;background:#F7F9F7;border-radius:13px;font-size:12.5px;color:#4B5563;line-height:1.5}' +
      '.gw-ai-coachintro{display:flex;gap:9px;align-items:flex-start;background:#F0FAF4;border:1.5px solid rgba(45,122,85,.18);border-radius:12px;padding:11px 13px;font-size:12px;color:#374151;line-height:1.5;margin-bottom:12px}' +
      '.gw-ai-refresh{width:100%;background:none;border:1.5px dashed #D1D5DB;border-radius:11px;padding:9px;font-size:11.5px;font-weight:800;color:#6B7280;cursor:pointer;font-family:inherit;margin-top:4px}' +
      '.gw-ai-setuphead{background:#F7F9F7;border:1.5px solid #E8EDE8;border-radius:13px;padding:13px 15px;margin-bottom:12px}' +
      '.gw-ai-setuprow{display:flex;gap:11px;align-items:flex-start;padding:11px 2px;border-bottom:1px solid #F3F4F6}' +
      '.gw-ai-setupdone{opacity:.55}' +
      '.gw-ai-check{width:20px;height:20px;border-radius:50%;flex-shrink:0;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:900;border:2px solid #D1D5DB;color:transparent;margin-top:1px}' +
      '.gw-ai-check.on{background:#2D7A55;border-color:#2D7A55;color:#fff}' +
      '.gw-ai-msg{max-width:88%;padding:10px 13px;border-radius:13px;font-size:12.5px;line-height:1.55;white-space:pre-wrap;word-break:break-word}' +
      '.gw-ai-msg-u{align-self:flex-end;background:#2D7A55;color:#fff;border-bottom-right-radius:4px}' +
      '.gw-ai-msg-a{align-self:flex-start;background:#F3F4F6;color:#1F2937;border-bottom-left-radius:4px}' +
      '.gw-ai-chip{background:#fff;border:1.5px solid #D1D5DB;border-radius:16px;padding:6px 12px;font-size:11px;font-weight:700;color:#374151;cursor:pointer;font-family:inherit}' +
      '.gw-ai-chip:hover{border-color:#2D7A55;color:#2D7A55}' +
      '.gw-ai-spin{width:26px;height:26px;border-radius:50%;border:3px solid #E5E7EB;border-top-color:#2D7A55;animation:gwAiSpin .8s linear infinite}' +
      '@keyframes gwAiSpin{to{transform:rotate(360deg)}}' +
      '@media (max-width:640px){#gwAiPanel{width:100vw}}' +
      /* Mobile / field mode: lift the orb above the fixed bottom nav bar
         (#gw-mobile-nav: 68px + safe-area, shown at <=768px) */
      '@media (max-width:768px){#gwAiOrb{bottom:calc(82px + env(safe-area-inset-bottom));right:14px;width:50px;height:50px}}';
    document.head.appendChild(s);
  }

  /* ── Public API ─────────────────────────────────────────────────────────── */
  window.gwAI = {
    open: open, close: close, toggle: toggle,
    ask: ask, askCoach: askCoach,
    markDone: markDone, snooze: snooze,
    refresh: function () { loadCtx(true).then(function () { if (state.open) renderTab(); }); },
    refreshSetup: function () { loadChecklist(true).then(function () { if (state.open && state.tab === 'setup') renderTab(); }); },
    noteSetupPending: function () { state.setupPending = true; },
    _act: actByIndex,
    _tour: function (id) { close(); if (window.gwCopilot) window.gwCopilot.startTour(id); },
    _go: function (view) { close(); if (typeof window.show === 'function') window.show(view); }
  };

  /* ── Boot: wait for session, skip platform account, mount once ────────────
     The platform guard trusts the SERVER-resolved company (context endpoint),
     not the client-side rep — during impersonation _d1SessionRep still says
     groundwork_platform while the server session is scoped to the tenant. */
  var tries = 0;
  (function boot() {
    tries++;
    var r = rep();
    if (!r) { if (tries < 40) setTimeout(boot, 500); return; } // wait up to 20s for login
    loadCtx(false).then(function (c) {
      var serverCo = c && c.company_id ? c.company_id : r.company_id;
      if (serverCo === 'groundwork_platform') return; // not for the platform account itself
      if (document.getElementById('gwAiOrb')) return;
      // Remove legacy Getting Started launcher if it beat us to the corner
      try { var old = document.getElementById('gwGSLauncher'); if (old) old.remove(); } catch (e) {}
      mountOrb();
      hookShow();
      updateBadge();
      setInterval(function () { if (!document.hidden) loadCtx(true).then(function () { if (state.open) renderTab(); }); }, CTX_TTL);
    });
  })();

  console.log('[Groundwork] groundwork_ai.js loaded v20260720t30');
})();
