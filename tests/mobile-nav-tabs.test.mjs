/* A mobile allow-list must not empty out the tab strip it filters.
 *
 * _gwSetHeader renders a workspace's tab strip, and on a phone it first filters
 * that strip through _GW_MOBILE_TABS[workspace] — "only what you'd realistically
 * use in the field", per its own comment. The filter is an intersection, and
 * nothing checks that the intersection is non-empty.
 *
 * Financial is the workspace where that bites, because it is the only one with
 * TWO tab sets:
 *
 *   _GW_FIN_NAV_TABS   the 9 Finance OS tabs (finControl … finConfig), which
 *                      gwFinancial() renders and which the 2026-08-06 nav
 *                      consolidation made the real Financial tab strip
 *
 *   _wsTabDefs.Financial  the older Overview/Invoices/Payments/Deposits/
 *                      Statements/Activity set, still rendered whenever someone
 *                      lands on one of those still-live legacy views — and
 *                      show('invoices') is called from around fifteen places,
 *                      including the Command Center
 *
 * _GW_MOBILE_TABS.Financial listed only the Finance OS ids. So on a phone,
 * tapping Invoices from the Command Center rendered a tab strip with nothing in
 * it: no error, no console message, just an empty nav bar and no way back to
 * the rest of Financial except the browser's own back button.
 *
 * Run: node --test tests/mobile-nav-tabs.test.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('../public/js/app_premium.js', import.meta.url), 'utf8');

/** Evaluate a named object/array literal straight out of the shipped file. */
function literal(name) {
  const at = source.indexOf(`${name} = {`) >= 0 ? source.indexOf(`${name} = {`) : source.indexOf(`${name} = [`);
  assert.ok(at >= 0, `${name} is no longer in public/js/app_premium.js`);
  const open = source.indexOf(source[source.indexOf('=', at) + 2] === '[' ? '[' : '{', source.indexOf('=', at));
  const close = source[open] === '[' ? ']' : '}';
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === source[open]) depth++;
    else if (source[i] === close) {
      depth--;
      if (depth === 0) return new Function(`return ${source.slice(open, i + 1)};`)();
    }
  }
  throw new Error(`could not find the end of ${name}`);
}

const mobile = literal('const _GW_MOBILE_TABS');
const financeOsTabs = literal('const _GW_FIN_NAV_TABS');
const wsTabDefs = literal('const _wsTabDefs');

const ids = (tabs) => tabs.filter(t => !t.divider).map(t => t.id);

/** Every tab set a workspace can render, keyed by workspace name. */
const RENDERED_SETS = {
  ...Object.fromEntries(Object.entries(wsTabDefs).map(([ws, tabs]) => [ws, [ids(tabs)]])),
};
// Financial renders _GW_FIN_NAV_TABS as well — gwFinancial() and the
// _GW_FIN_OS_IDS branch in show() both hand it to _gwSetHeader.
RENDERED_SETS.Financial.push(ids(financeOsTabs));

test('MN-01 every mobile allow-list leaves at least one tab in every set it filters', () => {
  for (const [workspace, sets] of Object.entries(RENDERED_SETS)) {
    const allowed = mobile[workspace];
    if (!allowed) continue; // no allow-list means no filtering, which is fine
    sets.forEach((set, i) => {
      const kept = set.filter(id => allowed.includes(id));
      assert.ok(
        kept.length > 0,
        `_GW_MOBILE_TABS.${workspace} allows none of tab set ${i} ` +
        `[${set.join(', ')}], so on a phone that strip renders empty:\n` +
        `  allowed: ${allowed.join(', ')}`,
      );
    });
  }
});

test('MN-02 a mobile allow-list only names tabs that still exist', () => {
  // Not "exists in the set this workspace renders" — several workspaces build
  // their tabs from a function (_gwOpsNavConfig, _gwAdminNavConfig) that cannot
  // be evaluated from the source text alone. The weaker, still useful claim: an
  // allowed id must appear SOMEWHERE as a tab id, so a rename cannot quietly
  // shrink a list toward the empty intersection MN-01 exists to prevent.
  const declared = new Set(
    [...source.matchAll(/\bid\s*:\s*'([A-Za-z0-9_]+)'/g)].map(m => m[1]),
  );
  for (const [workspace, allowed] of Object.entries(mobile)) {
    const unknown = allowed.filter(id => !declared.has(id));
    assert.deepEqual(
      unknown, [],
      `_GW_MOBILE_TABS.${workspace} names ids that are no longer any tab: ${unknown.join(', ')}`,
    );
  }
});

test('MN-03 the legacy Financial views are still reachable on a phone', () => {
  // show('invoices') is wired from the Command Center, the client detail
  // drawer, the quick-add menu and the mobile financial hub. If the strip that
  // renders alongside them is empty, those entry points become one-way doors.
  const allowed = mobile.Financial;
  for (const id of ['financialHub', 'invoices', 'payments']) {
    assert.ok(
      allowed.includes(id),
      `_GW_MOBILE_TABS.Financial drops '${id}', which show('${id}') still navigates to`,
    );
  }
});
