// ── Groundwork CRM — CSV Client Import (Bulletproof) ─────────────────────────
// Full flow: upload → column mapping → dedup preview → bulk import → log
// Version: 20260711p47
// Depends on: gw-icons.js, app_premium.js (showToast, gwIcon)
// ─────────────────────────────────────────────────────────────────────────────

/* ── State ─────────────────────────────────────────────────────────────────── */
let _csvState = {
  rawHeaders: [],
  rawRows: [],
  mappedRows: [],
  columnMap: {},
  previewResult: null,
};

/* ── Entry point: open the import modal ────────────────────────────────────── */
window.gwOpenCSVImport = function() {
  const overlay = _csvCreateOverlay('csv-import-overlay');
  overlay.innerHTML = `<div class="csv-modal">
    <div class="csv-modal-header">
      <div class="csv-modal-title">${gwIcon('upload',18,'#1C3A2B')} Import Clients from CSV</div>
      <button class="csv-modal-close" onclick="document.getElementById('csv-import-overlay').remove()">×</button>
    </div>
    <div class="csv-modal-body" id="csvModalBody">
      ${_csvStep1HTML()}
    </div>
  </div>`;
  document.body.appendChild(overlay);
};

/* ── Step 1: Upload ─────────────────────────────────────────────────────────── */
function _csvStep1HTML() {
  return `
<div class="csv-step" id="csvStep1">
  <div class="csv-step-header">
    <div class="csv-step-num">1</div>
    <div>
      <div class="csv-step-title">Upload CSV File</div>
      <div class="csv-step-sub">Supported: any CSV with client data. UTF-8 encoding recommended.</div>
    </div>
  </div>

  <div class="csv-drop-zone" id="csvDropZone" onclick="document.getElementById('csvFileInput').click()"
    ondragover="event.preventDefault();this.classList.add('csv-drop-hover')"
    ondragleave="this.classList.remove('csv-drop-hover')"
    ondrop="_csvHandleDrop(event)">
    <div class="csv-drop-icon">${gwIcon('upload',36,'#9CA3AF')}</div>
    <div class="csv-drop-text">Drag & drop your CSV here, or click to browse</div>
    <div class="csv-drop-sub">Max 10MB · CSV files only</div>
    <input type="file" id="csvFileInput" accept=".csv,text/csv" style="display:none" onchange="_csvHandleFile(this.files[0])">
  </div>

  <div id="csvFileInfo" style="display:none" class="csv-file-info">
    <div class="csv-file-icon">${gwIcon('document',20,'#2D7A55')}</div>
    <div class="csv-file-details">
      <div class="csv-file-name" id="csvFileName"></div>
      <div class="csv-file-meta" id="csvFileMeta"></div>
    </div>
    <button class="csv-btn-ghost" onclick="_csvReset()">Change file</button>
  </div>

  <div class="csv-sample-note">
    <div class="csv-sample-title">${gwIcon('info',13,'#5B7FA6')} Expected columns (any order, any name):</div>
    <div class="csv-sample-chips">
      ${['Name','Email','Phone','Address / Street','City','State','Zip','Type','Status','Notes'].map(c=>`<span class="csv-chip">${c}</span>`).join('')}
    </div>
  </div>

  <div class="csv-footer">
    <span></span>
    <button class="csv-btn-primary" id="csvNextStep1" onclick="_csvGoStep2()" disabled>
      Next: Map Columns ${gwIcon('arrow-right',13,'#fff')}
    </button>
  </div>
</div>`;
}

/* ── File handling ──────────────────────────────────────────────────────────── */
window._csvHandleDrop = function(e) {
  e.preventDefault();
  document.getElementById('csvDropZone')?.classList.remove('csv-drop-hover');
  const file = e.dataTransfer?.files?.[0];
  if (file) _csvHandleFile(file);
};

