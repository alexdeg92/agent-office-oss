'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { ApiError, requestId, errorMiddleware } = require('../../src/api/v2/errors');
const { VmError, createVmCheck } = require('../../src/api/v2/vm/check');

async function request(app, path) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  try {
    const { port } = server.address();
    return await fetch(`http://127.0.0.1:${port}${path}`);
  } finally { await new Promise((resolve) => server.close(resolve)); }
}

test('every INTERNAL logs its request id and redacted stack, never its message', async () => {
  const entries = [];
  const app = express();
  app.use(requestId);
  app.get('/explicit', () => { throw new ApiError('internal'); });
  app.get('/unexpected', () => { throw new Error('secret-token-should-not-be-logged'); });
  app.get('/vm', () => { throw new VmError('health', [{ path: '$.health.secret-sentinel', parent: '$.health', detail: 'unexpected field' }]); });
  const vmCheck = createVmCheck({ mode: 'throw' });
  app.get('/vm-undefined', () => vmCheck.check('health', { sk_live_T0043_PRIVATE_SENTINEL: undefined }));
  app.use(errorMiddleware((entry) => entries.push(entry)));

  for (const path of ['/explicit', '/unexpected', '/vm', '/vm-undefined']) {
    const response = await request(app, path);
    assert.equal(response.status, 500);
    const body = await response.json();
    assert.equal(body.error.code, 'internal');
    const entry = entries.at(-1);
    assert.equal(entry.requestId, body.error.requestId);
    assert.ok(entry.stack.some((frame) => frame.includes('internal-error-logging.test.js')));
    assert.doesNotMatch(JSON.stringify(entry), /secret-token-should-not-be-logged/);
    assert.doesNotMatch(JSON.stringify(entry), /secret-sentinel/);
    assert.doesNotMatch(JSON.stringify(entry), /T0043_PRIVATE_SENTINEL/);
    if (path === '/vm-undefined') assert.equal(entry.issues[0].path, '<redacted>');
    assert.ok(entry.stack.every((frame) => !frame.includes('/')), 'stack frames contain only basenames and source coordinates');
  }
  assert.equal(entries.length, 4);
});
