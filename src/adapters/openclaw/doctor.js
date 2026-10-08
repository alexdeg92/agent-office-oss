'use strict';
/*
 * G11 · the OpenClaw adapter's `agent-office doctor` checks (src/ops/doctor). Read-only: one gateway connection with the
 * operator.read scope (one listing), `openclaw --version` and one `skills list --agent <id>`. Nothing is written,
 * restarted or kept; the token goes only to the configured gateway, and nothing derived from it is printed.
 */
const fs = require('fs');
const { openclawPaths } = require('../../config');
const { loadIdentity, probeGateway } = require('./transport');
const { createCli } = require('./cli');

const REQUIRED_METHODS = ['agents.list', 'cron.list', 'sessions.list', 'channels.status', 'sessions.subscribe'];
const VERSION = /\b(\d{4}\.\d{1,2}\.\d{1,3})\b/;

async function doctor(ctx) {
  const { add, eff } = ctx;
  const { definition } = require('./index');
  const paths = ctx.cfg ? ctx.cfg : openclawPaths(eff);
  const url = (ctx.cfg && ctx.cfg.gatewayUrl) || eff.OC_GATEWAY_URL || 'ws://127.0.0.1:18793';
  const shownUrl = (() => { try { const u = new URL(url); return `${u.protocol}//${u.host}`; } catch (_) { return '(invalid URL)'; } })();
  const token = eff.OC_GATEWAY_TOKEN || null;

  const id = loadIdentity({ identityPath: paths.identityPath, stateDbPath: paths.stateDbPath });
  if (id.identity) add('runtime', 'runtime.identity', 'ok', 'runtime.identity.ok');
  else add('runtime', 'runtime.identity', token ? 'fail' : 'warn', 'runtime.identity.missing', { reason: id.missing });   // needed once a token is set

  let gatewayVersion = null, primary = eff.AO_PRIMARY_AGENT || null;
  if (!token) add('runtime', 'runtime.gateway', 'skip', 'runtime.gateway.no-token');
  else if (id.identity) {
    const r = await probeGateway({ url, token, identityPath: paths.identityPath, stateDbPath: paths.stateDbPath, timeoutMs: ctx.timeoutMs });
    if (r.status !== 'connected') add('runtime', 'runtime.gateway', 'fail', 'runtime.gateway.' + r.status, { url: shownUrl });
    else {
      const gw = r.gw;
      try {
        add('runtime', 'runtime.gateway', 'ok', 'runtime.gateway.ok', { url: shownUrl, ms: r.latencyMs });
        const hello = gw.hello || {};
        gatewayVersion = hello.server && typeof hello.server.version === 'string' && VERSION.test(hello.server.version) ? VERSION.exec(hello.server.version)[1] : null;
        const protocol = Number.isInteger(hello.protocol) ? hello.protocol : r.protocol;
        if (protocol !== 4) add('runtime', 'runtime.protocol', 'fail', 'runtime.protocol.bad', { protocol });
        else if (gatewayVersion && definition.testedWith.includes(gatewayVersion)) add('runtime', 'runtime.protocol', 'ok', 'runtime.protocol.ok', { protocol, version: gatewayVersion });
        else add('runtime', 'runtime.protocol', 'warn', 'runtime.protocol.untested', { protocol, version: gatewayVersion || '?', tested: definition.testedWith.join(', ') });
        // the scope: one read that needs operator.read
        try {
          const agents = await gw.call('agents.list', {});
          add('runtime', 'runtime.scope', 'ok', 'runtime.scope.ok');
          if (!primary && agents && typeof agents.defaultId === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(agents.defaultId)) primary = agents.defaultId;
        } catch (_) { add('runtime', 'runtime.scope', 'fail', 'runtime.scope.refused'); }
        const methods = hello.features && Array.isArray(hello.features.methods) ? hello.features.methods : null;
        const missing = methods ? REQUIRED_METHODS.filter((m) => !methods.includes(m)) : [];
        if (missing.length) add('runtime', 'runtime.methods', 'warn', 'runtime.scope.methods', { methods: missing.join(', ') });
        // the gateway refuses a device signature skewed by more than 120 s (2026.9.8)
        const c = gw.challenge;
        if (c && Number.isFinite(c.ts)) {
          const s = Math.round(Math.abs(c.receivedAt - c.ts) / 1000);
          add('runtime', 'runtime.clock', s > 120 ? 'fail' : s > 30 ? 'warn' : 'ok', s > 120 ? 'runtime.clock.fail' : s > 30 ? 'runtime.clock.warn' : 'runtime.clock.ok', { seconds: s });
        } else add('runtime', 'runtime.clock', 'skip', 'runtime.clock.unknown');
      } finally { gw.close(); }
    }
  }

  // the CLI: present, its version, and per-agent commands with --agent (CLAUDE.md: without it the CLI answers {ok:false})
  const bin = paths.openclawBin;
  let executable = false; try { fs.accessSync(bin, fs.constants.X_OK); executable = fs.statSync(bin).isFile(); } catch (_) { /* missing */ }
  if (!executable) { add('runtime', 'runtime.cli', 'warn', 'runtime.cli.missing', { path: bin }); return; }
  const cli = createCli({ bin, home: paths.openclawHome, readonly: true });
  const v = await cli.run(['--version'], 15000);
  const cliVersion = v.ok && VERSION.test(v.out) ? VERSION.exec(v.out)[1] : null;
  if (!cliVersion) add('runtime', 'runtime.cli', 'warn', 'runtime.cli.failed');
  else if (gatewayVersion && cliVersion !== gatewayVersion) add('runtime', 'runtime.cli', 'warn', 'runtime.cli.mismatch', { version: cliVersion, gateway: gatewayVersion });
  else add('runtime', 'runtime.cli', 'ok', 'runtime.cli.ok', { version: cliVersion, path: bin });
  if (!primary || !/^[A-Za-z0-9_-]{1,64}$/.test(primary)) { add('runtime', 'runtime.agent', 'skip', 'runtime.agent.unknown'); return; }
  const list = await cli.run(['skills', 'list', '--agent', primary, '--json'], 30000);
  const parsed = list.ok ? cli.parseJson(list.out) : null;
  const ok = !!parsed && parsed.ok !== false;
  add('runtime', 'runtime.agent', ok ? 'ok' : 'fail', ok ? 'runtime.agent.ok' : 'runtime.agent.failed', { agent: primary });
  await projectTag(ctx, cli, paths, primary);
}