window._csvHandleFile = function(file) {
  if (!file) return;
  if (!file.name.endsWith('.csv') && file.type !== 'text/csv') {
    showToast('Please select a CSV file', 'error'); return;
  }
  if (file.size > 10 * 1024 * 1024) {
    showToast('File too large. Max 10MB.', 'error'); return;
  }

  const reader = new FileReader();
  reader.onload = function(e) {
    try {
      const text = e.target.result;
      const parsed = _csvParse(text);
      if (!parsed.headers.length || !parsed.rows.length) {
        showToast('CSV appears empty or invalid', 'error'); return;
      }
      _csvState.rawHeaders = parsed.headers;
      _csvState.rawRows = parsed.rows;

      // Show file info
      const dropZone = document.getElementById('csvDropZone');
      const fileInfo = document.getElementById('csvFileInfo');
      if (dropZone) dropZone.style.display = 'none';
      if (fileInfo) fileInfo.style.display = 'flex';
      const fn = document.getElementById('csvFileName'); if(fn) fn.textContent = file.name;
      const fm = document.getElementById('csvFileMeta');
      if(fm) fm.textContent = `${parsed.rows.length.toLocaleString()} records · ${parsed.headers.length} columns`;

      const nextBtn = document.getElementById('csvNextStep1');
      if (nextBtn) nextBtn.disabled = false;
    } catch(err) {
      showToast('Failed to parse CSV: ' + err.message, 'error');
    }
  };
  reader.readAsText(file);
};

/* ── CSV parser (handles quotes, commas inside quotes, CRLF) ────────────────── */
function _csvParse(text) {
  // Quote-aware record parser: quoted fields may contain commas AND newlines
  // (e.g. Homeworks exports embed multi-line HTML in Notes). Splitting by
  // newline first shredded those fields into junk rows — never do that.
  const records = (window._gwParseCsvRecords || _csvParseRecordsFallback)(text);
  const clean = (v) => (window._gwCleanImportText
    ? window._gwCleanImportText(v)
    : String(v == null ? '' : v).replace(/<[^>]*>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/\s+/g, ' ').trim());
  if (!records.length) return { headers: [], rows: [] };
  const headers = records[0].map(h => clean(h));
  const rows = [];
  for (let i = 1; i < records.length; i++) {
    if (!records[i].join('').trim()) continue;
    const row = {};
    headers.forEach((h, idx) => { row[h] = clean(records[i][idx]); });
    rows.push(row);
  }
  return { headers, rows };
}

// Standalone fallback if app_premium.js has not defined _gwParseCsvRecords
function _csvParseRecordsFallback(text) {
  const records = []; let row = []; let field = ''; let inQ = false;
  const s = String(text || '').replace(/^\uFEFF/, '');
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inQ) {
      if (ch === '"') { if (s[i+1] === '"') { field += '"'; i++; } else { inQ = false; } }
      else field += ch;
    } else if (ch === '"') { inQ = true; }
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && s[i+1] === '\n') i++;
      row.push(field); field = '';
      if (row.length > 1 || row[0].trim() !== '') records.push(row);
      row = [];
    } else field += ch;
  }
  row.push(field);
  if (row.length > 1 || row[0].trim() !== '') records.push(row);
  return records;
}

window._csvReset = function() {
  _csvState = { rawHeaders:[], rawRows:[], mappedRows:[], columnMap:{}, previewResult:null };
  const dropZone = document.getElementById('csvDropZone');
  const fileInfo = document.getElementById('csvFileInfo');
  if (dropZone) dropZone.style.display = '';
  if (fileInfo) fileInfo.style.display = 'none';
  const nextBtn = document.getElementById('csvNextStep1'); if(nextBtn) nextBtn.disabled = true;
};

/* ── Step 2: Column Mapping ─────────────────────────────────────────────────── */
const _csvTargetFields = [
  { key: 'name',    label: 'Name',    required: true  },
  { key: 'email',   label: 'Email',   required: false },
  { key: 'phone',   label: 'Phone',   required: false },
  { key: 'mobile',  label: 'Mobile',  required: false },
  { key: 'address', label: 'Street Address', required: false },
  { key: 'city',    label: 'City',    required: false },
  { key: 'state',   label: 'State',   required: false },
  { key: 'zip',     label: 'Zip',     required: false },
  { key: 'type',    label: 'Type (Residential/Commercial)', required: false },
  { key: 'status',  label: 'Status',  required: false },
  { key: 'notes',   label: 'Notes',   required: false },
];

