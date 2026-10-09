'use strict';
// Discovery registry: adding a detector file is sufficient; unsupported transports remain presence-only.
const fs = require('fs'), path = require('path'), os = require('os');
const detectors = () => fs.readdirSync(path.join(__dirname, 'detectors')).filter(f => f.endsWith('.js') && f !== 'helpers.js').map(f => require('./detectors/' + f));
async function detectRuntimes({ env, home = env.HOME || os.homedir() }) {
  return Promise.all(detectors().map(async detector => {
    try { return await detector.detect({ env, home }); }
    catch (e) { if (e.code === 'ETESTPATH') throw e; return { runtime: detector.runtime, name: detector.name, found: false, confidence: 'unreadable', agents: [], connection: null }; }
  }));
}
module.exports = { detectRuntimes };
