#!/usr/bin/env python3
"""
Avalon Icon System — complete implementation
Design philosophy:
  - Inline SVG, 16–20px, always crisp
  - Geometric + real-world meaning (universally readable)
  - Brand palette: blue (#00a7e1), green (#4ade80), amber (#f59e0b), red (#f87171), purple (#a78bfa)
  - No emojis, no FontAwesome, no external deps — pure SVG authored in-house

Icon inventory:
  CATEGORIES (9):
    landscape   → leaf/plant silhouette
    maintenance → wrench/gear
    hardscape   → brick/block pattern
    drainage    → water drop + channel
    design_build → ruler + pencil cross
    irrigation  → water spray arc
    lighting    → light bulb
    snow        → snowflake
    other       → circle + dots

  TIMELINE DOTS (5):
    note    → speech bubble
    stage   → arrow-right chevron
    sold    → checkmark in circle
    created → star/spark
    admin   → key

  EXEC TAKEAWAY BADGES (5):
    +  (positive revenue)   → upward arrow in green badge
    −  (behind budget)      → downward arrow in red badge
    !  (overdue/warning)    → exclamation in amber badge
    $  (commission queue)   → dollar sign in amber badge
    ·  (unassigned/neutral) → info dot in slate badge

  SUGGESTED ACTIONS (4):
    stale       → clock
    proposals   → document/envelope
    noNextStep  → calendar with gap
    unassigned  → person with question mark

  DIVISIONS (3):
    landscape   → leaf
    maintenance → wrench
    snow        → snowflake

  COMMISSION PREVIEW:
    $ icon → a clean coin/dollar circle

All SVGs use currentColor by default with explicit fills where color matters.
"""
import sys

# ────────────────────────────────────────────────────────────────────────────
# SVG ICON LIBRARY
# Each returns a small inline SVG string
# ────────────────────────────────────────────────────────────────────────────

