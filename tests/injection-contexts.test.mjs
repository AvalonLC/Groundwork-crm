/* Untrusted values reach HTML, attribute and JavaScript-string contexts.
 * Each needs a different encoding, and one of them cannot be encoded at all.
 *
 * Two live paths, both found while reviewing PR #137:
 *
 *   invoices.js _invDate echoes the raw stored value when it cannot parse, and
 *   all EIGHT interpolation sites put the result into innerHTML unescaped
 *   (verified: zero wrapped in _invEsc). due_date is bound from the request
 *   body unvalidated.
 *
 *   record-page.js built onclick="show('invoices','${cfg.invoiceId}')" — an id
 *   inside a JS STRING inside an HTML ATTRIBUTE. HTML-escaping does NOT fix
 *   that: the parser decodes &#39; back to ' before the JS is compiled, so the
 *   quote returns intact and closes the string. The only reliable fix is to
 *   stop generating code — data attributes read back with getAttribute.
 *
 * These parse the generated markup with linkedom rather than grepping strings,
 * so the assertion is "the browser did not build an extra element / an event
 * handler / a broken attribute", which is the actual property.
 *
 * Run: node --test tests/injection-contexts.test.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { parseHTML } from 'linkedom';

const invSource = readFileSync(new URL('../public/js/invoices.js', import.meta.url), 'utf8');
const recSource = readFileSync(new URL('../public/js/record-page.js', import.meta.url), 'utf8');
const gwSource = readFileSync(new URL('../public/js/gw_date.js', import.meta.url), 'utf8');

/** The real _invDate/_invEsc/_invIso/_invAgo, out of the shipped file. */
function invoiceDates() {
  const from = invSource.indexOf('function _invIso');
  const to = invSource.indexOf('function _invBadge');
  assert.ok(from >= 0 && to > from, 'the invoices.js date helpers moved');
  return new Function('window', `${gwSource}\n${invSource.slice(from, to)}\nreturn { _invDate, _invAgo, _invEsc };`)({});
}

/** The real record-page module, evaluated against a linkedom DOM. */
function recordModule() {
  const { window } = parseHTML('<!doctype html><html><body></body></html>');
  const g = {
    window, document: window.document,
    HTMLElement: window.HTMLElement, Node: window.Node,
  };
  new Function('window', 'document', 'HTMLElement', 'Node', recSource)(
    g.window, g.document, g.HTMLElement, g.Node,
  );
  return { R: window.GW.record, window };
}

/* Quotes, backticks, tags, an entity string, a malformed date and Unicode. */
const PAYLOADS = [
  `<img src=x onerror=alert(1)>`,
  `'); alert(1); //`,
  `" onmouseover="alert(1)`,
  '`${alert(1)}`',
  `&lt;already-encoded&gt;`,
  `2026-13-45`,
  `Ω…café ☃ 𝕏`,
  `</div><script>alert(1)</script>`,
];

test('IJ-01 an unparseable date is escaped before it reaches innerHTML', () => {
  const { _invDate } = invoiceDates();
  for (const p of PAYLOADS) {
    const out = _invDate(p);
    assert.doesNotMatch(out, /[<>]/, `${p} produced raw markup: ${out}`);
  }
});

test('IJ-02 the browser builds no extra element from a poisoned due date', () => {
  // The real property: parse what would be assigned to innerHTML and count.
  const { _invDate } = invoiceDates();
  for (const p of PAYLOADS) {
    const html = `<td class="inv-due-cell">${_invDate(p)}</td>`;
    const { document } = parseHTML(`<!doctype html><html><body><table><tr>${html}</tr></table></body></html>`);
    const cell = document.querySelector('.inv-due-cell');
    assert.equal(cell.querySelectorAll('*').length, 0, `${p} injected an element`);
    assert.equal(document.querySelectorAll('script, img').length, 0, `${p} injected a script/img`);
  }
});

