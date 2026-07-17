// ═══════════════════════════════════════════════════════════════════════════
// SERVICES & PRICING — the company price book (replaces the "Service Data" sheet)
// + Job Cost Settings (labor rate, OHR, profit %, tax, warranty, non-productive)
// + CSV / Excel import (headers: Service / Material, Unit, Unit Cost, Unit Time)
// ═══════════════════════════════════════════════════════════════════════════

let _pbItems = [];
let _pbCats = [];
let _pbActiveCat = '';
let _pbSettings = null;
let _pbQ = '';

function _pbFmt(v) { return '$' + Number(v || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
function _pbEsc(s) { const d = document.createElement('div'); d.textContent = String(s ?? ''); return d.innerHTML; }

async function pricing() {
  const view = document.getElementById('view');
  if (!view) return;
  view.innerHTML = `
  <div class="gwp-shell">
    <header class="gwp-header">
      <div class="gwp-header-left" style="flex-direction:column;align-items:flex-start;gap:2px">
        <h1 class="gwp-title">Services &amp; Pricing</h1>
        <span class="gwp-subtitle">Your master price book — every service, material, and plant with unit cost and man-hours. Powers the estimate builder and AI quotes.</span>
      </div>
      <div class="gwp-header-actions">
        <button class="gwp-btn-ghost" onclick="_pbOpenSettings()" id="pb-settings-btn">⚙️ Job Cost Settings</button>
        <button class="gwp-btn-ghost" onclick="_pbOpenImport()">⬆ Import CSV / Excel</button>
        <button class="gwp-btn-ghost" onclick="_pbExport()" title="Download the whole price book as a CSV you can open in Sheets/Excel">⬇ Export CSV</button>
        <button class="gwp-btn-primary" onclick="_pbOpenItem()">+ Add Item</button>
      </div>
    </header>

    <div class="gwp-kpi-row" id="pb-kpi-row" style="display:none"></div>

    <div class="gwp-filter-bar">
      <div class="gwp-search-wrap">
        <svg class="gwp-search-icon" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="7" cy="7" r="5"/><path d="M14 14l-3.5-3.5"/></svg>
        <input id="pb-search" class="gwp-search-input" placeholder="Search services, materials, plants…" oninput="_pbSearch(this.value)">
      </div>
      <div id="pb-cat-tabs" style="display:flex;gap:6px;flex-wrap:wrap"></div>
    </div>

    <div id="pb-body"><div style="padding:40px;text-align:center;color:var(--gw-text-subtle,#8A948C)">Loading price book…</div></div>
  </div>
  <div id="pb-modal-root"></div>`;
  await _pbLoad();
}
window.pricing = pricing;

async function _pbLoad() {
  try {
    const r = await fetch('/api/price-items?all=1', { credentials: 'include' });
    const j = await r.json();
    _pbItems = j.data || [];
    _pbCats = j.categories || [];
    _pbRenderTabs();
    _pbRenderList();
  } catch (e) {
    const b = document.getElementById('pb-body');
    if (b) b.innerHTML = `<div style="padding:30px;text-align:center;color:#C97B6A">Could not load price book</div>`;
  }
}

function _pbRenderTabs() {
  const el = document.getElementById('pb-cat-tabs');
  if (!el) return;
  const mk = (id, label, active) => `<button class="gwp-chip${active ? ' gwp-chip--active' : ''}" onclick="_pbSetCat('${_pbEsc(id).replace(/'/g, "\\'")}')">${_pbEsc(label)}</button>`;
  el.innerHTML = mk('', `All (${_pbItems.length})`, !_pbActiveCat) +
    _pbCats.map(c => mk(c, c, _pbActiveCat === c)).join('');
}

window._pbSetCat = function(c) { _pbActiveCat = c; _pbRenderTabs(); _pbRenderList(); };
window._pbSearch = function(q) { _pbQ = (q || '').toLowerCase(); _pbRenderList(); };

function _pbRenderList() {
  const body = document.getElementById('pb-body');
  if (!body) return;
  let rows = _pbItems;
  if (_pbActiveCat) rows = rows.filter(i => i.category === _pbActiveCat);
  if (_pbQ) rows = rows.filter(i => (i.name || '').toLowerCase().includes(_pbQ) || (i.unit || '').toLowerCase().includes(_pbQ));

  if (!_pbItems.length) {
    body.innerHTML = `
    <div style="background:var(--gw-surface,#fff);border:1px dashed var(--gw-border,#DDD8CE);border-radius:14px;padding:48px 24px;text-align:center">
      <div style="font-size:15px;font-weight:700;margin-bottom:6px">No price book yet</div>
      <div style="font-size:13px;color:var(--gw-text-subtle,#8A948C);margin-bottom:16px;max-width:520px;margin-left:auto;margin-right:auto">
        Import your pricing spreadsheet (headers: <b>Service / Material, Unit, Unit Cost, Unit Time</b>) or add items one at a time.
        Once loaded, the estimate builder auto-fills costs &amp; labor hours, and the AI quote generator prices from <i>your</i> rates.</div>
      <button class="est-btn-primary" onclick="_pbOpenImport()">⬆ Import CSV / Excel</button>
      <button class="est-btn-secondary" style="margin-left:8px" onclick="_pbOpenItem()">+ Add manually</button>
    </div>`;
    return;
  }
  if (!rows.length) {
    body.innerHTML = `<div style="padding:30px;text-align:center;color:var(--gw-text-subtle,#8A948C)">No items match</div>`;
    return;
  }

  // Group by category
  const groups = {};
  rows.forEach(i => { (groups[i.category || 'General'] = groups[i.category || 'General'] || []).push(i); });

  body.innerHTML = Object.keys(groups).sort().map(cat => `
  <div style="margin-bottom:18px">
    <div style="font-size:12px;font-weight:800;letter-spacing:.6px;text-transform:uppercase;color:var(--gw-text-subtle,#8A948C);margin:0 0 7px 4px">${_pbEsc(cat)} <span style="font-weight:600">· ${groups[cat].length}</span></div>
    <div style="background:var(--gw-surface,#fff);border:1px solid var(--gw-border,#E4E0D6);border-radius:12px;overflow:hidden">
      <div style="display:grid;grid-template-columns:1fr 130px 110px 110px 90px 70px;gap:0;padding:8px 14px;border-bottom:1px solid var(--gw-border-soft,#F0EEE8);font-size:11px;font-weight:700;color:var(--gw-text-subtle,#8A948C);text-transform:uppercase;letter-spacing:.4px">
        <span>Service / Material</span><span>Unit</span><span style="text-align:right">Unit Cost</span><span style="text-align:right">Unit Time (hrs)</span><span style="text-align:center">Type</span><span></span>
      </div>
      ${groups[cat].map(i => `
      <div style="display:grid;grid-template-columns:1fr 130px 110px 110px 90px 70px;align-items:center;padding:9px 14px;border-bottom:1px solid var(--gw-border-soft,#F0EEE8);${i.active ? '' : 'opacity:.45'}">
        <span style="font-size:13.5px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;cursor:pointer" onclick="_pbOpenItem('${i.id}')" title="${_pbEsc(i.name)}">${_pbEsc(i.name)}</span>
        <span style="font-size:12.5px;color:var(--gw-text-subtle,#8A948C)">${_pbEsc(i.unit || '—')}</span>
        <span style="font-size:13px;text-align:right;font-weight:600">${_pbFmt(i.unit_cost)}</span>
        <span style="font-size:13px;text-align:right">${Number(i.unit_time || 0)}</span>
        <span style="font-size:11px;text-align:center"><span style="padding:2px 8px;border-radius:99px;background:var(--gw-bg,#FAF9F5);border:1px solid var(--gw-border-soft,#F0EEE8)">${_pbEsc(i.item_type || 'material')}</span></span>
        <span style="text-align:right;white-space:nowrap">
          <button onclick="_pbOpenItem('${i.id}')" title="Edit" style="background:none;border:none;cursor:pointer;font-size:13px;padding:3px">✏️</button>
          <button onclick="_pbDelete('${i.id}')" title="Delete" style="background:none;border:none;cursor:pointer;font-size:13px;padding:3px">🗑</button>
        </span>
      </div>`).join('')}
    </div>
  </div>`).join('');
}

// ── Add / Edit item modal ────────────────────────────────────────────────────
window._pbOpenItem = function(id) {
  const it = id ? _pbItems.find(x => x.id === id) : null;
  const root = document.getElementById('pb-modal-root');
  const catOpts = [...new Set(['Landscaping', 'Hardscaping / Drainage', 'Planting', 'Maintenance', 'General', ..._pbCats])];
  root.innerHTML = `
  <div id="pb-item-modal" style="position:fixed;inset:0;background:rgba(20,24,21,.45);z-index:1000;display:flex;align-items:center;justify-content:center;padding:16px" onclick="if(event.target===this)this.remove()">
    <div style="background:var(--gw-surface,#fff);border-radius:16px;max-width:520px;width:100%;padding:24px;box-shadow:0 18px 50px rgba(0,0,0,.25)">
      <h2 style="font-size:17px;font-weight:800;margin:0 0 16px">${it ? 'Edit Item' : 'Add Price Book Item'}</h2>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
        <label style="grid-column:1/-1;font-size:12px;font-weight:700;color:var(--gw-text-subtle,#8A948C)">SERVICE / MATERIAL NAME
          <input id="pbf-name" value="${_pbEsc(it?.name || '')}" style="width:100%;margin-top:4px;padding:9px 11px;border:1px solid var(--gw-border,#DDD8CE);border-radius:8px;font-size:13.5px;box-sizing:border-box"></label>
        <label style="font-size:12px;font-weight:700;color:var(--gw-text-subtle,#8A948C)">CATEGORY
          <input id="pbf-cat" list="pbf-cat-list" value="${_pbEsc(it?.category || _pbActiveCat || 'General')}" style="width:100%;margin-top:4px;padding:9px 11px;border:1px solid var(--gw-border,#DDD8CE);border-radius:8px;font-size:13.5px;box-sizing:border-box">
          <datalist id="pbf-cat-list">${catOpts.map(c => `<option value="${_pbEsc(c)}">`).join('')}</datalist></label>
        <label style="font-size:12px;font-weight:700;color:var(--gw-text-subtle,#8A948C)">TYPE
          <select id="pbf-type" style="width:100%;margin-top:4px;padding:9px 11px;border:1px solid var(--gw-border,#DDD8CE);border-radius:8px;font-size:13.5px;box-sizing:border-box">
            ${['material','labor','service','equipment','plant'].map(t => `<option value="${t}" ${it?.item_type === t ? 'selected' : ''}>${t[0].toUpperCase() + t.slice(1)}</option>`).join('')}
          </select></label>
        <label style="font-size:12px;font-weight:700;color:var(--gw-text-subtle,#8A948C)">UNIT <span style="font-weight:500">(cubic yard, per sqft, each, Labor…)</span>
          <input id="pbf-unit" value="${_pbEsc(it?.unit || '')}" style="width:100%;margin-top:4px;padding:9px 11px;border:1px solid var(--gw-border,#DDD8CE);border-radius:8px;font-size:13.5px;box-sizing:border-box"></label>
        <label style="font-size:12px;font-weight:700;color:var(--gw-text-subtle,#8A948C)">UNIT COST ($)
          <input id="pbf-cost" type="number" step="0.01" value="${Number(it?.unit_cost || 0)}" style="width:100%;margin-top:4px;padding:9px 11px;border:1px solid var(--gw-border,#DDD8CE);border-radius:8px;font-size:13.5px;box-sizing:border-box"></label>
        <label style="font-size:12px;font-weight:700;color:var(--gw-text-subtle,#8A948C)">UNIT TIME (man-hours)
          <input id="pbf-time" type="number" step="0.01" value="${Number(it?.unit_time || 0)}" style="width:100%;margin-top:4px;padding:9px 11px;border:1px solid var(--gw-border,#DDD8CE);border-radius:8px;font-size:13.5px;box-sizing:border-box"></label>
        <label style="font-size:12px;font-weight:700;color:var(--gw-text-subtle,#8A948C)">ACTIVE
          <select id="pbf-active" style="width:100%;margin-top:4px;padding:9px 11px;border:1px solid var(--gw-border,#DDD8CE);border-radius:8px;font-size:13.5px;box-sizing:border-box">
            <option value="1" ${(it?.active ?? 1) ? 'selected' : ''}>Active</option><option value="0" ${it && !it.active ? 'selected' : ''}>Hidden</option>
          </select></label>
      </div>
      <div id="pbf-err" style="color:#C97B6A;font-size:12.5px;margin-top:8px;display:none"></div>
      <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:18px">
        <button class="est-btn-secondary" onclick="document.getElementById('pb-item-modal').remove()">Cancel</button>
        <button class="est-btn-primary" onclick="_pbSaveItem('${it?.id || ''}')">${it ? 'Save Changes' : 'Add Item'}</button>
      </div>
    </div>
  </div>`;
  setTimeout(() => document.getElementById('pbf-name')?.focus(), 50);
};

window._pbSaveItem = async function(id) {
  const g = i => (document.getElementById(i) || {}).value || '';
  const payload = {
    name: g('pbf-name').trim(), category: g('pbf-cat').trim() || 'General',
    item_type: g('pbf-type'), unit: g('pbf-unit').trim(),
    unit_cost: Number(g('pbf-cost') || 0), unit_time: Number(g('pbf-time') || 0),
    active: Number(g('pbf-active')),
  };
  const errEl = document.getElementById('pbf-err');
  if (!payload.name) { errEl.textContent = 'Name is required'; errEl.style.display = 'block'; return; }
  try {
    const r = await fetch(id ? `/api/price-items/${id}` : '/api/price-items', {
      method: id ? 'PUT' : 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    });
    if (!r.ok) throw new Error('save failed');
    document.getElementById('pb-item-modal')?.remove();
    await _pbLoad();
    if (typeof showToast === 'function') showToast(id ? 'Item updated' : 'Item added', 'success');
  } catch (e) { errEl.textContent = 'Could not save — try again'; errEl.style.display = 'block'; }
};

window._pbDelete = async function(id) {
  if (!confirm('Delete this price book item?')) return;
  await fetch(`/api/price-items/${id}`, { method: 'DELETE', credentials: 'include' }).catch(() => {});
  await _pbLoad();
};

// ═══════════════════════════════════════════════════════════════════════════
// IMPORT — CSV / Excel price sheet import with smart header detection.
// Handles: single-table sheets (with or without a Category column) AND
// multi-block sheets where several "Service / Material | Unit | Unit Cost |
// Unit Time" blocks sit side-by-side, each titled by its category above.
// ═══════════════════════════════════════════════════════════════════════════

let _pbImpRows = [];      // parsed {category,name,unit,unit_cost,unit_time,item_type}
let _pbImpWb = null;      // SheetJS workbook (xlsx path)

function _pbLoadSheetJS() {
  return new Promise((resolve, reject) => {
    if (window.XLSX) return resolve(window.XLSX);
    const s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js';
    s.onload = () => resolve(window.XLSX);
    s.onerror = () => reject(new Error('Could not load spreadsheet parser'));
    document.head.appendChild(s);
  });
}

window._pbOpenImport = function() {
  _pbImpRows = []; _pbImpWb = null;
  const root = document.getElementById('pb-modal-root');
  if (!root) return;
  root.innerHTML = `
  <div id="pb-import-modal" style="position:fixed;inset:0;background:rgba(20,26,22,.45);z-index:1000;display:flex;align-items:center;justify-content:center;padding:20px" onclick="if(event.target===this)this.remove()">
    <div style="background:var(--gw-surface,#fff);border-radius:14px;max-width:760px;width:100%;max-height:88vh;overflow:auto;padding:22px;box-shadow:0 18px 50px rgba(0,0,0,.25)">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:4px">
        <h2 style="font-size:17px;font-weight:800;margin:0">Import Price Book</h2>
        <button onclick="document.getElementById('pb-import-modal').remove()" style="border:none;background:none;font-size:20px;cursor:pointer;color:var(--gw-text-subtle,#8A948C)">✕</button>
      </div>
      <div style="font-size:12.5px;color:var(--gw-text-subtle,#8A948C);margin-bottom:14px">
        Upload a <b>.csv</b> or <b>.xlsx</b> file. We auto-detect headers like
        <code style="background:var(--gw-bg,#F4F1EA);padding:1px 5px;border-radius:4px">Service / Material · Unit · Unit Cost · Unit Time</code>
        — including sheets with multiple category blocks side by side. An optional <b>Category</b> column is also supported.
      </div>

      <label style="display:block;border:2px dashed var(--gw-border,#DDD8CE);border-radius:12px;padding:26px;text-align:center;cursor:pointer;margin-bottom:12px" id="pb-imp-drop">
        <input type="file" id="pb-imp-file" accept=".csv,.xlsx,.xls" style="display:none" onchange="_pbImpFile(this.files[0])">
        <div style="font-size:28px;margin-bottom:6px">📄</div>
        <div style="font-size:13.5px;font-weight:700">Click to choose a file</div>
        <div style="font-size:12px;color:var(--gw-text-subtle,#8A948C)">CSV, XLSX or XLS — up to 5,000 items</div>
      </label>

      <div id="pb-imp-sheetpick" style="display:none;margin-bottom:12px"></div>
      <div id="pb-imp-preview"></div>

      <div id="pb-imp-footer" style="display:none;margin-top:14px">
        <div style="display:flex;gap:16px;align-items:center;margin-bottom:12px;flex-wrap:wrap">
          <label style="font-size:13px;display:flex;gap:6px;align-items:center;cursor:pointer">
            <input type="radio" name="pb-imp-mode" value="merge" checked> <b>Merge</b>&nbsp;— update matching items, add new ones
          </label>
          <label style="font-size:13px;display:flex;gap:6px;align-items:center;cursor:pointer">
            <input type="radio" name="pb-imp-mode" value="replace"> <b>Replace</b>&nbsp;— wipe imported categories first
          </label>
        </div>
        <div style="display:flex;gap:8px;justify-content:flex-end">
          <button class="est-btn-secondary" onclick="document.getElementById('pb-import-modal').remove()">Cancel</button>
          <button class="est-btn-primary" id="pb-imp-go" onclick="_pbImpRun()">Import <span id="pb-imp-count"></span> items</button>
        </div>
      </div>
      <div id="pb-imp-err" style="display:none;margin-top:10px;padding:9px 12px;background:#FBEDEA;color:#A6543F;border-radius:8px;font-size:12.5px"></div>
    </div>
  </div>`;
};

function _pbImpErr(msg) {
  const e = document.getElementById('pb-imp-err');
  if (e) { e.textContent = msg; e.style.display = 'block'; }
}

window._pbImpFile = async function(file) {
  if (!file) return;
  const errEl = document.getElementById('pb-imp-err'); if (errEl) errEl.style.display = 'none';
  const name = (file.name || '').toLowerCase();
  try {
    if (name.endsWith('.csv')) {
      const text = await file.text();
      const aoa = _pbParseCsv(text);
      _pbImpParseAoa(aoa, 'CSV');
    } else {
      const XLSX = await _pbLoadSheetJS();
      const buf = await file.arrayBuffer();
      _pbImpWb = XLSX.read(buf, { type: 'array' });
      const names = _pbImpWb.SheetNames || [];
      if (!names.length) return _pbImpErr('No sheets found in workbook');
      if (names.length > 1) {
        const sp = document.getElementById('pb-imp-sheetpick');
        sp.style.display = 'block';
        sp.innerHTML = `<label style="font-size:12.5px;font-weight:700;display:block;margin-bottom:4px">Sheet to import</label>
          <select id="pb-imp-sheet" onchange="_pbImpPickSheet(this.value)" style="padding:8px 10px;border:1px solid var(--gw-border,#DDD8CE);border-radius:8px;font-size:13px;min-width:240px">
            ${names.map(n => `<option value="${_pbEsc(n)}">${_pbEsc(n)}</option>`).join('')}
          </select>`;
      }
      _pbImpPickSheet(names[0]);
    }
  } catch (e) { _pbImpErr(e.message || 'Could not read file'); }
};

window._pbImpPickSheet = function(sheetName) {
  if (!_pbImpWb) return;
  const ws = _pbImpWb.Sheets[sheetName];
  if (!ws) return _pbImpErr('Sheet not found');
  const aoa = window.XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', raw: true });
  _pbImpParseAoa(aoa, sheetName);
};

// Simple CSV → array-of-arrays (handles quoted fields)
function _pbParseCsv(text) {
  const rows = []; let row = [], cell = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQ) {
      if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else inQ = false; }
      else cell += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

function _pbNum(v) {
  if (typeof v === 'number') return isFinite(v) ? v : 0;
  const n = parseFloat(String(v ?? '').replace(/[$,\s]/g, ''));
  return isFinite(n) ? n : 0;
}
function _pbNorm(v) { return String(v ?? '').trim().toLowerCase().replace(/\s+/g, ' '); }

// Detect header blocks in an AOA and extract items.
// A header block = a row where a "name" header cell is found and within the
// next 6 columns a "cost" header exists. Category = optional Category column,
// else the nearest non-empty cell above the name header, else sheet name.
function _pbImpParseAoa(aoa, fallbackCat) {
  const isName = s => /^(service\s*\/\s*material|service|material|item|name|description|plant material|general material)$/.test(s);
  const isUnit = s => /^unit(s)?( of measure)?$/.test(s);
  const isCost = s => /^(unit\s*)?cost$|^unit cost$|^price$|^unit price$|^cost each$/.test(s);
  const isTime = s => /^(unit\s*)?time$|^unit time$|^man\s*hours?$|^hours?$|^unit hrs?$/.test(s);
  const isCat  = s => /^(category|group|division|type)$/.test(s);

  const blocks = []; // {row, nameC, unitC, costC, timeC, catC, category}
  for (let r = 0; r < Math.min(aoa.length, 400); r++) {
    const row = aoa[r] || [];
    for (let c = 0; c < row.length; c++) {
      if (!isName(_pbNorm(row[c]))) continue;
      // look right for cost within 6 cols
      let unitC = -1, costC = -1, timeC = -1, catC = -1;
      for (let k = c + 1; k <= c + 6 && k < row.length; k++) {
        const h = _pbNorm(row[k]);
        if (unitC < 0 && isUnit(h)) unitC = k;
        else if (costC < 0 && isCost(h)) costC = k;
        else if (timeC < 0 && isTime(h)) timeC = k;
      }
      // category column may sit left of name
      for (let k = Math.max(0, c - 2); k < c; k++) if (isCat(_pbNorm(row[k]))) catC = k;
      if (costC < 0) continue;
      // block title: nearest non-empty cell above the name header (within 4 rows)
      let category = '';
      for (let up = r - 1; up >= Math.max(0, r - 4); up--) {
        const t = String((aoa[up] || [])[c] ?? '').trim();
        if (t) { category = t; break; }
      }
      blocks.push({ row: r, nameC: c, unitC, costC, timeC, catC, category: category || '' });
    }
  }

  const out = [];
  if (blocks.length) {
    for (const b of blocks) {
      let blanks = 0;
      for (let r = b.row + 1; r < aoa.length; r++) {
        const row = aoa[r] || [];
        const nm = String(row[b.nameC] ?? '').trim();
        if (!nm) { if (++blanks > 8) break; continue; }
        blanks = 0;
        const nmN = _pbNorm(nm);
        // skip subtotal/section noise
        if (/^(total|subtotal|sum|notes?)\b/.test(nmN)) continue;
        // a new inline sub-header inside the block resets nothing; skip it
        if (isName(nmN)) continue;
        const cat = b.catC >= 0 && String(row[b.catC] ?? '').trim() ? String(row[b.catC]).trim() : (b.category || fallbackCat || 'General');
        const unitRaw = b.unitC >= 0 ? String(row[b.unitC] ?? '').trim() : '';
        const cost = _pbNum(row[b.costC]);
        const time = b.timeC >= 0 ? _pbNum(row[b.timeC]) : 0;
        const type = /labor/.test(_pbNorm(unitRaw)) || /labor/.test(nmN) ? 'labor'
          : /plant|tree|shrub|perennial/i.test(cat) ? 'plant'
          : /equipment|rental/i.test(cat) || /rental/.test(nmN) ? 'equipment' : 'material';
        out.push({ category: cat.slice(0, 80), name: nm.slice(0, 200), unit: unitRaw.slice(0, 80), unit_cost: cost, unit_time: time, item_type: type });
      }
    }
  }
  if (!out.length) return _pbImpErr('No price rows detected. Make sure the sheet has headers like "Service / Material, Unit, Unit Cost, Unit Time".');

  // de-dupe by (category|name) keeping last occurrence
  const seen = new Map();
  for (const r of out) seen.set(r.category + '|' + r.name.toLowerCase(), r);
  _pbImpRows = [...seen.values()].slice(0, 5000);
  _pbImpRenderPreview();
}

function _pbImpRenderPreview() {
  const pv = document.getElementById('pb-imp-preview');
  const ft = document.getElementById('pb-imp-footer');
  if (!pv) return;
  const cats = {};
  for (const r of _pbImpRows) cats[r.category] = (cats[r.category] || 0) + 1;
  const catBadges = Object.entries(cats).map(([c, n]) =>
    `<span style="display:inline-block;padding:3px 10px;border-radius:99px;background:var(--gw-bg,#F4F1EA);font-size:11.5px;font-weight:700;margin:0 6px 6px 0">${_pbEsc(c)} · ${n}</span>`).join('');
  const sample = _pbImpRows.slice(0, 12);
  pv.innerHTML = `
    <div style="margin-bottom:8px">${catBadges}</div>
    <div style="border:1px solid var(--gw-border,#DDD8CE);border-radius:10px;overflow:hidden">
      <div style="display:grid;grid-template-columns:1.1fr 2fr .8fr .8fr .7fr;gap:0;font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:.04em;color:var(--gw-text-subtle,#8A948C);padding:8px 12px;background:var(--gw-bg,#F4F1EA)">
        <span>Category</span><span>Name</span><span>Unit</span><span style="text-align:right">Cost</span><span style="text-align:right">Time</span>
      </div>
      ${sample.map(r => `<div style="display:grid;grid-template-columns:1.1fr 2fr .8fr .8fr .7fr;padding:7px 12px;font-size:12.5px;border-top:1px solid var(--gw-border,#EEE9DF)">
        <span style="color:var(--gw-text-subtle,#8A948C)">${_pbEsc(r.category)}</span><span style="font-weight:600">${_pbEsc(r.name)}</span><span>${_pbEsc(r.unit)}</span>
        <span style="text-align:right">${_pbFmt(r.unit_cost)}</span><span style="text-align:right">${r.unit_time || ''}</span>
      </div>`).join('')}
      ${_pbImpRows.length > 12 ? `<div style="padding:8px 12px;font-size:12px;color:var(--gw-text-subtle,#8A948C);border-top:1px solid var(--gw-border,#EEE9DF)">…and ${_pbImpRows.length - 12} more</div>` : ''}
    </div>`;
  if (ft) {
    ft.style.display = 'block';
    const cnt = document.getElementById('pb-imp-count');
    if (cnt) cnt.textContent = _pbImpRows.length;
  }
}

window._pbImpRun = async function() {
  if (!_pbImpRows.length) return;
  const mode = (document.querySelector('input[name="pb-imp-mode"]:checked') || {}).value || 'merge';
  const btn = document.getElementById('pb-imp-go');
  if (btn) { btn.disabled = true; btn.textContent = 'Importing…'; }
  try {
    const r = await fetch('/api/price-items/import', {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rows: _pbImpRows, mode }),
    });
    const j = await r.json();
    if (!r.ok || !j.ok) throw new Error(j.error || 'Import failed');
    document.getElementById('pb-import-modal')?.remove();
    if (typeof showToast === 'function') showToast(`Imported ${j.total} items (${j.inserted} new, ${j.updated} updated)`, 'success');
    await _pbLoad();
  } catch (e) {
    _pbImpErr(e.message || 'Import failed');
    if (btn) { btn.disabled = false; btn.textContent = 'Import ' + _pbImpRows.length + ' items'; }
  }
};

