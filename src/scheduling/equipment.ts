/**
 * Equipment booked to a day, and where the same machine is double-booked.
 *
 * Migration 0071 created wo_day_equipment and nothing has ever read it. Its own
 * header promises that a machine on two jobs the same date "is caught as a
 * warning" — that warning is this module. Until now the rail rendered the work
 * order's free-text equipment notes, which is a list of words nobody can check
 * against reality.
 *
 * The distinction the migration draws, and the reason this is not one rule:
 *
 *   same day ROW      impossible. The UNIQUE index refuses it. Not our problem.
 *   same DATE, two    a warning, never an error. An excavator really can do two
 *   different jobs    jobs in a day if the sites are close enough. Refusing it
 *                     would make the honest answer unrecordable, and people who
 *                     cannot record the truth record a lie somewhere else.
 *
 * So this reports and does not block. The scheduler decides.
 */

export type BookingStatus = 'needed' | 'loaded' | 'on_site';

export interface EquipmentBooking {
  id: string;
  wo_day_id: string;
  asset_id: string;
  asset_name?: string | null;
  asset_tag?: string | null;
  category?: string | null;
  status?: string | null;
  notes?: string | null;
  /** The date the day sits on. Needed to find same-date collisions. */
  day_date?: string | null;
  work_order_id?: string | null;
  job_title?: string | null;
  crew_name?: string | null;
}

/** The three statuses 0071 defines, in the order work actually happens. */
export const BOOKING_STATUSES: BookingStatus[] = ['needed', 'loaded', 'on_site'];

const STATUS_LABEL: Record<string, string> = {
  needed: 'Needed',
  loaded: 'Loaded',
  on_site: 'On site',
};

/**
 * Anything unrecognised displays as 'Needed' rather than raw.
 *
 * A status column with a DEFAULT and no CHECK constraint will eventually hold
 * something unexpected, and rendering `on_sit` to a foreman is worse than
 * rendering the least-committed real status.
 */
export function statusLabel(status: string | null | undefined): string {
  return STATUS_LABEL[String(status || '').toLowerCase()] || STATUS_LABEL.needed!;
}

export function normalizeStatus(status: string | null | undefined): BookingStatus {
  const s = String(status || '').toLowerCase();
  return (BOOKING_STATUSES as string[]).includes(s) ? (s as BookingStatus) : 'needed';
}

export interface EquipmentConflict {
  asset_id: string;
  asset_name: string | null;
  day_date: string;
  /** The other jobs this machine is on that date — never including this day. */
  elsewhere: Array<{ wo_day_id: string; work_order_id: string | null; job_title: string | null; crew_name: string | null }>;
  message: string;
}

/**
 * Which of this day's machines are also somewhere else on the same date.
 *
 * `sameDateBookings` is every booking in the company on that date, this day's
 * included — filtering it here rather than in SQL keeps the "different day row,
 * same date" rule in one readable place instead of a NOT EXISTS clause.
 */
export function findDoubleBookings(
  dayId: string,
  dayBookings: EquipmentBooking[],
  sameDateBookings: EquipmentBooking[],
): EquipmentConflict[] {
  const out: EquipmentConflict[] = [];
  for (const b of dayBookings || []) {
    const elsewhere = (sameDateBookings || [])
      .filter((o) => o.asset_id === b.asset_id && o.wo_day_id !== dayId)
      .map((o) => ({
        wo_day_id: o.wo_day_id,
        work_order_id: o.work_order_id ?? null,
        job_title: o.job_title ?? null,
        crew_name: o.crew_name ?? null,
      }));
    if (!elsewhere.length) continue;
    const name = b.asset_name || b.asset_tag || 'This machine';
    const jobs = elsewhere.map((e) => e.job_title || 'another job');
    // "also on X" for one, "also on X and Y" for two, Oxford list beyond that —
    // the message is read at 6am on a phone and reads as prose or not at all.
    const list = jobs.length === 1 ? jobs[0]
      : jobs.length === 2 ? `${jobs[0]} and ${jobs[1]}`
      : `${jobs.slice(0, -1).join(', ')}, and ${jobs[jobs.length - 1]}`;
    out.push({
      asset_id: b.asset_id,
      asset_name: b.asset_name ?? null,
      day_date: String(b.day_date || ''),
      elsewhere,
      message: `${name} is also on ${list} this day.`,
    });
  }
  return out;
}

export interface EquipmentSummary {
  bookings: Array<EquipmentBooking & { status: BookingStatus; status_label: string; conflict: boolean }>;
  conflicts: EquipmentConflict[];
  /** How many are not yet on site — what a morning dispatch actually asks. */
  outstanding: number;
  /**
   * Free-text equipment the job recorded before this table existed, minus
   * anything now booked for real.
   *
   * Kept visible rather than migrated. A note saying "skid steer" is not enough
   * to identify WHICH skid steer, so guessing an asset_id from it would invent a
   * booking nobody made. It shows as a note until a human books the real one.
   */
  unbooked_notes: string[];
}

export function summarizeDayEquipment(
  dayId: string,
  dayBookings: EquipmentBooking[],
  sameDateBookings: EquipmentBooking[] = [],
  freeTextNotes: Array<string | { name?: string | null }> = [],
): EquipmentSummary {
  const conflicts = findDoubleBookings(dayId, dayBookings || [], sameDateBookings);
  const conflicted = new Set(conflicts.map((c) => c.asset_id));

  const bookings = (dayBookings || []).map((b) => {
    const status = normalizeStatus(b.status);
    return { ...b, status, status_label: statusLabel(status), conflict: conflicted.has(b.asset_id) };
  });

  const bookedNames = new Set(
    bookings.flatMap((b) => [b.asset_name, b.asset_tag].filter(Boolean).map((s) => String(s).toLowerCase().trim())),
  );
  const unbooked = (freeTextNotes || [])
    .map((n) => (typeof n === 'string' ? n : n?.name || ''))
    .map((s) => String(s).trim())
    .filter((s) => s && !bookedNames.has(s.toLowerCase()));

  return {
    bookings,
    conflicts,
    outstanding: bookings.filter((b) => b.status !== 'on_site').length,
    unbooked_notes: [...new Set(unbooked)],
  };
}