# ── Category tile icons (20×20, semantic fill color) ──
CAT_ICONS = {
    # Leaf silhouette — landscape
    'landscape': '<svg width="20" height="20" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M10 17V10M10 10C10 10 5 10 3 5c3.5 0 7 2 7 5zm0 0c0 0 5 0 7-5-3.5 0-7 2-7 5z" stroke="#4ade80" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/><path d="M10 17c-2 0-3.5-.5-4-1" stroke="#4ade80" stroke-width="1.4" stroke-linecap="round" opacity=".5"/></svg>',
    # Brick grid — hardscape
    'hardscape': '<svg width="20" height="20" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="3" y="4" width="6" height="3" rx=".5" stroke="#f59e0b" stroke-width="1.4"/><rect x="11" y="4" width="6" height="3" rx=".5" stroke="#f59e0b" stroke-width="1.4"/><rect x="6.5" y="9" width="7" height="3" rx=".5" stroke="#f59e0b" stroke-width="1.4"/><rect x="3" y="14" width="4" height="3" rx=".5" stroke="#f59e0b" stroke-width="1.4" opacity=".7"/><rect x="9" y="14" width="5" height="3" rx=".5" stroke="#f59e0b" stroke-width="1.4" opacity=".7"/></svg>',
    # Water drop with channel line — drainage
    'drainage': '<svg width="20" height="20" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M10 3L13 8a3.5 3.5 0 11-6 0L10 3z" stroke="#60a5fa" stroke-width="1.5" stroke-linejoin="round"/><path d="M4 16h12" stroke="#60a5fa" stroke-width="1.5" stroke-linecap="round"/><path d="M7 16l1.5-3M13 16l-1.5-3" stroke="#60a5fa" stroke-width="1.3" stroke-linecap="round" opacity=".6"/></svg>',
    # Ruler + pencil cross — design/build
    'design_build': '<svg width="20" height="20" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M4 16L15 5" stroke="#a78bfa" stroke-width="1.5" stroke-linecap="round"/><path d="M13 3l4 4-2 2-4-4 2-2z" stroke="#a78bfa" stroke-width="1.3" stroke-linejoin="round"/><path d="M4 16l-1 1 1-1zm0 0l2-1-1 1z" stroke="#a78bfa" stroke-width="1.3" stroke-linecap="round"/><rect x="3" y="12" width="8" height="2.5" rx=".5" transform="rotate(-45 3 12)" stroke="#a78bfa" stroke-width="1.3" opacity=".5"/></svg>',
    # Water arc spray — irrigation
    'irrigation': '<svg width="20" height="20" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M5 15 Q8 8 14 6" stroke="#60a5fa" stroke-width="1.5" stroke-linecap="round"/><circle cx="14" cy="6" r="1.3" fill="#60a5fa"/><path d="M10 4 Q12 3 14 4" stroke="#60a5fa" stroke-width="1.3" stroke-linecap="round" opacity=".6"/><path d="M12 7 Q15 5 17 6" stroke="#60a5fa" stroke-width="1.3" stroke-linecap="round" opacity=".6"/><path d="M11 10 Q14 9 16 10" stroke="#60a5fa" stroke-width="1.3" stroke-linecap="round" opacity=".4"/><path d="M3 16 Q4 14 5 15" stroke="#60a5fa" stroke-width="1.4" stroke-linecap="round"/></svg>',
    # Light bulb — outdoor lighting
    'lighting': '<svg width="20" height="20" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M10 3a5 5 0 014 8l-1 1v1H7v-1L6 11a5 5 0 014-8z" stroke="#fbbf24" stroke-width="1.5" stroke-linejoin="round"/><path d="M8 16h4" stroke="#fbbf24" stroke-width="1.4" stroke-linecap="round"/><path d="M8.5 16.5 Q10 18 11.5 16.5" stroke="#fbbf24" stroke-width="1.3" stroke-linecap="round"/><circle cx="3" cy="5" r="1" fill="#fbbf24" opacity=".4"/><circle cx="17" cy="5" r="1" fill="#fbbf24" opacity=".4"/><circle cx="10" cy="1.5" r="1" fill="#fbbf24" opacity=".4"/></svg>',
    # Snowflake — snow & ice
    'snow': '<svg width="20" height="20" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M10 3v14M3 10h14M5.5 5.5l9 9M14.5 5.5l-9 9" stroke="#93c5fd" stroke-width="1.5" stroke-linecap="round"/><circle cx="10" cy="3" r="1.2" fill="#93c5fd"/><circle cx="10" cy="17" r="1.2" fill="#93c5fd"/><circle cx="3" cy="10" r="1.2" fill="#93c5fd"/><circle cx="17" cy="10" r="1.2" fill="#93c5fd"/></svg>',
    # Wrench — maintenance
    'maintenance': '<svg width="20" height="20" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M14 4a3.5 3.5 0 00-3 5.2L4.6 15.6a1 1 0 001.4 1.4l6.4-6.4A3.5 3.5 0 0016 7.5a3.5 3.5 0 00-.5-1.8l-2 2-1.5-1.5 2-2A3.5 3.5 0 0014 4z" stroke="#22d3ee" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    # Three dots in circle — other
    'other': '<svg width="20" height="20" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="10" cy="10" r="7" stroke="#64748b" stroke-width="1.4"/><circle cx="7" cy="10" r="1.2" fill="#64748b"/><circle cx="10" cy="10" r="1.2" fill="#64748b"/><circle cx="13" cy="10" r="1.2" fill="#64748b"/></svg>',
}

