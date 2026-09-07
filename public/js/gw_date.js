// ── Groundwork CRM — calendar dates ───────────────────────────────────────────
//
// One place to turn a stored YYYY-MM-DD into a Date, a Date back into a
// YYYY-MM-DD, and either into something a person reads. Everything scheduling
// touches goes through here.
//
// The two bugs this exists to end, both reproduced under TZ=America/New_York:
//
//   new Date('2026-08-11')            -> per spec, UTC midnight. Rendered in
//                                        local time that is Aug 10. The work
//                                        order drawer showed a date one day
//                                        behind the date field beside it.
//
//   someLocalDate.toISOString()       -> converts local -> UTC. A Date built
//     .slice(0,10)                       from new Date() carries the current
//                                        wall clock, so after ~19:00 EST the
//                                        week grid's column dates jumped a day
//                                        forward. That ISO is what a drag
//                                        writes, so an evening drag scheduled
//                                        the crew to the wrong day.
//
// A calendar date has no time zone. "August 11th" is August 11th in Vienna VA
// and in Auckland. The moment we let a Date object carry an instant, we have
// signed up for one of the two bugs above. So:
//
//   - parse at local NOON, never local or UTC midnight. Noon is more than 12
//     hours from either boundary, so no DST shift and no rounding can push the
//     date across a day line.
//   - build the ISO string from the LOCAL parts (getFullYear/getMonth/getDate).
//     Never toISOString, which is a UTC serialiser.
//
// Loaded before app_premium.js; assigns onto window so plain scripts can use it.

