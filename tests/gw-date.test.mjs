import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

/**
 * Tests the SHIPPED file, not a copy of it.
 *
 * public/js/gw_date.js is a plain browser script with no module system, loaded
 * by a <script> tag. Rather than port the logic into TypeScript and let the two
 * drift, this reads the exact bytes the browser gets and evaluates them against
 * a stand-in global.
 *
 * Why node:test and not vitest: the vitest suite runs in the Cloudflare workers
 * pool, and workerd is pinned to UTC — it ignores TZ entirely (verified: TZ set
 * to America/New_York still reports getTimezoneOffset() === 0). Both defects
 * below are invisible at UTC, so a vitest version of this file would pass while
 * the bugs were live. It runs under `npm test` via the package script, so CI
 * still gates on it.
 *
 * Run: TZ=America/New_York node --test tests/gw-date.test.mjs
 */

const source = readFileSync(new URL('../public/js/gw_date.js', import.meta.url), 'utf8');
const sandbox = {};
new Function('window', `${source}\nreturn window.gwDate;`)(sandbox);
const { gwDateParse, gwDateISO, gwDateAddDays, gwDateFormat, gwDateWeekday, gwSameDay } = sandbox.gwDate;

/**
 * Run a block in a specific zone.
 *
 * The two defects bite in opposite hemispheres — one only west of Greenwich,
 * one only east — so testing a single zone would leave half the surface
 * unproven. Node re-reads process.env.TZ on each Date operation, so this is
 * enough; tests in a file run sequentially, and the zone is always restored.
 */
function inZone(zone, fn) {
  const previous = process.env.TZ;
  process.env.TZ = zone;
  try { fn(); } finally { process.env.TZ = previous; }
}

const EAST_COAST = 'America/New_York'; // UTC-4/-5 — where Avalon actually is
const NEW_ZEALAND = 'Pacific/Auckland'; // UTC+12/+13 — the opposite sign

// ── the premise ──────────────────────────────────────────────────────────────

test('GD-00 both test zones really are on opposite sides of UTC', () => {
  // Every assertion below is a no-op at UTC. If zone handling ever silently
  // stops working, this fails first instead of the suite going green while the
  // bugs come back.
  inZone(EAST_COAST, () => assert.ok(new Date(2026, 7, 11, 12).getTimezoneOffset() > 0));
  inZone(NEW_ZEALAND, () => assert.ok(new Date(2026, 7, 11, 12).getTimezoneOffset() < 0));
});

// ── the day-shift ────────────────────────────────────────────────────────────

test('GD-01 a stored date survives the round trip', () => {
  // new Date('2026-08-11') is UTC midnight per spec, which in Eastern is Aug 10
  // at 20:00 — the work-order drawer header read "Aug 10" for a job stored as
  // the 11th, while the date field beside it read 2026-08-11.
  inZone(EAST_COAST, () => {
    assert.equal(new Date('2026-08-11').getDate(), 10, 'the old behaviour');
    assert.equal(gwDateISO('2026-08-11'), '2026-08-11');
    assert.equal(gwDateParse('2026-08-11').getDate(), 11);
  });
  // East of Greenwich the same parse lands on the right day by luck, and the
  // helper must not "fix" it into being wrong.
  inZone(NEW_ZEALAND, () => {
    assert.equal(gwDateISO('2026-08-11'), '2026-08-11');
    assert.equal(gwDateParse('2026-08-11').getDate(), 11);
  });
});

test('GD-02 an evening Date does not roll FORWARD a day (west of Greenwich)', () => {
  // The week grid built Dates from new Date() — carrying the wall clock — then
  // called toISOString().slice(0,10). After ~20:00 Eastern that is already
  // tomorrow in UTC, and that string is what a drag persists.
  inZone(EAST_COAST, () => {
    const evening = new Date(2026, 7, 12, 20, 30, 0);
    assert.equal(evening.toISOString().slice(0, 10), '2026-08-13', 'the old bug');
    assert.equal(gwDateISO(evening), '2026-08-12', 'the day the user is looking at');
  });
});

test('GD-03 holds at every hour of the day, in both hemispheres', () => {
  // The failure was time-of-day dependent, which is how it survived review:
  // anyone checking during business hours saw correct dates.
  for (const zone of [EAST_COAST, NEW_ZEALAND]) {
    inZone(zone, () => {
      for (let hour = 0; hour < 24; hour++) {
        assert.equal(gwDateISO(new Date(2026, 7, 12, hour, 30, 0)), '2026-08-12', `${zone} hour ${hour}`);
      }
    });
  }
});

test('GD-04 a locally-built midnight does not roll BACKWARD a day (east of Greenwich)', () => {
  // new Date(y, m, 1) is LOCAL midnight. Converting that to UTC subtracts the
  // offset, so east of Greenwich it lands on the previous day — which is how a
  // month range query would start a day early.
  //
  // Worth being precise about: this one does NOT bite in Eastern, where local
  // midnight converts forward into the same UTC day. It is latent rather than
  // live for Avalon, and it is fixed here so it stays that way.
  inZone(NEW_ZEALAND, () => {
    const localMidnight = new Date(2026, 7, 1, 0, 0, 0);
    assert.equal(localMidnight.toISOString().slice(0, 10), '2026-07-31', 'the old bug');
    assert.equal(gwDateISO(localMidnight), '2026-08-01');
  });
  inZone(EAST_COAST, () => {
    assert.equal(gwDateISO(new Date(2026, 7, 1, 0, 0, 0)), '2026-08-01');
  });
});

