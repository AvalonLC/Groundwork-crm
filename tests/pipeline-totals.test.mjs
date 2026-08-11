/* Pipeline board totals — column rollups and the top KPI band.
 *
 * These numbers were previously reported by statCards(), which asked
 * GWSalesProcess.resolve() whether a lead was won. That resolver only answers
 * for tenants running a *published* sales process, or for the handful of legacy
 * status labels hardcoded in sales-process.js. A tenant on custom stage names
 * ("Won", "Closed Lost", …) resolved to needs_restaging for every lead, so the
 * board showed SOLD 0 next to a WON column holding seven deals.
 *
 * Everything here therefore runs with NO published process and custom stage
 * names — the exact condition that produced the zeros.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { parseHTML } from 'linkedom';

const source = readFileSync(new URL('../public/js/app_premium.js', import.meta.url), 'utf8');

function sourceBlock(startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.ok(start >= 0 && end > start, `missing source block ${startMarker}`);
  return source.slice(start, end);
}

// This tenant's stages — deliberately none of the labels baked into
// sales-process.js's legacy compatibility map.
const STAGES = [
  'New Lead', 'Intro Call', 'On-Site Consultation', 'Estimate Development',
  'Estimate Presentation', 'Decision Pending', 'Won', 'Closed Lost'
];

function harness() {
  const { window, document } = parseHTML('<main></main>');
  const context = {
    window,
    document,
    console,
    Date,
    getPipelineStages: () => STAGES,
    escapeHtml: v => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
    money: v => `$${Math.round(Number(v || 0)).toLocaleString('en-US')}`
  };
  context.globalThis = context;
  // No published sales process, and no GWSalesProcess resolver — the state a
  // tenant on custom stages is actually in.
  window._gwSalesProcess = null;

  vm.runInNewContext(sourceBlock('function gwLeadBaseValue(opp){', 'function estCommission(opp){'), context);
  vm.runInNewContext(sourceBlock('function gwStageClock(o){', 'window.gwLeadScore = gwLeadScore;'), context);
  vm.runInNewContext(sourceBlock('function gwPeriodStart(', 'function gwPipelineKpiBand('), context);
  vm.runInNewContext(sourceBlock('function gwPipelineKpiBand(', '// ── Pipeline value by division'), context);
  return context;
}

const DAY = 86400000;
const ago = days => new Date(Date.now() - days * DAY).toISOString();

function lead(over = {}) {
  return {
    id: 'l' + Math.random().toString(36).slice(2, 8),
    client: 'Test Client',
    status: 'New Lead',
    jobValue: 1000,
    createdAt: ago(10),
    updatedAt: ago(1),
    stageEnteredAt: ago(1),
    ...over
  };
}

// ── 1. Won / lost detection on custom stage names ───────────────────────────

test('won and lost are detected from custom stage names with no published process', () => {
  const c = harness();
  assert.equal(c.gwLeadClosedState(lead({ status: 'Won' })), 'won');
  assert.equal(c.gwLeadClosedState(lead({ status: 'Closed Lost' })), 'lost');
  assert.equal(c.gwLeadClosedState(lead({ status: 'Decision Pending' })), '');

  // …and the open check must agree, rather than calling a won lead open.
  assert.equal(c.gwLeadIsOpen(lead({ status: 'Won' })), false);
  assert.equal(c.gwLeadIsOpen(lead({ status: 'Closed Lost' })), false);
  assert.equal(c.gwLeadIsOpen(lead({ status: 'Decision Pending' })), true);
});

test('board totals count won and lost instead of sweeping every lead into open', () => {
  const c = harness();
  const opps = [
    lead({ status: 'Won', jobValue: 2100, soldAmount: 2100 }),
    lead({ status: 'Won', jobValue: 35000, soldAmount: 35000 }),
    lead({ status: 'Closed Lost', jobValue: 4000 }),
    lead({ status: 'Decision Pending', jobValue: 15000 }),
    lead({ status: 'New Lead', jobValue: 500 })
  ];
  const t = c.gwPipelineTotals(opps, 'all');

  assert.equal(t.wonCount, 2);
  assert.equal(t.wonValue, 37100);
  assert.equal(t.lostCount, 1);
  assert.equal(t.lostValue, 4000);
  assert.equal(t.openCount, 2);
  assert.equal(t.openValue, 15500);
});

// ── 2. gwLeadBaseValue picks up the sold amount ─────────────────────────────

test('gwLeadBaseValue returns soldAmount for a won lead on a custom stage name', () => {
  const c = harness();
  assert.equal(c.gwLeadBaseValue(lead({ status: 'Won', jobValue: 30000, soldAmount: 35000 })), 35000);
  // No sold amount recorded — fall back to the estimate rather than zero.
  assert.equal(c.gwLeadBaseValue(lead({ status: 'Won', jobValue: 30000 })), 30000);
  // Open leads always use the estimate, even if a stale soldAmount is present.
  assert.equal(c.gwLeadBaseValue(lead({ status: 'Decision Pending', jobValue: 30000, soldAmount: 99999 })), 30000);
});

// ── 3. Per-column rollups ───────────────────────────────────────────────────

test('gwStageTotals sums column value and flags leads with no value', () => {
  const c = harness();
  const t = c.gwStageTotals([
    lead({ status: 'Decision Pending', jobValue: 15000 }),
    lead({ status: 'Decision Pending', jobValue: 45000 }),
    lead({ status: 'Decision Pending', jobValue: 0 })
  ]);
  assert.equal(t.count, 3);
  assert.equal(t.value, 60000);
  assert.equal(t.noValue, 1);
});

test('gwStageTotals counts leads sitting past their stage clock as late', () => {
  const c = harness();
  const t = c.gwStageTotals([
    lead({ status: 'New Lead', stageEnteredAt: ago(1) }),    // fresh
    lead({ status: 'New Lead', stageEnteredAt: ago(40) }),   // well past ~7d expected
    lead({ status: 'New Lead', stageEnteredAt: ago(60) })
  ]);
  assert.equal(t.late, 2);
});

test('gwStageTotals never marks a closed lead late', () => {
  const c = harness();
  const t = c.gwStageTotals([lead({ status: 'Won', soldAmount: 9000, stageEnteredAt: ago(400) })]);
  assert.equal(t.late, 0);
  assert.equal(t.value, 9000);
});

test('column totals sum to the board open value', () => {
  const c = harness();
  const opps = [
    lead({ status: 'New Lead', jobValue: 500 }),
    lead({ status: 'Decision Pending', jobValue: 15000 }),
    lead({ status: 'Decision Pending', jobValue: 45000 })
  ];
  const byStage = STAGES.map(s => c.gwStageTotals(opps.filter(o => o.status === s)));
  const summed = byStage.reduce((a, t) => a + t.value, 0);
  assert.equal(summed, c.gwPipelineTotals(opps, 'all').openValue);
});

// ── 4. Totals describe the filtered board ───────────────────────────────────

test('totals reflect whatever filtered set they are handed', () => {
  const c = harness();
  const opps = [
    lead({ status: 'Won', repId: 'rep-a', soldAmount: 10000 }),
    lead({ status: 'Won', repId: 'rep-b', soldAmount: 25000 }),
    lead({ status: 'Decision Pending', repId: 'rep-a', jobValue: 4000 })
  ];
  const all = c.gwPipelineTotals(opps, 'all');
  const repA = c.gwPipelineTotals(opps.filter(o => o.repId === 'rep-a'), 'all');

  assert.equal(all.wonValue, 35000);
  assert.equal(repA.wonValue, 10000);
  assert.equal(repA.wonCount, 1);
  assert.equal(repA.openValue, 4000);
});

// ── 5. Win rate ─────────────────────────────────────────────────────────────

test('win rate ignores open leads and reports null rather than NaN', () => {
  const c = harness();
  const decided = c.gwPipelineTotals([
    lead({ status: 'Won', soldAmount: 1000 }),
    lead({ status: 'Won', soldAmount: 1000 }),
    lead({ status: 'Won', soldAmount: 1000 }),
    lead({ status: 'Closed Lost', jobValue: 1000 }),
    // Ten open leads must not dilute the rate.
    ...Array.from({ length: 10 }, () => lead({ status: 'Decision Pending' }))
  ], 'all');
  assert.equal(decided.winRate, 0.75);

  const undecided = c.gwPipelineTotals([lead({ status: 'Decision Pending' })], 'all');
  assert.equal(undecided.winRate, null);
  assert.ok(!Number.isNaN(undecided.winRate));

  const empty = c.gwPipelineTotals([], 'all');
  assert.equal(empty.winRate, null);
  assert.equal(empty.openValue, 0);
});

// ── 6. Period scoping ───────────────────────────────────────────────────────

test('period scoping excludes deals closed outside the window', () => {
  const c = harness();
  const now = new Date('2026-08-11T12:00:00Z');
  const opps = [
    lead({ status: 'Won', soldDate: '2026-08-03', soldAmount: 5000 }),  // this month
    lead({ status: 'Won', soldDate: '2026-07-20', soldAmount: 9000 }),  // last month, this quarter
    lead({ status: 'Won', soldDate: '2026-02-10', soldAmount: 7000 }),  // earlier this year
    lead({ status: 'Won', soldDate: '2025-11-01', soldAmount: 3000 })   // last year
  ];

  assert.equal(c.gwPipelineTotals(opps, 'month', now).wonValue, 5000);
  assert.equal(c.gwPipelineTotals(opps, 'quarter', now).wonValue, 14000);
  assert.equal(c.gwPipelineTotals(opps, 'ytd', now).wonValue, 21000);
  assert.equal(c.gwPipelineTotals(opps, 'all', now).wonValue, 24000);
});

test('a lead with no close date is only counted when no window is set', () => {
  const c = harness();
  const now = new Date('2026-08-11T12:00:00Z');
  // No soldDate and no updatedAt — nothing to place it in time.
  const undated = [lead({ status: 'Won', soldAmount: 5000, updatedAt: '', createdAt: '' })];
  assert.equal(c.gwPipelineTotals(undated, 'month', now).wonCount, 0);
  assert.equal(c.gwPipelineTotals(undated, 'all', now).wonCount, 1);
});

// ── 7. Secondary metrics ────────────────────────────────────────────────────

test('average deal size and days to close are derived from won deals only', () => {
  const c = harness();
  const now = new Date('2026-08-11T12:00:00Z');
  const opps = [
    lead({ status: 'Won', createdAt: '2026-08-01T00:00:00Z', soldDate: '2026-08-11', soldAmount: 10000 }),
    lead({ status: 'Won', createdAt: '2026-08-01T00:00:00Z', soldDate: '2026-08-21', soldAmount: 20000 }),
    lead({ status: 'Decision Pending', jobValue: 999999 })
  ];
  const t = c.gwPipelineTotals(opps, 'all', now);
  assert.equal(t.avgDeal, 15000);
  assert.equal(t.avgDaysToClose, 15);
});

test('days to close skips won deals missing either end of the span', () => {
  const c = harness();
  const opps = [
    lead({ status: 'Won', createdAt: '2026-08-01T00:00:00Z', soldDate: '2026-08-11', soldAmount: 10000 }),
    lead({ status: 'Won', createdAt: '', soldDate: '2026-08-21', soldAmount: 20000 }),
    lead({ status: 'Won', createdAt: '2026-08-01T00:00:00Z', soldDate: '', soldAmount: 30000 })
  ];
  const t = c.gwPipelineTotals(opps, 'all');
  assert.equal(t.avgDaysToClose, 10);

  // Nothing measurable at all reports null, not 0 or NaN.
  const none = c.gwPipelineTotals([lead({ status: 'Won', createdAt: '', soldDate: '', soldAmount: 1 })], 'all');
  assert.equal(none.avgDaysToClose, null);
});

// ── 8. Weighted forecast ────────────────────────────────────────────────────

test('weighted forecast covers open leads only, at the score shown on each card', () => {
  const c = harness();
  const open = [
    lead({ status: 'Decision Pending', jobValue: 60000 }),
    lead({ status: 'New Lead', jobValue: 500 })
  ];
  // Won leads pin to a score of 100 and lost to 0; including either would make
  // the forecast double-count closed revenue.
  const opps = [...open, lead({ status: 'Won', soldAmount: 80000 }), lead({ status: 'Closed Lost', jobValue: 9000 })];

  const expected = open.reduce((a, o) => a + c.gwLeadBaseValue(o) * (c.gwLeadScore(o).score / 100), 0);
  assert.equal(c.gwPipelineTotals(opps, 'all').forecast, expected);
  assert.ok(expected > 0 && expected < 60500, 'forecast should be a fraction of the open value');
});

// ── 9. What actually reaches the DOM ────────────────────────────────────────

test('the KPI band renders a figure for every tile and wires the board filters', () => {
  const c = harness();
  const html = c.gwPipelineKpiBand([
    lead({ status: 'Won', soldAmount: 35000, soldDate: '2026-08-01' }),
    lead({ status: 'Closed Lost', jobValue: 4000 }),
    lead({ status: 'Decision Pending', jobValue: 15000 })
  ], 'all', null);

  for (const label of ['Open Pipeline', 'Weighted Forecast', 'Won ·', 'Lost ·', 'Win Rate', 'Needs Follow-Up']) {
    assert.ok(html.includes(label), `missing tile: ${label}`);
  }
  assert.ok(html.includes('$35,000'), 'won total should render');
  assert.ok(html.includes('$15,000'), 'open total should render');
  assert.ok(html.includes('50%'), 'win rate should render');

  // Each money tile doubles as a board filter.
  for (const f of ['open', 'sold', 'lost', 'overdue']) {
    assert.ok(html.includes(`window._pipelineStatusFilter='${f}'`), `tile should set the ${f} filter`);
  }
  // Forecast and win rate are not filters and must not emit a click handler.
  assert.equal((html.match(/gw-kpi-tile--static/g) || []).length, 2);
  assert.ok(!/NaN|undefined|\$NaN/.test(html), 'no NaN or undefined should reach the page');
});

test('an active tile toggles its own filter off rather than re-applying it', () => {
  const c = harness();
  const opps = [lead({ status: 'Won', soldAmount: 1000 })];
  assert.ok(c.gwPipelineKpiBand(opps, 'all', 'sold').includes('window._pipelineStatusFilter=null'));
  assert.ok(c.gwPipelineKpiBand(opps, 'all', 'sold').includes('gw-kpi-tile--on'));
  assert.ok(!c.gwPipelineKpiBand(opps, 'all', null).includes('gw-kpi-tile--on'));
});

test('an empty board renders dashes, not NaN', () => {
  const c = harness();
  const html = c.gwPipelineKpiBand([], 'month', null);
  assert.ok(!/NaN|undefined/.test(html), html.match(/.{0,40}(NaN|undefined).{0,40}/)?.[0]);
  assert.ok(html.includes('no decisions yet'));
});

test('the period toggle marks the selected window and offers the rest', () => {
  const c = harness();
  const html = c.gwPipelineKpiBand([], 'quarter', null);
  assert.ok(/class="pl-filter-btn pl-active"[^>]*onclick="window\._pipelinePeriod='quarter'/.test(html));
  for (const p of ['all', 'month', 'quarter', 'ytd']) {
    assert.ok(html.includes(`window._pipelinePeriod='${p}'`), `missing period option: ${p}`);
  }
});

test('a column subhead shows its money and flags, and an empty column shows a dash', () => {
  const c = harness();
  const filled = c.gwStageTotalHtml(c.gwStageTotals([
    lead({ status: 'New Lead', jobValue: 15000, stageEnteredAt: ago(60) }),
    lead({ status: 'New Lead', jobValue: 0 })
  ]));
  assert.ok(filled.includes('$15,000'));
  assert.ok(filled.includes('1 late'));
  assert.ok(filled.includes('1 no value'));

  const empty = c.gwStageTotalHtml(c.gwStageTotals([]));
  assert.ok(empty.includes('—'));
  assert.ok(!empty.includes('late'), 'a clean column should carry no flags');

  // Defensive: the renderer is also reachable with nothing at all.
  assert.ok(c.gwStageTotalHtml(undefined).includes('—'));
});

test('client-supplied text cannot break out of the band markup', () => {
  const c = harness();
  const html = c.gwPipelineKpiBand([lead({ status: '<img src=x onerror=alert(1)>', jobValue: 100 })], 'all', null);
  assert.ok(!html.includes('<img src=x'), 'lead status must not render as markup');
});
