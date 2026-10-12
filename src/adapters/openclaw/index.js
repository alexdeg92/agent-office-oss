'use strict';
/*
 * The OpenClaw runtime adapter (ADR-001 §3; G2: the mechanical split, no wire change).
 *
 * Everything OpenClaw-specific lives under src/adapters/openclaw/: the gateway transport and CLI, the raw
 * schemas, the normalisers, the session-key classification, the ingestion routes, and the command argv.
 * The core (src/engine, src/api, src/store) only uses this file's exports: `definition` (static: what the
 * engine needs to ingest) and `createRuntime(cfg)` (connection-bound: transport, CLI, taps, commands).
 *
 * G2 keeps today's channel ids (`gw.rpc.*`, `gw.event.*`, `cli.*`, `config.openclaw`) because they are on the
 * wire (data-quality channels, goldens). Namespacing them per adapter comes with contract 3.0 (G5).
 */
const setupSchema = require('../../schema');
const { normaliseAgents } = require('./normalise/agent');
const { normaliseCronJobs, normaliseCronRuns } = require('./normalise/cron');
const { normaliseSkills, normaliseSkillInfo } = require('./normalise/skill');
const { normaliseChannels } = require('./normalise/channel');
const { normaliseTranscript } = require('./normalise/transcript');
const { normaliseConfig } = require('./normalise/config');
const { normaliseSession } = require('./normalise/session');
const { classifySession } = require('./classify/session-kind');
const { createSessionWalker } = require('./session-walker');

const SCHEMAS = Object.assign({}, require('./schemas/gateway.v1'), require('./schemas/cli.v1'), require('./schemas/config.v1'));
const TESTED_WITH = ['2026.9.8'];

// Raw channel → canonical operation (src/engine dispatches on `op`). `prep` adapts a raw shape to what the op
// takes; `key` reads the request key (session key, job id, skill name) from the envelope.
const ctxKey = (env) => (env.context && env.context.key) || null;
const ROUTES = {
  'gw.rpc.sessions.list': { op: 'sessions.page', prep: (v, env) => ({ page: v, offset: env.context && env.context.offset }) },
  'gw.rpc.sessions.describe': { op: 'sessions.describe', prep: (v) => v.session },
  // a catalog-only event (no sessionKey) carries no row: key null, the op skips it (the adapter refreshes the groups)
  'gw.event.sessions.changed': { op: 'sessions.changed', prep: (v) => { const { sessionKey, reason, runId, ...rest } = v;
    return Object.assign(rest, { key: sessionKey || null, lastRunId: rest.lastRunId || runId || null }); } },
  'gw.rpc.sessions.groups.list': { op: 'sessionGroups' },
  'gw.rpc.agents.list': { op: 'agents' },
  'gw.rpc.cron.list': { op: 'flows' },
  'gw.rpc.cron.runs': { op: 'flowRuns', key: ctxKey },
  'cli.skills.list': { op: 'skills' },
  'cli.skills.info': { op: 'skillInfo', key: (env, v) => ctxKey(env) || v.name },
  'gw.rpc.channels.status': { op: 'channels' },
  'gw.rpc.sessions.get': { op: 'transcript', key: ctxKey },
  'config.openclaw': { op: 'config' },
  'gw.event.health': { op: 'runtimeHealth' },
  'gw.event.cron': { op: 'flowEvent', prep: (v) => ({ jobId: v.jobId || null, fired: v.action == null || v.action === 'started' }) },
  'gw.hello': { op: 'hello', prep: (v) => ({ version: v.server.version, protocol: Number.isInteger(v.protocol) ? v.protocol : null, events: (v.features && v.features.events) || [] }) },
};

// The runtime's own health signals (data-model §10 HealthSnapshot.gateway): OpenClaw reports them on the
// `health` event and in channels.status; the core's deriveHealth only sees this canonical projection.
function runtimeHealth({ healthEvent, channelsStatus }) {
  const ev = (healthEvent && healthEvent.eventLoop) || (channelsStatus && channelsStatus.eventLoop) || null;
  return {
    version: (healthEvent && healthEvent.server && healthEvent.server.version) || null,
    pluginsLoaded: healthEvent && healthEvent.plugins && Array.isArray(healthEvent.plugins.loaded) ? healthEvent.plugins.loaded.length : null,
    eventLoop: ev ? { degraded: !!ev.degraded, delayP99Ms: typeof ev.delayP99Ms === 'number' ? ev.delayP99Ms : null, utilization: typeof ev.utilization === 'number' ? ev.utilization : null } : null,
  };
}

