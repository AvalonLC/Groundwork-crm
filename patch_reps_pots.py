#!/usr/bin/env python3
"""
Patch reps.js:
  1. Insert Paper on the Street section (Section 3B) before Section 4
  2. Inject JS render after viewEl.innerHTML closes at line 1254
"""

REPS_PATH = '/home/user/webapp/public/static/reps.js'

with open(REPS_PATH, 'r', encoding='utf-8') as f:
    reps = f.read()

# ─── PATCH A: Insert Section 3B HTML ───
# The anchor is: \n\n<!-- ── SECTION 4: PIPELINE HEALTH + COMMISSION QUEUE ── -->

SECTION4_MARKER = 'SECTION 4: PIPELINE HEALTH'
idx = reps.find(SECTION4_MARKER)
if idx == -1:
    print('ERROR: Cannot find SECTION 4 marker')
    import sys; sys.exit(1)

# Back up to start of that comment line (find the preceding \n)
line_start = reps.rfind('\n', 0, idx - 10)   # get to the \n before <!--
line_start2 = reps.rfind('\n', 0, line_start) # one more newline back (blank line)
print(f'Inserting before index {line_start2}, context: {repr(reps[line_start2:line_start2+60])}')

SECTION_3B_HTML = """

<!-- \u2500\u2500 SECTION 3B: PIPELINE BY DIVISION \u2500\u2500 -->
<div style="margin-bottom:24px">
  <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;flex-wrap:wrap;gap:8px">
    <div>
      <h2 style="margin:0;font-size:16px">Pipeline by Division</h2>
      <div style="font-size:11px;color:#64748b;margin-top:3px">
        <strong style="color:#a78bfa">Paper on the Street</strong>
        = active quoted\u202fpropd value currently in front of customers, not yet sold or lost
      </div>
    </div>
    <button onclick="show('manager')" style="padding:6px 14px;background:rgba(167,139,250,.12);border:1px solid rgba(124,58,237,.4);border-radius:8px;color:#a78bfa;font-size:11px;font-weight:700;cursor:pointer">
      Full Drill-Down \u2192
    </button>
  </div>
  <div id="dashDivPipeline" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px"></div>
</div>

"""

reps = reps[:line_start2] + SECTION_3B_HTML + reps[line_start2:]
print('PATCH A: Section 3B inserted before Section 4')


# ─── PATCH B: Inject render JS after viewEl.innerHTML closes ───
# The template closes at:  \n`;\n\n  window.viewRepPipeline
CLOSE_ANCHOR = '\n`;\n\n  window.viewRepPipeline'
if CLOSE_ANCHOR not in reps:
    # Try alternate
    CLOSE_ANCHOR = '\n`;\n\n  window.viewRepPipeline'
    idx2 = reps.find(CLOSE_ANCHOR)
    print(f'CLOSE_ANCHOR idx: {idx2}')
    if idx2 == -1:
        # Try: \n`;\n
        idx2 = reps.rfind('\n`;\n')
        print(f'Fallback close at: {idx2}, context: {repr(reps[idx2:idx2+60])}')

idx2 = reps.find(CLOSE_ANCHOR)
if idx2 == -1:
    # Use rfind for the last occurrence of the template close
    idx2 = reps.rfind('\n`;\n')
    print(f'Using rfind, idx2={idx2}, context: {repr(reps[idx2:idx2+80])}')