# ── Timeline dot icons (16×16, stroke-based) ──
# Rendered inside the .timeline-dot circle
TIMELINE_ICONS = {
    # Speech bubble — note/call log
    'note': '<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M2 2.5A.5.5 0 012.5 2h9a.5.5 0 01.5.5v6a.5.5 0 01-.5.5H8L5.5 12V9H2.5A.5.5 0 012 8.5v-6z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>',
    # Right-pointing chevron — stage advance
    'stage': '<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M5 3l4 4-4 4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    # Checkmark in circle — sold/won
    'sold': '<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><circle cx="7" cy="7" r="5" stroke="currentColor" stroke-width="1.3"/><path d="M4.5 7l2 2 3-3.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    # Four-point star/spark — created
    'created': '<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M7 1v2M7 11v2M1 7h2M11 7h2" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><path d="M3 3l1.4 1.4M9.6 9.6L11 11M11 3l-1.4 1.4M4.4 9.6L3 11" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" opacity=".6"/></svg>',
    # Key — admin action
    'admin': '<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><circle cx="5" cy="6" r="2.5" stroke="currentColor" stroke-width="1.3"/><path d="M7 7.5l5 3.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><path d="M10.5 9.5v1.5M9 10.5h2.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>',
}

# ── Exec takeaway badge icons — rendered as a small colored shape ──
# These replace the raw + − ! $ · characters with styled SVG badges
def takeaway_badge(icon_type):
    """Returns an HTML span with an SVG icon badge for the takeaway type."""
    configs = {
        '+': {
            'bg': 'rgba(74,222,128,.18)', 'border': 'rgba(74,222,128,.4)', 'color': '#4ade80',
            'svg': '<svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M6 2v8M2 6h8" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
            'title': 'Positive'
        },
        '-': {
            'bg': 'rgba(248,113,113,.18)', 'border': 'rgba(248,113,113,.4)', 'color': '#f87171',
            'svg': '<svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M6 9V3M6 9l-2.5-3M6 9l2.5-3" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
            'title': 'Behind target'
        },
        '!': {
            'bg': 'rgba(251,191,36,.18)', 'border': 'rgba(251,191,36,.4)', 'color': '#fbbf24',
            'svg': '<svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M6 2v5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><circle cx="6" cy="9.5" r="1" fill="currentColor"/></svg>',
            'title': 'Action needed'
        },
        '$': {
            'bg': 'rgba(251,191,36,.18)', 'border': 'rgba(251,191,36,.4)', 'color': '#fbbf24',
            'svg': '<svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M6 1.5v9M4 8c0 1 .9 1.5 2 1.5S8 9 8 8s-1-1.5-2-1.5S4 5 4 4s.9-1.5 2-1.5S8 3 8 4" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>',
            'title': 'Commission'
        },
        '·': {
            'bg': 'rgba(100,116,139,.18)', 'border': 'rgba(100,116,139,.4)', 'color': '#94a3b8',
            'svg': '<svg width="12" height="12" viewBox="0 0 12 12" fill="none"><circle cx="6" cy="6" r="1.5" fill="currentColor"/><path d="M6 2.5v2M6 7.5v2M2.5 6h2M7.5 6h2" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" opacity=".5"/></svg>',
            'title': 'Note'
        },
        '\u23f1': {  # ⏱ stale clock
            'bg': 'rgba(251,191,36,.18)', 'border': 'rgba(251,191,36,.4)', 'color': '#fbbf24',
            'svg': '<svg width="12" height="12" viewBox="0 0 12 12" fill="none"><circle cx="6" cy="6.5" r="4" stroke="currentColor" stroke-width="1.4"/><path d="M6 4v3l1.5 1.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/><path d="M4 1h4" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" opacity=".5"/></svg>',
            'title': 'Stale'
        },
    }
    c = configs.get(icon_type, configs['·'])
    return (
        f'<span style="display:inline-flex;align-items:center;justify-content:center;'
        f'width:22px;height:22px;border-radius:6px;background:{c["bg"]};'
        f'border:1px solid {c["border"]};color:{c["color"]};flex-shrink:0" '
        f'title="{c["title"]}">{c["svg"]}</span>'
    )

