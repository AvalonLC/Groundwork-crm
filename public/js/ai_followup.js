/**
 * ai_followup.js — AI Phase 1: meeting transcript → AI-drafted follow-up email
 * ════════════════════════════════════════════════════════════════════════════
 * Flow: rep opens a follow-up task (usually auto-created by calendar automation)
 *   → clicks "AI Follow-Up" → pastes transcript/notes → AI drafts the email
 *   with full lead context → rep edits → sends via their connected Gmail →
 *   email logs to the lead's Communications → task auto-completes.
 *
 * Depends on (all loaded earlier): integrations.js (gmailSendEmail via
 * window.intSendEmail path is internal, so we re-implement send through
 * window._gwAiSendViaGmail using the exposed gwEnsureComposeModal path OR the
 * raw helper if exported), task_engine.js (window.gwTask.complete).
 */
(function () {
  'use strict';

  const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const toast = (m, t) => { if (typeof window.showToast === 'function') window.showToast(m, t || 3000); };

  let _state = { taskId: null, oppId: null, oppLabel: '', draft: null };

  // ── Modal skeleton (injected once) ─────────────────────────────────────────
  function ensureModal() {
    if (document.getElementById('gw-aifu-overlay')) return;
    const div = document.createElement('div');
    div.innerHTML = `
<div id="gw-aifu-overlay" style="display:none;position:fixed;inset:0;background:#000000a8;z-index:10000;align-items:center;justify-content:center;padding:20px">
  <div class="gw-modal-card" style="border-radius:16px;width:100%;max-width:720px;max-height:92vh;display:flex;flex-direction:column;box-shadow:0 24px 64px #000a;background:var(--gw-surface,#fff)">
    <header style="display:flex;align-items:center;justify-content:space-between;padding:20px 24px 14px;border-bottom:1px solid var(--gw-line,#E0DDD5)">
      <div>
        <h3 style="margin:0;font-size:17px;font-weight:800;color:var(--gds-ink,#1F2A2B);display:flex;align-items:center;gap:8px">${(typeof gwIcon==='function')?gwIcon('sparkle',17,'currentColor'):''} AI Follow-Up Email</h3>
        <div id="gw-aifu-sub" style="font-size:12px;color:var(--gds-muted,#5E6E6F);margin-top:2px"></div>
      </div>
      <button onclick="window.gwAiFollowupClose()" style="background:none;border:none;color:#6F7E6A;font-size:22px;cursor:pointer;line-height:1">×</button>
    </header>
    <main id="gw-aifu-body" style="padding:20px 24px;overflow-y:auto;flex:1"></main>
  </div>
</div>`;
    document.body.appendChild(div.firstElementChild);
  }

  // ── Step 1: transcript input ────────────────────────────────────────────────
  function renderStep1() {
    const body = document.getElementById('gw-aifu-body');
    if (!body) return;
    body.innerHTML = `
<div style="display:flex;flex-direction:column;gap:14px">
  <div style="padding:10px 14px;background:rgba(77,138,134,.08);border:1px solid rgba(77,138,134,.25);border-radius:10px;font-size:12.5px;color:var(--gds-pine,#204A43);line-height:1.55">
    Paste your meeting recording transcript or your raw meeting notes below. The AI already knows this lead's
    profile and communication history — it will draft a grounded recap + next-steps email for you to review.
  </div>
  <div>
    <label style="font-size:11px;font-weight:700;color:var(--gds-muted,#5E6E6F);text-transform:uppercase;letter-spacing:.05em;display:block;margin-bottom:6px">Meeting transcript / notes</label>
    <textarea id="gw-aifu-transcript" rows="10" placeholder="Paste the transcript or type your meeting notes here…"
      style="width:100%;padding:12px;background:var(--gw-surface-3,#F2EFE9);border:1px solid var(--gw-line,#E0DDD5);border-radius:10px;color:var(--gw-ink,#1F2A2B);font-size:13px;line-height:1.5;resize:vertical;box-sizing:border-box;font-family:inherit"></textarea>
  </div>
  <div>
    <label style="font-size:11px;font-weight:700;color:var(--gds-muted,#5E6E6F);text-transform:uppercase;letter-spacing:.05em;display:block;margin-bottom:6px">Extra instructions <span style="font-weight:500;text-transform:none;letter-spacing:0">(optional)</span></label>
    <input id="gw-aifu-instructions" type="text" placeholder='e.g. "mention the drainage concern", "keep it short", "Spanish"'
      style="width:100%;padding:10px 12px;background:var(--gw-surface-3,#F2EFE9);border:1px solid var(--gw-line,#E0DDD5);border-radius:10px;color:var(--gw-ink,#1F2A2B);font-size:13px;box-sizing:border-box">
  </div>
  <div style="display:flex;justify-content:flex-end;gap:8px">
    <button onclick="window.gwAiFollowupClose()" class="secondary-btn">Cancel</button>
    <button id="gw-aifu-draft-btn" onclick="window.gwAiFollowupDraft()" class="primary-btn">${(typeof gwIcon==='function')?gwIcon('sparkle',13,'currentColor'):''} Draft Email</button>
  </div>
  <div id="gw-aifu-error" style="display:none;padding:10px 14px;background:rgba(191,73,52,.08);border:1px solid rgba(191,73,52,.3);border-radius:10px;font-size:12.5px;color:#8C3A2B;line-height:1.5"></div>
</div>`;
  }

  // ── Step 2: review/edit/send ───────────────────────────────────────────────
  function renderStep2(d) {
    const body = document.getElementById('gw-aifu-body');
    if (!body) return;
    const connected = (typeof window.isGoogleConnected === 'function') ? window.isGoogleConnected()
      : !!(window.integrations); // fallback: assume module present
    body.innerHTML = `
<div style="display:flex;flex-direction:column;gap:14px">
  <div style="display:flex;align-items:center;gap:8px;font-size:12px;color:#2D7A55;font-weight:600">
    ✓ Draft ready — grounded in this lead's history (${d.tokens ? d.tokens + ' tokens' : 'AI'}) · review &amp; edit before sending
  </div>
  <div>
    <label style="font-size:11px;font-weight:700;color:var(--gds-muted,#5E6E6F);text-transform:uppercase;letter-spacing:.05em;display:block;margin-bottom:6px">To</label>
    <input id="gw-aifu-to" type="email" value="${esc(d.to_email || '')}" placeholder="client@example.com"
      style="width:100%;padding:10px 12px;background:var(--gw-surface-3,#F2EFE9);border:1px solid var(--gw-line,#E0DDD5);border-radius:10px;color:var(--gw-ink,#1F2A2B);font-size:13px;box-sizing:border-box">
  </div>
  <div>
    <label style="font-size:11px;font-weight:700;color:var(--gds-muted,#5E6E6F);text-transform:uppercase;letter-spacing:.05em;display:block;margin-bottom:6px">Subject</label>
    <input id="gw-aifu-subject" type="text" value="${esc(d.subject || '')}"
      style="width:100%;padding:10px 12px;background:var(--gw-surface-3,#F2EFE9);border:1px solid var(--gw-line,#E0DDD5);border-radius:10px;color:var(--gw-ink,#1F2A2B);font-size:13px;font-weight:600;box-sizing:border-box">
  </div>
  <div>
    <label style="font-size:11px;font-weight:700;color:var(--gds-muted,#5E6E6F);text-transform:uppercase;letter-spacing:.05em;display:block;margin-bottom:6px">Email body <span style="font-weight:500;text-transform:none;letter-spacing:0">(editable)</span></label>
    <div id="gw-aifu-editor" contenteditable="true"
      style="min-height:220px;max-height:340px;overflow-y:auto;padding:14px;background:#fff;border:1px solid var(--gw-line,#E0DDD5);border-radius:10px;color:#1F2A2B;font-size:13.5px;line-height:1.6;box-sizing:border-box">${d.body_html || ''}</div>
  </div>
  ${connected ? '' : `<div style="padding:10px 14px;background:rgba(139,105,20,.08);border:1px solid rgba(139,105,20,.3);border-radius:10px;font-size:12px;color:#7A5C10">Google isn't connected — connect Gmail on the Integrations page to send directly. You can still copy the draft.</div>`}
  <div style="display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap">
    <div style="display:flex;gap:8px">
      <button onclick="window.gwAiFollowupBack()" class="secondary-btn" style="font-size:12px">← Re-draft</button>
      <button onclick="window.gwAiFollowupCopy()" class="secondary-btn" style="font-size:12px">Copy</button>
    </div>
    <div style="display:flex;gap:8px;align-items:center">
      <label style="display:flex;align-items:center;gap:6px;font-size:12px;color:var(--gds-muted,#5E6E6F);cursor:pointer">
        <input id="gw-aifu-complete-task" type="checkbox" checked style="accent-color:#2D7A55"> Complete task after send
      </label>
      <button id="gw-aifu-send-btn" onclick="window.gwAiFollowupSend()" class="primary-btn" ${connected ? '' : 'disabled style="opacity:.5;cursor:not-allowed"'}>Send via Gmail →</button>
    </div>
  </div>
</div>`;
  }

  // ── Public API ──────────────────────────────────────────────────────────────
  // Open the modal. opts: { taskId?, oppId, oppLabel? }
  window.gwAiFollowupOpen = function (opts) {
    opts = opts || {};
    _state = { taskId: opts.taskId || null, oppId: opts.oppId || null, oppLabel: opts.oppLabel || '', draft: null };
    ensureModal();
    const sub = document.getElementById('gw-aifu-sub');
    if (sub) sub.textContent = _state.oppLabel ? ('For: ' + _state.oppLabel) : 'Draft a grounded post-meeting email';
    renderStep1();
    document.getElementById('gw-aifu-overlay').style.display = 'flex';
    setTimeout(() => document.getElementById('gw-aifu-transcript')?.focus(), 60);
    _checkQuota();
  };

  // Phase 2: quota awareness — warn at 80%+, explain when blocked at 100%.
  async function _checkQuota() {
    try {
      const r = await fetch('/api/ai/quota', { credentials: 'include' });
      const j = await r.json().catch(() => ({}));
      const q = j.data || j;
      if (!q || !q.metered) return;   // BYOK / env keys are never capped
      const errEl = document.getElementById('gw-aifu-error');
      if (!errEl) return;
      if (q.blocked) {
        errEl.style.display = 'block';
        errEl.innerHTML = '<strong>Monthly AI limit reached</strong> — your team has used ' + q.used + ' of ' + q.cap +
          ' AI actions this month (' + q.plan + ' plan). Drafting is paused until the monthly reset. Ask your Groundwork rep about upgrading.';
        const btn = document.getElementById('gw-aifu-draft-btn');
        if (btn) { btn.disabled = true; btn.style.opacity = '.5'; btn.style.cursor = 'not-allowed'; }
      } else if (q.warn) {
        errEl.style.display = 'block';
        errEl.style.background = 'rgba(201,162,74,.1)';
        errEl.style.borderColor = 'rgba(201,162,74,.35)';
        errEl.style.color = '#8A6D2F';
        errEl.innerHTML = '<strong>Heads up:</strong> ' + q.used + ' of ' + q.cap + ' monthly AI actions used (' +
          Math.round(q.used / q.cap * 100) + '%). ' + q.remaining + ' remaining on the ' + q.plan + ' plan.';
      }
    } catch (e) { /* quota check is best-effort — never blocks the modal */ }
  }

  window.gwAiFollowupClose = function () {
    const o = document.getElementById('gw-aifu-overlay');
    if (o) o.style.display = 'none';
  };

  window.gwAiFollowupBack = function () { renderStep1(); };

  window.gwAiFollowupDraft = async function () {
    const transcript = document.getElementById('gw-aifu-transcript')?.value?.trim();
    if (!transcript) { toast('Paste the meeting transcript or notes first'); return; }
    const instructions = document.getElementById('gw-aifu-instructions')?.value?.trim() || '';
    const btn = document.getElementById('gw-aifu-draft-btn');
    if (btn) { btn.disabled = true; btn.textContent = 'Drafting… (10–30s)'; }
    try {
      const r = await fetch('/api/ai/draft-followup', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ opp_id: _state.oppId, transcript, instructions, task_id: _state.taskId }),
      });
      const j = await r.json().catch(() => ({}));
      const d = j.data || j;
      if (!r.ok || j.ok === false) throw new Error(j.message || d.message || 'AI drafting failed');
      _state.draft = d;
      _state.transcript = transcript;
      renderStep2(d);
    } catch (e) {
      toast('✗ ' + e.message, 4500);
      const errEl = document.getElementById('gw-aifu-error');
      if (errEl) { errEl.textContent = e.message; errEl.style.display = 'block'; }
      if (btn) { btn.disabled = false; btn.innerHTML = ((typeof gwIcon==='function')?gwIcon('sparkle',13):'') + ' Draft Email'; }
    }
  };

  window.gwAiFollowupCopy = function () {
    const subj = document.getElementById('gw-aifu-subject')?.value || '';
    const html = document.getElementById('gw-aifu-editor')?.innerText || '';
    navigator.clipboard.writeText('Subject: ' + subj + '\n\n' + html).then(
      () => toast('Draft copied to clipboard'),
      () => toast('Copy failed')
    );
  };

  window.gwAiFollowupSend = async function () {
    const to = document.getElementById('gw-aifu-to')?.value?.trim();
    const subject = document.getElementById('gw-aifu-subject')?.value?.trim();
    const bodyHtml = document.getElementById('gw-aifu-editor')?.innerHTML || '';
    if (!to) { toast('Add the client\'s email address'); return; }
    if (!subject) { toast('Add a subject line'); return; }
    const btn = document.getElementById('gw-aifu-send-btn');
    if (btn) { btn.disabled = true; btn.textContent = 'Sending…'; }
    try {
      // 1. Send via the rep's connected Gmail (helper exported by integrations.js)
      if (typeof window.gwAiGmailSend !== 'function') throw new Error('Gmail module not loaded — refresh the page');
      await window.gwAiGmailSend({ to, subject, body: bodyHtml });

      // 2. Log to the lead's Communications timeline
      if (_state.oppId) {
        try {
          const rep = window.getCurrentRep ? window.getCurrentRep() : null;
          await fetch(`/api/opportunities/${_state.oppId}/comms`, {
            method: 'POST', credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ repId: rep?.id || null, type: 'email', direction: 'out', subject, body: bodyHtml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 4000) }),
          });
        } catch (e) { /* non-fatal */ }
      }

      // 3. Auto-complete the task
      const doComplete = document.getElementById('gw-aifu-complete-task')?.checked;
      if (doComplete && _state.taskId && window.gwTask?.complete) {
        try { await window.gwTask.complete(_state.taskId); window._gwTaskLastCompletedAt = Date.now(); } catch (e) { /* non-fatal */ }
      }

      toast('✓ Follow-up sent' + (doComplete && _state.taskId ? ' — task completed' : ''), 4000);
      window.gwAiFollowupClose();
      // refresh any visible task lists
      try { if (typeof window.gwMyDayRefreshTasks === 'function') window.gwMyDayRefreshTasks(); } catch (e) {}
      document.dispatchEvent(new CustomEvent('gw:task-completed', { detail: { taskId: _state.taskId } }));
    } catch (e) {
      toast('✗ Send failed: ' + e.message, 5000);
      if (btn) { btn.disabled = false; btn.textContent = 'Send via Gmail →'; }
    }
  };
})();
