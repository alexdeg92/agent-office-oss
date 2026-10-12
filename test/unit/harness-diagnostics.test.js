'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const fs = require('node:fs'), path = require('node:path');
const { startServer } = require('../helpers/harness');
const { loadScenario } = require('../helpers/scenario');

async function fixture(t) {
  const h = await startServer(loadScenario('synthetic-basic'), {
    prepare(tmp, { env }) {
      const preload = path.join(tmp, 'diagnostic-fault.cjs');
      fs.writeFileSync(preload, `
if (process.argv[1] === ${JSON.stringify(path.resolve(__dirname, '../../server.js'))}) {
  const http = require('node:http'), original = http.Server.prototype.emit;
  function crash() {
    process.stderr.write('EARLY_DIAGNOSTIC_SENTINEL\\n' + 'x'.repeat(20000) + '\\n');
    for (let i = 0; i < 40; i++) process.stderr.write('SYNTHETIC_DIAGNOSTIC_LINE_' + i + '\\n');
    Error.stackTraceLimit = 2;
    throw new Error('SYNTHETIC_HARNESS_CRASH');
  }
  http.Server.prototype.emit = function(name, ...args) {
    if (name === 'request' && args[0].url === '/synthetic-socket-reset') {
      process.stderr.write('SYNTHETIC_SOCKET_RESET\\n');
      args[0].socket.destroy(); return true;
    }
    if (name === 'request' && args[0].url === '/synthetic-partial-body') {
      process.stderr.write('SYNTHETIC_PARTIAL_BODY\\n');
      args[1].writeHead(200, { 'content-type': 'application/json', 'content-length': '1000' });
      args[1].write('{"partial":'); setTimeout(() => args[1].destroy(), 20); return true;
    }
    if (name === 'request' && args[0].url === '/synthetic-crash') {
      process.nextTick(crash); return true;
    }
    return original.call(this, name, ...args);
  };
  process.on('SIGUSR2', crash);
}
`);
      env.NODE_OPTIONS = '--require=' + preload;
    },
  });
  t.after(() => h.stop());
  return h;
}

test('harness transport failure retains its cause and reports a still-running child without retrying', async t => {
  const h = await fixture(t);
  await assert.rejects(h.get('/synthetic-socket-reset'), error => {
    assert.match(error.message, /GET \/synthetic-socket-reset failed \(still running, pid=\d+\)/);
    assert.match(error.message, /SYNTHETIC_SOCKET_RESET/);
    assert.equal(error.cause.name, 'TypeError');
    assert.equal(error.cause.cause.code, 'UND_ERR_SOCKET');
    return true;
  });
  assert.equal(h.output.split('SYNTHETIC_SOCKET_RESET').length - 1, 1, 'no request replay');
  assert.equal((await h.get('/api/v2/meta')).status, 200, 'the server is still available');
});

test('harness reports uncaught child exit code and a bounded stderr tail after readiness', async t => {
  const h = await fixture(t), closed = once(h.child, 'close');
  assert.equal(h.child.kill('SIGUSR2'), true); await closed;
  await assert.rejects(h.get('/api/v2/meta'), error => {
    assert.match(error.message, /failed \(exit code=1, pid=\d+\)/);
    assert.match(error.message, /SYNTHETIC_HARNESS_CRASH/);
    assert.doesNotMatch(error.message, /EARLY_DIAGNOSTIC_SENTINEL|SYNTHETIC_DIAGNOSTIC_LINE_0\b/);
    assert.ok(!error.message.includes(h.tmp));
    const tail = error.message.split('--- last server stderr ---\n')[1];
    assert.ok(tail.split('\n').length <= 16); assert.ok(Buffer.byteLength(tail) <= 8192);
    assert.equal(error.cause.cause.code, 'ECONNREFUSED');
    return true;
  });
});

test('harness reports a child killed by signal rather than treating null exitCode as running', async t => {
  const h = await fixture(t), closed = once(h.child, 'close');
  assert.equal(h.child.kill('SIGKILL'), true); await closed;
  await assert.rejects(h.get('/api/v2/meta'), error => {
    assert.match(error.message, /failed \(exit signal=SIGKILL, pid=\d+\)/);
    assert.equal(error.cause.cause.code, 'ECONNREFUSED');
    return true;
  });
});

test('harness diagnoses socket closure during response-body consumption without replay', async t => {
  const h = await fixture(t);
  await assert.rejects(h.get('/synthetic-partial-body'), error => {
    assert.match(error.message, /GET \/synthetic-partial-body failed \(still running, pid=\d+\)/);
    assert.match(error.message, /SYNTHETIC_PARTIAL_BODY/);
    assert.equal(error.cause.cause.code, 'UND_ERR_SOCKET');
    return true;
  });
  assert.equal(h.output.split('SYNTHETIC_PARTIAL_BODY').length - 1, 1);
  assert.equal((await h.get('/api/v2/meta')).status, 200);
});

test('harness drains crash stderr and exit status when the request sees EOF before child close', async t => {
  const h = await fixture(t);
  await assert.rejects(h.get('/synthetic-crash'), error => {
    assert.match(error.message, /GET \/synthetic-crash failed \(exit code=1, pid=\d+\)/);
    assert.match(error.message, /SYNTHETIC_HARNESS_CRASH/);
    assert.equal(error.cause.cause.code, 'UND_ERR_SOCKET');
    return true;
  });
});
