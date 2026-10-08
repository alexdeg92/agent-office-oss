'use strict';
/*
 * Preloaded into the server process under test (`node --require test/helpers/freeze-env.js server.js`)
 * so characterisation output is deterministic:
 *   - the wall clock is frozen at AO_FAKE_NOW (Date.now() and `new Date()`); timers still run;
 *   - os metrics are fixed (load, cpus, memory, uptime, hostname).
 * `df` and `systemctl` are faked through PATH (test/bin).
 */
const NOW = Number(process.env.AO_FAKE_NOW);
if (Number.isFinite(NOW) && NOW > 0) {
  const RealDate = Date;
  class FrozenDate extends RealDate {
    constructor(...args) { if (args.length === 0) super(NOW); else super(...args); }
    static now() { return NOW; }
  }
  global.Date = FrozenDate;
}

const os = require('os');
os.loadavg = () => [0.42, 0.37, 0.31];
os.cpus = () => Array.from({ length: 4 }, () => ({ model: 'fake', speed: 1000, times: { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 } }));
os.totalmem = () => 16e9;
os.freemem = () => 6e9;
os.uptime = () => 3 * 86400 + 4 * 3600 + 5;
os.hostname = () => 'fake-host';
