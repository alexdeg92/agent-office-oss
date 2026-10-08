'use strict';
// Host metrics: load, CPU count, memory, root disk (df), uptime, hostname.
const os = require('os');
const { execFile } = require('child_process');

function dfRoot() {
  return new Promise((resolve) => {
    execFile('df', ['-B1', '/'], { timeout: 4000 }, (err, stdout) => {
      if (err) return resolve(null);
      const line = stdout.trim().split('\n').pop().split(/\s+/);
      const total = Number(line[1]), used = Number(line[2]);
      resolve(Number.isFinite(total) ? { total, used } : null);
    });
  });
}

async function readHost() {
  const load = os.loadavg(), ncpu = os.cpus().length || 1, disk = await dfRoot();
  return {
    cpuPct: Math.min(100, Math.round((load[0] / ncpu) * 100)), load1: load[0], ncpu,
    memUsed: os.totalmem() - os.freemem(), memTotal: os.totalmem(), disk, uptimeSec: os.uptime(), host: os.hostname(),
  };
}

module.exports = { readHost, dfRoot };
