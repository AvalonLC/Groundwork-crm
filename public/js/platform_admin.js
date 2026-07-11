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

  const PLAN_COLORS = { trial:'#8B6914', starter:'#1A4740', pro:'#4D8A86', enterprise:'#2D7A55', churned:'#C97B6A' };
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

  // ── Shared page shell ────────────────────────────────────────────────────
  function shell(title, subtitle, breadcrumb, actionHtml, bodyHtml) {
    return `
<div style="max-width:1280px;margin:0 auto;padding:28px 20px 60px">
  <!-- Page header -->
  <div style="display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:28px;gap:16px;flex-wrap:wrap">
    <div>
      <div style="font-size:11px;color:#5C6B58;font-weight:600;text-transform:uppercase;letter-spacing:.07em;margin-bottom:6px">${esc(breadcrumb)}</div>
      <h1 style="font-size:26px;font-weight:900;color:#E8E4D9;margin:0 0 4px;letter-spacing:-.02em">${title}</h1>
      ${subtitle ? `<p style="color:#6F7E6A;margin:0;font-size:14px">${subtitle}</p>` : ''}
    </div>
    ${actionHtml ? `<div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center">${actionHtml}</div>` : ''}
  </div>
  ${bodyHtml}
</div>`;
  }

  function statCard(label, value, icon, color, sub) {
    return `
<div style="background:var(--card,#fff);border:1px solid ${color}33;border-radius:14px;padding:20px;position:relative;overflow:hidden">
  <div style="position:absolute;top:16px;right:16px;opacity:.15;font-size:40px">${icon}</div>
  <div style="font-size:28px;font-weight:900;color:${color};margin-bottom:4px">${value}</div>
  <div style="font-size:12px;color:#6F7E6A;font-weight:700;text-transform:uppercase;letter-spacing:.05em">${esc(label)}</div>
  ${sub ? `<div style="font-size:11px;color:#5C6B58;margin-top:6px">${sub}</div>` : ''}
</div>`;
  }

  function panel(title, rightHtml, bodyHtml, extra) {
    return `
<div style="background:var(--card,#fff);border:1px solid var(--line,#e5e5e0);border-radius:16px;overflow:hidden;${extra||''}">
  <div style="display:flex;align-items:center;justify-content:space-between;padding:18px 20px;border-bottom:1px solid var(--line,#e5e5e0);flex-wrap:wrap;gap:10px">
    <h2 style="font-size:14px;font-weight:800;color:#E8E4D9;margin:0;text-transform:uppercase;letter-spacing:.06em">${title}</h2>
    ${rightHtml ? `<div style="display:flex;gap:8px;align-items:center">${rightHtml}</div>` : ''}
  </div>
  ${bodyHtml}
</div>`;
  }

  function actionBtn(label, onclick, style) {
    return `<button onclick="${onclick}" style="padding:8px 18px;background:rgba(77,138,134,.15);border:1px solid #4D8A8644;border-radius:10px;color:#4D8A86;font-size:13px;font-weight:700;cursor:pointer;${style||''}" onmouseover="this.style.background='rgba(77,138,134,.25)'" onmouseout="this.style.background='rgba(77,138,134,.15)'">${label}</button>`;
  }
  function primaryBtn(label, onclick, style) {
    return `<button onclick="${onclick}" style="padding:9px 20px;background:#4D8A86;border:none;border-radius:10px;color:#fff;font-size:13px;font-weight:700;cursor:pointer;${style||''}" onmouseover="this.style.opacity='.85'" onmouseout="this.style.opacity='1'">${label}</button>`;
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

    let stats = {}, companies = [], recentTickets = [], recentLeads = [];
    try {
      [stats, companies, recentTickets, recentLeads] = await Promise.all([
        apiGet('/api/admin/stats'),
        apiGet('/api/admin/companies'),
        apiGet('/api/platform/tickets?limit=5&status=open'),
        apiGet('/api/platform/gw-leads?limit=5'),
      ]);
      if (!Array.isArray(companies)) companies = [];
      if (!Array.isArray(recentTickets)) recentTickets = [];
      if (!Array.isArray(recentLeads)) recentLeads = [];
    } catch(e) {
      v.innerHTML = `<div style="padding:60px;text-align:center"><p style="color:#C97B6A">Failed to load: ${esc(e.message)}</p>
        <button class="secondary-btn" style="margin-top:16px" onclick="show('superAdmin')">↺ Retry</button></div>`;
      return;
    }

    const activeCompanies = companies.filter(c => c.active).length;
    const trialCompanies  = companies.filter(c => c.plan === 'trial').length;
    const mrr = companies.filter(c=>c.active && c.plan !== 'trial')
      .reduce((s,c) => s + ({starter:99,pro:249,enterprise:499}[c.plan]||0), 0);

    v.innerHTML = shell(
      `${gwI('shield',22,'#7EC8A4')} Platform Overview`,
      `Groundwork CRM · ${new Date().toLocaleDateString('en-US',{weekday:'long',month:'long',day:'numeric'})}`,
      'PLATFORM ADMIN',
      `${actionBtn('↺ Refresh','show(\'superAdmin\')')}
       ${primaryBtn('+ New Lead','show(\'gwLeads\')')}`,
      `
      <!-- Stat Grid -->
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:16px;margin-bottom:28px">
        ${statCard('Total Tenants',   fmt(companies.length),  '🏢', '#1A4740', `${activeCompanies} active`)}
        ${statCard('On Trial',        fmt(trialCompanies),    '⏱', '#8B6914', 'Convert to paid')}
        ${statCard('Monthly Revenue', fmtMoney(mrr),          '💰', '#2D7A55', 'est. MRR')}
        ${statCard('Total Reps',      fmt(stats.reps),        '👥', '#4D8A86', 'across all tenants')}
        ${statCard('Open Tickets',    fmt(recentTickets.length),'🎫','#C97B6A', 'need attention')}
        ${statCard('Active Opps',     fmt(stats.opportunities),'📈','#7B5EA7', 'in all pipelines')}
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
          </div>` : '<div style="padding:40px;text-align:center;color:#5C6B58">No open tickets 🎉</div>'
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

    const PLANS = ['trial','starter','pro','enterprise'];

    v.innerHTML = shell(
      'Customer Tenants',
      `${companies.length} companies using Groundwork CRM`,
      'PLATFORM ADMIN › TENANTS',
      primaryBtn('+ Onboard New Company', 'window._gwNewTenant()'),
      `
      <!-- Filters -->
      <div style="display:flex;gap:10px;margin-bottom:20px;flex-wrap:wrap">
        ${['all','trial','starter','pro','enterprise'].map(p => `
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
          ${['trial','starter','pro','enterprise'].map(p=>`<option value="${p}" ${(co?.plan||'trial')===p?'selected':''}>${p.charAt(0).toUpperCase()+p.slice(1)}</option>`).join('')}
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
        ${statCard('Total Leads',      fmt(gwLeads.length),   '📋','#4D8A86')}
        ${statCard('Pipeline Value',   fmtMoney(pipeValue),   '💼','#8B6914','open deals')}
        ${statCard('Closed Won',       fmt(byStage.closed_won.length),'🏆','#2D7A55', fmtMoney(wonValue))}
        ${statCard('Closed Lost',      fmt(byStage.closed_lost.length),'❌','#C97B6A')}
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
        ${statCard('Open', fmt(byStatus.open||0), '🔴', '#C97B6A')}
        ${statCard('In Progress', fmt(byStatus.in_progress||0), '🟡', '#8B6914')}
        ${statCard('Waiting', fmt(byStatus.waiting||0), '🔵', '#4D8A86')}
        ${statCard('Resolved', fmt(byStatus.resolved||0), '🟢', '#2D7A55')}
      </div>

      <!-- Tickets list -->
      ${panel('All Tickets',
        `<span style="font-size:12px;color:#5C6B58" id="gwTicketCount">${tickets.length} total</span>`,
        `<div id="gwTicketsList">
          ${tickets.length ? tickets.map(_ticketRow).join('') : '<div style="padding:60px;text-align:center;color:#5C6B58">No tickets yet 🎉</div>'}
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

    const PLAN_PRICES = { trial:0, starter:99, pro:249, enterprise:499 };
    const active = companies.filter(c => c.active);
    const mrr = active.reduce((s,c) => s + (PLAN_PRICES[c.plan]||0), 0);
    const arr = mrr * 12;
    const byPlan = {};
    ['trial','starter','pro','enterprise'].forEach(p => byPlan[p] = companies.filter(c=>c.plan===p));

    v.innerHTML = shell(
      'Billing & Plans',
      'Revenue overview and tenant plan management',
      'PLATFORM ADMIN › BILLING',
      '',
      `
      <!-- Revenue cards -->
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:16px;margin-bottom:28px">
        ${statCard('Monthly Revenue', fmtMoney(mrr), '💰', '#2D7A55', 'est. MRR')}
        ${statCard('Annual Revenue',  fmtMoney(arr), '📊', '#1A4740', 'est. ARR')}
        ${statCard('Paid Accounts',   fmt(active.filter(c=>c.plan!=='trial').length), '✅', '#4D8A86')}
        ${statCard('On Trial',        fmt(byPlan.trial?.length||0), '⏱', '#8B6914', 'need conversion')}
      </div>

      <!-- Plan breakdown -->
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:16px;margin-bottom:28px">
        ${['starter','pro','enterprise'].map(plan => {
          const cos = byPlan[plan] || [];
          const rev = cos.filter(c=>c.active).length * PLAN_PRICES[plan];
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
                ${['trial','starter','pro','enterprise'].map(p=>`<option value="${p}" ${co.plan===p?'selected':''}>${p.charAt(0).toUpperCase()+p.slice(1)}</option>`).join('')}
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
                <div style="font-size:15px;font-weight:700;color:#E8E4D9">Tyler Grigg</div>
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
  // REGISTER MODULE
  // ─────────────────────────────────────────────────────────────────────────
  window.gwPlatformAdmin = {
    overview,
    tenants,
    leads,
    support,
    announce,
    billing,
    platformSettings
  };

  // Also wire the legacy _saImpersonate to the new handler
  window._saImpersonate = _gwImpersonate;

})();
