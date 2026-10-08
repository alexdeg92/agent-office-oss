'use strict';
// G10: AO_TIME_SCALE compresses the periodic loops for the test instance only; every other instance runs at scale 1.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { timeScale } = require('../../src/ops/timescale');

describe('G10 · the loop time scale is a test-instance knob only', () => {
  it('honoured for AO_ENV=test, within 1..1000', () => {
    assert.equal(timeScale({ AO_ENV: 'test', AO_TIME_SCALE: '30' }), 30);
    assert.equal(timeScale({ AO_ENV: 'test' }), 1);
    for (const bad of ['0', '0.5', '-3', '1001', 'fast', '']) assert.equal(timeScale({ AO_ENV: 'test', AO_TIME_SCALE: bad }), 1, bad);
  });
  it('ignored by production, staging and dev', () => {
    for (const AO_ENV of ['production', 'staging', 'dev', undefined]) assert.equal(timeScale({ AO_ENV, AO_TIME_SCALE: '30' }), 1, String(AO_ENV));
  });
});
