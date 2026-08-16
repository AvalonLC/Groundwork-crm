import { describe, it, expect } from 'vitest';
import {
  summarizeDayEquipment, findDoubleBookings, normalizeStatus, statusLabel,
  type EquipmentBooking,
} from './equipment';

const bk = (o: Partial<EquipmentBooking> & { asset_id: string; wo_day_id: string }): EquipmentBooking => ({
  id: `b_${o.wo_day_id}_${o.asset_id}`, day_date: '2026-08-18', ...o,
});

describe('findDoubleBookings', () => {
  it('EQ-01 says nothing when a machine is on one job that day', () => {
    const mine = [bk({ asset_id: 'ex1', wo_day_id: 'd1', asset_name: 'Excavator 1' })];
    expect(findDoubleBookings('d1', mine, mine)).toEqual([]);
  });

  it('EQ-02 flags the same machine on a different job the same date', () => {
    // The warning migration 0071 promised and nothing ever produced.
    const mine = [bk({ asset_id: 'ex1', wo_day_id: 'd1', asset_name: 'Excavator 1' })];
    const all = [...mine, bk({ asset_id: 'ex1', wo_day_id: 'd2', job_title: 'Miller patio' })];
    const c = findDoubleBookings('d1', mine, all);
    expect(c).toHaveLength(1);
    expect(c[0]!.message).toBe('Excavator 1 is also on Miller patio this day.');
    expect(c[0]!.elsewhere.map((e) => e.wo_day_id)).toEqual(['d2']);
  });

  it('EQ-03 never reports a day as conflicting with itself', () => {
    // The same row appears in both lists — the callers pass every booking on the
    // date, this day's included, and filtering by day_id is the whole guard.
    const mine = [bk({ asset_id: 'ex1', wo_day_id: 'd1' })];
    expect(findDoubleBookings('d1', mine, [...mine, ...mine])).toEqual([]);
  });

  it('EQ-04 names every other job, not just the first', () => {
    const mine = [bk({ asset_id: 'ex1', wo_day_id: 'd1', asset_name: 'Excavator 1' })];
    const all = [
      ...mine,
      bk({ asset_id: 'ex1', wo_day_id: 'd2', job_title: 'Miller patio' }),
      bk({ asset_id: 'ex1', wo_day_id: 'd3', job_title: 'Vance grading' }),
    ];
    expect(findDoubleBookings('d1', mine, all)[0]!.message)
      .toBe('Excavator 1 is also on Miller patio and Vance grading this day.');
  });

  it('EQ-05 falls back to the asset tag, then to a generic noun', () => {
    const withTag = [bk({ asset_id: 'x', wo_day_id: 'd1', asset_tag: 'EQ-114' })];
    const other = bk({ asset_id: 'x', wo_day_id: 'd2', job_title: 'Miller patio' });
    expect(findDoubleBookings('d1', withTag, [...withTag, other])[0]!.message)
      .toBe('EQ-114 is also on Miller patio this day.');

    const bare = [bk({ asset_id: 'x', wo_day_id: 'd1' })];
    expect(findDoubleBookings('d1', bare, [...bare, other])[0]!.message)
      .toBe('This machine is also on Miller patio this day.');
  });

  it('EQ-06 a different machine on the same day is not a conflict', () => {
    const mine = [bk({ asset_id: 'ex1', wo_day_id: 'd1' })];
    const all = [...mine, bk({ asset_id: 'skid', wo_day_id: 'd2' })];
    expect(findDoubleBookings('d1', mine, all)).toEqual([]);
  });
});

describe('normalizeStatus / statusLabel', () => {
  it('EQ-07 keeps the three real statuses and rejects anything else', () => {
    expect(normalizeStatus('loaded')).toBe('loaded');
    expect(normalizeStatus('ON_SITE')).toBe('on_site');
    // No CHECK constraint on the column, so junk will arrive eventually. It
    // reads as the least-committed real status rather than as itself.
    expect(normalizeStatus('on_sit')).toBe('needed');
    expect(normalizeStatus(null)).toBe('needed');
    expect(statusLabel('on_site')).toBe('On site');
    expect(statusLabel('nonsense')).toBe('Needed');
  });
});

describe('summarizeDayEquipment', () => {
  it('EQ-08 marks the conflicted booking and leaves the others clean', () => {
    const mine = [
      bk({ asset_id: 'ex1', wo_day_id: 'd1', asset_name: 'Excavator 1' }),
      bk({ asset_id: 'skid', wo_day_id: 'd1', asset_name: 'Skid steer' }),
    ];
    const s = summarizeDayEquipment('d1', mine, [...mine, bk({ asset_id: 'ex1', wo_day_id: 'd2' })]);
    expect(s.bookings.map((b) => b.conflict)).toEqual([true, false]);
    expect(s.conflicts).toHaveLength(1);
  });

  it('EQ-09 counts what is not yet on site', () => {
    const s = summarizeDayEquipment('d1', [
      bk({ asset_id: 'a', wo_day_id: 'd1', status: 'on_site' }),
      bk({ asset_id: 'b', wo_day_id: 'd1', status: 'loaded' }),
      bk({ asset_id: 'c', wo_day_id: 'd1' }),
    ]);
    expect(s.outstanding).toBe(2);
  });

  it('EQ-10 keeps old free-text equipment visible instead of inventing bookings', () => {
    // "skid steer" does not identify WHICH skid steer, so turning it into a
    // booking would fabricate one. It stays a note until a human picks the asset.
    const s = summarizeDayEquipment('d1', [], [], ['skid steer', 'plate compactor']);
    expect(s.unbooked_notes).toEqual(['skid steer', 'plate compactor']);
    expect(s.bookings).toEqual([]);
  });

  it('EQ-11 drops a note once the real machine is booked, case-insensitively', () => {
    const s = summarizeDayEquipment(
      'd1',
      [bk({ asset_id: 'ex1', wo_day_id: 'd1', asset_name: 'Excavator 1' })],
      [],
      ['excavator 1', 'plate compactor'],
    );
    // Otherwise the rail shows the machine twice: once booked, once as the note
    // somebody typed before they booked it.
    expect(s.unbooked_notes).toEqual(['plate compactor']);
  });

  it('EQ-12 accepts the object form the work order actually stores', () => {
    const s = summarizeDayEquipment('d1', [], [], [{ name: 'Trailer' }, 'Trailer', { name: '' }]);
    expect(s.unbooked_notes).toEqual(['Trailer']); // deduped, blanks dropped
  });

  it('EQ-13 an empty day is empty, not broken', () => {
    const s = summarizeDayEquipment('d1', [], [], []);
    expect(s).toMatchObject({ bookings: [], conflicts: [], outstanding: 0, unbooked_notes: [] });
  });
});
