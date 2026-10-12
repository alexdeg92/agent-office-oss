'use strict';
// Office theme resolution: day / night / automatique (19:00–07:00 in the instance's time zone). Pure.
// The zone is a parameter: browser callers pass fmt.timeZone() (MetaVM.instance.timeZone, else the browser's
// zone, frontend-07 §6); omitted, Intl uses the runtime's own zone. No built-in zone.


const toMin = (hhmm) => {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
};

/** Minutes since midnight of `date` in `tz`. */
function minutesIn(date, tz = undefined) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(date);
  const get = (t) => Number(parts.find((p) => p.type === t).value);
  return get('hour') * 60 + get('minute');
}

/** True when `minutes` falls in the night window [from, to), which may wrap past midnight. */
function isNight(minutes, from = '19:00', to = '07:00') {
  const f = toMin(from), t = toMin(to);
  return f <= t ? minutes >= f && minutes < t : minutes >= f || minutes < t;
}

/**
 * mode: 'auto' | 'day' | 'night' (UiPrefs.officeTheme) or a layout theme object { mode, fixed, day, night, nightFrom, nightTo }.
 * Returns the theme id to render.
 */
function resolveTheme(mode, now = new Date(), tz = undefined) {
  const t = typeof mode === 'string' ? (mode === 'auto' ? { mode: 'auto' } : { mode: 'fixed', fixed: mode }) : mode;
  if (t.mode === 'fixed') return t.fixed ?? 'day';
  const night = isNight(minutesIn(now, tz), t.nightFrom ?? '19:00', t.nightTo ?? '07:00');
  return night ? (t.night ?? 'night') : (t.day ?? 'day');
}

// ---- Next boundary (review-16 R16-08): a zoned calendar time, never « now + a wall-clock difference ». Across a
// DST change the elapsed time between two local times is not their wall-clock difference (23 h or 25 h days).

/** Offset of `tz` from UTC at instant `ms`, in ms (local = UTC + offset). */
function zoneOffset(ms, tz = undefined) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(ms).map((x) => [x.type, x.value]));
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second);
  return asUtc - (Math.floor(ms / 1000) * 1000);
}

/** The instant of local wall time y-m-d hh:mm in `tz`. A time skipped by a spring-forward gap maps to the first
 *  instant after the gap (02:30 → 03:30 in Toronto); a repeated fall-back time maps to its first occurrence. */
function zonedInstant(y, m, d, hh, mm, tz = undefined) {
  const wall = Date.UTC(y, m - 1, d, hh, mm);
  const o1 = zoneOffset(wall, tz);
  const t1 = wall - o1;
  const o2 = zoneOffset(t1, tz);
  if (o2 === o1) {
    // Fall back: the same wall time may exist one offset-change earlier as well; take the earlier one.
    const earlier = wall - zoneOffset(t1 - 3_600_000, tz);
    return earlier < t1 && zoneOffset(earlier, tz) + earlier === wall ? earlier : t1;
  }
  const t2 = wall - o2;
  // Inside a gap neither offset reproduces the wall time: the boundary happens when the clock jumps past it.
  return zoneOffset(t2, tz) + t2 === wall ? t2 : Math.max(t1, t2);
}

/** Local calendar date (y, m, d) of instant `ms` in `tz`. */
function localDate(ms, tz) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(ms).map((x) => [x.type, x.value]));
  return [+p.year, +p.month, +p.day];
}

/**
 * The resolved theme at `now` and the instant it next changes (auto mode), both computed in the instance zone.
 * @returns {{ resolved: string, nextChangeAt: number|null }}
 */
function nextChange(theme, now = Date.now(), tz = undefined) {
  const t = typeof theme === 'string' ? (theme === 'auto' ? { mode: 'auto' } : { mode: 'fixed', fixed: theme }) : theme;
  const resolved = resolveTheme(t, new Date(now), tz);
  if (t.mode !== 'auto') return { resolved, nextChangeAt: null };
  const bounds = [t.nightFrom ?? '19:00', t.nightTo ?? '07:00'].map(toMin);
  const [y, m, d] = localDate(now, tz);
  let best = null;
  for (let k = 0; k <= 2; k++) {
    const day = new Date(Date.UTC(y, m - 1, d + k));
    for (const b of bounds) {
      const at = zonedInstant(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), Math.floor(b / 60), b % 60, tz);
      if (at > now && (best == null || at < best)) best = at;
    }
  }
  return { resolved, nextChangeAt: best };
}

module.exports = { minutesIn, isNight, resolveTheme, zoneOffset, zonedInstant, nextChange };
