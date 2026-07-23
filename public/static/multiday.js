/**
 * Groundwork CRM — Multi-Day Jobs
 * multiday.js
 *
 * Staff side: enable multi-day mode on a work order, set per-day scopes,
 * AI generates end-of-day yes/no questions per day.
 * Crew side: daily checklist popup — answer each question yes/no with a
 * REQUIRED photo before advancing to the next question. Completing the day
 * has Groundwork AI compose the client message and publishes it (with the
 * photos) to the client portal automatically.
 *
 * Mounted by _sbOpenVisitModal via window._gwMultidayPanel(woId, el).
 */
(function () {
  'use strict';

  const esc = s => String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  const _toast = (m, t) => { if (typeof showToast === 'function') showToast(m, t || 'info'); };
  const fmtD = s => { if (!s) return ''; const d = new Date(String(s) + 'T12:00:00'); return isNaN(d) ? String(s) : d.toLocaleDateString('en-US', { weekday:'short', month:'short', day:'numeric' }); };
  const PHASE_LABELS = ['Mobilization', 'Demolition', 'Grading', 'Hardscape', 'Planting', 'Cleanup', 'Final Walkthrough'];
  const phaseOptions = v => PHASE_LABELS.map(p => '<option value="' + esc(p) + '"' + (p === v ? ' selected' : '') + '>' + esc(p) + '</option>').join('');
  const dateDays = s => { const t = Date.parse(String(s || '') + 'T12:00:00Z'); return Number.isFinite(t) ? Math.round(t / 86400000) : null; };
  function planWarnings(days) {
    const warnings = [];
    const sorted = (days || []).slice().sort((a,b) => (Number(a.phase_sequence || a.day_number) - Number(b.phase_sequence || b.day_number)) || String(a.day_date||'').localeCompare(String(b.day_date||'')));
    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[i - 1], cur = sorted[i];
      const p = dateDays(prev.day_date), c = dateDays(cur.day_date);
      if (p == null || c == null) continue;
      if (c <= p) warnings.push((cur.phase_name || 'Day ' + cur.day_number) + ' overlaps or is not after ' + (prev.phase_name || 'day ' + prev.day_number) + '.');
      if (c > p + 1) warnings.push('Gap before ' + (cur.phase_name || 'day ' + cur.day_number) + ': ' + (c - p - 1) + ' unscheduled day' + (c - p - 1 === 1 ? '' : 's') + '.');
    }
    return warnings;
  }

  async function api(path, opts = {}) {
    const r = await fetch(path, {
      credentials: 'include',
      headers: opts.body ? { 'Content-Type': 'application/json' } : undefined,
      method: opts.method || (opts.body ? 'POST' : 'GET'),
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || d.ok === false) throw new Error(d.error || ('HTTP ' + r.status));
    return d;
  }

  // ── Staff panel inside the visit modal ─────────────────────────────────────
  window._gwMultidayPanel = async function (woId, el) {
    if (!el) return;
    let state;
    try { state = await api('/api/work-orders/' + woId + '/days'); }
    catch (e) { el.innerHTML = '<p class="sb-empty-note">Multi-day: ' + esc(e.message) + '</p>'; return; }
    render();

    function render() {
      const days = state.data || [];
      if (!state.is_multiday || !days.length) {
        el.innerHTML = `
          <p class="sb-empty-note" style="margin-bottom:8px">Split this job across multiple days. Each day gets an AI-generated end-of-day checklist for the crew; completing a day publishes a progress update (with photos) to the client portal automatically.</p>
          <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
            <label style="font-size:12px;color:var(--gw-text-muted,#7a857f)">Number of days
              <input class="rp-input" type="number" id="gw-md-days" min="2" max="30" value="3" style="width:70px;margin-left:6px">
            </label>
            <button class="rp-btn rp-btn--primary" onclick="_gwMdSetup('${esc(woId)}')">Set Up Multi-Day Job</button>
          </div>
          <div id="gw-md-scopes" style="margin-top:8px"></div>`;
        return;
      }
      const doneCount = days.filter(d => d.status === 'completed').length;
      const pct = Math.round((doneCount / days.length) * 100);
      const warnings = planWarnings(days);
      el.innerHTML = `
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
          <span style="font-size:12px;font-weight:700">${doneCount} of ${days.length} days complete</span>
          <span style="font-size:11.5px;color:var(--gw-text-muted,#7a857f)">${pct}% progress</span>
        </div>
        <div style="height:6px;border-radius:3px;background:var(--gw-surface-3,#eef2f0);overflow:hidden;margin-bottom:10px">
          <div style="height:100%;width:${pct}%;background:var(--gw-green,#2D7A55);border-radius:3px"></div>
        </div>
        ${warnings.length ? `<div class="gw-md-warn"><strong>Schedule warning:</strong><br>${warnings.map(esc).join('<br>')}</div>` : ''}
        ${days.map(d => {
          const qs = d.questions || [];
          const answered = qs.filter(q => q.answer !== null && q.answer !== undefined).length;
          const badge = d.status === 'completed'
            ? '<span style="font-size:10px;font-weight:800;letter-spacing:.4px;color:#fff;background:var(--gw-green,#2D7A55);border-radius:10px;padding:2px 8px">PUBLISHED</span>'
            : d.status === 'in_progress'
              ? `<span style="font-size:10px;font-weight:800;letter-spacing:.4px;color:#8a6d1a;background:#f7ecc8;border-radius:10px;padding:2px 8px">${answered}/${qs.length} ANSWERED</span>`
              : '<span style="font-size:10px;font-weight:800;letter-spacing:.4px;color:var(--gw-text-muted,#7a857f);background:var(--gw-surface-3,#eef2f0);border-radius:10px;padding:2px 8px">PENDING</span>';
          return `
          <div style="display:flex;align-items:center;gap:10px;border:1px solid var(--gw-border,#e3e8e5);border-radius:8px;padding:9px 12px;margin-bottom:6px;background:var(--gw-surface-2,#fff)">
            <div style="min-width:0;flex:1">
              <div style="font-size:12.5px;font-weight:700">Day ${d.day_number}${d.day_date ? ' · ' + fmtD(d.day_date) : ''}</div>
              <div style="font-size:11px;font-weight:800;color:var(--gw-green,#2D7A55);text-transform:uppercase;letter-spacing:.04em">${esc(d.phase_name || 'Phase ' + (d.phase_sequence || d.day_number))}</div>
              ${d.scope ? `<div style="font-size:11.5px;color:var(--gw-text-muted,#7a857f);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(d.scope)}</div>` : ''}
              ${d.depends_on_day_number ? `<div style="font-size:10.5px;color:var(--gw-text-muted,#7a857f)">Depends on day ${esc(d.depends_on_day_number)}${d.dependency_lag_days ? ' + ' + esc(d.dependency_lag_days) + 'd' : ''}</div>` : ''}
            </div>
            ${badge}
            <input class="rp-input" type="date" id="gw-md-shift-${d.day_number}" value="${esc(d.day_date || '')}" style="width:132px">
            <button class="rp-btn-sm" title="Shift this day and later days by the same amount" onclick="_gwMdShiftDownstream('${esc(woId)}',${d.day_number})">Shift Downstream</button>
            ${d.status !== 'completed' ? `<button class="rp-btn-sm" onclick="_gwMdOpenDay('${esc(woId)}',${d.day_number})">${d.status === 'in_progress' ? 'Continue' : 'Start Day'}</button>` : ''}
          </div>`;
        }).join('')}`;
    }

    window._gwMdRefreshPanel = async function () {
      try { state = await api('/api/work-orders/' + woId + '/days'); render(); } catch (_) {}
    };
  };

  // ── Setup: per-day scope inputs then create ─────────────────────────────────
  window._gwMdSetup = function (woId) {
    const n = Math.max(2, Math.min(30, parseInt(document.getElementById('gw-md-days')?.value) || 3));
    const box = document.getElementById('gw-md-scopes');
    if (!box) return;
    box.innerHTML = `
      <p style="font-size:11.5px;color:var(--gw-text-muted,#7a857f);margin:4px 0 6px">Describe what is planned for each day — Groundwork AI turns each day's plan into the crew's end-of-day checklist questions.</p>
      <div class="gw-md-row gw-md-row-head"><span>Day</span><span>Phase</span><span>Date</span><span>Scope</span><span>Depends on</span></div>
      ${Array.from({ length: n }, (_, i) => `
        <div class="gw-md-row">
          <span style="font-size:11px;font-weight:700">Day ${i + 1}</span>
          <input class="rp-input" list="gw-md-phase-labels" id="gw-md-phase-${i + 1}" value="${esc(PHASE_LABELS[Math.min(i, PHASE_LABELS.length - 1)])}">
          <input class="rp-input" type="date" id="gw-md-date-${i + 1}">
          <input class="rp-input" id="gw-md-scope-${i + 1}" placeholder="e.g. ${i === 0 ? 'Demo existing patio, excavate and grade base' : i === 1 ? 'Install base material, compact, set edging' : 'Lay pavers, cut borders, final cleanup'}">
          <input class="rp-input" type="number" min="1" id="gw-md-dep-${i + 1}" value="${i ? i : ''}" ${i ? '' : 'disabled'}>
        </div>`).join('')}
      <datalist id="gw-md-phase-labels">${phaseOptions('')}</datalist>
      <button class="rp-btn rp-btn--primary" style="margin-top:6px" id="gw-md-create" onclick="_gwMdCreate('${esc(woId)}',${n})">Generate Daily Checklists</button>`;
  };

  window._gwMdCreate = async function (woId, n) {
    const btn = document.getElementById('gw-md-create');
    if (btn) { btn.disabled = true; btn.textContent = 'Generating checklists with AI...'; }
    const day_scopes = Array.from({ length: n }, (_, i) => ({
      day_number: i + 1,
      scope: document.getElementById('gw-md-scope-' + (i + 1))?.value?.trim() || '',
      day_date: document.getElementById('gw-md-date-' + (i + 1))?.value || '',
      phase_name: document.getElementById('gw-md-phase-' + (i + 1))?.value?.trim() || PHASE_LABELS[Math.min(i, PHASE_LABELS.length - 1)],
      phase_sequence: i + 1,
      depends_on_day_number: i ? (parseInt(document.getElementById('gw-md-dep-' + (i + 1))?.value) || i) : null,
      dependency_type: 'finish_to_start',
      dependency_lag_days: 0,
    }));
    try {
      const d = await api('/api/work-orders/' + woId + '/multiday', { body: { total_days: n, day_scopes } });
      _toast(d.ai_used ? 'Multi-day plan created — AI generated the daily checklists' : 'Multi-day plan created with standard checklists (AI unavailable)', 'success');
      if (typeof window._gwMdRefreshPanel === 'function') window._gwMdRefreshPanel();
    } catch (e) {
      _toast('Setup failed: ' + e.message, 'error');
      if (btn) { btn.disabled = false; btn.textContent = 'Generate Daily Checklists'; }
    }
  };

  window._gwMdShiftDownstream = async function (woId, dayN) {
    const input = document.getElementById('gw-md-shift-' + dayN);
    const day_date = input && input.value;
    if (!day_date) { _toast('Choose a date first', 'error'); return; }
    try {
      const d = await api('/api/work-orders/' + woId + '/days/' + dayN + '/shift-downstream', { body: { day_date } });
      _toast('Shifted ' + ((d.shifted || []).length) + ' downstream day' + ((d.shifted || []).length === 1 ? '' : 's'), 'success');
      if (typeof window._gwMdRefreshPanel === 'function') window._gwMdRefreshPanel();
      if (typeof window._sbRefresh === 'function') window._sbRefresh();
    } catch (e) { _toast('Shift failed: ' + e.message, 'error'); }
  };

  // ── Crew daily checklist popup ──────────────────────────────────────────────
  window._gwMdOpenDay = async function (woId, dayN) {
    document.getElementById('gw-md-overlay')?.remove();
    let day, dayState;
    try {
      dayState = await api('/api/work-orders/' + woId + '/days');
      day = (dayState.data || []).find(d => d.day_number === dayN);
      if (!day) throw new Error('Day not found');
    } catch (e) { _toast(e.message, 'error'); return; }

    const overlay = document.createElement('div');
    overlay.id = 'gw-md-overlay';
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:9998;display:flex;align-items:center;justify-content:center;padding:14px';
    document.body.appendChild(overlay);

    const qs = day.questions || [];
    let idx = qs.findIndex(q => q.answer === null || q.answer === undefined);
    if (idx < 0) idx = qs.length; // all answered — show completion screen
    let pendingPhoto = null; // { id, file_name }

    function paint() {
      const answered = qs.filter(q => q.answer !== null && q.answer !== undefined).length;
      const total = qs.length;
      const header = `
        <div style="display:flex;justify-content:space-between;align-items:center;padding:16px 20px 12px;border-bottom:1px solid #E5E7EB">
          <div>
            <div style="font-size:16px;font-weight:800;color:#111827">Day ${dayN} of ${dayState.total_days} — End of Day Checklist</div>
            <div style="font-size:11.5px;color:#6B7280;margin-top:2px">${answered} of ${total} answered${day.scope ? ' · ' + esc(day.scope.slice(0, 60)) : ''}</div>
          </div>
          <button style="border:none;background:none;font-size:18px;cursor:pointer;color:#6B7280" onclick="document.getElementById('gw-md-overlay').remove()">&#x2715;</button>
        </div>
        <div style="height:5px;background:#EEF2F0"><div style="height:100%;width:${Math.round((answered / total) * 100)}%;background:#2D7A55;transition:width .3s"></div></div>`;

      let bodyHtml;
      if (idx >= total) {
        // All answered — completion screen
        bodyHtml = `
          <div style="padding:26px 22px;text-align:center">
            <div style="font-size:15px;font-weight:800;color:#111827;margin-bottom:6px">All ${total} questions answered</div>
            <p style="font-size:13px;color:#6B7280;line-height:1.6;margin:0 0 18px">Completing this day sends everything to Groundwork AI, which writes the client update and publishes it with today's photos to the client portal automatically.</p>
            <button id="gw-md-complete-btn" class="rp-btn rp-btn--primary" style="font-size:14px;padding:11px 26px" onclick="_gwMdCompleteDay('${esc(woId)}',${dayN})">Complete Day ${dayN} &amp; Publish to Client Portal</button>
            <div id="gw-md-complete-err" style="color:#B4423A;font-size:12px;margin-top:10px;display:none"></div>
          </div>`;
      } else {
        const q = qs[idx];
        bodyHtml = `
          <div style="padding:20px 22px">
            <div style="font-size:11px;font-weight:800;letter-spacing:.5px;color:#2D7A55;margin-bottom:6px">QUESTION ${idx + 1} OF ${total}</div>
            <div style="font-size:15px;font-weight:700;color:#111827;line-height:1.45;margin-bottom:16px">${esc(q.q)}</div>

            <div style="font-size:11.5px;font-weight:700;color:#374151;margin-bottom:6px">Photo of this task <span style="color:#B4423A">(required)</span></div>
            <div id="gw-md-photo-box" style="margin-bottom:16px">
              ${pendingPhoto
                ? `<div style="display:flex;align-items:center;gap:10px">
                     <img src="/api/admin/portal/media/${esc(pendingPhoto.id)}" style="width:74px;height:74px;object-fit:cover;border-radius:8px;border:1px solid #E5E7EB">
                     <div style="font-size:12px;color:#374151;min-width:0">
                       <div style="font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:220px">${esc(pendingPhoto.file_name || 'photo')}</div>
                       <button style="border:none;background:none;color:#B4423A;font-size:11.5px;cursor:pointer;padding:2px 0" onclick="_gwMdClearPhoto()">Remove &amp; retake</button>
                     </div>
                   </div>`
                : `<label style="display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;border:2px dashed #C9D4CE;border-radius:10px;padding:22px;cursor:pointer;color:#6B7280;font-size:12.5px">
                     <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M23 19a2 2 0 01-2 2H3a2 2 0 01-2-2V8a2 2 0 012-2h4l2-3h6l2 3h4a2 2 0 012 2z"/><circle cx="12" cy="13" r="4"/></svg>
                     Take or choose a photo
                     <input type="file" accept="image/*" capture="environment" style="display:none" onchange="_gwMdUploadPhoto(event,'${esc(woId)}')">
                   </label>
                   <div id="gw-md-upstatus" style="font-size:11.5px;color:#6B7280;margin-top:5px"></div>`}
            </div>

            <div style="display:flex;gap:10px">
              <button class="rp-btn" style="flex:1;font-size:14px;padding:12px;background:#2D7A55;color:#fff;border:none;border-radius:9px;font-weight:800;cursor:pointer;${pendingPhoto ? '' : 'opacity:.45;cursor:not-allowed'}" ${pendingPhoto ? '' : 'disabled'} onclick="_gwMdAnswer('${esc(woId)}',${dayN},${idx},true)">YES — Done</button>
              <button class="rp-btn" style="flex:1;font-size:14px;padding:12px;background:#fff;color:#B4423A;border:1.5px solid #E3B8B4;border-radius:9px;font-weight:800;cursor:pointer;${pendingPhoto ? '' : 'opacity:.45;cursor:not-allowed'}" ${pendingPhoto ? '' : 'disabled'} onclick="_gwMdAnswer('${esc(woId)}',${dayN},${idx},false)">NO — Not finished</button>
            </div>
            <div style="font-size:11px;color:#9CA3AF;margin-top:10px;text-align:center">Attach a photo showing the completed task or current state before answering.</div>
            <div id="gw-md-ans-err" style="color:#B4423A;font-size:12px;margin-top:8px;display:none"></div>
          </div>`;
      }

      overlay.innerHTML = `<div style="background:#fff;border-radius:14px;width:480px;max-width:96vw;max-height:92vh;overflow-y:auto;box-shadow:0 24px 64px rgba(0,0,0,.25)">${header}${bodyHtml}</div>`;
    }
    paint();

    window._gwMdClearPhoto = function () { pendingPhoto = null; paint(); };

    window._gwMdUploadPhoto = async function (ev, wid) {
      const f = (ev.target.files || [])[0];
      ev.target.value = '';
      if (!f) return;
      if (f.size > 15 * 1024 * 1024) { _toast('Photo over 15 MB — choose a smaller one', 'error'); return; }
      const st = document.getElementById('gw-md-upstatus');
      if (st) st.textContent = 'Uploading photo...';
      try {
        const fd = new FormData();
        fd.append('file', f);
        const r = await fetch('/api/admin/portal/projects/' + wid + '/media', { method: 'POST', credentials: 'same-origin', body: fd });
        const d = await r.json();
        if (!r.ok || d.error) throw new Error(d.error || 'Upload failed');
        pendingPhoto = { id: d.id, file_name: d.file_name || f.name };
        paint();
      } catch (e) {
        if (st) st.textContent = 'Upload failed: ' + e.message;
        _toast('Photo upload failed: ' + e.message, 'error');
      }
    };

    window._gwMdAnswer = async function (wid, dn, qi, answer) {
      if (!pendingPhoto) { _toast('Attach a photo first', 'error'); return; }
      try {
        await api('/api/work-orders/' + wid + '/days/' + dn + '/answer', {
          body: { question_index: qi, answer, photo_media_id: pendingPhoto.id },
        });
        qs[qi] = { ...qs[qi], answer, photo_media_id: pendingPhoto.id };
        pendingPhoto = null;
        idx = qi + 1;
        paint();
      } catch (e) {
        const errEl = document.getElementById('gw-md-ans-err');
        if (errEl) { errEl.style.display = 'block'; errEl.textContent = e.message; }
        _toast(e.message, 'error');
      }
    };

    window._gwMdCompleteDay = async function (wid, dn) {
      const btn = document.getElementById('gw-md-complete-btn');
      if (btn) { btn.disabled = true; btn.textContent = 'Groundwork AI is writing the client update...'; }
      try {
        const d = await api('/api/work-orders/' + wid + '/days/' + dn + '/complete', { body: {} });
        document.getElementById('gw-md-overlay')?.remove();
        _toast('Day ' + dn + ' complete — update published to the client portal' + (d.emailed ? ' and emailed to ' + d.emailed + ' portal user' + (d.emailed === 1 ? '' : 's') : ''), 'success');
        if (d.job_completed) _toast('Final day done — job marked completed', 'success');
        if (typeof window._gwMdRefreshPanel === 'function') window._gwMdRefreshPanel();
        if (typeof window._gwPortalUpdatesPanel === 'function') {
          const pp = document.getElementById('gw-wo-portal-panel');
          if (pp) window._gwPortalUpdatesPanel(wid, pp);
        }
      } catch (e) {
        const errEl = document.getElementById('gw-md-complete-err');
        if (errEl) { errEl.style.display = 'block'; errEl.textContent = e.message; }
        if (btn) { btn.disabled = false; btn.textContent = 'Complete Day ' + dn + ' & Publish to Client Portal'; }
        _toast(e.message, 'error');
      }
    };
  };
})();