// ═══════════════════════════════════════════════════════════════════════════
// JOB COST SETTINGS — the numbers that used to be buried in spreadsheet
// formulas: labor rate, OHR, profit %, tax, warranty, crew defaults, etc.
// ═══════════════════════════════════════════════════════════════════════════

const _PB_SETTING_GROUPS = [
  { title: 'Labor & Overhead', desc: 'What an hour of work really costs you', fields: [
    ['labor_rate', 'Direct labor rate ($/man-hour)', 'Crew wage cost per productive hour'],
    ['ohr_rate', 'Overhead recovery ($/budgeted hour)', 'Trucks, insurance, office — recovered per budgeted hour'],
    ['setup_pay_rate', 'Estimator / setup pay ($/hour)', 'Owner or estimator time billed into jobs'],
    ['setup_hours_default', 'Default setup hours per job', ''],
  ]},
  { title: 'Profit, Tax & Warranty', desc: '', fields: [
    ['profit_pct', 'Target profit (%)', 'Applied on break-even price'],
    ['tax_pct', 'Materials sales tax (%)', ''],
    ['warranty_pct', 'Plant / warranty reserve (%)', 'Reserve on plant material for warranty replacements'],
    ['rev_per_hour_goal', 'Revenue per man-hour goal ($)', 'The floor — jobs pricing under this get flagged'],
  ]},
  { title: 'Crew & Schedule Defaults', desc: '', fields: [
    ['crew_size_default', 'Default crew size', ''],
    ['workday_hours', 'Workday length (hours)', ''],
    ['nonprod_hours_per_person_day', 'Non-productive hrs / person / day', 'Load-up, drive time, breaks'],
  ]},
  { title: 'Maintenance / Recurring Division', desc: 'Rates for monthly contracts (can differ from install division)', fields: [
    ['maint_labor_rate', 'Maintenance labor rate ($/hr)', ''],
    ['maint_ohr_rate', 'Maintenance overhead ($/hr)', ''],
    ['maint_profit_pct', 'Maintenance profit (%)', ''],
    ['escalation_pct', 'Yearly contract escalation (%)', 'Auto price increase years 2-3'],
  ]},
  { title: 'Per-Job Misc Defaults', desc: 'Auto-added line defaults on new estimates', fields: [
    ['contingency_default', 'Contingency ($)', ''],
    ['disposal_default', 'Disposal fee ($)', ''],
    ['pickup_default', 'Material pick-up ($)', ''],
  ]},
];

