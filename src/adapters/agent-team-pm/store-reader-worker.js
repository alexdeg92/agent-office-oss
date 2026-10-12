'use strict';

const { parentPort, workerData } = require('node:worker_threads');
const { projectSnapshot } = require('./store-reader');

try {
  const snapshot = projectSnapshot({ root: workerData.root, label: workerData.label, now: () => workerData.nowMs,
    includeInbox: workerData.includeInbox === true });
  const json = JSON.stringify({ ...snapshot, privateMemberRefs: snapshot.privateMemberRefs || {} });
  if (Buffer.byteLength(json) > 16 * 1024 * 1024) throw Object.assign(new Error('result limit'), { code: 'result_limit' });
  parentPort.postMessage({ ok: true, json });
} catch (error) {
  parentPort.postMessage({ ok: false, error: typeof error?.code === 'string' && /^[a-z_]{1,40}$/.test(error.code) ? error.code : 'read_failed' });
}
