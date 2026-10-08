// The only formatting module (api.md §1): fr-CA or en-CA (setLocale), 24-hour clock, the INSTANCE's time zone.
// Every function accepts an optional `now` (ms) so output is deterministic in tests.
// Time zone (review-12 R12-08, ADR-001 §12): MetaVM.instance.timeZone, applied with setTimeZone() at boot. Until
// then (and when meta has none) the browser's own zone; never a hard-coded installation zone.

// Words the formatters write, per UI language (F6: fr + en). Everything else comes from Intl.
const WORDS = {
  fr: { justNow: 'à l’instant', agoMin: 'il y a {n} min', agoH: 'il y a {n} h', yesterdayAt: 'hier à {t}', inMin: 'dans {n} min', inDur: 'dans {d}',
    token: ['jeton', 'jetons'], bytes: ['o', 'Ko', 'Mo', 'Go', 'To'], day: 'j', pct: ' %' },
  en: { justNow: 'just now', agoMin: '{n} min ago', agoH: '{n} h ago', yesterdayAt: 'yesterday at {t}', inMin: 'in {n} min', inDur: 'in {d}',
    token: ['token', 'tokens'], bytes: ['B', 'KB', 'MB', 'GB', 'TB'], day: 'd', pct: '%' },
};
export let LOCALE = 'fr-CA';
let W = WORDS.fr;
let nf, nf1;

const isZone = (z) => { try { return typeof z === 'string' && !!z && !!new Intl.DateTimeFormat('en', { timeZone: z }); } catch { return false; } };
const localZone = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; } };
let zone, timeF, timeSecF, dayF, dayYearF, ymdF, dayLongF, longF, longYearF;
/** Sets the UI locale ('fr-CA' | 'en-CA'); formatters are rebuilt. Unknown → fr-CA. */
export function setLocale(l) {
  LOCALE = l === 'en-CA' ? 'en-CA' : 'fr-CA';
  W = WORDS[LOCALE.slice(0, 2)];
  nf = new Intl.NumberFormat(LOCALE, { maximumFractionDigits: 0 });
  nf1 = new Intl.NumberFormat(LOCALE, { maximumFractionDigits: 1 });
  return build();
}
/** Sets the zone every date and time is shown in; formatters are rebuilt. Invalid or empty → the browser's zone. */
export function setTimeZone(z) {
  zone = isZone(z) ? z : localZone();
  return build();
}
function build() {
  timeF = new Intl.DateTimeFormat(LOCALE, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: zone });
  timeSecF = new Intl.DateTimeFormat(LOCALE, { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23', timeZone: zone });
  dayF = new Intl.DateTimeFormat(LOCALE, { day: 'numeric', month: 'short', timeZone: zone });
  dayYearF = new Intl.DateTimeFormat(LOCALE, { day: 'numeric', month: 'short', year: 'numeric', timeZone: zone });
  ymdF = new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit', timeZone: zone });
  dayLongF = new Intl.DateTimeFormat(LOCALE, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: zone });
  longF = new Intl.DateTimeFormat(LOCALE, { weekday: 'long', day: 'numeric', month: 'long', timeZone: zone });
  longYearF = new Intl.DateTimeFormat(LOCALE, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: zone });
  return zone;
}
const fill = (tpl, p) => tpl.replace(/\{(\w)\}/g, (_, k) => p[k]);
/** The active IANA zone (form defaults, the office's day/night). */
export const timeZone = () => zone;
zone = localZone();
setLocale('fr-CA');

// Intl uses U+202F/U+00A0 as group and percent separators; keep them (they don't wrap) but normalise to U+00A0
// so tests and copy-paste are predictable.
const nbsp = (s) => s.replace(/[  ]/g, ' ');
const isNum = (n) => typeof n === 'number' && Number.isFinite(n);