// Auto-detect common column name patterns
function _csvAutoMap(headers) {
  const map = {};
  const normalize = h => h.toLowerCase().replace(/[\s_\-\.]/g,'');
  const patterns = {
    name:    ['name','fullname','clientname','customername','company','businessname','contactname'],
    email:   ['email','emailaddress','e-mail','mail'],
    phone:   ['phone','phonenumber','telephone','tel','homephone','workphone','office'],
    mobile:  ['mobile','cell','cellphone','cellular'],
    address: ['address','street','streetaddress','address1','addr','line1'],
    city:    ['city','town'],
    state:   ['state','province','region','st'],
    zip:     ['zip','zipcode','postalcode','postal'],
    type:    ['type','clienttype','customertype','category'],
    status:  ['status','clientstatus'],
    notes:   ['notes','note','comments','comment','memo','description'],
  };
  headers.forEach(h => {
    const n = normalize(h);
    for (const [field, pats] of Object.entries(patterns)) {
      if (!map[field] && pats.some(p => n.includes(p))) {
        map[field] = h; break;
      }
    }
  });
  return map;
}

function _csvGoStep2() {
  if (!_csvState.rawRows.length) return;
  _csvState.columnMap = _csvAutoMap(_csvState.rawHeaders);
  const body = document.getElementById('csvModalBody');
  if (!body) return;

  const headers = _csvState.rawHeaders;
  const optionsList = headers.map(h => `<option value="${h}">${h}</option>`).join('');

  body.innerHTML = `
<div class="csv-step" id="csvStep2">
  <div class="csv-step-header">
    <div class="csv-step-num">2</div>
    <div>
      <div class="csv-step-title">Map Columns</div>
      <div class="csv-step-sub">Match your CSV columns to Groundwork fields. Auto-detected from column names.</div>
    </div>
  </div>

  <div class="csv-map-grid">
    ${_csvTargetFields.map(f => `
      <div class="csv-map-row">
        <div class="csv-map-target">
          <span class="csv-map-label">${f.label}${f.required ? ' <span class="csv-required">*</span>':''}</span>
        </div>
        <div class="csv-map-arrow">${gwIcon('arrow-right',14,'#D1D5DB')}</div>
        <div class="csv-map-select-wrap">
          <select class="csv-select" id="csvMap_${f.key}" onchange="_csvUpdatePreviewRow()">
            <option value="">— skip —</option>
            ${optionsList}
          </select>
        </div>
        <div class="csv-map-sample" id="csvMapSample_${f.key}">—</div>
      </div>
    `).join('')}
  </div>

  <div class="csv-preview-row-wrap">
    <div class="csv-preview-label">${gwIcon('eye',13,'#5B7FA6')} Preview (first record):</div>
    <div class="csv-preview-row" id="csvPreviewRow">—</div>
  </div>

  <div class="csv-footer">
    <button class="csv-btn-ghost" onclick="_csvBackToStep1()">← Back</button>
    <button class="csv-btn-primary" onclick="_csvGoStep3()">
      Preview Import ${gwIcon('arrow-right',13,'#fff')}
    </button>
  </div>
</div>`;

  // Apply auto-mapped values
  for (const [field, col] of Object.entries(_csvState.columnMap)) {
    const sel = document.getElementById(`csvMap_${field}`);
    if (sel) sel.value = col;
  }
  _csvUpdatePreviewRow();
}

window._csvUpdatePreviewRow = function() {
  const firstRow = _csvState.rawRows[0];
  if (!firstRow) return;

  // Update samples
  _csvTargetFields.forEach(f => {
    const sel = document.getElementById(`csvMap_${f.key}`);
    const sample = document.getElementById(`csvMapSample_${f.key}`);
    if (sel && sample) {
      const col = sel.value;
      sample.textContent = col && firstRow[col] ? firstRow[col] : '—';
      sample.className = 'csv-map-sample' + (col && firstRow[col] ? ' csv-map-sample-hit' : '');
    }
  });

  // Build preview
  const previewEl = document.getElementById('csvPreviewRow');
  if (!previewEl) return;
  const preview = _csvBuildRow(firstRow);
  previewEl.innerHTML = `<div class="csv-preview-chips">
    ${Object.entries(preview).filter(([k,v])=>v).map(([k,v])=>`<span class="csv-preview-chip"><span class="csv-pc-key">${k}</span><span class="csv-pc-val">${v}</span></span>`).join('')}
  </div>`;
};