# ── Suggested action icons (18×18) ──
SUGGESTED_ICONS = {
    '\u23f1': '<svg width="18" height="18" viewBox="0 0 18 18" fill="none"><circle cx="9" cy="10" r="6" stroke="#fbbf24" stroke-width="1.5"/><path d="M9 7v4l2 1.5" stroke="#fbbf24" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/><path d="M6 2h6" stroke="#fbbf24" stroke-width="1.3" stroke-linecap="round" opacity=".5"/></svg>',
    '': '<svg width="18" height="18" viewBox="0 0 18 18" fill="none"><rect x="2" y="4" width="14" height="11" rx="1.5" stroke="#60a5fa" stroke-width="1.5"/><path d="M2 8h14" stroke="#60a5fa" stroke-width="1.3" opacity=".5"/><path d="M6 2v4M12 2v4" stroke="#60a5fa" stroke-width="1.4" stroke-linecap="round" opacity=".6"/><circle cx="13" cy="13" r="2.5" fill="#f87171" stroke="#0f172a" stroke-width="1"/><path d="M13 11.5v1.5M13 14h.01" stroke="#fff" stroke-width="1.2" stroke-linecap="round"/></svg>',  # proposal pending
    'cal_missing': '<svg width="18" height="18" viewBox="0 0 18 18" fill="none"><rect x="2" y="4" width="14" height="11" rx="1.5" stroke="#f59e0b" stroke-width="1.5"/><path d="M2 8h14" stroke="#f59e0b" stroke-width="1.3" opacity=".5"/><path d="M6 2v4M12 2v4" stroke="#f59e0b" stroke-width="1.4" stroke-linecap="round" opacity=".6"/><path d="M7 12h4M9 10v4" stroke="#f59e0b" stroke-width="1.4" stroke-linecap="round" opacity=".7"/></svg>',  # no next step
    'unassigned': '<svg width="18" height="18" viewBox="0 0 18 18" fill="none"><circle cx="9" cy="7" r="3" stroke="#94a3b8" stroke-width="1.5"/><path d="M3 16c0-3 2.7-5 6-5s6 2 6 5" stroke="#94a3b8" stroke-width="1.5" stroke-linecap="round"/><path d="M14 4v4M12 6h4" stroke="#f59e0b" stroke-width="1.4" stroke-linecap="round"/></svg>',  # unassigned (person + plus)
}

# ── Division icons (20×20) ──
DIV_ICONS_SVG = {
    'landscape':   '<svg width="18" height="18" viewBox="0 0 18 18" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M9 15V9.5M9 9.5C9 9.5 5 9.5 3 5c3 0 6 2 6 4.5zm0 0c0 0 4 0 6-4.5-3 0-6 2-6 4.5z" stroke="#4ade80" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    'maintenance': '<svg width="18" height="18" viewBox="0 0 18 18" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M12.5 3a3 3 0 00-2.5 4.5L3.8 13.8a.8.8 0 001.2 1.2l6.5-5.7A3 3 0 0014 10a3 3 0 00-.5-1.5l-1.8 1.8-1.2-1.2 1.8-1.8A3 3 0 0012.5 3z" stroke="#22d3ee" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    'snow':        '<svg width="18" height="18" viewBox="0 0 18 18" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M9 2.5v13M2.5 9h13M4.5 4.5l9 9M13.5 4.5l-9 9" stroke="#93c5fd" stroke-width="1.5" stroke-linecap="round"/><circle cx="9" cy="2.5" r="1" fill="#93c5fd"/><circle cx="9" cy="15.5" r="1" fill="#93c5fd"/><circle cx="2.5" cy="9" r="1" fill="#93c5fd"/><circle cx="15.5" cy="9" r="1" fill="#93c5fd"/></svg>',
}

# ────────────────────────────────────────────────────────────────────────────
# APPLY PATCHES
# ────────────────────────────────────────────────────────────────────────────

APP_PATH  = '/home/user/webapp/public/static/app_premium.js'
REPS_PATH = '/home/user/webapp/public/static/reps.js'
CSS_PATH  = '/home/user/webapp/public/static/premium.css'

with open(APP_PATH, 'r') as f: app = f.read()
with open(REPS_PATH, 'r') as f: reps = f.read()
with open(CSS_PATH, 'r') as f: css = f.read()


