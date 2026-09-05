import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

/**
 * The Issued column on the invoice list.
 *
 * Two date shapes reach these helpers and they mean different things:
 *
 *   "2026-08-21"            a DATE the user chose (due_date). Local midnight.
 *   "2026-08-21 17:08:25"   a TIMESTAMP from SQLite's datetime('now'), which is
 *                           UTC, space-separated, with no zone designator.
 *
 * Both used to be handed to `new Date(d + 'T00:00:00')`. For the second that
 * builds "2026-08-21 17:08:25T00:00:00" — an Invalid Date — so _invAgo returned
 * '' and the Issued column rendered BLANK, and _invDate fell into its catch and
 * rendered the raw SQLite string. Before that it was worse in a different way:
 * parsed as local, a UTC timestamp is up to 5h in the FUTURE east-coast, so
 * Math.floor of a small negative gave "-1d ago" on a brand new invoice.
 *
 * Tests the SHIPPED file, same approach as gw-date.test.mjs: the helper block
 * is read out of public/js/invoices.js and evaluated, rather than ported here
 * where the two copies could drift.
 *
 * Why node:test and not vitest: the vitest suite runs in the Cloudflare workers
 * pool, and workerd is pinned to UTC — it ignores TZ entirely. Every defect
 * below is invisible at UTC, so a vitest version of this file would pass while
 * the bugs were live.
 *
 * Run: TZ=America/New_York node --test tests/invoice-dates.test.mjs
 */

const source = readFileSync(new URL('../public/js/invoices.js', import.meta.url), 'utf8');

function sourceBlock(startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.ok(start >= 0 && end > start, `missing source block ${startMarker}`);
  return source.slice(start, end);
}

// _invFmt / _invDate / _invAgo / _invEsc / _invIsOverdue — pure, no globals.
const helpers = sourceBlock('/* ── Helpers ─', '/* ── Status config ─');
const { _invDate, _invAgo } = new Function(
  `${helpers}\nreturn { _invDate, _invAgo };`,
)();

const EAST_COAST = 'America/New_York'; // UTC-4/-5 — where Avalon actually is

function inZone(zone, fn) {
  const previous = process.env.TZ;
  process.env.TZ = zone;
  try { fn(); } finally { process.env.TZ = previous; }
}

/** Exactly what SQLite's datetime('now') writes: UTC, space, no designator. */
function sqliteNow(offsetMs = 0) {
  return new Date(Date.now() + offsetMs).toISOString().slice(0, 19).replace('T', ' ');
}

test('IA-00 the test zone really is west of UTC', () => {
  inZone(EAST_COAST, () => {
    assert.ok(new Date().getTimezoneOffset() > 0, 'expected a zone behind UTC');
  });
});

test('IA-01 an invoice created seconds ago reads Today, not blank', () => {
  // The reported bug: a brand new invoice showed nothing in the Issued column.
  inZone(EAST_COAST, () => {
    assert.equal(_invAgo(sqliteNow()), 'Today');
  });
});

test('IA-02 a SQLite timestamp 25h back reads Yesterday', () => {
  inZone(EAST_COAST, () => {
    assert.equal(_invAgo(sqliteNow(-25 * 3600 * 1000)), 'Yesterday');
  });
});

test('IA-03 a SQLite timestamp never renders as an empty string', () => {
  // Pins the Invalid Date regression directly: "…17:08:25" + "T00:00:00".
  inZone(EAST_COAST, () => {
    assert.notEqual(_invAgo('2026-08-21 17:08:25'), '');
  });
});

test('IA-04 a bare date the user picked still reads Today', () => {
  // Guards the half of the fix that DID land (PR #87) against regression.
  inZone(EAST_COAST, () => {
    const today = new Date();
    const local = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    assert.equal(_invAgo(local), 'Today');
  });
});

test('IA-05 a UTC timestamp is never rendered as a negative age', () => {
  // "-1d ago" on a brand new invoice — a UTC stamp read as local is up to 5h
  // in the future east-coast, and Math.floor of a small negative is -1.
  inZone(EAST_COAST, () => {
    for (let minutes = 0; minutes <= 300; minutes += 30) {
      const rendered = _invAgo(sqliteNow(-minutes * 60 * 1000));
      assert.ok(!rendered.startsWith('-'), `negative age for ${minutes}m ago: ${rendered}`);
      assert.notEqual(rendered, '', `blank age for ${minutes}m ago`);
    }
  });
});

test('IA-06 junk returns an empty string rather than throwing', () => {
  inZone(EAST_COAST, () => {
    assert.equal(_invAgo('not a date'), '');
    assert.equal(_invAgo(''), '');
    assert.equal(_invAgo(null), '');
  });
});

test('IA-07 _invDate formats a SQLite timestamp instead of echoing it raw', () => {
  // The same defect one function up. _invDate appends 'T00:00:00' to a string
  // that already has a time, toLocaleDateString throws on the Invalid Date, and
  // the catch returns the raw "2026-08-21 17:08:25" into the UI.
  inZone(EAST_COAST, () => {
    assert.equal(_invDate('2026-08-21 17:08:25'), 'Aug 21, 2026');
  });
});

test('IA-08 _invDate does not shift a UTC evening stamp into the next day', () => {
  // 01:30 UTC on the 1st is 21:30 on the previous day east-coast.
  inZone(EAST_COAST, () => {
    assert.equal(_invDate('2026-09-01 01:30:00'), 'Aug 31, 2026');
  });
});

test('IA-09 _invDate still pins a user-picked date to its own day', () => {
  inZone(EAST_COAST, () => {
    assert.equal(_invDate('2026-08-21'), 'Aug 21, 2026');
  });
});
