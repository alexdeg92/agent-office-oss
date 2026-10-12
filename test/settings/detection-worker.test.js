'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawn } = require('node:child_process');
for (const [mode, purpose] of [
  ['fifo', 'FIFO IDENTITY.md is refused without blocking boot discovery or HTTP'],
  ['replacement', 'regular-to-FIFO replacement is refused on the opened descriptor'],
  ['deadline', 'blocked worker is terminated at the deadline and cannot publish late'],
  ['close', 'shutdown cancels a blocked worker without cache publication'],
  ['agents', 'aggregate agent capacity rejects the whole pass and preserves the cache'],
  ['bytes', 'aggregate read capacity rejects the whole pass and preserves the cache'],
]) test('isolated discovery: ' + purpose, async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-discovery-')); t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const result = await new Promise(resolve => {
    const child = spawn(process.execPath, [path.resolve(__dirname, '../helpers/detection-worker-child.cjs'), mode], {
      cwd: path.resolve(__dirname, '../..'), env: { HOME: home, AO_TEST_SCRATCH_HOME: home, PATH: '', AO_ENV: 'test', ...(process.env.T0027_DISCOVERY_BASE ? { T0027_DISCOVERY_BASE: process.env.T0027_DISCOVERY_BASE } : {}) }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', timedOut = false;
    child.stdout.on('data', data => stdout += data); child.stderr.on('data', data => stderr += data);
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, 3000);
    child.on('exit', (code, signal) => { clearTimeout(timer); resolve({ code, signal, stdout, stderr, timedOut }); });
  });
  assert.equal(result.timedOut, false, 'synthetic discovery child blocked its deadline/HTTP: ' + result.stderr);
  assert.equal(result.code, 0, result.stderr); assert.equal(JSON.parse(result.stdout.trim()).mode, mode);
});