test('GD-05 tells "no date" apart from a real one', () => {
  // Date's constructor turns null into the epoch. A backlog job legitimately
  // has no date and must never render as 1 Jan 1970.
  assert.equal(gwDateParse(null), null);
  assert.equal(gwDateParse(''), null);
  assert.equal(gwDateParse(undefined), null);
  assert.equal(gwDateParse('not a date'), null);
  assert.equal(gwDateISO(null), '');
});

test('GD-06 passes a full timestamp through as a real instant', () => {
  // created_at and friends carry a genuine moment; only bare calendar dates get
  // the noon anchor.
  assert.equal(gwDateParse('2026-08-11T15:30:00Z').toISOString(), '2026-08-11T15:30:00.000Z');
});

// ── DST ──────────────────────────────────────────────────────────────────────
// US DST in 2026: forward Sun 8 Mar, back Sun 1 Nov.

test('GD-07 parses the spring-forward day itself', () => {
  // 02:00 does not exist locally on this date. Anchoring at midnight risks the
  // engine normalising across the day line; noon is 12 hours clear of either.
  assert.equal(gwDateISO('2026-03-08'), '2026-03-08');
  assert.equal(gwDateParse('2026-03-08').getDate(), 8);
});

test('GD-08 adds a day across spring-forward (a 23-hour day)', () => {
  assert.equal(gwDateAddDays('2026-03-07', 1), '2026-03-08');
  assert.equal(gwDateAddDays('2026-03-08', 1), '2026-03-09');
});

test('GD-09 adds a day across fall-back (a 25-hour day)', () => {
  // Adding 24h of milliseconds would land back on 1 Nov here. setDate is
  // calendar arithmetic rather than duration arithmetic, which is the point.
  assert.equal(gwDateAddDays('2026-10-31', 1), '2026-11-01');
  assert.equal(gwDateAddDays('2026-11-01', 1), '2026-11-02');
});

test('GD-10 walks a week through the transition without losing or repeating a day', () => {
  const seen = [];
  let cursor = '2026-03-05';
  for (let i = 0; i < 7; i++) { seen.push(cursor); cursor = gwDateAddDays(cursor, 1); }
  assert.deepEqual(seen, [
    '2026-03-05', '2026-03-06', '2026-03-07',
    '2026-03-08', '2026-03-09', '2026-03-10', '2026-03-11',
  ]);
  assert.equal(new Set(seen).size, 7);
});

test('GD-11 subtracts as well as adds, across a year boundary', () => {
  assert.equal(gwDateAddDays('2026-03-09', -1), '2026-03-08');
  assert.equal(gwDateAddDays('2026-01-01', -1), '2025-12-31');
});

// ── week grid vs month grid ──────────────────────────────────────────────────

/** The week-column derivation, as the schedule board does it. */
function weekColumns(now) {
  const sunday = new Date(now);
  sunday.setDate(now.getDate() - now.getDay());
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(sunday);
    d.setDate(sunday.getDate() + i);
    return gwDateISO(d);
  });
}

test('GD-12 the week columns are the same whatever time of day it is', () => {
  // The tell that this was a bug and not a preference: the same Wednesday had
  // two different ISO strings depending on when you looked at the screen.
  const morning = weekColumns(new Date(2026, 7, 13, 9, 0, 0));
  const evening = weekColumns(new Date(2026, 7, 13, 20, 30, 0));
  assert.deepEqual(evening, morning);
  assert.deepEqual(morning, [
    '2026-08-09', '2026-08-10', '2026-08-11',
    '2026-08-12', '2026-08-13', '2026-08-14', '2026-08-15',
  ]);
});

test('GD-13 a week column matches the month cell for the same day', () => {
  // Month view hand-built its ISO string and was correct; week view used
  // toISOString and was not. They disagreed with each other, which is how one
  // job could appear to be on two different days in two views.
  const monthCell = (y, m, d) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  const week = weekColumns(new Date(2026, 7, 13, 22, 0, 0));
  assert.equal(week[3], monthCell(2026, 8, 12));
});

// ── display ──────────────────────────────────────────────────────────────────

test('GD-14 the header shows the day that is stored', () => {
  assert.equal(gwDateFormat('2026-08-11'), 'Aug 11, 2026');
});

test('GD-15 renders an em dash for no date, not the epoch', () => {
  assert.equal(gwDateFormat(null), '—');
  assert.equal(gwDateFormat(''), '—');
});

test('GD-16 falls back to the raw value rather than blanking the row', () => {
  assert.equal(gwDateFormat('whenever'), 'whenever');
});

test('GD-17 weekday matches the calendar', () => {
  assert.equal(gwDateWeekday('2026-08-11'), 'Tue');
  assert.equal(gwDateWeekday('2026-08-11', 'long'), 'Tuesday');
});

test('GD-18 gwSameDay compares calendar days, not instants', () => {
  assert.equal(gwSameDay('2026-08-11', new Date(2026, 7, 11, 23, 59)), true);
  assert.equal(gwSameDay('2026-08-11', '2026-08-12'), false);
  assert.equal(gwSameDay(null, null), false, 'two missing dates are not "the same day"');
});