# ═══════════════════════════════════════════════════════════════════════════
# PATCH A: Category tile icons — app_premium.js lines ~709-717
# ═══════════════════════════════════════════════════════════════════════════
# Each _cats entry: {v:'...', icon:'', short:'...'}
# Replace icon:'' with actual SVG for each

cat_replacements = [
    ("    {v:'Landscape / Enhancement', icon:'', short:'Landscape'},",
     "    {v:'Landscape / Enhancement', icon:'" + CAT_ICONS['landscape'] + "', short:'Landscape'},"),
    ("    {v:'Maintenance - Recurring',  icon:'', short:'Recurring Maint.'},",
     "    {v:'Maintenance - Recurring',  icon:'" + CAT_ICONS['maintenance'] + "', short:'Recurring Maint.'},"),
    ("    {v:'Maintenance - One Time',   icon:'', short:'One-Time Maint.'},",
     "    {v:'Maintenance - One Time',   icon:'" + CAT_ICONS['maintenance'] + "', short:'One-Time Maint.'},"),
    ("    {v:'Hardscape',                icon:'', short:'Hardscape'},",
     "    {v:'Hardscape',                icon:'" + CAT_ICONS['hardscape'] + "', short:'Hardscape'},"),
    ("    {v:'Drainage',                 icon:'', short:'Drainage'},",
     "    {v:'Drainage',                 icon:'" + CAT_ICONS['drainage'] + "', short:'Drainage'},"),
    ("    {v:'Design / Build',           icon:'', short:'Design / Build'},",
     "    {v:'Design / Build',           icon:'" + CAT_ICONS['design_build'] + "', short:'Design / Build'},"),
    ("    {v:'Irrigation',               icon:'', short:'Irrigation'},",
     "    {v:'Irrigation',               icon:'" + CAT_ICONS['irrigation'] + "', short:'Irrigation'},"),
    ("    {v:'Outdoor Lighting',         icon:'', short:'Lighting'},",
     "    {v:'Outdoor Lighting',         icon:'" + CAT_ICONS['lighting'] + "', short:'Lighting'},"),
    ("    {v:'Other',                    icon:'', short:'Other'},",
     "    {v:'Other',                    icon:'" + CAT_ICONS['other'] + "', short:'Other'},"),
]

for old, new in cat_replacements:
    if old in app:
        app = app.replace(old, new, 1)
        print(f'Category icon set: {old[:40].strip()}...')
    else:
        print(f'WARN: cat icon anchor not found: {old[:50]}')

print('PATCH A: Category icons done')


# ═══════════════════════════════════════════════════════════════════════════
# PATCH B: Timeline dot icons — app_premium.js ~line 1324
# ═══════════════════════════════════════════════════════════════════════════
OLD_B = "  const dotIcon  = { note:'·', stage:'·', sold:'·', created:'·', admin:'·' };"
NEW_B = (
    "  const dotIcon  = { "
    "note:'" + TIMELINE_ICONS['note'] + "', "
    "stage:'" + TIMELINE_ICONS['stage'] + "', "
    "sold:'" + TIMELINE_ICONS['sold'] + "', "
    "created:'" + TIMELINE_ICONS['created'] + "', "
    "admin:'" + TIMELINE_ICONS['admin'] + "' };"
)
if OLD_B in app:
    app = app.replace(OLD_B, NEW_B, 1)
    print('PATCH B: Timeline dot icons set')
else:
    print('WARN: timeline dot anchor not found')


# ═══════════════════════════════════════════════════════════════════════════
# PATCH C: Suggested action icons — app_premium.js ~lines 207-210
# ═══════════════════════════════════════════════════════════════════════════

# Stale (clock icon ⏱)
OLD_C1 = "suggestions.push({icon:'\u23f1',"
NEW_C1 = "suggestions.push({icon:'" + SUGGESTED_ICONS['\u23f1'] + "',"
if OLD_C1 in app:
    app = app.replace(OLD_C1, NEW_C1, 1)
    print('PATCH C1: Stale icon set')
