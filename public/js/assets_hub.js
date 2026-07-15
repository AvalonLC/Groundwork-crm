// ═══════════════════════════════════════════════════════════════════════════
// GROUNDWORK — UNIFIED ASSETS HUB
// One page for Equipment, Maintenance, Inventory & Tools — D1-backed so the
// whole team (office, mechanic, foremen) sees the same live data.
//
// Data model (migration 0031):
//   assets              — vehicles/trailers/equipment/mowers/attachments
//   asset_service_plans — per-asset service schedule rows (oil/air/fuel/…)
//   asset_service_log   — completed service history
//   stock_items         — unified inventory + tools + consumables
//
// Framework modeled on the Avalon Asset Maintenance spreadsheet:
//   meter-based intervals (mi/hr) + calendar intervals (months), material
//   specs per service, last/next tracking, due status computation.
// ═══════════════════════════════════════════════════════════════════════════
(function(){
'use strict';

const AH = window._AH = { assets: [], plans: [], stock: [], log: [], loaded: false, loading: null };

// ── Role helpers ─────────────────────────────────────────────────────────────
const WRITE_ROLES = ['admin', 'office_manager', 'division_manager', 'mechanic'];
const LOG_ROLES   = WRITE_ROLES.concat(['foreman', 'field_supervisor', 'laborer']);
function _rep()     { return (window.getCurrentRep ? window.getCurrentRep() : null) || window._d1SessionRep || null; }
function _role()    { const r = _rep(); return r ? r.role : 'admin'; }
function canWrite() { const r = _rep(); return !r || WRITE_ROLES.includes(r.role); }
function canLog()   { const r = _rep(); return !r || LOG_ROLES.includes(r.role); }

// ── Small utils ──────────────────────────────────────────────────────────────
function esc(s){ return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function icon(n,s,c){ return (typeof window.gwIcon==='function') ? window.gwIcon(n,s||16,c) : ''; }
function fmtDate(d){
  if (!d) return '—';
  try { const dt = new Date(String(d).slice(0,10)+'T12:00:00'); return dt.toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'}); }
  catch(e){ return d; }
}
function fmtNum(n){ if (n==null||n==='') return '—'; return Number(n).toLocaleString(); }
function todayStr(){ return new Date().toISOString().slice(0,10); }
function toast(msg, type){ if (window.showToast) window.showToast(msg, type||'success'); }

async function api(path, opts) {
  const r = await fetch(path, Object.assign({ credentials: 'include', headers: {'Content-Type':'application/json'} }, opts||{}));
  const j = await r.json().catch(()=>({}));
  if (!r.ok || j.ok === false) throw new Error(j.error || ('HTTP '+r.status));
  return (j && j.data !== undefined) ? j.data : j;
}

// ── Data load ────────────────────────────────────────────────────────────────
async function loadAll(force) {
  if (AH.loading) return AH.loading;
  if (AH.loaded && !force) return;
  AH.loading = (async () => {
    try {
      const [assetData, stock, log] = await Promise.all([
        api('/api/assets'), api('/api/stock'), api('/api/service-log')
      ]);
      AH.assets = assetData.assets || [];
      AH.plans  = assetData.plans  || [];
      AH.stock  = stock || [];
      AH.log    = log || [];
      AH.loaded = true;
    } finally { AH.loading = null; }
  })();
  return AH.loading;
}
function plansFor(assetId){ return AH.plans.filter(p => p.asset_id === assetId); }
function assetById(id){ return AH.assets.find(a => a.id === id); }

// ── Service due status ───────────────────────────────────────────────────────
// Returns {code:'overdue'|'due-soon'|'ok'|'unset', reason}
function planStatus(plan, asset) {
  const today = todayStr();
  const meter = asset && asset.current_meter != null ? Number(asset.current_meter) : null;
  let byDate = null, byMeter = null;
  if (plan.next_date) {
    if (plan.next_date <= today) byDate = 'overdue';
    else {
      const soon = new Date(Date.now() + 30*864e5).toISOString().slice(0,10);
      byDate = plan.next_date <= soon ? 'due-soon' : 'ok';
    }
  }
  if (plan.next_meter != null && meter != null) {
    const remaining = Number(plan.next_meter) - meter;
    const soonWindow = Math.max((Number(plan.interval_meter)||0) * 0.1, 10);
    byMeter = remaining <= 0 ? 'overdue' : (remaining <= soonWindow ? 'due-soon' : 'ok');
  }
  const rank = { 'overdue': 3, 'due-soon': 2, 'ok': 1 };
  const worst = [byDate, byMeter].filter(Boolean).sort((a,b)=>(rank[b]||0)-(rank[a]||0))[0];
  return worst || 'unset';
}
function assetDueSummary(asset) {
  const plans = plansFor(asset.id);
  let overdue = 0, dueSoon = 0, next = null;
  plans.forEach(p => {
    const st = planStatus(p, asset);
    if (st === 'overdue') overdue++;
    else if (st === 'due-soon') dueSoon++;
    if (p.next_date && (!next || p.next_date < next)) next = p.next_date;
  });
  return { overdue, dueSoon, next, planCount: plans.length };
}
function statusBadge(code) {
  const map = {
    'overdue':  ['OVERDUE',  '#A05050'],
    'due-soon': ['DUE SOON', '#8B6914'],
    'ok':       ['OK',       '#2D7A55'],
    'unset':    ['—',        '#6F7E6A'],
  };
  const [label, color] = map[code] || map.unset;
  return `<span style="font-size:10px;font-weight:800;letter-spacing:.04em;color:${color};background:${color}18;border:1px solid ${color}40;border-radius:10px;padding:2px 8px;white-space:nowrap">${label}</span>`;
}
function assetStatusBadge(status) {
  const map = {
    active:'#2D7A55', idle:'#6F7E6A', maintenance:'#8B6914',
    retired:'#A05050', rented:'#4D8A86', 'out-of-service':'#A05050'
  };
  const c = map[status] || '#6F7E6A';
  const label = (status||'active').replace(/-/g,' ').toUpperCase();
  return `<span style="font-size:10px;font-weight:800;letter-spacing:.04em;color:${c};background:${c}18;border:1px solid ${c}40;border-radius:10px;padding:2px 8px;white-space:nowrap">${label}</span>`;
}

const CATEGORIES = [
  ['vehicle','Vehicle'],['trailer','Trailer'],['equipment','Equipment'],['mower','Mower'],
  ['attachment','Attachment'],['tool','Tool'],['tech','Tech'],['other','Other']
];
const SERVICE_TYPES = [
  ['oil','Oil & Filter'],['air','Air Filter'],['fuel','Fuel Filter'],
  ['brakes','Brakes'],['rotors','Rotors'],['blades','Blades'],
  ['hydraulic','Hydraulic'],['grease','Grease / Lube'],['tires','Tires'],
  ['inspection','Inspection'],['custom','Custom']
];
const STOCK_TYPES = [
  ['material','Material'],['part','Part'],['supply','Supply'],['tool','Tool'],
  ['consumable','Consumable'],['safety','Safety'],['chemical','Chemical'],['other','Other']
];
function catLabel(c){ const f = CATEGORIES.find(x=>x[0]===c); return f ? f[1] : (c||'Other'); }
function svcLabel(t){ const f = SERVICE_TYPES.find(x=>x[0]===t); return f ? f[1] : (t||'Service'); }
function stockTypeLabel(t){ const f = STOCK_TYPES.find(x=>x[0]===t); return f ? f[1] : (t||'Other'); }

// ═════════════════════════════════════════════════════════════════════════════
// MAIN HUB — assetsHub(tab)
// ═════════════════════════════════════════════════════════════════════════════
function assetsHub(tab) {
  tab = tab || window._ahTab || 'equipment';
  window._ahTab = tab;
  window._currentView = 'assetsHub';

  // Workspace header (Operations sidebar w/ Assets highlighted)
  if (typeof _gwSetHeader === 'function' && typeof _gwOpsNavConfig === 'function') {
    _gwSetHeader('Operations', _gwOpsNavConfig(), 'assetsHub');
  }

  const view = document.getElementById('view');
  if (!view) return;

  const tabs = [
    { id:'equipment',   label:'Equipment' },
    { id:'maintenance', label:'Maintenance' },
    { id:'inventory',   label:'Inventory & Tools' },
  ];
  if (typeof _gwSetSubHeader === 'function') _gwSetSubHeader(tabs, tab, 'gwAssetsTab');
  // Clear previous content — the innerHTML patch re-injects the sub-tab bar
  view.innerHTML = '';

  if (!AH.loaded) {
    view.insertAdjacentHTML('beforeend', `<div style="padding:60px;text-align:center;color:var(--gw-muted)">Loading assets…</div>`);
    loadAll().then(() => assetsHub(tab)).catch(e => {
      view.insertAdjacentHTML('beforeend', `<div style="padding:40px;text-align:center;color:#A05050">Could not load assets: ${esc(e.message)}</div>`);
    });
    return;
  }

  if (tab === 'maintenance')      renderMaintenance(view);
  else if (tab === 'inventory')   renderInventory(view);
  else                            renderEquipment(view);
}
window.assetsHub = assetsHub;
window.gwAssetsTab = function(t){ assetsHub(t); };

// ═════════════════════════════════════════════════════════════════════════════
// TAB 1 — EQUIPMENT
// ═════════════════════════════════════════════════════════════════════════════
function renderEquipment(view) {
  const q = (window._ahSearch||'').toLowerCase();
  const catF = window._ahCatFilter || '';
  let assets = AH.assets.slice();
  if (q)    assets = assets.filter(a => [a.name,a.make,a.model,a.vin,a.asset_tag,a.assigned_to].join(' ').toLowerCase().includes(q));
  if (catF) assets = assets.filter(a => a.category === catF);

  // Sort: overdue first, then due-soon, then by category/name
  assets.sort((a,b) => {
    const sa = assetDueSummary(a), sb = assetDueSummary(b);
    if (sb.overdue - sa.overdue) return sb.overdue - sa.overdue;
    if (sb.dueSoon - sa.dueSoon) return sb.dueSoon - sa.dueSoon;
    return (a.category||'').localeCompare(b.category||'') || (a.name||'').localeCompare(b.name||'');
  });

  const totals = { total: AH.assets.length, overdue: 0, dueSoon: 0, active: 0 };
  AH.assets.forEach(a => {
    const s = assetDueSummary(a);
    if (s.overdue) totals.overdue++;
    else if (s.dueSoon) totals.dueSoon++;
    if (a.status === 'active') totals.active++;
  });

  const catCounts = {};
  AH.assets.forEach(a => { catCounts[a.category] = (catCounts[a.category]||0)+1; });
  const catChips = [''].concat(CATEGORIES.map(c=>c[0]).filter(c=>catCounts[c]))
    .map(c => `<button class="ah-chip${catF===c?' ah-chip--on':''}" onclick="window._ahSetCat('${c}')">${c?catLabel(c):'All'}${c?` <span style="opacity:.6">${catCounts[c]}</span>`:''}</button>`).join('');

  const isMobile = window.innerWidth <= 768;

  const rows = assets.map(a => {
    const due = assetDueSummary(a);
    const dueBadge = due.overdue ? statusBadge('overdue') : due.dueSoon ? statusBadge('due-soon') : due.planCount ? statusBadge('ok') : statusBadge('unset');
    const meterStr = a.current_meter != null ? `${fmtNum(a.current_meter)} <span style="font-size:10px;color:var(--gw-muted)">${a.meter_type==='miles'?'mi':'hrs'}</span>` : '—';
    const ymm = [a.year, a.make, a.model].filter(Boolean).join(' ');
    if (isMobile) {
      return `<div class="ah-mcard" onclick="window.ahAssetDetail('${a.id}')">
        <div class="ah-mcard-top">
          <span class="ah-mcard-name">${a.asset_tag?`<span class="ah-tag">${esc(a.asset_tag)}</span> `:''}${esc(a.name)}</span>
          ${dueBadge}
        </div>
        <div class="ah-mcard-sub">${esc(catLabel(a.category))}${ymm?` · ${esc(ymm)}`:''}</div>
        <div class="ah-mcard-bottom">
          <span>${meterStr}</span>
          <span style="color:var(--gw-muted);font-size:11px">Next: ${fmtDate(due.next)}</span>
          ${assetStatusBadge(a.status)}
        </div>
      </div>`;
    }
    return `<tr class="ah-row" onclick="window.ahAssetDetail('${a.id}')">
      <td class="ah-td"><span style="font-weight:600">${a.asset_tag?`<span class="ah-tag">${esc(a.asset_tag)}</span> `:''}${esc(a.name)}</span>
        ${a.assigned_to?`<div style="font-size:11px;color:var(--gw-muted)">→ ${esc(a.assigned_to)}</div>`:''}</td>
      <td class="ah-td">${esc(catLabel(a.category))}</td>
      <td class="ah-td" style="font-size:12px">${esc(ymm)||'—'}<div style="font-size:10px;color:var(--gw-muted)">${esc(a.vin||'')}</div></td>
      <td class="ah-td" style="text-align:right;font-weight:700">${meterStr}</td>
      <td class="ah-td" style="font-size:12px">${fmtDate(due.next)}</td>
      <td class="ah-td">${dueBadge}</td>
      <td class="ah-td">${assetStatusBadge(a.status)}</td>
    </tr>`;
  }).join('');

  const emptyState = !AH.assets.length ? `
    <div style="padding:48px 24px;text-align:center">
      <p style="color:var(--gw-muted);margin-bottom:14px">No equipment tracked yet.</p>
      ${canWrite() ? `<div style="display:flex;gap:8px;justify-content:center;flex-wrap:wrap">
        <button class="primary-btn" onclick="window._ahNewAsset()">+ Add Equipment</button>
        <button class="secondary-btn" onclick="window._ahImportExport('assets')">⇪ Import from Spreadsheet</button>
      </div>`:''}
    </div>` : '';

  view.insertAdjacentHTML('beforeend', `
  <div class="ah-shell">
    <header class="ah-header">
      <div>
        <h1 style="margin:0 0 4px">Assets</h1>
        <p style="margin:0;font-size:13px;color:var(--gw-muted)">
          ${totals.total} tracked · ${totals.active} active
          ${totals.overdue?` · <strong style="color:#A05050">${totals.overdue} overdue service</strong>`:''}
          ${totals.dueSoon?` · <strong style="color:#8B6914">${totals.dueSoon} due soon</strong>`:''}
        </p>
      </div>
      <div class="ah-header-actions">
        ${canWrite() ? `<button class="secondary-btn" onclick="window._ahImportExport('assets')" style="font-size:13px">⇅ Import / Export</button>
        <button class="primary-btn" onclick="window._ahNewAsset()" style="font-size:13px">+ Add Equipment</button>`:''}
      </div>
    </header>
    <div class="ah-toolbar">
      <input type="search" class="ah-search" placeholder="Search name, make, VIN, tag…" value="${esc(window._ahSearch||'')}"
        oninput="window._ahSearch=this.value;window.assetsHub('equipment')">
      <div class="ah-chips">${catChips}</div>
    </div>
    ${emptyState || (isMobile
      ? `<div class="ah-mlist">${rows || '<div style="padding:30px;text-align:center;color:var(--gw-muted)">No matches.</div>'}</div>`
      : `<div class="ah-table-wrap"><table class="ah-table">
          <thead><tr>
            <th class="ah-th">Asset</th><th class="ah-th">Category</th><th class="ah-th">Year / Make / Model</th>
            <th class="ah-th" style="text-align:right">Meter</th><th class="ah-th">Next Service</th>
            <th class="ah-th">Service</th><th class="ah-th">Status</th>
          </tr></thead>
          <tbody>${rows || '<tr><td colspan="7" style="padding:30px;text-align:center;color:var(--gw-muted)">No matches.</td></tr>'}</tbody>
        </table></div>`)}
  </div>`);
}
window._ahSetCat = function(c){ window._ahCatFilter = c; assetsHub('equipment'); };

// ── New asset ────────────────────────────────────────────────────────────────
window._ahNewAsset = async function() {
  if (!canWrite()) return;
  try {
    const r = await api('/api/assets', { method:'POST', body: JSON.stringify({ name:'New Asset', category:'equipment', status:'active' }) });
    await loadAll(true);
    window.ahAssetDetail(r.id, true);
  } catch(e){ toast('Could not create asset: '+e.message, 'error'); }
};

// ═════════════════════════════════════════════════════════════════════════════
// ASSET DETAIL — profile + service plan grid + history + log service
// ═════════════════════════════════════════════════════════════════════════════
async function ahAssetDetail(id, isNew) {
  window._currentView = 'assetsHub';
  if (typeof _gwSetHeader === 'function' && typeof _gwOpsNavConfig === 'function') {
    _gwSetHeader('Operations', _gwOpsNavConfig(), 'assetsHub');
  }
  const view = document.getElementById('view');
  if (!view) return;
  if (!AH.loaded) { await loadAll(); }
  const a = assetById(id);
  if (!a) { assetsHub('equipment'); return; }
  const plans = plansFor(id);
  const w = canWrite();
  const lg = canLog();

  let history = [];
  try { history = await api(`/api/assets/${id}/log`); } catch(e) {}

  const meterUnit = a.meter_type === 'miles' ? 'mi' : 'hrs';

  const planRows = plans.map((p) => {
    const st = planStatus(p, a);
    return `<tr class="ah-plan-row" data-plan="${p.id}">
      <td class="ah-td" style="font-weight:600">${esc(p.label || svcLabel(p.service_type))}</td>
      <td class="ah-td" style="font-size:11px;max-width:260px">${esc(p.material_spec||'')}</td>
      <td class="ah-td" style="text-align:center;font-size:12px">${p.interval_meter?fmtNum(p.interval_meter)+' '+meterUnit:''}${p.interval_meter&&p.interval_months?' / ':''}${p.interval_months?p.interval_months+' mo':''}</td>
      <td class="ah-td" style="font-size:12px">${fmtDate(p.last_date)}${p.last_meter!=null?`<div style="font-size:10px;color:var(--gw-muted)">@ ${fmtNum(p.last_meter)}</div>`:''}</td>
      <td class="ah-td" style="font-size:12px">${fmtDate(p.next_date)}${p.next_meter!=null?`<div style="font-size:10px;color:var(--gw-muted)">@ ${fmtNum(p.next_meter)}</div>`:''}</td>
      <td class="ah-td">${statusBadge(st)}</td>
      <td class="ah-td" style="white-space:nowrap">
        ${lg?`<button class="ah-btn-sm ah-btn-sm--primary" onclick="window._ahLogSvcModal('${id}','${p.id}')">Log Service</button>`:''}
        ${w?`<button class="ah-btn-sm" onclick="window._ahEditPlanModal('${id}','${p.id}')">Edit</button>
        <button class="ah-btn-sm ah-btn-sm--danger" onclick="window._ahDeletePlan('${id}','${p.id}')">✕</button>`:''}
      </td>
    </tr>`;
  }).join('');

  const histRows = history.slice(0, 30).map(h => `
    <tr>
      <td class="ah-td" style="font-size:12px">${fmtDate(h.performed_date)}</td>
      <td class="ah-td" style="font-weight:600;font-size:12px">${esc(h.service_type ? svcLabel(h.service_type) : 'Service')}</td>
      <td class="ah-td" style="font-size:12px;text-align:right">${h.performed_meter!=null?fmtNum(h.performed_meter)+' '+meterUnit:'—'}</td>
      <td class="ah-td" style="font-size:12px">${esc(h.performed_by||'—')}</td>
      <td class="ah-td" style="font-size:12px;text-align:right">${h.cost!=null?'$'+Number(h.cost).toLocaleString():'—'}</td>
      <td class="ah-td" style="font-size:11px;color:var(--gw-muted)">${esc(h.notes||'')}</td>
    </tr>`).join('');

  const fieldRO = w ? '' : 'disabled';

  view.innerHTML = `
  <div class="ah-shell">
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:14px;font-size:13px">
      <button class="ah-crumb" onclick="window.assetsHub('equipment')">← Assets</button>
      <span style="color:var(--gw-muted)">›</span>
      <span style="font-weight:700">${esc(a.name)}</span>
      ${assetStatusBadge(a.status)}
    </div>

    <div class="ah-detail-grid">
      <!-- ── Profile card ── -->
      <section class="card">
        <h2 style="margin-top:0">Asset Profile</h2>
        <div class="ah-form-grid">
          <label class="ah-field"><span>Tag / ID</span><input id="ah-f-tag" value="${esc(a.asset_tag||'')}" placeholder="#01" ${fieldRO}></label>
          <label class="ah-field" style="grid-column:span 2"><span>Name *</span><input id="ah-f-name" value="${esc(a.name||'')}" ${fieldRO}></label>
          <label class="ah-field"><span>Category</span><select id="ah-f-cat" ${fieldRO}>${CATEGORIES.map(c=>`<option value="${c[0]}"${a.category===c[0]?' selected':''}>${c[1]}</option>`).join('')}</select></label>
          <label class="ah-field"><span>Year</span><input id="ah-f-year" type="number" value="${a.year||''}" ${fieldRO}></label>
          <label class="ah-field"><span>Make</span><input id="ah-f-make" value="${esc(a.make||'')}" ${fieldRO}></label>
          <label class="ah-field"><span>Model</span><input id="ah-f-model" value="${esc(a.model||'')}" ${fieldRO}></label>
          <label class="ah-field" style="grid-column:span 2"><span>VIN / SKU / Serial</span><input id="ah-f-vin" value="${esc(a.vin||'')}" ${fieldRO}></label>
          <label class="ah-field"><span>Status</span><select id="ah-f-status" ${fieldRO}>${['active','idle','maintenance','retired','rented','out-of-service'].map(s=>`<option value="${s}"${a.status===s?' selected':''}>${s.replace(/-/g,' ')}</option>`).join('')}</select></label>
          <label class="ah-field"><span>Assigned To</span><input id="ah-f-assigned" value="${esc(a.assigned_to||'')}" placeholder="Crew / employee" ${fieldRO}></label>
          <label class="ah-field"><span>Location</span><input id="ah-f-loc" value="${esc(a.location||'')}" placeholder="Shop / yard" ${fieldRO}></label>
        </div>
        <label class="ah-field" style="margin-top:8px"><span>Engine / Service Notes</span><textarea id="ah-f-engine" rows="2" ${fieldRO}>${esc(a.engine_notes||'')}</textarea></label>
        <label class="ah-field" style="margin-top:8px"><span>General Notes</span><textarea id="ah-f-notes" rows="2" ${fieldRO}>${esc(a.notes||'')}</textarea></label>
        ${w?`<div style="margin-top:12px;display:flex;gap:8px;flex-wrap:wrap">
          <button class="primary-btn" onclick="window._ahSaveAsset('${id}')">Save Changes</button>
          <button class="danger-btn" onclick="window._ahDeleteAsset('${id}')" style="margin-left:auto">Delete Asset</button>
        </div>`:''}
      </section>

      <!-- ── Meter card ── -->
      <section class="card">
        <h2 style="margin-top:0">Meter</h2>
        <div style="display:flex;align-items:baseline;gap:8px;margin-bottom:10px">
          <span style="font-size:32px;font-weight:800">${a.current_meter!=null?fmtNum(a.current_meter):'—'}</span>
          <span style="font-size:13px;color:var(--gw-muted)">${meterUnit}</span>
        </div>
        ${a.meter_updated_at?`<div style="font-size:11px;color:var(--gw-muted);margin-bottom:10px">Updated ${fmtDate(a.meter_updated_at)}</div>`:''}
        <label class="ah-field"><span>Meter Type</span><select id="ah-f-metertype" ${fieldRO}><option value="hours"${a.meter_type!=='miles'?' selected':''}>Hours</option><option value="miles"${a.meter_type==='miles'?' selected':''}>Miles</option></select></label>
        ${lg?`<div style="display:flex;gap:8px;margin-top:10px">
          <input id="ah-f-meter" type="number" placeholder="New reading" style="flex:1;padding:8px 10px;border:1px solid var(--gw-line);border-radius:8px;background:var(--gw-surface-2);color:var(--gds-ink);font-size:13px">
          <button class="secondary-btn" onclick="window._ahUpdateMeter('${id}')" style="font-size:13px">Update</button>
        </div>`:''}
        <div style="margin-top:16px;padding-top:14px;border-top:1px solid var(--gw-line)">
          <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--gw-muted);margin-bottom:8px">Quick Stats</div>
          <div style="font-size:13px;line-height:2">
            <div>Service plans: <strong>${plans.length}</strong></div>
            <div>Services logged: <strong>${history.length}</strong></div>
            <div>Overdue: <strong style="color:${assetDueSummary(a).overdue?'#A05050':'inherit'}">${assetDueSummary(a).overdue}</strong></div>
          </div>
        </div>
      </section>
    </div>

    <!-- ── Service Plan ── -->
    <section class="card" style="margin-top:16px">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:10px">
        <h2 style="margin:0">Service Plan</h2>
        ${w?`<button class="secondary-btn" onclick="window._ahEditPlanModal('${id}','')" style="font-size:13px">+ Add Service Item</button>`:''}
      </div>
      ${plans.length?`<div class="ah-table-wrap"><table class="ah-table">
        <thead><tr>
          <th class="ah-th">Service</th><th class="ah-th">Material / Spec</th><th class="ah-th" style="text-align:center">Interval</th>
          <th class="ah-th">Last</th><th class="ah-th">Next</th><th class="ah-th">Status</th><th class="ah-th"></th>
        </tr></thead><tbody>${planRows}</tbody></table></div>`
      : `<p style="color:var(--gw-muted);font-size:13px;font-style:italic">No service plan yet.${w?' Add oil, air filter, fuel filter, brakes… intervals to start tracking.':''}</p>`}
    </section>

    <!-- ── Service History ── -->
    <section class="card" style="margin-top:16px">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:10px">
        <h2 style="margin:0">Service History</h2>
        ${lg?`<button class="secondary-btn" onclick="window._ahLogSvcModal('${id}','')" style="font-size:13px">+ Log Service</button>`:''}
      </div>
      ${history.length?`<div class="ah-table-wrap"><table class="ah-table">
        <thead><tr><th class="ah-th">Date</th><th class="ah-th">Service</th><th class="ah-th" style="text-align:right">Meter</th><th class="ah-th">By</th><th class="ah-th" style="text-align:right">Cost</th><th class="ah-th">Notes</th></tr></thead>
        <tbody>${histRows}</tbody></table></div>`
      : `<p style="color:var(--gw-muted);font-size:13px;font-style:italic">No services logged yet.</p>`}
    </section>
    <div id="ah-modal-root"></div>
  </div>`;
  if (isNew) { const el = document.getElementById('ah-f-name'); if (el) { el.focus(); el.select(); } }
}
window.ahAssetDetail = ahAssetDetail;

// ── Asset save / delete / meter ──────────────────────────────────────────────
window._ahSaveAsset = async function(id) {
  const g = f => { const el = document.getElementById('ah-f-'+f); return el ? el.value : ''; };
  try {
    await api('/api/assets', { method:'POST', body: JSON.stringify({
      id, assetTag:g('tag'), name:g('name'), category:g('cat'),
      year:g('year')||null, make:g('make'), model:g('model'), vin:g('vin'),
      engineNotes:g('engine'), meterType:g('metertype'),
      currentMeter: assetById(id)?.current_meter,
      status:g('status'), assignedTo:g('assigned'), location:g('loc'), notes:g('notes'),
    })});
    await loadAll(true);
    toast('Asset saved');
    ahAssetDetail(id);
  } catch(e){ toast('Save failed: '+e.message, 'error'); }
};
window._ahDeleteAsset = async function(id) {
  if (!confirm('Delete this asset? Its service history is kept but hidden.')) return;
  try {
    await api('/api/assets/'+id, { method:'DELETE' });
    await loadAll(true);
    toast('Asset deleted');
    assetsHub('equipment');
  } catch(e){ toast('Delete failed: '+e.message, 'error'); }
};
window._ahUpdateMeter = async function(id) {
  const el = document.getElementById('ah-f-meter');
  const v = el ? Number(el.value) : NaN;
  if (!isFinite(v)) { toast('Enter a meter reading', 'error'); return; }
  try {
    await api(`/api/assets/${id}/meter`, { method:'PUT', body: JSON.stringify({ currentMeter: v }) });
    await loadAll(true);
    toast('Meter updated');
    ahAssetDetail(id);
  } catch(e){ toast('Update failed: '+e.message, 'error'); }
};

// ── Service plan modal ───────────────────────────────────────────────────────
window._ahEditPlanModal = function(assetId, planId) {
  const p = AH.plans.find(x => x.id === planId) || {};
  const root = document.getElementById('ah-modal-root');
  if (!root) return;
  root.innerHTML = `
  <div class="ah-modal-bg" onclick="if(event.target===this)this.remove()">
    <div class="ah-modal">
      <h3 style="margin:0 0 14px">${planId?'Edit':'Add'} Service Item</h3>
      <div style="display:grid;gap:10px">
        <label class="ah-field"><span>Service Type</span>
          <select id="ahp-type">${SERVICE_TYPES.map(t=>`<option value="${t[0]}"${p.service_type===t[0]?' selected':''}>${t[1]}</option>`).join('')}</select></label>
        <label class="ah-field"><span>Label (optional — overrides type name)</span><input id="ahp-label" value="${esc(p.label||'')}" placeholder="e.g. Hydraulic Filter"></label>
        <label class="ah-field"><span>Material / Spec</span><textarea id="ahp-spec" rows="2" placeholder="e.g. SAE 5W-30 + ACDelco PF46E, 6 qt">${esc(p.material_spec||'')}</textarea></label>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
          <label class="ah-field"><span>Interval (mi/hr)</span><input id="ahp-im" type="number" value="${p.interval_meter??''}" placeholder="5000"></label>
          <label class="ah-field"><span>Interval (months)</span><input id="ahp-imo" type="number" value="${p.interval_months??''}" placeholder="6"></label>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
          <label class="ah-field"><span>Last Done (date)</span><input id="ahp-ld" type="date" value="${p.last_date||''}"></label>
          <label class="ah-field"><span>Last Done (meter)</span><input id="ahp-lm" type="number" value="${p.last_meter??''}"></label>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
          <label class="ah-field"><span>Next Due (date)</span><input id="ahp-nd" type="date" value="${p.next_date||''}"></label>
          <label class="ah-field"><span>Next Due (meter)</span><input id="ahp-nm" type="number" value="${p.next_meter??''}"></label>
        </div>
      </div>
      <div style="display:flex;gap:8px;margin-top:16px;justify-content:flex-end">
        <button class="secondary-btn" onclick="this.closest('.ah-modal-bg').remove()">Cancel</button>
        <button class="primary-btn" onclick="window._ahSavePlan('${assetId}','${planId||''}')">Save</button>
      </div>
    </div>
  </div>`;
};
window._ahSavePlan = async function(assetId, planId) {
  const g = f => { const el = document.getElementById('ahp-'+f); return el ? el.value : ''; };
  const num = v => v === '' || v == null ? null : Number(v);
  const existing = plansFor(assetId).filter(p => p.id !== planId);
  const newPlan = {
    id: planId || undefined,
    serviceType: g('type'), label: g('label'), materialSpec: g('spec'),
    intervalMeter: num(g('im')), intervalMonths: num(g('imo')),
    lastDate: g('ld')||null, lastMeter: num(g('lm')),
    nextDate: g('nd')||null, nextMeter: num(g('nm')),
  };
  // Auto-compute next from last + interval when next left blank
  if (!newPlan.nextDate && newPlan.lastDate && newPlan.intervalMonths) {
    const d = new Date(newPlan.lastDate+'T12:00:00'); d.setMonth(d.getMonth()+Math.round(newPlan.intervalMonths));
    newPlan.nextDate = d.toISOString().slice(0,10);
  }
  if (newPlan.nextMeter == null && newPlan.lastMeter != null && newPlan.intervalMeter) {
    newPlan.nextMeter = newPlan.lastMeter + newPlan.intervalMeter;
  }
  const all = existing.map(p => ({
    id: p.id, serviceType: p.service_type, label: p.label, materialSpec: p.material_spec,
    intervalMeter: p.interval_meter, intervalMonths: p.interval_months,
    lastDate: p.last_date, lastMeter: p.last_meter, nextDate: p.next_date, nextMeter: p.next_meter,
  })).concat([newPlan]);
  try {
    await api(`/api/assets/${assetId}/plans`, { method:'PUT', body: JSON.stringify({ plans: all }) });
    await loadAll(true);
    toast('Service plan saved');
    ahAssetDetail(assetId);
  } catch(e){ toast('Save failed: '+e.message, 'error'); }
};
window._ahDeletePlan = async function(assetId, planId) {
  if (!confirm('Remove this service item from the plan?')) return;
  const rest = plansFor(assetId).filter(p => p.id !== planId).map(p => ({
    id: p.id, serviceType: p.service_type, label: p.label, materialSpec: p.material_spec,
    intervalMeter: p.interval_meter, intervalMonths: p.interval_months,
    lastDate: p.last_date, lastMeter: p.last_meter, nextDate: p.next_date, nextMeter: p.next_meter,
  }));
  try {
    await api(`/api/assets/${assetId}/plans`, { method:'PUT', body: JSON.stringify({ plans: rest }) });
    await loadAll(true);
    ahAssetDetail(assetId);
  } catch(e){ toast('Delete failed: '+e.message, 'error'); }
};

// ── Log service modal ────────────────────────────────────────────────────────
window._ahLogSvcModal = function(assetId, planId) {
  const a = assetById(assetId);
  const plans = plansFor(assetId);
  const p = plans.find(x => x.id === planId);
  const rep = _rep();
  const root = document.getElementById('ah-modal-root') || (function(){
    const d = document.createElement('div'); d.id = 'ah-modal-root'; document.getElementById('view').appendChild(d); return d;
  })();
  root.innerHTML = `
  <div class="ah-modal-bg" onclick="if(event.target===this)this.remove()">
    <div class="ah-modal">
      <h3 style="margin:0 0 4px">Log Service</h3>
      <div style="font-size:12px;color:var(--gw-muted);margin-bottom:14px">${esc(a?a.name:'')}</div>
      <div style="display:grid;gap:10px">
        <label class="ah-field"><span>Service</span>
          <select id="ahl-plan">
            ${plans.map(x=>`<option value="${x.id}"${x.id===planId?' selected':''}>${esc(x.label||svcLabel(x.service_type))}</option>`).join('')}
            <option value=""${!p?' selected':''}>Other / one-off</option>
          </select></label>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
          <label class="ah-field"><span>Date</span><input id="ahl-date" type="date" value="${todayStr()}"></label>
          <label class="ah-field"><span>Meter (${a&&a.meter_type==='miles'?'mi':'hrs'})</span><input id="ahl-meter" type="number" value="${a&&a.current_meter!=null?a.current_meter:''}"></label>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
          <label class="ah-field"><span>Performed By</span><input id="ahl-by" value="${esc(rep?rep.name:'')}"></label>
          <label class="ah-field"><span>Cost ($, optional)</span><input id="ahl-cost" type="number" step="0.01" placeholder="0.00"></label>
        </div>
        <label class="ah-field"><span>Notes</span><textarea id="ahl-notes" rows="2" placeholder="Parts used, condition observed…"></textarea></label>
      </div>
      <div style="display:flex;gap:8px;margin-top:16px;justify-content:flex-end">
        <button class="secondary-btn" onclick="this.closest('.ah-modal-bg').remove()">Cancel</button>
        <button class="primary-btn" onclick="window._ahSubmitLog('${assetId}')">Save Log Entry</button>
      </div>
    </div>
  </div>`;
};
window._ahSubmitLog = async function(assetId) {
  const g = f => { const el = document.getElementById('ahl-'+f); return el ? el.value : ''; };
  const planId = g('plan');
  const plan = AH.plans.find(x => x.id === planId);
  try {
    await api(`/api/assets/${assetId}/log`, { method:'POST', body: JSON.stringify({
      planId: planId || null,
      serviceType: plan ? plan.service_type : 'custom',
      performedDate: g('date') || todayStr(),
      performedMeter: g('meter') !== '' ? Number(g('meter')) : null,
      performedBy: g('by'), cost: g('cost') !== '' ? Number(g('cost')) : null, notes: g('notes'),
    })});
    await loadAll(true);
    toast('Service logged');
    ahAssetDetail(assetId);
  } catch(e){ toast('Log failed: '+e.message, 'error'); }
};

// ═════════════════════════════════════════════════════════════════════════════
// TAB 2 — MAINTENANCE (due queue computed from service plans)
// ═════════════════════════════════════════════════════════════════════════════
function renderMaintenance(view) {
  const items = [];
  AH.assets.forEach(a => {
    plansFor(a.id).forEach(p => {
      const st = planStatus(p, a);
      items.push({ asset: a, plan: p, status: st });
    });
  });
  const overdue = items.filter(i => i.status === 'overdue');
  const dueSoon = items.filter(i => i.status === 'due-soon');
  const upcoming = items.filter(i => i.status === 'ok' && (i.plan.next_date || i.plan.next_meter != null))
    .sort((x,y) => (x.plan.next_date||'9999').localeCompare(y.plan.next_date||'9999')).slice(0, 20);
  const recentLog = AH.log.slice(0, 15);
  const lg = canLog();

  function rowHtml(i) {
    const a = i.asset, p = i.plan;
    const meterUnit = a.meter_type === 'miles' ? 'mi' : 'hrs';
    return `<tr class="ah-row" onclick="window.ahAssetDetail('${a.id}')">
      <td class="ah-td" style="font-weight:600">${a.asset_tag?`<span class="ah-tag">${esc(a.asset_tag)}</span> `:''}${esc(a.name)}</td>
      <td class="ah-td">${esc(p.label||svcLabel(p.service_type))}</td>
      <td class="ah-td" style="font-size:12px">${fmtDate(p.next_date)}${p.next_meter!=null?`<div style="font-size:10px;color:var(--gw-muted)">@ ${fmtNum(p.next_meter)} ${meterUnit} (now ${a.current_meter!=null?fmtNum(a.current_meter):'?'})</div>`:''}</td>
      <td class="ah-td" style="font-size:11px;max-width:280px">${esc(p.material_spec||'')}</td>
      <td class="ah-td">${statusBadge(i.status)}</td>
      <td class="ah-td">${lg?`<button class="ah-btn-sm ah-btn-sm--primary" onclick="event.stopPropagation();window._ahLogSvcModal('${a.id}','${p.id}')">Log Service</button>`:''}</td>
    </tr>`;
  }
  function section(title, arr, color) {
    if (!arr.length) return '';
    return `<div style="margin-bottom:22px">
      <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:${color};margin-bottom:8px">${title} (${arr.length})</div>
      <div class="ah-table-wrap"><table class="ah-table">
        <thead><tr><th class="ah-th">Asset</th><th class="ah-th">Service</th><th class="ah-th">Due</th><th class="ah-th">Material / Spec</th><th class="ah-th">Status</th><th class="ah-th"></th></tr></thead>
        <tbody>${arr.map(rowHtml).join('')}</tbody></table></div>
    </div>`;
  }

  const logRows = recentLog.map(h => {
    const a = assetById(h.asset_id);
    return `<tr class="ah-row" onclick="window.ahAssetDetail('${h.asset_id}')">
      <td class="ah-td" style="font-size:12px">${fmtDate(h.performed_date)}</td>
      <td class="ah-td" style="font-weight:600;font-size:12px">${esc(a?a.name:h.asset_id)}</td>
      <td class="ah-td" style="font-size:12px">${esc(h.service_type?svcLabel(h.service_type):'Service')}</td>
      <td class="ah-td" style="font-size:12px">${esc(h.performed_by||'—')}</td>
      <td class="ah-td" style="font-size:11px;color:var(--gw-muted)">${esc(h.notes||'')}</td>
    </tr>`;
  }).join('');

  view.insertAdjacentHTML('beforeend', `
  <div class="ah-shell">
    <header class="ah-header">
      <div>
        <h1 style="margin:0 0 4px">Maintenance</h1>
        <p style="margin:0;font-size:13px;color:var(--gw-muted)">
          ${overdue.length?`<strong style="color:#A05050">${overdue.length} overdue</strong> · `:''}
          ${dueSoon.length?`<strong style="color:#8B6914">${dueSoon.length} due soon</strong> · `:''}
          ${items.length} tracked services across ${AH.assets.length} assets
        </p>
      </div>
    </header>
    ${!items.length ? `<div style="padding:48px 24px;text-align:center;color:var(--gw-muted)">
        No service plans yet. Open an asset in <a href="javascript:void(0)" onclick="window.assetsHub('equipment')" style="color:#4D8A86">Equipment</a> and add its service plan to start tracking maintenance.
      </div>` : `
    ${section('Overdue', overdue, '#A05050')}
    ${section('Due Soon (30 days / near meter)', dueSoon, '#8B6914')}
    ${section('Upcoming', upcoming, 'var(--gw-muted)')}`}
    ${recentLog.length?`<div style="margin-bottom:22px">
      <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:#2D7A55;margin-bottom:8px">Recently Completed</div>
      <div class="ah-table-wrap"><table class="ah-table">
        <thead><tr><th class="ah-th">Date</th><th class="ah-th">Asset</th><th class="ah-th">Service</th><th class="ah-th">By</th><th class="ah-th">Notes</th></tr></thead>
        <tbody>${logRows}</tbody></table></div>
    </div>`:''}
    <div id="ah-modal-root"></div>
  </div>`);
}

// ═════════════════════════════════════════════════════════════════════════════
// TAB 3 — INVENTORY & TOOLS (unified stock)
// ═════════════════════════════════════════════════════════════════════════════
function renderInventory(view) {
  const q = (window._ahStockSearch||'').toLowerCase();
  const typeF = window._ahStockType || '';
  let items = AH.stock.slice();
  if (q)     items = items.filter(i => [i.name,i.vendor,i.location].join(' ').toLowerCase().includes(q));
  if (typeF) items = items.filter(i => i.item_type === typeF);

  const low = AH.stock.filter(i => Number(i.on_hand||0) <= Number(i.reorder_at||0) && Number(i.reorder_at||0) > 0);
  const out = AH.stock.filter(i => Number(i.on_hand||0) === 0 && Number(i.reorder_at||0) > 0);

  // low stock first
  items.sort((a,b) => {
    const la = (Number(a.on_hand||0) <= Number(a.reorder_at||0) && Number(a.reorder_at||0) > 0) ? 1 : 0;
    const lb = (Number(b.on_hand||0) <= Number(b.reorder_at||0) && Number(b.reorder_at||0) > 0) ? 1 : 0;
    if (lb - la) return lb - la;
    return (a.item_type||'').localeCompare(b.item_type||'') || (a.name||'').localeCompare(b.name||'');
  });

  const typeCounts = {};
  AH.stock.forEach(i => { typeCounts[i.item_type] = (typeCounts[i.item_type]||0)+1; });
  const chips = [''].concat(STOCK_TYPES.map(t=>t[0]).filter(t=>typeCounts[t]))
    .map(t => `<button class="ah-chip${typeF===t?' ah-chip--on':''}" onclick="window._ahSetStockType('${t}')">${t?stockTypeLabel(t):'All'}${t?` <span style="opacity:.6">${typeCounts[t]}</span>`:''}</button>`).join('');

  const w = canWrite(), lg = canLog();
  const isMobile = window.innerWidth <= 768;

  const rows = items.map(i => {
    const isLow = Number(i.on_hand||0) <= Number(i.reorder_at||0) && Number(i.reorder_at||0) > 0;
    const isOut = Number(i.on_hand||0) === 0;
    const badge = isOut && Number(i.reorder_at||0) > 0
      ? `<span style="font-size:10px;font-weight:800;color:#A05050;background:#A0505018;border:1px solid #A0505040;border-radius:10px;padding:2px 8px">OUT</span>`
      : isLow ? `<span style="font-size:10px;font-weight:800;color:#8B6914;background:#8B691418;border:1px solid #8B691440;border-radius:10px;padding:2px 8px">LOW</span>`
      : `<span style="font-size:10px;font-weight:800;color:#2D7A55;background:#2D7A5518;border:1px solid #2D7A5540;border-radius:10px;padding:2px 8px">OK</span>`;
    if (isMobile) {
      return `<div class="ah-mcard">
        <div class="ah-mcard-top"><span class="ah-mcard-name">${esc(i.name)}</span>${badge}</div>
        <div class="ah-mcard-sub">${stockTypeLabel(i.item_type)}${i.location?` · ${esc(i.location)}`:''}${i.vendor?` · ${esc(i.vendor)}`:''}</div>
        <div class="ah-mcard-bottom">
          ${lg?`<span style="display:inline-flex;align-items:center;gap:6px">
            <button class="ah-qty-btn" onclick="window._ahQtyAdj('${i.id}',-1)">−</button>
            <strong style="min-width:32px;text-align:center">${fmtNum(i.on_hand)}</strong>
            <button class="ah-qty-btn" onclick="window._ahQtyAdj('${i.id}',1)">+</button>
            <span style="font-size:10px;color:var(--gw-muted)">${esc(i.unit||'ea')}</span>
          </span>`:`<strong>${fmtNum(i.on_hand)} ${esc(i.unit||'ea')}</strong>`}
          ${Number(i.reorder_at||0)>0?`<span style="font-size:11px;color:var(--gw-muted)">reorder @ ${fmtNum(i.reorder_at)}</span>`:''}
          ${w?`<button class="ah-btn-sm" onclick="window._ahStockModal('${i.id}')">Edit</button>`:''}
        </div>
      </div>`;
    }
    return `<tr class="ah-row${isLow?' ah-row--low':''}">
      <td class="ah-td" style="font-weight:600">${esc(i.name)}${i.location?`<div style="font-size:11px;color:var(--gw-muted)">${esc(i.location)}</div>`:''}</td>
      <td class="ah-td">${stockTypeLabel(i.item_type)}</td>
      <td class="ah-td" style="text-align:center">
        ${lg?`<span style="display:inline-flex;align-items:center;gap:6px">
          <button class="ah-qty-btn" onclick="window._ahQtyAdj('${i.id}',-1)">−</button>
          <strong style="min-width:36px;display:inline-block">${fmtNum(i.on_hand)}</strong>
          <button class="ah-qty-btn" onclick="window._ahQtyAdj('${i.id}',1)">+</button>
        </span> <span style="font-size:10px;color:var(--gw-muted)">${esc(i.unit||'ea')}</span>`
        :`<strong>${fmtNum(i.on_hand)}</strong> <span style="font-size:10px;color:var(--gw-muted)">${esc(i.unit||'ea')}</span>`}
      </td>
      <td class="ah-td" style="text-align:center;font-size:12px;color:var(--gw-muted)">${Number(i.reorder_at||0)>0?fmtNum(i.reorder_at):'—'}</td>
      <td class="ah-td">${badge}</td>
      <td class="ah-td" style="font-size:12px">${esc(i.vendor||'—')}</td>
      <td class="ah-td" style="white-space:nowrap">
        ${w?`<button class="ah-btn-sm" onclick="window._ahStockModal('${i.id}')">Edit</button>
        <button class="ah-btn-sm ah-btn-sm--danger" onclick="window._ahDeleteStock('${i.id}')">✕</button>`:''}
      </td>
    </tr>`;
  }).join('');

  view.insertAdjacentHTML('beforeend', `
  <div class="ah-shell">
    <header class="ah-header">
      <div>
        <h1 style="margin:0 0 4px">Inventory & Tools</h1>
        <p style="margin:0;font-size:13px;color:var(--gw-muted)">
          ${AH.stock.length} items
          ${out.length?` · <strong style="color:#A05050">${out.length} out of stock</strong>`:''}
          ${low.length?` · <strong style="color:#8B6914">${low.length} low</strong>`:''}
        </p>
      </div>
      <div class="ah-header-actions">
        ${w?`<button class="secondary-btn" onclick="window._ahImportExport('stock')" style="font-size:13px">⇅ Import / Export</button>
        <button class="primary-btn" onclick="window._ahStockModal('')" style="font-size:13px">+ Add Item</button>`:''}
      </div>
    </header>
    <div class="ah-toolbar">
      <input type="search" class="ah-search" placeholder="Search items, vendor, location…" value="${esc(window._ahStockSearch||'')}"
        oninput="window._ahStockSearch=this.value;window.assetsHub('inventory')">
      <div class="ah-chips">${chips}</div>
    </div>
    ${!AH.stock.length ? `<div style="padding:48px 24px;text-align:center">
        <p style="color:var(--gw-muted);margin-bottom:14px">No inventory or tools tracked yet.</p>
        ${w?`<div style="display:flex;gap:8px;justify-content:center;flex-wrap:wrap">
          <button class="primary-btn" onclick="window._ahStockModal('')">+ Add Item</button>
          <button class="secondary-btn" onclick="window._ahImportExport('stock')">⇪ Import from Spreadsheet</button>
        </div>`:''}
      </div>`
    : (isMobile
      ? `<div class="ah-mlist">${rows || '<div style="padding:30px;text-align:center;color:var(--gw-muted)">No matches.</div>'}</div>`
      : `<div class="ah-table-wrap"><table class="ah-table">
          <thead><tr>
            <th class="ah-th">Item</th><th class="ah-th">Type</th><th class="ah-th" style="text-align:center">On Hand</th>
            <th class="ah-th" style="text-align:center">Reorder At</th><th class="ah-th">Stock</th><th class="ah-th">Vendor</th><th class="ah-th"></th>
          </tr></thead>
          <tbody>${rows || '<tr><td colspan="7" style="padding:30px;text-align:center;color:var(--gw-muted)">No matches.</td></tr>'}</tbody>
        </table></div>`)}
    <div id="ah-modal-root"></div>
  </div>`);
}
window._ahSetStockType = function(t){ window._ahStockType = t; assetsHub('inventory'); };

window._ahQtyAdj = async function(id, delta) {
  const item = AH.stock.find(i => i.id === id);
  if (!item) return;
  const newQty = Math.max(0, Number(item.on_hand||0) + delta);
  item.on_hand = newQty; // optimistic
  try {
    await api(`/api/stock/${id}/qty`, { method:'PUT', body: JSON.stringify({ onHand: newQty }) });
    assetsHub('inventory');
  } catch(e){ toast('Update failed: '+e.message, 'error'); await loadAll(true); assetsHub('inventory'); }
};

window._ahStockModal = function(id) {
  const i = AH.stock.find(x => x.id === id) || {};
  const root = document.getElementById('ah-modal-root');
  if (!root) return;
  root.innerHTML = `
  <div class="ah-modal-bg" onclick="if(event.target===this)this.remove()">
    <div class="ah-modal">
      <h3 style="margin:0 0 14px">${id?'Edit':'Add'} Item</h3>
      <div style="display:grid;gap:10px">
        <label class="ah-field"><span>Name *</span><input id="ahs-name" value="${esc(i.name||'')}" placeholder="e.g. Trimmer Line .095, Chainsaw Bar Oil"></label>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
          <label class="ah-field"><span>Type</span><select id="ahs-type">${STOCK_TYPES.map(t=>`<option value="${t[0]}"${i.item_type===t[0]?' selected':''}>${t[1]}</option>`).join('')}</select></label>
          <label class="ah-field"><span>Unit</span><input id="ahs-unit" value="${esc(i.unit||'ea')}" placeholder="ea / gal / box"></label>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
          <label class="ah-field"><span>On Hand</span><input id="ahs-qty" type="number" min="0" value="${i.on_hand??0}"></label>
          <label class="ah-field"><span>Reorder At (0 = no alert)</span><input id="ahs-reorder" type="number" min="0" value="${i.reorder_at??0}"></label>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
          <label class="ah-field"><span>Vendor</span><input id="ahs-vendor" value="${esc(i.vendor||'')}"></label>
          <label class="ah-field"><span>Unit Cost ($)</span><input id="ahs-cost" type="number" step="0.01" value="${i.unit_cost??''}"></label>
        </div>
        <label class="ah-field"><span>Location</span><input id="ahs-loc" value="${esc(i.location||'')}" placeholder="Shop shelf, Truck #01…"></label>
        <label class="ah-field"><span>Notes</span><textarea id="ahs-notes" rows="2">${esc(i.notes||'')}</textarea></label>
      </div>
      <div style="display:flex;gap:8px;margin-top:16px;justify-content:flex-end">
        <button class="secondary-btn" onclick="this.closest('.ah-modal-bg').remove()">Cancel</button>
        <button class="primary-btn" onclick="window._ahSaveStock('${id||''}')">Save</button>
      </div>
    </div>
  </div>`;
};
window._ahSaveStock = async function(id) {
  const g = f => { const el = document.getElementById('ahs-'+f); return el ? el.value : ''; };
  if (!g('name').trim()) { toast('Item name required', 'error'); return; }
  try {
    await api('/api/stock', { method:'POST', body: JSON.stringify({
      id: id || undefined, name: g('name'), itemType: g('type'), unit: g('unit')||'ea',
      onHand: Number(g('qty'))||0, reorderAt: Number(g('reorder'))||0,
      vendor: g('vendor'), location: g('loc'),
      unitCost: g('cost') !== '' ? Number(g('cost')) : null, notes: g('notes'),
    })});
    await loadAll(true);
    toast('Item saved');
    assetsHub('inventory');
  } catch(e){ toast('Save failed: '+e.message, 'error'); }
};
window._ahDeleteStock = async function(id) {
  if (!confirm('Remove this item?')) return;
  try {
    await api('/api/stock/'+id, { method:'DELETE' });
    await loadAll(true);
    assetsHub('inventory');
  } catch(e){ toast('Delete failed: '+e.message, 'error'); }
};

/* ── IMPORT / EXPORT ────────────────────────────────────────────────────── */
let _xlsxLoading = null;
function loadSheetJS() {
  if (window.XLSX) return Promise.resolve();
  if (_xlsxLoading) return _xlsxLoading;
  _xlsxLoading = new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js';
    s.onload = () => res();
    s.onerror = () => { _xlsxLoading = null; rej(new Error('Could not load spreadsheet library')); };
    document.head.appendChild(s);
  });
  return _xlsxLoading;
}

// Normalize a header cell for tolerant matching: lowercase, strip non-alphanumerics
function _hk(s){ return String(s==null?'':s).toLowerCase().replace(/[^a-z0-9]/g,''); }

// Map of normalized header → asset field
const ASSET_COL_MAP = {
  assetid: 'assetTag', asset: 'assetTag', id: 'assetTag', tag: 'assetTag', assettag: 'assetTag',
  assetname: 'name', name: 'name', equipmentname: 'name',
  category: 'category', type: 'category',
  year: 'year', make: 'make', model: 'model',
  vinskuserial: 'vin', vin: 'vin', serial: 'vin', serialnumber: 'vin', sku: 'vin', vinserial: 'vin',
  enginenotes: 'engineNotes', engine: 'engineNotes',
  metertype: 'meterType', meterunit: 'meterType',
  currentmeter: 'currentMeter', meter: 'currentMeter', currenthours: 'currentMeter', currentmiles: 'currentMeter',
  notes: 'notes', note: 'notes',
  assignedto: 'assignedTo', location: 'location', status: 'status',
};

// Service-plan column blocks (matches user's spreadsheet framework):
//   "<Prefix> Material Spec", "<Prefix> Interval (mi/hr)", "<Prefix> Interval (months)",
//   "Last <X> Date", "Last <X> Meter", "Next <X> Date", "Next <X> Meter", "<X> Status"
const PLAN_BLOCKS = [
  { type:'oil',    label:'Oil & Filter', keys:['oil'] },
  { type:'air',    label:'Air Filter',   keys:['air','airfilter'] },
  { type:'fuel',   label:'Fuel Filter',  keys:['fuel','fuelfilter'] },
  { type:'brakes', label:'Brakes',       keys:['brake','brakes'] },
  { type:'rotors', label:'Rotors',       keys:['rotor','rotors'] },
  { type:'blades', label:'Blades',       keys:['blade','blades'] },
];

function _matchPlanCol(nk) {
  // Returns {type, field} or null. nk = normalized header key.
  for (const blk of PLAN_BLOCKS) {
    for (const k of blk.keys) {
      if (nk === k + 'materialspec' || nk === k + 'material' || nk === k + 'spec') return { type: blk.type, field: 'materialSpec' };
      if (nk === k + 'intervalmihr' || nk === k + 'intervalmiles' || nk === k + 'intervalhours' || nk === k + 'intervalmeter' || nk === k + 'interval') return { type: blk.type, field: 'intervalMeter' };
      if (nk === k + 'intervalmonths' || nk === k + 'intervalmonth' || nk === k + 'intervalmo') return { type: blk.type, field: 'intervalMonths' };
      if (nk === 'last' + k + 'date' || nk === k + 'lastdate') return { type: blk.type, field: 'lastDate' };
      if (nk === 'last' + k + 'meter' || nk === k + 'lastmeter') return { type: blk.type, field: 'lastMeter' };
      if (nk === 'next' + k + 'date' || nk === k + 'nextdate') return { type: blk.type, field: 'nextDate' };
      if (nk === 'next' + k + 'meter' || nk === k + 'nextmeter') return { type: blk.type, field: 'nextMeter' };
      if (nk === k + 'status') return { type: blk.type, field: '_status' }; // computed, ignored on import
    }
  }
  return null;
}

function _normCategory(v) {
  const s = String(v||'').toLowerCase().trim();
  if (!s) return 'equipment';
  const hit = CATEGORIES.find(c => c[0] === s || c[1].toLowerCase() === s);
  if (hit) return hit[0];
  if (s.includes('truck') || s.includes('vehic')) return 'vehicle';
  if (s.includes('trail')) return 'trailer';
  if (s.includes('mow')) return 'mower';
  if (s.includes('attach')) return 'attachment';
  if (s.includes('tool')) return 'tool';
  return 'equipment';
}
function _normMeterType(v) {
  const s = String(v||'').toLowerCase();
  if (s.includes('mile') || s === 'mi' || s.includes('odo')) return 'miles';
  return 'hours';
}
// Excel serial dates or strings → YYYY-MM-DD
function _normDate(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number' && v > 20000 && v < 80000) {
    const d = new Date(Math.round((v - 25569) * 86400 * 1000));
    if (!isNaN(d)) return d.toISOString().slice(0,10);
  }
  const d = new Date(v);
  if (!isNaN(d)) return d.toISOString().slice(0,10);
  return null;
}
function _normNum(v) {
  if (v == null || v === '') return null;
  const n = Number(String(v).replace(/[^0-9.\-]/g,''));
  return isNaN(n) ? null : n;
}

// Parse an array-of-arrays sheet (row 0 = headers) into asset import payloads
function parseAssetSheet(rows) {
  if (!rows || rows.length < 2) return [];
  const headers = rows[0].map(_hk);
  const out = [];
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    if (!row || !row.some(c => c != null && String(c).trim() !== '')) continue;
    const a = { plans: {} };
    for (let ci = 0; ci < headers.length; ci++) {
      const nk = headers[ci]; if (!nk) continue;
      const val = row[ci];
      const pf = _matchPlanCol(nk);
      if (pf) {
        if (pf.field === '_status') continue;
        if (!a.plans[pf.type]) a.plans[pf.type] = { serviceType: pf.type };
        a.plans[pf.type][pf.field] = val;
        continue;
      }
      const af = ASSET_COL_MAP[nk];
      if (af && a[af] === undefined) a[af] = val;
    }
    const name = String(a.name || '').trim();
    if (!name) continue;
    const plans = Object.values(a.plans)
      .map(p => ({
        serviceType: p.serviceType,
        label: (PLAN_BLOCKS.find(b=>b.type===p.serviceType)||{}).label || p.serviceType,
        materialSpec: p.materialSpec != null ? String(p.materialSpec) : '',
        intervalMeter: _normNum(p.intervalMeter),
        intervalMonths: _normNum(p.intervalMonths),
        lastDate: _normDate(p.lastDate),
        lastMeter: _normNum(p.lastMeter),
        nextDate: _normDate(p.nextDate),
        nextMeter: _normNum(p.nextMeter),
      }))
      // keep plans that have at least one meaningful value
      .filter(p => p.materialSpec || p.intervalMeter != null || p.intervalMonths != null ||
                   p.lastDate || p.lastMeter != null || p.nextDate || p.nextMeter != null);
    out.push({
      name,
      assetTag: a.assetTag != null ? String(a.assetTag).trim() : '',
      category: _normCategory(a.category),
      year: _normNum(a.year),
      make: a.make != null ? String(a.make) : '',
      model: a.model != null ? String(a.model) : '',
      vin: a.vin != null ? String(a.vin) : '',
      engineNotes: a.engineNotes != null ? String(a.engineNotes) : '',
      meterType: _normMeterType(a.meterType),
      currentMeter: _normNum(a.currentMeter),
      status: 'active',
      assignedTo: a.assignedTo != null ? String(a.assignedTo) : '',
      location: a.location != null ? String(a.location) : '',
      notes: a.notes != null ? String(a.notes) : '',
      plans,
    });
  }
  return out;
}

