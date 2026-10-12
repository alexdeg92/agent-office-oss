'use strict';
// This capability restarts only the owning API process. It never executes a
// command or controls a gateway, another service, or a container daemon.
const RESTART_EXIT_STATUS = 75;
function createHostSupervisor({ env = process.env, shutdown = null, argv = process.argv, execPath = process.execPath } = {}) {
  const managed = !!(env.AO_SUPERVISED === '1' || ['always', 'on-failure', 'unless-stopped'].includes(env.AO_RESTART_POLICY));
  const supported = managed && typeof shutdown === 'function';
  const quote = value => "'" + String(value).replace(/'/g, "'\\''") + "'";
  return { supported, command: supported ? null : argv[1] ? [execPath, ...argv.slice(1)].map(quote).join(' ') : 'agent-office',
    reason: supported ? null : { key: 'settings.restart.unsupervised' },
    restart() { if (!supported) throw Object.assign(new Error('restart unavailable'), { code: 'EUNSUPERVISED' }); shutdown(RESTART_EXIT_STATUS); } };
}
module.exports = { createHostSupervisor, RESTART_EXIT_STATUS };
