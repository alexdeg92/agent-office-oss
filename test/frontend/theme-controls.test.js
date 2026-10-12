import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readTime, clockTime, snapTime, nightMinutes, nightSegments } from '../../public/v2/office/theme-controls.js';
test('night controls: strict 24h fields, quarter hours and midnight wrapping', () => {
  assert.equal(readTime('19:00'), 1140); assert.equal(readTime('00:00'), 0);
  for (const value of ['7:00', '24:00', '12:60', '', '07:00 PM']) assert.equal(readTime(value), null);
  assert.equal(clockTime(snapTime(1439)), '00:00'); assert.equal(clockTime(snapTime(430)), '07:15');
  assert.equal(nightMinutes('19:00', '07:00'), 720);
  assert.deepEqual(nightSegments('19:00', '07:00'), [[0, 420], [1140, 1440]]);
  assert.deepEqual(nightSegments('07:00', '19:00'), [[420, 1140]]);
  assert.equal(nightMinutes('00:00', '00:00'), 0); assert.deepEqual(nightSegments('00:00', '00:00'), []);
});