function _csvBuildRow(rawRow) {
  const out = {};
  _csvTargetFields.forEach(f => {
    const sel = document.getElementById(`csvMap_${f.key}`);
    const col = sel?.value || _csvState.columnMap[f.key] || '';
    if (col && rawRow[col]) out[f.key] = rawRow[col];
  });
  // Merge phone+mobile
  if (!out.phone && out.mobile) { out.phone = out.mobile; }
  return out;
}

function _csvCollectColumnMap() {
  const map = {};
  _csvTargetFields.forEach(f => {
    const sel = document.getElementById(`csvMap_${f.key}`);
    if (sel?.value) map[f.key] = sel.value;
  });
  _csvState.columnMap = map;
}

window._csvBackToStep1 = function() {
  const body = document.getElementById('csvModalBody');
  if (body) body.innerHTML = _csvStep1HTML();
  // Re-show file info if we already have data
  if (_csvState.rawRows.length) {
    const dropZone = document.getElementById('csvDropZone');
    const fileInfo = document.getElementById('csvFileInfo');
    if (dropZone) dropZone.style.display = 'none';
    if (fileInfo) { fileInfo.style.display = 'flex'; }
    const nextBtn = document.getElementById('csvNextStep1');
    if (nextBtn) nextBtn.disabled = false;
  }
};

/* ── Step 3: Dedup Preview ──────────────────────────────────────────────────── */
async function _csvGoStep3() {
  _csvCollectColumnMap();

  // Validate: name mapping required
  if (!_csvState.columnMap.name) {
    showToast('Please map the "Name" column — it is required', 'error'); return;
  }

  // Build mapped rows from raw; drop rows whose "name" is clearly shredded
  // prose or leftover HTML rather than an actual client name.
  const _csvJunkName = (n) => {
    const s = String(n || '');
    if (!s.trim()) return true;
    if (/<[a-z!/]|&[a-z]+;|<\/p>|href=/i.test(s)) return true;
    if (s.trim().split(/\s+/).length > 12) return true;
    return false;
  };
  _csvState.mappedRows = _csvState.rawRows.map(raw => _csvBuildRow(raw)).filter(r => !_csvJunkName(r.name));

  const body = document.getElementById('csvModalBody');
  if (!body) return;
  body.innerHTML = `<div class="csv-step" id="csvStep3">
    <div class="csv-step-header">
      <div class="csv-step-num">3</div>
      <div>
        <div class="csv-step-title">Preview Import</div>
        <div class="csv-step-sub">Checking ${_csvState.mappedRows.length} records against existing clients…</div>
      </div>
    </div>
    <div class="csv-loading">${gwIcon('hourglass',24,'#9CA3AF')}<br>Running deduplication check…</div>
  </div>`;

  // Send to API for server-side dedup check
  try {
    const res = await fetch('/api/clients/import-preview', {
      method: 'POST', credentials: 'include',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ rows: _csvState.mappedRows.slice(0, 100) })
    });
    const data = res.ok ? await res.json() : { preview: _csvState.mappedRows.map(r=>({...r,_duplicate:false})), total: _csvState.mappedRows.length };
    _csvState.previewResult = data;
    _csvRenderPreview(data);
  } catch(e) {
    // Fallback: no dedup check, just show all as new
    const fallback = { preview: _csvState.mappedRows.slice(0,100).map(r=>({...r,_duplicate:false})), total: _csvState.mappedRows.length };
    _csvState.previewResult = fallback;
    _csvRenderPreview(fallback);
  }
}