const definition = {
  id: 'openclaw',
  name: 'OpenClaw',
  mark: { monogram: 'OC', color: '#b23a0b', providerName: 'OpenClaw', logo: 'assets/connectors/openclaw.svg' },
  testedWith: TESTED_WITH,
  schemas: SCHEMAS,
  routes: ROUTES,
  // frontend-06 (ADR §12.9): how the UI names this runtime's transport. French today; per locale in G3c.
  gatewayLabel: 'Passerelle OpenClaw',
  gatewayLabels: { fr: 'Passerelle OpenClaw', en: 'OpenClaw gateway' },   // G3c
  // OpenClaw's session-key grammar for an explicit key (`--session-key <ref>` → agent:<id>:explicit:<ref>)
  sessionKeyFor: (agentId, ref) => 'agent:' + agentId + ':explicit:' + ref,
  eventPrefix: 'gw.event.',          // unknown runtime events arrive as `${eventPrefix}<name>` (event.unknown)
  normalise: { agents: normaliseAgents, flows: normaliseCronJobs, flowRuns: normaliseCronRuns, skills: normaliseSkills, skillInfo: normaliseSkillInfo,
    channels: normaliseChannels, transcript: normaliseTranscript, config: normaliseConfig, session: normaliseSession, runtimeHealth,
    // S7b: the catalog in display order; membership comes from Session.group. OpenClaw's catalog is keyed by name
    // (session_groups has no id column; a rename rewrites the members' category), so its stable group id IS the name.
    sessionGroups: (v) => v.groups.slice().sort((a, b) => a.position - b.position || a.name.localeCompare(b.name)).map((g) => ({ id: g.name, name: g.name, position: g.position })) },
  classifySession,
  // architect-54: the project tag, from the no-op `projet` tool calls in a canonical transcript (never from message text)
  resolveSender: require('./sender').resolveSender,
  stripEnvelope: require('./sender').stripEnvelope,
  projectHints: (transcript) => require('./project-hint').projectHintsOf(transcript),
  // architect-55: trace events no view shows (the project-tag call is metadata only)
  hiddenTraceEvent: (ev) => require('./project-hint').isProjectTagEvent(ev),
  // What this runtime can do (ADR-001 §3). G2 reports today's behaviour; the UI starts reading it in 3.0.
  capabilities: () => ({ sessions: true, transcripts: true, senderCapture: true, activity: 'run-state',
    // G5: flows.multiAgent, since `cron add` takes --agent (api-v3.md D7)
    flows: { read: true, write: true, schedules: ['cron', 'every', 'at'], multiAgent: true }, skills: { read: true, toggle: true, detail: true },
    channels: true, interlocutors: true, chat: true, restart: true, costs: true, subagents: true, sessionGroups: true }),
};

const GROUPS_REFRESH_MS = 60 * 1000;
const { every } = require('../../ops/timescale');