test('IJ-03 a real date is not escaped, so nothing double-escapes', () => {
  const { _invDate, _invAgo } = invoiceDates();
  const out = _invDate('2026-09-01');
  assert.doesNotMatch(out, /&(amp|lt|gt|quot|#0?39);/, `formatted date was escaped: ${out}`);
  assert.match(out, /2026/);
  // _invAgo delegates to _invDate past 30 days, so it inherits the same rule.
  assert.doesNotMatch(_invAgo('2020-01-01'), /&(amp|lt|gt);/);
});

test('IJ-04 an entity string is escaped once, not decoded and re-encoded', () => {
  const { _invDate } = invoiceDates();
  const out = _invDate('&lt;already-encoded&gt;');
  assert.equal(out, '&amp;lt;already-encoded&amp;gt;');
  const { document } = parseHTML(`<!doctype html><html><body><span>${out}</span></body></html>`);
  // Round-trips to exactly what was stored — no more, no less.
  assert.equal(document.querySelector('span').textContent, '&lt;already-encoded&gt;');
});

test('IJ-05 navigation links carry no inline JavaScript at all', () => {
  const { R } = recordModule();
  for (const id of PAYLOADS) {
    const html = R.PaymentTimeline([], { invoiceId: id })
      + R.FinancialSummary({ invoiceId: id, estimateId: id, contractTotal: 100, balanceDue: 0 });
    const { document } = parseHTML(`<!doctype html><html><body>${html}</body></html>`);
    for (const el of document.querySelectorAll('*')) {
      assert.equal(el.getAttribute('onclick'), null, `${id} produced an inline onclick`);
    }
    assert.equal(document.querySelectorAll('script').length, 0, `${id} injected a script`);
  }
});

test('IJ-06 the id survives the attribute round-trip byte for byte', () => {
  // This is what makes the data-attribute approach correct rather than merely
  // different: show() receives exactly the stored id, quotes and all, and it
  // arrives as a string rather than as source text.
  const { R } = recordModule();
  for (const id of PAYLOADS) {
    // A milestone is required: PaymentTimeline early-returns an empty-state
    // card that carries no link at all when the list is empty.
    const html = R.PaymentTimeline([{ name: 'Deposit', amount: 100, status: 'paid' }], { invoiceId: id });
    const { document } = parseHTML(`<!doctype html><html><body>${html}</body></html>`);
    const link = document.querySelector('[data-gw-show]');
    assert.ok(link, `no navigation link rendered for ${id}`);
    assert.equal(link.getAttribute('data-gw-id'), id, 'the id did not round-trip');
    assert.equal(link.getAttribute('data-gw-show'), 'invoices');
  }
});

test('IJ-07 milestone name and status cannot inject', () => {
  const { R } = recordModule();
  for (const p of PAYLOADS) {
    const html = R.PaymentTimeline(
      [{ name: p, amount: 100, status: p, dueDate: p }],
      { invoiceId: 'inv-1' },
    );
    const { document } = parseHTML(`<!doctype html><html><body>${html}</body></html>`);
    assert.equal(document.querySelectorAll('script, img').length, 0, `${p} injected`);
    const name = document.querySelector('.pay-tl-name');
    assert.equal(name.querySelectorAll('*').length, 0, `${p} built an element inside the name`);
    assert.equal(name.textContent, p, 'the name did not round-trip as text');
  }
});

test('IJ-08 record-page interpolates no value into a JavaScript string', () => {
  // The three surviving onclick attributes in record-page.js take a
  // caller-supplied HANDLER string (R.Tabs, R.Actions, onAssign) — developer
  // authored code, by design. What must never come back is an interpolated
  // DATA value inside a JS string literal, which is what the invoiceId and
  // estimateId links used to be.
  const offenders = [];
  recSource.split('\n').forEach((line, i) => {
    if (/^\s*(\/\/|\*)/.test(line.trim())) return;
    if (/onclick="[^"]*'\$\{/.test(line)) offenders.push(`record-page.js:${i + 1}`);
  });
  assert.deepEqual(offenders, [], 'a value is interpolated into a JS string literal');
});

test('IJ-08b the latent id-in-onclick surface in invoices.js cannot grow', () => {
  // invoices.js has 19 handlers of the shape onclick="_invFoo('${inv.id}')".
  // They are NOT live: invoice ids are generated server-side as
  // `inv_${Date.now()}_${base36}` (src/index.tsx:9298, 9526) and the POST route
  // never reads an id from the body, so no attacker-controlled value reaches
  // them. They are the same SHAPE as the record-page defect this file fixes,
  // and converting nineteen live money-UI handlers to delegation is a bigger,
  // riskier change than belongs in a security fix — so they are pinned here
  // instead: the count may fall, never rise.
  //
  // If an id ever becomes client-supplied, or a non-id value is added to one of
  // these, this fails and says why.
  const sites = recount(invSource);
  assert.ok(
    sites.length <= 19,
    `inline onclick handlers interpolating into a JS string grew to ${sites.length}:\n  ` +
    sites.slice(19).join('\n  '),
  );
  // Only ids may appear there. Anything else is a new class of value.
  const nonId = sites.filter(l => !/'\$\{(inv\.id|invId|invId\|\|''|i\.id)\}'/.test(l));
  assert.deepEqual(
    nonId.map(l => l.trim().slice(0, 60)), [],
    'a non-id value is now interpolated into a JavaScript string literal',
  );
});

function recount(src) {
  return src.split('\n').filter(line => {
    if (/^\s*(\/\/|\*)/.test(line.trim())) return false;
    return /onclick="[^"]*'\$\{/.test(line);
  });
}

test('IJ-09 every _invDate/_invAgo call site is covered by the helper', () => {
  // Escaping lives in the helper precisely because none of the call sites do
  // it. If one ever starts, this says so before it double-escapes.
  const wrapped = (invSource.match(/_invEsc\(\s*_inv(Date|Ago)\(/g) || []).length;
  assert.equal(wrapped, 0, 'a call site now escapes too — the helper would double-escape');
  const sites = (invSource.match(/\$\{[^}]*_inv(Date|Ago)\(/g) || []).length;
  assert.ok(sites >= 8, `expected at least 8 interpolation sites, found ${sites}`);
});
