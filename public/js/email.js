/**
 * Groundwork CRM — Email Composer
 * email.js v20260711p50
 *
 * Features:
 *  - gwEmailComposer(opts) — modal composer for any email type
 *  - gwSendEstimateEmail(estimateId) — pre-filled estimate delivery
 *  - gwSendInvoiceEmail(invoiceId) — pre-filled invoice delivery
 *  - gwSendCustomEmail(clientId) — blank composer to any client
 *  - Template variables: {{client_name}}, {{company_name}}, {{amount}}, {{link}}
 *  - Sends via POST /api/email/send → server uses SendGrid
 *  - Graceful fallback if SendGrid not configured (shows mailto: link)
 */

(function () {
  'use strict';

  // ── Email templates ────────────────────────────────────────────────────────
  const _TEMPLATES = {
    estimate: {
      subject: 'Your Estimate from {{company_name}} — #{{number}}',
      body: `Hi {{client_name}},\n\nThank you for the opportunity to work with you! Please find your estimate (#{{number}}) for {{project}} attached below.\n\nTotal: {{amount}}\n\nYou can review and approve your estimate online:\n{{link}}\n\nThis estimate is valid for 30 days. If you have any questions or would like to make changes, just reply to this email.\n\nLooking forward to working with you!\n\n{{company_name}}`,
    },
    invoice: {
      subject: 'Invoice #{{number}} from {{company_name}} — Due {{due_date}}',
      body: `Hi {{client_name}},\n\nPlease find your invoice (#{{number}}) for {{project}} ready for payment.\n\nAmount Due: {{amount}}\nDue Date: {{due_date}}\n{{deposit}}\nPay securely online:\n{{link}}\n\nIf you have any questions about this invoice, please don't hesitate to reach out.\n\nThank you for your business!\n\n{{company_name}}`,
    },
    custom: {
      subject: '',
      body: '',
    },
    review: {
      subject: 'How did we do? — {{company_name}}',
      body: `Hi {{client_name}},\n\nThank you for choosing {{company_name}}! We hope you're happy with the work we completed.\n\nIf you have a moment, we'd really appreciate a quick review. It helps us grow and helps other homeowners find us:\n\n{{link}}\n\nThanks so much — we look forward to working with you again!\n\n{{company_name}}`,
    },
    followup: {
      subject: 'Following up — {{company_name}}',
      body: `Hi {{client_name}},\n\nJust wanted to follow up on our recent conversation. We'd love to help you with {{project}}.\n\nIf you're ready to move forward or have any questions, just reply here or give us a call.\n\nLooking forward to hearing from you!\n\n{{company_name}}`,
    },
  };

  // ── State ──────────────────────────────────────────────────────────────────
  let _emOverlay = null;
  let _emSending = false;

  // ── Main entry point ───────────────────────────────────────────────────────
  /**
   * gwEmailComposer(opts)
   * opts: {
   *   type: 'estimate'|'invoice'|'custom'|'review'|'followup',
   *   toEmail, toName, clientId,
   *   subject, body,           // override template
   *   entityId,                // estimate/invoice id
   *   entityNumber,            // #EST-001 etc.
   *   amount, dueDate, project,
   *   portalLink,              // pre-built link for estimate/invoice portal
   *   onSent,                  // callback after successful send
   * }
   */
  /**
   * The composer's on-sent callback.
   *
   * Held here rather than passed through the Send button's onclick, which is
   * what it used to do:
   *
   *     onclick="_emSend('id','type',${JSON.stringify(opts.onSent||null)...})"
   *
   * JSON.stringify of a FUNCTION returns undefined, so .replace() on it threw —
   * every single time a caller supplied onSent, which all of them do. The
   * callers wrapped the composer in try/catch, so the throw was swallowed and
   * the catch re-opened the composer with no variables at all. That is where
   * "Invoice #inv_1787326690151_y55vjn ... Hi , Amount Due: Due Date:" came
   * from: not a missing invoice, a serialisation error two layers away.
   *
   * _emSend already checked `typeof onSentStr === 'function'`, which could never
   * be true for a value that arrived through an HTML attribute.
   */
  let _emOnSent = null;

  window.gwEmailComposer = function (opts = {}) {
    _emInjectCSS();
    _emCloseOverlay();
    _emOnSent = typeof opts.onSent === 'function' ? opts.onSent : null;

    const type = opts.type || 'custom';
    const tmpl = _TEMPLATES[type] || _TEMPLATES.custom;

    // Merge vars into template
    const vars = {
      client_name:  opts.toName    || '',
      company_name: _emGetCompany(),
      // Deliberately NOT falling back to opts.entityId. A row id
      // (inv_1787326690151_y55vjn) is not an invoice number, and putting one in
      // a customer's subject line is how "Invoice #inv_1787326690151_y55vjn"
      // reached a send button. Callers that cannot supply a real number should
      // refuse to compose — see gwSendInvoiceEmail.
      number:       opts.entityNumber || '',
      amount:       opts.amount    || '',
      due_date:     opts.dueDate   || '',
      project:      opts.project   || 'your project',
      // Empty for most invoices, so the template's line collapses to nothing
      // rather than leaving a stray blank where a sentence should be.
      deposit:      opts.deposit ? opts.deposit + '\n' : '',
      link:         opts.portalLink || '',   // never fall back to the bare domain
    };

    const subject = _emFill(opts.subject || tmpl.subject, vars);
    const body    = _emFill(opts.body    || tmpl.body,    vars);

    const typeLabels = { estimate:'Estimate', invoice:'Invoice', review:'Review Request', followup:'Follow-Up', custom:'Email' };

    const overlay = document.createElement('div');
    overlay.className = 'em-overlay';
    overlay.innerHTML = `
<div class="em-modal">
  <div class="em-header">
    <h3 class="em-title">${gwIcon('mail','18','#2D7A55')} Send ${typeLabels[type] || 'Email'}</h3>
    <button class="em-close" onclick="window._emClose()">${gwIcon('x','18','#6B7280')}</button>
  </div>
  <div class="em-body">
    <!-- To -->
    <div class="em-field-row">
      <label class="em-label">To</label>
      <input id="em-to-email" class="em-input" type="email" placeholder="client@email.com"
        value="${_esc(opts.toEmail || '')}">
    </div>
    <!-- Subject -->
    <div class="em-field-row">
      <label class="em-label">Subject</label>
      <input id="em-subject" class="em-input" type="text" value="${_esc(subject)}"
        placeholder="Email subject…">
    </div>
    <!-- Template picker -->
    <div class="em-field-row">
      <label class="em-label">Template</label>
      <select id="em-template-sel" class="em-select" onchange="_emApplyTemplate(this.value,'${_esc(JSON.stringify(vars))}')">
        <option value="custom"   ${type==='custom'   ?'selected':''}>Custom (blank)</option>
        <option value="estimate" ${type==='estimate' ?'selected':''}>Estimate delivery</option>
        <option value="invoice"  ${type==='invoice'  ?'selected':''}>Invoice delivery</option>
        <option value="review"   ${type==='review'   ?'selected':''}>Review request</option>
        <option value="followup" ${type==='followup' ?'selected':''}>Follow-up</option>
      </select>
    </div>
    <!-- Body -->
    <div class="em-field-row em-field-body">
      <label class="em-label">Message</label>
      <textarea id="em-body" class="em-textarea" rows="10" placeholder="Write your message…">${_esc(body)}</textarea>
    </div>
    <!-- Portal link (if provided) -->
    ${opts.portalLink ? `
    <div class="em-portal-link-row">
      ${gwIcon('external-link','13','#2D7A55')}
      <span>Portal link included:</span>
      <a href="${_esc(opts.portalLink)}" target="_blank" class="em-portal-link">${_esc(opts.portalLink)}</a>
    </div>` : ''}
    <!-- Error -->
    <div id="em-error" class="em-error" style="display:none"></div>
    <!-- SendGrid notice -->
    <div id="em-sgnotice" class="em-notice" style="display:none">
      ${gwIcon('alert-circle','13','#F59E0B')}
      SendGrid not configured — email will open in your mail client instead.
    </div>
  </div>
  <div class="em-footer">
    <button class="gw-btn gw-btn-ghost" onclick="window._emClose()">Cancel</button>
    <button class="gw-btn gw-btn-ghost" onclick="_emOpenMailto()">
      ${gwIcon('external-link','13','#374151')} Open in Mail
    </button>
    <button class="gw-btn gw-btn-primary" id="em-send-btn" onclick="window._emSend('${_esc(opts.entityId||'')}','${type}')">
      ${gwIcon('send','14','#fff')} Send Email
    </button>
  </div>
</div>`;

    overlay.addEventListener('click', e => { if (e.target === overlay) window._emClose(); });
    document.body.appendChild(overlay);
    _emOverlay = overlay;
    requestAnimationFrame(() => overlay.classList.add('em-overlay-visible'));

    // Check if SendGrid is available
    fetch('/api/email/status', { credentials: 'include' })
      .then(r => r.json())
      .then(d => {
        const notice = document.getElementById('em-sgnotice');
        if (notice && !d.configured) notice.style.display = 'flex';
      }).catch(() => {});
  };

  window._emClose = function () { _emCloseOverlay(); };

  function _emCloseOverlay() {
    if (_emOverlay) { _emOverlay.remove(); _emOverlay = null; }
  }

  window._emApplyTemplate = function (type, varsJson) {
    const vars = JSON.parse(varsJson.replace(/&quot;/g, '"'));
    const tmpl = _TEMPLATES[type] || _TEMPLATES.custom;
    const subjectEl = document.getElementById('em-subject');
    const bodyEl    = document.getElementById('em-body');
    if (subjectEl) subjectEl.value = _emFill(tmpl.subject, vars);
    if (bodyEl)    bodyEl.value    = _emFill(tmpl.body,    vars);
  };

  window._emSend = async function (entityId, type) {
    if (_emSending) return;
    const toEmail = document.getElementById('em-to-email')?.value.trim();
    const subject = document.getElementById('em-subject')?.value.trim();
    const body    = document.getElementById('em-body')?.value.trim();
    const errEl   = document.getElementById('em-error');
    const btn     = document.getElementById('em-send-btn');

    if (!toEmail || !subject || !body) {
      if (errEl) { errEl.textContent = 'To, Subject, and Message are required.'; errEl.style.display='flex'; }
      return;
    }
    if (errEl) errEl.style.display = 'none';

    _emSending = true;
    const origHTML = btn?.innerHTML;
    if (btn) btn.innerHTML = `${gwIcon('loader','14','#fff')} Sending…`;

    try {
      const res = await fetch('/api/email/send', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ to_email: toEmail, subject, body, entity_type: type, entity_id: entityId }),
      });
      const data = await res.json();

      if (data.fallback) {
        // SendGrid not configured — open mailto
        _emOpenMailto();
        _emCloseOverlay();
      } else if (!res.ok) {
        throw new Error(data.error || 'Send failed');
      } else {
        if (typeof showToast === 'function') showToast('Email sent!', 'success');
        _emCloseOverlay();
        if (typeof _emOnSent === 'function') _emOnSent();
      }
    } catch (e) {
      if (errEl) { errEl.textContent = e.message; errEl.style.display = 'flex'; }
      if (btn) btn.innerHTML = origHTML;
    } finally {
      _emSending = false;
    }
  };

  window._emOpenMailto = function () {
    const toEmail = document.getElementById('em-to-email')?.value.trim() || '';
    const subject = encodeURIComponent(document.getElementById('em-subject')?.value.trim() || '');
    const body    = encodeURIComponent(document.getElementById('em-body')?.value.trim() || '');
    window.open(`mailto:${toEmail}?subject=${subject}&body=${body}`, '_blank');
  };

  // ── Convenience wrappers ───────────────────────────────────────────────────
  window.gwSendEstimateEmail = async function (estimateId) {
    // Fetch estimate data then open composer
    try {
      const res = await fetch(`/api/estimates/${estimateId}`, { credentials: 'include' });
      const raw = await res.json();
      const est = raw.data || raw;   // API returns { ok, data } — unwrap
      const client = est.client_name || est.clientName || '';
      const email  = est.client_email || est.clientEmail || '';
      const num    = est.est_number || est.estimate_number || est.number || estimateId;
      const totalVal = est.total != null ? est.total : est.total_price;
      const amount = totalVal != null ? '$' + Number(totalVal).toLocaleString() : '';
      const project = est.title || est.project_name || est.projectName || est.service_type || '';
      const portalLink = est.portal_token
        ? `${window.location.origin}/estimates/portal/${est.portal_token}`
        : '';
      window.gwEmailComposer({
        type: 'estimate', toEmail: email, toName: client,
        entityId: estimateId, entityNumber: num,
        amount, project, portalLink,
        onSent: () => { if (typeof _estLoadList === 'function') _estLoadList(); },
      });
    } catch (e) {
      window.gwEmailComposer({ type: 'estimate', entityId: estimateId });
    }
  };

  window.gwSendInvoiceEmail = async function (invoiceId) {
    // This used to fall back to gwEmailComposer({type:'invoice', entityId}) on
    // ANY failure, and that is where the broken email came from. With no other
    // vars, {{number}} fell through to the raw row id and every other
    // placeholder resolved to '', producing a composer pre-filled with
    //
    //     Invoice #inv_1787326690151_y55vjn from Avalon Landscape ... - Due
    //     Hi ,        Amount Due:        Due Date:        Pay securely online:
    //
    // and a live Send button. A degraded email is worse than no email: nothing
    // about it looks broken enough to stop somebody sending it to a customer.
    let res;
    try {
      res = await fetch(`/api/invoices/${invoiceId}`, { credentials: 'include' });
    } catch (e) {
      return _emFail('Could not reach the server to load this invoice.');
    }
    // res.ok was never checked, and a 404 body still parses as JSON — so a
    // deleted invoice, or one belonging to another company, produced the blank
    // template above rather than an error.
    if (!res.ok) {
      return _emFail(res.status === 404
        ? 'That invoice no longer exists. Refresh the list and try again.'
        : 'Could not load the invoice (' + res.status + ').');
    }
    let inv;
    try { inv = await res.json(); }
    catch (e) { return _emFail('The server sent back something unreadable for this invoice.'); }

    const client = inv.client_name || '';
    const email  = inv.client_email || '';
    const num    = inv.invoice_number || '';
    // Balance, not total: on a partially paid invoice the total is not what is
    // owed, and "Amount Due" has to mean the amount due.
    const amount = inv.balance_due != null ? _emMoney(inv.balance_due)
                 : inv.total != null ? _emMoney(inv.total)
                 : inv.amount_total != null ? _emMoney(inv.amount_total) : '';
    // Date-only strings parse as UTC. The same off-by-one that made the list
    // read "-1d ago" would print the wrong due date to the customer.
    const dueDate = inv.due_date
      ? new Date(inv.due_date + (String(inv.due_date).includes('T') ? '' : 'T00:00:00')).toLocaleDateString()
      : '';
    const project = inv.title || inv.description || inv.line_items?.[0]?.description || '';
    const portalLink = inv.portal_token
      ? window.location.origin + '/invoices/portal/' + inv.portal_token
      : '';

    // The number is what the customer quotes back at you; the link is the only
    // reason the email exists. Missing either means it is not sendable — refuse,
    // rather than papering over it with a row id and an empty line.
    if (!num) return _emFail('This invoice has no invoice number yet, so it cannot be emailed.');
    if (!portalLink) return _emFail('This invoice has no payment link yet, so there would be nothing for the client to pay.');

    // A deposit is requested on the ESTIMATE (estimates.deposit_amt_cents, 0058);
    // an invoice raised from one inherits it. Somebody who was asked for a
    // deposit needs telling the deposit figure, not just the full balance.
    const depositDue = Number(inv.deposit_due);
    const deposit = Number.isFinite(depositDue) && depositDue > 0
      ? 'A deposit of ' + _emMoney(depositDue) + ' is due before work begins.'
      : '';

    window.gwEmailComposer({
      type: 'invoice', toEmail: email, toName: client,
      entityId: invoiceId, entityNumber: num,
      amount, dueDate, project, portalLink, deposit,
      onSent: function () { if (typeof _invLoadList === 'function') _invLoadList(); },
    });
  };

  /** Say what went wrong rather than opening a composer full of blanks. */
  function _emFail(msg) {
    if (typeof showToast === 'function') showToast(msg, 'error');
    else alert(msg);
    return null;
  }

  function _emMoney(v) {
    const n = Number(v);
    if (!Number.isFinite(n)) return '';
    return n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
  }

  window.gwSendCustomEmail = function (clientId, clientName, clientEmail) {
    window.gwEmailComposer({
      type: 'custom', toEmail: clientEmail || '', toName: clientName || '',
      clientId,
    });
  };

  window.gwSendReviewEmail = function (clientName, clientEmail, reviewLink) {
    window.gwEmailComposer({
      type: 'review', toEmail: clientEmail || '', toName: clientName || '',
      portalLink: reviewLink || '',
    });
  };

  // ── Helpers ────────────────────────────────────────────────────────────────
  function _emFill(tmpl, vars) {
    if (!tmpl) return '';
    return tmpl.replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] || '');
  }

  function _emGetCompany() {
    // Real company name, set by the bootstrap from D1 (window._companyName).
    if (window._companyName) return window._companyName;
    // Fall back to the header company chip (top bar shows the tenant name).
    const kicker = document.getElementById('brandKicker');
    if (kicker && kicker.textContent && kicker.textContent.trim()) return kicker.textContent.trim();
    return 'Groundwork Services';
  }

  function _esc(s) {
    if (!s) return '';
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  // ── CSS ────────────────────────────────────────────────────────────────────
  function _emInjectCSS() {
    if (document.getElementById('em-styles')) return;
    const s = document.createElement('style');
    s.id = 'em-styles';
    s.textContent = `
.em-overlay { position:fixed;inset:0;background:rgba(0,0,0,.48);z-index:9995;display:flex;align-items:center;justify-content:center;opacity:0;transition:.2s; }
.em-overlay-visible { opacity:1; }
.em-modal { background:#fff;border-radius:16px;width:600px;max-width:96vw;max-height:92vh;display:flex;flex-direction:column;box-shadow:0 24px 64px rgba(0,0,0,.22); }
.em-header { display:flex;justify-content:space-between;align-items:center;padding:18px 22px 14px;border-bottom:1px solid #E5E7EB; }
.em-title { font-size:17px;font-weight:700;color:#111827;margin:0;display:flex;align-items:center;gap:8px; }
.em-close { background:none;border:none;cursor:pointer;padding:4px;border-radius:6px;color:#6B7280;line-height:1; }
.em-close:hover { background:#F3F4F6; }
.em-body { padding:18px 22px;overflow-y:auto;flex:1;display:flex;flex-direction:column;gap:12px; }
.em-field-row { display:flex;flex-direction:column;gap:4px; }
.em-field-body { flex:1; }
.em-label { font-size:12px;font-weight:600;color:#6B7280;text-transform:uppercase;letter-spacing:.04em; }
.em-input,.em-select { padding:9px 12px;border:1px solid #D1D5DB;border-radius:8px;font-size:14px;color:#111827;background:#fff;transition:.15s;width:100%;box-sizing:border-box; }
.em-input:focus,.em-select:focus,.em-textarea:focus { outline:none;border-color:#2D7A55;box-shadow:0 0 0 3px #D1FAE5; }
.em-textarea { padding:9px 12px;border:1px solid #D1D5DB;border-radius:8px;font-size:14px;color:#111827;resize:vertical;font-family:inherit;line-height:1.6;width:100%;box-sizing:border-box;min-height:180px; }
.em-portal-link-row { display:flex;align-items:center;gap:6px;font-size:12px;color:#6B7280;background:#F0FAF4;border:1px solid #BBF7D0;border-radius:8px;padding:8px 12px; }
.em-portal-link { color:#2D7A55;text-decoration:none;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:300px; }
.em-portal-link:hover { text-decoration:underline; }
.em-error { display:flex;align-items:center;gap:6px;color:#DC2626;font-size:13px;background:#FEF2F2;border-radius:6px;padding:8px 12px; }
.em-notice { display:flex;align-items:center;gap:6px;color:#92400E;font-size:12px;background:#FFFBEB;border:1px solid #FDE68A;border-radius:6px;padding:8px 12px; }
.em-footer { padding:14px 22px;border-top:1px solid #E5E7EB;display:flex;justify-content:flex-end;gap:8px; }
@media(max-width:640px) { .em-modal { width:100%;max-width:100vw;border-radius:16px 16px 0 0;position:fixed;bottom:0;max-height:85vh; } .em-overlay { align-items:flex-end; } }
`;
    document.head.appendChild(s);
  }

  console.log('[Groundwork] email.js loaded v20260711p50');
})();