// Connection-bound parts, built at the composition root (server.js).
function createRuntime(cfg, { senderCaptures = null, cliEnv } = {}) {
  const { Gateway } = require('./transport');
  const { createCli } = require('./cli');
  const { tapGateway, tapCli } = require('./taps');
  const commands = require('./commands');
  const { bind: bindReads } = require('./reads');
  const { createSkillDocReader } = require('./skill-doc');
  const gw = new Gateway({ url: cfg.gatewayUrl, gatewayToken: cfg.gatewayToken, identityPath: cfg.identityPath, stateDbPath: cfg.stateDbPath });
  const cli = createCli({ bin: cfg.openclawBin, home: cfg.openclawHome, readonly: cfg.readonly,
    env: { ...(cliEnv || process.env), OC_GATEWAY_URL: cfg.gatewayUrl, OC_GATEWAY_TOKEN: cfg.gatewayToken || '',
      OPENCLAW_GATEWAY_URL: cfg.gatewayUrl, OPENCLAW_GATEWAY_TOKEN: cfg.gatewayToken || '', OPENCLAW_GATEWAY_PASSWORD: '' } });
  const reads = bindReads({ gw, cli });   // §12.4: every read here has its capability true
  const capture = senderCaptures && cfg.senderCapture !== false && !cfg.readonlyStore ? require('./sender-capture').createSenderCapture(senderCaptures) : null;
  let sessionsListFailure = null, retrySessionsList = async () => ({ ok: false, category: 'not-started' });
  const boundDefinition = { ...definition,
    capabilities: () => { const caps = definition.capabilities(); return { ...caps, senderCapture: !!capture, restart:!!caps.restart && commands.restartableUrl(cfg.gatewayUrl) }; },
    normalise: { ...definition.normalise, transcript: (key, value, at, window, issue, ctx = {}) => {
      if (capture) { try { capture.observe(key, value.messages, ctx.session); } catch {} }
      return normaliseTranscript(key, value, at, window, issue, { ...ctx, capturedSender: capture?.lookup });
    }, agents: (value) => normaliseAgents(value, require('./agent-settings').readAgentSettings(cfg.openclawConfigPath)) },
    resolveSender: (raw, ctx = {}) => definition.resolveSender(raw, { ...ctx, capturedSender: capture?.lookup }),
    health: {
      checks: () => sessionsListFailure ? [{ id: 'session-sync', severity: 'warn', causeCode: sessionsListFailure, textKey: `healthCheck.sessionSync.${sessionsListFailure}`,
        impactKey: 'healthImpact.sessions', remedy: 'auto', actionId: 'retry-session-sync' }] : [],
      remedies: { 'retry-session-sync': (context, options) => retrySessionsList(context, options) },
    },
  };
  let stopCapture = null, disposed = false, nextSourceOrder = null;
  let groupsTimer = null, groupsSoon = null, attached = null, sessionWalker = null;
  const loops = [];
  // R1-11: SKILL.md bodies, read only inside OpenClaw's documented skill roots (agent workspaces from the engine)
  const skillDocs = createSkillDocReader({ home: cfg.openclawHome, bin: cfg.openclawBin,
    workspaces: () => (attached ? attached.agents().map((a) => a.workspace).filter(Boolean) : []) });
  return {
    definition: boundDefinition, gw, cli, reads,
    updateConnection: (pair) => gw.updateConnection(pair),
    attach(engine) {
      attached = engine;
      nextSourceOrder = tapGateway(gw, engine).nextSourceOrder; tapCli(cli, engine); engine.setReads(reads);
      stopCapture = capture?.watch(gw, (key) => engine.session(key));
      // S7b: the session-group catalog changes rarely: read it on connect, every GROUPS_REFRESH_MS while connected,
      // and shortly after a catalog-only `sessions.changed` ({reason: 'groups'}, no sessionKey).
      const refreshGroups = () => { if (gw.connected) engine.request('sessionGroups').catch(() => {}); };
      gw.on('open', refreshGroups);
      gw.on('gwevent', (event, payload) => {
        if (event !== 'sessions.changed' || !payload || payload.sessionKey || payload.reason !== 'groups') return;
        clearTimeout(groupsSoon); groupsSoon = setTimeout(refreshGroups, 500); if (groupsSoon.unref) groupsSoon.unref();
      });
      groupsTimer = setInterval(refreshGroups, every(GROUPS_REFRESH_MS)); if (groupsTimer.unref) groupsTimer.unref();
    },
    close() { disposed=true; sessionWalker?.invalidate(); gw.close(); stopCapture?.(); clearInterval(groupsTimer); clearTimeout(groupsSoon); for (const t of loops) clearInterval(t); },
    /**
     * The runtime's own read loops (moved out of the v1 legacy runtime at S16 prep, same order and periods). Every read
     * goes through the taps. `hooks.refreshed()` runs after each full refresh (interlocutor enrichment).
     */
    start(engine, hooks = {}) {
      if (disposed) return;
      const call = (m, p) => gw.call(m, p).catch(() => null);
      // every page of sessions.list (R2-02); a failed or stalled page stops the walk (the snapshot is then incomplete)
      sessionWalker = createSessionWalker({ gw, nextAcquisitionGeneration: nextSourceOrder,
        onFailure: category => { sessionsListFailure = category; attached?.notifyHealth?.(); },
        onSuccess: () => { sessionsListFailure = null; attached?.notifyHealth?.(); },
      });
      const listAllSessions = options => sessionWalker.walk(options);
      retrySessionsList = async (_context, { signal } = {}) => {
        const page = await listAllSessions({ signal });
        return { ok: !!page, category: sessionsListFailure };
      };
      const refreshAll = () => Promise.all([call('agents.list', {}), call('cron.list', {}), listAllSessions(), call('channels.status', {})]);
      const { readOpenclawConfig } = require('./config-source');
      const readConfig = () => engine.ingest({ source: 'config', channel: 'config.openclaw', receivedAt: Date.now(), body: readOpenclawConfig(cfg.openclawConfigPath) });
      const fire = (name, ...args) => { try { if (hooks[name]) hooks[name](...args); } catch (e) { console.log('[hook]', e.message); } };
      gw.on('open', async () => {
        await refreshAll();
        if (disposed) return;
        fire('refreshed');
        this.refreshSkills();   // the listing is known now: the resolver has a primary
        call('sessions.subscribe', {}); call('sessions.messages.subscribe', {});
      });
      gw.on('log', (m) => console.log('[gw]', m));
      gw.on('gwevent', (event, payload) => {
        if (event === 'cron') call('cron.list', {});
        if (event === 'sessions.changed') listAllSessions();
      });
      gw.start();
      readConfig(); this.refreshSkills();
      loops.push(setInterval(() => { if (engine.gateway().connected) refreshAll().then(() => fire('refreshed')); }, every(10000)));
      loops.push(setInterval(readConfig, every(60000)));
      loops.push(setInterval(() => this.refreshSkills(), every(120000)));
      for (const t of loops) if (t.unref) t.unref();
    },
    skillDoc: (filePath) => skillDocs.read(filePath),
    commands: commands.bind(cli, { gw, gatewayUrl:cfg.gatewayUrl, readonly: !!cfg.readonly }),
    // S7c: re-reads after a write (ingested by the taps)
    refreshFlows: () => gw.call('cron.list', {}).catch(() => null),
    // G3a: the resolver's primary; without one (no listing yet) nothing is read
    refreshSkills: () => { const a = !disposed && attached && attached.primaryAgent(); return a ? cli.run(['skills', 'list', '--agent', a.id, '--json'], 30000, { freshness: true }) : Promise.resolve({ ok: false, refused: 'agent-unknown' }); },
  };
}