(function (global) {
  'use strict';

  var ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

  // SQLite's datetime('now'), which is what 358 call sites across src/ write:
  // 'YYYY-MM-DD HH:MM:SS' — UTC, space-separated, and carrying NO zone
  // designator to say so. Handing that to `new Date()` is the bug this block
  // exists for, twice over:
  //
  //   The space makes it invalid ISO 8601, so parsing is implementation-defined.
  //   V8 accepts it and reads it as LOCAL, turning a UTC instant into one up to
  //   14 hours off. Safari has historically rejected it outright, yielding
  //   Invalid Date -> null -> the raw string rendered into the UI. Same stored
  //   value, three different answers depending on the browser.
  //
  //   Read as local, an evening-UTC timestamp lands on the wrong calendar DAY
  //   for anyone west of Greenwich: '2026-09-01 01:30:00' is 21:30 on Aug 31 in
  //   New York, and every consumer of gwDateFormat showed it as September 1st.
  var SQLITE_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?$/;

  // What <input type="datetime-local"> hands back: 'YYYY-MM-DDTHH:MM[:SS]',
  // also with no designator — but this one genuinely IS local, because a person
  // typed it into a form in their own zone. It looks almost identical to the
  // SQLite shape and means the opposite, which is exactly why both are matched
  // explicitly instead of being left to the Date constructor to guess.
  var LOCAL_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?$/;

  // A timestamp that states its own zone ('...Z' or '...+05:30'). This is
  // well-formed ISO 8601, so every engine agrees on it and `new Date()` is safe.
  var ZONED_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$/;

  // 'YYYY' or 'YYYY-MM' — a real ISO 8601 form, but one that names a year or a
  // month rather than a day. Matched only so it can be refused; see below.
  var PARTIAL_ISO = /^\d{4}(?:-\d{2})?$/;

  /** Rejects 2026-02-30 and 2026-13-01 instead of silently rolling them over. */
  function validParts(y, mo, d, h, mi, s) {
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return false;
    if (h > 23 || mi > 59 || s > 59) return false;
    // Round-trip through UTC to reject a day that does not exist in that month.
    var probe = new Date(Date.UTC(y, mo - 1, d));
    return probe.getUTCFullYear() === y && probe.getUTCMonth() === mo - 1 && probe.getUTCDate() === d;
  }

  function num(v) { return v == null ? 0 : Number(v); }

  /**
   * A calendar date as a Date object anchored at LOCAL noon, or a timestamp as
   * the instant it actually names.
   *
   * Every shape this repository stores is matched explicitly and built with
   * arithmetic, so parsing does not vary by browser. Returns null for anything
   * unusable, so callers can tell "no date" from "the epoch" — the distinction
   * Date's own constructor throws away.
   */
  function gwDateParse(value) {
    if (value == null || value === '') return null;
    if (value instanceof Date) return isNaN(value.getTime()) ? null : value;

    var str = String(value).trim();
    if (str === '') return null;

    var m = ISO_DATE.exec(str);
    if (m) {
      var y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
      if (!validParts(y, mo, d, 0, 0, 0)) return null;
      // Local noon. Deliberately not `new Date(str)` (UTC midnight) and not
      // `new Date(y, mo, d)` (local midnight, which a DST spring-forward can
      // move backwards across the day line in some zones).
      return new Date(y, mo - 1, d, 12, 0, 0, 0);
    }

    m = SQLITE_TIMESTAMP.exec(str);
    if (m) {
      var sy = Number(m[1]), smo = Number(m[2]), sd = Number(m[3]);
      var sh = num(m[4]), smi = num(m[5]), ss = num(m[6]);
      if (!validParts(sy, smo, sd, sh, smi, ss)) return null;
      // Date.UTC, because the value is UTC even though it never says so.
      return new Date(Date.UTC(sy, smo - 1, sd, sh, smi, ss));
    }

    m = LOCAL_TIMESTAMP.exec(str);
    if (m) {
      var ly = Number(m[1]), lmo = Number(m[2]), ld = Number(m[3]);
      var lh = num(m[4]), lmi = num(m[5]), ls = num(m[6]);
      if (!validParts(ly, lmo, ld, lh, lmi, ls)) return null;
      return new Date(ly, lmo - 1, ld, lh, lmi, ls, 0);
    }

    if (ZONED_TIMESTAMP.test(str)) {
      var z = new Date(str);
      return isNaN(z.getTime()) ? null : z;
    }

    // A partial ISO date — 'YYYY' or 'YYYY-MM'. It names no calendar day, and
    // the Date constructor invents the missing parts at UTC midnight: in New
    // York `new Date('2026')` is Dec 31, 2025. That is the same day-shift this
    // file exists to prevent, so a value too vague to name a day reads as
    // unusable rather than as a confidently wrong one.
    if (PARTIAL_ISO.test(str)) return null;

    // Anything outside this repository's own conventions. Still parsed rather
    // than rejected, because returning null here would blank values that render
    // fine today — but nothing we store reaches this line any more, so the
    // browser-dependent behaviour is no longer load-bearing.
    var fallback = new Date(str);
    return isNaN(fallback.getTime()) ? null : fallback;
  }

  /**
   * YYYY-MM-DD from a date's LOCAL parts.
   *
   * This is the replacement for `.toISOString().slice(0,10)`. That call answers
   * "what was the UTC date at this instant", which is not the question any
   * calendar grid is asking.
   */
  function gwDateISO(value) {
    var d = gwDateParse(value);
    if (!d) return '';
    var mo = d.getMonth() + 1;
    var day = d.getDate();
    return d.getFullYear() + '-' + (mo < 10 ? '0' : '') + mo + '-' + (day < 10 ? '0' : '') + day;
  }

  /** Today as YYYY-MM-DD, in the user's own zone. */
  function gwToday() {
    return gwDateISO(new Date());
  }

  /**
   * Add (or subtract) whole days, returning YYYY-MM-DD.
   *
   * Works across DST because the anchor is noon: adding 1 to a 23-hour or
   * 25-hour day still lands on the next calendar date.
   */
  function gwDateAddDays(value, days) {
    var d = gwDateParse(value);
    if (!d) return '';
    var next = new Date(d.getTime());
    next.setDate(next.getDate() + (Number(days) || 0));
    return gwDateISO(next);
  }

  /**
   * Human-readable date. Falls back to the raw value rather than throwing —
   * a malformed date should show as itself, not blank out the row it is in.
   */
  function gwDateFormat(value, options) {
    if (value == null || value === '') return '—';
    var d = gwDateParse(value);
    if (!d) return String(value);
    try {
      return d.toLocaleDateString(undefined, options || { month: 'short', day: 'numeric', year: 'numeric' });
    } catch (e) {
      return String(value);
    }
  }

  /** Weekday name, e.g. 'Tue'. Same parsing guarantees. */
  function gwDateWeekday(value, style) {
    var d = gwDateParse(value);
    if (!d) return '';
    try {
      return d.toLocaleDateString(undefined, { weekday: style || 'short' });
    } catch (e) {
      return '';
    }
  }

  /** True when two values name the same calendar day. */
  function gwSameDay(a, b) {
    var ia = gwDateISO(a);
    return ia !== '' && ia === gwDateISO(b);
  }

  var api = {
    gwDateParse: gwDateParse,
    gwDateISO: gwDateISO,
    gwToday: gwToday,
    gwDateAddDays: gwDateAddDays,
    gwDateFormat: gwDateFormat,
    gwDateWeekday: gwDateWeekday,
    gwSameDay: gwSameDay,
  };

  for (var k in api) if (Object.prototype.hasOwnProperty.call(api, k)) global[k] = api[k];
  global.gwDate = api;
})(typeof window !== 'undefined' ? window : globalThis);
