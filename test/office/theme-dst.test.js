'use strict';
// review-16 R16-08: the automatic office theme's next boundary is a zoned calendar time (Intl offsets), so it stays
// on the agreed local time across both DST transitions; checked in America/Toronto and in zones without DST.
const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
let T;
before(async () => { T = await import('../../public/v2/office/theme.js'); });
const AUTO = { mode: 'auto', nightFrom: '19:00', nightTo: '07:00' };
const at = (iso) => Date.parse(iso);
const iso = (ms) => new Date(ms).toISOString();
const TOR = 'America/Toronto';

describe('automatic office theme across DST (R16-08)', () => {
  it('spring forward (Toronto, 2027-03-14): the review case schedules day at 07:00 EDT = 11:00 UTC, not 12:00', () => {
    const r = T.nextChange(AUTO, at('2027-03-14T00:00:00Z'), TOR);           // Mar 13, 19:00 EST
    assert.equal(r.resolved, 'night');
    assert.equal(iso(r.nextChangeAt), '2027-03-14T11:00:00.000Z');
    // …and the evening boundary that day is 19:00 EDT = 23:00 UTC.
    assert.equal(iso(T.nextChange(AUTO, at('2027-03-14T11:00:00Z'), TOR).nextChangeAt), '2027-03-14T23:00:00.000Z');
    assert.equal(T.nextChange(AUTO, at('2027-03-14T11:00:00Z'), TOR).resolved, 'day');
    assert.equal(T.nextChange(AUTO, at('2027-03-14T10:59:00Z'), TOR).resolved, 'night');
  });

  it('fall back (Toronto, 2026-11-01): day at 07:00 EST = 12:00 UTC; night at 19:00 EST = 00:00 UTC', () => {
    const r = T.nextChange(AUTO, at('2026-11-01T00:00:00Z'), TOR);           // Oct 31, 20:00 EDT
    assert.equal(r.resolved, 'night');
    assert.equal(iso(r.nextChangeAt), '2026-11-01T12:00:00.000Z');
    assert.equal(iso(T.nextChange(AUTO, at('2026-11-01T12:00:00Z'), TOR).nextChangeAt), '2026-11-02T00:00:00.000Z');
    assert.equal(T.nextChange(AUTO, at('2026-11-01T11:59:00Z'), TOR).resolved, 'night');
  });

  it('a boundary inside the skipped hour happens when the clock jumps past it; a repeated hour takes its first occurrence', () => {
    const gap = { mode: 'auto', nightFrom: '02:30', nightTo: '07:00' };
    assert.equal(iso(T.nextChange(gap, at('2027-03-14T05:00:00Z'), TOR).nextChangeAt), '2027-03-14T07:30:00.000Z');   // 03:30 EDT
    const rep = { mode: 'auto', nightFrom: '01:30', nightTo: '07:00' };
    assert.equal(iso(T.nextChange(rep, at('2026-11-01T04:00:00Z'), TOR).nextChangeAt), '2026-11-01T05:30:00.000Z');   // first 01:30 (EDT)
  });

  it('zones without DST keep a constant offset (Asia/Tokyo, UTC), and a window that wraps midnight works', () => {
    for (const [tz, expect] of [['Asia/Tokyo', '2027-03-14T10:00:00.000Z'], ['UTC', '2027-03-14T07:00:00.000Z']]) {
      assert.equal(iso(T.nextChange(AUTO, at('2027-03-14T02:00:00Z'), tz).nextChangeAt), expect, tz);
    }
    const wrap = { mode: 'auto', nightFrom: '22:00', nightTo: '06:00' };
    assert.equal(iso(T.nextChange(wrap, at('2026-07-01T23:00:00Z'), 'UTC').nextChangeAt), '2026-07-02T06:00:00.000Z');
    assert.equal(T.nextChange({ mode: 'fixed', fixed: 'night' }, at('2026-07-01T23:00:00Z'), 'UTC').nextChangeAt, null);
  });

  it('every computed boundary lands exactly on the configured local time, all year, in Toronto', () => {
    let now = at('2026-01-01T05:00:00Z');
    for (let i = 0; i < 2 * 366; i++) {
      const { nextChangeAt: next } = T.nextChange(AUTO, now, TOR);
      const hhmm = new Intl.DateTimeFormat('en-GB', { timeZone: TOR, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(next);
      assert.ok(hhmm === '19:00' || hhmm === '07:00', `${iso(now)} → ${iso(next)} (${hhmm})`);
      assert.ok(next > now);
      now = next;
    }
  });

  it('the server’s LayoutVM theme uses the same computation (src/api/v2/office-layout.js)', () => {
    const { resolveTheme } = require(path.join(ROOT, 'src/api/v2/office-layout.js'));
    const r = resolveTheme(AUTO, at('2027-03-14T00:00:00Z'), TOR);
    assert.deepEqual({ resolved: r.resolved, mode: r.mode, next: iso(r.nextChangeAt) }, { resolved: 'night', mode: 'auto', next: '2027-03-14T11:00:00.000Z' });
  });
});
