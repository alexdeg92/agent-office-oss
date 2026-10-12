'use strict';
// Discovery registry: adding a detector file is sufficient; unsupported transports remain presence-only.
const fs = require('fs'), path = require('path'), os = require('os');
const { Worker, isMainThread } = require('node:worker_threads');
const detectors = () => fs.readdirSync(path.join(__dirname, 'detectors')).filter(f => f.endsWith('.js') && f !== 'helpers.js').map(f => require('./detectors/' + f));
async function scanRuntimes({ env, home }) {
  if (isMainThread) throw Error('discovery must run in a worker');
  return require('../ops/local-files').withReadBudget(() => Promise.all(detectors().map(async detector => {
    try { return await detector.detect({ env, home }); }
    catch (e) { if (['ETESTPATH', 'EDETECTIONLIMIT'].includes(e.code)) throw e; return { runtime: detector.runtime, name: detector.name, found: false, confidence: 'unreadable', agents: [], connection: null }; }
  })));
}
function detectRuntimes({ env, home = env.HOME || os.homedir(), signal, timeoutMs = 5000 }) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 5000) return Promise.reject(Error('invalid discovery deadline'));
  if (signal?.aborted) return Promise.reject(Error('detection cancelled'));
  return new Promise((resolve, reject) => {
    // No inherited preload/CLI flags. Only explicit discovery context enters the
    // worker; it owns all synchronous filesystem and parsing work.
    const worker = new Worker(path.join(__dirname, 'detection-worker.js'), { workerData: { env, home }, env: { NODE_OPTIONS: '', ...(process.env.NODE_TEST_CONTEXT ? { NODE_TEST_CONTEXT: process.env.NODE_TEST_CONTEXT } : {}) }, execArgv: [],
      resourceLimits: { maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 } });
    let done = false, deadline;
    const finish = (error, rows) => {
      if (done) return; done = true; clearTimeout(deadline); signal?.removeEventListener('abort', cancelled);
      // Await termination before releasing the single flight; neither a stalled
      // worker nor a late message can survive into the next detection pass.
      worker.terminate().then(() => error ? reject(error) : resolve(rows), reject);
    };
    const cancelled = () => finish(Error('detection cancelled'));
    deadline = setTimeout(() => finish(Error('detection timeout')), timeoutMs);
    signal?.addEventListener('abort', cancelled, { once: true });
    worker.once('message', message => message.error ? finish(Object.assign(Error('detection failed'), { code: message.error })) : finish(null, message.rows));
    worker.once('error', error => finish(error));
    worker.once('exit', () => { if (!done) finish(Error('detection worker exited')); });
    if (signal?.aborted) cancelled();
  });
}
const runtimeCatalog = () => detectors().map(({runtime,name})=>({runtime,name}));
module.exports = { detectRuntimes, runtimeCatalog, scanRuntimes };