window._pbOpenSettings = async function() {
  const root = document.getElementById('pb-modal-root');
  if (!root) return;
  let data = {};
  try {
    const r = await fetch('/api/pricing-settings', { credentials: 'include' });
    const j = await r.json();
    data = j.data || {};
  } catch (e) {}
  _pbSettings = data;
  const fld = ([key, label, hint]) => `
    <div>
      <label style="font-size:12px;font-weight:700;display:block;margin-bottom:3px">${_pbEsc(label)}</label>
      <input type="number" step="any" id="pbs-${key}" value="${data[key] ?? ''}"
        style="width:100%;padding:8px 10px;border:1px solid var(--gw-border,#DDD8CE);border-radius:8px;font-size:13px;background:var(--gw-surface,#fff)">
      ${hint ? `<div style="font-size:11px;color:var(--gw-text-subtle,#8A948C);margin-top:2px">${_pbEsc(hint)}</div>` : ''}
    </div>`;
  root.innerHTML = `
  <div id="pb-settings-modal" style="position:fixed;inset:0;background:rgba(20,26,22,.45);z-index:1000;display:flex;align-items:center;justify-content:center;padding:20px" onclick="if(event.target===this)this.remove()">
    <div style="background:var(--gw-surface,#fff);border-radius:14px;max-width:640px;width:100%;max-height:88vh;overflow:auto;padding:22px;box-shadow:0 18px 50px rgba(0,0,0,.25)">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:2px">
        <h2 style="font-size:17px;font-weight:800;margin:0">⚙️ Job Cost Settings</h2>
        <button onclick="document.getElementById('pb-settings-modal').remove()" style="border:none;background:none;font-size:20px;cursor:pointer;color:var(--gw-text-subtle,#8A948C)">✕</button>
      </div>
      <div style="font-size:12.5px;color:var(--gw-text-subtle,#8A948C);margin-bottom:14px">These replace your spreadsheet formulas. The estimate builder's cost engine uses them on every job.</div>
      ${_PB_SETTING_GROUPS.map(g => `
        <div style="margin-bottom:16px">
          <div style="font-size:13px;font-weight:800;margin-bottom:2px">${_pbEsc(g.title)}</div>
          ${g.desc ? `<div style="font-size:11.5px;color:var(--gw-text-subtle,#8A948C);margin-bottom:8px">${_pbEsc(g.desc)}</div>` : '<div style="margin-bottom:8px"></div>'}
          <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:10px">${g.fields.map(fld).join('')}</div>
        </div>`).join('')}
      <div id="pbs-err" style="display:none;margin-bottom:10px;padding:9px 12px;background:#FBEDEA;color:#A6543F;border-radius:8px;font-size:12.5px"></div>
      <div style="display:flex;gap:8px;justify-content:flex-end">
        <button class="est-btn-secondary" onclick="document.getElementById('pb-settings-modal').remove()">Cancel</button>
        <button class="est-btn-primary" id="pbs-save" onclick="_pbSaveSettings()">Save Settings</button>
      </div>
    </div>
  </div>`;
};