function _csvRenderPreview(data) {
  const body = document.getElementById('csvModalBody');
  if (!body) return;
  const total = _csvState.mappedRows.length;
  const dupes = data.preview.filter(r => r._duplicate).length;
  const newCount = total - dupes;

  body.innerHTML = `
<div class="csv-step" id="csvStep3">
  <div class="csv-step-header">
    <div class="csv-step-num">3</div>
    <div>
      <div class="csv-step-title">Preview Import</div>
      <div class="csv-step-sub">${total} records · ${newCount} new · ${dupes} duplicates found</div>
    </div>
  </div>

  <div class="csv-summary-bar">
    <div class="csv-sum-card csv-sum-new">
      <div class="csv-sum-num">${newCount}</div>
      <div class="csv-sum-lbl">New clients</div>
    </div>
    <div class="csv-sum-card csv-sum-dupe">
      <div class="csv-sum-num">${dupes}</div>
      <div class="csv-sum-lbl">Duplicates</div>
    </div>
    <div class="csv-sum-card">
      <div class="csv-sum-num">${total}</div>
      <div class="csv-sum-lbl">Total</div>
    </div>
  </div>

  <div class="csv-dupe-option">
    <label class="csv-toggle-label">
      <input type="checkbox" id="csvSkipDupes" checked>
      Skip duplicates (recommended)
    </label>
    <div class="csv-dupe-hint">Matched on email address and/or client name</div>
  </div>

  <div class="csv-preview-table-wrap">
    <table class="csv-preview-table">
      <thead>
        <tr>
          <th></th>
          <th>Name</th>
          <th>Email</th>
          <th>Phone</th>
          <th>Address</th>
          <th>Status</th>
        </tr>
      </thead>
      <tbody>
        ${data.preview.slice(0,100).map(row => `
          <tr class="${row._duplicate ? 'csv-row-dupe' : 'csv-row-new'}">
            <td>${row._duplicate ? `<span class="csv-badge-dupe">${gwIcon('info',11)} Dupe</span>` : `<span class="csv-badge-new">${gwIcon('plus',11)} New</span>`}</td>
            <td class="csv-td-name">${row.name||'—'}</td>
            <td class="csv-td-sub">${row.email||'—'}</td>
            <td class="csv-td-sub">${row.phone||'—'}</td>
            <td class="csv-td-sub">${[row.address, row.city, row.state].filter(Boolean).join(', ')||'—'}</td>
            <td class="csv-td-sub">${row._duplicate ? `<span class="csv-dupe-reason">${row._matchReason||'Match found'}</span>` : '<span style="color:#2D7A55">Ready</span>'}</td>
          </tr>
        `).join('')}
        ${total > 100 ? `<tr><td colspan="6" style="text-align:center;padding:12px;color:#9CA3AF;font-size:12px">…and ${total-100} more records (all will be imported)</td></tr>` : ''}
      </tbody>
    </table>
  </div>

  <div class="csv-footer">
    <button class="csv-btn-ghost" onclick="_csvGoStep2()">← Back</button>
    <button class="csv-btn-primary" onclick="_csvRunImport()">
      ${gwIcon('upload',13,'#fff')} Import ${newCount} Client${newCount===1?'':'s'}
    </button>
  </div>
</div>`;
}

/* ── Step 4: Run Import ─────────────────────────────────────────────────────── */
window._csvRunImport = async function() {
  const skipDupes = document.getElementById('csvSkipDupes')?.checked !== false;
  const body = document.getElementById('csvModalBody');
  if (!body) return;

  body.innerHTML = `<div class="csv-step">
    <div class="csv-step-header">
      <div class="csv-step-num">4</div>
      <div>
        <div class="csv-step-title">Importing…</div>
        <div class="csv-step-sub">Please wait while we add your clients.</div>
      </div>
    </div>
    <div class="csv-progress-wrap">
      <div class="csv-progress-bar"><div class="csv-progress-fill" id="csvProgressFill" style="width:0%"></div></div>
      <div class="csv-progress-text" id="csvProgressText">Preparing…</div>
    </div>
  </div>`;

  // Merge preview dedup results into mappedRows
  const previewMap = {};
  (_csvState.previewResult?.preview || []).forEach(r => { previewMap[r.name] = r; });
  const rows = _csvState.mappedRows.map(r => ({
    ...r,
    _duplicate: previewMap[r.name]?._duplicate || false,
    _matchReason: previewMap[r.name]?._matchReason || ''
  }));

  try {
    // Send in batches of 100
    const batchSize = 100;
    let inserted = 0, skipped = 0, errors = [];
    const totalBatches = Math.ceil(rows.length / batchSize);

    for (let b = 0; b < totalBatches; b++) {
      const batch = rows.slice(b * batchSize, (b+1) * batchSize);
      const res = await fetch('/api/clients/import-bulk', {
        method: 'POST', credentials: 'include',
        headers: {'Content-Type':'application/json'},
        body: JSON.stringify({ rows: batch, skip_duplicates: skipDupes })
      });
      const data = res.ok ? await res.json() : { inserted: 0, skipped: batch.length, errors: ['Server error'] };
      inserted += data.inserted || 0;
      skipped  += data.skipped || 0;
      errors    = errors.concat(data.errors || []);

      const pct = Math.round((b+1) / totalBatches * 100);
      const fill = document.getElementById('csvProgressFill');
      const text = document.getElementById('csvProgressText');
      if (fill) fill.style.width = pct + '%';
      if (text) text.textContent = `Batch ${b+1}/${totalBatches} — ${inserted} imported…`;
    }

    _csvShowResult(inserted, skipped, errors, rows.length);
  } catch(e) {
    showToast('Import failed: ' + e.message, 'error');
  }
};