POTS_RENDER_JS = """

  // ── Populate Paper on the Street division cards ──────────────────────────
  setTimeout(function() {
    var wrap = document.getElementById('dashDivPipeline');
    if (!wrap) return;
    if (typeof buildDivisionPipeline !== 'function') {
      wrap.innerHTML = '<p style="color:#475569;font-size:12px;padding:12px">Division pipeline data will appear once leads are added.</p>';
      return;
    }
    var dp = buildDivisionPipeline();
    var KEYS = dp.keys;
    var divs = dp.divisions;
    function fm(n){ return n!=null?n.toLocaleString(undefined,{style:'currency',currency:'USD',maximumFractionDigits:0}):'\\u2014'; }
    function ageColor(d){ if(d==null)return'#475569'; if(d<=7)return'#4ade80'; if(d<=14)return'#fbbf24'; if(d<=30)return'#f97316'; return'#f87171'; }
    wrap.innerHTML = KEYS.map(function(k) {
      var d = divs[k];
      var potsColor = d.paperOnStreet > 0 ? '#a78bfa' : '#475569';
      var crStr = d.closeRatePct != null ? d.closeRatePct + '%' : '\\u2014';
      var avgAgeStr = d.avgEstimateAge != null ? d.avgEstimateAge + 'd' : '\\u2014';
      var oldestStr = d.oldestEstimateAge != null ? d.oldestEstimateAge + 'd' : '\\u2014';
      return '<div style="background:linear-gradient(135deg,#0d1e35,#0a1628);border:1px solid #1e3a5f;border-radius:14px;padding:18px">'
        + '<div style="font-size:13px;font-weight:800;color:' + d.color + ';margin-bottom:12px;text-transform:uppercase;letter-spacing:.06em">' + d.label + '</div>'
        + '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">'
          + '<div><div style="font-size:9px;color:#64748b;text-transform:uppercase;font-weight:600">Open Pipeline</div><div style="font-size:15px;font-weight:800;color:#e2e8f0">' + fm(d.openValue) + '</div></div>'
          + '<div><div style="font-size:9px;color:#a78bfa;text-transform:uppercase;font-weight:600" title="Active quoted/proposed value not yet sold or lost">Paper on Street</div><div style="font-size:15px;font-weight:800;color:' + potsColor + '">' + fm(d.paperOnStreet) + '</div></div>'
          + '<div><div style="font-size:9px;color:#64748b;text-transform:uppercase;font-weight:600">Weighted</div><div style="font-size:13px;font-weight:700;color:#94a3b8">' + fm(d.weightedPipeline) + '</div></div>'
          + '<div><div style="font-size:9px;color:#64748b;text-transform:uppercase;font-weight:600">Sold This Mo.</div><div style="font-size:13px;font-weight:700;color:#4ade80">' + fm(d.soldThisMonth) + '</div></div>'
          + '<div><div style="font-size:9px;color:#64748b;text-transform:uppercase;font-weight:600">Active Opps</div><div style="font-size:16px;font-weight:800;color:#e2e8f0">' + d.openCount + '</div></div>'
          + '<div><div style="font-size:9px;color:#64748b;text-transform:uppercase;font-weight:600">Open Ests</div><div style="font-size:16px;font-weight:800;color:#e2e8f0">' + d.openEstimateCount + '</div></div>'
          + '<div><div style="font-size:9px;color:#64748b;text-transform:uppercase;font-weight:600">Avg Est. Age</div><div style="font-size:13px;font-weight:700;color:' + ageColor(d.avgEstimateAge) + '">' + avgAgeStr + '</div></div>'
          + '<div><div style="font-size:9px;color:#64748b;text-transform:uppercase;font-weight:600">Oldest Est.</div><div style="font-size:13px;font-weight:700;color:' + ageColor(d.oldestEstimateAge) + '">' + oldestStr + '</div></div>'
          + '<div><div style="font-size:9px;color:#fbbf24;text-transform:uppercase;font-weight:600">7d Follow-Up Risk</div><div style="font-size:16px;font-weight:800;color:' + (d.sevenDayRisk>0?'#fbbf24':'#4ade80') + '">' + d.sevenDayRisk + '</div></div>'
          + '<div><div style="font-size:9px;color:#64748b;text-transform:uppercase;font-weight:600">Close Rate</div><div style="font-size:13px;font-weight:700;color:#00d4ff">' + crStr + '</div></div>'
        + '</div>'
      + '</div>';
    }).join('') + '<div style="background:linear-gradient(135deg,#0a1628,#071525);border:1px solid #334155;border-radius:14px;padding:18px">'
      + '<div style="font-size:13px;font-weight:800;color:#e2e8f0;margin-bottom:12px;text-transform:uppercase;letter-spacing:.06em">Total</div>'
      + '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">'
        + '<div><div style="font-size:9px;color:#64748b;text-transform:uppercase;font-weight:600">Open Pipeline</div><div style="font-size:15px;font-weight:800;color:#e2e8f0">' + fm(divs.total.openValue) + '</div></div>'
        + '<div><div style="font-size:9px;color:#a78bfa;text-transform:uppercase;font-weight:600">Paper on Street</div><div style="font-size:15px;font-weight:800;color:#a78bfa">' + fm(divs.total.paperOnStreet) + '</div></div>'
        + '<div><div style="font-size:9px;color:#64748b;text-transform:uppercase;font-weight:600">Weighted</div><div style="font-size:13px;font-weight:700;color:#94a3b8">' + fm(divs.total.weightedPipeline) + '</div></div>'
        + '<div><div style="font-size:9px;color:#64748b;text-transform:uppercase;font-weight:600">Sold This Mo.</div><div style="font-size:13px;font-weight:700;color:#4ade80">' + fm(divs.total.soldThisMonth) + '</div></div>'
        + '<div><div style="font-size:9px;color:#64748b;text-transform:uppercase;font-weight:600">Active Opps</div><div style="font-size:16px;font-weight:800;color:#e2e8f0">' + divs.total.openCount + '</div></div>'
        + '<div><div style="font-size:9px;color:#64748b;text-transform:uppercase;font-weight:600">Open Ests</div><div style="font-size:16px;font-weight:800;color:#e2e8f0">' + divs.total.openEstimateCount + '</div></div>'
        + '<div><div style="font-size:9px;color:#fbbf24;text-transform:uppercase;font-weight:600">7d Risk Total</div><div style="font-size:16px;font-weight:800;color:' + (divs.total.sevenDayRisk>0?'#fbbf24':'#4ade80') + '">' + divs.total.sevenDayRisk + '</div></div>'
        + '<div></div>'
      + '</div>'
    + '</div>';
  }, 100);
"""

# Insert right before the closing `; of viewEl.innerHTML
# We found the close is at `\n`;\n`
# Insert POTS_RENDER_JS just AFTER the `; and before the next function

insert_after = '\n`;'
# Find the LAST occurrence (the owner dashboard close)
last_close = reps.rfind(insert_after)
print(f'Last template close at: {last_close}')
print(f'Context: {repr(reps[last_close:last_close+80])}')

# Verify this is the admin dashboard (should be followed by window.viewRepPipeline)
context_after = reps[last_close:last_close+120]
if 'viewRepPipeline' not in context_after:
    # It might be a different template close — find the one before window.viewRepPipeline
    vrp_idx = reps.find('window.viewRepPipeline')
    print(f'window.viewRepPipeline at: {vrp_idx}')
    # Find the `; just before it
    last_close = reps.rfind('\n`;', 0, vrp_idx)
    print(f'Admin dashboard close: {last_close}, context: {repr(reps[last_close:last_close+80])}')

# Insert after the `; (i.e., after the 2 chars `\n`;`)
insert_point = last_close + len('\n`;')
reps = reps[:insert_point] + '\n' + POTS_RENDER_JS + reps[insert_point:]
print('PATCH B: Paper on the Street render JS injected into admin dashboard')

with open(REPS_PATH, 'w', encoding='utf-8') as f:
    f.write(reps)
print(f'reps.js written ({len(reps)} chars)')
print('Done.')