const STOCK_COL_MAP = {
  name: 'name', item: 'name', itemname: 'name', material: 'name', description: 'name',
  type: 'itemType', itemtype: 'itemType', category: 'itemType',
  onhand: 'onHand', qty: 'onHand', quantity: 'onHand', stock: 'onHand', count: 'onHand',
  unit: 'unit', uom: 'unit', units: 'unit',
  reorderat: 'reorderAt', reorder: 'reorderAt', reorderpoint: 'reorderAt', min: 'reorderAt', minqty: 'reorderAt', lowstock: 'reorderAt',
  vendor: 'vendor', supplier: 'vendor',
  location: 'location', storage: 'location',
  unitcost: 'unitCost', cost: 'unitCost', price: 'unitCost',
  notes: 'notes', note: 'notes',
};
function _normStockType(v) {
  const s = String(v||'').toLowerCase().trim();
  if (!s) return 'material';
  const hit = STOCK_TYPES.find(t => t[0] === s || t[1].toLowerCase() === s);
  return hit ? hit[0] : 'material';
}
function parseStockSheet(rows) {
  if (!rows || rows.length < 2) return [];
  const headers = rows[0].map(_hk);
  const out = [];
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    if (!row || !row.some(c => c != null && String(c).trim() !== '')) continue;
    const it = {};
    for (let ci = 0; ci < headers.length; ci++) {
      const f = STOCK_COL_MAP[headers[ci]];
      if (f && it[f] === undefined) it[f] = row[ci];
    }
    const name = String(it.name || '').trim();
    if (!name) continue;
    out.push({
      name,
      itemType: _normStockType(it.itemType),
      onHand: _normNum(it.onHand) || 0,
      unit: it.unit != null && String(it.unit).trim() ? String(it.unit).trim() : 'ea',
      reorderAt: _normNum(it.reorderAt) || 0,
      vendor: it.vendor != null ? String(it.vendor) : '',
      location: it.location != null ? String(it.location) : '',
      unitCost: _normNum(it.unitCost),
      notes: it.notes != null ? String(it.notes) : '',
    });
  }
  return out;
}

