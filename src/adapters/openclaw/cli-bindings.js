'use strict';
// OpenClaw can run another runtime's CLI (Claude Code, Codex) as an agent backend inside the agent's
// workspace, and records the CLI session it resumes for each of its own sessions. Those runs are the
// OpenClaw agent's work; the CLI's own connector must not show them as a second agent. Only the CLI session
// ids OpenClaw recorded are claimed: never a folder, so a session started by hand in that workspace stays visible.
// Reads run in a worker (bounded time, memory, stores and rows), read-only; message text is never read.
const path = require('node:path'), { Worker } = require('node:worker_threads');
const AGENT_ID = /^[A-Za-z0-9_-]{1,128}$/;
const LIMITS = Object.freeze({ stores: 16, rowsPerStore: 2000, claims: 20000, timeoutMs: 5000 });


function readCliBindings({ stateDir, agents = [], limits = LIMITS } = {}) {
  const known = (Array.isArray(agents) ? agents : []).filter(agent => AGENT_ID.test(agent?.id || '')).slice(0, limits.stores);
  if (typeof stateDir !== 'string' || !path.isAbsolute(stateDir) || !known.length) return Promise.resolve({ sessions: [] });
  return new Promise(resolve => {
    let settled = false;
    const worker = new Worker(path.join(__dirname, 'cli-bindings-worker.js'), {
      workerData: { stateDir, agentIds: known.map(agent => agent.id), limits: { rowsPerStore: limits.rowsPerStore, claims: limits.claims } },
      env: {}, resourceLimits: { maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 16, stackSizeMb: 2 } });
    const finish = sessions => { if (settled) return; settled = true; clearTimeout(timer); void worker.terminate(); resolve({ sessions }); };
    const timer = setTimeout(() => finish([]), limits.timeoutMs); timer.unref?.();
    worker.once('message', message => finish(Array.isArray(message?.sessions) ? message.sessions : []));
    worker.once('error', () => finish([])); worker.once('exit', () => finish([]));
  });
}

module.exports = { readCliBindings, LIMITS };
