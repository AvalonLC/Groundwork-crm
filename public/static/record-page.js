/**
 * Groundwork Record Page System — record-page.js
 *
 * Reusable primitives that power every record detail page:
 *   Lead Detail · Opportunity Detail · Client Detail
 *   (future: Jobs · Employees · Assets)
 *
 * Primitives exposed on window.GW.record:
 *   RecordPageShell(config)       — full 3-col scaffold
 *   RecordLeftPanel(config)       — sticky left identity + meta panel
 *   RecordCenterWorkspace(config) — hero + stage tracker + QA bar + tabs
 *   RecordRightRail(config)       — sticky right rail with cards
 *   StageTracker(stages, current) — visual pipeline progress strip
 *   QuickActionBar(actions)       — horizontal action chip row
 *   InfoSectionCard(config)       — titled card with optional form grid
 *   ActivityTimeline(items)       — full comm/note timeline
 *   StatMicroGrid(stats)          — 2×N micro stat tiles
 *
 * Design rules:
 *   - All classes use rp-* (new) or ld-* (legacy bridge — both are styled)
 *   - No inline styles except data-driven color on timeline dots
 *   - All tokens come from the --gw-* semantic system
 *   - Functions return HTML strings (same pattern as rest of app)
 */

(function () {
  'use strict';

  // ── Namespace ──────────────────────────────────────────────────────────────
  window.GW = window.GW || {};
  window.GW.record = {};
  const R = window.GW.record;

  // ── Local helpers ──────────────────────────────────────────────────────────
  const esc = s => {
    if (s == null) return '';
    return String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  };

  const icon = (name, size, color) =>
    typeof window.gwIcon === 'function'
      ? window.gwIcon(name, size || 14, color || 'currentColor')
      : '';

  // Type → dot CSS class + icon name map
  const COMM_TYPE = {
    email:    { cls: 'type-email',    icon: 'email',    color: 'var(--gw-pine-800)' },
    call:     { cls: 'type-call',     icon: 'call',     color: 'var(--gw-action)' },
    sms:      { cls: 'type-sms',      icon: 'message',  color: 'var(--gw-teal-500,#4D8A86)' },
    note:     { cls: 'type-note',     icon: 'notes',    color: 'var(--gw-warning)' },
    proposal: { cls: 'type-proposal', icon: 'estimate', color: 'var(--gw-teal-500,#4D8A86)' },
  };


  // ══════════════════════════════════════════════════════════════════════════
  // 1. STAGE TRACKER
  // stages: string[]   — ordered stage names
  // current: string    — active stage value
  // onStageClick: fn   — optional, receives (stageName)
  // ══════════════════════════════════════════════════════════════════════════
  R.StageTracker = function (stages, current) {
    if (!stages || !stages.length) return '';

    const currentIdx = stages.indexOf(current);
    const isSold     = current === 'Sold / Activation';
    const isLost     = current === 'Closed Lost';
    // For sold/lost, treat as terminal
    const effectiveIdx = isSold
      ? stages.length
      : isLost
        ? stages.indexOf('Closed Lost')
        : currentIdx;

    // Shorten long labels for the tracker
    const shorten = s => {
      if (!s) return '';
      const shorts = {
        'Lead Intake / Rapport': 'Intake',
        'Mutual Agreement Set': 'Agreement',
        'Discovery / CBR Uncovered': 'Discovery',
        'Budget & Investment Qualified': 'Budget',
        'Decision Process Qualified': 'Decision',
        'Presentation & SOW Pitch': 'Presentation',
        'Deal Closed / Won': 'Won',
        'On Hold': 'On Hold',
        'Closed Lost': 'Lost',
        'Sold / Activation': 'Sold',
      };
      return shorts[s] || (s.length > 14 ? s.slice(0, 12) + '…' : s);
    };

    // Only show active pipeline stages (not Sold/Lost which are handled as terminal)
    const trackStages = stages.filter(s => s !== 'Sold / Activation' && s !== 'Closed Lost');

    const nodes = trackStages.map((s, i) => {
      const isDone    = i < effectiveIdx && !isLost;
      const isCurrent = s === current && !isSold && !isLost;
      let stateClass  = '';
      if (isDone)    stateClass = 'is-done';
      if (isCurrent) stateClass = 'is-current';

      const dotIcon = isDone
        ? `<svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M2 6l2.8 2.8L10 3" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`
        : isCurrent
          ? `<svg width="10" height="10" viewBox="0 0 10 10" fill="none"><circle cx="5" cy="5" r="3" fill="currentColor"/></svg>`
          : '';

      const connector = i < trackStages.length - 1
        ? `<div class="rp-stage-connector"></div>`
        : '';

      return `<div class="rp-stage-node ${stateClass}">
        <button class="rp-stage-btn" title="${esc(s)}" onclick="setOppField&&document.getElementById('statusEdit')&&(document.getElementById('statusEdit').value=this.dataset.stage)&&setOppField" data-stage="${esc(s)}">
          <div class="rp-stage-dot">${dotIcon}</div>
          <span class="rp-stage-label">${esc(shorten(s))}</span>
        </button>
        ${connector}
      </div>`;
    });

    // Terminal badge for Sold/Lost
    let terminalBadge = '';
    if (isSold) {
      terminalBadge = `<div class="rp-stage-node is-sold" style="margin-left:8px">
        <div class="rp-stage-btn" style="min-width:56px">
          <div class="rp-stage-dot">
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M6 1l1.2 3.3h3.3l-2.7 2 1 3L6 7.3l-2.8 2 1-3L1.5 4.3h3.3z" fill="currentColor"/></svg>
          </div>
          <span class="rp-stage-label" style="color:var(--gw-action);font-weight:800">Sold</span>
        </div>
      </div>`;
    } else if (isLost) {
      terminalBadge = `<div class="rp-stage-node is-lost" style="margin-left:8px">
        <div class="rp-stage-btn" style="min-width:56px">
          <div class="rp-stage-dot">
            <svg width="11" height="11" viewBox="0 0 11 11" fill="none"><path d="M2 2l7 7M9 2L2 9" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>
          </div>
          <span class="rp-stage-label" style="color:var(--gw-danger)">Lost</span>
        </div>
      </div>`;
    }

    return `<div class="rp-stage-track-wrap" role="navigation" aria-label="Pipeline stages">
      <div class="rp-stage-track">${nodes.join('')}${terminalBadge}</div>
    </div>`;
  };


  // ══════════════════════════════════════════════════════════════════════════
  // 2. QUICK ACTION BAR
  // actions: [{ id, icon, label, sub, onclick, variant, loading, success }]
  // variant: '' | 'primary' | 'danger'
  // ══════════════════════════════════════════════════════════════════════════
  R.QuickActionBar = function (actions) {
    if (!actions || !actions.length) return '';

    const btns = actions.map(a => {
      const variantClass = a.variant ? ` rp-qa-btn--${a.variant}` : '';
      const stateClass   = a.loading ? ' is-loading' : a.success ? ' is-success' : '';
      const idAttr       = a.id ? ` id="${esc(a.id)}"` : '';
      return `<button type="button"
          class="rp-qa-btn${variantClass}${stateClass}"
          ${idAttr}
          onclick="${esc(a.onclick || '')}"
          title="${esc(a.label)}"
        >
        ${a.icon ? `<span style="display:flex;align-items:center;flex-shrink:0">${a.icon}</span>` : ''}
        <span class="rp-qa-label">${esc(a.label)}</span>
      </button>`;
    }).join('');

    return `<div class="rp-qa-bar" role="toolbar" aria-label="Quick actions">${btns}</div>`;
  };


  // ══════════════════════════════════════════════════════════════════════════
  // 3. INFO SECTION CARD
  // config: { title, titleIcon, actions?, bodyHtml, bodyClass? }
  // ══════════════════════════════════════════════════════════════════════════
  R.InfoSectionCard = function (cfg) {
    const actionsHtml = cfg.actions
      ? `<div class="rp-section-card-actions">${cfg.actions}</div>`
      : '';
    const bodyClass = cfg.bodyClass || '';
    return `<div class="rp-section-card">
      <div class="rp-section-card-head">
        <div class="rp-section-card-title">
          ${cfg.titleIcon ? cfg.titleIcon : ''}
          ${esc(cfg.title)}
        </div>
        ${actionsHtml}
      </div>
      <div class="rp-section-card-body ${bodyClass}">${cfg.bodyHtml || ''}</div>
    </div>`;
  };


  // ══════════════════════════════════════════════════════════════════════════
  // 4. STAT MICRO GRID
  // stats: [{ label, value, accent? }]   accent: 'green'|'red'|'amber'
  // ══════════════════════════════════════════════════════════════════════════
  R.StatMicroGrid = function (stats) {
    if (!stats || !stats.length) return '';
    const tiles = stats.map(s =>
      `<div class="rp-micro-stat">
        <div class="rp-micro-stat-val${s.accent ? ' accent-' + s.accent : ''}">${s.value != null ? esc(String(s.value)) : '—'}</div>
        <div class="rp-micro-stat-label">${esc(s.label)}</div>
      </div>`
    ).join('');
    return `<div class="rp-micro-grid">${tiles}</div>`;
  };


  // ══════════════════════════════════════════════════════════════════════════
  // 5. ACTIVITY TIMELINE
  // items: comm objects { type, direction, ts, subject, body, sentBy }
  // Full timeline — used in the center Activity tab
  // ══════════════════════════════════════════════════════════════════════════
  R.ActivityTimeline = function (items) {
    if (!items || !items.length) {
      return `<div class="rp-timeline-empty">
        ${icon('activity', 28, 'var(--gw-text-subtle)')}
        <p>No activity yet</p>
        <small>Activity appears here as you log calls, emails, and notes.</small>
      </div>`;
    }

    const fmtFull = ts => {
      try {
        return new Date(ts).toLocaleString(undefined, {
          weekday: 'short', month: 'short', day: 'numeric',
          hour: '2-digit', minute: '2-digit'
        });
      } catch { return ''; }
    };

    const rows = items.map(m => {
      const td = COMM_TYPE[m.type] || { cls: '', icon: 'notes', color: 'var(--gw-text-muted)' };
      const typeIcon = icon(td.icon, 14, td.color);
      const dirLabel = m.direction === 'out'
        ? `<span class="rp-timeline-dir">&#8593; Sent</span>`
        : `<span class="rp-timeline-dir">&#8595; Received</span>`;
      const preview = m.body ? esc(m.body.slice(0, 200)) + (m.body.length > 200 ? '…' : '') : '';

      return `<div class="rp-timeline-item">
        <div class="rp-timeline-dot ${esc(td.cls)}">${typeIcon}</div>
        <div class="rp-timeline-content">
          <div class="rp-timeline-header">
            <span class="rp-timeline-type" style="color:${td.color}">${esc((m.type||'').toUpperCase())}</span>
            ${dirLabel}
            <span class="rp-timeline-time">${fmtFull(m.ts)}</span>
          </div>
          ${m.subject ? `<div class="rp-timeline-subject">${esc(m.subject)}</div>` : ''}
          ${preview ? `<div class="rp-timeline-body">${preview}</div>` : ''}
          ${m.sentBy ? `<div class="rp-timeline-actor">by ${esc(m.sentBy)}</div>` : ''}
        </div>
      </div>`;
    });

    return `<div class="rp-timeline">${rows.join('')}</div>`;
  };


  // ══════════════════════════════════════════════════════════════════════════
  // 6. RAIL MINI FEED
  // items: up to 5 recent comm objects
  // ══════════════════════════════════════════════════════════════════════════
  R.RailMiniFeed = function (items) {
    if (!items || !items.length) {
      return `<div class="rp-rail-feed-empty">No activity logged yet</div>`;
    }

    const fmtShort = ts => {
      try {
        return new Date(ts).toLocaleString(undefined, {
          month: 'short', day: 'numeric',
          hour: '2-digit', minute: '2-digit'
        });
      } catch { return ''; }
    };

    return `<div class="rp-rail-feed">${items.slice(0, 5).map(m => {
      const td = COMM_TYPE[m.type] || { cls: '', icon: 'notes', color: 'var(--gw-text-muted)' };
      const typeIcon = icon(td.icon, 13, td.color);
      const preview  = (m.subject || m.body || '').slice(0, 55);
      return `<div class="rp-rail-feed-item">
        <div class="rp-rail-feed-icon">${typeIcon}</div>
        <div class="rp-rail-feed-body">
          <div class="rp-rail-feed-type">${esc((m.type||'').toUpperCase())}</div>
          <div class="rp-rail-feed-preview">${esc(preview)}${(m.subject || m.body || '').length > 55 ? '…' : ''}</div>
          <div class="rp-rail-feed-time">${fmtShort(m.ts)}</div>
        </div>
      </div>`;
    }).join('')}</div>`;
  };


  // ══════════════════════════════════════════════════════════════════════════
  // 7. RECORD LEFT PANEL
  // Renders the sticky 260px left column with identity, contact fields, micro-stats
  //
  // config:
  //   initials: string         — avatar text (1–2 chars)
  //   name: string
  //   subLine: string          — e.g. "Landscape · Residential"
  //   statusHtml: string       — chips to render in status row
  //   sections: [{             — each section block
  //     title: string,
  //     titleIcon: svgString,
  //     fields: [{ label, value, href? }]  — or pass bodyHtml directly
  //     bodyHtml: string
  //   }]
  //   statsHtml: string        — pre-built StatMicroGrid or similar
  // ══════════════════════════════════════════════════════════════════════════
  R.RecordLeftPanel = function (cfg) {
    const sections = (cfg.sections || []).map(sec => {
      const bodyHtml = sec.bodyHtml || (sec.fields || []).map(f => {
        const isEmpty = !f.value && f.value !== 0;
        const val = f.href
          ? `<a href="${esc(f.href)}" target="_blank" rel="noopener">${esc(f.value)}</a>`
          : isEmpty
            ? `<span class="rp-left-field-empty">Not set</span>`
            : esc(f.value);
        return `<div class="rp-left-field">
          <div class="rp-left-field-label">${esc(f.label)}</div>
          <div class="rp-left-field-value">${val}</div>
        </div>`;
      }).join('');

      return `<div class="rp-left-section">
        <div class="rp-left-section-head">
          ${sec.titleIcon || ''}
          ${esc(sec.title)}
        </div>
        ${bodyHtml}
        ${sec.statsHtml || ''}
      </div>`;
    }).join('');

    return `<aside class="rp-left" aria-label="Record overview">
      <div class="rp-left-hero">
        <div class="rp-left-avatar">${esc(cfg.initials || '?')}</div>
        <div class="rp-left-name">${esc(cfg.name || 'Unnamed')}</div>
        ${cfg.subLine ? `<div class="rp-left-sub">${esc(cfg.subLine)}</div>` : ''}
        ${cfg.statusHtml ? `<div class="rp-left-status">${cfg.statusHtml}</div>` : ''}
      </div>
      ${sections}
    </aside>`;
  };


  // ══════════════════════════════════════════════════════════════════════════
  // 8. RECORD RIGHT RAIL
  // Renders the sticky 300px right column as a sequence of rail cards
  //
  // cards: [{
  //   title: string,
  //   titleIcon: svgString,
  //   bodyHtml: string,
  //   alert: bool             — orange alert styling
  //   headActions: string     — extra HTML in header right
  //   noPad: bool
  // }]
  // ══════════════════════════════════════════════════════════════════════════
  R.RecordRightRail = function (cards) {
    const cardHtml = (cards || []).map(c =>
      `<div class="rp-rail-card${c.alert ? ' rp-rail-card--alert' : ''}">
        <div class="rp-rail-card-head">
          ${c.titleIcon || ''}
          ${esc(c.title)}
          ${c.headActions ? `<div class="rp-rail-card-head-actions">${c.headActions}</div>` : ''}
        </div>
        <div class="rp-rail-card-body${c.noPad ? ' no-pad' : ''}">${c.bodyHtml || ''}</div>
      </div>`
    ).join('');

    return `<aside class="rp-rail" aria-label="Record context">${cardHtml}</aside>`;
  };


  // ══════════════════════════════════════════════════════════════════════════
  // 9. RECORD CENTER WORKSPACE
  // Renders the center column: hero + stage tracker + QA bar + tab bar + panels
  //
  // config:
  //   heroHtml: string         — full hero content (name, sub, status chips)
  //   stageTrackerHtml: string — from StageTracker()
  //   qaBarHtml: string        — from QuickActionBar()
  //   tabs: [{
  //     id: string,
  //     label: string,
  //     icon: svgString,
  //     badge: number|null,
  //     active: bool,
  //     contentHtml: string
  //   }]
  // ══════════════════════════════════════════════════════════════════════════
  R.RecordCenterWorkspace = function (cfg) {
    const tabBarItems = (cfg.tabs || []).map(t =>
      `<button
          class="rp-tab${t.active ? ' is-active' : ''}"
          role="tab"
          aria-selected="${t.active ? 'true' : 'false'}"
          aria-controls="rp-panel-${esc(t.id)}"
          onclick="${esc(t.onclick || '')}"
        >
        ${t.icon || ''}
        ${esc(t.label)}
        ${t.badge ? `<span class="rp-tab-badge">${t.badge}</span>` : ''}
      </button>`
    ).join('');

    const panels = (cfg.tabs || []).map(t =>
      `<div
          id="rp-panel-${esc(t.id)}"
          class="rp-tab-panel${t.active ? ' is-active' : ''}"
          role="tabpanel"
        >
        ${t.contentHtml || ''}
      </div>`
    ).join('');

    return `<div class="rp-center">
      ${cfg.heroHtml || ''}
      ${cfg.stageTrackerHtml || ''}
      ${cfg.qaBarHtml || ''}
      <div class="rp-tabs" role="tablist">${tabBarItems}</div>
      <div class="rp-tab-panels">${panels}</div>
    </div>`;
  };


  // ══════════════════════════════════════════════════════════════════════════
  // 10. RECORD PAGE SHELL
  // Full page scaffold: command bar + 3-col body
  //
  // config:
  //   commandBarHtml: string   — sticky top bar content
  //   leftPanelHtml: string    — from RecordLeftPanel()
  //   centerHtml: string       — from RecordCenterWorkspace()
  //   railHtml: string         — from RecordRightRail()
  // ══════════════════════════════════════════════════════════════════════════
  R.RecordPageShell = function (cfg) {
    return `<div class="rp-shell">
      <div class="rp-command" id="rpCommandBar" aria-label="Record command bar">
        ${cfg.commandBarHtml || ''}
      </div>
      <div class="rp-body">
        ${cfg.leftPanelHtml || ''}
        ${cfg.centerHtml || ''}
        ${cfg.railHtml || ''}
      </div>
    </div>`;
  };


  // ══════════════════════════════════════════════════════════════════════════
  // SCROLL OBSERVER — triggers command bar visibility
  // Call after rendering: GW.record.wireCommandBar(heroSelector)
  // ══════════════════════════════════════════════════════════════════════════
  R.wireCommandBar = function (heroSelector) {
    const cmd  = document.getElementById('rpCommandBar');
    const hero = heroSelector
      ? document.querySelector(heroSelector)
      : document.querySelector('.rp-hero, .ld-hero');
    if (!cmd || !hero) return;

    const obs = new IntersectionObserver(
      ([entry]) => cmd.classList.toggle('rp-command--visible', !entry.isIntersecting),
      { threshold: 0, rootMargin: '-52px 0px 0px 0px' }
    );
    obs.observe(hero);
  };

  // ══════════════════════════════════════════════════════════════════════════
  // OVERFLOW MENU TOGGLE — shared by all record pages
  // ══════════════════════════════════════════════════════════════════════════
  // ── Phase 5: Financial Summary Widget ────────────────────────────────────
  // cfg: { contractValue, estimateStatus, depositPaid, depositPct,
  //        totalBilled, totalPaid, balanceDue, estimateId, invoiceId }
  R.FinancialSummary = function(cfg) {
    cfg = cfg || {};
    const fmt = v => {
      if (v == null || v === '') return '—';
      const n = Number(v);
      if (isNaN(n)) return '—';
      return '$' + n.toLocaleString('en-US', {minimumFractionDigits:0, maximumFractionDigits:0});
    };
    const pct = cfg.contractValue > 0 && cfg.totalPaid > 0
      ? Math.min(100, Math.round((cfg.totalPaid / cfg.contractValue) * 100))
      : 0;
    const estBadgeClass = {
      draft: 'fin-sum-badge--draft',
      sent: 'fin-sum-badge--pending',
      approved: 'fin-sum-badge--approved',
      declined: 'fin-sum-badge--overdue',
      invoiced: 'fin-sum-badge--invoiced',
      paid: 'fin-sum-badge--paid'
    }[cfg.estimateStatus] || 'fin-sum-badge--draft';
    const estLabel = cfg.estimateStatus
      ? cfg.estimateStatus.charAt(0).toUpperCase() + cfg.estimateStatus.slice(1)
      : 'No Estimate';
    const fillClass = pct >= 100 ? '' : (pct >= 50 ? '' : (cfg.balanceDue > 0 ? 'fin-sum-progress-fill--warn' : ''));
    const linkEst = cfg.estimateId
      ? `<span class="fin-sum-title-link" onclick="show('estimates','${cfg.estimateId}')">View Estimate →</span>`
      : '';
    const linkInv = cfg.invoiceId
      ? `<span class="fin-sum-title-link" onclick="show('invoices','${cfg.invoiceId}')">View Invoice →</span>`
      : '';
    return `
    <div class="fin-sum-card">
      <div class="fin-sum-title">
        <span>Financial Summary</span>
        ${linkEst || linkInv}
      </div>
      <div class="fin-sum-grid">
        <div class="fin-sum-stat">
          <div class="fin-sum-stat-val">${fmt(cfg.contractValue)}</div>
          <div class="fin-sum-stat-label">Contract Value</div>
        </div>
        <div class="fin-sum-stat">
          <div class="fin-sum-stat-val">${fmt(cfg.depositPaid)}</div>
          <div class="fin-sum-stat-label">Deposit Paid</div>
        </div>
        <div class="fin-sum-stat">
          <div class="fin-sum-stat-val">${fmt(cfg.totalBilled)}</div>
          <div class="fin-sum-stat-label">Total Invoiced</div>
        </div>
        <div class="fin-sum-stat">
          <div class="fin-sum-stat-val${cfg.balanceDue > 0 ? ' fin-sum-stat-val--danger' : ' fin-sum-stat-val--positive'}">${fmt(cfg.balanceDue)}</div>
          <div class="fin-sum-stat-label">Balance Due</div>
        </div>
      </div>
      <div class="fin-sum-progress-wrap">
        <div class="fin-sum-progress-label">
          <span>Collected</span><span>${pct}%</span>
        </div>
        <div class="fin-sum-progress-track">
          <div class="fin-sum-progress-fill ${fillClass}" style="width:${pct}%"></div>
        </div>
      </div>
      <hr class="fin-sum-divider">
      <div class="fin-sum-status-row">
        <span style="font-size:11px;color:var(--gw-text-muted)">Estimate Status</span>
        <span class="fin-sum-badge ${estBadgeClass}">${estLabel}</span>
      </div>
    </div>`;
  };

  // ── Phase 5: Payment Timeline ─────────────────────────────────────────────
  // milestones: [{ name, amount, dueDate, paidDate, status }]
  // status: 'paid' | 'pending' | 'overdue' | 'draft'
  R.PaymentTimeline = function(milestones, cfg) {
    milestones = milestones || [];
    cfg = cfg || {};
    const fmt = v => {
      const n = Number(v);
      if (!v || isNaN(n)) return '—';
      return '$' + n.toLocaleString('en-US', {minimumFractionDigits:0, maximumFractionDigits:0});
    };
    const fmtDate = d => {
      if (!d) return '';
      try { return new Date(d).toLocaleDateString(undefined,{month:'short',day:'numeric',year:'numeric'}); }
      catch(e) { return d; }
    };
    if (!milestones.length) {
      return `<div class="fin-sum-card">
        <div class="fin-sum-title">Payment Schedule</div>
        <div style="font-size:12px;color:var(--gw-text-subtle);font-style:italic;padding:6px 0">No payment milestones set</div>
      </div>`;
    }
    const dotClass = s => ({
      paid: 'pay-tl-dot--done',
      pending: 'pay-tl-dot--pending',
      overdue: 'pay-tl-dot--overdue',
      active: 'pay-tl-dot--active'
    }[s] || 'pay-tl-dot--pending');
    const badgeClass = s => ({
      paid: 'pay-tl-badge--paid',
      pending: 'pay-tl-badge--pending',
      overdue: 'pay-tl-badge--overdue',
      draft: 'pay-tl-badge--draft'
    }[s] || 'pay-tl-badge--pending');
    const rows = milestones.map((m, i) => {
      const isLast = i === milestones.length - 1;
      const statusLabel = m.status ? m.status.charAt(0).toUpperCase() + m.status.slice(1) : 'Pending';
      const dateLabel = m.status === 'paid' && m.paidDate
        ? `Paid ${fmtDate(m.paidDate)}`
        : (m.dueDate ? `Due ${fmtDate(m.dueDate)}` : '');
      return `
      <div class="pay-tl-row">
        <div class="pay-tl-spine">
          <div class="pay-tl-dot ${dotClass(m.status)}"></div>
          ${!isLast ? '<div class="pay-tl-line"></div>' : ''}
        </div>
        <div class="pay-tl-content">
          <div class="pay-tl-head">
            <div class="pay-tl-name">${m.name || 'Payment ' + (i+1)}</div>
            <div class="pay-tl-amount">${fmt(m.amount)}</div>
          </div>
          <div class="pay-tl-meta">${dateLabel}</div>
          <span class="pay-tl-badge ${badgeClass(m.status)}">${statusLabel}</span>
        </div>
      </div>`;
    }).join('');
    return `
    <div class="fin-sum-card">
      <div class="fin-sum-title">
        <span>Payment Schedule</span>
        ${cfg.invoiceId ? `<span class="fin-sum-title-link" onclick="show('invoices','${cfg.invoiceId}')">Full Invoice →</span>` : ''}
      </div>
      <div class="pay-tl-wrap">${rows}</div>
    </div>`;
  };

  // ── Phase 5: Communications Timeline ─────────────────────────────────────
  // events: [{ type, direction, subject, body, ts, files }]
  R.CommTimeline = function(events, cfg) {
    events = (events || []).sort((a,b) => new Date(b.ts) - new Date(a.ts));
    cfg = cfg || {};
    var _commIcons = {
      sms:      '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M2 2h12a1 1 0 011 1v8a1 1 0 01-1 1H5l-3 3V3a1 1 0 011-1z"/></svg>',
      email:    '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="1" y="3" width="14" height="10" rx="1.5"/><path d="M1 6l7 4 7-4"/></svg>',
      call:     '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 2a1 1 0 011-1h2l1 3-1.5 1.5a9 9 0 004 4L11 8l3 1v2a1 1 0 01-1 1C6 12 4 5 3 3.5V2z"/></svg>',
      note:     '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 1h8a1 1 0 011 1v10l-3 3H4a1 1 0 01-1-1V2a1 1 0 011-1z"/><path d="M5 5h6M5 8h4"/></svg>',
      proposal: '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 1h8a1 1 0 011 1v12a1 1 0 01-1 1H4a1 1 0 01-1-1V2a1 1 0 011-1z"/><path d="M5 5h6M5 8h6M5 11h4"/></svg>'
    };
    var typeIcon = function(t) { return _commIcons[t] || '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="8" cy="8" r="6"/></svg>'; };
    const fmtDate = d => {
      if (!d) return '';
      try { return new Date(d).toLocaleString(undefined,{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}); }
      catch(e) { return d; }
    };
    if (!events.length) {
      return `<div style="padding:16px;font-size:12px;color:var(--gw-text-subtle);font-style:italic">No communications logged yet</div>`;
    }
    const items = events.map(m => {
      const preview = (m.subject || m.body || '').slice(0, 100);
      const iconClass = `comm-tl-icon comm-tl-icon--${m.type || 'note'}`;
      return `
      <div class="comm-tl-item">
        <div class="${iconClass}">${typeIcon(m.type)}</div>
        <div class="comm-tl-body">
          <div class="comm-tl-meta">
            <span class="comm-tl-type">${(m.type||'note').toUpperCase()}</span>
            <span class="comm-tl-dir">${m.direction==='out'?'↑ Sent':'↓ Received'}</span>
          </div>
          <div class="comm-tl-preview">${preview}${(m.subject||m.body||'').length>100?'…':''}</div>
        </div>
        <div class="comm-tl-time">${fmtDate(m.ts)}</div>
      </div>`;
    }).join('');
    return `<div class="comm-tl-wrap">${items}</div>`;
  };

  // ══ PHASE 6 PRIMITIVES ═══════════════════════════════════════════════════

  // ── R.OpsStatusBar(stats) ─────────────────────────────────────────────────
  // stats: [{ val, label, accent, filter }]
  // accent: 'warning' | 'danger' | 'positive' | 'info' | '' (neutral)
  R.OpsStatusBar = function(stats) {
    if (!stats || !stats.length) return '';
    const cells = stats.map((s, i) => {
      const valClass = s.accent ? ` ops-sum-val--${s.accent}` : '';
      return `<div class="ops-sum-stat" data-filter="${s.filter||''}"
                   onclick="window._opsFilterActive='${s.filter||''}';
                            document.querySelectorAll('.ops-sum-stat').forEach(el=>el.classList.remove('is-active'));
                            this.classList.add('is-active');
                            window._opsRenderFilter&&window._opsRenderFilter('${s.filter||''}')">
        <div class="ops-sum-val${valClass}">${s.val}</div>
        <div class="ops-sum-label">${s.label}</div>
        ${s.delta ? `<div class="ops-sum-delta">${s.delta}</div>` : ''}
      </div>`;
    });
    return `<div class="ops-sum-bar">${cells.join('')}</div>`;
  };

  // ── R.AssignBlock(cfg) ────────────────────────────────────────────────────
  // cfg: { crew: [{initials, name}], window: string, area: string, unassigned: bool }
  R.AssignBlock = function(cfg) {
    cfg = cfg || {};
    if (cfg.unassigned) {
      return `<div class="ops-assign-row">
        <span class="ops-assign-empty" onclick="${cfg.onAssign||''}">
          <svg width="11" height="11" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M7 1v12M1 7h12"/></svg>
          Assign Crew
        </span>
        ${cfg.window ? `<span class="ops-assign-window">${cfg.window}</span>` : '<span class="ops-assign-window" style="color:var(--gw-text-subtle)">No date set</span>'}
      </div>`;
    }
    const crew = cfg.crew || [];
    const visible = crew.slice(0, 3);
    const overflow = crew.length > 3 ? crew.length - 3 : 0;
    const avatars = visible.map(c =>
      `<div class="ops-assign-avatar" title="${c.name||''}">${c.initials||'?'}</div>`
    ).join('') + (overflow ? `<div class="ops-assign-overflow">+${overflow}</div>` : '');
    return `<div class="ops-assign-row">
      <div class="ops-assign-avatars">${avatars}</div>
      ${cfg.window ? `<span class="ops-assign-window">${cfg.window}</span>` : ''}
      ${cfg.area   ? `<span class="ops-assign-area">${cfg.area}</span>` : ''}
    </div>`;
  };

  // ── R.ReadinessBadge(state, reason) ──────────────────────────────────────
  // state: one of the ops-ready-- classes (without prefix)
  R.ReadinessBadge = function(state, reason) {
    const labels = {
      'unscheduled':       'Ready to Schedule',
      'scheduled':         'Scheduled',
      'crew-ready':        'Crew Ready',
      'pending-approval':  'Pending Approval',
      'waiting-materials': 'Waiting on Materials',
      'waiting-deposit':   'Waiting on Deposit',
      'blocked':           'Blocked',
      'in-progress':       'In Progress',
      'complete':          'Complete',
      'cancelled':         'Cancelled'
    };
    const label = labels[state] || state;
    const badge = `<span class="ops-ready-badge ops-ready--${state}">
      <span class="ops-ready-dot"></span>${label}
    </span>`;
    return reason
      ? `<div>${badge}<div class="ops-ready-reason">${reason}</div></div>`
      : badge;
  };

  // ── R.AssetStatusBadge(state) ─────────────────────────────────────────────
  R.AssetStatusBadge = function(state) {
    const labels = {
      'available':      'Available',
      'assigned':       'Assigned',
      'in-maintenance': 'In Maintenance',
      'out-of-service': 'Out of Service',
      'inspection-due': 'Inspection Due',
      'overdue-maint':  'Maintenance Overdue',
      'retired':        'Retired'
    };
    return `<span class="ops-asset-badge ops-asset--${state}">${labels[state]||state}</span>`;
  };

  // ── R.InvtStatusBadge(state) ─────────────────────────────────────────────
  R.InvtStatusBadge = function(state) {
    const labels = {
      'in-stock':    'In Stock',
      'low-stock':   'Low Stock',
      'reserved':    'Reserved',
      'on-order':    'On Order',
      'delivered':   'Delivered',
      'consumed':    'Consumed',
      'unavailable': 'Unavailable'
    };
    return `<span class="ops-inv-badge ops-inv--${state}">${labels[state]||state}</span>`;
  };

  // ── R.OpsTL(events) ───────────────────────────────────────────────────────
  // events: [{ title, desc, time, variant }]  variant: 'muted'|'warn'|'danger'|''
  R.OpsTL = function(events) {
    events = events || [];
    if (!events.length) return `<div style="font-size:12px;color:var(--gw-text-subtle);font-style:italic;padding:8px 0">No activity yet</div>`;
    const rows = events.map((e, i) => {
      const isLast = i === events.length - 1;
      const dotCls = e.variant ? ` ops-tl-dot--${e.variant}` : '';
      return `<div class="ops-tl-entry">
        <div class="ops-tl-spine">
          <div class="ops-tl-dot${dotCls}"></div>
          ${!isLast ? '<div class="ops-tl-line"></div>' : ''}
        </div>
        <div class="ops-tl-body">
          <div class="ops-tl-title">${e.title}</div>
          ${e.desc ? `<div class="ops-tl-desc">${e.desc}</div>` : ''}
        </div>
        <div class="ops-tl-time">${e.time||''}</div>
      </div>`;
    });
    return `<div class="ops-tl-wrap">${rows.join('')}</div>`;
  };

  window.toggleRecordOverflow = function (btn) {
    const menu = btn ? btn.nextElementSibling : null;
    if (!menu) return;
    const isOpen = menu.style.display !== 'none';
    // Close all open menus first
    document.querySelectorAll('.rp-overflow-menu, .ld-overflow-menu').forEach(m => {
      m.style.display = 'none';
    });
    if (!isOpen) menu.style.display = 'block';
  };

  // Close menus on outside click
  document.addEventListener('click', e => {
    if (!e.target.closest('.rp-overflow-wrap, .ld-overflow-wrap')) {
      document.querySelectorAll('.rp-overflow-menu, .ld-overflow-menu').forEach(m => {
        m.style.display = 'none';
      });
    }
  }, { capture: false });

})();