/* Export builders */
function buildAssetExportRows() {
  const svc = ['oil','air','fuel','brakes','rotors','blades'];
  const svcLabel = { oil:'Oil', air:'Air', fuel:'Fuel', brakes:'Brake', rotors:'Rotor', blades:'Blade' };
  const headers = ['Asset ID','Asset Name','Category','Year','Make','Model','VIN / SKU / Serial','Engine / Notes','Meter Type','Current Meter'];
  for (const s of svc) {
    const L = svcLabel[s];
    headers.push(
      L+' Material Spec', L+' Interval (mi/hr)', L+' Interval (months)',
      'Last '+L+' Date', 'Last '+L+' Meter', 'Next '+L+' Date', 'Next '+L+' Meter', L+' Status'
    );
  }
  headers.push('Assigned To','Location','Status','NOTES');
  const rows = [headers];
  for (const a of AH.assets) {
    const plans = plansFor(a.id);
    const row = [
      a.asset_tag || '', a.name || '', catLabel(a.category), a.year || '', a.make || '', a.model || '',
      a.vin || '', a.engine_notes || '', a.meter_type === 'miles' ? 'Miles' : 'Hours',
      a.current_meter != null ? a.current_meter : '',
    ];
    for (const s of svc) {
      const p = plans.find(x => x.service_type === s);
      if (!p) { row.push('','','','','','','',''); continue; }
      const st = planStatus(p, a);
      row.push(
        p.material_spec || '', p.interval_meter != null ? p.interval_meter : '',
        p.interval_months != null ? p.interval_months : '',
        p.last_date || '', p.last_meter != null ? p.last_meter : '',
        p.next_date || '', p.next_meter != null ? p.next_meter : '',
        st === 'overdue' ? 'OVERDUE' : st === 'due-soon' ? 'DUE SOON' : st === 'ok' ? 'OK' : ''
      );
    }
    row.push(a.assigned_to || '', a.location || '', (a.status || 'active').toUpperCase(), a.notes || '');
    rows.push(row);
  }
  return rows;
}
function buildStockExportRows() {
  const rows = [['Item Name','Type','On Hand','Unit','Reorder At','Vendor','Location','Unit Cost','Notes']];
  for (const it of AH.stock) {
    rows.push([
      it.name || '', (STOCK_TYPES.find(t=>t[0]===it.item_type)||['','Other'])[1],
      it.on_hand != null ? it.on_hand : 0, it.unit || 'ea', it.reorder_at != null ? it.reorder_at : 0,
      it.vendor || '', it.location || '', it.unit_cost != null ? it.unit_cost : '', it.notes || ''
    ]);
  }
  return rows;
}
async function exportToXlsx(rows, sheetName, filename) {
  await loadSheetJS();
  const ws = window.XLSX.utils.aoa_to_sheet(rows);
  const wb = window.XLSX.utils.book_new();
  window.XLSX.utils.book_append_sheet(wb, ws, sheetName);
  window.XLSX.writeFile(wb, filename);
}
function exportToCsv(rows, filename) {
  const csv = rows.map(r => r.map(c => {
    const s = String(c == null ? '' : c);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g,'""') + '"' : s;
  }).join(',')).join('\n');
  const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = filename;
  document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
}

