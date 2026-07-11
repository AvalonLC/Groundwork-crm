/**
 * Groundwork CRM — Stripe Connect Platform
 * stripe.js v20260711p49
 *
 * Features:
 *  - gwStripe() — main Stripe settings view (admin only)
 *  - Connect onboarding flow (account link redirect)
 *  - Payout dashboard (charges, balance, payouts)
 *  - Invoice payment link generation (calls /api/stripe/payment-link)
 *  - Platform fee display
 *  - gwStripePayButton(invoiceId, amount) — embeddable pay button for invoice portal
 */

(function () {
  'use strict';

  // ── Entry point ────────────────────────────────────────────────────────────
  window.gwStripe = function () {
    _stInjectCSS();
    const main = document.getElementById('main-content');
    if (!main) return;
    main.innerHTML = `<div class="st-root"><div class="st-loading">${gwIcon('loader','22','#2D7A55')} Loading Stripe settings…</div></div>`;
    _stLoad();
  };

  async function _stLoad() {
    try {
      const res = await fetch('/api/stripe/status', { credentials: 'include' });
      if (!res.ok) throw new Error('Not available');
      const data = await res.json();
      _stRender(data);
    } catch (e) {
      document.querySelector('.st-root').innerHTML = `
<div class="st-error">
  ${gwIcon('alert-circle','32','#DC2626')}
  <h3>Stripe not configured</h3>
  <p>Add your Stripe secret key as a Cloudflare Worker secret named <code>STRIPE_SECRET_KEY</code>, then redeploy.</p>
  <a class="gw-btn gw-btn-primary" href="https://dashboard.stripe.com/apikeys" target="_blank">
    ${gwIcon('external-link','14','#fff')} Get Stripe API Keys
  </a>
</div>`;
    }
  }

  function _stRender(data) {
    const { account, balance, charges, onboarded, platform_fee_pct } = data;
    const root = document.querySelector('.st-root');
    if (!root) return;

    if (!onboarded) {
      root.innerHTML = _stOnboardShell(platform_fee_pct);
      return;
    }

    root.innerHTML = _stDashShell(account, balance, charges, platform_fee_pct);
    _stLoadCharges();
  }

  // ── Onboarding shell ───────────────────────────────────────────────────────
  function _stOnboardShell(feePct) {
    return `
<div class="st-onboard">
  <div class="st-onboard-hero">
    <div class="st-onboard-icon">${gwIcon('credit-card','48','#2D7A55')}</div>
    <h2 class="st-onboard-title">Accept Payments with Stripe</h2>
    <p class="st-onboard-sub">
      Connect your Stripe account to accept credit cards on invoices and estimates.
      Groundwork charges a <strong>${feePct || 2.9}% platform fee</strong> on top of Stripe's standard processing fees.
    </p>
  </div>

  <div class="st-onboard-steps">
    <div class="st-step">
      <div class="st-step-num">1</div>
      <div>
        <div class="st-step-title">Click Connect below</div>
        <div class="st-step-sub">You'll be redirected to Stripe to create or link your account</div>
      </div>
    </div>
    <div class="st-step">
      <div class="st-step-num">2</div>
      <div>
        <div class="st-step-title">Complete Stripe verification</div>
        <div class="st-step-sub">Provide business details, bank account, and ID verification</div>
      </div>
    </div>
    <div class="st-step">
      <div class="st-step-num">3</div>
      <div>
        <div class="st-step-title">Start accepting payments</div>
        <div class="st-step-sub">Payment links appear on your invoices automatically</div>
      </div>
    </div>
  </div>

  <div class="st-onboard-fee-box">
    ${gwIcon('info','16','#0EA5E9')}
    <div>
      <strong>Fee breakdown per transaction:</strong>
      Stripe's 2.9% + 30¢ &nbsp;+&nbsp; Groundwork ${feePct || 2.9}% platform fee.
      Example: a $1,000 invoice costs ~${_stFeeEx(1000, feePct)} total in fees.
    </div>
  </div>

  <button class="gw-btn gw-btn-primary st-connect-btn" onclick="_stStartConnect()">
    ${gwIcon('zap','16','#fff')} Connect Stripe Account
  </button>

  <p class="st-onboard-note">Already have an account? Connecting will link your existing Stripe account.</p>
</div>`;
  }

  function _stFeeEx(amount, feePct) {
    const stripeFee = amount * 0.029 + 0.30;
    const platformFee = amount * ((feePct || 2.9) / 100);
    return '$' + (stripeFee + platformFee).toFixed(2);
  }

  window._stStartConnect = async function () {
    const btn = document.querySelector('.st-connect-btn');
    if (btn) { btn.disabled = true; btn.innerHTML = `${gwIcon('loader','16','#fff')} Connecting…`; }
    try {
      const res = await fetch('/api/stripe/connect', { method: 'POST', credentials: 'include' });
      const data = await res.json();
      if (data.url) {
        window.location.href = data.url;
      } else {
        throw new Error(data.error || 'No redirect URL');
      }
    } catch (e) {
      if (btn) { btn.disabled = false; btn.innerHTML = `${gwIcon('zap','16','#fff')} Connect Stripe Account`; }
      alert('Failed to start Stripe Connect: ' + e.message);
    }
  };

  // ── Connected dashboard ────────────────────────────────────────────────────
  function _stDashShell(account, balance, charges, feePct) {
    const avail  = ((balance?.available?.[0]?.amount || 0) / 100).toFixed(2);
    const pending = ((balance?.pending?.[0]?.amount  || 0) / 100).toFixed(2);
    const acctName = account?.business_profile?.name || account?.display_name || 'Connected Account';
    const chargesEnabled = account?.charges_enabled;

    return `
<div class="st-dash">
  <div class="st-dash-header">
    <div>
      <h2 class="st-dash-title">${gwIcon('credit-card','22','#2D7A55')} Stripe Payments</h2>
      <p class="st-dash-sub">${_esc(acctName)} &nbsp;·&nbsp;
        <span class="st-status-badge ${chargesEnabled ? 'st-status-active' : 'st-status-pending'}">
          ${chargesEnabled ? `${gwIcon('check-circle','12','#2D7A55')} Active` : `${gwIcon('clock','12','#F59E0B')} Pending verification`}
        </span>
      </p>
    </div>
    <button class="gw-btn gw-btn-ghost" onclick="_stOpenDashboard()">
      ${gwIcon('external-link','14','#374151')} Stripe Dashboard
    </button>
  </div>

  <!-- Balance cards -->
  <div class="st-balance-cards">
    <div class="st-bal-card">
      <div class="st-bal-label">Available Balance</div>
      <div class="st-bal-val">$${avail}</div>
      <div class="st-bal-sub">Ready to payout</div>
    </div>
    <div class="st-bal-card">
      <div class="st-bal-label">Pending Balance</div>
      <div class="st-bal-val">$${pending}</div>
      <div class="st-bal-sub">Processing (2-7 days)</div>
    </div>
    <div class="st-bal-card">
      <div class="st-bal-label">Platform Fee</div>
      <div class="st-bal-val">${feePct || 2.9}%</div>
      <div class="st-bal-sub">Groundwork platform fee</div>
    </div>
    <div class="st-bal-card">
      <div class="st-bal-label">Recent Charges</div>
      <div class="st-bal-val" id="st-charge-count">—</div>
      <div class="st-bal-sub">Last 30 days</div>
    </div>
  </div>

  <!-- Charges table -->
  <div class="st-section">
    <div class="st-section-header">
      <h3 class="st-section-title">Recent Payments</h3>
      <button class="gw-btn gw-btn-ghost st-btn-sm" onclick="_stLoadCharges()">
        ${gwIcon('refresh-cw','13','#374151')} Refresh
      </button>
    </div>
    <div id="st-charges-table">
      <div class="st-table-loading">${gwIcon('loader','18','#2D7A55')} Loading charges…</div>
    </div>
  </div>

  <!-- Settings -->
  <div class="st-section st-settings-section">
    <h3 class="st-section-title">Payment Settings</h3>
    <div class="st-settings-grid">
      <div class="st-setting-row">
        <div>
          <div class="st-setting-label">Auto-send payment link with invoice</div>
          <div class="st-setting-sub">Clients receive a Stripe payment link when invoice is marked "Sent"</div>
        </div>
        <div class="rv-toggle-switch rv-toggle-on" id="st-toggle-autolink" onclick="this.classList.toggle('rv-toggle-on')">
          <div class="rv-toggle-knob"></div>
        </div>
      </div>
      <div class="st-setting-row">
        <div>
          <div class="st-setting-label">Allow partial payments</div>
          <div class="st-setting-sub">Clients can pay less than the full invoice amount</div>
        </div>
        <div class="rv-toggle-switch" id="st-toggle-partial" onclick="this.classList.toggle('rv-toggle-on')">
          <div class="rv-toggle-knob"></div>
        </div>
      </div>
    </div>
    <div style="display:flex;gap:10px;margin-top:16px;flex-wrap:wrap">
      <button class="gw-btn gw-btn-ghost st-danger-btn" onclick="_stDisconnect()">
        ${gwIcon('unlink','14','#DC2626')} Disconnect Stripe
      </button>
    </div>
  </div>
</div>`;
  }

  window._stLoadCharges = async function () {
    const table = document.getElementById('st-charges-table');
    if (!table) return;
    table.innerHTML = `<div class="st-table-loading">${gwIcon('loader','18','#2D7A55')} Loading…</div>`;
    try {
      const res = await fetch('/api/stripe/charges', { credentials: 'include' });
      const data = await res.json();
      const charges = data.charges || [];

      // Update count card
      const countEl = document.getElementById('st-charge-count');
      if (countEl) countEl.textContent = charges.length;

      if (!charges.length) {
        table.innerHTML = `<div class="st-empty">No payments received yet. Share a payment link from any invoice.</div>`;
        return;
      }

      table.innerHTML = `
<div class="st-table-wrap">
  <table class="st-table">
    <thead>
      <tr>
        <th>Date</th><th>Client</th><th>Amount</th><th>Fee</th><th>Net</th><th>Status</th><th>Invoice</th>
      </tr>
    </thead>
    <tbody>
      ${charges.map(_stChargeRow).join('')}
    </tbody>
  </table>
</div>`;
    } catch (e) {
      table.innerHTML = `<div class="st-empty st-err">Failed to load charges. <button class="rv-link" onclick="_stLoadCharges()">Retry</button></div>`;
    }
  };

  function _stChargeRow(ch) {
    const date = ch.created ? new Date(ch.created * 1000).toLocaleDateString() : '—';
    const amount = (ch.amount / 100).toFixed(2);
    const fee    = ch.application_fee_amount ? (ch.application_fee_amount / 100).toFixed(2) : '—';
    const net    = ch.application_fee_amount ? ((ch.amount - ch.application_fee_amount) / 100).toFixed(2) : amount;
    const status = ch.status || 'unknown';
    const statusColor = { succeeded:'#2D7A55', pending:'#F59E0B', failed:'#DC2626' }[status] || '#6B7280';
    const statusBg    = { succeeded:'#F0FAF4', pending:'#FFFBEB', failed:'#FEF2F2'  }[status] || '#F3F4F6';
    const client = ch.billing_details?.name || ch.metadata?.client_name || '—';
    const invoiceId = ch.metadata?.invoice_id || '';

    return `
<tr class="st-row">
  <td>${date}</td>
  <td>${_esc(client)}</td>
  <td><strong>$${amount}</strong></td>
  <td style="color:#6B7280">$${fee}</td>
  <td style="color:#2D7A55"><strong>$${net}</strong></td>
  <td><span class="rv-badge" style="color:${statusColor};background:${statusBg}">${status}</span></td>
  <td>${invoiceId ? `<button class="rv-link" onclick="show('invoices','${_esc(invoiceId)}')">#${_esc(invoiceId).slice(-6)}</button>` : '—'}</td>
</tr>`;
  }

  window._stOpenDashboard = function () {
    window.open('https://dashboard.stripe.com', '_blank');
  };

  window._stDisconnect = async function () {
    if (!confirm('Disconnect your Stripe account? Payment links will stop working on existing invoices.')) return;
    try {
      const res = await fetch('/api/stripe/disconnect', { method: 'POST', credentials: 'include' });
      if (!res.ok) throw new Error('Failed');
      showToast('Stripe account disconnected', 'info');
      _stLoad();
    } catch (e) {
      alert('Disconnect failed: ' + e.message);
    }
  };

  // ── Payment link generator (called from invoices.js) ──────────────────────
  /**
   * gwStripePaymentLink(invoiceId, amountCents, clientEmail)
   * Returns { url } or throws.
   * Called from invoices.js "Send Payment Link" button.
   */
  window.gwStripePaymentLink = async function (invoiceId, amountCents, clientEmail) {
    const res = await fetch('/api/stripe/payment-link', {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ invoice_id: invoiceId, amount: amountCents, client_email: clientEmail }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || 'Payment link failed');
    }
    return await res.json();
  };

  // ── Pay button widget (used in invoice portal) ────────────────────────────
  /**
   * gwStripePayButton(containerId, invoiceId, amountDollars, clientEmail)
   * Renders a "Pay Now" button into container. On click, generates payment link
   * and redirects to Stripe Checkout.
   */
  window.gwStripePayButton = function (containerId, invoiceId, amountDollars, clientEmail) {
    const el = document.getElementById(containerId);
    if (!el) return;
    el.innerHTML = `
<button class="st-pay-btn" onclick="_stDoPayNow('${_esc(invoiceId)}',${amountDollars},'${_esc(clientEmail || '')}')">
  ${gwIcon('credit-card','18','#fff')}
  Pay $${Number(amountDollars).toFixed(2)} Now
</button>
<div class="st-pay-secure">${gwIcon('lock','12','#9CA3AF')} Secured by Stripe · No card data stored by Groundwork</div>`;
  };

  window._stDoPayNow = async function (invoiceId, amountDollars, clientEmail) {
    const btn = document.querySelector('.st-pay-btn');
    if (btn) { btn.disabled = true; btn.innerHTML = `${gwIcon('loader','18','#fff')} Generating link…`; }
    try {
      const amountCents = Math.round(amountDollars * 100);
      const data = await window.gwStripePaymentLink(invoiceId, amountCents, clientEmail);
      if (data.url) {
        window.location.href = data.url;
      } else {
        throw new Error('No payment URL returned');
      }
    } catch (e) {
      if (btn) { btn.disabled = false; btn.innerHTML = `${gwIcon('credit-card','18','#fff')} Pay $${Number(amountDollars).toFixed(2)} Now`; }
      alert('Payment failed to start: ' + e.message);
    }
  };

  // ── Utilities ──────────────────────────────────────────────────────────────
  function _esc(s) {
    if (!s) return '';
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  // ── CSS ────────────────────────────────────────────────────────────────────
  function _stInjectCSS() {
    if (document.getElementById('st-styles')) return;
    const style = document.createElement('style');
    style.id = 'st-styles';
    style.textContent = `
/* Root */
.st-root { padding:24px;max-width:1100px;margin:0 auto; }
.st-loading { display:flex;align-items:center;gap:10px;color:#6B7280;padding:60px 0;justify-content:center;font-size:15px; }
.st-error { text-align:center;padding:60px 20px;color:#6B7280; }
.st-error h3 { font-size:20px;font-weight:700;color:#111827;margin:16px 0 8px; }
.st-error p { font-size:14px;margin-bottom:20px;line-height:1.6; }
.st-error code { background:#F3F4F6;padding:2px 6px;border-radius:4px;font-size:13px; }

/* Onboarding */
.st-onboard { max-width:640px;margin:0 auto;padding:20px 0; }
.st-onboard-hero { text-align:center;padding:32px 0 24px; }
.st-onboard-icon { width:80px;height:80px;background:#F0FAF4;border-radius:20px;display:flex;align-items:center;justify-content:center;margin:0 auto 20px; }
.st-onboard-title { font-size:26px;font-weight:800;color:#111827;margin:0 0 12px; }
.st-onboard-sub { font-size:15px;color:#6B7280;line-height:1.7;margin:0; }
.st-onboard-steps { display:flex;flex-direction:column;gap:16px;margin:28px 0; }
.st-step { display:flex;align-items:flex-start;gap:14px;background:#fff;border:1px solid #E5E7EB;border-radius:12px;padding:16px; }
.st-step-num { width:28px;height:28px;background:#2D7A55;color:#fff;border-radius:50%;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:13px;flex-shrink:0;margin-top:1px; }
.st-step-title { font-size:14px;font-weight:600;color:#111827;margin-bottom:3px; }
.st-step-sub { font-size:13px;color:#6B7280; }
.st-onboard-fee-box { display:flex;align-items:flex-start;gap:10px;background:#EFF6FF;border:1px solid #BFDBFE;border-radius:10px;padding:14px 16px;font-size:13px;color:#1E40AF;line-height:1.5;margin-bottom:24px; }
.st-connect-btn { width:100%;justify-content:center;padding:14px;font-size:15px; }
.st-onboard-note { text-align:center;font-size:12px;color:#9CA3AF;margin-top:12px; }

/* Dashboard */
.st-dash { display:flex;flex-direction:column;gap:24px; }
.st-dash-header { display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:12px; }
.st-dash-title { font-size:22px;font-weight:700;color:#111827;display:flex;align-items:center;gap:8px;margin:0 0 4px; }
.st-dash-sub { color:#6B7280;font-size:14px;margin:0;display:flex;align-items:center;gap:6px; }
.st-status-badge { display:inline-flex;align-items:center;gap:4px;font-size:12px;font-weight:600;padding:2px 10px;border-radius:99px; }
.st-status-active  { color:#2D7A55;background:#F0FAF4;border:1px solid #BBF7D0; }
.st-status-pending { color:#92400E;background:#FFFBEB;border:1px solid #FDE68A; }

/* Balance cards */
.st-balance-cards { display:grid;grid-template-columns:repeat(4,1fr);gap:16px; }
.st-bal-card { background:#fff;border:1px solid #E5E7EB;border-radius:12px;padding:18px; }
.st-bal-label { font-size:12px;color:#6B7280;font-weight:500;margin-bottom:6px; }
.st-bal-val { font-size:26px;font-weight:800;color:#111827; }
.st-bal-sub { font-size:11px;color:#9CA3AF;margin-top:4px; }

/* Section */
.st-section { background:#fff;border:1px solid #E5E7EB;border-radius:12px;padding:20px; }
.st-section-header { display:flex;justify-content:space-between;align-items:center;margin-bottom:16px; }
.st-section-title { font-size:15px;font-weight:700;color:#111827;margin:0; }
.st-btn-sm { padding:6px 12px;font-size:12px; }
.st-table-loading { display:flex;align-items:center;gap:8px;color:#6B7280;padding:24px;justify-content:center; }
.st-empty { text-align:center;color:#9CA3AF;padding:28px;font-size:14px; }
.st-err { color:#DC2626; }

/* Table */
.st-table-wrap { overflow-x:auto;border:1px solid #E5E7EB;border-radius:8px; }
.st-table { width:100%;border-collapse:collapse; }
.st-table th { padding:10px 14px;text-align:left;font-size:12px;font-weight:600;color:#6B7280;border-bottom:1px solid #E5E7EB;background:#F9FAFB; }
.st-table td { padding:11px 14px;font-size:14px;color:#374151;border-bottom:1px solid #F3F4F6; }
.st-row:last-child td { border-bottom:none; }
.st-row:hover { background:#FAFAFA; }

/* Settings */
.st-settings-section { margin-top:0; }
.st-settings-grid { display:flex;flex-direction:column;gap:16px; }
.st-setting-row { display:flex;justify-content:space-between;align-items:center;gap:16px;padding:14px 0;border-bottom:1px solid #F3F4F6; }
.st-setting-row:last-child { border-bottom:none; }
.st-setting-label { font-size:14px;font-weight:500;color:#111827;margin-bottom:3px; }
.st-setting-sub { font-size:12px;color:#6B7280; }
.st-danger-btn { color:#DC2626!important;border-color:#FECACA!important; }
.st-danger-btn:hover { background:#FEF2F2!important; }

/* Pay button widget */
.st-pay-btn { display:flex;align-items:center;justify-content:center;gap:10px;width:100%;padding:16px;background:#2D7A55;color:#fff;border:none;border-radius:12px;font-size:16px;font-weight:700;cursor:pointer;transition:.15s; }
.st-pay-btn:hover { background:#1F5C3F; }
.st-pay-btn:disabled { background:#9CA3AF;cursor:not-allowed; }
.st-pay-secure { display:flex;align-items:center;justify-content:center;gap:5px;font-size:11px;color:#9CA3AF;margin-top:8px; }

/* Responsive */
@media(max-width:768px) {
  .st-balance-cards { grid-template-columns:repeat(2,1fr); }
  .st-root { padding:16px; }
}
@media(max-width:480px) {
  .st-balance-cards { grid-template-columns:1fr 1fr; }
}
`;
    document.head.appendChild(style);
  }

  console.log('[Groundwork] stripe.js loaded v20260711p49');
})();