else:
    print('WARN: stale icon anchor not found, trying alternate...')
    # Try raw character
    for ch in ['\u23f1', '⏱']:
        test = f"suggestions.push({{icon:'{ch}',"
        if test in app:
            app = app.replace(test, NEW_C1, 1)
            print(f'PATCH C1: Stale icon set (alt match: {repr(ch)})')
            break

# Proposals pending (document with alert)
OLD_C2 = "suggestions.push({icon:'',"
if OLD_C2 in app:
    # First empty icon = proposals
    NEW_C2 = "suggestions.push({icon:'" + SUGGESTED_ICONS[''] + "',"
    app = app.replace(OLD_C2, NEW_C2, 1)
    print('PATCH C2: Proposals icon set')
else:
    print('WARN: proposals icon anchor not found')

# No next step (calendar with gap) — second empty icon
# After replacing proposals, the next '' is no next step
OLD_C3 = "suggestions.push({icon:'',"
if OLD_C3 in app:
    NEW_C3 = "suggestions.push({icon:'" + SUGGESTED_ICONS['cal_missing'] + "',"
    app = app.replace(OLD_C3, NEW_C3, 1)
    print('PATCH C3: No next step icon set')
else:
    print('WARN: no-next-step icon anchor not found')

# Unassigned (person + plus) — third empty icon
OLD_C4 = "suggestions.push({icon:'',"
if OLD_C4 in app:
    NEW_C4 = "suggestions.push({icon:'" + SUGGESTED_ICONS['unassigned'] + "',"
    app = app.replace(OLD_C4, NEW_C4, 1)
    print('PATCH C4: Unassigned icon set')
else:
    print('WARN: unassigned icon anchor not found')

print('PATCH C: Suggested action icons done')


# ═══════════════════════════════════════════════════════════════════════════
# PATCH D: Division icons in app_premium.js (3 locations)
# ═══════════════════════════════════════════════════════════════════════════

# Location 1: Revenue admin section ~line 2822
OLD_D1a = "    { key:'landscape',   label:'Landscape',   icon:'', color:'#4ade80' },"
NEW_D1a = "    { key:'landscape',   label:'Landscape',   icon:'" + DIV_ICONS_SVG['landscape'] + "', color:'#4ade80' },"
OLD_D1b = "    { key:'maintenance', label:'Maintenance',  icon:'', color:'#22d3ee' },"
NEW_D1b = "    { key:'maintenance', label:'Maintenance',  icon:'" + DIV_ICONS_SVG['maintenance'] + "', color:'#22d3ee' },"
OLD_D1c = "    { key:'snow',        label:'Snow & Ice',   icon:'', color:'#a78bfa' }"
NEW_D1c = "    { key:'snow',        label:'Snow & Ice',   icon:'" + DIV_ICONS_SVG['snow'] + "', color:'#a78bfa' }"

for old, new in [(OLD_D1a, NEW_D1a), (OLD_D1b, NEW_D1b), (OLD_D1c, NEW_D1c)]:
    if old in app:
        app = app.replace(old, new, 1)
        print(f'DIV icon set (loc1): {old[:40].strip()}')
    else:
        print(f'WARN: div icon loc1 not found: {repr(old[:50])}')

# Location 2: Rep dashboard ~line 3007
OLD_D2a = "    { key: 'landscape',   label: 'Landscape',    icon: '', color: '#4ade80' },"
NEW_D2a = "    { key: 'landscape',   label: 'Landscape',    icon: '" + DIV_ICONS_SVG['landscape'] + "', color: '#4ade80' },"
OLD_D2b = "    { key: 'maintenance', label: 'Maintenance',   icon: '', color: '#22d3ee' },"
NEW_D2b = "    { key: 'maintenance', label: 'Maintenance',   icon: '" + DIV_ICONS_SVG['maintenance'] + "', color: '#22d3ee' },"
OLD_D2c = "    { key: 'snow',        label: 'Snow & Ice',    icon: '', color: '#a78bfa' }"
NEW_D2c = "    { key: 'snow',        label: 'Snow & Ice',    icon: '" + DIV_ICONS_SVG['snow'] + "', color: '#a78bfa' }"