// architect-56 · the project tag in the primary agent's workspace (src/adapters/openclaw/integration.js), read-only
async function projectTag(ctx, cli, paths, primary) {
  const { add, eff } = ctx;
  if (String(eff.AO_INTEGRATIONS || 'projet').split(',').map((x) => x.trim()).includes('none')) { add('runtime', 'runtime.projectTag', 'skip', 'runtime.projectTag.off'); return; }
  const I = require('./integration');
  const agents = await I.discoverAgents(cli, { home: paths.openclawHome });
  const agent = agents && agents.find((a) => a.id === primary);
  if (!agent) { add('runtime', 'runtime.projectTag', 'skip', 'runtime.projectTag.unknown'); return; }
  const s = I.inspect(agent, { locale: ctx.locale });
  const level = { installed: 'ok', absent: 'info', outdated: 'warn', conflict: 'warn' }[s.status] || 'warn';
  add('runtime', 'runtime.projectTag', level, 'runtime.projectTag.' + s.status, { agent: primary });
  if (s.status !== 'absent' && (await I.execPolicy(cli, primary)) === 'prompts') add('runtime', 'runtime.projectTagExec', 'warn', 'runtime.projectTag.prompts', { agent: primary });
}

module.exports = { doctor, REQUIRED_METHODS };
