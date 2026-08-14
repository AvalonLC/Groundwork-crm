/**
 * Stop ordering, and the seam a routing provider plugs into.
 *
 * Ordering works today with no external service. Optimisation does not, and the
 * design is built so that stays honest: `optimizeOrder` reports what it can and
 * cannot do rather than falling back to a guess. A route that claims to be
 * optimised and is really just "the order someone typed" is worse than no
 * optimisation, because a crew will follow it.
 */

export interface Stop {
  day_id: string;
  work_order_id: string;
  client_name?: string | null;
  address?: string | null;
  stop_order?: number | null;
  lat?: number | null;
  lng?: number | null;
  /** Time on site, not travel. */
  duration_minutes?: number | null;
  /**
   * Travel to this stop, once a provider supplies it. Null until then.
   *
   * summarizeRoute has always read this and the interface never declared it —
   * the test papered over the gap with `as Partial<Stop>`, and typecheck was not
   * covering src/recurring at all, so nothing objected. Declared now.
   */
  drive_minutes?: number | null;
}

/**
 * Put stops in a stable, gapless order.
 *
 * Rows can share a stop_order — see migration 0073 for why no unique index —
 * and rows that have never been ordered have none at all. Both are resolved
 * here rather than in SQL so the rule is in one place:
 *
 *   ordered stops first, by their number
 *   ties broken by start time, then by day_id so the result never flickers
 *   unordered stops last, in the same stable order
 *
 * The returned positions are 1..n with no gaps, which is what the UI renders
 * and what a reorder writes back.
 */
export function normalizeStopOrder<T extends Stop>(stops: T[], startTimes: Record<string, string | null> = {}): Array<T & { position: number }> {
  const withIndex = stops.map((s, i) => ({ s, i }));
  withIndex.sort((a, b) => {
    const ao = a.s.stop_order, bo = b.s.stop_order;
    const aHas = ao != null, bHas = bo != null;
    if (aHas && bHas && ao !== bo) return (ao as number) - (bo as number);
    if (aHas !== bHas) return aHas ? -1 : 1; // ordered before unordered
    const at = startTimes[a.s.day_id] || '', bt = startTimes[b.s.day_id] || '';
    if (at !== bt) return at < bt ? -1 : 1;
    return a.s.day_id < b.s.day_id ? -1 : a.s.day_id > b.s.day_id ? 1 : a.i - b.i;
  });
  return withIndex.map((x, idx) => ({ ...x.s, position: idx + 1 }));
}

/**
 * Move one stop to a new position, returning the full new order.
 *
 * Takes and returns the whole list because that is what gets written: assigning
 * a single row a new number leaves the rest wrong, and "shift everything after
 * it" is the bug people write instead. The caller persists all of them.
 */
export function reorderStops<T extends Stop>(
  stops: Array<T & { position: number }>,
  dayId: string,
  toPosition: number,
): Array<T & { position: number }> {
  const from = stops.findIndex((s) => s.day_id === dayId);
  if (from === -1) return stops;
  const target = Math.max(1, Math.min(stops.length, Math.trunc(toPosition || 1)));
  const next = stops.slice();
  const [moved] = next.splice(from, 1);
  // findIndex above guarantees this, but the compiler cannot see that and a
  // non-null assertion would hide a real bug if the guard ever moved.
  if (!moved) return stops;
  next.splice(target - 1, 0, moved);
  return next.map((s, i) => ({ ...s, position: i + 1 }));
}

/** Minutes on site across a day's stops. Travel is not included — see below. */
export function totalOnSiteMinutes(stops: Stop[]): number {
  return stops.reduce((n, s) => n + Math.max(0, Math.trunc(Number(s.duration_minutes) || 0)), 0);
}

export interface RouteSummary {
  stops: number;
  on_site_minutes: number;
  /**
   * null until a provider supplies real drive times.
   *
   * Straight-line distance between coordinates is available and is NOT used as
   * a stand-in: it ignores rivers, highways and one-way systems, and a crew
   * given "14 minutes" that is really 35 stops trusting the number. Null says
   * "not known", which is true.
   */
  drive_minutes: number | null;
  /** on_site + drive, or null while drive is unknown. */
  total_minutes: number | null;
  /** How many stops still have no coordinates. */
  ungeocoded: number;
}

export function summarizeRoute(stops: Stop[]): RouteSummary {
  const onSite = totalOnSiteMinutes(stops);
  const drives = stops.map((s) => s.drive_minutes).filter((d): d is number => typeof d === 'number');
  const drive = drives.length === stops.length && stops.length > 0
    ? drives.reduce((a, b) => a + b, 0)
    : null;
  return {
    stops: stops.length,
    on_site_minutes: onSite,
    drive_minutes: drive,
    total_minutes: drive == null ? null : onSite + drive,
    ungeocoded: stops.filter((s) => s.lat == null || s.lng == null).length,
  };
}

// ── Provider seam ────────────────────────────────────────────────────────────

export interface GeocodeResult { lat: number; lng: number }

/**
 * Degrees <-> stored integers.
 *
 * Coordinates are persisted as degrees x 1e7 (migration 0073) for the same
 * reason money is persisted as cents: this schema does not keep floats. These
 * are the only two places the scaling is applied — convert at the boundary,
 * work in degrees everywhere above it.
 */
export const COORD_SCALE = 1e7;
export const toE7 = (deg: number | null | undefined): number | null =>
  deg == null || !Number.isFinite(Number(deg)) ? null : Math.round(Number(deg) * COORD_SCALE);
export const fromE7 = (e7: number | null | undefined): number | null =>
  e7 == null || !Number.isFinite(Number(e7)) ? null : Number(e7) / COORD_SCALE;

export interface RoutingProvider {
  name: string;
  geocode(address: string): Promise<GeocodeResult | null>;
  /** Returns day_ids in suggested visiting order, or null if it cannot answer. */
  optimize(stops: Stop[]): Promise<string[] | null>;
}

/**
 * What is available with no provider configured: nothing, and it says so.
 *
 * Deliberately not a "best effort" implementation. The alternative — ordering by
 * straight-line distance and calling it optimised — produces a number a crew
 * will drive to, and being confidently wrong about a route costs more than
 * having no route at all.
 */
export const NULL_PROVIDER: RoutingProvider = {
  name: 'none',
  async geocode() { return null; },
  async optimize() { return null; },
};

export interface OptimizeOutcome {
  /** null when nothing could be computed. */
  order: string[] | null;
  /** Always populated, whether or not an order came back. */
  reason: string;
}

/**
 * Ask a provider for a better order, and be explicit when the answer is no.
 *
 * Every failure mode returns a reason the UI can show, because "optimise" that
 * silently does nothing is indistinguishable from "optimise" that is broken.
 */
export async function optimizeOrder(provider: RoutingProvider, stops: Stop[]): Promise<OptimizeOutcome> {
  if (provider.name === 'none') {
    return { order: null, reason: 'No routing provider configured — stops stay in the order you set.' };
  }
  if (stops.length < 3) {
    // Two stops have exactly one sensible order and one is not a route.
    return { order: null, reason: 'Needs at least three stops to be worth optimising.' };
  }
  const missing = stops.filter((s) => s.lat == null || s.lng == null);
  if (missing.length) {
    return { order: null, reason: `${missing.length} of ${stops.length} stops have no coordinates yet.` };
  }
  const order = await provider.optimize(stops);
  if (!order || order.length !== stops.length) {
    return { order: null, reason: 'The routing provider could not return an order for these stops.' };
  }
  return { order, reason: `Ordered by ${provider.name}.` };
}
