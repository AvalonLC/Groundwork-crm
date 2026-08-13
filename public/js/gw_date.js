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

  /**
   * A calendar date as a Date object anchored at LOCAL noon.
   *
   * Accepts 'YYYY-MM-DD', a full ISO timestamp, or a Date. Returns null for
   * anything unusable so callers can tell "no date" from "the epoch" — the
   * distinction Date's own constructor throws away.
   */
  function gwDateParse(value) {
    if (value == null || value === '') return null;
    if (value instanceof Date) return isNaN(value.getTime()) ? null : value;

    var str = String(value);
    var m = ISO_DATE.exec(str);
    if (m) {
      // Local noon. Deliberately not `new Date(str)` (UTC midnight) and not
      // `new Date(y, mo, d)` (local midnight, which a DST spring-forward can
      // move backwards across the day line in some zones).
      return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12, 0, 0, 0);
    }

    // A timestamp carries a real instant, so honour it as written.
    var d = new Date(str);
    return isNaN(d.getTime()) ? null : d;
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