function _csvShowResult(inserted, skipped, errors, total) {
  const body = document.getElementById('csvModalBody');
  if (!body) return;
  body.innerHTML = `
<div class="csv-step">
  <div class="csv-step-header">
    <div class="csv-step-num csv-step-done">${gwIcon('check',16,'#fff')}</div>
    <div>
      <div class="csv-step-title">Import Complete</div>
      <div class="csv-step-sub">Finished processing ${total} records.</div>
    </div>
  </div>

  <div class="csv-result-cards">
    <div class="csv-result-card csv-result-success">
      <div class="csv-result-num">${inserted}</div>
      <div class="csv-result-lbl">${gwIcon('check',14,'#166534')} Imported</div>
    </div>
    <div class="csv-result-card csv-result-skip">
      <div class="csv-result-num">${skipped}</div>
      <div class="csv-result-lbl">${gwIcon('info',14,'#92400E')} Skipped</div>
    </div>
    ${errors.length ? `<div class="csv-result-card csv-result-error">
      <div class="csv-result-num">${errors.length}</div>
      <div class="csv-result-lbl">${gwIcon('alert',14,'#991B1B')} Errors</div>
    </div>` : ''}
  </div>

  ${errors.length ? `
    <div class="csv-error-list">
      <div class="csv-error-list-title">${gwIcon('alert',13,'#991B1B')} Errors:</div>
      ${errors.slice(0,10).map(e=>`<div class="csv-error-item">${e}</div>`).join('')}
      ${errors.length > 10 ? `<div class="csv-error-item">…and ${errors.length-10} more</div>` : ''}
    </div>
  ` : ''}

  <div class="csv-footer" style="justify-content:center">
    <button class="csv-btn-primary" onclick="document.getElementById('csv-import-overlay').remove(); if(typeof gwClients==='function') gwClients();">
      ${gwIcon('user',13,'#fff')} View Clients
    </button>
    <button class="csv-btn-ghost" onclick="document.getElementById('csv-import-overlay').remove()">Close</button>
  </div>
</div>`;

  if (inserted > 0) showToast(`Imported ${inserted} client${inserted===1?'':'s'} successfully`, 'success');
}

/* ── Helper: create overlay ──────────────────────────────────────────────────── */
function _csvCreateOverlay(id) {
  document.getElementById(id)?.remove();
  const overlay = document.createElement('div');
  overlay.id = id;
  overlay.className = 'csv-overlay';
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
  return overlay;
}

