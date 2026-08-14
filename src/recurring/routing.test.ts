import { describe, it, expect } from 'vitest';
import {
  normalizeStopOrder, reorderStops, totalOnSiteMinutes, summarizeRoute,
  optimizeOrder, NULL_PROVIDER, type RoutingProvider, type Stop,
} from './routing';

const stop = (id: string, over: Partial<Stop> = {}): Stop => ({
  day_id: id, work_order_id: `wo-${id}`, duration_minutes: 60, ...over,
});

describe('normalizeStopOrder', () => {
  it('RT-01 puts ordered stops first and numbers them 1..n with no gaps', () => {
    // stop_order is written by reordering and can end up sparse (10, 20, 30) or
    // tied. The UI renders positions, so the gaps are closed on read.
    const out = normalizeStopOrder([
      stop('c', { stop_order: 30 }), stop('a', { stop_order: 10 }), stop('b', { stop_order: 20 }),
    ]);
    expect(out.map((s) => s.day_id)).toEqual(['a', 'b', 'c']);
    expect(out.map((s) => s.position)).toEqual([1, 2, 3]);
  });

  it('RT-02 unordered stops go last, never first', () => {
    // A newly scheduled job has no stop_order. Sorting it to the front would
    // silently rewrite a route the crew already agreed on.
    const out = normalizeStopOrder([stop('new'), stop('a', { stop_order: 1 }), stop('b', { stop_order: 2 })]);
    expect(out.map((s) => s.day_id)).toEqual(['a', 'b', 'new']);
  });

  it('RT-03 breaks ties by start time, then stably', () => {
    // Duplicate positions are allowed by design — see migration 0073 on why
    // there is no unique index — so the tie-break has to be deterministic or
    // the list reshuffles itself on every render.
    const stops = [stop('x', { stop_order: 1 }), stop('y', { stop_order: 1 })];
    const times = { x: '09:00', y: '07:00' };
    expect(normalizeStopOrder(stops, times).map((s) => s.day_id)).toEqual(['y', 'x']);
    // Same input, same output, every time.
    expect(normalizeStopOrder(stops, times).map((s) => s.day_id))
      .toEqual(normalizeStopOrder(stops, times).map((s) => s.day_id));
  });

  it('RT-04 with no order and no times at all, it is still stable', () => {
    const stops = [stop('b'), stop('a'), stop('c')];
    const once = normalizeStopOrder(stops).map((s) => s.day_id);
    const twice = normalizeStopOrder(stops).map((s) => s.day_id);
    expect(once).toEqual(twice);
  });
});

describe('reorderStops', () => {
  const base = () => normalizeStopOrder([
    stop('a', { stop_order: 1 }), stop('b', { stop_order: 2 }),
    stop('c', { stop_order: 3 }), stop('d', { stop_order: 4 }),
  ]);

  it('RT-05 moves a stop down and renumbers everything', () => {
    // Returns the whole list because that is what gets written. Assigning one
    // row a new number and leaving the rest is the bug this shape prevents.
    const out = reorderStops(base(), 'a', 3);
    expect(out.map((s) => s.day_id)).toEqual(['b', 'c', 'a', 'd']);
    expect(out.map((s) => s.position)).toEqual([1, 2, 3, 4]);
  });

  it('RT-06 moves a stop up', () => {
    expect(reorderStops(base(), 'd', 1).map((s) => s.day_id)).toEqual(['d', 'a', 'b', 'c']);
  });

  it('RT-07 clamps a position past either end instead of dropping the stop', () => {
    expect(reorderStops(base(), 'a', 99).map((s) => s.day_id)).toEqual(['b', 'c', 'd', 'a']);
    expect(reorderStops(base(), 'd', -5).map((s) => s.day_id)).toEqual(['d', 'a', 'b', 'c']);
  });

  it('RT-08 an unknown stop leaves the list exactly as it was', () => {
    const before = base();
    expect(reorderStops(before, 'nope', 1)).toEqual(before);
  });
});

describe('route totals', () => {
  it('RT-09 sums on-site minutes, ignoring junk', () => {
    expect(totalOnSiteMinutes([
      stop('a', { duration_minutes: 45 }), stop('b', { duration_minutes: 30 }),
      stop('c', { duration_minutes: null }), stop('d', { duration_minutes: -10 }),
    ])).toBe(75);
  });

  it('RT-10 drive time is null until EVERY stop has one', () => {
    // Partial drive times summed would read as a complete route total and be
    // short by however many legs are missing.
    const partial = summarizeRoute([
      stop('a', { drive_minutes: 10 }), stop('b'),
    ]);
    expect(partial.drive_minutes).toBeNull();
    expect(partial.total_minutes).toBeNull();
    expect(partial.on_site_minutes).toBe(120); // still known, still reported
  });

  it('RT-11 reports how many stops still lack coordinates', () => {
    const s = summarizeRoute([
      stop('a', { lat: 38.9, lng: -77.2 }), stop('b'), stop('c', { lat: 38.8, lng: -77.1 }),
    ]);
    expect(s.ungeocoded).toBe(1);
    expect(s.stops).toBe(3);
  });
});

describe('optimizeOrder', () => {
  const stubProvider = (order: string[] | null): RoutingProvider => ({
    name: 'stub',
    async geocode() { return { lat: 0, lng: 0 }; },
    async optimize() { return order; },
  });
  const geo = (id: string, n: number) => stop(id, { lat: 38 + n / 100, lng: -77 - n / 100 });

  it('RT-12 with no provider, it declines and says why', () => {
    // The important one. Ordering by straight-line distance and calling it
    // optimised produces a number a crew will drive to, and being confidently
    // wrong about a route costs more than having no route.
    return optimizeOrder(NULL_PROVIDER, [geo('a', 1), geo('b', 2), geo('c', 3)]).then((out) => {
      expect(out.order).toBeNull();
      expect(out.reason).toMatch(/No routing provider configured/);
    });
  });

  it('RT-13 declines below three stops', async () => {
    const out = await optimizeOrder(stubProvider(['b', 'a']), [geo('a', 1), geo('b', 2)]);
    expect(out.order).toBeNull();
    expect(out.reason).toMatch(/at least three stops/);
  });

  it('RT-14 declines when any stop has no coordinates, and counts them', async () => {
    const out = await optimizeOrder(stubProvider(['a', 'b', 'c']), [geo('a', 1), stop('b'), geo('c', 3)]);
    expect(out.order).toBeNull();
    expect(out.reason).toMatch(/1 of 3 stops have no coordinates/);
  });

  it('RT-15 returns the provider order when it can answer', async () => {
    const out = await optimizeOrder(stubProvider(['c', 'a', 'b']), [geo('a', 1), geo('b', 2), geo('c', 3)]);
    expect(out.order).toEqual(['c', 'a', 'b']);
    expect(out.reason).toMatch(/Ordered by stub/);
  });

  it('RT-16 rejects a short or malformed answer rather than applying it', async () => {
    // A provider that drops a stop would silently remove it from the crew's day.
    const out = await optimizeOrder(stubProvider(['a', 'b']), [geo('a', 1), geo('b', 2), geo('c', 3)]);
    expect(out.order).toBeNull();
    expect(out.reason).toMatch(/could not return an order/);
  });
});