// Export the entire price book as CSV (opens straight in Sheets / Excel).
// Round-trips with the importer — same headers it detects.
window._pbExport = function() {
  const items = _pbItems || [];
  if (!items.length) { if (typeof showToast === 'function') showToast('Price book is empty — nothing to export', 'info'); return; }
  const esc = (v) => {
    v = String(v ?? '');
    return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
  };
  const header = ['Category', 'Service / Material', 'Unit', 'Unit Cost', 'Unit Time', 'Type', 'SKU', 'Vendor', 'Notes'];
  const lines = [header.join(',')];
  // Keep category blocks together like the spreadsheet
  const sorted = [...items].sort((a, b) => String(a.category || '').localeCompare(String(b.category || '')) || String(a.name || '').localeCompare(String(b.name || '')));
  for (const it of sorted) {
    lines.push([esc(it.category), esc(it.name), esc(it.unit), Number(it.unit_cost || 0), Number(it.unit_time || 0), esc(it.item_type), esc(it.sku), esc(it.vendor), esc(it.notes)].join(','));
  }
  const blob = new Blob(['\ufeff' + lines.join('\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `price-book-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 400);
  if (typeof showToast === 'function') showToast(`Exported ${items.length} price book item${items.length !== 1 ? 's' : ''}`, 'success');
};

window._pbSaveSettings = async function() {
  const payload = {};
  for (const g of _PB_SETTING_GROUPS) for (const [key] of g.fields) {
    const el = document.getElementById('pbs-' + key);
    if (el && el.value !== '' && isFinite(Number(el.value))) payload[key] = Number(el.value);
  }
  const btn = document.getElementById('pbs-save');
  if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
  try {
    const r = await fetch('/api/pricing-settings', {
      method: 'PUT', credentials: 'include',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    });
    const j = await r.json();
    if (!r.ok || !j.ok) throw new Error(j.error || 'Save failed');
    document.getElementById('pb-settings-modal')?.remove();
    if (typeof showToast === 'function') showToast('Job cost settings saved', 'success');
  } catch (e) {
    const err = document.getElementById('pbs-err');
    if (err) { err.textContent = e.message || 'Save failed'; err.style.display = 'block'; }
    if (btn) { btn.disabled = false; btn.textContent = 'Save Settings'; }
  }
};
