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
    // A milestone is required, or PaymentTimeline early-returns an empty-state
    // card with no link — restoring the inline onclick on its link would not
    // have failed this test.
    const html = R.PaymentTimeline([{ name: 'Deposit', amount: 100, status: 'paid' }], { invoiceId: id })
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
  // Handlers can span lines — the defect this PR removed was a four-line
  // onclick, and only its second line carried both the attribute and an
  // interpolation. Scanning the file as one string with the attribute value
  // allowed to run past newlines catches the continuation lines too.
  const offenders = [];
  for (const m of recSource.matchAll(/\son[a-z]+="([^"]*)"/g)) {
    if (/'\$\{/.test(m[1])) offenders.push(m[0].trim().slice(0, 70));
  }
  assert.deepEqual(offenders, [], 'a value is interpolated into a JS string literal');
});

test('IJ-08b the latent id-in-onclick surface in invoices.js cannot grow', () => {
  // invoices.js has 21 handlers of the shape onEVENT="_invFoo('${inv.id}')" —
  // 19 onclick plus two onchange the original onclick-only regex could not see.
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
    sites.length <= 21,
    `inline onclick handlers interpolating into a JS string grew to ${sites.length}:\n  ` +
    sites.slice(21).join('\n  '),
  );
  // Only ids may appear there — checked per INTERPOLATION, not per line. The
  // previous version asked whether the line contained any id, so
  // onclick="_invFoo('${inv.id}','${inv.client_name}')" was filtered out by its
  // first argument and the second never examined.
  const ID = /^(inv\.id|invId(\s*\|\|\s*'')?|i\.id|i|id|cl\.id|pm\.id)$/;
  const nonId = [];
  for (const line of sites) {
    for (const expr of jsStringInterpolations(line)) {
      if (!ID.test(expr)) nonId.push(`${expr}  <-  ${line.trim().slice(0, 60)}`);
    }
  }
  assert.deepEqual(
    nonId, [],
    'a non-id value is now interpolated into a JavaScript string literal',
  );
});

/**
 * Every line putting an interpolation inside a JS string literal in ANY inline
 * handler attribute.
 *
 * `onclick` alone missed onchange="_invUpdateDueDate('${inv.id}',this.value)"
 * and its sibling at :447 — the identical shape, invisible to the guard.
 */
function recount(src) {
  return src.split('\n').filter(line => {
    if (/^\s*(\/\/|\*)/.test(line.trim())) return false;
    return /\son[a-z]+="[^"]*'\$\{/.test(line);
  });
}

/** Every `'${...}'` occurrence on a line, so each is judged on its own. */
function jsStringInterpolations(line) {
  return [...line.matchAll(/'\$\{([^}]*)\}'/g)].map(m => m[1].trim());
}

test('IJ-09 every _invDate/_invAgo call site is covered by the helper', () => {
  // Escaping lives in the helper precisely because none of the call sites do
  // it. If one ever starts, this says so before it double-escapes.
  const wrapped = (invSource.match(/_invEsc\(\s*_inv(Date|Ago)\(/g) || []).length;
  assert.equal(wrapped, 0, 'a call site now escapes too — the helper would double-escape');
  const sites = (invSource.match(/\$\{[^}]*_inv(Date|Ago)\(/g) || []).length;
  assert.ok(sites >= 8, `expected at least 8 interpolation sites, found ${sites}`);
});

test('IJ-10 no user-controlled value sits raw in an HTML attribute', () => {
  // The element context was hardened first and the ATTRIBUTE context was left
  // raw in the same file — `value="${inv.due_date||''}"` on the invoice detail,
  // the same field the fix eight lines above names as attacker-controlled, plus
  // the builder's copy and the line-item qty/unit_price whose `description`
  // sibling one line up WAS escaped.
  //
  // due_date is stored verbatim (src/index.tsx: `b.due_date`), and line_items
  // is JSON.stringify'd straight from the body, so both are reachable.
  const ATTR = /(\b[a-zA-Z-]+)="([^"]*\$\{[^"]*)"/g;
  const SAFE = /_invEsc\(|esc\(|escapeHtml\(|gwIcon\(|_invBadge\(|_invFmt\(|_invDate\(|_invAgo\(|Class\(|fmt\(/;
  // Server-generated ids and literals from in-file arrays are not user data.
  const INERT = /^(inv\.id|invId(\s*\|\|\s*'')?|i|id|cl\.id|pm\.id|t|primary|state|pct|td\.color|\(inv\.balance_due\|\|0\)\.toFixed\(2\))$/;
  // A ternary whose branches are both quoted literals can only emit one of
  // them, whatever the condition is — e.g. aria-selected="${x ? 'true' : 'false'}".
  const LITERAL_TERNARY = /\?\s*'[^']*'\s*:\s*'[^']*'\s*$/;
  const offenders = [];
  for (const [file, src] of [['invoices.js', invSource], ['record-page.js', recSource]]) {
    src.split('\n').forEach((line, i) => {
      if (/^\s*(\/\/|\*)/.test(line.trim())) return;
      for (const m of line.matchAll(ATTR)) {
        const [, attr, val] = m;
        if (/^(class|style|data-|id$)/.test(attr) || /^on[a-z]+$/.test(attr)) continue;
        for (const e of val.matchAll(/\$\{([^}]*)\}/g)) {
          const expr = e[1].trim();
          if (SAFE.test(expr) || INERT.test(expr) || LITERAL_TERNARY.test(expr)) continue;
          offenders.push(`${file}:${i + 1} ${attr}="\${${expr}}"`);
        }
      }
    });
  }
  assert.deepEqual(offenders, [], 'a user-controlled value is raw in an HTML attribute');
});

test('IJ-11 a poisoned due date cannot break out of its input attribute', () => {
  // Executed, not matched: render the real attribute and parse it.
  const { _invEsc } = invoiceDates();
  for (const p of PAYLOADS) {
    const html = `<input type="date" value="${_invEsc(p)}">`;
    const { document } = parseHTML(`<!doctype html><html><body>${html}</body></html>`);
    const input = document.querySelector('input');
    assert.equal(input.getAttribute('value'), p, 'the value did not round-trip');
    assert.equal(input.getAttribute('onfocus'), null, `${p} injected a handler`);
    assert.equal(document.body.querySelectorAll('*').length, 1, `${p} created extra elements`);
  }
});

test('IJ-12 every exit from _invDate is HTML-safe, including the catch', () => {
  // The catch returned the raw value, so the invariant all eight call sites now
  // rely on was untrue on one branch.
  const src = invSource.slice(invSource.indexOf('function _invDate'), invSource.indexOf('function _invAgo'));
  assert.doesNotMatch(src, /catch\s*\(e\)\s*\{\s*return d;/, '_invDate still echoes the raw value on throw');
  assert.match(src, /catch\s*\(e\)\s*\{\s*return _invEsc\(String\(d\)\);/);
});
