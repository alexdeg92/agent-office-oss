'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { gatewayStartupLine } = require('../../src/ops/startup-diagnostics');

test('entire startup gateway record omits markers in every URL component and malformed inputs', () => {
  const markers = ['secretUser', 'secretPassword', 'secretHost', 'secretPath', 'secretQuery', 'secretFragment', 'secretLine'];
  const inputs = [
    'wss://secretUser:secretPassword@secretHost.invalid/secretPath?token=secretQuery#secretFragment',
    'ws://127.0.0.1:18789', 'malformed secretPath\nsecretLine\r\x1b[31m', '', null, undefined,
  ];
  for (const gatewayUrl of inputs) {
    const record = gatewayStartupLine({ gatewayUrl, loginEmail: 'owner@example.invalid' });
    for (const marker of markers) assert.ok(!record.includes(marker), marker);
    assert.doesNotMatch(record, /[\x00-\x1f\x7f-\x9f\u2028\u2029]/);
    assert.equal(record, 'Gateway: endpoint omitted  ·  login: owner@example.invalid');
  }
  const cfg = { loginEmail: 'owner@example.invalid', get gatewayUrl() { throw Error('endpoint must not be inspected'); } };
  assert.equal(gatewayStartupLine(cfg), 'Gateway: endpoint omitted  ·  login: owner@example.invalid');
});

test('startup identity is single-line and the server uses the safe record', () => {
  assert.doesNotMatch(gatewayStartupLine({ loginEmail: 'owner\n\r\x1b\u2028@example.invalid' }), /[\x00-\x1f\x7f-\x9f\u2028\u2029]/);
  const source = fs.readFileSync(path.join(__dirname, '../../server.js'), 'utf8');
  assert.match(source, /console\.log\(gatewayStartupLine\(cfg\)\)/);
  assert.doesNotMatch(source, /console\.(?:log|warn|error)\([^\n]*cfg\.gatewayUrl/);
});