/* Import/Export modal */
window._ahImportExport = function(kind) {
  const isAssets = kind === 'assets';
  const title = isAssets ? 'Import / Export Equipment & Assets' : 'Import / Export Inventory & Tools';
  const count = isAssets ? AH.assets.length : AH.stock.length;
  const old = document.getElementById('ah-ie-modal'); if (old) old.remove();
  const bg = document.createElement('div');
  bg.className = 'ah-modal-bg'; bg.id = 'ah-ie-modal';
  bg.innerHTML = `
    <div class="ah-modal" style="max-width:520px">
      <h3 style="margin:0 0 4px">${title}</h3>
      <p style="margin:0 0 14px;font-size:13px;color:#6F7E6A">
        ${isAssets
          ? 'Import from your maintenance spreadsheet (.xlsx / .csv). Columns like <b>Asset ID, Asset Name, Category, Make, Model, Meter Type, Oil / Air / Fuel intervals, Brakes, Blades…</b> are detected automatically.'
          : 'Import items from a spreadsheet (.xlsx / .csv). Columns like <b>Item Name, Type, On Hand, Unit, Reorder At, Vendor, Cost…</b> are detected automatically.'}
      </p>
      <div style="border:1px dashed #C9D3C4;border-radius:10px;padding:16px;text-align:center;margin-bottom:14px">
        <input type="file" id="ah-ie-file" accept=".xlsx,.xls,.csv" style="display:none">
        <button class="primary-btn" onclick="document.getElementById('ah-ie-file').click()">⇪ Choose Spreadsheet File</button>
        <div id="ah-ie-status" style="font-size:13px;color:#6F7E6A;margin-top:8px">No file selected</div>
        <div id="ah-ie-preview" style="display:none;margin-top:10px;text-align:left"></div>
      </div>
      <div style="border-top:1px solid #E4EAE0;padding-top:12px">
        <div style="font-size:13px;font-weight:600;margin-bottom:8px">Export current data (${count} ${isAssets ? 'assets' : 'items'})</div>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <button class="secondary-btn" id="ah-ie-xlsx">⬇ Excel (.xlsx)</button>
          <button class="secondary-btn" id="ah-ie-csv">⬇ CSV</button>
        </div>
      </div>
      <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:16px">
        <button class="secondary-btn" onclick="document.getElementById('ah-ie-modal').remove()">Close</button>
      </div>
    </div>`;
  document.body.appendChild(bg);
  bg.addEventListener('click', e => { if (e.target === bg) bg.remove(); });

  let parsed = null;
  const statusEl = () => document.getElementById('ah-ie-status');
  const previewEl = () => document.getElementById('ah-ie-preview');

  document.getElementById('ah-ie-file').addEventListener('change', async function() {
    const file = this.files && this.files[0];
    if (!file) return;
    statusEl().textContent = 'Reading ' + file.name + '…';
    try {
      await loadSheetJS();
      const buf = await file.arrayBuffer();
      const wb = window.XLSX.read(buf, { type: 'array', cellDates: false });
      const ws = wb.Sheets[wb.SheetNames[0]];
      const rows = window.XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null });
      parsed = isAssets ? parseAssetSheet(rows) : parseStockSheet(rows);
      if (!parsed.length) {
        statusEl().innerHTML = '<span style="color:#B3573F">No valid rows found. Check that row 1 has column headers and a Name column exists.</span>';
        previewEl().style.display = 'none';
        return;
      }
      statusEl().innerHTML = '<b style="color:#2F5233">✓ ' + parsed.length + ' ' + (isAssets ? 'assets' : 'items') + ' ready to import</b> from ' + esc(file.name);
      const sample = parsed.slice(0, 5).map(x =>
        '<div style="font-size:12px;padding:3px 0;border-bottom:1px solid #EEF2EB">• <b>' + esc(x.name) + '</b>' +
        (isAssets
          ? (x.assetTag ? ' <span style="color:#6F7E6A">(' + esc(x.assetTag) + ')</span>' : '') + ' — ' + catLabel(x.category) + (x.plans.length ? ', ' + x.plans.length + ' service plans' : '')
          : ' — ' + esc(String(x.onHand)) + ' ' + esc(x.unit)) +
        '</div>').join('');
      previewEl().innerHTML = sample +
        (parsed.length > 5 ? '<div style="font-size:12px;color:#6F7E6A;padding:4px 0">…and ' + (parsed.length - 5) + ' more</div>' : '') +
        '<button class="primary-btn" id="ah-ie-go" style="margin-top:10px;width:100%">Import ' + parsed.length + ' ' + (isAssets ? 'Assets' : 'Items') + '</button>';
      previewEl().style.display = 'block';
      document.getElementById('ah-ie-go').addEventListener('click', async function() {
        this.disabled = true; this.textContent = 'Importing…';
        try {
          const res = isAssets
            ? await api('/api/assets/import-bulk', { method:'POST', body: JSON.stringify({ assets: parsed }) })
            : await api('/api/stock/import-bulk', { method:'POST', body: JSON.stringify({ items: parsed }) });
          await loadAll(true);
          bg.remove();
          toast('Imported ' + ((res && res.imported) != null ? res.imported : parsed.length) + ' ' + (isAssets ? 'assets' : 'items'));
          assetsHub(isAssets ? 'equipment' : 'inventory');
        } catch(e) {
          this.disabled = false; this.textContent = 'Retry Import';
          toast('Import failed: ' + e.message, 'error');
        }
      });
    } catch(e) {
      statusEl().innerHTML = '<span style="color:#B3573F">Could not read file: ' + esc(e.message) + '</span>';
    }
  });

  document.getElementById('ah-ie-xlsx').addEventListener('click', async () => {
    try {
      const rows = isAssets ? buildAssetExportRows() : buildStockExportRows();
      await exportToXlsx(rows, isAssets ? 'Assets' : 'Inventory',
        (isAssets ? 'assets_export_' : 'inventory_export_') + todayStr() + '.xlsx');
      toast('Export downloaded');
    } catch(e) { toast('Export failed: ' + e.message, 'error'); }
  });
  document.getElementById('ah-ie-csv').addEventListener('click', () => {
    try {
      const rows = isAssets ? buildAssetExportRows() : buildStockExportRows();
      exportToCsv(rows, (isAssets ? 'assets_export_' : 'inventory_export_') + todayStr() + '.csv');
      toast('Export downloaded');
    } catch(e) { toast('Export failed: ' + e.message, 'error'); }
  });
};
})();
