'use strict';
/*
 * Shadow-mode taps (S2): feed the engine the exact inputs the legacy runtime receives, without
 * changing what the legacy code sees. Only ingestion reads are tapped; writes are not ingestion.
 */
const INGESTED_RPCS = new Set(['agents.list', 'sessions.list', 'sessions.describe', 'sessions.get', 'sessions.usage', 'cron.list', 'cron.runs', 'channels.status', 'sessions.groups.list']);
const PARAM_KEY = { 'sessions.get': 'key', 'sessions.describe': 'key', 'cron.runs': 'jobId' };

function tapGateway(gw, engine) {
  const call = gw.call.bind(gw);
  let sourceOrder = 0;
  const nextSourceOrder = () => ++sourceOrder;
  gw.call = async (method, params, local = undefined) => {   // `local` is ours (never sent): { background }
    if (!INGESTED_RPCS.has(method)) return call(method, params);
    const key = PARAM_KEY[method] && params ? params[PARAM_KEY[method]] : undefined;
    // sessions.list is paginated: the request offset tells the registry where a page belongs (R2-02)
    const offset = method === 'sessions.list' && params && Number.isInteger(params.offset) ? params.offset : 0;
    const requestOrder = nextSourceOrder();
    const acquisitionGeneration = method === 'sessions.list'
      ? (Number.isSafeInteger(local?.acquisitionGeneration) ? local.acquisitionGeneration : requestOrder) : undefined;
    const context = { key, offset, sourceOrder: requestOrder };
    if (acquisitionGeneration !== undefined) context.acquisitionGeneration = acquisitionGeneration;
    const env = { source: 'gateway', channel: 'gw.rpc.' + method, receivedAt: Date.now(), context };
    try {
      const payload = await call(method, params);
      if (!local?.shouldIngest || local.shouldIngest()) safeIngest(engine, Object.assign(env, { body: { kind: 'json', value: payload } }));
      return payload;
    } catch (e) {
      if (!(local && local.background) && (!local?.shouldIngest || local.shouldIngest())) safeIngest(engine, Object.assign(env, { body: { kind: 'error', message: e.message } }));
      throw e;
    }
  };
  // R1-03: the transport state is part of freshness; polling stops while disconnected.
  gw.on('close', () => engine.setGatewayConnected(false));
  gw.on('not-configured', (reason) => engine.setRuntimeNotConfigured(reason));   // §12.1: never connects
  gw.on('open', (hello) => {
    engine.setGatewayConnected(true);
    if (!hello) return;
    safeIngest(engine, { source: 'gateway', channel: 'gw.hello', receivedAt: Date.now(), body: { kind: 'json', value: hello } });
    engine.setOpenclawVersion(hello.server && hello.server.version);
  });
  gw.on('gwevent', (event, payload) => {
    safeIngest(engine, { source: 'gateway', channel: 'gw.event.' + event, receivedAt: Date.now(), context: { sourceOrder: nextSourceOrder() }, body: { kind: 'json', value: payload } });
  });
  return { nextSourceOrder };
}

function tapCli(cli, engine) {
  const run = cli.run;
  cli.run = async (args, timeoutMs, local = {}) => {
    const r = await run(args, timeoutMs, local);
    const channel = args[0] === 'skills' && args[1] === 'list' ? 'cli.skills.list' : args[0] === 'skills' && args[1] === 'info' ? 'cli.skills.info' : null;
    if (channel && !r.refused && !local.background) {
      const body = r.out ? { kind: 'text', value: r.out } : { kind: 'error', message: r.err || 'no output' };
      // R1-05: the process outcome travels with the output; a failed process is never "fresh".
      const outcome = { ok: !!r.ok, exitCode: Number.isInteger(r.code) ? r.code : null, stderr: !!(r.err && r.err.trim()) };
      safeIngest(engine, { source: 'cli', channel, receivedAt: Date.now(), context: { key: channel === 'cli.skills.info' ? args[2] : undefined }, body, outcome });
    }
    return r;
  };
}

// The engine must never break the legacy path in shadow mode.
function safeIngest(engine, env) { try { engine.ingest(env); } catch (e) { console.log('[engine]', e.message); } }

module.exports = { tapGateway, tapCli, INGESTED_RPCS };