for old, new in [(OLD_D2a, NEW_D2a), (OLD_D2b, NEW_D2b), (OLD_D2c, NEW_D2c)]:
    if old in app:
        app = app.replace(old, new, 1)
        print(f'DIV icon set (loc2): {old[:40].strip()}')
    else:
        print(f'WARN: div icon loc2 not found: {repr(old[:50])}')

print('PATCH D: Division icons done')


# ═══════════════════════════════════════════════════════════════════════════
# PATCH E: Commission preview icon in lead form — app_premium.js ~line 809
# ═══════════════════════════════════════════════════════════════════════════
OLD_E = "            + '<span class=\"lf-comm-icon\">$</span>'"
NEW_E = "            + '<span class=\"lf-comm-icon\"><svg width=\"16\" height=\"16\" viewBox=\"0 0 16 16\" fill=\"none\"><circle cx=\"8\" cy=\"8\" r=\"6.5\" stroke=\"#4ade80\" stroke-width=\"1.3\"/><path d=\"M8 3v10M6 11c0 1 .9 1.5 2 1.5S10 12 10 11s-1-1.5-2-1.5S6 8 6 7s.9-1.5 2-1.5S10 5 10 6\" stroke=\"#4ade80\" stroke-width=\"1.2\" stroke-linecap=\"round\"/></svg></span>'"
if OLD_E in app:
    app = app.replace(OLD_E, NEW_E, 1)
    print('PATCH E: Commission preview icon updated')
else:
    print('WARN: commission preview icon anchor not found')


# Write app_premium.js
with open(APP_PATH, 'w') as f:
    f.write(app)
print(f'\napp_premium.js written ({len(app)} chars)')


# ═══════════════════════════════════════════════════════════════════════════
# PATCH F: reps.js — exec takeaway badges + division icons
# ═══════════════════════════════════════════════════════════════════════════

# F1: Takeaway badge icons (lines ~945-971)
# Replace icon:'+' → styled badge, icon:'−' → styled badge, etc.

takeaway_icon_map = [
    ("{ icon:'+',", "{ icon:`" + takeaway_badge('+') + "`,"),
    ("{ icon:'\u2212',", "{ icon:`" + takeaway_badge('-') + "`,"),  # − (minus sign)
    ("{ icon:'-',", "{ icon:`" + takeaway_badge('-') + "`,"),       # fallback plain hyphen
    ("{ icon:'!',", "{ icon:`" + takeaway_badge('!') + "`,"),
    ("{ icon:'$',", "{ icon:`" + takeaway_badge('$') + "`,"),
    ("{ icon:'\u00b7',", "{ icon:`" + takeaway_badge('·') + "`,"),  # ·  neutral
]

for old, new in takeaway_icon_map:
    count = reps.count(old)
    if count > 0:
        reps = reps.replace(old, new)
        print(f'PATCH F1: Replaced {count}x takeaway icon: {repr(old[:30])}')
    else:
        print(f'WARN: takeaway icon not found: {repr(old)}')

# F2: Stale icon ⏱ in reps.js takeaways
OLD_F2 = "{ icon:'\u23f1',"
NEW_F2 = "{ icon:`" + takeaway_badge('\u23f1') + "`,"
if OLD_F2 in reps:
    reps = reps.replace(OLD_F2, NEW_F2)
    print(f'PATCH F2: Stale clock icon set in reps.js')
else:
    # Try the raw ⏱ character
    for ch in ['\u23f1', '⏱']:
        test = "{" + f" icon:'{ch}',"
        if test in reps:
            reps = reps.replace(test, NEW_F2)
            print(f'PATCH F2: Stale icon set (alt: {repr(ch)})')
            break
    else:
        print('WARN: stale icon not found in reps.js')

# F3: Division icons in reps.js divTile + revenue grids
# The reps.js has its own div icon config ~line 893 area