/* ── CSS Injection ───────────────────────────────────────────────────────────── */
(function _csvInjectCSS() {
  if (document.getElementById('csv-styles')) return;
  const style = document.createElement('style');
  style.id = 'csv-styles';
  style.textContent = `
.csv-overlay { position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:9995;display:flex;align-items:flex-start;justify-content:center;padding:40px 16px;overflow-y:auto; }
.csv-modal { background:#fff;border-radius:18px;width:100%;max-width:700px;box-shadow:0 24px 80px rgba(0,0,0,.3);overflow:hidden; }
.csv-modal-header { display:flex;align-items:center;justify-content:space-between;padding:20px 24px;border-bottom:1.5px solid #F3F4F6; }
.csv-modal-title { display:flex;align-items:center;gap:10px;font-size:16px;font-weight:800;color:#1C3A2B; }
.csv-modal-close { width:32px;height:32px;border:none;background:#F3F4F6;border-radius:8px;font-size:18px;cursor:pointer;color:#6B7280;display:flex;align-items:center;justify-content:center; }
.csv-modal-body { padding:24px;max-height:75vh;overflow-y:auto; }

.csv-step {}
.csv-step-header { display:flex;align-items:flex-start;gap:14px;margin-bottom:20px; }
.csv-step-num { width:32px;height:32px;border-radius:50%;background:#2D7A55;color:#fff;font-size:14px;font-weight:800;display:flex;align-items:center;justify-content:center;flex-shrink:0;margin-top:2px; }
.csv-step-done { background:#2D7A55 !important; }
.csv-step-title { font-size:16px;font-weight:800;color:#1C3A2B;margin-bottom:2px; }
.csv-step-sub { font-size:13px;color:#6B7280; }

.csv-drop-zone { border:2px dashed #D1D5DB;border-radius:14px;padding:40px 24px;text-align:center;cursor:pointer;transition:border-color .15s,background .15s; }
.csv-drop-zone:hover,.csv-drop-hover { border-color:#2D7A55;background:#F0FAF4; }
.csv-drop-icon { margin-bottom:12px;opacity:.5; }
.csv-drop-text { font-size:14px;font-weight:600;color:#374151;margin-bottom:4px; }
.csv-drop-sub { font-size:12px;color:#9CA3AF; }

.csv-file-info { display:flex;align-items:center;gap:12px;padding:14px 16px;background:#F0FAF4;border:1.5px solid #A7D7BC;border-radius:12px;margin-bottom:16px; }
.csv-file-name { font-size:14px;font-weight:700;color:#1C3A2B; }
.csv-file-meta { font-size:12px;color:#6B7280;margin-top:2px; }

.csv-sample-note { margin-top:16px;padding:14px;background:#F8FAFF;border:1.5px solid #E0E7FF;border-radius:10px; }
.csv-sample-title { display:flex;align-items:center;gap:6px;font-size:12px;font-weight:700;color:#374151;margin-bottom:8px; }
.csv-sample-chips { display:flex;flex-wrap:wrap;gap:6px; }
.csv-chip { padding:3px 10px;background:#EEF2FF;color:#4338CA;border-radius:10px;font-size:11px;font-weight:600; }

.csv-footer { display:flex;align-items:center;justify-content:space-between;margin-top:24px;padding-top:16px;border-top:1.5px solid #F3F4F6;gap:12px; }

.csv-btn-primary { display:inline-flex;align-items:center;gap:6px;padding:10px 18px;background:#2D7A55;color:#fff;border:none;border-radius:10px;font-size:13px;font-weight:700;cursor:pointer;font-family:inherit;transition:background .15s; }
.csv-btn-primary:hover { background:#256645; }
.csv-btn-primary:disabled { opacity:.5;cursor:default; }
.csv-btn-ghost { display:inline-flex;align-items:center;gap:6px;padding:10px 16px;background:transparent;color:#6B7280;border:1.5px solid #E5E7EB;border-radius:10px;font-size:13px;font-weight:600;cursor:pointer;font-family:inherit; }
.csv-btn-ghost:hover { border-color:#9CA3AF;color:#374151; }

/* Column map */
.csv-map-grid { display:flex;flex-direction:column;gap:6px;margin-bottom:16px; }
.csv-map-row { display:grid;grid-template-columns:180px 28px 1fr 140px;align-items:center;gap:8px; }
.csv-map-target { display:flex;align-items:center; }
.csv-map-label { font-size:12px;font-weight:600;color:#374151; }
.csv-required { color:#EF4444; }
.csv-map-arrow { display:flex;align-items:center;justify-content:center;color:#D1D5DB; }
.csv-map-select-wrap {}
.csv-select { width:100%;padding:7px 10px;border:1.5px solid #E5E7EB;border-radius:9px;font-size:12px;font-family:inherit;color:#111;background:#fff;outline:none; }
.csv-select:focus { border-color:#2D7A55; }
.csv-map-sample { font-size:11px;color:#9CA3AF;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:130px; }
.csv-map-sample-hit { color:#2D7A55;font-weight:600; }

.csv-preview-row-wrap { margin-top:12px;padding:12px;background:#F9FAFB;border-radius:10px; }
.csv-preview-label { font-size:11px;font-weight:700;color:#9CA3AF;text-transform:uppercase;letter-spacing:.06em;margin-bottom:8px;display:flex;align-items:center;gap:5px; }
.csv-preview-chips { display:flex;flex-wrap:wrap;gap:6px; }
.csv-preview-chip { display:flex;align-items:center;gap:4px;padding:4px 10px;background:#fff;border:1.5px solid #E5E7EB;border-radius:8px;font-size:11px; }
.csv-pc-key { color:#9CA3AF;font-weight:600; }
.csv-pc-val { color:#111;font-weight:700; }

/* Dedup preview */
.csv-summary-bar { display:flex;gap:12px;margin-bottom:16px; }
.csv-sum-card { flex:1;padding:14px;background:#F9FAFB;border:1.5px solid #E5E7EB;border-radius:12px;text-align:center; }
.csv-sum-num { font-size:24px;font-weight:800;color:#1C3A2B; }
.csv-sum-lbl { font-size:11px;color:#9CA3AF;font-weight:700;text-transform:uppercase;letter-spacing:.06em;margin-top:2px; }
.csv-sum-new .csv-sum-num { color:#2D7A55; }
.csv-sum-dupe .csv-sum-num { color:#D97706; }

.csv-dupe-option { margin-bottom:12px;padding:12px;background:#FFFBEB;border:1.5px solid #FDE68A;border-radius:10px; }
.csv-toggle-label { display:flex;align-items:center;gap:8px;font-size:13px;font-weight:600;color:#374151;cursor:pointer; }
.csv-dupe-hint { font-size:11px;color:#9CA3AF;margin-top:4px;margin-left:22px; }

.csv-preview-table-wrap { max-height:320px;overflow-y:auto;border:1.5px solid #E5E7EB;border-radius:10px; }
.csv-preview-table { width:100%;border-collapse:collapse; }
.csv-preview-table thead { position:sticky;top:0;background:#F9FAFB;z-index:1; }
.csv-preview-table th { padding:8px 12px;font-size:10px;font-weight:700;color:#9CA3AF;text-transform:uppercase;letter-spacing:.06em;text-align:left; }
.csv-preview-table td { padding:8px 12px;font-size:12px;color:#374151;border-top:1px solid #F3F4F6; }
.csv-td-name { font-weight:600;color:#111; }
.csv-td-sub { color:#6B7280; }
.csv-row-dupe { background:#FFFBEB; }
.csv-row-new { background:#fff; }
.csv-badge-new { display:inline-flex;align-items:center;gap:3px;padding:2px 8px;background:#DCFCE7;color:#166534;border-radius:10px;font-size:10px;font-weight:700; }
.csv-badge-dupe { display:inline-flex;align-items:center;gap:3px;padding:2px 8px;background:#FEF3C7;color:#92400E;border-radius:10px;font-size:10px;font-weight:700; }
.csv-dupe-reason { font-size:11px;color:#D97706;font-style:italic; }

/* Progress */
.csv-progress-wrap { margin:24px 0;text-align:center; }
.csv-progress-bar { height:8px;background:#E5E7EB;border-radius:4px;overflow:hidden;margin-bottom:12px; }
.csv-progress-fill { height:100%;background:#2D7A55;border-radius:4px;transition:width .3s; }
.csv-progress-text { font-size:13px;color:#6B7280; }

/* Result */
.csv-result-cards { display:flex;gap:12px;margin-bottom:16px; }
.csv-result-card { flex:1;padding:16px;border-radius:12px;text-align:center; }
.csv-result-success { background:#DCFCE7;border:1.5px solid #A7D7BC; }
.csv-result-skip { background:#FEF3C7;border:1.5px solid #FDE68A; }
.csv-result-error { background:#FEE2E2;border:1.5px solid #FCA5A5; }
.csv-result-num { font-size:28px;font-weight:800;color:#1C3A2B; }
.csv-result-lbl { font-size:12px;font-weight:700;color:#6B7280;margin-top:4px;display:flex;align-items:center;justify-content:center;gap:4px; }
.csv-error-list { background:#FEF2F2;border:1.5px solid #FCA5A5;border-radius:10px;padding:12px;margin-bottom:16px; }
.csv-error-list-title { display:flex;align-items:center;gap:6px;font-size:12px;font-weight:700;color:#991B1B;margin-bottom:8px; }
.csv-error-item { font-size:11px;color:#991B1B;padding:2px 0; }

.csv-loading { text-align:center;padding:40px;color:#9CA3AF;font-size:14px; }

@media(max-width:580px) {
  .csv-map-row { grid-template-columns:120px 20px 1fr;grid-template-rows:auto auto; }
  .csv-map-sample { display:none; }
}
`;
  document.head.appendChild(style);
})();

console.log('[Groundwork] csv_import.js loaded v20260711p47');
