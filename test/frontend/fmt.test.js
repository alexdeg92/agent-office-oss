import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fmt from '../../public/v2/fmt.js';

// The instance zone comes from MetaVM.instance.timeZone at boot (R12-08); these cases pin one explicitly.
fmt.setTimeZone('America/Toronto');

const NB = ' ';
// 2026-10-05 14:05:09 in Toronto (EDT, UTC−4)
const NOW = Date.UTC(2026, 9, 5, 18, 5, 9);

test('numbers: space thousands, comma decimals', () => {
  assert.equal(fmt.number(184302), `184${NB}302`);
  assert.equal(fmt.decimal(1.43), '1,4');
  assert.equal(fmt.percent(23), `23${NB}%`);
  assert.equal(fmt.tokens(1), `1${NB}jeton`);
  assert.equal(fmt.tokens(184302), `184${NB}302${NB}jetons`);
  assert.equal(fmt.number(null), '—');
  assert.equal(fmt.number(NaN), '—');
});

test('bytes', () => {
  assert.equal(fmt.bytes(512), `512${NB}o`);
  assert.equal(fmt.bytes(3.2 * 1024 ** 3), `3,2${NB}Go`);
});

test('durations are spelled out', () => {
  assert.equal(fmt.duration(840), `840${NB}ms`);
  assert.equal(fmt.duration(1430), `1,4${NB}s`);
  assert.equal(fmt.duration(42_000), `42${NB}s`);
  assert.equal(fmt.duration(252_000), `4${NB}min 12${NB}s`);
  assert.equal(fmt.duration(240_000), `4${NB}min`);
  assert.equal(fmt.duration(3_660_000), `1${NB}h 1${NB}min`);
  assert.equal(fmt.duration(90_061_000), `1${NB}j 1${NB}h`);
  assert.equal(fmt.duration(-1), '—');
});

test('R12-08: the instance zone from meta, never a built-in default; formatters follow a change', () => {
  const at = Date.UTC(2026, 9, 5, 20, 0);
  assert.equal(fmt.setTimeZone('Europe/Paris'), 'Europe/Paris');
  assert.equal(fmt.time(at), '22:00', 'a Paris instance sees Paris time');
  assert.equal(fmt.timeZone(), 'Europe/Paris');
  const local = Intl.DateTimeFormat().resolvedOptions().timeZone;
  assert.equal(fmt.setTimeZone(undefined), local, 'no meta zone → the browser zone');
  assert.equal(fmt.setTimeZone('Pas/Une_Zone'), local, 'an invalid zone is ignored');
  fmt.setTimeZone('America/Toronto');
  assert.equal(fmt.time(at), '16:00');
});

test('24-hour clock in Toronto time', () => {
  assert.equal(fmt.time(NOW), '14:05');
  assert.equal(fmt.time(NOW, { seconds: true }), '14:05:09');
  assert.equal(fmt.time(Date.UTC(2026, 9, 5, 4, 3)), '00:03');
});

test('relative times', () => {
  assert.equal(fmt.relative(NOW - 10_000, NOW), 'à l’instant');
  assert.equal(fmt.relative(NOW - 3 * 60_000, NOW), `il y a 3${NB}min`);
  assert.equal(fmt.relative(NOW - 2 * 3_600_000, NOW), `il y a 2${NB}h`);
  assert.equal(fmt.relative(NOW - 20 * 3_600_000, NOW), 'hier à 18:05');
  assert.match(fmt.relative(NOW - 5 * 86_400_000, NOW), /^30 sept\.$/);
  assert.equal(fmt.relative(NOW + 5 * 60_000, NOW), `dans 5${NB}min`);
});

test('dates carry the year only when it differs', () => {
  assert.match(fmt.date(NOW, NOW), /^5 oct\.$/);
  assert.match(fmt.date(Date.UTC(2025, 0, 2, 17), NOW), /^2 janv\. 2025$/);
});

test('interpolate and VM values', () => {
  assert.equal(fmt.interpolate('Dont {n} en échec', { n: 1200 }), `Dont 1${NB}200 en échec`);
  assert.equal(fmt.interpolate('Protocole v{n} {x}', { n: 4 }), 'Protocole v4 {x}');
  assert.equal(fmt.value({ n: 61, unit: 'percent' }), `61${NB}%`);
  assert.equal(fmt.value({ n: 90_000, unit: 'ms' }), `1${NB}min 30${NB}s`);
  assert.equal(fmt.value({ n: 3.2 * 1024 ** 3, unit: 'bytes' }), `3,2${NB}Go`);
  assert.equal(fmt.value({ n: 7, unit: 'count' }), '7');
  assert.equal(fmt.value(null), '—');
});

test('ISO 8601 durations', () => {
  assert.equal(fmt.parseIsoDuration('PT2M8S'), 128_000);
  assert.equal(fmt.parseIsoDuration('PT1.4S'), 1400);
  assert.equal(fmt.parseIsoDuration('P1DT2H'), 93_600_000);
  assert.equal(fmt.parseIsoDuration('PT0S'), 0);
  for (const bad of ['P', 'PT', 'nope', '2M', 'PT-1S', '']) assert.equal(fmt.parseIsoDuration(bad), null, bad);
});