// G11: `agent-office doctor`'s runtime checks (read-only)
const doctor = (ctx) => require('./doctor').doctor(ctx);

// architect-56: the project-tag installer (src/adapters/openclaw/integration.js) with a CLI bound to the runtime's paths
const projectTag = () => Object.assign({}, require('./integration'), {
  cli: ({ openclawBin, openclawHome, readonly = false, env }) => require('./cli').createCli({ bin: openclawBin, home: openclawHome, readonly, env }) });

const setup = { connect: true, capabilities: { brand: { mark: 'OC', color: '#b54d31', foreground: '#ffffff', providerName: 'OpenClaw', logo: 'assets/connectors/openclaw.svg' } },
  env: ({ runtime, token }) => ({ OC_GATEWAY_URL: runtime.openclaw.gatewayUrl, ...(token ? { OC_GATEWAY_TOKEN: token } : {}) }),
  overrideEnv({ env, runtime, effective }) {
    const { cleanUrl } = require('./connection');
    if (env.OC_GATEWAY_URL !== undefined && env.OC_GATEWAY_TOKEN === undefined &&
        cleanUrl(env.OC_GATEWAY_URL) !== cleanUrl(runtime.openclaw.gatewayUrl)) delete effective.OC_GATEWAY_TOKEN;
  },
  configSchema: setupSchema.object({ adapter: setupSchema.literal('openclaw'), openclaw: setupSchema.object({ gatewayUrl: setupSchema.string().refine(url => /^wss?:\/\/[^\s/?#]+(?:\/[^\s]*)?$/.test(url), 'ws(s) URL') }, { extra: 'reject' }) }, { extra: 'reject' }), credential: require('./connection').credential, name: 'OpenClaw', fields: ['gatewayUrl', 'token'], defaultGatewayUrl: 'ws://127.0.0.1:18789',
  config: (rt) => ({ adapter: definition.id, openclaw: { gatewayUrl: rt.gatewayUrl } }),
  probe: (opts) => require('./transport').probeGateway(opts) };
setup.discover = async ({ gw, detected = [] }) => {
  const listing = await gw.call('agents.list', {});
  return (Array.isArray(listing?.agents) ? listing.agents : []).filter(a => a && /^[A-Za-z0-9_-]{1,64}$/.test(a.id || '')).map(a => {
    const local = detected.find(d => d.id === a.id);
    const name = local?.name || (typeof a.name === 'string' && a.name.trim() ? a.name.trim().slice(0, 80) : null);
    return { id: a.id, name, nameSource: local?.name ? local.nameSource : name ? 'runtime' : null, isPrimary: listing.defaultId === a.id,
      model: typeof a.model === 'string' ? a.model : typeof a.model?.primary === 'string' ? a.model.primary : null };
  });
};
setup.integrationTargets = ctx => require('./agent-targets').targets(ctx);
setup.integrationAgents = async ({ paths, agents, env }) => {
  const local = setup.integrationTargets({ paths, env });
  if (local.length) return local;
  if (agents?.some(a => a.workspace)) return agents.filter(a => a.workspace);
  if (!paths.openclawBin || !paths.openclawHome) return [];
  const I = projectTag();
  const agentsFromCli = await I.discoverAgents(I.cli({ ...paths, env }), { home: paths.openclawHome }) || [];
  return agentsFromCli.map(a => ({ ...a, workspace: require('path').resolve(paths.openclawHome, a.workspace) }));
};
// Settings asks the adapter for descriptors, effective values and validated connection pairs.
setup.settings = {
  detectionIdentity: ({ cfg, entry, detection }) => detection
    ? { paths: detection.checkedPaths?.slice(0, 1), gateways: [detection.connection?.gatewayUrl] }
    : { paths: !entry || entry.id === 'legacy' ? [cfg.openclawConfigPath] : [], gateways: [cfg.gatewayUrl] },
  probe: ({ runtime, paths, probe }) => (probe || setup.probe)({ url: runtime.gatewayUrl, token: runtime.token, identityPath: paths.identityPath, stateDbPath: paths.stateDbPath }),
  secret: runtime => runtime.token,
  detectedValues: detected => ({ gatewayUrl: detected.connection?.gatewayUrl, token: detected.secret }),
  fields: [
    { id: 'gatewayUrl', label: { key: 'settings.field.gatewayUrl' }, type: 'url', required: true, writeOnly: false, options: [] },
    { id: 'token', label: { key: 'settings.field.token' }, type: 'secret', required: true, writeOnly: true, options: [] },
  ],
  envKeys: { gatewayUrl: 'OC_GATEWAY_URL', token: 'OC_GATEWAY_TOKEN' },
  values: cfg => ({ gatewayUrl: cfg.gatewayUrl, token: cfg.gatewayToken }),
  resolve(input, current = {}) {
    const C = require('./connection');
    const raw = input.gatewayUrl;
    const url = C.cleanUrl(raw);
    if (!url || url !== raw || raw.length > 2048 || !/^wss?:\/\/[^\s/?#]+(?:\/[^\s]*)?$/.test(raw)) throw Object.assign(new Error('invalid connection'), { field: 'runtime.gatewayUrl' });
    const token = input.token === undefined && url === current.gatewayUrl ? current.token : input.token;
    if (typeof token !== 'string' || !token || token.length > 4096) throw Object.assign(new Error('credential required for destination'), { field: 'runtime.token' });
    return { adapter: 'openclaw', gatewayUrl: url, token };
  },
};
const detect = (ctx) => require('../detectors/openclaw').detect(ctx);
module.exports = { paths: require('./paths').paths, definition, createRuntime, runtimeHealth, ROUTES, doctor, projectTag, setup, detect };