/** 184302 → « 184 302 ». null → « — ». */
export function number(n) { return isNum(n) ? nbsp(nf.format(n)) : '—'; }
/** 1.43 → « 1,4 ». */
export function decimal(n) { return isNum(n) ? nbsp(nf1.format(n)) : '—'; }
/** 23 → « 23 % » (value already in percent). */
export function percent(n) { return isNum(n) ? nbsp(nf.format(n)) + W.pct : '—'; }
/** « 184 302 jetons », « 1 jeton ». */
export function tokens(n) { return isNum(n) ? `${number(n)} ${W.token[Math.abs(n) === 1 ? 0 : 1]}` : '—'; }
/** Bytes → « 3,2 Go » (base 1024, French units). */
export function bytes(n) {
  if (!isNum(n)) return '—';
  const units = W.bytes;
  let i = 0, v = n;
  while (Math.abs(v) >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${i === 0 ? number(v) : decimal(v)} ${units[i]}`;
}

/** Durations are spelled out (README §2): 1430 → « 1,4 s », 252000 → « 4 min 12 s », 90061000 → « 1 j 1 h ». */
export function duration(ms) {
  if (!isNum(ms) || ms < 0) return '—';
  if (ms < 1000) return `${number(Math.round(ms))} ms`;
  if (ms < 10_000) return `${decimal(Math.floor(ms / 100) / 10)} s`;
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  const parts = d ? [[d, W.day], [h, 'h']] : h ? [[h, 'h'], [m, 'min']] : m ? [[m, 'min'], [sec, 's']] : [[sec, 's']];
  return parts.filter(([v], i) => i === 0 || v > 0).map(([v, u]) => `${v} ${u}`).join(' ');
}

/** « 14:05 » (or « 14:05:09 ») in Toronto time. fr-CA's Intl default is « 14 h 05 », so build it from parts. */
export function time(at, { seconds = false } = {}) {
  if (!isNum(at)) return '—';
  const parts = Object.fromEntries((seconds ? timeSecF : timeF).formatToParts(at).map((p) => [p.type, p.value]));
  return [parts.hour, parts.minute, seconds ? parts.second : null].filter(Boolean).join(':');
}

function ymd(at) { return ymdF.format(at); }
/** The instance-zone calendar day of `at` as 'YYYY-MM-DD' (Carnet groups sessions by it). */
export const dayKey = (at) => (isNum(at) ? ymd(at) : null);
/** Parts of the instance-zone date for a date folio: { weekday: 'lundi', day: '05', month: 'octobre', year: '2026' }. */
export function dayParts(at) {
  if (!isNum(at)) return null;
  const p = Object.fromEntries(dayLongF.formatToParts(at).map((x) => [x.type, x.value]));
  return { weekday: p.weekday, day: String(p.day).padStart(2, '0'), month: p.month, year: p.year };
}
/** « lundi 5 octobre » / « Monday, October 5 » (with the year when it isn't the current year). */
export function longDate(at, now = Date.now()) {
  if (!isNum(at)) return '—';
  return (ymd(at).slice(0, 4) === ymd(now).slice(0, 4) ? longF : longYearF).format(at);
}
/** 0 for today, 1 for yesterday, … in the instance zone (calendar days, not 24 h windows). */
export function daysAgo(at, now = Date.now()) {
  if (!isNum(at)) return null;
  const d = (x) => Date.UTC(...ymd(x).split('-').map((n, i) => (i === 1 ? +n - 1 : +n)));
  return Math.round((d(now) - d(at)) / 86_400_000);
}

/** Relative time (README §2): « à l'instant », « il y a 3 min », « il y a 2 h », « hier », else a date. */
export function relative(at, now = Date.now()) {
  if (!isNum(at)) return '—';
  const diff = now - at;
  if (diff < 0) return future(-diff);
  if (diff < 45_000) return W.justNow;
  if (diff < 3_600_000) return fill(W.agoMin, { n: Math.max(1, Math.round(diff / 60_000)) });
  if (ymd(at) === ymd(now)) return fill(W.agoH, { n: Math.round(diff / 3_600_000) });
  if (ymd(at) === ymd(now - 86_400_000)) return fill(W.yesterdayAt, { t: time(at) });
  return date(at, now);
}
function future(diff) {
  if (diff < 45_000) return W.justNow;
  if (diff < 3_600_000) return fill(W.inMin, { n: Math.max(1, Math.round(diff / 60_000)) });
  return fill(W.inDur, { d: duration(diff) });
}

/** « 5 oct. », with the year when it isn't the current year. */
export function date(at, now = Date.now()) {
  if (!isNum(at)) return '—';
  const sameYear = ymd(at).slice(0, 4) === ymd(now).slice(0, 4);
  return nbsp((sameYear ? dayF : dayYearF).format(at));
}

/** « 5 oct., 14:05 ». */
export function dateTime(at, now = Date.now()) { return isNum(at) ? `${date(at, now)}, ${time(at)}` : '—'; }

/** Fills « {n} » style placeholders in a label; numbers go through `number()`. */
export function interpolate(label, params = {}) {
  return String(label).replace(/\{(\w+)\}/g, (m, k) => (k in params ? (isNum(params[k]) ? number(params[k]) : String(params[k])) : m));
}

/** Formats a `{n, unit}` value from a view model. Unknown units fall back to the bare number. */
export function value(v) {
  if (!v || !isNum(v.n)) return '—';
  switch (v.unit) {
    case 'percent': return percent(v.n);
    case 'ms': return duration(v.n);
    case 'bytes': return bytes(v.n);
    case 'tokens': return tokens(v.n);
    case 'count': default: return number(v.n);
  }
}

/** ISO 8601 duration (« PT2M8S », « P1DT2H », « PT1.4S ») → ms, or null when it isn't one. */
export function parseIsoDuration(s) {
  const m = /^P(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(String(s));
  if (!m || s === 'P' || s.endsWith('T')) return null;
  const [, d = 0, h = 0, mi = 0, se = 0] = m;
  return Math.round(((+d * 24 + +h) * 60 + +mi) * 60_000 + +se * 1000);
}
