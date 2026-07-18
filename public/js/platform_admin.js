/**
 * platform_admin.js — Groundwork CRM Internal Operations Platform
 * ═══════════════════════════════════════════════════════════════════
 * Full internal system for the Groundwork CRM team to:
 *  - Manage all customer tenants (companies using the software)
 *  - Run their own sales pipeline (selling Groundwork CRM to prospects)
 *  - Handle support tickets and bug reports from customers
 *  - Post announcements / release notes to all tenants
 *  - View billing and plan information
 *  - Configure global platform settings
 *
 * Loaded after app_premium.js. Registers itself as window.gwPlatformAdmin.
 */

(function () {
  'use strict';

  // ── Helpers ──────────────────────────────────────────────────────────────
  const view   = () => document.getElementById('view');
  const esc    = s  => String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  const fmt    = n  => (n ?? 0).toLocaleString();
  const fmtMoney = n => '$' + (n ?? 0).toLocaleString('en-US', {minimumFractionDigits:0, maximumFractionDigits:0});
  const ago    = d  => {
    if (!d) return '—';
    const ms = Date.now() - new Date(d).getTime();
    const min = Math.floor(ms/60000), hr = Math.floor(ms/3600000), day = Math.floor(ms/86400000);
    if (min < 2) return 'just now';
    if (min < 60) return min + 'm ago';
    if (hr < 24) return hr + 'h ago';
    if (day < 30) return day + 'd ago';
    return new Date(d).toLocaleDateString('en-US',{month:'short',day:'numeric'});
  };
  const dateStr = d => d ? new Date(d).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'}) : '—';
  const gwI = (name,sz,col) => (typeof gwIcon === 'function') ? gwIcon(name,sz||16,col||'currentColor') : '';

  const PLAN_COLORS = { trial:'#8B6914', starter:'#1A4740', core:'#4D8A86', growth:'#2D7A55', pro:'#7B5EA7', enterprise:'#B8860B', churned:'#C97B6A' };
  const STAGE_COLORS = { prospect:'#6F7E6A', qualified:'#4D8A86', demo:'#8B6914', proposal:'#1A4740', negotiation:'#7B5EA7', closed_won:'#2D7A55', closed_lost:'#C97B6A' };
  const PRIORITY_COLORS = { low:'#6F7E6A', medium:'#8B6914', high:'#C97B6A', urgent:'#B03E30' };
  const TICKET_STATUS_COLORS = { open:'#C97B6A', 'in_progress':'#8B6914', waiting:'#4D8A86', resolved:'#2D7A55', closed:'#6F7E6A' };

  const planBadge = p => {
    const c = PLAN_COLORS[p] || '#6F7E6A';
    return `<span style="display:inline-block;background:${c}22;color:${c};border:1px solid ${c}44;font-size:10px;font-weight:700;padding:2px 8px;border-radius:10px;letter-spacing:.05em;text-transform:uppercase">${esc(p||'free')}</span>`;
  };
  const stageBadge = s => {
    const c = STAGE_COLORS[s] || '#6F7E6A';
    const label = (s||'').replace(/_/g,' ').replace(/\b\w/g,l=>l.toUpperCase());
    return `<span style="display:inline-block;background:${c}22;color:${c};border:1px solid ${c}44;font-size:10px;font-weight:700;padding:2px 8px;border-radius:10px;letter-spacing:.04em">${esc(label)}</span>`;
  };
  const priorityBadge = p => {
    const c = PRIORITY_COLORS[p] || '#6F7E6A';
    return `<span style="display:inline-block;background:${c}22;color:${c};border:1px solid ${c}44;font-size:10px;font-weight:700;padding:2px 7px;border-radius:8px;text-transform:uppercase;letter-spacing:.05em">${esc(p||'—')}</span>`;
  };
  const ticketStatusBadge = s => {
    const c = TICKET_STATUS_COLORS[s] || '#6F7E6A';
    const label = (s||'').replace(/_/g,' ').replace(/\b\w/g,l=>l.toUpperCase());
    return `<span style="display:inline-block;background:${c}22;color:${c};border:1px solid ${c}44;font-size:10px;font-weight:700;padding:2px 8px;border-radius:10px;text-transform:uppercase">${esc(label)}</span>`;
  };

  // ── Shared page shell (full-width premium layout) ───────────────────────
  function shell(title, subtitle, breadcrumb, actionHtml, bodyHtml) {
    return `
<div class="gw-pa-shell" style="width:100%;box-sizing:border-box;padding:0 0 56px">
  <!-- Premium page header band (full-width within view) -->
  <div style="background:linear-gradient(135deg,#0E372F 0%,#1A4740 48%,#2A5D57 100%);border:1px solid rgba(77,138,134,.35);border-radius:20px;padding:26px clamp(20px,2.5vw,36px);margin-bottom:26px;position:relative;overflow:hidden;box-shadow:0 14px 40px -18px rgba(14,55,47,.55)">
    <div style="position:absolute;inset:auto -80px -120px auto;width:320px;height:320px;border-radius:50%;background:radial-gradient(circle,rgba(77,138,134,.35),transparent 65%);pointer-events:none"></div>
    <div style="position:absolute;top:0;left:0;width:100%;height:2px;background:linear-gradient(90deg,#4D8A86,transparent 70%)"></div>
    <div style="display:flex;align-items:flex-end;justify-content:space-between;gap:16px;flex-wrap:wrap;position:relative;z-index:1">
      <div style="min-width:0">
        <div style="display:flex;align-items:center;gap:8px;font-size:11px;color:#7FB5B0;font-weight:800;text-transform:uppercase;letter-spacing:.14em;margin-bottom:8px">
          <span style="width:20px;height:2px;background:#4D8A86;border-radius:2px;display:inline-block"></span>${esc(breadcrumb)}
        </div>
        <h1 style="font-size:clamp(24px,2.4vw,32px);font-weight:900;color:#F2EFE6;margin:0 0 6px;letter-spacing:-.025em;line-height:1.1">${title}</h1>
        ${subtitle ? `<p style="color:#A8BCB0;margin:0;font-size:14px;max-width:760px">${subtitle}</p>` : ''}
      </div>
      ${actionHtml ? `<div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center">${actionHtml}</div>` : ''}
    </div>
  </div>
  ${bodyHtml}
</div>`;
  }

  function statCard(label, value, icon, color, sub) {
    return `
<div class="gw-pa-stat" style="background:linear-gradient(160deg,var(--card,#fff) 0%,var(--card,#fff) 60%,${color}0d 100%);border:1px solid ${color}30;border-radius:16px;padding:22px;position:relative;overflow:hidden;transition:transform .18s ease,box-shadow .18s ease,border-color .18s ease" onmouseover="this.style.transform='translateY(-2px)';this.style.boxShadow='0 10px 28px -12px ${color}55';this.style.borderColor='${color}66'" onmouseout="this.style.transform='';this.style.boxShadow='';this.style.borderColor='${color}30'">
  <div style="position:absolute;top:-14px;right:-10px;opacity:.10;font-size:64px;pointer-events:none">${icon}</div>
  <div style="position:absolute;top:0;left:0;width:100%;height:3px;background:linear-gradient(90deg,${color},transparent)"></div>
  <div style="font-size:clamp(26px,2vw,34px);font-weight:900;color:${color};margin-bottom:4px;letter-spacing:-.02em;font-variant-numeric:tabular-nums">${value}</div>
  <div style="font-size:11px;color:#6F7E6A;font-weight:800;text-transform:uppercase;letter-spacing:.08em">${esc(label)}</div>
  ${sub ? `<div style="font-size:11px;color:#5C6B58;margin-top:7px">${sub}</div>` : ''}
</div>`;
  }

  function panel(title, rightHtml, bodyHtml, extra) {
    return `
<div class="gw-pa-panel" style="background:var(--card,#fff);border:1px solid var(--line,#e5e5e0);border-radius:18px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.18),0 8px 24px -18px rgba(0,0,0,.35);${extra||''}">
  <div style="display:flex;align-items:center;justify-content:space-between;padding:18px 22px;border-bottom:1px solid var(--line,#e5e5e0);flex-wrap:wrap;gap:10px;background:linear-gradient(180deg,rgba(77,138,134,.05),transparent)">
    <h2 style="font-size:13px;font-weight:800;color:#E8E4D9;margin:0;text-transform:uppercase;letter-spacing:.09em;display:flex;align-items:center;gap:8px"><span style="width:3px;height:14px;background:#4D8A86;border-radius:2px;display:inline-block"></span>${title}</h2>
    ${rightHtml ? `<div style="display:flex;gap:8px;align-items:center">${rightHtml}</div>` : ''}
  </div>
  ${bodyHtml}
</div>`;
  }

  function actionBtn(label, onclick, style) {
    return `<button onclick="${onclick}" style="padding:9px 18px;background:rgba(77,138,134,.12);border:1px solid #4D8A8644;border-radius:10px;color:#4D8A86;font-size:13px;font-weight:700;cursor:pointer;transition:all .15s ease;${style||''}" onmouseover="this.style.background='rgba(77,138,134,.24)';this.style.borderColor='#4D8A8688'" onmouseout="this.style.background='rgba(77,138,134,.12)';this.style.borderColor='#4D8A8644'">${label}</button>`;
  }
  function primaryBtn(label, onclick, style) {
    return `<button onclick="${onclick}" style="padding:10px 22px;background:linear-gradient(135deg,#4D8A86,#1A4740);border:none;border-radius:10px;color:#fff;font-size:13px;font-weight:800;cursor:pointer;letter-spacing:.01em;box-shadow:0 4px 14px -6px rgba(77,138,134,.6);transition:all .15s ease;${style||''}" onmouseover="this.style.transform='translateY(-1px)';this.style.boxShadow='0 6px 20px -6px rgba(77,138,134,.75)'" onmouseout="this.style.transform='';this.style.boxShadow='0 4px 14px -6px rgba(77,138,134,.6)'">${label}</button>`;
  }
  function dangerBtn(label, onclick) {
    return `<button onclick="${onclick}" style="padding:8px 16px;background:#C97B6A22;border:1px solid #C97B6A44;border-radius:10px;color:#C97B6A;font-size:12px;font-weight:700;cursor:pointer">${label}</button>`;
  }

  // ── API wrappers ─────────────────────────────────────────────────────────
  async function apiGet(path) {
    const r = await fetch(path, { credentials:'include' });
    if (!r.ok) throw new Error((await r.json().catch(()=>({}))).error || `HTTP ${r.status}`);
    const d = await r.json();
    return d.data ?? d;
  }
  async function apiPost(path, body) {
    const r = await fetch(path, { method:'POST', credentials:'include', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body) });
    const d = await r.json().catch(()=>({}));
    if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
    return d.data ?? d;
  }
  async function apiPut(path, body) {
    const r = await fetch(path, { method:'PUT', credentials:'include', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body) });
    const d = await r.json().catch(()=>({}));
    if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
    return d.data ?? d;
  }
  async function apiDelete(path) {
    const r = await fetch(path, { method:'DELETE', credentials:'include' });
    const d = await r.json().catch(()=>({}));
    if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
    return d;
  }

  function toast(msg, dur) {
    if (typeof showToast === 'function') showToast(msg, dur || 2500);
    else console.log('[toast]', msg);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 1. OVERVIEW DASHBOARD
  // ─────────────────────────────────────────────────────────────────────────
  async function overview() {
    const v = view(); if (!v) return;
    v.innerHTML = `<div style="padding:60px;text-align:center;color:#6F7E6A">Loading platform data…</div>`;

    let stats = {}, companies = [], recentTickets = [], recentLeads = [], pricingPlans = [], recentDemos = [];
    try {
      [stats, companies, recentTickets, recentLeads] = await Promise.all([
        apiGet('/api/admin/stats'),
        apiGet('/api/admin/companies'),
        apiGet('/api/platform/tickets?limit=5&status=open'),
        apiGet('/api/platform/gw-leads?limit=5'),
      ]);
      // Non-critical extras — don't fail the dashboard if these error
      [pricingPlans, recentDemos] = await Promise.all([
        apiGet('/api/platform/pricing-plans').catch(()=>[]),
        apiGet('/api/platform/demos?limit=50').catch(()=>[]),
      ]);
      if (!Array.isArray(companies)) companies = [];
      if (!Array.isArray(recentTickets)) recentTickets = [];
      if (!Array.isArray(recentLeads)) recentLeads = [];
      if (!Array.isArray(pricingPlans)) pricingPlans = [];
      if (!Array.isArray(recentDemos)) recentDemos = [];
    } catch(e) {
      v.innerHTML = `<div style="padding:60px;text-align:center"><p style="color:#C97B6A">Failed to load: ${esc(e.message)}</p>
        <button class="secondary-btn" style="margin-top:16px" onclick="show('superAdmin')">↺ Retry</button></div>`;
      return;
    }

    const activeCompanies = companies.filter(c => c.active).length;
    const trialCompanies  = companies.filter(c => c.plan === 'trial').length;
    // MRR from the live pricing plan table (falls back to legacy map if empty)
    const priceMap = {};
    pricingPlans.forEach(p => { priceMap[p.id] = p.monthly_price || 0; });
    if (!Object.keys(priceMap).length) Object.assign(priceMap, {starter:29,core:49,growth:65,pro:85,enterprise:0});
    const mrr = companies.filter(c=>c.active && c.plan !== 'trial')
      .reduce((s,c) => s + (priceMap[c.plan]||0), 0);
    const pendingDemos = recentDemos.filter(d => d.status === 'requested' || d.status === 'scheduled').length;

    v.innerHTML = shell(
      `${gwI('shield',22,'#7EC8A4')} Platform Overview`,
      `Groundwork CRM · ${new Date().toLocaleDateString('en-US',{weekday:'long',month:'long',day:'numeric'})}`,
      'PLATFORM ADMIN',
      `${actionBtn('↺ Refresh','show(\'superAdmin\')')}
       ${actionBtn('Demo Requests','show(\'gwDemos\')')}
       ${primaryBtn('+ New Lead','show(\'gwLeads\')')}`,
      `
      <!-- Stat Grid -->
      <div class="gw-pa-stat-grid" style="margin-bottom:28px">
        ${statCard('Total Tenants',   fmt(companies.length),  gwIcon('building',40,'#1A4740'), '#1A4740', `${activeCompanies} active`)}
        ${statCard('On Trial',        fmt(trialCompanies),    gwIcon('clock',40,'#8B6914'), '#8B6914', 'Convert to paid')}
        ${statCard('Monthly Revenue', fmtMoney(mrr),          gwIcon('revenue',40,'#2D7A55'), '#2D7A55', 'est. MRR (live pricing)')}
        ${statCard('Pending Demos',   fmt(pendingDemos),      gwIcon('calendar',40,'#B8860B'), '#B8860B', 'from groundwork-crm.info')}
        ${statCard('Total Reps',      fmt(stats.reps),        gwIcon('users',40,'#4D8A86'), '#4D8A86', 'across all tenants')}
        ${statCard('Open Tickets',    fmt(recentTickets.length),gwIcon('tag',40,'#C97B6A'),'#C97B6A', 'need attention')}
        ${statCard('Active Opps',     fmt(stats.opportunities),gwIcon('reports',40,'#7B5EA7'),'#7B5EA7', 'in all pipelines')}
      </div>

      <!-- 2-col layout -->
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:20px;margin-bottom:20px">

        <!-- Recent Support Tickets -->
        ${panel('Open Support Tickets',
          `${actionBtn('View All','show(\'gwSupport\')')}`,
          recentTickets.length ? `
          <div style="padding:0">
            ${recentTickets.map(t => `
            <div style="display:flex;align-items:center;gap:12px;padding:14px 18px;border-bottom:1px solid var(--line,#e5e5e0);cursor:pointer" onclick="show('gwSupport')" onmouseover="this.style.background='rgba(255,255,255,.04)'" onmouseout="this.style.background=''">
              <div style="flex:1;min-width:0">
                <div style="font-weight:700;font-size:13px;color:#E8E4D9;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(t.subject||'No subject')}</div>
                <div style="font-size:11px;color:#5C6B58;margin-top:2px">${esc(t.company_name||t.company_id||'Unknown')} · ${ago(t.created_at)}</div>
              </div>
              <div>${priorityBadge(t.priority)}</div>
            </div>`).join('')}
          </div>` : '<div style="padding:40px;text-align:center;color:#5C6B58">No open tickets</div>'
        )}

        <!-- Recent Sales Leads -->
        ${panel('GW Sales Pipeline',
          `${actionBtn('View All','show(\'gwLeads\')')}`,
          recentLeads.length ? `
          <div style="padding:0">
            ${recentLeads.map(l => `
            <div style="display:flex;align-items:center;gap:12px;padding:14px 18px;border-bottom:1px solid var(--line,#e5e5e0);cursor:pointer" onclick="show('gwLeads')" onmouseover="this.style.background='rgba(255,255,255,.04)'" onmouseout="this.style.background=''">
              <div style="flex:1;min-width:0">
                <div style="font-weight:700;font-size:13px;color:#E8E4D9;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(l.company_name||l.contact_name||'Unnamed')}</div>
                <div style="font-size:11px;color:#5C6B58;margin-top:2px">${esc(l.contact_name||'')} · ${ago(l.updated_at||l.created_at)}</div>
              </div>
              <div>${stageBadge(l.stage)}</div>
            </div>`).join('')}
          </div>` : `<div style="padding:40px;text-align:center;color:#5C6B58">
            No leads yet. <button class="secondary-btn" style="margin-top:12px;display:block;margin-left:auto;margin-right:auto" onclick="show('gwLeads')">Add First Lead</button>
          </div>`
        )}
      </div>

      <!-- Companies quick list -->
      ${panel('Customer Tenants',
        `${actionBtn('Manage All','show(\'gwTenants\')')}`,
        `<div style="overflow-x:auto">
        <table style="width:100%;border-collapse:collapse;font-size:13px">
          <thead><tr>
            ${['Company','Plan','Status','Reps','Last Activity','Action'].map(h =>
              `<th style="padding:11px 14px;text-align:left;color:#5C6B58;font-weight:700;font-size:11px;text-transform:uppercase;letter-spacing:.05em;white-space:nowrap">${h}</th>`
            ).join('')}
          </tr></thead>
          <tbody>
            ${companies.slice(0,8).map(co => `
            <tr onmouseover="this.style.background='rgba(255,255,255,.03)'" onmouseout="this.style.background=''">
              <td style="padding:12px 14px">
                <div style="font-weight:700;color:#E8E4D9">${esc(co.name||'—')}</div>
                <div style="font-size:11px;color:#5C6B58">${esc(co.owner_email||co.slug||'')}</div>
              </td>
              <td style="padding:12px 14px">${planBadge(co.plan)}</td>
              <td style="padding:12px 14px"><span style="color:${co.active?'#2D7A55':'#C97B6A'};font-size:12px;font-weight:700">${co.active?'● Active':'○ Inactive'}</span></td>
              <td style="padding:12px 14px;color:#6F7E6A;text-align:center">${fmt(co.rep_count)}</td>
              <td style="padding:12px 14px;color:#5C6B58;font-size:12px">${ago(co.last_activity)}</td>
              <td style="padding:12px 14px">
                <button onclick="window._gwImpersonate('${esc(co.id)}','${esc(co.name)}')"
                  style="padding:5px 12px;background:#8B691422;border:1px solid #8B691444;border-radius:7px;color:#8B6914;font-size:11px;font-weight:700;cursor:pointer"
                  onmouseover="this.style.background='#8B691433'" onmouseout="this.style.background='#8B691422'">
                  Impersonate
                </button>
              </td>
            </tr>`).join('')}
            ${companies.length > 8 ? `<tr><td colspan="6" style="padding:14px;text-align:center;color:#5C6B58;font-size:12px">
              + ${companies.length - 8} more tenants — <button class="secondary-btn" style="padding:4px 12px;font-size:12px" onclick="show('gwTenants')">View All</button>
            </td></tr>` : ''}
          </tbody>
        </table></div>`
      )}
      ${_impersonateModal()}
    `);

    window._gwImpersonate = _gwImpersonate;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 2. TENANTS (full CRUD)
  // ─────────────────────────────────────────────────────────────────────────
  async function tenants() {
    const v = view(); if (!v) return;
    v.innerHTML = `<div style="padding:60px;text-align:center;color:#6F7E6A">Loading tenants…</div>`;

    let companies = [];
    try { companies = await apiGet('/api/admin/companies'); if (!Array.isArray(companies)) companies = []; }
    catch(e) { v.innerHTML = `<div style="padding:60px;text-align:center;color:#C97B6A">Error: ${esc(e.message)}</div>`; return; }

    const PLANS = ['trial','starter','core','growth','pro','enterprise'];

    v.innerHTML = shell(
      'Customer Tenants',
      `${companies.length} companies using Groundwork CRM`,
      'PLATFORM ADMIN › TENANTS',
      primaryBtn('+ Onboard New Company', 'window._gwNewTenant()'),
      `
      <!-- Filters -->
      <div style="display:flex;gap:10px;margin-bottom:20px;flex-wrap:wrap">
        ${['all','trial','starter','core','growth','pro','enterprise'].map(p => `
        <button onclick="window._gwFilterTenants('${p}')" id="gwTenantFilter_${p}"
          style="padding:7px 16px;border-radius:20px;border:1px solid ${p==='all'?'#4D8A86':'var(--line,#e5e5e0)'};
                 background:${p==='all'?'rgba(77,138,134,.15)':'transparent'};
                 color:${p==='all'?'#4D8A86':'#6F7E6A'};font-size:12px;font-weight:700;cursor:pointer">
          ${p.charAt(0).toUpperCase()+p.slice(1)}
        </button>`).join('')}
      </div>

      <!-- Table -->
      ${panel('All Companies',
        `<span style="font-size:12px;color:#5C6B58">${companies.length} total</span>`,
        `<div style="overflow-x:auto" id="gwTenantsTableWrap">
        <table style="width:100%;border-collapse:collapse;font-size:13px" id="gwTenantsTable">
          <thead><tr>
            ${['Company','Owner','Plan','Status','Reps','Opps','Created','Actions'].map(h =>
              `<th style="padding:12px 14px;text-align:left;color:#5C6B58;font-weight:700;font-size:11px;text-transform:uppercase;letter-spacing:.05em;white-space:nowrap">${h}</th>`
            ).join('')}
          </tr></thead>
          <tbody id="gwTenantsBody">
          ${companies.map(co => _tenantRow(co)).join('')}
          </tbody>
        </table></div>`
      )}
      ${_impersonateModal()}
      <div id="gwTenantModal"></div>
    `);

    window._gwAllTenants   = companies;
    window._gwImpersonate  = _gwImpersonate;
    window._gwFilterTenants = function(plan) {
      document.querySelectorAll('[id^="gwTenantFilter_"]').forEach(b => {
        const active = b.id === 'gwTenantFilter_' + plan;
        b.style.background = active ? 'rgba(77,138,134,.15)' : 'transparent';
        b.style.borderColor = active ? '#4D8A86' : 'var(--line,#e5e5e0)';
        b.style.color = active ? '#4D8A86' : '#6F7E6A';
      });
      const filtered = plan === 'all' ? companies : companies.filter(c => c.plan === plan);
      document.getElementById('gwTenantsBody').innerHTML = filtered.map(_tenantRow).join('');
    };
    window._gwNewTenant = function() { _tenantModal(null); };
    window._gwEditTenant = function(id) {
      const co = (window._gwAllTenants||[]).find(c => c.id === id);
      _tenantModal(co);
    };
    window._gwToggleTenantActive = async function(id, active) {
      if (!confirm(`${active ? 'Reactivate' : 'Deactivate'} this company?`)) return;
      try {
        await apiPut(`/api/admin/companies/${id}`, { active: active ? 1 : 0 });
        toast(`Company ${active ? 'reactivated' : 'deactivated'}`);
        show('gwTenants');
      } catch(e) { toast('Error: ' + e.message); }
    };
    window._gwDeleteTenant = async function(id, name) {
      const typed = prompt(`⚠️ PERMANENTLY DELETE "${name}" and ALL its data?\n\nThis cannot be undone. Reps, leads, estimates, invoices, settings — everything will be erased.\n\nType the company ID to confirm:\n${id}`);
      if (typed === null) return;
      if (typed.trim() !== id) { toast('Company ID did not match — deletion cancelled'); return; }
      try {
        const r = await fetch(`/api/admin/companies/${encodeURIComponent(id)}?confirm=${encodeURIComponent(id)}`, { method:'DELETE', credentials:'include' });
        const j = await r.json();
        if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
        toast(`Deleted "${name}" and all its data`);
        show('gwTenants');
      } catch(e) { toast('Delete failed: ' + e.message); }
    };
  }

  function _tenantRow(co) {
    return `<tr onmouseover="this.style.background='rgba(255,255,255,.03)'" onmouseout="this.style.background=''">
      <td style="padding:13px 14px">
        <div style="font-weight:700;color:#E8E4D9">${esc(co.name)}</div>
        <div style="font-size:11px;color:#5C6B58">${esc(co.website||co.slug||'')}</div>
      </td>
      <td style="padding:13px 14px;color:#6F7E6A;font-size:12px">${esc(co.owner_email||'—')}</td>
      <td style="padding:13px 14px">${planBadge(co.plan)}</td>
      <td style="padding:13px 14px"><span style="color:${co.active?'#2D7A55':'#C97B6A'};font-size:12px;font-weight:700">${co.active?'● Active':'○ Inactive'}</span></td>
      <td style="padding:13px 14px;color:#6F7E6A;text-align:center">${fmt(co.rep_count)}</td>
      <td style="padding:13px 14px;color:#6F7E6A;text-align:center">${fmt(co.opp_count)}</td>
      <td style="padding:13px 14px;color:#5C6B58;font-size:12px">${dateStr(co.created_at)}</td>
      <td style="padding:13px 14px">
        <div style="display:flex;gap:6px;flex-wrap:wrap">
          <button onclick="window._gwEditTenant('${esc(co.id)}')"
            style="padding:5px 10px;background:rgba(77,138,134,.12);border:1px solid #4D8A8644;border-radius:7px;color:#4D8A86;font-size:11px;font-weight:700;cursor:pointer">Edit</button>
          <button onclick="window._gwImpersonate('${esc(co.id)}','${esc(co.name)}')"
            style="padding:5px 10px;background:#8B691422;border:1px solid #8B691444;border-radius:7px;color:#8B6914;font-size:11px;font-weight:700;cursor:pointer">Impersonate</button>
          <button onclick="window._gwToggleTenantActive('${esc(co.id)}',${co.active?0:1})"
            style="padding:5px 10px;background:${co.active?'#C97B6A22':'#2D7A5522'};border:1px solid ${co.active?'#C97B6A44':'#2D7A5544'};border-radius:7px;color:${co.active?'#C97B6A':'#2D7A55'};font-size:11px;font-weight:700;cursor:pointer">
            ${co.active?'Deactivate':'Reactivate'}
          </button>
          ${co.id !== 'avalon' ? `<button onclick="window._gwDeleteTenant('${esc(co.id)}','${esc(co.name)}')"
            style="padding:5px 10px;background:rgba(201,60,60,.12);border:1px solid rgba(201,60,60,.35);border-radius:7px;color:#D96C6C;font-size:11px;font-weight:700;cursor:pointer">Delete</button>` : ''}
        </div>
      </td>
    </tr>`;
  }

  function _tenantModal(co) {
    const isEdit = !!co;
    const wrap = document.getElementById('gwTenantModal') || document.body;
    const el = document.createElement('div');
    el.id = 'gwTenantModalOverlay';
    el.style.cssText = 'position:fixed;inset:0;background:#000c;z-index:9999;display:flex;align-items:center;justify-content:center;padding:20px';
    el.innerHTML = `
<div style="background:var(--card,#1E2B29);border:1px solid var(--line,#2A3A38);border-radius:20px;width:min(560px,100%);max-height:90vh;overflow-y:auto;padding:28px">
  <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:22px">
    <h2 style="margin:0;font-size:18px;font-weight:800;color:#E8E4D9">${isEdit ? 'Edit Company' : 'Onboard New Company'}</h2>
    <button onclick="document.getElementById('gwTenantModalOverlay').remove()" style="background:none;border:none;color:#6F7E6A;font-size:20px;cursor:pointer">✕</button>
  </div>
  <div style="display:grid;gap:14px">
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
      <div><label class="um-label">Company Name *</label>
        <input id="gwT-name" class="um-input" value="${esc(co?.name||'')}" placeholder="Avalon Logistics"></div>
      <div><label class="um-label">Slug (URL ID) *</label>
        <input id="gwT-slug" class="um-input" value="${esc(co?.slug||'')}" placeholder="avalon" ${isEdit?'readonly style="opacity:.6"':''}></div>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
      <div><label class="um-label">Owner Email</label>
        <input id="gwT-email" class="um-input" type="email" value="${esc(co?.owner_email||'')}" placeholder="owner@company.com"></div>
      <div><label class="um-label">Website</label>
        <input id="gwT-website" class="um-input" value="${esc(co?.website||'')}" placeholder="company.com"></div>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
      <div><label class="um-label">Plan</label>
        <select id="gwT-plan" class="um-input">
          ${['trial','starter','core','growth','pro','enterprise'].map(p=>`<option value="${p}" ${(co?.plan||'trial')===p?'selected':''}>${p.charAt(0).toUpperCase()+p.slice(1)}</option>`).join('')}
        </select></div>
      <div><label class="um-label">Status</label>
        <select id="gwT-active" class="um-input">
          <option value="1" ${(co?.active!==0)?'selected':''}>Active</option>
          <option value="0" ${co?.active===0?'selected':''}>Inactive</option>
        </select></div>
    </div>
    <div><label class="um-label">Notes (internal)</label>
      <textarea id="gwT-notes" class="um-input" rows="2" placeholder="Internal notes about this company" style="resize:vertical">${esc(co?.notes||'')}</textarea></div>
  </div>
  <div style="display:flex;justify-content:flex-end;gap:10px;margin-top:24px">
    <button class="secondary-btn" onclick="document.getElementById('gwTenantModalOverlay').remove()">Cancel</button>
    <button class="primary-btn" onclick="window._gwSaveTenant('${esc(co?.id||'')}')">${isEdit ? 'Save Changes' : 'Create Company'}</button>
  </div>
</div>`;
    document.body.appendChild(el);

    window._gwSaveTenant = async function(existingId) {
      const name    = document.getElementById('gwT-name')?.value?.trim();
      const slug    = document.getElementById('gwT-slug')?.value?.trim();
      const email   = document.getElementById('gwT-email')?.value?.trim();
      const website = document.getElementById('gwT-website')?.value?.trim();
      const plan    = document.getElementById('gwT-plan')?.value;
      const active  = parseInt(document.getElementById('gwT-active')?.value || '1');
      const notes   = document.getElementById('gwT-notes')?.value?.trim();
      if (!name) { toast('Company name is required'); return; }
      if (!existingId && !slug) { toast('Slug is required'); return; }
      try {
        if (existingId) {
          await apiPut(`/api/admin/companies/${existingId}`, { name, owner_email:email, website, plan, active, notes });
          toast('Company updated');
        } else {
          await apiPost('/api/admin/companies', { id:slug, name, slug, owner_email:email, website, plan, active:active, notes });
          toast('Company created');
        }
        document.getElementById('gwTenantModalOverlay')?.remove();
        show('gwTenants');
      } catch(e) { toast('Error: ' + e.message); }
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 3. GW SALES PIPELINE (leads for selling Groundwork CRM)
  // ─────────────────────────────────────────────────────────────────────────
  const GW_STAGES = ['prospect','qualified','demo','proposal','negotiation','closed_won','closed_lost'];

  async function leads() {
    const v = view(); if (!v) return;
    v.innerHTML = `<div style="padding:60px;text-align:center;color:#6F7E6A">Loading pipeline…</div>`;

    let gwLeads = [];
    try { gwLeads = await apiGet('/api/platform/gw-leads'); if (!Array.isArray(gwLeads)) gwLeads = []; }
    catch(e) { v.innerHTML = `<div style="padding:60px;text-align:center;color:#C97B6A">Error: ${esc(e.message)}</div>`; return; }

    const byStage = {};
    GW_STAGES.forEach(s => byStage[s] = gwLeads.filter(l => l.stage === s));
    const wonValue = byStage.closed_won.reduce((s,l) => s+(l.deal_value||0), 0);
    const pipeValue = gwLeads.filter(l=>!['closed_won','closed_lost'].includes(l.stage)).reduce((s,l)=>s+(l.deal_value||0),0);

    v.innerHTML = shell(
      'GW Sales Pipeline',
      'Prospects and leads for selling Groundwork CRM subscriptions',
      'PLATFORM ADMIN › SALES PIPELINE',
      `${actionBtn('Board View','window._gwLeadToggleView(\'board\')')}
       ${actionBtn('List View','window._gwLeadToggleView(\'list\')')}
       ${primaryBtn('+ Add Lead','window._gwLeadModal(null)')}`,
      `
      <!-- Pipeline stats -->
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:14px;margin-bottom:24px">
        ${statCard('Total Leads',      fmt(gwLeads.length),   gwIcon('checklist',40,'#4D8A86'),'#4D8A86')}
        ${statCard('Pipeline Value',   fmtMoney(pipeValue),   gwIcon('revenue',40,'#8B6914'),'#8B6914','open deals')}
        ${statCard('Closed Won',       fmt(byStage.closed_won.length),gwIcon('trophy',40,'#2D7A55'),'#2D7A55', fmtMoney(wonValue))}
        ${statCard('Closed Lost',      fmt(byStage.closed_lost.length),gwIcon('lost',40,'#C97B6A'),'#C97B6A')}
      </div>

      <!-- Kanban Board -->
      <div id="gwLeadBoardView">
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:14px;overflow-x:auto">
        ${GW_STAGES.map(stage => `
        <div style="background:var(--card,#fff);border:1px solid var(--line,#e5e5e0);border-radius:14px;overflow:hidden;min-width:180px">
          <div style="padding:12px 14px;border-bottom:1px solid var(--line,#e5e5e0);display:flex;align-items:center;justify-content:space-between">
            <span style="font-size:11px;font-weight:800;color:#5C6B58;text-transform:uppercase;letter-spacing:.07em">${stage.replace(/_/g,' ')}</span>
            <span style="background:var(--line,#e5e5e0);border-radius:10px;padding:2px 8px;font-size:11px;font-weight:700;color:#6F7E6A">${byStage[stage].length}</span>
          </div>
          <div style="padding:10px;min-height:120px">
            ${byStage[stage].length ? byStage[stage].map(l => `
            <div onclick="window._gwLeadModal('${esc(l.id)}')"
              style="background:var(--surface,#fff);border:1px solid var(--line,#e5e5e0);border-radius:10px;padding:12px;margin-bottom:8px;cursor:pointer;transition:border-color .15s"
              onmouseover="this.style.borderColor='#4D8A86'" onmouseout="this.style.borderColor='var(--line,#e5e5e0)'">
              <div style="font-weight:700;font-size:13px;color:#E8E4D9;margin-bottom:4px;line-height:1.3">${esc(l.company_name||l.contact_name||'Unnamed')}</div>
              <div style="font-size:11px;color:#5C6B58">${esc(l.contact_name||'')}</div>
              ${l.deal_value ? `<div style="font-size:12px;color:#2D7A55;font-weight:700;margin-top:6px">${fmtMoney(l.deal_value)}/mo</div>` : ''}
              <div style="font-size:10px;color:#6F7E6A;margin-top:4px">${ago(l.updated_at||l.created_at)}</div>
            </div>`).join('') : `<div style="text-align:center;padding:20px 0;color:#5C6B58;font-size:12px">Empty</div>`}
          </div>
        </div>`).join('')}
      </div>
      </div>

      <!-- List view (hidden by default) -->
      <div id="gwLeadListView" style="display:none">
        ${panel('All Leads',
          `<span style="font-size:12px;color:#5C6B58">${gwLeads.length} total</span>`,
          `<div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse;font-size:13px">
            <thead><tr>${['Company','Contact','Stage','Value','Priority','Next Action','Updated',''].map(h=>`<th style="padding:11px 14px;text-align:left;color:#5C6B58;font-weight:700;font-size:11px;text-transform:uppercase;letter-spacing:.05em">${h}</th>`).join('')}</tr></thead>
            <tbody>
            ${gwLeads.map(l=>`<tr onmouseover="this.style.background='rgba(255,255,255,.03)'" onmouseout="this.style.background=''">
              <td style="padding:12px 14px;font-weight:700;color:#E8E4D9">${esc(l.company_name||'—')}</td>
              <td style="padding:12px 14px;color:#6F7E6A">${esc(l.contact_name||'—')}</td>
              <td style="padding:12px 14px">${stageBadge(l.stage)}</td>
              <td style="padding:12px 14px;color:#2D7A55;font-weight:700">${l.deal_value?fmtMoney(l.deal_value):''}</td>
              <td style="padding:12px 14px">${priorityBadge(l.priority)}</td>
              <td style="padding:12px 14px;color:#6F7E6A;font-size:12px;max-width:180px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(l.next_action||'—')}</td>
              <td style="padding:12px 14px;color:#5C6B58;font-size:12px">${ago(l.updated_at||l.created_at)}</td>
              <td style="padding:12px 14px"><button onclick="window._gwLeadModal('${esc(l.id)}')" style="padding:5px 10px;background:rgba(77,138,134,.12);border:1px solid #4D8A8644;border-radius:7px;color:#4D8A86;font-size:11px;font-weight:700;cursor:pointer">Open</button></td>
            </tr>`).join('')}
            </tbody>
          </table></div>`
        )}
      </div>

      <div id="gwLeadModalWrap"></div>
    `);

    window._gwAllLeads = gwLeads;
    window._gwLeadToggleView = function(v) {
      document.getElementById('gwLeadBoardView').style.display = v==='board' ? '' : 'none';
      document.getElementById('gwLeadListView').style.display  = v==='list'  ? '' : 'none';
    };
    window._gwLeadModal = function(id) {
      const lead = id ? (window._gwAllLeads||[]).find(l=>l.id===id) : null;
      _leadModal(lead);
    };
  }

  function _leadModal(lead) {
    const isEdit = !!lead;
    const el = document.createElement('div');
    el.id = 'gwLeadModalOverlay';
    el.style.cssText = 'position:fixed;inset:0;background:#000c;z-index:9999;display:flex;align-items:center;justify-content:center;padding:20px';
    el.innerHTML = `
<div style="background:var(--card,#1E2B29);border:1px solid var(--line,#2A3A38);border-radius:20px;width:min(620px,100%);max-height:90vh;overflow-y:auto;padding:28px">
  <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:22px">
    <h2 style="margin:0;font-size:18px;font-weight:800;color:#E8E4D9">${isEdit ? 'Edit Lead' : 'Add New Lead'}</h2>
    <button onclick="document.getElementById('gwLeadModalOverlay').remove()" style="background:none;border:none;color:#6F7E6A;font-size:20px;cursor:pointer">✕</button>
  </div>
  <div style="display:grid;gap:14px">
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
      <div><label class="um-label">Company Name *</label>
        <input id="gwL-company" class="um-input" value="${esc(lead?.company_name||'')}" placeholder="Prospect Inc."></div>
      <div><label class="um-label">Contact Name</label>
        <input id="gwL-contact" class="um-input" value="${esc(lead?.contact_name||'')}" placeholder="Jane Smith"></div>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
      <div><label class="um-label">Email</label>
        <input id="gwL-email" class="um-input" type="email" value="${esc(lead?.email||'')}" placeholder="jane@prospect.com"></div>
      <div><label class="um-label">Phone</label>
        <input id="gwL-phone" class="um-input" type="tel" value="${esc(lead?.phone||'')}" placeholder="(555) 000-0000"></div>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px">
      <div><label class="um-label">Stage</label>
        <select id="gwL-stage" class="um-input">
          ${GW_STAGES.map(s=>`<option value="${s}" ${(lead?.stage||'prospect')===s?'selected':''}>${s.replace(/_/g,' ').replace(/\b\w/g,c=>c.toUpperCase())}</option>`).join('')}
        </select></div>
      <div><label class="um-label">Priority</label>
        <select id="gwL-priority" class="um-input">
          ${['low','medium','high','urgent'].map(p=>`<option value="${p}" ${(lead?.priority||'medium')===p?'selected':''}>${p.charAt(0).toUpperCase()+p.slice(1)}</option>`).join('')}
        </select></div>
      <div><label class="um-label">Deal Value ($/mo)</label>
        <input id="gwL-value" class="um-input" type="number" value="${esc(lead?.deal_value||'')}" placeholder="249" min="0"></div>
    </div>
    <div><label class="um-label">Next Action</label>
      <input id="gwL-next" class="um-input" value="${esc(lead?.next_action||'')}" placeholder="Schedule demo call, send proposal…"></div>
    <div><label class="um-label">Notes</label>
      <textarea id="gwL-notes" class="um-input" rows="3" placeholder="Lead context, pain points, budget…" style="resize:vertical">${esc(lead?.notes||'')}</textarea></div>
    <div><label class="um-label">Source</label>
      <select id="gwL-source" class="um-input">
        ${['referral','cold_outreach','inbound','demo_request','conference','other'].map(s=>`<option value="${s}" ${(lead?.source||'other')===s?'selected':''}>${s.replace(/_/g,' ').replace(/\b\w/g,c=>c.toUpperCase())}</option>`).join('')}
      </select></div>
  </div>
  <div style="display:flex;justify-content:space-between;align-items:center;margin-top:24px">
    ${isEdit ? dangerBtn('Delete Lead',`window._gwDeleteLead('${esc(lead.id)}')`) : '<span></span>'}
    <div style="display:flex;gap:10px">
      <button class="secondary-btn" onclick="document.getElementById('gwLeadModalOverlay').remove()">Cancel</button>
      <button class="primary-btn" onclick="window._gwSaveLead('${esc(lead?.id||'')}')">${isEdit ? 'Save' : 'Add Lead'}</button>
    </div>
  </div>
</div>`;
    document.body.appendChild(el);

    window._gwSaveLead = async function(existingId) {
      const payload = {
        company_name: document.getElementById('gwL-company')?.value?.trim(),
        contact_name: document.getElementById('gwL-contact')?.value?.trim(),
        email:        document.getElementById('gwL-email')?.value?.trim(),
        phone:        document.getElementById('gwL-phone')?.value?.trim(),
        stage:        document.getElementById('gwL-stage')?.value,
        priority:     document.getElementById('gwL-priority')?.value,
        deal_value:   parseFloat(document.getElementById('gwL-value')?.value)||0,
        next_action:  document.getElementById('gwL-next')?.value?.trim(),
        notes:        document.getElementById('gwL-notes')?.value?.trim(),
        source:       document.getElementById('gwL-source')?.value,
      };
      if (!payload.company_name) { toast('Company name required'); return; }
      try {
        if (existingId) { await apiPut(`/api/platform/gw-leads/${existingId}`, payload); toast('Lead updated'); }
        else { await apiPost('/api/platform/gw-leads', payload); toast('Lead added'); }
        document.getElementById('gwLeadModalOverlay')?.remove();
        show('gwLeads');
      } catch(e) { toast('Error: ' + e.message); }
    };
    window._gwDeleteLead = async function(id) {
      if (!confirm('Delete this lead? This cannot be undone.')) return;
      try {
        await apiDelete(`/api/platform/gw-leads/${id}`);
        document.getElementById('gwLeadModalOverlay')?.remove();
        toast('Lead deleted');
        show('gwLeads');
      } catch(e) { toast('Error: ' + e.message); }
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 4. SUPPORT TICKETS
  // ─────────────────────────────────────────────────────────────────────────
  const TICKET_STATUSES = ['open','in_progress','waiting','resolved','closed'];

  async function support() {
    const v = view(); if (!v) return;
    v.innerHTML = `<div style="padding:60px;text-align:center;color:#6F7E6A">Loading tickets…</div>`;

    let tickets = [];
    try { tickets = await apiGet('/api/platform/tickets'); if (!Array.isArray(tickets)) tickets = []; }
    catch(e) { v.innerHTML = `<div style="padding:60px;text-align:center;color:#C97B6A">Error: ${esc(e.message)}</div>`; return; }

    const byStatus = {};
    TICKET_STATUSES.forEach(s => byStatus[s] = tickets.filter(t=>t.status===s).length);

    v.innerHTML = shell(
      'Support & Tickets',
      'Customer bug reports, questions, and feature requests',
      'PLATFORM ADMIN › SUPPORT',
      primaryBtn('+ New Ticket','window._gwTicketModal(null)'),
      `
      <!-- Status filter pills -->
      <div style="display:flex;gap:10px;margin-bottom:20px;flex-wrap:wrap">
        ${['all',...TICKET_STATUSES].map(s => `
        <button onclick="window._gwFilterTickets('${s}')" id="gwTicketFilter_${s}"
          style="padding:7px 14px;border-radius:20px;border:1px solid ${s==='all'?'#4D8A86':'var(--line,#e5e5e0)'};
                 background:${s==='all'?'rgba(77,138,134,.15)':'transparent'};
                 color:${s==='all'?'#4D8A86':'#6F7E6A'};font-size:12px;font-weight:700;cursor:pointer">
          ${s==='all'?'All':s.replace(/_/g,' ').replace(/\b\w/g,c=>c.toUpperCase())}
          <span style="margin-left:4px;opacity:.7">${s==='all'?tickets.length:(byStatus[s]||0)}</span>
        </button>`).join('')}
      </div>

      <!-- Stats row -->
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:12px;margin-bottom:24px">
        ${statCard('Open', fmt(byStatus.open||0), gwIcon('dot',40,'#C97B6A'), '#C97B6A')}
        ${statCard('In Progress', fmt(byStatus.in_progress||0), gwIcon('dot',40,'#8B6914'), '#8B6914')}
        ${statCard('Waiting', fmt(byStatus.waiting||0), gwIcon('dot',40,'#4D8A86'), '#4D8A86')}
        ${statCard('Resolved', fmt(byStatus.resolved||0), gwIcon('dot',40,'#2D7A55'), '#2D7A55')}
      </div>

      <!-- Tickets list -->
      ${panel('All Tickets',
        `<span style="font-size:12px;color:#5C6B58" id="gwTicketCount">${tickets.length} total</span>`,
        `<div id="gwTicketsList">
          ${tickets.length ? tickets.map(_ticketRow).join('') : '<div style="padding:60px;text-align:center;color:#5C6B58">No tickets yet</div>'}
        </div>`
      )}
      <div id="gwTicketModalWrap"></div>
    `);

    window._gwAllTickets = tickets;
    window._gwFilterTickets = function(status) {
      document.querySelectorAll('[id^="gwTicketFilter_"]').forEach(b => {
        const active = b.id === 'gwTicketFilter_' + status;
        b.style.background = active ? 'rgba(77,138,134,.15)' : 'transparent';
        b.style.borderColor = active ? '#4D8A86' : 'var(--line,#e5e5e0)';
        b.style.color = active ? '#4D8A86' : '#6F7E6A';
      });
      const filtered = status === 'all' ? tickets : tickets.filter(t => t.status === status);
      document.getElementById('gwTicketsList').innerHTML = filtered.length
        ? filtered.map(_ticketRow).join('')
        : '<div style="padding:40px;text-align:center;color:#5C6B58">No tickets in this status.</div>';
      document.getElementById('gwTicketCount').textContent = filtered.length + ' total';
    };
    window._gwTicketModal = function(id) {
      const ticket = id ? (window._gwAllTickets||[]).find(t=>t.id===id) : null;
      _ticketModal(ticket);
    };
  }

  function _ticketRow(t) {
    return `
<div onclick="window._gwTicketModal('${esc(t.id)}')"
  style="display:flex;align-items:center;gap:14px;padding:16px 20px;border-bottom:1px solid var(--line,#e5e5e0);cursor:pointer;transition:background .12s"
  onmouseover="this.style.background='rgba(255,255,255,.04)'" onmouseout="this.style.background=''">
  <div style="flex:1;min-width:0">
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px;flex-wrap:wrap">
      <span style="font-weight:700;font-size:14px;color:#E8E4D9">${esc(t.subject||'No subject')}</span>
      ${priorityBadge(t.priority)}
    </div>
    <div style="font-size:12px;color:#5C6B58">${esc(t.company_name||t.company_id||'Unknown tenant')} · ${esc(t.submitter_name||t.submitter_email||'Anonymous')} · ${ago(t.created_at)}</div>
    ${t.body ? `<div style="font-size:12px;color:#6F7E6A;margin-top:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:600px">${esc(t.body.substring(0,120))}${t.body.length>120?'…':''}</div>` : ''}
  </div>
  <div style="display:flex;flex-direction:column;align-items:flex-end;gap:6px;flex-shrink:0">
    ${ticketStatusBadge(t.status)}
    <span style="font-size:11px;color:#5C6B58">${ago(t.updated_at||t.created_at)}</span>
  </div>
</div>`;
  }

  function _ticketModal(ticket) {
    const isEdit = !!ticket;
    const el = document.createElement('div');
    el.id = 'gwTicketModalOverlay';
    el.style.cssText = 'position:fixed;inset:0;background:#000c;z-index:9999;display:flex;align-items:center;justify-content:center;padding:20px';
    el.innerHTML = `
<div style="background:var(--card,#1E2B29);border:1px solid var(--line,#2A3A38);border-radius:20px;width:min(680px,100%);max-height:92vh;overflow-y:auto;padding:28px">
  <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:22px">
    <h2 style="margin:0;font-size:18px;font-weight:800;color:#E8E4D9">${isEdit ? 'Ticket Details' : 'Create Ticket'}</h2>
    <button onclick="document.getElementById('gwTicketModalOverlay').remove()" style="background:none;border:none;color:#6F7E6A;font-size:20px;cursor:pointer">✕</button>
  </div>
  ${isEdit ? `
  <div style="background:rgba(255,255,255,.04);border:1px solid var(--line,#2A3A38);border-radius:12px;padding:16px;margin-bottom:20px">
    <div style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:8px">
      ${ticketStatusBadge(ticket.status)} ${priorityBadge(ticket.priority)}
      <span style="font-size:12px;color:#5C6B58">From: ${esc(ticket.submitter_name||ticket.submitter_email||'Anonymous')}</span>
      <span style="font-size:12px;color:#5C6B58">· ${dateStr(ticket.created_at)}</span>
    </div>
    <div style="font-size:13px;color:#6F7E6A;line-height:1.6;white-space:pre-wrap">${esc(ticket.body||'No description')}</div>
  </div>` : ''}
  <div style="display:grid;gap:14px">
    <div><label class="um-label">Subject *</label>
      <input id="gwTk-subject" class="um-input" value="${esc(ticket?.subject||'')}" placeholder="Bug report: login not working"></div>
    ${!isEdit ? `
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
      <div><label class="um-label">Company / Tenant</label>
        <input id="gwTk-company" class="um-input" value="${esc(ticket?.company_name||'')}" placeholder="Avalon Logistics"></div>
      <div><label class="um-label">Submitter Email</label>
        <input id="gwTk-email" class="um-input" type="email" value="${esc(ticket?.submitter_email||'')}" placeholder="user@company.com"></div>
    </div>
    <div><label class="um-label">Description *</label>
      <textarea id="gwTk-body" class="um-input" rows="4" placeholder="Describe the issue in detail…" style="resize:vertical">${esc(ticket?.body||'')}</textarea></div>` : ''}
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
      <div><label class="um-label">Status</label>
        <select id="gwTk-status" class="um-input">
          ${TICKET_STATUSES.map(s=>`<option value="${s}" ${(ticket?.status||'open')===s?'selected':''}>${s.replace(/_/g,' ').replace(/\b\w/g,c=>c.toUpperCase())}</option>`).join('')}
        </select></div>
      <div><label class="um-label">Priority</label>
        <select id="gwTk-priority" class="um-input">
          ${['low','medium','high','urgent'].map(p=>`<option value="${p}" ${(ticket?.priority||'medium')===p?'selected':''}>${p.charAt(0).toUpperCase()+p.slice(1)}</option>`).join('')}
        </select></div>
    </div>
    <div><label class="um-label">Internal Notes / Resolution</label>
      <textarea id="gwTk-notes" class="um-input" rows="3" placeholder="Internal notes, steps taken, resolution…" style="resize:vertical">${esc(ticket?.internal_notes||'')}</textarea></div>
  </div>
  <div style="display:flex;justify-content:space-between;align-items:center;margin-top:24px">
    ${isEdit ? dangerBtn('Delete',`window._gwDeleteTicket('${esc(ticket.id)}')`) : '<span></span>'}
    <div style="display:flex;gap:10px">
      <button class="secondary-btn" onclick="document.getElementById('gwTicketModalOverlay').remove()">Cancel</button>
      <button class="primary-btn" onclick="window._gwSaveTicket('${esc(ticket?.id||'')}')">${isEdit ? 'Update Ticket' : 'Create Ticket'}</button>
    </div>
  </div>
</div>`;
    document.body.appendChild(el);

    window._gwSaveTicket = async function(existingId) {
      const payload = {
        subject:        document.getElementById('gwTk-subject')?.value?.trim(),
        status:         document.getElementById('gwTk-status')?.value,
        priority:       document.getElementById('gwTk-priority')?.value,
        internal_notes: document.getElementById('gwTk-notes')?.value?.trim(),
        ...(!existingId ? {
          company_name:     document.getElementById('gwTk-company')?.value?.trim(),
          submitter_email:  document.getElementById('gwTk-email')?.value?.trim(),
          body:             document.getElementById('gwTk-body')?.value?.trim(),
        } : {})
      };
      if (!payload.subject) { toast('Subject is required'); return; }
      try {
        if (existingId) { await apiPut(`/api/platform/tickets/${existingId}`, payload); toast('Ticket updated'); }
        else { await apiPost('/api/platform/tickets', payload); toast('Ticket created'); }
        document.getElementById('gwTicketModalOverlay')?.remove();
        show('gwSupport');
      } catch(e) { toast('Error: ' + e.message); }
    };
    window._gwDeleteTicket = async function(id) {
      if (!confirm('Delete this ticket?')) return;
      try { await apiDelete(`/api/platform/tickets/${id}`); document.getElementById('gwTicketModalOverlay')?.remove(); toast('Deleted'); show('gwSupport'); }
      catch(e) { toast('Error: ' + e.message); }
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 5. ANNOUNCEMENTS / RELEASE NOTES
  // ─────────────────────────────────────────────────────────────────────────
  async function announce() {
    const v = view(); if (!v) return;
    v.innerHTML = `<div style="padding:60px;text-align:center;color:#6F7E6A">Loading announcements…</div>`;

    let posts = [];
    try { posts = await apiGet('/api/platform/announcements'); if (!Array.isArray(posts)) posts = []; }
    catch(e) { v.innerHTML = `<div style="padding:60px;text-align:center;color:#C97B6A">Error: ${esc(e.message)}</div>`; return; }

    const TYPE_COLORS = { release:'#2D7A55', maintenance:'#8B6914', announcement:'#4D8A86', urgent:'#C97B6A' };

    v.innerHTML = shell(
      'Announcements',
      'Release notes, maintenance windows, and platform-wide communications',
      'PLATFORM ADMIN › ANNOUNCEMENTS',
      primaryBtn('+ New Post','window._gwAnnounceModal(null)'),
      `
      ${panel('All Posts',
        `<span style="font-size:12px;color:#5C6B58">${posts.length} posts</span>`,
        posts.length ? `<div>
          ${posts.map(p => {
            const c = TYPE_COLORS[p.type] || '#4D8A86';
            return `
<div style="padding:20px;border-bottom:1px solid var(--line,#e5e5e0)">
  <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:12px;flex-wrap:wrap">
    <div style="flex:1;min-width:200px">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;flex-wrap:wrap">
        <span style="background:${c}22;color:${c};border:1px solid ${c}44;font-size:10px;font-weight:700;padding:2px 8px;border-radius:10px;text-transform:uppercase">${esc(p.type||'announcement')}</span>
        ${p.published ? '<span style="background:#2D7A5522;color:#2D7A55;border:1px solid #2D7A5544;font-size:10px;font-weight:700;padding:2px 8px;border-radius:10px">Published</span>' : '<span style="background:#8B691422;color:#8B6914;border:1px solid #8B691444;font-size:10px;font-weight:700;padding:2px 8px;border-radius:10px">Draft</span>'}
        <span style="font-size:11px;color:#5C6B58">${dateStr(p.published_at||p.created_at)}</span>
      </div>
      <h3 style="margin:0 0 6px;font-size:15px;font-weight:800;color:#E8E4D9">${esc(p.title)}</h3>
      <p style="margin:0;font-size:13px;color:#6F7E6A;line-height:1.6">${esc((p.body||'').substring(0,200))}${(p.body||'').length>200?'…':''}</p>
    </div>
    <div style="display:flex;gap:8px;flex-shrink:0">
      <button onclick="window._gwAnnounceModal('${esc(p.id)}')" style="padding:6px 12px;background:rgba(77,138,134,.12);border:1px solid #4D8A8644;border-radius:8px;color:#4D8A86;font-size:12px;font-weight:700;cursor:pointer">Edit</button>
      ${!p.published ? `<button onclick="window._gwPublishAnnounce('${esc(p.id)}')" style="padding:6px 12px;background:#2D7A5522;border:1px solid #2D7A5544;border-radius:8px;color:#2D7A55;font-size:12px;font-weight:700;cursor:pointer">Publish</button>` : ''}
    </div>
  </div>
</div>`;
          }).join('')}
        </div>` : '<div style="padding:60px;text-align:center;color:#5C6B58">No announcements yet. Create your first post.</div>'
      )}
      <div id="gwAnnounceModalWrap"></div>
    `);

    window._gwAllAnnouncements = posts;
    window._gwAnnounceModal = function(id) {
      const post = id ? (window._gwAllAnnouncements||[]).find(p=>p.id===id) : null;
      _announceModal(post);
    };
    window._gwPublishAnnounce = async function(id) {
      try {
        await apiPut(`/api/platform/announcements/${id}`, { published:1, published_at: new Date().toISOString() });
        toast('Announcement published!');
        show('gwAnnounce');
      } catch(e) { toast('Error: ' + e.message); }
    };
  }

  function _announceModal(post) {
    const isEdit = !!post;
    const el = document.createElement('div');
    el.id = 'gwAnnounceModalOverlay';
    el.style.cssText = 'position:fixed;inset:0;background:#000c;z-index:9999;display:flex;align-items:center;justify-content:center;padding:20px';
    el.innerHTML = `
<div style="background:var(--card,#1E2B29);border:1px solid var(--line,#2A3A38);border-radius:20px;width:min(640px,100%);max-height:92vh;overflow-y:auto;padding:28px">
  <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:22px">
    <h2 style="margin:0;font-size:18px;font-weight:800;color:#E8E4D9">${isEdit ? 'Edit Post' : 'New Announcement'}</h2>
    <button onclick="document.getElementById('gwAnnounceModalOverlay').remove()" style="background:none;border:none;color:#6F7E6A;font-size:20px;cursor:pointer">✕</button>
  </div>
  <div style="display:grid;gap:14px">
    <div><label class="um-label">Title *</label>
      <input id="gwA-title" class="um-input" value="${esc(post?.title||'')}" placeholder="v2.4.0 — New email templates and pipeline improvements"></div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
      <div><label class="um-label">Type</label>
        <select id="gwA-type" class="um-input">
          ${['release','announcement','maintenance','urgent'].map(t=>`<option value="${t}" ${(post?.type||'release')===t?'selected':''}>${t.charAt(0).toUpperCase()+t.slice(1)}</option>`).join('')}
        </select></div>
      <div><label class="um-label">Status</label>
        <select id="gwA-published" class="um-input">
          <option value="0" ${!post?.published?'selected':''}>Draft</option>
          <option value="1" ${post?.published?'selected':''}>Published</option>
        </select></div>
    </div>
    <div><label class="um-label">Content *</label>
      <textarea id="gwA-body" class="um-input" rows="7" placeholder="Describe the release, changes, or announcement in detail…" style="resize:vertical;font-family:inherit">${esc(post?.body||'')}</textarea></div>
    <div><label class="um-label">Audience</label>
      <select id="gwA-audience" class="um-input">
        <option value="all" ${(post?.audience||'all')==='all'?'selected':''}>All Tenants</option>
        <option value="paid" ${post?.audience==='paid'?'selected':''}>Paid Plans Only</option>
        <option value="enterprise" ${post?.audience==='enterprise'?'selected':''}>Enterprise Only</option>
      </select></div>
  </div>
  <div style="display:flex;justify-content:space-between;align-items:center;margin-top:24px">
    ${isEdit ? dangerBtn('Delete',`window._gwDeleteAnnounce('${esc(post.id)}')`) : '<span></span>'}
    <div style="display:flex;gap:10px">
      <button class="secondary-btn" onclick="document.getElementById('gwAnnounceModalOverlay').remove()">Cancel</button>
      <button class="primary-btn" onclick="window._gwSaveAnnounce('${esc(post?.id||'')}')">${isEdit ? 'Save' : 'Create Draft'}</button>
    </div>
  </div>
</div>`;
    document.body.appendChild(el);

    window._gwSaveAnnounce = async function(existingId) {
      const payload = {
        title:     document.getElementById('gwA-title')?.value?.trim(),
        type:      document.getElementById('gwA-type')?.value,
        published: parseInt(document.getElementById('gwA-published')?.value)||0,
        body:      document.getElementById('gwA-body')?.value?.trim(),
        audience:  document.getElementById('gwA-audience')?.value,
      };
      if (!payload.title) { toast('Title required'); return; }
      if (!payload.body) { toast('Content required'); return; }
      try {
        if (existingId) { await apiPut(`/api/platform/announcements/${existingId}`, payload); toast('Updated'); }
        else { await apiPost('/api/platform/announcements', payload); toast('Draft saved'); }
        document.getElementById('gwAnnounceModalOverlay')?.remove();
        show('gwAnnounce');
      } catch(e) { toast('Error: ' + e.message); }
    };
    window._gwDeleteAnnounce = async function(id) {
      if (!confirm('Delete this post?')) return;
      try { await apiDelete(`/api/platform/announcements/${id}`); document.getElementById('gwAnnounceModalOverlay')?.remove(); toast('Deleted'); show('gwAnnounce'); }
      catch(e) { toast('Error: ' + e.message); }
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 6. BILLING & PLANS
  // ─────────────────────────────────────────────────────────────────────────
  async function billing() {
    const v = view(); if (!v) return;
    v.innerHTML = `<div style="padding:60px;text-align:center;color:#6F7E6A">Loading billing data…</div>`;

    let companies = [];
    try { companies = await apiGet('/api/admin/companies'); if (!Array.isArray(companies)) companies = []; }
    catch(e) { v.innerHTML = `<div style="padding:60px;text-align:center;color:#C97B6A">Error: ${esc(e.message)}</div>`; return; }

    // Live prices from the Pricing Plans table (fallback to real base prices)
    let _plans = [];
    try { _plans = await apiGet('/api/platform/pricing-plans'); if (!Array.isArray(_plans)) _plans = []; } catch(_) {}
    const PLAN_PRICES = { trial:0 };
    _plans.forEach(p => { PLAN_PRICES[p.id] = p.monthly_price || 0; });
    if (Object.keys(PLAN_PRICES).length <= 1) Object.assign(PLAN_PRICES, {starter:29,core:49,growth:65,pro:85,enterprise:0});
    const PLAN_IDS = _plans.length ? _plans.map(p=>p.id) : ['starter','core','growth','pro','enterprise'];
    const active = companies.filter(c => c.active);
    const mrr = active.reduce((s,c) => s + (PLAN_PRICES[c.plan]||0), 0);
    const arr = mrr * 12;
    const byPlan = {};
    ['trial',...PLAN_IDS].forEach(p => byPlan[p] = companies.filter(c=>c.plan===p));

    v.innerHTML = shell(
      'Billing & Plans',
      'Revenue overview and tenant plan management',
      'PLATFORM ADMIN › BILLING',
      '',
      `
      <!-- Revenue cards -->
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:16px;margin-bottom:28px">
        ${statCard('Monthly Revenue', fmtMoney(mrr), gwIcon('revenue',40,'#2D7A55'), '#2D7A55', 'est. MRR')}
        ${statCard('Annual Revenue',  fmtMoney(arr), gwIcon('reports',40,'#1A4740'), '#1A4740', 'est. ARR')}
        ${statCard('Paid Accounts',   fmt(active.filter(c=>c.plan!=='trial').length), gwIcon('success',40,'#4D8A86'), '#4D8A86')}
        ${statCard('On Trial',        fmt(byPlan.trial?.length||0), gwIcon('clock',40,'#8B6914'), '#8B6914', 'need conversion')}
      </div>

      <!-- Plan breakdown -->
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:16px;margin-bottom:28px">
        ${PLAN_IDS.map(plan => {
          const cos = byPlan[plan] || [];
          const rev = cos.filter(c=>c.active).length * (PLAN_PRICES[plan]||0);
          const c = PLAN_COLORS[plan];
          return `
<div style="background:var(--card,#fff);border:1px solid ${c}44;border-radius:16px;padding:22px">
  <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:14px">
    ${planBadge(plan)}
    <span style="font-size:11px;color:#5C6B58;font-weight:700">${fmtMoney(PLAN_PRICES[plan])}/mo each</span>
  </div>
  <div style="font-size:28px;font-weight:900;color:${c};margin-bottom:4px">${fmt(cos.length)}</div>
  <div style="font-size:12px;color:#6F7E6A;margin-bottom:10px">companies · ${fmtMoney(rev)}/mo</div>
  <div style="max-height:120px;overflow-y:auto">
    ${cos.slice(0,5).map(co=>`<div style="font-size:12px;color:#6F7E6A;padding:3px 0;display:flex;justify-content:space-between"><span>${esc(co.name)}</span><span style="color:${co.active?'#2D7A55':'#C97B6A'}">${co.active?'Active':'Inactive'}</span></div>`).join('')}
    ${cos.length>5?`<div style="font-size:11px;color:#5C6B58;margin-top:4px">+ ${cos.length-5} more</div>`:''}
  </div>
</div>`;
        }).join('')}
      </div>

      <!-- Full billing table -->
      ${panel('All Accounts',
        `<span style="font-size:12px;color:#5C6B58">${companies.length} total</span>`,
        `<div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse;font-size:13px">
          <thead><tr>${['Company','Plan','MRR','Status','Reps','Owner','Actions'].map(h=>`<th style="padding:11px 14px;text-align:left;color:#5C6B58;font-weight:700;font-size:11px;text-transform:uppercase;letter-spacing:.05em">${h}</th>`).join('')}</tr></thead>
          <tbody>
          ${companies.map(co => `
          <tr onmouseover="this.style.background='rgba(255,255,255,.03)'" onmouseout="this.style.background=''">
            <td style="padding:12px 14px;font-weight:700;color:#E8E4D9">${esc(co.name)}</td>
            <td style="padding:12px 14px">${planBadge(co.plan)}</td>
            <td style="padding:12px 14px;color:#2D7A55;font-weight:700">${co.active && co.plan!=='trial' ? fmtMoney(PLAN_PRICES[co.plan]||0) : co.plan==='trial'?'<span style="color:#8B6914">Trial</span>':'—'}</td>
            <td style="padding:12px 14px"><span style="color:${co.active?'#2D7A55':'#C97B6A'};font-size:12px;font-weight:700">${co.active?'● Active':'○ Inactive'}</span></td>
            <td style="padding:12px 14px;color:#6F7E6A;text-align:center">${fmt(co.rep_count)}</td>
            <td style="padding:12px 14px;color:#6F7E6A;font-size:12px">${esc(co.owner_email||'—')}</td>
            <td style="padding:12px 14px">
              <select onchange="window._gwChangePlan('${esc(co.id)}',this.value)" style="padding:5px 10px;border-radius:8px;border:1px solid var(--line,#e5e5e0);background:transparent;color:#6F7E6A;font-size:12px;cursor:pointer">
                ${['trial','starter','core','growth','pro','enterprise'].map(p=>`<option value="${p}" ${co.plan===p?'selected':''}>${p.charAt(0).toUpperCase()+p.slice(1)}</option>`).join('')}
              </select>
            </td>
          </tr>`).join('')}
          </tbody>
        </table></div>`
      )}
    `);

    window._gwChangePlan = async function(companyId, newPlan) {
      try {
        await apiPut(`/api/admin/companies/${companyId}`, { plan: newPlan });
        toast(`Plan updated to ${newPlan}`);
      } catch(e) { toast('Error: ' + e.message); show('gwBilling'); }
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 7. PLATFORM SETTINGS
  // ─────────────────────────────────────────────────────────────────────────
  function platformSettings() {
    const v = view(); if (!v) return;
    v.innerHTML = shell(
      'Platform Settings',
      'Global configuration for Groundwork CRM',
      'PLATFORM ADMIN › SETTINGS',
      '',
      `
      <div style="display:grid;gap:20px">

        <!-- Account -->
        ${panel('Platform Account',
          '',
          `<div style="padding:24px;display:grid;gap:18px">
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px">
              <div>
                <div style="font-size:11px;font-weight:700;color:#5C6B58;text-transform:uppercase;letter-spacing:.06em;margin-bottom:6px">Platform Owner</div>
                <div style="font-size:15px;font-weight:700;color:#E8E4D9">Tyler Johnson</div>
                <div style="font-size:13px;color:#6F7E6A">tyler@groundwork-crm.com</div>
              </div>
              <div>
                <div style="font-size:11px;font-weight:700;color:#5C6B58;text-transform:uppercase;letter-spacing:.06em;margin-bottom:6px">Platform Role</div>
                <div style="font-size:15px;font-weight:700;color:#4D8A86">Super Administrator</div>
                <div style="font-size:13px;color:#6F7E6A">Full system access</div>
              </div>
            </div>
            <div>
              <label class="um-label">Change Password</label>
              <div style="display:flex;gap:10px;align-items:center">
                <input id="gwPS-newPw" class="um-input" type="password" placeholder="New password (min 4 chars)" style="max-width:320px">
                <button onclick="window._gwChangePlatformPw()" style="padding:10px 18px;background:#4D8A86;border:none;border-radius:10px;color:#fff;font-size:13px;font-weight:700;cursor:pointer">Update</button>
              </div>
            </div>
          </div>`
        )}

        <!-- Google Workspace (platform owner: tyler@groundwork-crm.com) -->
        ${panel('Google Workspace — Platform Account',
          '',
          `<div style="padding:24px" id="gwPS-gws-body">
            <div style="color:#6F7E6A;font-size:13px">Checking connection…</div>
          </div>`
        )}

        <!-- AI (platform master key + tenant entitlements + usage) -->
        ${panel('AI — Platform Master Key & Tenant Access',
          '',
          `<div style="padding:24px;display:grid;gap:20px" id="gwPS-ai-body">
            <div class="spinner-wrap"><div class="spinner"></div></div>
          </div>`
        )}

        <!-- Impersonation log -->
        ${panel('Impersonation & Access Log',
          '',
          `<div style="padding:24px">
            <p style="color:#6F7E6A;font-size:13px;line-height:1.6;margin:0 0 16px">
              Impersonation sessions allow viewing a customer tenant's data as if you were a member of that company.
              Sessions are tied to your existing cookie — refreshing the page restores your platform admin context.
            </p>
            <div style="background:rgba(255,255,255,.04);border:1px solid var(--line,#e5e5e0);border-radius:10px;padding:14px">
              <div style="font-size:12px;color:#5C6B58">Recent impersonation sessions are not persisted — refresh the page to exit any active impersonation.</div>
            </div>
          </div>`
        )}

        <!-- Danger zone -->
        ${panel('Danger Zone',
          '',
          `<div style="padding:24px;display:grid;gap:12px">
            <div style="display:flex;align-items:center;justify-content:space-between;padding:16px;background:#C97B6A0A;border:1px solid #C97B6A33;border-radius:12px">
              <div>
                <div style="font-weight:700;color:#E8E4D9;margin-bottom:3px">Clear All Platform Sessions</div>
                <div style="font-size:12px;color:#6F7E6A">Force all users across all tenants to re-authenticate</div>
              </div>
              ${dangerBtn('Clear Sessions','window._gwClearSessions()')}
            </div>
          </div>`
        )}

      </div>
    `);

    // ── Google Workspace panel loader ───────────────────────────────────
    window._gwLoadGwsPanel = async function() {
      const body = document.getElementById('gwPS-gws-body');
      if (!body) return;
      let st = { connected:false, email:'' };
      try {
        const r = await fetch('/api/google/status', { credentials:'include' });
        const j = await r.json();
        st = (j.data ?? j) || st;
      } catch(_) {}
      if (st.connected) {
        body.innerHTML = `
          <div style="display:flex;align-items:center;justify-content:space-between;gap:14px;flex-wrap:wrap">
            <div style="display:flex;align-items:center;gap:14px">
              <div style="width:44px;height:44px;border-radius:12px;background:linear-gradient(135deg,rgba(45,122,85,.2),rgba(77,138,134,.12));display:flex;align-items:center;justify-content:center;font-size:20px">✓</div>
              <div>
                <div style="font-weight:800;color:#2D7A55;font-size:14px">Google Workspace connected</div>
                <div style="font-size:13px;color:#6F7E6A;margin-top:2px">${esc(st.email||'tyler@groundwork-crm.com')}${st.connected_at ? ' · since ' + dateStr(st.connected_at) : ''}</div>
                <div style="font-size:12px;color:#5C6B58;margin-top:4px">Gmail send, Calendar sync, and Drive are live for the platform account. AI follow-up emails and demo scheduling can use this connection.</div>
              </div>
            </div>
            ${dangerBtn('Disconnect','window._gwGwsDisconnect()')}
          </div>`;
      } else {
        body.innerHTML = `
          <div style="display:flex;align-items:center;justify-content:space-between;gap:14px;flex-wrap:wrap">
            <div style="min-width:0;flex:1">
              <div style="font-weight:800;color:#E8E4D9;font-size:14px;margin-bottom:4px">Connect tyler@groundwork-crm.com</div>
              <div style="font-size:13px;color:#6F7E6A;line-height:1.6">
                Link the Groundwork Google Workspace account to send email from the platform (demo confirmations, follow-ups),
                sync your calendar for demo scheduling, and access Drive — all from Platform Admin.
              </div>
            </div>
            ${primaryBtn('Connect Google Workspace','window._gwGwsConnect()')}
          </div>`;
      }
    };
    window._gwGwsConnect = async function() {
      if (typeof window.gwGoogleOAuthConnect !== 'function') { toast('Integrations module not loaded — refresh the page'); return; }
      const ok = await window.gwGoogleOAuthConnect();
      if (ok) toast('Google Workspace connected');
      window._gwLoadGwsPanel();
    };
    window._gwGwsDisconnect = async function() {
      if (!confirm('Disconnect the platform Google Workspace account?')) return;
      try {
        await apiDelete('/api/google/disconnect');
        toast('Disconnected');
      } catch(e) { toast('Error: ' + e.message); }
      window._gwLoadGwsPanel();
    };
    window._gwLoadGwsPanel();

    // ── AI panel loader ─────────────────────────────────────────────────
    window._gwLoadAiPanel = async function() {
      const body = document.getElementById('gwPS-ai-body');
      if (!body) return;
      let d;
      try { d = await apiGet('/api/admin/ai'); } catch(e) {
        body.innerHTML = `<div style="color:#C97B6A;font-size:13px">Failed to load AI settings: ${esc(e.message)}</div>`;
        return;
      }
      const keyLine = d.platform_key_set
        ? `<span style="color:#2D7A55;font-weight:700">✓ Master key saved</span> <span style="font-family:monospace;color:#6F7E6A">(${esc(d.platform_key_masked)})</span> — saving a new one replaces it.`
        : `<span style="color:#C97B6A;font-weight:700">No master key saved yet.</span> Paste your OpenAI key below.`;
      const rows = (d.companies || []).map(co => {
        const u = co.usage_30d || {};
        // Month-to-date quota bar (platform-key usage vs plan cap)
        const cap = Number(co.ai_cap) || 0;
        const used = Number(co.ai_used_mtd) || 0;
        const pct = cap > 0 ? Math.min(100, Math.round(used / cap * 100)) : 0;
        const barColor = cap > 0 && used >= cap ? '#C9564A' : (cap > 0 && pct >= 80 ? '#C9A24A' : '#4D8A86');
        const quotaBar = cap > 0
          ? `<div style="min-width:110px">
               <div style="font-size:11px;color:#E8E4D9;margin-bottom:3px">${fmt(used)} / ${fmt(cap)} <span style="color:#5C6B58">this mo</span>${used >= cap ? ' <span style="color:#C9564A;font-weight:700">BLOCKED</span>' : (pct >= 80 ? ' <span style="color:#C9A24A;font-weight:700">80%+</span>' : '')}</div>
               <div style="height:5px;background:rgba(255,255,255,.08);border-radius:3px;overflow:hidden"><div style="height:100%;width:${pct}%;background:${barColor};border-radius:3px"></div></div>
             </div>`
          : `<div style="font-size:11px;color:#6F7E6A">${fmt(used)} this mo · <span style="color:#4D8A86;font-weight:700">unlimited</span></div>`;
        return `
        <tr style="border-bottom:1px solid var(--line,#2A3A38)">
          <td style="padding:10px 8px">
            <div style="font-weight:700;color:#E8E4D9">${esc(co.name)}</div>
            <div style="font-size:11px;color:#6F7E6A">${esc(co.id)}${co.has_byok ? ' · <span style="color:#4D8A86">own key (BYOK — never capped)</span>' : ''}</div>
          </td>
          <td style="padding:10px 8px;text-align:center;font-size:12px;color:#E8E4D9">${fmt(u.platform_actions||0)} <span style="color:#5C6B58">actions</span><div style="font-size:10px;color:#5C6B58">${fmt(u.platform_tokens||0)} tokens</div></td>
          <td style="padding:10px 8px;text-align:center">
            <select onchange="window._gwSetAiPlan('${esc(co.id)}', this.value, this)" style="padding:5px 8px;background:rgba(255,255,255,.06);border:1px solid var(--line,#2A3A38);border-radius:8px;color:#E8E4D9;font-size:12px;cursor:pointer">
              <optgroup label="CRM plan included">
                <option value="starter" ${co.ai_plan==='starter'?'selected':''}>Starter · 50/mo</option>
                <option value="core" ${co.ai_plan==='core'?'selected':''}>Core · 100/mo</option>
                <option value="growth" ${co.ai_plan==='growth'?'selected':''}>Growth · 250/mo</option>
                <option value="pro" ${co.ai_plan==='pro'?'selected':''}>Pro · 500/mo</option>
              </optgroup>
              <optgroup label="AI packages">
                <option value="essentials" ${co.ai_plan==='essentials'?'selected':''}>AI Essentials · 500/mo</option>
                <option value="plus" ${co.ai_plan==='plus'?'selected':''}>AI Plus · 1,500/mo</option>
                <option value="max" ${co.ai_plan==='max'?'selected':''}>AI Max · 5,000/mo</option>
              </optgroup>
              <optgroup label="Uncapped">
                <option value="enterprise" ${co.ai_plan==='enterprise'?'selected':''}>Enterprise · custom</option>
                <option value="unlimited" ${co.ai_plan==='unlimited'?'selected':''}>Unlimited</option>
              </optgroup>
            </select>
          </td>
          <td style="padding:10px 8px;text-align:center">${quotaBar}</td>
          <td style="padding:10px 8px;text-align:right">
            <label style="display:inline-flex;align-items:center;gap:8px;cursor:pointer;font-size:12px;font-weight:700;color:${co.ai_enabled?'#2D7A55':'#6F7E6A'}">
              <input type="checkbox" ${co.ai_enabled?'checked':''} onchange="window._gwToggleAi('${esc(co.id)}', this.checked, this)" style="width:16px;height:16px;accent-color:#2D7A55;cursor:pointer">
              ${co.ai_enabled ? 'AI ON' : 'AI OFF'}
            </label>
          </td>
        </tr>`;
      }).join('');
      body.innerHTML = `
        <div>
          <div style="font-size:11px;font-weight:700;color:#5C6B58;text-transform:uppercase;letter-spacing:.06em;margin-bottom:6px">Platform Master OpenAI Key</div>
          <div style="font-size:13px;margin-bottom:10px">${keyLine}</div>
          <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
            <input id="gwPS-ai-key" class="um-input" type="password" placeholder="sk-…" style="max-width:340px;font-family:monospace">
            <button onclick="window._gwSaveAiKey()" style="padding:10px 18px;background:#4D8A86;border:none;border-radius:10px;color:#fff;font-size:13px;font-weight:700;cursor:pointer">Save Master Key</button>
            <button id="gwPS-ai-test-btn" onclick="window._gwTestAiKey()" ${d.platform_key_set?'':'disabled'} style="padding:10px 18px;background:${d.platform_key_set?'#2D7A55':'#3a4a48'};border:none;border-radius:10px;color:#fff;font-size:13px;font-weight:700;cursor:${d.platform_key_set?'pointer':'not-allowed'}">⚡ Test AI</button>
          </div>
          <div id="gwPS-ai-test-result" style="margin-top:10px"></div>
          <div style="font-size:11px;color:#6F7E6A;margin-top:8px;line-height:1.6">
            This ONE key powers AI for every tenant you enable below. Their usage is metered per-company so you can bill it back.
            Companies can alternatively paste their own key (BYOK) in their Integrations → Admin Setup — BYOK usage never touches your key.
          </div>
        </div>
        <div>
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;flex-wrap:wrap;gap:8px">
            <div style="font-size:11px;font-weight:700;color:#5C6B58;text-transform:uppercase;letter-spacing:.06em">Tenant AI Access & 30-Day Usage (on your key)</div>
            <button onclick="window._gwLoadAiPanel()" style="padding:5px 12px;background:rgba(255,255,255,.06);border:1px solid var(--line,#2A3A38);border-radius:8px;color:#6F7E6A;font-size:11px;font-weight:700;cursor:pointer">↻ Refresh</button>
          </div>
          ${(d.companies||[]).length ? `
          <table style="width:100%;border-collapse:collapse;font-size:13px">
            <thead><tr style="border-bottom:1px solid var(--line,#2A3A38)">
              <th style="text-align:left;padding:8px;font-size:10px;font-weight:700;color:#5C6B58;text-transform:uppercase;letter-spacing:.06em">Company</th>
              <th style="text-align:center;padding:8px;font-size:10px;font-weight:700;color:#5C6B58;text-transform:uppercase;letter-spacing:.06em">30-Day Usage</th>
              <th style="text-align:center;padding:8px;font-size:10px;font-weight:700;color:#5C6B58;text-transform:uppercase;letter-spacing:.06em">AI Plan</th>
              <th style="text-align:center;padding:8px;font-size:10px;font-weight:700;color:#5C6B58;text-transform:uppercase;letter-spacing:.06em">Month Quota</th>
              <th style="text-align:right;padding:8px;font-size:10px;font-weight:700;color:#5C6B58;text-transform:uppercase;letter-spacing:.06em">Platform Key Access</th>
            </tr></thead>
            <tbody>${rows}</tbody>
          </table>` : '<div style="font-size:13px;color:#6F7E6A">No tenant companies yet.</div>'}
        </div>`;
    };
    window._gwSetAiPlan = async function(companyId, plan, el) {
      if (el) el.disabled = true;
      try {
        await apiPut('/api/admin/ai/company/' + companyId, { ai_plan: plan });
        toast('AI plan for ' + companyId + ' → ' + plan);
        window._gwLoadAiPanel();
      } catch(e) { toast('Error: ' + e.message); if (el) el.disabled = false; }
    };
    window._gwSaveAiKey = async function() {
      const key = document.getElementById('gwPS-ai-key')?.value?.trim();
      if (!key) { toast('Paste your OpenAI key first'); return; }
      try {
        await apiPut('/api/settings', { key: 'openai_api_key', value: key });
        toast('Master AI key saved');
        window._gwLoadAiPanel();
      } catch(e) { toast('Error: ' + e.message); }
    };
    window._gwTestAiKey = async function() {
      const out = document.getElementById('gwPS-ai-test-result');
      const btn = document.getElementById('gwPS-ai-test-btn');
      if (out) out.innerHTML = '<div style="font-size:12px;color:#8B9491">Testing — calling OpenAI with your master key…</div>';
      if (btn) { btn.disabled = true; btn.textContent = 'Testing…'; }
      try {
        const r = await fetch('/api/admin/ai/test', { method:'POST', credentials:'include', headers:{'Content-Type':'application/json'}, body:'{}' });
        const j = await r.json();
        const d2 = j.data || j;
        if (r.ok && j.ok !== false) {
          out.innerHTML = `<div style="padding:12px 14px;background:#2D7A5514;border:1px solid #2D7A5544;border-radius:10px;font-size:13px;color:#2D7A55">
            <strong>✓ AI is LIVE.</strong> Model <span style="font-family:monospace">${esc(d2.model||'')}</span> replied:
            <em style="color:#E8E4D9">"${esc(d2.reply||'')}"</em>
            <span style="color:#6F7E6A"> · ${fmt(d2.tokens||0)} tokens (logged to usage ledger)</span></div>`;
        } else {
          out.innerHTML = `<div style="padding:12px 14px;background:#C97B6A14;border:1px solid #C97B6A44;border-radius:10px;font-size:13px;color:#C97B6A">
            <strong>✗ Test failed.</strong> ${esc(j.message||d2.message||'Unknown error')}
            ${j.detail?`<div style="font-size:11px;color:#8B9491;margin-top:6px;font-family:monospace;word-break:break-all">${esc(String(j.detail).slice(0,200))}</div>`:''}</div>`;
        }
      } catch(e) {
        out.innerHTML = `<div style="font-size:13px;color:#C97B6A">✗ ${esc(e.message)}</div>`;
      }
      if (btn) { btn.disabled = false; btn.textContent = '⚡ Test AI'; }
    };
    window._gwToggleAi = async function(companyId, enabled, el) {
      try {
        await apiPut('/api/admin/ai/company/' + companyId, { ai_enabled: enabled });
        toast((enabled ? 'AI enabled for ' : 'AI disabled for ') + companyId);
        window._gwLoadAiPanel();
      } catch(e) { toast('Error: ' + e.message); if (el) el.checked = !enabled; }
    };
    window._gwLoadAiPanel();

    window._gwChangePlatformPw = async function() {
      const pw = document.getElementById('gwPS-newPw')?.value;
      if (!pw || pw.length < 4) { toast('Password must be at least 4 characters'); return; }
      try {
        await apiPut('/api/reps/gw_tyler', { password: pw });
        document.getElementById('gwPS-newPw').value = '';
        toast('Password updated');
      } catch(e) { toast('Error: ' + e.message); }
    };
    window._gwClearSessions = async function() {
      if (!confirm('This will sign out ALL users across ALL tenants. Continue?')) return;
      try {
        await apiPost('/api/admin/clear-sessions', {});
        toast('All sessions cleared');
      } catch(e) { toast('Error: ' + e.message); }
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // SHARED: Impersonate modal
  // ─────────────────────────────────────────────────────────────────────────
  function _impersonateModal() {
    return `
<div id="gwImpersonateOverlay" style="display:none;position:fixed;inset:0;background:#000c;z-index:9999;align-items:center;justify-content:center">
  <div style="background:var(--card,#1E2B29);border:1px solid var(--line,#2A3A38);border-radius:20px;width:min(440px,92vw);padding:28px">
    <h2 style="margin:0 0 10px;font-size:20px;font-weight:800;color:#E8E4D9">Impersonate Company</h2>
    <p id="gwImpersonateMsg" style="color:#6F7E6A;margin:0 0 24px;font-size:14px;line-height:1.6"></p>
    <div style="display:flex;gap:12px">
      <button id="gwImpersonateConfirmBtn" style="flex:1;padding:12px;background:#8B6914;border:none;border-radius:10px;color:#fff;font-size:14px;font-weight:800;cursor:pointer">Confirm</button>
      <button onclick="document.getElementById('gwImpersonateOverlay').style.display='none'" style="padding:12px 20px;background:rgba(255,255,255,.07);border:1px solid var(--line,#2A3A38);border-radius:10px;color:#6F7E6A;font-size:14px;cursor:pointer">Cancel</button>
    </div>
  </div>
</div>`;
  }

  async function _gwImpersonate(companyId, companyName) {
    const overlay = document.getElementById('gwImpersonateOverlay');
    const msg     = document.getElementById('gwImpersonateMsg');
    const btn     = document.getElementById('gwImpersonateConfirmBtn');
    if (!overlay) return;
    msg.textContent = `You'll view "${companyName}" as a member of that company. Your platform session cookie is preserved — refresh to return to Platform Admin.`;
    overlay.style.display = 'flex';
    btn.onclick = async () => {
      btn.textContent = 'Switching…'; btn.disabled = true;
      try {
        const res = await fetch('/api/admin/impersonate', {
          method:'POST', credentials:'include',
          headers:{'Content-Type':'application/json'},
          body: JSON.stringify({ companyId })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Failed');
        window._d1Ready = false; window._d1SessionRep = null; window._companyId = companyId;
        // Tenant guard: wipe cached client state so the new company's data doesn't mix
        try {
          if (typeof window.gwClearTenantState === 'function') window.gwClearTenantState();
          localStorage.setItem('gwLastCompany', companyId);
        } catch(_) {}
        if (typeof showToast === 'function') showToast(`Switched to ${companyName} — reloading…`, 3000);
        overlay.style.display = 'none';
        setTimeout(() => location.reload(), 1000);
      } catch(e) {
        if (typeof showToast === 'function') showToast('Impersonate failed: ' + e.message, 4000);
        btn.textContent = 'Confirm'; btn.disabled = false;
      }
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 8. DEMO REQUESTS (intake from groundwork-crm.info + manual)
  // ─────────────────────────────────────────────────────────────────────────
  const DEMO_STATUSES = ['requested','scheduled','completed','no_show','converted','cancelled'];
  const DEMO_STATUS_COLORS = { requested:'#8B6914', scheduled:'#4D8A86', completed:'#2D7A55', no_show:'#C97B6A', converted:'#7B5EA7', cancelled:'#6F7E6A' };
  const demoStatusBadge = s => {
    const c = DEMO_STATUS_COLORS[s] || '#6F7E6A';
    const label = (s||'').replace(/_/g,' ').replace(/\b\w/g,l=>l.toUpperCase());
    return `<span style="display:inline-block;background:${c}22;color:${c};border:1px solid ${c}44;font-size:10px;font-weight:700;padding:2px 8px;border-radius:10px;text-transform:uppercase;letter-spacing:.04em">${esc(label)}</span>`;
  };

  async function demos() {
    const v = view(); if (!v) return;
    v.innerHTML = `<div style="padding:60px;text-align:center;color:#6F7E6A">Loading demo requests…</div>`;

    let rows = [];
    try { rows = await apiGet('/api/platform/demos'); if (!Array.isArray(rows)) rows = []; }
    catch(e) { v.innerHTML = `<div style="padding:60px;text-align:center;color:#C97B6A">Error: ${esc(e.message)}</div>`; return; }

    const byStatus = {};
    DEMO_STATUSES.forEach(s => byStatus[s] = rows.filter(d=>d.status===s).length);
    const fromSite = rows.filter(d => d.source === 'website').length;

    v.innerHTML = shell(
      'Demo Requests',
      'Demo signups from groundwork-crm.info plus manually scheduled demos — convert winners into pipeline leads',
      'PLATFORM ADMIN › DEMOS',
      `${actionBtn('↺ Refresh','show(\'gwDemos\')')}
       ${primaryBtn('+ Log Demo','window._gwDemoModal(null)')}`,
      `
      <div class="gw-pa-stat-grid" style="margin-bottom:24px">
        ${statCard('Requested', fmt(byStatus.requested||0), gwI('clock',40,'#8B6914'), '#8B6914', 'awaiting scheduling')}
        ${statCard('Scheduled', fmt(byStatus.scheduled||0), gwI('calendar',40,'#4D8A86'), '#4D8A86', 'on the calendar')}
        ${statCard('Completed', fmt(byStatus.completed||0), gwI('check',40,'#2D7A55'), '#2D7A55', 'demo delivered')}
        ${statCard('Converted', fmt(byStatus.converted||0), gwI('trophy',40,'#7B5EA7'), '#7B5EA7', 'became pipeline leads')}
        ${statCard('From Website', fmt(fromSite), gwI('globe',40,'#1A4740'), '#1A4740', 'groundwork-crm.info')}
      </div>

      <!-- Status filter pills -->
      <div style="display:flex;gap:10px;margin-bottom:20px;flex-wrap:wrap">
        ${['all',...DEMO_STATUSES].map(s => `
        <button onclick="window._gwFilterDemos('${s}')" id="gwDemoFilter_${s}"
          style="padding:7px 14px;border-radius:20px;border:1px solid ${s==='all'?'#4D8A86':'var(--line,#e5e5e0)'};
                 background:${s==='all'?'rgba(77,138,134,.15)':'transparent'};
                 color:${s==='all'?'#4D8A86':'#6F7E6A'};font-size:12px;font-weight:700;cursor:pointer">
          ${s==='all'?'All':s.replace(/_/g,' ').replace(/\b\w/g,c=>c.toUpperCase())}
          <span style="margin-left:4px;opacity:.7">${s==='all'?rows.length:(byStatus[s]||0)}</span>
        </button>`).join('')}
      </div>

      ${panel('Demo Requests',
        `<span style="font-size:12px;color:#5C6B58" id="gwDemoCount">${rows.length} total</span>`,
        `<div id="gwDemosList">
          ${rows.length ? rows.map(_demoRow).join('') : `<div style="padding:60px;text-align:center;color:#5C6B58">
            No demo requests yet.<br><br>
            <span style="font-size:12px">Wire your marketing site to <code style="background:rgba(77,138,134,.12);padding:2px 8px;border-radius:6px;color:#4D8A86">POST /api/public/demo-request</code> — new signups will appear here automatically.</span>
          </div>`}
        </div>`
      )}
      <div id="gwDemoModalWrap"></div>
    `);

    window._gwAllDemos = rows;
    window._gwFilterDemos = function(status) {
      document.querySelectorAll('[id^="gwDemoFilter_"]').forEach(b => {
        const active = b.id === 'gwDemoFilter_' + status;
        b.style.background = active ? 'rgba(77,138,134,.15)' : 'transparent';
        b.style.borderColor = active ? '#4D8A86' : 'var(--line,#e5e5e0)';
        b.style.color = active ? '#4D8A86' : '#6F7E6A';
      });
      const filtered = status === 'all' ? rows : rows.filter(d => d.status === status);
      document.getElementById('gwDemosList').innerHTML = filtered.length
        ? filtered.map(_demoRow).join('')
        : '<div style="padding:40px;text-align:center;color:#5C6B58">No demos in this status.</div>';
      document.getElementById('gwDemoCount').textContent = filtered.length + ' total';
    };
    window._gwDemoModal = function(id) {
      const demo = id ? (window._gwAllDemos||[]).find(d=>d.id===id) : null;
      _demoModal(demo);
    };
    window._gwConvertDemo = async function(id) {
      if (!confirm('Convert this demo request into a Sales Pipeline lead?')) return;
      try {
        const r = await apiPost(`/api/platform/demos/${id}/convert`, {});
        await apiPut(`/api/platform/demos/${id}`, { status: 'converted' });
        toast(r.existing ? 'Already linked to a lead' : 'Converted to pipeline lead');
        show('gwLeads');
      } catch(e) { toast('Error: ' + e.message); }
    };
  }

  function _demoRow(d) {
    return `
<div onclick="window._gwDemoModal('${esc(d.id)}')"
  style="display:flex;align-items:center;gap:14px;padding:16px 20px;border-bottom:1px solid var(--line,#e5e5e0);cursor:pointer;transition:background .12s"
  onmouseover="this.style.background='rgba(77,138,134,.05)'" onmouseout="this.style.background=''">
  <div style="width:38px;height:38px;border-radius:10px;background:linear-gradient(135deg,rgba(77,138,134,.2),rgba(26,71,64,.15));display:flex;align-items:center;justify-content:center;font-weight:800;color:#4D8A86;font-size:14px;flex-shrink:0">
    ${esc((d.contact_name||d.company_name||'?').trim().charAt(0).toUpperCase())}
  </div>
  <div style="flex:1;min-width:0">
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:3px;flex-wrap:wrap">
      <span style="font-weight:700;font-size:14px;color:#E8E4D9">${esc(d.company_name||d.contact_name||'Unknown')}</span>
      ${d.source==='website' ? '<span style="font-size:10px;font-weight:700;color:#1A4740;background:rgba(26,71,64,.14);border:1px solid rgba(26,71,64,.3);padding:2px 7px;border-radius:8px;letter-spacing:.04em">WEBSITE</span>' : ''}
    </div>
    <div style="font-size:12px;color:#5C6B58">${esc(d.contact_name||'')}${d.email?' · '+esc(d.email):''}${d.phone?' · '+esc(d.phone):''} · ${ago(d.created_at)}</div>
    ${d.message ? `<div style="font-size:12px;color:#6F7E6A;margin-top:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:640px">"${esc(d.message.substring(0,140))}${d.message.length>140?'…':''}"</div>` : ''}
  </div>
  <div style="display:flex;flex-direction:column;align-items:flex-end;gap:6px;flex-shrink:0">
    ${demoStatusBadge(d.status)}
    ${d.scheduled_at ? `<span style="font-size:11px;color:#4D8A86;font-weight:700">${dateStr(d.scheduled_at)}</span>` : `<span style="font-size:11px;color:#5C6B58">${ago(d.updated_at||d.created_at)}</span>`}
  </div>
</div>`;
  }

  function _demoModal(demo) {
    const isEdit = !!demo;
    const el = document.createElement('div');
    el.id = 'gwDemoModalOverlay';
    el.style.cssText = 'position:fixed;inset:0;background:#000c;z-index:9999;display:flex;align-items:center;justify-content:center;padding:20px';
    el.innerHTML = `
<div style="background:var(--card,#1E2B29);border:1px solid var(--line,#2A3A38);border-radius:20px;width:min(640px,100%);max-height:92vh;overflow-y:auto;padding:28px">
  <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:22px">
    <h2 style="margin:0;font-size:18px;font-weight:800;color:#E8E4D9">${isEdit ? 'Demo Request' : 'Log Demo Request'}</h2>
    <button onclick="document.getElementById('gwDemoModalOverlay').remove()" style="background:none;border:none;color:#6F7E6A;font-size:20px;cursor:pointer">✕</button>
  </div>
  ${isEdit && demo.message ? `
  <div style="background:rgba(77,138,134,.07);border:1px solid rgba(77,138,134,.2);border-radius:12px;padding:14px 16px;margin-bottom:18px">
    <div style="font-size:11px;font-weight:800;color:#4D8A86;text-transform:uppercase;letter-spacing:.06em;margin-bottom:6px">Their message${demo.source_page?` · from ${esc(demo.source_page)}`:''}</div>
    <div style="font-size:13px;color:#6F7E6A;line-height:1.6;white-space:pre-wrap">${esc(demo.message)}</div>
  </div>` : ''}
  <div style="display:grid;gap:14px">
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
      <div><label class="um-label">Company</label>
        <input id="gwD-company" class="um-input" value="${esc(demo?.company_name||'')}" placeholder="Prospect Inc."></div>
      <div><label class="um-label">Contact Name *</label>
        <input id="gwD-contact" class="um-input" value="${esc(demo?.contact_name||'')}" placeholder="Jane Smith"></div>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
      <div><label class="um-label">Email</label>
        <input id="gwD-email" class="um-input" type="email" value="${esc(demo?.email||'')}" placeholder="jane@prospect.com"></div>
      <div><label class="um-label">Phone</label>
        <input id="gwD-phone" class="um-input" type="tel" value="${esc(demo?.phone||'')}" placeholder="(555) 000-0000"></div>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
      <div><label class="um-label">Status</label>
        <select id="gwD-status" class="um-input">
          ${DEMO_STATUSES.map(s=>`<option value="${s}" ${(demo?.status||'requested')===s?'selected':''}>${s.replace(/_/g,' ').replace(/\b\w/g,c=>c.toUpperCase())}</option>`).join('')}
        </select></div>
      <div><label class="um-label">Scheduled Date/Time</label>
        <input id="gwD-scheduled" class="um-input" type="datetime-local" value="${demo?.scheduled_at ? esc(String(demo.scheduled_at).slice(0,16)) : ''}"></div>
    </div>
    <div><label class="um-label">Notes</label>
      <textarea id="gwD-notes" class="um-input" rows="3" placeholder="Prep notes, follow-up items…" style="resize:vertical">${esc(demo?.notes||'')}</textarea></div>
  </div>
  ${isEdit ? `
  <div style="margin-top:20px;border:1px solid var(--line,#2A3A38);border-radius:14px;overflow:hidden">
    <div style="display:flex;justify-content:space-between;align-items:center;padding:12px 16px;background:rgba(77,138,134,.07)">
      <div style="font-size:12px;font-weight:800;letter-spacing:.06em;text-transform:uppercase;color:#4D8A86">Sales Playbook</div>
      <div id="gwDPlaybookPct" style="font-size:12px;font-weight:800;color:#4D8A86"></div>
    </div>
    <div id="gwDPlaybookBar" style="height:5px;background:rgba(111,126,106,.15)"><div id="gwDPlaybookFill" style="height:100%;width:0%;background:#4D8A86;transition:width .3s"></div></div>
    <div id="gwDPlaybook" style="max-height:300px;overflow-y:auto;padding:6px 16px 12px">
      <div style="padding:16px;text-align:center;color:#6F7E6A;font-size:12px">Loading playbook…</div>
    </div>
  </div>` : ''}
  <div style="display:flex;justify-content:space-between;align-items:center;margin-top:24px;flex-wrap:wrap;gap:10px">
    <div style="display:flex;gap:8px">
      ${isEdit ? dangerBtn('Delete',`window._gwDeleteDemo('${esc(demo.id)}')`) : '<span></span>'}
      ${isEdit && !demo.lead_id ? actionBtn('→ Convert to Lead',`window._gwConvertDemo('${esc(demo.id)}')`) : ''}
      ${isEdit && demo.lead_id ? `<span style="font-size:12px;color:#2D7A55;font-weight:700;align-self:center">✓ Linked to pipeline lead</span>` : ''}
    </div>
    <div style="display:flex;gap:10px">
      <button class="secondary-btn" onclick="document.getElementById('gwDemoModalOverlay').remove()">Cancel</button>
      <button class="primary-btn" onclick="window._gwSaveDemo('${esc(demo?.id||'')}')">${isEdit ? 'Save' : 'Add Demo'}</button>
    </div>
  </div>
</div>`;
    document.body.appendChild(el);

    // ── Embedded Sales Playbook (edit mode only) ─────────────────────────
    if (isEdit) (async () => {
      try {
        const [tplData, prog] = await Promise.all([
          apiGet('/api/platform/onboarding/templates'),
          apiGet(`/api/platform/onboarding/progress?subject_type=demo&subject_id=${encodeURIComponent(demo.id)}`),
        ]);
        const steps = (tplData.steps||[]).filter(s => s.template_id === 'sales_default' && s.active)
          .sort((a,b)=>(a.sort||0)-(b.sort||0));
        const doneSet = new Set((Array.isArray(prog)?prog:[]).map(p => p.step_id));
        const box = document.getElementById('gwDPlaybook');
        if (!box) return;

        const paint = () => {
          const pct = steps.length ? Math.round(doneSet.size / steps.length * 100) : 0;
          const pctEl = document.getElementById('gwDPlaybookPct');
          const fillEl = document.getElementById('gwDPlaybookFill');
          if (pctEl) pctEl.textContent = `${doneSet.size} / ${steps.length} · ${pct}%`;
          if (fillEl) { fillEl.style.width = pct + '%'; fillEl.style.background = pct >= 100 ? '#2D7A55' : '#4D8A86'; }
        };

        let lastPhase = null;
        box.innerHTML = steps.map(s => {
          let phase = ''; try { phase = JSON.parse(s.fields||'{}').phase || ''; } catch {}
          const header = phase && phase !== lastPhase
            ? `<div style="font-size:10.5px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;color:#8B6914;padding:12px 0 4px">${esc(phase)}</div>` : '';
          lastPhase = phase || lastPhase;
          const done = doneSet.has(s.id);
          return `${header}
<div style="display:flex;align-items:flex-start;gap:10px;padding:6px 0">
  <input type="checkbox" ${done?'checked':''} data-gwdpb="${esc(s.id)}"
    style="width:16px;height:16px;accent-color:#2D7A55;cursor:pointer;margin-top:1px;flex-shrink:0">
  <div style="flex:1">
    <div class="gwdpb-title" style="font-size:12.5px;font-weight:700;color:${done?'#5C6B58':'#E8E4D9'};${done?'text-decoration:line-through;opacity:.7':''}">${esc(s.title)}${s.required?' <span style="color:#C97B6A;font-size:10px">*</span>':''}</div>
    ${s.description?`<div style="font-size:11px;color:#6F7E6A;margin-top:1px;line-height:1.45">${esc(s.description)}</div>`:''}
  </div>
</div>`;
        }).join('') || '<div style="padding:14px;text-align:center;color:#6F7E6A;font-size:12px">No playbook steps defined. Add them in Onboarding → Template Builder.</div>';
        paint();

        box.querySelectorAll('input[data-gwdpb]').forEach(cb => {
          cb.addEventListener('change', async function() {
            const sid = this.getAttribute('data-gwdpb');
            const checked = this.checked;
            try {
              await apiPost('/api/platform/onboarding/progress', { step_id: sid, subject_type: 'demo', subject_id: demo.id, done: checked });
              checked ? doneSet.add(sid) : doneSet.delete(sid);
              const t = this.parentElement.querySelector('.gwdpb-title');
              if (t) { t.style.color = checked?'#5C6B58':'#E8E4D9'; t.style.textDecoration = checked?'line-through':''; t.style.opacity = checked?'.7':''; }
              paint();
            } catch(e) { this.checked = !checked; toast('Error: ' + e.message); }
          });
        });
      } catch(e) {
        const box = document.getElementById('gwDPlaybook');
        if (box) box.innerHTML = `<div style="padding:14px;text-align:center;color:#C97B6A;font-size:12px">Playbook failed to load: ${esc(e.message)}</div>`;
      }
    })();

    window._gwSaveDemo = async function(existingId) {
      const payload = {
        company_name: document.getElementById('gwD-company')?.value?.trim(),
        contact_name: document.getElementById('gwD-contact')?.value?.trim(),
        email:        document.getElementById('gwD-email')?.value?.trim(),
        phone:        document.getElementById('gwD-phone')?.value?.trim(),
        status:       document.getElementById('gwD-status')?.value,
        scheduled_at: document.getElementById('gwD-scheduled')?.value || null,
        notes:        document.getElementById('gwD-notes')?.value?.trim(),
      };
      if (!payload.contact_name && !payload.company_name) { toast('Contact or company name required'); return; }
      try {
        if (existingId) { await apiPut(`/api/platform/demos/${existingId}`, payload); toast('Demo updated'); }
        else { await apiPost('/api/platform/demos', payload); toast('Demo logged'); }
        document.getElementById('gwDemoModalOverlay')?.remove();
        show('gwDemos');
      } catch(e) { toast('Error: ' + e.message); }
    };
    window._gwDeleteDemo = async function(id) {
      if (!confirm('Delete this demo request? This cannot be undone.')) return;
      try {
        await apiDelete(`/api/platform/demos/${id}`);
        document.getElementById('gwDemoModalOverlay')?.remove();
        toast('Demo deleted');
        show('gwDemos');
      } catch(e) { toast('Error: ' + e.message); }
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 9. PRICING PLANS MANAGER (source of truth for MRR + public pricing)
  // ─────────────────────────────────────────────────────────────────────────
  async function pricingPlans() {
    const v = view(); if (!v) return;
    v.innerHTML = `<div style="padding:60px;text-align:center;color:#6F7E6A">Loading pricing plans…</div>`;

    let plans = [], companies = [], aiPkgs = [];
    try {
      [plans, companies, aiPkgs] = await Promise.all([
        apiGet('/api/platform/pricing-plans'),
        apiGet('/api/admin/companies').catch(()=>[]),
        apiGet('/api/platform/ai-packages').catch(()=>[]),
      ]);
      if (!Array.isArray(plans)) plans = [];
      if (!Array.isArray(companies)) companies = [];
      if (!Array.isArray(aiPkgs)) aiPkgs = [];
    }
    catch(e) { v.innerHTML = `<div style="padding:60px;text-align:center;color:#C97B6A">Error: ${esc(e.message)}</div>`; return; }

    const tenantsByPlan = {};
    companies.forEach(c => { tenantsByPlan[c.plan] = (tenantsByPlan[c.plan]||0) + (c.active?1:0); });
    const totalMrr = plans.reduce((s,p) => s + (p.monthly_price||0) * (tenantsByPlan[p.id]||0), 0);

    const _planCard = p => {
      const features = (() => { try { return JSON.parse(p.features||'[]'); } catch { return []; } })();
      const nTenants = tenantsByPlan[p.id]||0;
      const hasSeats = (p.seat_rep||0) > 0 || (p.seat_field||0) > 0 || (p.seat_office||0) > 0;
      return `
        <div style="background:var(--card,#fff);border:1px solid ${p.highlight?'#4D8A86':'var(--line,#e5e5e0)'};border-radius:18px;padding:24px;position:relative;overflow:hidden;${p.active?'':'opacity:.55'};box-shadow:${p.highlight?'0 12px 32px -14px rgba(77,138,134,.45)':'0 1px 3px rgba(0,0,0,.12)'};transition:transform .15s;display:flex;flex-direction:column" onmouseover="this.style.transform='translateY(-2px)'" onmouseout="this.style.transform=''">
          ${p.highlight ? '<div style="position:absolute;top:0;left:0;width:100%;height:3px;background:linear-gradient(90deg,#4D8A86,#2D7A55)"></div><div style="position:absolute;top:14px;right:14px;background:linear-gradient(135deg,#4D8A86,#1A4740);color:#fff;font-size:9px;font-weight:800;padding:3px 9px;border-radius:8px;letter-spacing:.08em">MOST POPULAR</div>' : ''}
          ${!p.active ? '<div style="position:absolute;top:14px;right:14px;background:#6F7E6A22;color:#6F7E6A;font-size:9px;font-weight:800;padding:3px 9px;border-radius:8px;letter-spacing:.08em">INACTIVE</div>' : ''}
          <div style="font-size:13px;font-weight:800;color:${PLAN_COLORS[p.id]||'#4D8A86'};text-transform:uppercase;letter-spacing:.08em;margin-bottom:6px">${esc(p.name)}</div>
          ${p.is_custom
            ? `<div style="font-size:26px;font-weight:900;color:#E8E4D9;letter-spacing:-.02em;margin-bottom:4px">Custom pricing</div>`
            : `<div style="display:flex;align-items:baseline;gap:6px;margin-bottom:4px">
                <span style="font-size:13px;color:#6F7E6A">${hasSeats?'Starting at':''}</span>
                <span style="font-size:34px;font-weight:900;color:#E8E4D9;letter-spacing:-.02em">${fmtMoney(p.monthly_price)}</span>
                <span style="font-size:13px;color:#6F7E6A">/mo</span>
              </div>`}
          ${p.tagline ? `<div style="font-size:12px;color:#6F7E6A;margin-bottom:12px;line-height:1.5">${esc(p.tagline)}</div>` : '<div style="margin-bottom:12px"></div>'}
          <div style="display:flex;gap:14px;margin-bottom:12px;font-size:12px;color:#6F7E6A;flex-wrap:wrap">
            <span><strong style="color:#E8E4D9">${p.ai_credits ? fmt(p.ai_credits) : (p.is_custom ? 'Custom' : '∞')}</strong> AI actions/mo</span>
            ${p.max_reps ? `<span><strong style="color:#E8E4D9">${fmt(p.max_reps)}</strong> rep seat${p.max_reps===1?'':'s'} max</span>` : ''}
          </div>
          ${features.length ? `<ul style="margin:0 0 14px;padding:0;list-style:none">${features.map(f=>`<li style="font-size:12px;color:#6F7E6A;padding:3px 0;display:flex;gap:8px;align-items:flex-start"><span style="color:#2D7A55;font-weight:800">✓</span>${esc(f)}</li>`).join('')}</ul>` : ''}
          ${hasSeats ? `
          <div style="background:rgba(77,138,134,.06);border:1px solid rgba(77,138,134,.16);border-radius:12px;padding:12px 14px;margin-bottom:14px">
            <div style="font-size:10px;font-weight:800;color:#4D8A86;text-transform:uppercase;letter-spacing:.08em;margin-bottom:8px">Additional seats / mo</div>
            <div style="display:grid;grid-template-columns:1fr auto;gap:4px 12px;font-size:12px">
              <span style="color:#6F7E6A">Rep/Estimator</span><strong style="color:#E8E4D9;text-align:right">${fmtMoney(p.seat_rep)}</strong>
              <span style="color:#6F7E6A">Field</span><strong style="color:#E8E4D9;text-align:right">${fmtMoney(p.seat_field)}</strong>
              <span style="color:#6F7E6A">Office Manager</span><strong style="color:#E8E4D9;text-align:right">${fmtMoney(p.seat_office)}</strong>
              <span style="color:#6F7E6A">View-only</span><strong style="color:#E8E4D9;text-align:right">${p.viewonly_included?`${p.viewonly_included} incl, then `:''}${fmtMoney(p.seat_viewonly)}</strong>
            </div>
          </div>` : (p.id==='starter' ? '<div style="font-size:11px;color:#8B6914;background:rgba(139,105,20,.1);border:1px solid rgba(139,105,20,.25);border-radius:10px;padding:8px 12px;margin-bottom:14px;font-weight:700">Additional seats not available — best for one-person companies</div>' : '')}
          <div style="display:flex;align-items:center;justify-content:space-between;border-top:1px solid var(--line,#e5e5e0);padding-top:14px;margin-top:auto">
            <span style="font-size:12px;color:#5C6B58"><strong style="color:#4D8A86">${nTenants}</strong> tenant${nTenants===1?'':'s'}${p.is_custom?'':' · '+fmtMoney((p.monthly_price||0)*nTenants)+'/mo'}</span>
            <button onclick="window._gwPlanModal('${esc(p.id)}')" style="padding:6px 14px;background:rgba(77,138,134,.12);border:1px solid #4D8A8644;border-radius:8px;color:#4D8A86;font-size:12px;font-weight:700;cursor:pointer">Edit</button>
          </div>
        </div>`;
    };

    const _aiPkgCard = p => {
      const features = (() => { try { return JSON.parse(p.features||'[]'); } catch { return []; } })();
      return `
        <div style="background:var(--card,#fff);border:1px solid ${p.highlight?'#7B5EA7':'var(--line,#e5e5e0)'};border-radius:16px;padding:20px;position:relative;overflow:hidden;${p.active?'':'opacity:.55'};box-shadow:${p.highlight?'0 10px 28px -14px rgba(123,94,167,.5)':'0 1px 3px rgba(0,0,0,.1)'}">
          ${p.highlight ? '<div style="position:absolute;top:0;left:0;width:100%;height:3px;background:linear-gradient(90deg,#7B5EA7,#4D8A86)"></div><div style="position:absolute;top:12px;right:12px;background:linear-gradient(135deg,#7B5EA7,#4D8A86);color:#fff;font-size:9px;font-weight:800;padding:3px 9px;border-radius:8px;letter-spacing:.08em">MOST POPULAR</div>' : ''}
          <div style="font-size:12px;font-weight:800;color:#7B5EA7;text-transform:uppercase;letter-spacing:.08em;margin-bottom:6px">${esc(p.name)}</div>
          ${p.is_custom || (!p.monthly_price && !p.ai_actions)
            ? `<div style="font-size:20px;font-weight:900;color:#E8E4D9;margin-bottom:4px">${p.id==='byok'?'No AI charge':'Contact Sales'}</div>`
            : `<div style="display:flex;align-items:baseline;gap:5px;margin-bottom:4px">
                <span style="font-size:26px;font-weight:900;color:#E8E4D9">${fmtMoney(p.monthly_price)}</span><span style="font-size:12px;color:#6F7E6A">/mo</span>
                <span style="font-size:12px;color:#4D8A86;font-weight:700;margin-left:8px">${fmt(p.ai_actions)} actions</span>
              </div>`}
          ${p.description ? `<div style="font-size:11px;color:#6F7E6A;margin-bottom:10px">${esc(p.description)}</div>` : ''}
          ${features.length ? `<ul style="margin:0 0 12px;padding:0;list-style:none">${features.map(f=>`<li style="font-size:11px;color:#6F7E6A;padding:2px 0;display:flex;gap:7px"><span style="color:#7B5EA7;font-weight:800">✓</span>${esc(f)}</li>`).join('')}</ul>` : ''}
          <button onclick="window._gwAiPkgModal('${esc(p.id)}')" style="padding:5px 12px;background:rgba(123,94,167,.1);border:1px solid #7B5EA744;border-radius:8px;color:#7B5EA7;font-size:11px;font-weight:700;cursor:pointer">Edit</button>
        </div>`;
    };

    v.innerHTML = shell(
      'Pricing Plans',
      'Source of truth for subscription + AI pricing — MRR across the platform is computed from these numbers',
      'PLATFORM ADMIN › PRICING',
      `${actionBtn('↺ Refresh','show(\'gwPricing\')')}
       ${primaryBtn('+ New Plan','window._gwPlanModal(null)')}`,
      `
      <div class="gw-pa-stat-grid" style="margin-bottom:26px">
        ${statCard('CRM Plans', fmt(plans.filter(p=>p.active).length), gwI('tag',40,'#4D8A86'), '#4D8A86')}
        ${statCard('AI Packages', fmt(aiPkgs.filter(p=>p.active).length), gwI('reports',40,'#7B5EA7'), '#7B5EA7', 'company-wide add-ons')}
        ${statCard('Est. Base MRR', fmtMoney(totalMrr), gwI('revenue',40,'#2D7A55'), '#2D7A55', 'active tenants × base price')}
        ${statCard('Paying Tenants', fmt(companies.filter(c=>c.active && c.plan!=='trial').length), gwI('building',40,'#1A4740'), '#1A4740')}
      </div>

      <!-- CRM Plan cards -->
      <div style="font-size:13px;font-weight:800;color:#E8E4D9;text-transform:uppercase;letter-spacing:.09em;margin-bottom:14px;display:flex;align-items:center;gap:8px"><span style="width:3px;height:14px;background:#4D8A86;border-radius:2px"></span>CRM Plans</div>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:18px;margin-bottom:32px">
        ${plans.map(_planCard).join('')}
        ${!plans.length ? '<div style="padding:60px;text-align:center;color:#5C6B58;grid-column:1/-1">No pricing plans found — click "+ New Plan" to create one.</div>' : ''}
      </div>

      <!-- Field seat volume discounts -->
      ${panel('Field-Seat Volume Pricing',
        '<span style="font-size:11px;color:#5C6B58">Applies to field seats only — not Rep/Estimator or Office Manager</span>',
        `<div style="padding:20px 22px;display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:14px">
          <div style="background:rgba(77,138,134,.05);border:1px solid rgba(77,138,134,.15);border-radius:12px;padding:16px;text-align:center">
            <div style="font-size:22px;font-weight:900;color:#6F7E6A">1–5</div>
            <div style="font-size:11px;color:#5C6B58;font-weight:700;text-transform:uppercase;letter-spacing:.05em;margin-top:4px">field seats</div>
            <div style="font-size:13px;color:#E8E4D9;font-weight:700;margin-top:8px">Standard rate</div>
          </div>
          <div style="background:rgba(45,122,85,.06);border:1px solid rgba(45,122,85,.2);border-radius:12px;padding:16px;text-align:center">
            <div style="font-size:22px;font-weight:900;color:#2D7A55">6–10</div>
            <div style="font-size:11px;color:#5C6B58;font-weight:700;text-transform:uppercase;letter-spacing:.05em;margin-top:4px">field seats</div>
            <div style="font-size:13px;color:#2D7A55;font-weight:800;margin-top:8px">10% off field seats</div>
          </div>
          <div style="background:rgba(45,122,85,.09);border:1px solid rgba(45,122,85,.3);border-radius:12px;padding:16px;text-align:center">
            <div style="font-size:22px;font-weight:900;color:#2D7A55">11+</div>
            <div style="font-size:11px;color:#5C6B58;font-weight:700;text-transform:uppercase;letter-spacing:.05em;margin-top:4px">field seats</div>
            <div style="font-size:13px;color:#2D7A55;font-weight:800;margin-top:8px">15% off or custom pricing</div>
          </div>
        </div>`,
        'margin-bottom:32px'
      )}

      <!-- AI Packages -->
      <div style="font-size:13px;font-weight:800;color:#E8E4D9;text-transform:uppercase;letter-spacing:.09em;margin-bottom:6px;display:flex;align-items:center;gap:8px"><span style="width:3px;height:14px;background:#7B5EA7;border-radius:2px"></span>Groundwork AI — Company-Wide Packages</div>
      <div style="font-size:12px;color:#6F7E6A;margin-bottom:14px">Every CRM plan includes monthly AI actions (Starter 50 · Core 100 · Growth 250 · Pro 500). These optional packages replace the included allowance with a larger company-wide pool. Usage is shared — never charged per employee. No automatic overages.</div>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:16px;margin-bottom:26px">
        ${aiPkgs.map(_aiPkgCard).join('')}
        ${!aiPkgs.length ? '<div style="padding:40px;text-align:center;color:#5C6B58;grid-column:1/-1">No AI packages found.</div>' : ''}
      </div>
      <div id="gwPlanModalWrap"></div>
    `);

    window._gwAllPlans = plans;
    window._gwAllAiPkgs = aiPkgs;
    window._gwPlanModal = function(id) {
      const plan = id ? (window._gwAllPlans||[]).find(p=>p.id===id) : null;
      _planModal(plan);
    };
    window._gwAiPkgModal = function(id) {
      const pkg = id ? (window._gwAllAiPkgs||[]).find(p=>p.id===id) : null;
      _aiPkgModal(pkg);
    };
  }

  function _planModal(plan) {
    const isEdit = !!plan;
    const features = (() => { try { return JSON.parse(plan?.features||'[]'); } catch { return []; } })();
    const el = document.createElement('div');
    el.id = 'gwPlanModalOverlay';
    el.style.cssText = 'position:fixed;inset:0;background:#000c;z-index:9999;display:flex;align-items:center;justify-content:center;padding:20px';
    el.innerHTML = `
<div style="background:var(--card,#1E2B29);border:1px solid var(--line,#2A3A38);border-radius:20px;width:min(640px,100%);max-height:92vh;overflow-y:auto;padding:28px">
  <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:22px">
    <h2 style="margin:0;font-size:18px;font-weight:800;color:#E8E4D9">${isEdit ? 'Edit Plan — ' + esc(plan.name) : 'New Pricing Plan'}</h2>
    <button onclick="document.getElementById('gwPlanModalOverlay').remove()" style="background:none;border:none;color:#6F7E6A;font-size:20px;cursor:pointer">✕</button>
  </div>
  <div style="display:grid;gap:14px">
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
      <div><label class="um-label">Plan ID ${isEdit?'(locked)':'*'}</label>
        <input id="gwP-id" class="um-input" value="${esc(plan?.id||'')}" placeholder="starter" ${isEdit?'disabled style="opacity:.5"':''}></div>
      <div><label class="um-label">Display Name *</label>
        <input id="gwP-name" class="um-input" value="${esc(plan?.name||'')}" placeholder="Starter"></div>
    </div>
    <div><label class="um-label">Tagline</label>
      <input id="gwP-tagline" class="um-input" value="${esc(plan?.tagline||'')}" placeholder="For solo operators testing Groundwork."></div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
      <div><label class="um-label">Monthly Price ($)</label>
        <input id="gwP-monthly" class="um-input" type="number" min="0" step="1" value="${esc(plan?.monthly_price??'')}" placeholder="99"></div>
      <div><label class="um-label">Annual Price ($/mo equiv, 0 = n/a)</label>
        <input id="gwP-annual" class="um-input" type="number" min="0" step="1" value="${esc(plan?.annual_price??'')}" placeholder="79"></div>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px">
      <div><label class="um-label">AI Actions/mo (0 = ∞)</label>
        <input id="gwP-ai" class="um-input" type="number" min="0" value="${esc(plan?.ai_credits??'')}" placeholder="200"></div>
      <div><label class="um-label">Max Reps (0 = ∞)</label>
        <input id="gwP-reps" class="um-input" type="number" min="0" value="${esc(plan?.max_reps??'')}" placeholder="5"></div>
      <div><label class="um-label">Sort Order</label>
        <input id="gwP-sort" class="um-input" type="number" min="0" value="${esc(plan?.sort??'')}" placeholder="1"></div>
    </div>
    <div style="border:1px solid var(--line,#2A3A38);border-radius:12px;padding:14px">
      <div style="font-size:11px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;color:#6F7E6A;margin-bottom:10px">Per-Seat Pricing ($/mo, 0 = seats not available)</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
        <div><label class="um-label">Rep / Estimator seat</label>
          <input id="gwP-seatRep" class="um-input" type="number" min="0" step="1" value="${esc(plan?.seat_rep??'')}" placeholder="49"></div>
        <div><label class="um-label">Field seat</label>
          <input id="gwP-seatField" class="um-input" type="number" min="0" step="1" value="${esc(plan?.seat_field??'')}" placeholder="25"></div>
        <div><label class="um-label">Office Manager seat</label>
          <input id="gwP-seatOffice" class="um-input" type="number" min="0" step="1" value="${esc(plan?.seat_office??'')}" placeholder="89"></div>
        <div><label class="um-label">View-only seat</label>
          <input id="gwP-seatView" class="um-input" type="number" min="0" step="1" value="${esc(plan?.seat_viewonly??'')}" placeholder="10"></div>
        <div><label class="um-label">View-only seats included</label>
          <input id="gwP-viewIncl" class="um-input" type="number" min="0" value="${esc(plan?.viewonly_included??'')}" placeholder="1"></div>
      </div>
    </div>
    <div><label class="um-label">Features (one per line)</label>
      <textarea id="gwP-features" class="um-input" rows="5" placeholder="Full CRM &amp; pipeline&#10;Estimates &amp; invoicing" style="resize:vertical">${esc(features.join('\n'))}</textarea></div>
    <div style="display:flex;gap:24px">
      <label style="display:flex;align-items:center;gap:8px;font-size:13px;color:#6F7E6A;cursor:pointer">
        <input id="gwP-highlight" type="checkbox" ${plan?.highlight?'checked':''} style="width:16px;height:16px;accent-color:#4D8A86"> "Most Popular" badge
      </label>
      <label style="display:flex;align-items:center;gap:8px;font-size:13px;color:#6F7E6A;cursor:pointer">
        <input id="gwP-active" type="checkbox" ${(plan?.active??1)?'checked':''} style="width:16px;height:16px;accent-color:#4D8A86"> Active
      </label>
      <label style="display:flex;align-items:center;gap:8px;font-size:13px;color:#6F7E6A;cursor:pointer">
        <input id="gwP-custom" type="checkbox" ${plan?.is_custom?'checked':''} style="width:16px;height:16px;accent-color:#B8860B"> Custom pricing (Contact Sales)
      </label>
    </div>
  </div>
  <div style="display:flex;justify-content:space-between;align-items:center;margin-top:24px">
    ${isEdit ? dangerBtn('Delete Plan',`window._gwDeletePlan('${esc(plan.id)}')`) : '<span></span>'}
    <div style="display:flex;gap:10px">
      <button class="secondary-btn" onclick="document.getElementById('gwPlanModalOverlay').remove()">Cancel</button>
      <button class="primary-btn" onclick="window._gwSavePlan('${esc(plan?.id||'')}')">${isEdit ? 'Save' : 'Create Plan'}</button>
    </div>
  </div>
</div>`;
    document.body.appendChild(el);

    window._gwSavePlan = async function(existingId) {
      const featureLines = (document.getElementById('gwP-features')?.value||'').split('\n').map(s=>s.trim()).filter(Boolean);
      const payload = {
        name:          document.getElementById('gwP-name')?.value?.trim(),
        monthly_price: parseFloat(document.getElementById('gwP-monthly')?.value)||0,
        annual_price:  parseFloat(document.getElementById('gwP-annual')?.value)||0,
        ai_credits:    parseInt(document.getElementById('gwP-ai')?.value)||0,
        max_reps:      parseInt(document.getElementById('gwP-reps')?.value)||0,
        sort:          parseInt(document.getElementById('gwP-sort')?.value)||0,
        features:      featureLines,
        highlight:     document.getElementById('gwP-highlight')?.checked ? 1 : 0,
        active:        document.getElementById('gwP-active')?.checked ? 1 : 0,
        tagline:            document.getElementById('gwP-tagline')?.value?.trim() || '',
        seat_rep:           parseFloat(document.getElementById('gwP-seatRep')?.value)||0,
        seat_field:         parseFloat(document.getElementById('gwP-seatField')?.value)||0,
        seat_office:        parseFloat(document.getElementById('gwP-seatOffice')?.value)||0,
        seat_viewonly:      parseFloat(document.getElementById('gwP-seatView')?.value)||0,
        viewonly_included:  parseInt(document.getElementById('gwP-viewIncl')?.value)||0,
        is_custom:          document.getElementById('gwP-custom')?.checked ? 1 : 0,
      };
      payload.extra_seats_available = (payload.seat_rep||payload.seat_field||payload.seat_office||payload.seat_viewonly) ? 1 : 0;
      if (!payload.name) { toast('Plan name required'); return; }
      try {
        if (existingId) { await apiPut(`/api/platform/pricing-plans/${existingId}`, payload); toast('Plan updated'); }
        else {
          const id = document.getElementById('gwP-id')?.value?.trim();
          if (!id) { toast('Plan ID required'); return; }
          await apiPost('/api/platform/pricing-plans', Object.assign({ id }, payload));
          toast('Plan created');
        }
        document.getElementById('gwPlanModalOverlay')?.remove();
        show('gwPricing');
      } catch(e) { toast('Error: ' + e.message); }
    };
    window._gwDeletePlan = async function(id) {
      if (!confirm(`Delete the "${id}" plan? Tenants on this plan keep their plan label but MRR will show $0 for them.`)) return;
      try {
        await apiDelete(`/api/platform/pricing-plans/${id}`);
        document.getElementById('gwPlanModalOverlay')?.remove();
        toast('Plan deleted');
        show('gwPricing');
      } catch(e) { toast('Error: ' + e.message); }
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // AI PACKAGE MODAL (create / edit)
  // ─────────────────────────────────────────────────────────────────────────
  function _aiPkgModal(pkg) {
    const isEdit = !!pkg;
    const features = (() => { try { return JSON.parse(pkg?.features||'[]'); } catch { return []; } })();
    const el = document.createElement('div');
    el.id = 'gwAiPkgModalOverlay';
    el.style.cssText = 'position:fixed;inset:0;background:#000c;z-index:9999;display:flex;align-items:center;justify-content:center;padding:20px';
    el.innerHTML = `
<div style="background:var(--card,#1E2B29);border:1px solid var(--line,#2A3A38);border-radius:20px;width:min(600px,100%);max-height:92vh;overflow-y:auto;padding:28px">
  <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:22px">
    <h2 style="margin:0;font-size:18px;font-weight:800;color:#E8E4D9">${isEdit ? 'Edit AI Package — ' + esc(pkg.name) : 'New AI Package'}</h2>
    <button onclick="document.getElementById('gwAiPkgModalOverlay').remove()" style="background:none;border:none;color:#6F7E6A;font-size:20px;cursor:pointer">✕</button>
  </div>
  <div style="display:grid;gap:14px">
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
      <div><label class="um-label">Package ID ${isEdit?'(locked)':'*'}</label>
        <input id="gwAP-id" class="um-input" value="${esc(pkg?.id||'')}" placeholder="essentials" ${isEdit?'disabled style="opacity:.5"':''}></div>
      <div><label class="um-label">Display Name *</label>
        <input id="gwAP-name" class="um-input" value="${esc(pkg?.name||'')}" placeholder="AI Essentials"></div>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px">
      <div><label class="um-label">Monthly Price ($)</label>
        <input id="gwAP-monthly" class="um-input" type="number" min="0" step="1" value="${esc(pkg?.monthly_price??'')}" placeholder="12"></div>
      <div><label class="um-label">AI Actions/mo (0 = custom/∞)</label>
        <input id="gwAP-actions" class="um-input" type="number" min="0" value="${esc(pkg?.ai_actions??'')}" placeholder="500"></div>
      <div><label class="um-label">Sort Order</label>
        <input id="gwAP-sort" class="um-input" type="number" min="0" value="${esc(pkg?.sort??'')}" placeholder="1"></div>
    </div>
    <div><label class="um-label">Description</label>
      <input id="gwAP-desc" class="um-input" value="${esc(pkg?.description||'')}" placeholder="Shared across the company"></div>
    <div><label class="um-label">Features (one per line)</label>
      <textarea id="gwAP-features" class="um-input" rows="5" placeholder="500 total AI actions&#10;Shared across the company" style="resize:vertical">${esc(features.join('\n'))}</textarea></div>
    <div style="display:flex;gap:24px;flex-wrap:wrap">
      <label style="display:flex;align-items:center;gap:8px;font-size:13px;color:#6F7E6A;cursor:pointer">
        <input id="gwAP-highlight" type="checkbox" ${pkg?.highlight?'checked':''} style="width:16px;height:16px;accent-color:#7B5EA7"> "Most Popular" badge
      </label>
      <label style="display:flex;align-items:center;gap:8px;font-size:13px;color:#6F7E6A;cursor:pointer">
        <input id="gwAP-custom" type="checkbox" ${pkg?.is_custom?'checked':''} style="width:16px;height:16px;accent-color:#B8860B"> Custom pricing (Contact Sales)
      </label>
      <label style="display:flex;align-items:center;gap:8px;font-size:13px;color:#6F7E6A;cursor:pointer">
        <input id="gwAP-active" type="checkbox" ${(pkg?.active??1)?'checked':''} style="width:16px;height:16px;accent-color:#4D8A86"> Active
      </label>
    </div>
  </div>
  <div style="display:flex;justify-content:space-between;align-items:center;margin-top:24px">
    ${isEdit ? dangerBtn('Delete Package',`window._gwDeleteAiPkg('${esc(pkg.id)}')`) : '<span></span>'}
    <div style="display:flex;gap:10px">
      <button class="secondary-btn" onclick="document.getElementById('gwAiPkgModalOverlay').remove()">Cancel</button>
      <button class="primary-btn" onclick="window._gwSaveAiPkg('${esc(pkg?.id||'')}')">${isEdit ? 'Save' : 'Create Package'}</button>
    </div>
  </div>
</div>`;
    document.body.appendChild(el);

    window._gwSaveAiPkg = async function(existingId) {
      const featureLines = (document.getElementById('gwAP-features')?.value||'').split('\n').map(s=>s.trim()).filter(Boolean);
      const payload = {
        name:          document.getElementById('gwAP-name')?.value?.trim(),
        monthly_price: parseFloat(document.getElementById('gwAP-monthly')?.value)||0,
        ai_actions:    parseInt(document.getElementById('gwAP-actions')?.value)||0,
        description:   document.getElementById('gwAP-desc')?.value?.trim() || '',
        features:      featureLines,
        highlight:     document.getElementById('gwAP-highlight')?.checked ? 1 : 0,
        is_custom:     document.getElementById('gwAP-custom')?.checked ? 1 : 0,
        active:        document.getElementById('gwAP-active')?.checked ? 1 : 0,
        sort:          parseInt(document.getElementById('gwAP-sort')?.value)||0,
      };
      if (!payload.name) { toast('Package name required'); return; }
      try {
        if (existingId) { await apiPut(`/api/platform/ai-packages/${existingId}`, payload); toast('AI package updated'); }
        else {
          const id = document.getElementById('gwAP-id')?.value?.trim();
          if (!id) { toast('Package ID required'); return; }
          await apiPost('/api/platform/ai-packages', Object.assign({ id }, payload));
          toast('AI package created');
        }
        document.getElementById('gwAiPkgModalOverlay')?.remove();
        show('gwPricing');
      } catch(e) { toast('Error: ' + e.message); }
    };
    window._gwDeleteAiPkg = async function(id) {
      if (!confirm(`Delete the "${id}" AI package? Tenants assigned to it fall back to their CRM plan's included AI allowance.`)) return;
      try {
        await apiDelete(`/api/platform/ai-packages/${id}`);
        document.getElementById('gwAiPkgModalOverlay')?.remove();
        toast('AI package deleted');
        show('gwPricing');
      } catch(e) { toast('Error: ' + e.message); }
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // ONBOARDING  (Sales Playbook · Template Builder · Tenant Funnel)
  // ─────────────────────────────────────────────────────────────────────────
  async function onboarding() {
    const v = view(); if (!v) return;
    v.innerHTML = `<div style="padding:60px;text-align:center;color:#6F7E6A">Loading onboarding…</div>`;

    let data, demosRows = [], funnel = { companies: [], checklist_progress: [], checklist_total: 0, responses: [] }, salesProg = [];
    try {
      [data, demosRows, funnel, salesProg] = await Promise.all([
        apiGet('/api/platform/onboarding/templates'),
        apiGet('/api/platform/demos').catch(()=>[]),
        apiGet('/api/platform/onboarding/funnel').catch(()=>funnel),
        apiGet('/api/platform/onboarding/progress?template_id=sales_default').catch(()=>[]),
      ]);
    } catch(e) { v.innerHTML = `<div style="padding:60px;text-align:center;color:#C97B6A">Error: ${esc(e.message)}</div>`; return; }

    const templates = data.templates || [];
    const steps = data.steps || [];
    const stepsFor = tid => steps.filter(s => s.template_id === tid).sort((a,b)=>(a.sort||0)-(b.sort||0));
    const salesSteps = stepsFor('sales_default').filter(s=>s.active);
    const wizardSteps = stepsFor('wizard_default');
    const checklistSteps = stepsFor('checklist_default');

    // Progress lookup: subject_id → Set(step_id)
    const progBySubject = {};
    (Array.isArray(salesProg)?salesProg:[]).forEach(p => {
      (progBySubject[p.subject_id] = progBySubject[p.subject_id] || new Set()).add(p.step_id);
    });

    // Active playbook subjects: demos not cancelled; converted stay until all steps done
    const activeDemos = (demosRows||[]).filter(d => d.status !== 'cancelled')
      .filter(d => {
        const done = progBySubject[d.id]?.size || 0;
        return !(d.status === 'converted' && done >= salesSteps.length && salesSteps.length > 0);
      });
    const inFlight = activeDemos.filter(d => (progBySubject[d.id]?.size||0) > 0 && (progBySubject[d.id]?.size||0) < salesSteps.length).length;
    const notStarted = activeDemos.filter(d => !(progBySubject[d.id]?.size)).length;

    // Tenant funnel stats
    const cos = funnel.companies || [];
    const wizDone = cos.filter(c => c.onboarding_completed).length;
    const clProgMap = {}; (funnel.checklist_progress||[]).forEach(r => clProgMap[r.subject_id] = r.done);

    v.innerHTML = shell(
      'Onboarding',
      'Your sales-to-live playbook, the new-company signup wizard, and the tenant Getting Started checklist — all editable here',
      'PLATFORM ADMIN › ONBOARDING',
      `${actionBtn('↺ Refresh','show(\'gwOnboarding\')')}`,
      `
      <div class="gw-pa-stat-grid" style="margin-bottom:24px">
        ${statCard('Playbook Steps', fmt(salesSteps.length), gwI('list',40,'#4D8A86'), '#4D8A86', 'sales onboarding checklist')}
        ${statCard('In Flight', fmt(inFlight), gwI('clock',40,'#8B6914'), '#8B6914', 'demos mid-playbook')}
        ${statCard('Not Started', fmt(notStarted), gwI('flag',40,'#C97B6A'), '#C97B6A', 'demos w/ no steps done')}
        ${statCard('Wizard Completed', fmt(wizDone) + ' / ' + fmt(cos.length), gwI('check',40,'#2D7A55'), '#2D7A55', 'tenants finished setup wizard')}
        ${statCard('Checklist Items', fmt(checklistSteps.filter(s=>s.active).length), gwI('star',40,'#7B5EA7'), '#7B5EA7', 'shown to new tenants')}
      </div>

      <!-- Tabs -->
      <div style="display:flex;gap:10px;margin-bottom:22px;flex-wrap:wrap">
        ${[['playbook','Sales Playbook'],['builder','Template Builder'],['funnel','Tenant Funnel']].map(([id,label],i)=>`
        <button onclick="window._gwOnbTab('${id}')" id="gwOnbTab_${id}"
          style="padding:9px 20px;border-radius:12px;border:1px solid ${i===0?'#4D8A86':'var(--line,#e5e5e0)'};
                 background:${i===0?'rgba(77,138,134,.15)':'transparent'};
                 color:${i===0?'#4D8A86':'#6F7E6A'};font-size:13px;font-weight:800;cursor:pointer;letter-spacing:.02em">
          ${label}
        </button>`).join('')}
      </div>

      <div id="gwOnbPane"></div>
      `
    );

    /* ── Pane renderers ─────────────────────────────────────────────────── */
    const paneEl = () => document.getElementById('gwOnbPane');

    function renderPlaybook() {
      const rows = activeDemos.map(d => {
        const doneSet = progBySubject[d.id] || new Set();
        const pct = salesSteps.length ? Math.round(doneSet.size / salesSteps.length * 100) : 0;
        const barCol = pct >= 100 ? '#2D7A55' : pct >= 50 ? '#4D8A86' : '#8B6914';
        return `
<div style="border-bottom:1px solid var(--line,#e5e5e0)">
  <div onclick="window._gwOnbExpand('${esc(d.id)}')" style="display:flex;align-items:center;gap:14px;padding:15px 20px;cursor:pointer" onmouseover="this.style.background='rgba(77,138,134,.05)'" onmouseout="this.style.background=''">
    <div style="width:36px;height:36px;border-radius:10px;background:linear-gradient(135deg,rgba(77,138,134,.2),rgba(26,71,64,.15));display:flex;align-items:center;justify-content:center;font-weight:800;color:#4D8A86;font-size:13px;flex-shrink:0">${esc((d.company_name||d.contact_name||'?').trim().charAt(0).toUpperCase())}</div>
    <div style="flex:1;min-width:0">
      <div style="font-weight:700;font-size:14px;color:#E8E4D9">${esc(d.company_name||d.contact_name||'Unknown')}</div>
      <div style="font-size:12px;color:#5C6B58">${esc(d.contact_name||'')}${d.email?' · '+esc(d.email):''} · ${demoStatusBadge(d.status)}</div>
    </div>
    <div style="width:220px;flex-shrink:0">
      <div style="display:flex;justify-content:space-between;font-size:11px;color:#6F7E6A;margin-bottom:5px"><span>${doneSet.size} / ${salesSteps.length} steps</span><span style="font-weight:800;color:${barCol}">${pct}%</span></div>
      <div style="height:7px;background:rgba(111,126,106,.15);border-radius:4px;overflow:hidden"><div style="height:100%;width:${pct}%;background:${barCol};border-radius:4px;transition:width .3s"></div></div>
    </div>
    <span id="gwOnbChev_${esc(d.id)}" style="color:#6F7E6A;font-size:12px;transition:transform .2s">▾</span>
  </div>
  <div id="gwOnbSteps_${esc(d.id)}" style="display:none;padding:6px 20px 18px 70px">
    ${(() => { let lastPhase = null; return salesSteps.map(s => {
      const done = doneSet.has(s.id);
      let phase = ''; try { phase = JSON.parse(s.fields||'{}').phase || ''; } catch {}
      const header = phase && phase !== lastPhase
        ? `<div style="font-size:10.5px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;color:#8B6914;padding:12px 0 4px">${esc(phase)}</div>` : '';
      lastPhase = phase || lastPhase;
      return `${header}
    <div style="display:flex;align-items:flex-start;gap:12px;padding:8px 0">
      <input type="checkbox" ${done?'checked':''} onchange="window._gwOnbToggle('${esc(s.id)}','${esc(d.id)}',this.checked)"
        style="width:17px;height:17px;accent-color:#2D7A55;cursor:pointer;margin-top:2px;flex-shrink:0">
      <div style="flex:1">
        <div style="font-size:13px;font-weight:700;color:${done?'#5C6B58':'#E8E4D9'};${done?'text-decoration:line-through;opacity:.7':''}">${esc(s.title)}${s.required?' <span style="color:#C97B6A;font-size:11px">*</span>':''}</div>
        ${s.description?`<div style="font-size:11.5px;color:#6F7E6A;margin-top:2px">${esc(s.description)}</div>`:''}
      </div>
    </div>`;
    }).join(''); })()}
  </div>
</div>`;
      }).join('');

      paneEl().innerHTML = panel('Sales Onboarding Playbook',
        `<span style="font-size:12px;color:#5C6B58">${activeDemos.length} active · click a row to expand its checklist</span>`,
        rows || `<div style="padding:60px;text-align:center;color:#5C6B58">No active demos.<br><br><span style="font-size:12px">Every demo request automatically gets this playbook. Log one from the Demo Requests page to start.</span></div>`
      );
    }

    function renderBuilder() {
      const tplSection = (tpl, tSteps, color, hint) => panel(
        esc(tpl?.name || ''),
        `${primaryBtn('+ Add Step',`window._gwOnbStepModal(null,'${esc(tpl.id)}')`)}`,
        `
        <div style="padding:14px 20px;font-size:12.5px;color:#6F7E6A;border-bottom:1px solid var(--line,#e5e5e0);background:rgba(77,138,134,.04)">${esc(hint || tpl?.description || '')}</div>
        ${tSteps.map(s => {
          let metaNote = '';
          if (tpl.id === 'wizard_default' && !s.locked) {
            let qs = []; try { qs = JSON.parse(s.fields||'[]'); } catch {}
            metaNote = qs.length ? `${qs.length} question${qs.length!==1?'s':''}` : 'no questions yet';
          } else if (tpl.id === 'checklist_default') {
            let m = {}; try { m = JSON.parse(s.fields||'{}'); } catch {}
            metaNote = m.auto && m.auto !== 'manual' ? `auto-detects: ${m.auto}` : 'manual check-off';
          } else if (tpl.id === 'sales_default') {
            let m = {}; try { m = JSON.parse(s.fields||'{}'); } catch {}
            metaNote = m.phase || '';
          }
          return `
<div style="display:flex;align-items:center;gap:14px;padding:13px 20px;border-bottom:1px solid var(--line,#e5e5e0);${s.active?'':'opacity:.45'}">
  <div style="width:28px;height:28px;border-radius:8px;background:${color}22;border:1px solid ${color}44;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:800;color:${color};flex-shrink:0">${s.sort||'·'}</div>
  <div style="flex:1;min-width:0">
    <div style="font-size:13.5px;font-weight:700;color:#E8E4D9">${esc(s.title)}
      ${s.locked?'<span style="font-size:10px;font-weight:700;color:#8B6914;background:rgba(139,105,20,.14);border:1px solid rgba(139,105,20,.3);padding:2px 7px;border-radius:8px;margin-left:6px">BUILT-IN</span>':''}
      ${s.required?'<span style="font-size:10px;font-weight:700;color:#C97B6A;background:rgba(201,123,106,.12);border:1px solid rgba(201,123,106,.3);padding:2px 7px;border-radius:8px;margin-left:6px">REQUIRED</span>':''}
      ${s.active?'':'<span style="font-size:10px;font-weight:700;color:#6F7E6A;border:1px solid #6F7E6A44;padding:2px 7px;border-radius:8px;margin-left:6px">INACTIVE</span>'}
    </div>
    <div style="font-size:11.5px;color:#6F7E6A;margin-top:2px">${esc(s.description||'')}${metaNote?` <span style="color:${color};font-weight:700">· ${esc(metaNote)}</span>`:''}</div>
  </div>
  ${s.locked
    ? '<span style="font-size:11px;color:#5C6B58;flex-shrink:0">locked</span>'
    : `<button onclick="window._gwOnbStepModal('${esc(s.id)}','${esc(tpl.id)}')" style="padding:6px 14px;background:${color}18;border:1px solid ${color}44;border-radius:8px;color:${color};font-size:12px;font-weight:700;cursor:pointer;flex-shrink:0">Edit</button>`}
</div>`;
        }).join('') || '<div style="padding:40px;text-align:center;color:#5C6B58">No steps yet.</div>'}
        `, 'margin-bottom:28px');

      const tSales = templates.find(t=>t.id==='sales_default');
      const tWiz = templates.find(t=>t.id==='wizard_default');
      const tCl = templates.find(t=>t.id==='checklist_default');
      const sections =
        (tSales ? tplSection(tSales, stepsFor('sales_default'), '#4D8A86', 'Internal checklist your team works through for every demo → live customer. Attached automatically to all demo requests in the Sales Playbook tab.') : '') +
        (tWiz ? tplSection(tWiz, wizardSteps, '#8B6914', 'The first-login wizard every new tenant admin sees. Built-in steps are locked. Add custom question steps — answers appear in the Tenant Funnel.') : '') +
        (tCl ? tplSection(tCl, checklistSteps, '#7B5EA7', 'The "Getting Started" panel inside every new tenant dashboard. Auto-detect items check themselves off when the tenant does the thing.') : '');

      paneEl().innerHTML = `
      <div style="display:flex;gap:24px;align-items:flex-start;flex-wrap:wrap">
        <div style="flex:1;min-width:360px">${sections}</div>
        <div style="width:430px;max-width:100%;flex-shrink:0;position:sticky;top:12px">
          <div style="border:1px solid var(--line,#e5e5e0);border-radius:16px;overflow:hidden;background:rgba(255,255,255,.02)">
            <div style="padding:13px 18px;border-bottom:1px solid var(--line,#e5e5e0);display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap">
              <div>
                <div style="font-weight:800;font-size:14px;color:#E8E4D9">Live Preview</div>
                <div style="font-size:10.5px;color:#6F7E6A">Interactive demo — nothing is saved</div>
              </div>
              <div style="display:flex;gap:6px">
                ${[['playbook','Playbook'],['wizard','Wizard'],['checklist','Checklist']].map(([id,l])=>`
                <button onclick="window._gwOnbPvMode('${id}')" id="gwPvTab_${id}" style="padding:6px 12px;border-radius:9px;border:1px solid var(--line,#e5e5e0);background:transparent;color:#6F7E6A;font-size:11.5px;font-weight:800;cursor:pointer">${l}</button>`).join('')}
              </div>
            </div>
            <div id="gwOnbPvBody" style="padding:18px;background:#DDD9CE;max-height:calc(100vh - 230px);overflow-y:auto"></div>
          </div>
        </div>
      </div>`;
      window._gwOnbPvMode((window._gwOnbPvState && window._gwOnbPvState.mode) || 'playbook');
    }

    /* ── Live Preview renderers (Template Builder) ──────────────────────── */
    const pvBody = () => document.getElementById('gwOnbPvBody');
    window._gwOnbPvState = window._gwOnbPvState || { mode: 'playbook', wizIdx: 0, pbDone: {}, clDone: {} };
    const pvS = window._gwOnbPvState;

    window._gwOnbPvMode = function(mode) {
      pvS.mode = mode;
      ['playbook','wizard','checklist'].forEach(t => {
        const b = document.getElementById('gwPvTab_'+t); if (!b) return;
        const on = t === mode;
        b.style.background = on ? 'rgba(77,138,134,.2)' : 'transparent';
        b.style.borderColor = on ? '#4D8A86' : 'var(--line,#e5e5e0)';
        b.style.color = on ? '#4D8A86' : '#6F7E6A';
      });
      if (!pvBody()) return;
      if (mode === 'playbook') pvPlaybook();
      else if (mode === 'wizard') pvWizard();
      else pvChecklist();
    };

    function pvPlaybook() {
      const act = salesSteps;
      const doneCount = act.filter(s => pvS.pbDone[s.id]).length;
      const pct = act.length ? Math.round(doneCount / act.length * 100) : 0;
      const barCol = pct >= 100 ? '#2D7A55' : pct >= 50 ? '#4D8A86' : '#8B6914';
      let lastPhase = null;
      pvBody().innerHTML = `
      <div style="font-size:11px;color:#4A5546;margin-bottom:10px;text-align:center;font-weight:600">What your team sees inside a demo request — check items off to try it</div>
      <div style="background:#fff;border-radius:14px;box-shadow:0 8px 28px rgba(0,0,0,.14);overflow:hidden">
        <div style="padding:14px 18px;border-bottom:1px solid #EEE">
          <div style="display:flex;align-items:center;gap:10px">
            <div style="width:34px;height:34px;border-radius:9px;background:linear-gradient(135deg,#4D8A8633,#1A474026);display:flex;align-items:center;justify-content:center;font-weight:800;color:#2D6763;flex-shrink:0">A</div>
            <div style="flex:1;min-width:0">
              <div style="font-weight:800;font-size:13.5px;color:#1F2937">Acme Landscaping <span style="font-size:9.5px;color:#8B6914;background:#FEF6E4;border:1px solid #EAD9AC;border-radius:8px;padding:1px 7px;margin-left:4px;vertical-align:middle">SAMPLE</span></div>
              <div style="font-size:11px;color:#6B7280">Sarah Miller · sarah@acmelandscaping.com</div>
            </div>
          </div>
          <div style="display:flex;justify-content:space-between;font-size:10.5px;color:#6B7280;margin:10px 0 4px"><span style="font-weight:700;letter-spacing:.05em;text-transform:uppercase">Onboarding Playbook</span><span style="font-weight:800;color:${barCol}">${doneCount}/${act.length} · ${pct}%</span></div>
          <div style="height:6px;background:#F3F4F6;border-radius:4px;overflow:hidden"><div style="height:100%;width:${pct}%;background:${barCol};border-radius:4px;transition:width .3s"></div></div>
        </div>
        <div style="max-height:380px;overflow-y:auto;padding:4px 18px 12px">
          ${act.map(s => {
            let phase = ''; try { phase = JSON.parse(s.fields||'{}').phase || ''; } catch {}
            const header = phase && phase !== lastPhase ? `<div style="font-size:10px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;color:#8B6914;padding:11px 0 3px">${esc(phase)}</div>` : '';
            lastPhase = phase || lastPhase;
            const done = !!pvS.pbDone[s.id];
            return `${header}
            <label style="display:flex;align-items:flex-start;gap:10px;padding:6px 0;cursor:pointer">
              <input type="checkbox" ${done?'checked':''} onchange="window._gwOnbPvPb('${esc(s.id)}',this.checked)" style="width:16px;height:16px;accent-color:#2D7A55;margin-top:1px;flex-shrink:0;cursor:pointer">
              <span style="flex:1">
                <span style="display:block;font-size:12.5px;font-weight:700;color:${done?'#9CA3AF':'#1F2937'};${done?'text-decoration:line-through':''}">${esc(s.title)}${s.required?' <span style="color:#C97B6A;font-size:11px">*</span>':''}</span>
                ${s.description?`<span style="display:block;font-size:11px;color:#6B7280;margin-top:1px">${esc(s.description)}</span>`:''}
              </span>
            </label>`;
          }).join('') || '<div style="padding:30px;text-align:center;color:#9CA3AF;font-size:12px">No active playbook steps.</div>'}
        </div>
      </div>`;
    }
    window._gwOnbPvPb = function(id, on) { pvS.pbDone[id] = on; pvPlaybook(); };

    function pvWizMock(id) {
      const inp = (label, val) => `<div style="margin-bottom:11px"><label style="display:block;font-size:11.5px;font-weight:700;color:#374151;margin-bottom:4px">${label}</label><input value="${val}" disabled style="width:100%;padding:9px 10px;border:1.5px solid #E5E7EB;border-radius:9px;font-size:12.5px;background:#F9FAFB;color:#6B7280;box-sizing:border-box"></div>`;
      if (id === 'wz_welcome')  return `<div style="text-align:center;padding:10px 0"><div style="font-size:40px">👋</div><div style="font-size:12.5px;color:#6B7280;margin-top:8px;line-height:1.5">A quick setup gets your whole business into Groundwork — clients, pricing, and your first estimate. Takes about 2 minutes.</div></div>`;
      if (id === 'wz_profile')  return inp('Company name','Acme Landscaping') + inp('Industry','Landscaping &amp; Lawn Care') + inp('Business phone','(555) 201-8890');
      if (id === 'wz_client')   return inp('Client name','Riverside HOA') + inp('Client phone','(555) 318-2244');
      if (id === 'wz_estimate') return inp('Estimate title','Spring Cleanup — Riverside HOA') + inp('Amount','$2,450.00');
      if (id === 'wz_team')     return inp('Crew size','2–5 people') + inp('Divisions','Maintenance, Installs');
      return `<div style="font-size:12px;color:#6B7280;padding:8px 0">Built-in step — the user sees its full form here.</div>`;
    }

    function pvWizard() {
      const scr = wizardSteps.filter(s=>s.active).sort((a,b)=>(a.sort||0)-(b.sort||0));
      const total = scr.length + 1; // + done screen
      const idx = Math.min(pvS.wizIdx || 0, total - 1);
      const step = scr[idx]; // undefined ⇒ done screen
      const pct = total > 1 ? Math.round((idx / (total - 1)) * 100) : 100;

      let title = '', sub = '', body = '';
      if (!step) {
        body = `
        <div style="text-align:center;padding:8px 0 4px">
          <div style="width:56px;height:56px;border-radius:50%;background:#2D7A55;color:#fff;font-size:26px;display:flex;align-items:center;justify-content:center;margin:0 auto 12px">✓</div>
          <div style="font-size:17px;font-weight:800;color:#1F2937">You're all set!</div>
          <div style="font-size:12px;color:#6B7280;margin-top:6px">Acme Landscaping is live on Groundwork.</div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:16px">
            ${['View Estimates','View Clients','View Invoices','Dashboard'].map(l=>`<div style="border:1.5px solid #E5E7EB;border-radius:10px;padding:12px 8px;font-size:11.5px;font-weight:700;color:#374151;text-align:center">${l}</div>`).join('')}
          </div>
        </div>`;
      } else {
        title = step.title || ''; sub = step.description || '';
        let qs = null;
        if (!step.locked) { try { const p = JSON.parse(step.fields||'[]'); if (Array.isArray(p) && p.length) qs = p; } catch {} }
        if (qs) {
          body = qs.map(q=>`
          <div style="margin-bottom:12px">
            <label style="display:block;font-size:11.5px;font-weight:700;color:#374151;margin-bottom:4px">${esc(q.label||'')}</label>
            ${q.type==='select'
              ? `<select style="width:100%;padding:9px 10px;border:1.5px solid #E5E7EB;border-radius:9px;font-size:12.5px;color:#374151;background:#fff"><option>Select…</option>${(q.options||[]).map(o=>`<option>${esc(o)}</option>`).join('')}</select>`
              : `<input placeholder="Your answer…" style="width:100%;padding:9px 10px;border:1.5px solid #E5E7EB;border-radius:9px;font-size:12.5px;box-sizing:border-box">`}
          </div>`).join('');
        } else {
          body = pvWizMock(step.id);
        }
      }

      pvBody().innerHTML = `
      <div style="font-size:11px;color:#4A5546;margin-bottom:10px;text-align:center;font-weight:600">What a new company admin sees on first login — click Continue to walk through</div>
      <div style="background:#fff;border-radius:16px;box-shadow:0 10px 32px rgba(0,0,0,.16);overflow:hidden">
        <div style="height:6px;background:#F3F4F6"><div style="height:100%;width:${pct}%;background:linear-gradient(90deg,#2D7A55,#4D8A86);transition:width .3s"></div></div>
        <div style="padding:18px 22px 6px">
          <div style="font-size:10.5px;font-weight:800;letter-spacing:.08em;color:#2D7A55;text-transform:uppercase">${step?`Step ${idx+1} of ${scr.length}`:'Setup complete'}</div>
          ${title?`<div style="font-size:17px;font-weight:800;color:#1F2937;margin-top:5px">${esc(title)}</div>`:''}
          ${sub?`<div style="font-size:12px;color:#6B7280;margin-top:4px;line-height:1.4">${esc(sub)}</div>`:''}
        </div>
        <div style="padding:14px 22px 4px">${body}</div>
        <div style="display:flex;justify-content:space-between;align-items:center;padding:12px 22px 18px">
          ${idx>0?`<button onclick="window._gwOnbPvWiz(${idx-1})" style="background:none;border:none;color:#6B7280;font-size:12.5px;font-weight:700;cursor:pointer;padding:0">← Back</button>`:'<span></span>'}
          ${step
            ?`<button onclick="window._gwOnbPvWiz(${idx+1})" style="background:#2D7A55;color:#fff;border:none;border-radius:10px;padding:10px 22px;font-size:12.5px;font-weight:800;cursor:pointer">${idx===scr.length-1?'Finish':'Continue →'}</button>`
            :`<button onclick="window._gwOnbPvWiz(0)" style="background:#2D7A55;color:#fff;border:none;border-radius:10px;padding:10px 22px;font-size:12.5px;font-weight:800;cursor:pointer">↺ Restart Preview</button>`}
        </div>
      </div>`;
    }
    window._gwOnbPvWiz = function(i) { pvS.wizIdx = i; pvWizard(); };

    function pvChecklist() {
      const items = checklistSteps.filter(s=>s.active).sort((a,b)=>(a.sort||0)-(b.sort||0));
      const done = items.filter(s=>pvS.clDone[s.id]).length;
      const pct = items.length ? Math.round(done/items.length*100) : 0;
      pvBody().innerHTML = `
      <div style="font-size:11px;color:#4A5546;margin-bottom:10px;text-align:center;font-weight:600">The Getting Started panel in every new tenant dashboard — click the circles to simulate progress</div>
      <div style="background:#fff;border:1.5px solid #E5E7EB;border-radius:18px;box-shadow:0 16px 48px rgba(0,0,0,.18);overflow:hidden">
        <div style="background:linear-gradient(135deg,#1C3A2B,#2D7A55);padding:16px 18px;color:#fff">
          <div style="display:flex;justify-content:space-between;align-items:center">
            <div style="font-size:14px;font-weight:800">Getting Started</div>
            <div style="display:flex;gap:8px;align-items:center"><span style="background:rgba(255,255,255,.15);font-size:10.5px;font-weight:700;padding:4px 10px;border-radius:8px">Hide</span><span style="font-size:16px;line-height:1">✕</span></div>
          </div>
          <div style="margin-top:10px;height:7px;background:rgba(255,255,255,.2);border-radius:4px;overflow:hidden"><div style="height:100%;width:${pct}%;background:#fff;border-radius:4px;transition:width .3s"></div></div>
          <div style="font-size:11.5px;margin-top:6px;opacity:.9">${done} of ${items.length} complete — ${pct}%</div>
        </div>
        <div style="max-height:330px;overflow-y:auto">
          ${items.map(it => {
            let f = {}; try { f = JSON.parse(it.fields||'{}'); } catch {}
            const dn = !!pvS.clDone[it.id];
            return `
          <div style="display:flex;align-items:flex-start;gap:12px;padding:12px 16px;border-bottom:1px solid #F3F4F6;${dn?'opacity:.55':''}">
            <div onclick="window._gwOnbPvCl('${esc(it.id)}')" title="Click to simulate" style="width:20px;height:20px;border-radius:50%;flex-shrink:0;margin-top:1px;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:900;cursor:pointer;${dn?'background:#2D7A55;color:#fff':'border:2px solid #D1D5DB;color:transparent'}">✓</div>
            <div style="flex:1;min-width:0">
              <div style="font-size:13px;font-weight:700;color:#1F2937;${dn?'text-decoration:line-through':''}">${esc(it.title)}</div>
              <div style="font-size:11px;color:#6B7280;margin-top:2px">${esc(it.description||'')}${f.auto&&f.auto!=='manual'?` <span style="color:#7B5EA7;font-weight:700">· auto-detects</span>`:''}</div>
            </div>
            ${!dn&&f.view?`<span style="flex-shrink:0;background:#F0FAF4;border:1.5px solid #2D7A5533;color:#2D7A55;font-size:11px;font-weight:800;padding:5px 11px;border-radius:9px">${esc(f.cta||'Open')}</span>`:''}
          </div>`;
          }).join('') || '<div style="padding:30px;text-align:center;color:#9CA3AF;font-size:12px">No active checklist items.</div>'}
        </div>
      </div>
      <div style="text-align:right;margin-top:12px">
        <span style="display:inline-flex;align-items:center;background:#2D7A55;color:#fff;border-radius:26px;padding:11px 18px;font-size:12.5px;font-weight:800;box-shadow:0 6px 24px rgba(29,58,43,.35)">🚀 Getting Started <span style="background:#fff;color:#2D7A55;border-radius:10px;padding:1px 8px;font-size:11px;font-weight:800;margin-left:6px">${done}/${items.length}</span></span>
        <div style="font-size:10.5px;color:#4A5546;margin-top:6px;font-weight:600">↑ the floating launcher pinned bottom-right of the tenant dashboard</div>
      </div>`;
    }
    window._gwOnbPvCl = function(id) { pvS.clDone[id] = !pvS.clDone[id]; pvChecklist(); };

    function renderFunnel() {
      const respByCo = {};
      (funnel.responses||[]).forEach(r => (respByCo[r.company_id] = respByCo[r.company_id] || []).push(r));
      const rows = cos.map(co => {
        const clDone = clProgMap[co.id] || 0;
        const wizPct = co.onboarding_completed ? 100 : Math.min(99, Math.round(((co.onboarding_step||0) / 6) * 100));
        const answers = respByCo[co.id] || [];
        return `
<div style="border-bottom:1px solid var(--line,#e5e5e0)">
  <div onclick="window._gwOnbExpand('fn_${esc(co.id)}')" style="display:flex;align-items:center;gap:14px;padding:14px 20px;cursor:pointer" onmouseover="this.style.background='rgba(77,138,134,.05)'" onmouseout="this.style.background=''">
    <div style="flex:1;min-width:0">
      <div style="font-weight:700;font-size:14px;color:#E8E4D9">${esc(co.name||co.id)}</div>
      <div style="font-size:11.5px;color:#5C6B58">${esc(co.plan||'—')} · ${esc(co.subscription_status||'')} · joined ${ago(co.created_at)}</div>
    </div>
    <div style="width:170px;flex-shrink:0">
      <div style="font-size:11px;color:#6F7E6A;margin-bottom:4px">Wizard ${co.onboarding_completed?'<span style="color:#2D7A55;font-weight:800">✓ done</span>':`<span style="color:#8B6914;font-weight:800">step ${(co.onboarding_step||0)+1}/6</span>`}</div>
      <div style="height:6px;background:rgba(111,126,106,.15);border-radius:4px;overflow:hidden"><div style="height:100%;width:${wizPct}%;background:${co.onboarding_completed?'#2D7A55':'#8B6914'};border-radius:4px"></div></div>
    </div>
    <div style="width:120px;text-align:right;flex-shrink:0;font-size:12px;color:#6F7E6A">Checklist <span style="font-weight:800;color:#7B5EA7">${clDone}</span>${funnel.checklist_total?` <span style="opacity:.6">manual</span>`:''}</div>
    <span id="gwOnbChev_fn_${esc(co.id)}" style="color:#6F7E6A;font-size:12px">▾</span>
  </div>
  <div id="gwOnbSteps_fn_${esc(co.id)}" style="display:none;padding:4px 20px 16px 24px">
    ${answers.length ? `<div style="font-size:11px;font-weight:800;letter-spacing:.06em;text-transform:uppercase;color:#6F7E6A;margin:8px 0 6px">Custom Wizard Answers</div>
      ${answers.map(a=>`<div style="font-size:12.5px;padding:5px 0;border-bottom:1px dashed var(--line,#e5e5e0)"><span style="color:#6F7E6A">${esc(a.question)}:</span> <span style="color:#E8E4D9;font-weight:600">${esc(a.answer||'—')}</span></div>`).join('')}`
      : '<div style="font-size:12px;color:#5C6B58;padding:10px 0">No custom wizard answers recorded for this tenant.</div>'}
  </div>
</div>`;
      }).join('');
      paneEl().innerHTML = panel('Tenant Onboarding Funnel',
        `<span style="font-size:12px;color:#5C6B58">${cos.length} tenants · ${wizDone} completed the wizard</span>`,
        rows || '<div style="padding:60px;text-align:center;color:#5C6B58">No tenants yet.</div>'
      );
    }

    /* ── Handlers ────────────────────────────────────────────────────────── */
    window._gwOnbTab = function(id) {
      ['playbook','builder','funnel'].forEach(t => {
        const b = document.getElementById('gwOnbTab_'+t); if (!b) return;
        const on = t === id;
        b.style.background = on ? 'rgba(77,138,134,.15)' : 'transparent';
        b.style.borderColor = on ? '#4D8A86' : 'var(--line,#e5e5e0)';
        b.style.color = on ? '#4D8A86' : '#6F7E6A';
      });
      if (id === 'playbook') renderPlaybook();
      else if (id === 'builder') renderBuilder();
      else renderFunnel();
    };
    window._gwOnbExpand = function(id) {
      const el = document.getElementById('gwOnbSteps_'+id);
      const ch = document.getElementById('gwOnbChev_'+id);
      if (!el) return;
      const open = el.style.display !== 'none';
      el.style.display = open ? 'none' : 'block';
      if (ch) ch.style.transform = open ? '' : 'rotate(180deg)';
    };
    window._gwOnbToggle = async function(stepId, demoId, done) {
      try {
        await apiPost('/api/platform/onboarding/progress', { step_id: stepId, subject_type: 'demo', subject_id: demoId, done });
        const set = (progBySubject[demoId] = progBySubject[demoId] || new Set());
        done ? set.add(stepId) : set.delete(stepId);
        toast(done ? 'Step completed' : 'Step reopened');
      } catch(e) { toast('Error: ' + e.message); }
    };
    window._gwOnbStepModal = function(stepId, templateId) {
      const step = stepId ? steps.find(s => s.id === stepId) : null;
      _onbStepModal(step, templateId);
    };

    renderPlaybook();
  }

  // ── Step editor modal (all template types) ────────────────────────────────
  function _onbStepModal(step, templateId) {
    const isEdit = !!step;
    const isWizard = templateId === 'wizard_default';
    const isChecklist = templateId === 'checklist_default';
    const isSales = templateId === 'sales_default';
    let salesPhase = '';
    if (isSales) { try { salesPhase = JSON.parse(step?.fields||'{}').phase || ''; } catch {} }
    let fieldsText = '';
    if (isWizard) {
      let qs = []; try { qs = JSON.parse(step?.fields||'[]'); } catch {}
      fieldsText = qs.map(q => q.type === 'select' ? `${q.label} | select | ${(q.options||[]).join(', ')}` : `${q.label} | text`).join('\n');
    }
    let clMeta = { auto: 'manual', view: '', cta: 'Open' };
    if (isChecklist) { try { clMeta = Object.assign(clMeta, JSON.parse(step?.fields||'{}')); } catch {} }

    const el = document.createElement('div');
    el.id = 'gwOnbStepOverlay';
    el.style.cssText = 'position:fixed;inset:0;background:#000c;z-index:9999;display:flex;align-items:center;justify-content:center;padding:20px';
    el.innerHTML = `
<div style="background:var(--card,#1E2B29);border:1px solid var(--line,#2A3A38);border-radius:20px;width:min(620px,100%);max-height:92vh;overflow-y:auto;padding:28px">
  <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:22px">
    <h2 style="margin:0;font-size:18px;font-weight:800;color:#E8E4D9">${isEdit ? 'Edit Step' : 'New Step'}</h2>
    <button onclick="document.getElementById('gwOnbStepOverlay').remove()" style="background:none;border:none;color:#6F7E6A;font-size:20px;cursor:pointer">✕</button>
  </div>
  <div style="display:grid;gap:14px">
    <div><label class="um-label">Title *</label>
      <input id="gwOS-title" class="um-input" value="${esc(step?.title||'')}" placeholder="e.g. Kickoff call scheduled"></div>
    <div><label class="um-label">Description</label>
      <textarea id="gwOS-desc" class="um-input" rows="2" style="resize:vertical" placeholder="What does completing this step involve?">${esc(step?.description||'')}</textarea></div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
      <div><label class="um-label">Sort Order</label>
        <input id="gwOS-sort" class="um-input" type="number" min="0" value="${esc(step?.sort??'')}" placeholder="1"></div>
      <div style="display:flex;align-items:flex-end;gap:20px;padding-bottom:8px">
        ${!isWizard && !isChecklist ? `<label style="display:flex;align-items:center;gap:8px;font-size:13px;color:#6F7E6A;cursor:pointer">
          <input id="gwOS-required" type="checkbox" ${step?.required?'checked':''} style="width:16px;height:16px;accent-color:#C97B6A"> Required
        </label>` : ''}
        <label style="display:flex;align-items:center;gap:8px;font-size:13px;color:#6F7E6A;cursor:pointer">
          <input id="gwOS-active" type="checkbox" ${(step?.active??1)?'checked':''} style="width:16px;height:16px;accent-color:#4D8A86"> Active
        </label>
      </div>
    </div>
    ${isSales ? `
    <div><label class="um-label">Phase (groups steps under a header — e.g. "Discovery & Demo")</label>
      <input id="gwOS-phase" class="um-input" value="${esc(salesPhase)}" placeholder="Discovery & Demo" list="gwOSPhaseList">
      <datalist id="gwOSPhaseList"><option value="Discovery & Demo"><option value="Proposal & Close"><option value="Account Setup"><option value="Launch & Success"></datalist></div>` : ''}
    ${isWizard ? `
    <div><label class="um-label">Questions (one per line: <code style="font-size:11px">Label | text</code> or <code style="font-size:11px">Label | select | Opt1, Opt2</code>)</label>
      <textarea id="gwOS-questions" class="um-input" rows="6" style="resize:vertical;font-family:monospace;font-size:12px" placeholder="What tools do you use today? | text&#10;Team size? | select | Just me, 2-5, 6-10, 11+">${esc(fieldsText)}</textarea></div>` : ''}
    ${isChecklist ? `
    <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px">
      <div><label class="um-label">Auto-detect</label>
        <select id="gwOS-auto" class="um-input">
          ${['manual','wizard','branding','clients','price_items','estimates','work_orders','invoices','stripe','reps','google'].map(a=>`<option value="${a}" ${clMeta.auto===a?'selected':''}>${a==='manual'?'Manual check-off':a}</option>`).join('')}
        </select></div>
      <div><label class="um-label">Opens view</label>
        <input id="gwOS-view" class="um-input" value="${esc(clMeta.view||'')}" placeholder="clients"></div>
      <div><label class="um-label">Button label</label>
        <input id="gwOS-cta" class="um-input" value="${esc(clMeta.cta||'')}" placeholder="Add Client"></div>
    </div>` : ''}
  </div>
  <div style="display:flex;justify-content:space-between;align-items:center;margin-top:24px">
    ${isEdit && !step.locked ? dangerBtn('Delete Step',`window._gwOnbDeleteStep('${esc(step.id)}')`) : '<span></span>'}
    <div style="display:flex;gap:10px">
      <button class="secondary-btn" onclick="document.getElementById('gwOnbStepOverlay').remove()">Cancel</button>
      <button class="primary-btn" onclick="window._gwOnbSaveStep('${esc(step?.id||'')}','${esc(templateId)}')">${isEdit ? 'Save' : 'Create Step'}</button>
    </div>
  </div>
</div>`;
    document.body.appendChild(el);

    window._gwOnbSaveStep = async function(existingId, tplId) {
      const payload = {
        title:       document.getElementById('gwOS-title')?.value?.trim(),
        description: document.getElementById('gwOS-desc')?.value?.trim() || '',
        sort:        parseInt(document.getElementById('gwOS-sort')?.value)||0,
        required:    document.getElementById('gwOS-required')?.checked ? 1 : 0,
        active:      document.getElementById('gwOS-active')?.checked ? 1 : 0,
      };
      if (!payload.title) { toast('Title required'); return; }
      if (tplId === 'wizard_default') {
        const lines = (document.getElementById('gwOS-questions')?.value||'').split('\n').map(s=>s.trim()).filter(Boolean);
        payload.fields = lines.map((ln,i) => {
          const parts = ln.split('|').map(p=>p.trim());
          const q = { key: 'q'+(i+1), label: parts[0]||ln, type: (parts[1]||'text').toLowerCase()==='select'?'select':'text' };
          if (q.type==='select') q.options = (parts[2]||'').split(',').map(o=>o.trim()).filter(Boolean);
          return q;
        });
      }
      if (tplId === 'checklist_default') {
        payload.fields = {
          auto: document.getElementById('gwOS-auto')?.value || 'manual',
          view: document.getElementById('gwOS-view')?.value?.trim() || '',
          cta:  document.getElementById('gwOS-cta')?.value?.trim() || 'Open',
        };
      }
      if (tplId === 'sales_default') {
        payload.fields = { phase: document.getElementById('gwOS-phase')?.value?.trim() || '' };
      }
      try {
        if (existingId) { await apiPut(`/api/platform/onboarding/steps/${existingId}`, payload); toast('Step updated'); }
        else { await apiPost('/api/platform/onboarding/steps', Object.assign({ template_id: tplId }, payload)); toast('Step created'); }
        document.getElementById('gwOnbStepOverlay')?.remove();
        show('gwOnboarding');
        setTimeout(()=>{ try { window._gwOnbTab('builder'); } catch(e){} }, 400);
      } catch(e) { toast('Error: ' + e.message); }
    };
    window._gwOnbDeleteStep = async function(id) {
      if (!confirm('Delete this step? Progress recorded against it will also be removed.')) return;
      try {
        await apiDelete(`/api/platform/onboarding/steps/${id}`);
        document.getElementById('gwOnbStepOverlay')?.remove();
        toast('Step deleted');
        show('gwOnboarding');
        setTimeout(()=>{ try { window._gwOnbTab('builder'); } catch(e){} }, 400);
      } catch(e) { toast('Error: ' + e.message); }
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // REGISTER MODULE
  // ─────────────────────────────────────────────────────────────────────────
  window.gwPlatformAdmin = {
    overview,
    tenants,
    leads,
    demos,
    pricingPlans,
    onboarding,
    support,
    announce,
    billing,
    platformSettings
  };

  // Also wire the legacy _saImpersonate to the new handler
  window._saImpersonate = _gwImpersonate;

})();