for old_icon, new_svg in [
    ("{ key:'landscape',   label:'Landscape',", None),  # check
]:
    idx = reps.find("{ key:'landscape',   label:'Landscape',")
    if idx > -1:
        print(f'  reps.js landscape div config at: {idx}')

# Find and update all reps.js division icon configs
reps_div_replacements = [
    ("{ key:'landscape',   label:'Landscape',   icon:'',", 
     "{ key:'landscape',   label:'Landscape',   icon:'" + DIV_ICONS_SVG['landscape'] + "',"),
    ("{ key:'maintenance', label:'Maintenance',  icon:'',",
     "{ key:'maintenance', label:'Maintenance',  icon:'" + DIV_ICONS_SVG['maintenance'] + "',"),
    ("{ key:'snow',        label:'Snow & Ice',   icon:'',",
     "{ key:'snow',        label:'Snow & Ice',   icon:'" + DIV_ICONS_SVG['snow'] + "',"),
    # Alternate spacing patterns
    ("{ key:'landscape',   label: 'Landscape',   icon: '',",
     "{ key:'landscape',   label: 'Landscape',   icon: '" + DIV_ICONS_SVG['landscape'] + "',"),
    ("{ key:'maintenance', label: 'Maintenance',  icon: '',",
     "{ key:'maintenance', label: 'Maintenance',  icon: '" + DIV_ICONS_SVG['maintenance'] + "',"),
    ("{ key:'snow',        label: 'Snow & Ice',   icon: '',",
     "{ key:'snow',        label: 'Snow & Ice',   icon: '" + DIV_ICONS_SVG['snow'] + "',"),
]

for old, new in reps_div_replacements:
    if old in reps:
        reps = reps.replace(old, new)
        print(f'PATCH F3: reps.js div icon: {old[:50].strip()}')

# Also check for the manager divTile section in reps.js (they may use different format)
idx_lt = reps.find("'landscape'")
print(f'reps.js landscape key at: {idx_lt}, context: {repr(reps[idx_lt:idx_lt+80])}')

# Write reps.js
with open(REPS_PATH, 'w') as f:
    f.write(reps)
print(f'\nreps.js written ({len(reps)} chars)')


# ═══════════════════════════════════════════════════════════════════════════
# PATCH G: premium.css — update timeline dot to show SVG icons properly
# and add .av-icon utility class for inline SVG icons
# ═══════════════════════════════════════════════════════════════════════════

ICON_CSS = """
/* ── Avalon Internal Icon System ─────────────────────────────────────────── */
/* Timeline dot SVG icons — override the plain font-size approach */
.timeline-dot {
  /* Override: make the inner span render SVG correctly */
  overflow: visible;
}
.timeline-dot span {
  display: flex;
  align-items: center;
  justify-content: center;
  line-height: 1;
}
.timeline-dot.note    span { color: var(--blue); }
.timeline-dot.stage   span { color: #a855f7; }
.timeline-dot.sold    span { color: #16a34a; }
.timeline-dot.created span { color: #f59e0b; }
.timeline-dot.admin   span { color: #64748b; }

/* Category tile icon container */
.cat-tile-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  border-radius: 10px;
  background: rgba(255,255,255,.06);
  margin-bottom: 2px;
}
.cat-tile--active .cat-tile-icon {
  background: rgba(0,167,225,.12);
}

/* Suggested action icon container */
.sa-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border-radius: 8px;
  flex-shrink: 0;
}

/* Exec takeaway icon badge */
.takeaway-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border-radius: 6px;
  flex-shrink: 0;
}

/* Division icon wrapper */
.div-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border-radius: 8px;
  background: rgba(255,255,255,.06);
  flex-shrink: 0;
}

/* Commission preview icon */
.lf-comm-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

/* General inline SVG helper */
.av-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  vertical-align: middle;
  flex-shrink: 0;
}
/* ────────────────────────────────────────────────────────────────────────── */
"""

css = css.rstrip() + '\n' + ICON_CSS

with open(CSS_PATH, 'w') as f:
    f.write(css)
print(f'premium.css written ({len(css)} chars)')
print('\nAll icon patches complete.')
