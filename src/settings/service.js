'use strict';
const fs = require('node:fs');
const IC = require('../instance-config'), { tryLoadConfig } = require('../config');
const { adapterById, ADAPTER_IDS, detectRuntimes, defaultAutoAdd, settingsBrand, sourceBrand } = require('../adapters');
const { digest } = require('../ops/config-publisher');
const { ApiError, invalid } = require('../api/v2/errors');
const { hashPassword } = require('../security/password');
const { networkConfig } = require('../ops/onboarding-network');
const { createSetupIntegrations } = require('../ops/setup-integrations');
const label = (key, params) => ({ key: 'settings.' + key, ...(params ? { params } : {}) });
const forbidden = (issue, field) => new ApiError('forbidden', { details: [{ issue, ...(field ? { field } : {}) }] });
const conflict = () => new ApiError('conflict', { details: [{ issue: 'settings-revision' }] });
function body(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid(null, 'invalid-body');
  for (const key of Object.keys(value)) if (!keys.includes(key)) throw invalid(null, 'unexpected-field');
  return value;
}
const text = (value, field, max = 80) => { if (typeof value !== 'string' || !value.trim() || value.length > max) throw invalid(field, 'invalid'); return value.trim(); };
const { scopedId, parseId, INSTANCE_ID } = require('../runtime-ids');
const { DEFAULT_SESSION_PRESENCE_WINDOW_MS, DEFAULT_AGENT_PRESENCE_WINDOW_MS } = require('../engine/derive/occupants');
const OFFICE_TIMINGS = Object.freeze([
  { key: 'finishedSessionWindowMinutes', env: 'AGENT_OFFICE_SESSION_PRESENCE_WINDOW_MS', default: DEFAULT_SESSION_PRESENCE_WINDOW_MS / 60000, unit: 'ms' },
  { key: 'agentPresenceWindowMinutes', env: 'AGENT_OFFICE_AGENT_PRESENCE_WINDOW_MS', default: DEFAULT_AGENT_PRESENCE_WINDOW_MS / 60000, unit: 'ms' },
  { key: 'idleRelocationMinutes', env: 'AGENT_OFFICE_IDLE_RELOCATION_MINUTES', default: 15, unit: 'minutes' },
]);
function validOfficeEnv(raw, unit) {
  if (raw === undefined || raw === '') return null;
  const value = Number(raw), minutes = unit === 'ms' ? value / 60000 : value;
  return Number.isSafeInteger(value) && Number.isSafeInteger(minutes) && minutes >= 1 && minutes <= 1440 ? minutes : null;
}
function createSettings({ env, files: initialFiles, cfg, store, auth, controller = null, engine,
  paths, detect = null, probe = null, elapsed = () => Number(process.hrtime.bigint() / 1000000n), now = Date.now, derivePassword = hashPassword,
  supervisor = null, orchestratorTeams = null, bootId = cfg.bootId || require('../ops/boot-identity').BOOT_ID,
  changed = () => {}, readBuild = () => ({ buildId: null }) }) {
  let publishedDigest = digest(initialFiles.config || null);
  let files = cfg.runtimeInstances && initialFiles.config?.version === 2 ? { ...initialFiles, ...IC.upgradeV2(initialFiles.config, initialFiles.secrets) } : initialFiles;
  const discovery = require('./detection-state').createDetectionState({ store, env, now, writable: () => !cfg.readonlyStore,
    detect: context => {
      if (!detect && (env.AO_ENV === 'test' || process.env.NODE_TEST_CONTEXT)) throw Object.assign(new Error('Settings tests require an injected detector'), { code: 'ETESTDETECT' });
      return (detect || detectRuntimes)(context);
    }, changed: () => changed({ revision: revision(), changed: ['detected'], restartRequired: vm({ headers: {} }).network.restartRequired }) });
  let checks = new Map();
  const detections = () => discovery.rows();
  const confirmations = new Map();
  let authorization = null;
  supervisor ||= require('../ops/host-supervisor').createHostSupervisor({ env });
  let restartAccepted = false;
  const restartAt = store.db.prepare('SELECT accepted_at FROM settings_restart WHERE singleton=1');
  const acceptRestart = store.db.prepare('INSERT INTO settings_restart(singleton,accepted_at) VALUES(1,?) ON CONFLICT(singleton) DO UPDATE SET accepted_at=excluded.accepted_at');
  const getRevision = store.db.prepare("SELECT value FROM settings_state WHERE key='revision'");
  const setRevision = store.db.prepare("UPDATE settings_state SET value=? WHERE key='revision'");
  const putHash = store.db.prepare("INSERT INTO store_meta(key,value) VALUES('setup_config_hash',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value");
  const revision = () => getRevision.get().value;
  const networkMode = value => value.host === '0.0.0.0' ? 'lan' : value.publicUrl ? 'tunnel' : 'local';
  const modeEnv = env.HOST !== undefined ? 'HOST' : env.AO_PUBLIC_URL !== undefined ? 'AO_PUBLIC_URL' : null;
  const activeMode = (!modeEnv && initialFiles.config?.network?.mode) || networkMode(cfg);
  const readonly = () => !!(cfg.readonly || cfg.readonlyStore);
  const legacyIdleRelocationMinutes = () => {
    try {
      // Read only: during Settings construction the layout router has not yet
      // seeded a missing layout, and a compatibility probe must not create one.
      const value = store.office?.active?.()?.data?.idleRelocationMinutes;
      return Number.isInteger(value) && value >= 1 && value <= 1440 ? value : null;
    } catch { return null; }
  };
  // One-time compatibility migration from the pre-Settings layout field. Once
  // copied, the config value is authoritative and layout writes cannot replace it.
  function migrateLegacyOfficeTiming() {
    const config = files.config, legacy = legacyIdleRelocationMinutes();
    if (readonly() || !config || ![2, 3].includes(config.version) || legacy == null
      || Number.isInteger(config.office?.presence?.idleRelocationMinutes)) return;
    const nextConfig = { ...structuredClone(config), office: { ...(config.office || {}), presence: {
      ...(config.office?.presence || {}), idleRelocationMinutes: legacy } } };
    const nextSecrets = structuredClone(files.secrets);
    const out = IC.writeInstanceConfig(files.paths, nextConfig, nextSecrets, { replace: true, expectedDigest: publishedDigest,
      commit: hash => store.withTx(() => { setRevision.run(revision() + 1); putHash.run(hash); }) });
    files = { ...files, config: nextConfig, secrets: nextSecrets };
    publishedDigest = out.digest;
  }
  migrateLegacyOfficeTiming();
  function officeTimingEntries() {
    return Object.fromEntries(OFFICE_TIMINGS.map(def => {
      const fromEnv = validOfficeEnv(env[def.env], def.unit), configured = files.config?.office?.presence?.[def.key];
      const fromFile = Number.isInteger(configured) ? configured : def.key === 'idleRelocationMinutes' ? legacyIdleRelocationMinutes() : null;
      const source = fromEnv !== null ? 'env' : fromFile !== null ? 'file' : 'default';
      return [def.key, { value: fromEnv ?? fromFile ?? def.default, source, env: def.env }];
    }));
  }
  function officeTimings() {
    const values = officeTimingEntries();
    return { finishedSessionWindowMs: values.finishedSessionWindowMinutes.value * 60000,
      agentPresenceWindowMs: values.agentPresenceWindowMinutes.value * 60000,
      idleRelocationMinutes: values.idleRelocationMinutes.value };
  }
  const currentEnv = () => IC.effectiveEnv(env, files);
  const ownerEnabled = () => cfg.authDatabase && !!store.users.owner();
  function active(req, sensitive = false) {
    const session = auth.sessionOf(req);
    if (!session || req.principal) throw new ApiError('unauthorized');
    if(req.authorize) {
      if(!authorization)throw new ApiError('unauthorized');
      req.authorize();const user=store.users.byId(session.userId);
      if(user?.status!=='active'||user.id!==req.user.id||user.auth_generation!==(session.authGeneration??0))throw new ApiError('unauthorized');
    } else if(session.userId && session.userId !== store.users.owner()?.id)throw new ApiError('unauthorized');
    req.session = session;
    if (readonly()) throw new ApiError('readonly');
    if(sensitive&&req.authorize)authorization.reauthentication.requireRecent(req);
    else if (sensitive && (!session.sid || !confirmations.has(session.sid) || elapsed() >= confirmations.get(session.sid).until)) throw forbidden('reauth-required');
    return session;
  }
  function envGuard(field, key, value, current) { if (key && env[key] !== undefined && (arguments.length < 3 || JSON.stringify(value) !== JSON.stringify(current))) throw forbidden('env-override', field); }
  function field(value, key, fromFile, editable = true, reason = null) {
    const imposed = key && env[key] !== undefined;
    return { value, source: imposed ? 'env' : fromFile ? 'file' : 'default', editable: !readonly() && !imposed && editable,
      reason: readonly() ? label('readonly') : imposed ? label('envOverride', { variable: key }) : reason };
  }
  const adapter = id => { if (!ADAPTER_IDS.includes(id) || !adapterById(id).setup?.connect || !adapterById(id).setup.settings) throw invalid('runtime.adapter', 'unsupported'); return adapterById(id); };
  function connection(input, instanceId = null) {
    if (!input || typeof input.adapter !== 'string') throw invalid('runtime.adapter', 'required');
    const A = adapter(input.adapter), S = A.setup.settings;
    body(input, ['adapter', 'id', ...S.fields.map(f => f.id)]);
    instanceId ||= input.id;
    const instance = cfg.runtimeInstances?.find(r => r.id === instanceId && r.adapter === input.adapter);
    const saved = instance ? S.values(instance.cfg) : (!instanceId || instanceId === 'legacy' && !cfg.runtimeInstances) && cfg.runtimeAdapter === input.adapter ? S.values(cfg) : {};
    const { id, ...native } = input;
    try { return { ...S.resolve(native, saved), ...(instanceId ? { id: instanceId } : {}) }; } catch (e) { throw invalid(e.field || 'runtime', 'invalid'); }
  }
  function edited(rt) { const A = adapter(rt.adapter), instance = rt.id && cfg.runtimeInstances?.find(r => r.id === rt.id && r.adapter === rt.adapter);
    const saved = instance ? instance.cfg : !rt.id && cfg.runtimeAdapter === rt.adapter ? cfg : null;
    if (!saved) return true;
    const previous = A.setup.settings.resolve(A.setup.settings.values(saved), {});
    return A.setup.settings.fields.some(f => JSON.stringify(previous[f.id]) !== JSON.stringify(rt[f.id])); }
  async function checked(rt, discover = false, authorize = () => {}) {
    const A = adapter(rt.adapter);
    let p, timer, pending = true;
    try {
      const instance = rt.id && cfg.runtimeInstances?.find(r => r.id === rt.id);
      const scopedEnv = rt.id && rt.id !== 'legacy' ? { HOME: env.HOME, ...A.setup.env({ runtime: A.setup.config(rt), token: A.setup.settings.secret(rt) }) } : currentEnv();
      const operation = Promise.resolve().then(() => { authorize();return A.setup.settings.probe({ runtime: rt, paths: instance?.cfg || A.paths?.(scopedEnv) || paths, probe }); }).then(value => { if (!pending) value?.gw?.close?.(); return value; });
      p = await Promise.race([operation,new Promise((_,reject) => { timer=setTimeout(()=>reject(new ApiError('upstream_unavailable',{details:[{issue:'runtime-timeout'}]})),5000); })]);
      const result = { ok: ['connected','capacity-limited'].includes(p.status), status: p.status, protocol: p.protocol ?? null, latencyMs: p.latencyMs ?? null,
        ...(Number.isSafeInteger(p.projectCount) ? { projectCount: p.projectCount } : {}),
        ...(Number.isSafeInteger(p.fileCount) ? { fileCount: p.fileCount } : {}),
        ...(Number.isSafeInteger(p.ignoredLineCount) ? { ignoredLineCount: p.ignoredLineCount } : {}),
        ...(Number.isSafeInteger(p.unknownLineTypeCount) ? { unknownLineTypeCount: p.unknownLineTypeCount } : {}),
        ...(Number.isSafeInteger(p.unknownKeyCount) ? { unknownKeyCount: p.unknownKeyCount } : {}),
        ...(Number.isSafeInteger(p.unknownContentBlockCount) ? { unknownContentBlockCount: p.unknownContentBlockCount } : {}),
        ...(typeof p.reasonCode === 'string' && /^[a-z0-9-]{1,80}$/.test(p.reasonCode) ? { reasonCode: p.reasonCode } : {}) };
      authorize();
      const agents = discover && result.ok ? await A.setup.discover({ gw: p.gw, runtime:rt,env:scopedEnv, detected: detections().find(d => d.runtime === rt.adapter)?.agents || [] }) : [];
      return { result, agents };
    } finally { pending=false; clearTimeout(timer); p?.gw?.close?.(); }
  }
  function base() {
    if (files.config) {
      const copy = structuredClone(files.config);
      if (copy.version === 1) { copy.version = 2; copy.owner.authSource = 'database'; }
      return copy;
    }
    const A = adapter(cfg.runtimeAdapter);
    return { version: 2, instance: { name: cfg.instanceName || 'Agent Office', locale: cfg.instanceLocale.startsWith('en') ? 'en' : 'fr', timeZone: cfg.timeZone },
      owner: { displayName: store.owner.name, email: cfg.loginEmail, authSource: 'database' },
      runtime: A.setup.config({ adapter: cfg.runtimeAdapter, ...A.setup.settings.values(cfg) }), agents: { primary: cfg.primaryAgent, looks: {}, names: {} } };
  }
  function secrets() { return files.secrets?.version === 3 ? structuredClone(files.secrets) : { version: 2, sessionSecret: files.secrets?.sessionSecret || cfg.sessionSecret, runtimeToken: files.secrets?.runtimeToken ?? cfg.gatewayToken ?? null }; }
  function persist(req, res, config, privateValues, expected, fields, { sensitive = false, dbChange = () => {}, runtimeChanged = false, sourceChanged = false } = {}) {
    active(req, sensitive);
    if (expected !== revision()) throw conflict();
    if (config.version === 2) ({ config, secrets: privateValues } = IC.upgradeV2(config, privateValues));
    runtimeChanged ||= files.config?.version !== 3;
    const nextFiles = { ...files, config, secrets: privateValues };
    let desiredEnv; try { desiredEnv = IC.effectiveEnv(env, nextFiles); } catch (error) { if (error instanceof IC.ConfigError) throw invalid('runtimes','invalid-config'); throw error; }
    const nextCfg = { ...tryLoadConfig(desiredEnv), configured: true, instanceName: desiredEnv.AO_INSTANCE_NAME || null,
      hiddenAgents: config.agents.hidden?.[desiredEnv.AO_RUNTIME || cfg.runtimeAdapter] || [],
      configuredAgents: config.agents.configured?.[desiredEnv.AO_RUNTIME || cfg.runtimeAdapter] || null,
      // Access publication is saved for the next boot; keep the currently served policy in this process.
      access: cfg.access || null, accessRevision: cfg.accessRevision ?? 0,
      // Listener, cookies and CSRF origin remain active until restart.
      bootId, port: cfg.port, host: cfg.host, cookieSecure: cfg.cookieSecure, publicUrl: cfg.publicUrl };
    nextCfg.runtimeInstances = IC.runtimeInstances(nextCfg, nextFiles, env);
    nextCfg.primaryAgent = config.agents.primary;
    nextCfg.runtimeWritable = nextCfg.runtimeInstances.some(r => r.enabled && r.cfg.runtimeWritable);
    nextCfg.agentNames = Object.assign({}, ...config.runtimes.map(r => Object.fromEntries(Object.entries(config.agents.names?.[r.id] || {}).map(([id, name]) => [scopedId(r.id, 'agent', id), name]))));
    const prepared = runtimeChanged && controller ? controller.prepare(nextCfg) : null;
    try {
      IC.writeInstanceConfig(files.paths, config, privateValues, { replace: !!files.config, expectedDigest: publishedDigest, commit: hash => store.withTx(() => {
        if (!store.users.owner() && files.config?.version === 1 && files.secrets?.passwordHash) store.users.createOwner({ email: config.owner.email, personId: store.owner.id, passwordHash: files.secrets.passwordHash });
        dbChange(); store.runtimeReferences.migrate(hash); store.runtimeReferences.bind(config.runtimes); setRevision.run(expected + 1); putHash.run(hash);
      }) });
    } catch (e) {
      controller?.dispose(prepared);
      if (e instanceof IC.ConfigError) throw invalid(null, 'invalid-config');
      if (['EBUSY', 'ECONFLICT', 'EEXIST'].includes(e.code)) throw conflict();
      throw new ApiError('upstream_unavailable', { details: [{ issue: 'publish-failed' }] });
    }
    files = nextFiles;
    publishedDigest = digest(config);
    if (sourceChanged) void orchestratorTeams?.configureHerdr?.(config.sources?.herdr === true);
    if (runtimeChanged) { for (const helper of integrations.values()) helper.invalidate(); integrations.clear(); planOwners.clear(); }
    if (nextCfg.authDatabase && !cfg.authDatabase) { auth.useDatabase(email => email == null ? store.users.owner() : store.users.credential(email), () => store.users.authGeneration()); auth.refreshSession(req, res, {revokeOthers:true}); }
    controller?.apply(nextCfg, prepared);
    req.settingsChanged = fields;
    const restartRequired = vm(req).network.restartRequired;
    changed({ revision: revision(), changed: fields, restartRequired });
    return { ok: true, result: { changed: fields, restartRequired }, revision: revision(), vm: vm(req) };
  }
  const integration = createSetupIntegrations({ env, paths, dataDir: cfg.dataDir, now: elapsed, beforeMutation: () => {
    if (!integrationRequest) throw forbidden('reauth-required'); active(integrationRequest, true);
  }, afterMutation: () => { active(integrationRequest,true); store.withTx(() => setRevision.run(integrationRevision + 1)); } });
  let integrationRequest = null, integrationRevision = null;
  const integrations = new Map(), planOwners = new Map();
  function integrationFor(id) {
    if (files.config?.version !== 3) return { helper: integration, adapter: id };
    let entry = files.config.runtimes.find(r => r.id === id && r.enabled);
    if (!entry && files.config.runtimes.length === 1 && files.config.runtimes[0].id === 'legacy' && files.config.runtimes[0].adapter === id) entry = files.config.runtimes[0];
    if (!entry) throw invalid('runtime', 'instance-required');
    if (!integrations.has(entry.id)) {
      const A = adapter(entry.adapter), child = cfg.runtimeInstances?.find(r => r.id === entry.id)?.cfg;
      const scopedEnv = entry.id === 'legacy' ? currentEnv() : { HOME: env.HOME, AO_ENV: env.AO_ENV,
        ...A.setup.env({ runtime: IC.nativeRuntime(entry), token: child?.gatewayToken }) };
      integrations.set(entry.id, createSetupIntegrations({ env: scopedEnv, paths: child || paths, dataDir: cfg.dataDir, now: elapsed,
        beforeMutation: () => { if (!integrationRequest) throw forbidden('reauth-required'); active(integrationRequest, true); },
        afterMutation: () => { active(integrationRequest, true); store.withTx(() => setRevision.run(integrationRevision + 1)); } }));
    }
    return { helper: integrations.get(entry.id), adapter: entry.adapter };
  }
  function agentRows() {
    if (files.config?.version === 3) return require('./runtime-rows').agentRows({ config: files.config, cfg, engine, detections: detections(), store, now: now() }).map(row => {
      if (!row.integrations.length) return row;
      let status = 'modified';
      try { const { helper, adapter } = integrationFor(row.runtime), st = helper.descriptor({ runtime: adapter, agentId: row.agentId, locale: files.config.instance.locale }).status; status = ({ absent: 'missing', conflict: 'modified' })[st] || st; } catch {}
      return { ...row, integrations: [{ id: 'projet', status }] };
    });
    const rows = new Map();
    for (const d of detections()) for (const a of d.agents || []) rows.set(d.runtime + ':' + a.id, { ...a, runtime: d.runtime });
    for (const a of engine.detectedAgents?.() || engine.agents()) {
      const id = cfg.runtimeAdapter + ':' + a.id, old = rows.get(id);
      rows.set(id, { ...a, workspace: old?.workspace || null, name: old?.name || (a.name !== a.id ? a.name : null), nameSource: old?.nameSource || (a.name !== a.id ? 'runtime' : null), runtime: cfg.runtimeAdapter, model: a.model?.primary || null });
    }
    for (const [runtime, names] of Object.entries(files.config?.agents.names || {})) for (const id of Object.keys(names)) if (!rows.has(runtime + ':' + id)) rows.set(runtime + ':' + id, { id, runtime, name: null });
    for (const [runtime, ids] of Object.entries(files.config?.agents.configured || {})) for (const id of ids) if (!rows.has(runtime + ':' + id)) rows.set(runtime + ':' + id, { id, runtime, name: null });
    const primary = engine.primaryAgent()?.id ?? cfg.primaryAgent;
    if (primary && !rows.has(cfg.runtimeAdapter + ':' + primary)) rows.set(cfg.runtimeAdapter + ':' + primary, { id: primary, runtime: cfg.runtimeAdapter, name: null });
    return [...rows.values()].map(a => {
      const names = a.runtime === cfg.runtimeAdapter ? cfg.agentNames || {} : files.config?.agents.names?.[a.runtime] || {};
      const ids = files.config?.agents.configured?.[a.runtime];
      const policyId=a.runtime===cfg.runtimeAdapter?'legacy':a.runtime,autoAddDefault=defaultAutoAdd(a.runtime);
      const autoPolicy=store.runtimeAutoAdd?.get(policyId,autoAddDefault)||{enabled:autoAddDefault,added:[],excluded:[]},added=autoPolicy.added.find(x=>x.id===a.id);
      const configured = (ids ? ids.includes(a.id) : Object.hasOwn(names, a.id) || a.runtime === cfg.runtimeAdapter && primary === a.id)
        || !!added || autoPolicy.enabled && !autoPolicy.excluded.includes(a.id);
      const selected = a.runtime === cfg.runtimeAdapter && primary === a.id;
      let status = 'unsupported';
      const A = ADAPTER_IDS.includes(a.runtime) ? adapterById(a.runtime) : null;
      if (A?.projectTag) {
        try { const st = integration.descriptor({ runtime: a.runtime, agentId: a.id, locale: files.config?.instance.locale || 'fr' }).status; status = ({ absent: 'missing', conflict: 'modified' })[st] || st; } catch { status = 'modified'; }
      }
      return { id: a.runtime + ':' + a.id, agentId: a.id, runtime: a.runtime, name: Object.hasOwn(names, a.id) ? names[a.id] : a.name || null,
        detectedName: a.name || null, nameSource: a.nameSource || null, configured,
        hidden: (files.config?.agents.hidden?.[a.runtime] || []).includes(a.id)||autoPolicy.excluded.includes(a.id),autoAddedAt:added?.at??null,isNew:!!added&&store.runtimeAutoAdd.isNew(autoPolicy,a.id,now()),isPrimary: selected, model: typeof a.model === 'string' ? a.model : a.model?.primary || null,
        lookRoute: configured && a.runtime === cfg.runtimeAdapter ? '/boutique?onglet=personnages&agent=' + encodeURIComponent(selected ? 'primary' : 'agent:' + a.id) : null,
        integrations: A?.projectTag ? [{ id: 'projet', status }] : [] };
    });
  }
  function vm(req) {
    const conf = files.config, dbOwner = store.users.owner();
    // Use the same env/file/default projection as boot. A mode is guidance,
    // not a listener setting; env-managed fields can never be pending writes.
    const effective = tryLoadConfig(currentEnv());
    const desiredNetwork = { mode: (!modeEnv && conf?.network?.mode) || networkMode(effective),
      host: effective.host, port: effective.port, publicUrl: effective.publicUrl, cookieSecure: effective.cookieSecure };
    const activeNetwork = { mode: activeMode, host: cfg.host, port: cfg.port, publicUrl: cfg.publicUrl, cookieSecure: cfg.cookieSecure };
    const restartRequired = ['host', 'port', 'publicUrl', 'cookieSecure'].some(k => desiredNetwork[k] !== activeNetwork[k]);
    const all = new Map(detections().map(d => [d.runtime, d]));
    for (const id of ADAPTER_IDS) if (!all.has(id)) all.set(id, { runtime: id, name: adapterById(id).setup.name, found: false, confidence: 'none', agents: [] });
    const runtimes = conf?.version === 3 ? require('./runtime-rows').runtimeRows({ config: conf, cfg, engine, detections: detections(), checks, field, label, store }) : [...all.values()].filter(d => !ADAPTER_IDS.includes(d.runtime) || !adapterById(d.runtime).setup.settings?.optional || d.runtime === cfg.runtimeAdapter).map(d => {
      const A = ADAPTER_IDS.includes(d.runtime) ? adapterById(d.runtime) : null, S = A?.setup?.settings;
      const selected = d.runtime === cfg.runtimeAdapter;
      const autoAddDefault=defaultAutoAdd(d.runtime),autoPolicy=store.runtimeAutoAdd?.get(selected?'legacy':d.runtime,autoAddDefault) || {enabled:autoAddDefault,managed:false};
      const values = selected && S ? S.values(cfg) : S ? S.detectedValues(d) : {};
      return { id: d.runtime, adapter: d.runtime, enabled: selected, candidate: !selected, name: d.name, brand: settingsBrand(d.runtime), optional:!!S?.optional, autoAdd:{enabled:autoPolicy.enabled,defaultEnabled:autoAddDefault,managed:!!autoPolicy.managed}, supported: !!S, selected, ...require('./detection-state').detectionView(d, S?.optional && selected),
        checkedPaths: d.checkedPaths || [], fields: S?.fields || [], values: Object.fromEntries((S?.fields || []).map(def => [def.id,
          { ...field(def.writeOnly ? null : values[def.id] ?? null, S.envKeys[def.id], selected && !!conf, true), ...(def.writeOnly ? { tokenSet: !!values[def.id] } : {}) }])),
        connection: { status: !S ? 'unsupported' : checks.get(d.runtime)?.status || (selected ? engine.gateway().connected ? 'connected' : 'unreachable' : 'not-configured'),
          protocol: checks.get(d.runtime)?.protocol ?? (selected ? engine.runtime().protocol : null) ?? null,
          latencyMs: checks.get(d.runtime)?.latencyMs ?? null, checkedAt: checks.get(d.runtime)?.checkedAt ?? null } };
    });
    const permissionOk = [files.paths.file, files.paths.secrets].every(f => { try { const st = fs.lstatSync(f); return st.isFile() && !st.isSymbolicLink() && !(st.mode & 0o077); } catch { return !conf; } });
    const agents = agentRows({store,now:now()}), build = readBuild().buildId;
    const stale = !!(build && req.headers?.['x-ao-build'] && build !== req.headers['x-ao-build']);
    const herdrDetection = orchestratorTeams?.herdrCheck || { status: orchestratorTeams?.detected ? 'not-checked' : 'not-detected', checkedAt: null };
    const herdrEnabled = orchestratorTeams?.sourceEnabled ?? (conf?.sources?.herdr === true);
    const herdrFound = !!orchestratorTeams?.detected;
    const diagnostics = require('./diagnostics').diagnostics({runtimes,agents,
      orchestrator:{detected:herdrFound,enabled:herdrEnabled,label:'herdr'},
      permissionOk,stale,restartRequired,readonly:readonly()});
    const c = confirmations.get(req.session?.sid), expiresAt = c && elapsed() < c.until ? c.expiresAt : null;
    const timingEntries = officeTimingEntries();
    const office = Object.fromEntries(OFFICE_TIMINGS.map(def => [def.key, { ...field(timingEntries[def.key].value,
      timingEntries[def.key].source === 'env' ? def.env : null,
      timingEntries[def.key].source === 'file', true),
      ...(!readonly() && timingEntries[def.key].source === 'env' ? { reason: label('office.managed') } : {}), label: label('office.' + def.key), help: label('office.help.' + def.key), minimum: 1, maximum: 1440 }]));
    return { revision: revision(), readonly: readonly(), disabledReason: readonly() ? label('readonly') : null, reauth: { expiresAt, windowMs: 300000 },
      instance: { name: field(cfg.instanceName || 'Agent Office', 'AO_INSTANCE_NAME', !!conf), locale: field(cfg.instanceLocale.startsWith('en') ? 'en' : 'fr', 'AO_LOCALE', !!conf), timeZone: field(cfg.timeZone, 'AO_TIME_ZONE', !!conf) },
      office,
      restart: { supported: !readonly() && supervisor.supported, command: supervisor.command, reason: readonly() ? label('readonly') : supervisor.reason },
      owner: { displayName: field(store.owner.name, 'PORTAL_DISPLAY_NAME', !!conf, ownerEnabled(), ownerEnabled() ? null : label('externalAccount')),
        email: field(ownerEnabled() ? dbOwner.email : cfg.loginEmail, IC.completeEnvLogin(env) ? 'PORTAL_EMAIL' : null, !!conf, ownerEnabled(), ownerEnabled() ? null : label('externalAccount')),
        passwordChangeEnabled: ownerEnabled() && !readonly(), reason: readonly() ? label('readonly') : ownerEnabled() ? null : label('externalAccount') },
      network: { mode: field(desiredNetwork.mode, modeEnv, !!conf?.network),
        host: field(desiredNetwork.host, 'HOST', !!conf?.network, false, label('derivedField')), port: field(desiredNetwork.port, 'PORT', !!conf?.network),
        publicUrl: field(desiredNetwork.publicUrl, 'AO_PUBLIC_URL', !!conf?.network), cookieSecure: field(desiredNetwork.cookieSecure, 'PORTAL_COOKIE_SECURE', !!conf?.network, false, label('derivedField')),
        active: activeNetwork, restartRequired },
      herdr: { found: herdrFound, enabled: herdrEnabled, active: !!orchestratorTeams?.hasHerdr, brand:sourceBrand('herdr'),
        status: herdrDetection.status, checkedAt: herdrDetection.checkedAt ?? null },
      runtimes, agents, diagnostics };
  }
  function planBinding(req) {
    const {userId,sessionId,generation,fingerprint}=authorization.reauthentication.identity(req);
    return {userId,sessionId,generation,fingerprint};
  }
  async function account(command,req,res) {
    active(req,true);
    const b=body(req.body,command==='password'?['expectedRevision','password']:['expectedRevision','displayName','email']);
    const binding=authorization.reauthentication.requireRecent(req);
    const ctx={userId:binding.userId,authGeneration:binding.generation,requestId:req.requestId,authorize:()=>active(req,true)};
    let value;
    try {
      if(command==='password') {
        if(typeof b.password!=='string'||b.password.length<12||b.password.length>1024)throw invalid('password','invalid');
        const gate=auth.reserveCredentialAttempt(req);
        if(!gate.ok){res.setHeader('Retry-After',String(gate.retryAfterSec));throw new ApiError('rate_limited');}
        let committed=false;
        try {const passwordHash=await derivePassword(b.password);active(req,true);value=store.selfAccount.password({expectedRevision:b.expectedRevision,passwordHash},ctx);committed=true;}
        finally {gate.release(committed);}
      } else value=store.selfAccount.profile(b,ctx);
    }catch(error){
      if(error instanceof ApiError)throw error;
      if(error.code==='empty-change')throw invalid(null,'empty-change');
      throw require('../api/v3/access-management').mapError(error);
    }
    req.managementAudited=true;req.accountCommitted=true;
    auth.refreshSession(req,res,{revokeOthers:value.rotated});
    return {ok:true,result:{updated:true,user:value.user},revision:value.user.revision,vm:null};
  }
  async function run(command, req, res) {
    let b = req.body || {}; active(req);
    if(req.authorize&&['owner','password'].includes(command))return account(command,req,res);
    const startRevision = revision();
    if (command === 'agents' && files.config?.version === 3 && files.config.runtimes.length === 1 && files.config.runtimes[0].id === 'legacy' && b.runtime === files.config.runtimes[0].adapter) b = { ...b, runtime: 'legacy' };
    if (command === 'reauth') {
      body(b, ['password']); if (typeof b.password !== 'string' || b.password.length > 1024) throw invalid('password', 'invalid');
      const previous = auth.sessionOf(req), generation = store.users.authGeneration();
      const result = await auth.confirmPassword(req, b.password);
      if (result.rateLimit) { res.setHeader('Retry-After', String(result.rateLimit.retryAfterSec)); throw new ApiError('rate_limited'); }
      if (!result.ok) throw new ApiError('unauthorized', { details: [{ issue: 'current-password' }] });
      const session = active(req); if (!session.sid || session.sid !== previous.sid || generation !== store.users.authGeneration()) throw new ApiError('unauthorized');
      if (confirmations.size >= 1024) confirmations.delete(confirmations.keys().next().value);
      const expiresAt = now() + 300000; confirmations.set(session.sid, { until: elapsed() + 300000, expiresAt });
      return { ok: true, result: { expiresAt }, revision: null, vm: null };
    }
    if (command === 'check') {
      body(b, ['runtime']); const rt = connection(b.runtime), sensitive = edited(rt); active(req, sensitive);
      const { result } = await checked(rt,false,()=>active(req,sensitive)); active(req, sensitive);
      if (!sensitive) { const key=rt.id || rt.adapter; if (result.status === 'not-verified') checks.delete(key); else checks.set(key, { ...result, checkedAt: now() }); }
      return { ok: true, result, revision: null, vm: null };
    }
    if (command === 'detect') {
      body(b, []);
      try { await discovery.refresh(() => active(req)); }
      catch (error) {
        if (error instanceof ApiError || error.code === 'ETESTDETECT') throw error;
        throw new ApiError('upstream_unavailable', { details: [{ issue: 'detection-failed' }] });
      }
      active(req);
      const value = vm(req);
      return { ok: true, result: { runtimes: value.runtimes, agents: value.agents }, revision: revision(), vm: value };
    }
    if (command === 'herdrCheck') {
      body(b, []); active(req);
      if (!orchestratorTeams?.checkHerdr) throw new ApiError('not_found');
      let result; try { result = await orchestratorTeams.checkHerdr(); } catch { throw new ApiError('upstream_unavailable', { details: [{ issue: 'herdr-check-failed' }] }); }
      active(req);
      return { ok: true, result, revision: null, vm: null };
    }
    if (command === 'integrationPlan') {
      body(b, ['runtime', 'locale']); const { helper, adapter: kind } = integrationFor(b.runtime); adapter(kind); const detected = detections().find(d => d.runtime === kind)?.agents || [];
      if (b.locale !== undefined && !['fr','en'].includes(b.locale)) throw invalid('locale','invalid');
      const result = await helper.plan({ runtime: kind, agents: detected, locale: b.locale || files.config?.instance.locale || 'fr' }); active(req);
      if (planOwners.size >= 16) planOwners.delete(planOwners.keys().next().value); planOwners.set(result.planId, { helper, revision: startRevision, binding:req.authorize?planBinding(req):null });
      return { ok: true, result, revision: null, vm: null };
    }
    if (command === 'integrationApply') {
      body(b, ['planId', 'agentIds', 'confirmed', 'action']); active(req, true);
      integrationRequest = req; integrationRevision = startRevision;
      const owner = planOwners.get(b.planId); if (!owner || owner.revision !== startRevision) throw conflict();
      if(req.authorize){const binding=authorization.reauthentication.requireRecent(req),issued=owner.binding;if(!issued||issued.userId!==binding.userId||issued.sessionId!==binding.sessionId||issued.generation!==binding.generation||issued.fingerprint!==binding.fingerprint)throw forbidden('plan-owner');}
      let result; try { result = owner.helper.apply(b); } catch (e) { if(e instanceof ApiError) throw e; throw invalid('integrations', ['EPLAN', 'ECONFIRM', 'ESTALEPLAN', 'EUNSAFEPATH', 'EROLLBACK', 'ECONFLICT'].includes(e.code) ? e.code : 'unavailable'); }
      finally { integrationRequest = null; integrationRevision=null; }
      req.settingsChanged = ['integrations'];
      owner.revision = revision();
      changed({ revision: revision(), changed: ['integrations'], restartRequired: vm(req).network.restartRequired });
      return { ok: true, result, revision: revision(), vm: vm(req) };
    }
    if (command === 'fixAll') return fixAll(req,res,b,startRevision);
    if (command === 'restart') {
      body(b, ['expectedRevision', 'bootId', 'confirmed']); active(req, true);
      if (b.confirmed !== true) throw invalid('confirmed', 'required');
      if (typeof b.bootId !== 'string' || !b.bootId) throw invalid('bootId', 'required');
      if (b.bootId !== bootId) throw new ApiError('conflict', { details: [{ issue: 'boot-changed' }] });
      if (!Number.isInteger(b.expectedRevision)) throw invalid('expectedRevision', 'required');
      if (b.expectedRevision !== startRevision) throw conflict();
      if (!supervisor.supported) throw forbidden('restart-unsupported');
      store.withTx(() => {
        const last = restartAt.get()?.accepted_at;
        const remaining = last === undefined ? 0 : 60000 - (now() - last);
        if (restartAccepted || remaining > 0) {
          res.setHeader('Retry-After', String(Math.max(1, Math.ceil(remaining / 1000))));
          throw new ApiError('rate_limited');
        }
        acceptRestart.run(now());
      });
      restartAccepted = true; if(req.authorize)authorization.reauthentication.clear(req);else confirmations.delete(req.session.sid);
      req.settingsChanged = ['instance.restart'];
      // Only a flushed successful response permits shutdown. An aborted request
      // retains the cooldown, but cannot make the process exit.
      res.once('finish', () => { if (res.statusCode >= 200 && res.statusCode < 300) setImmediate(() => supervisor.restart()); });
      return { ok: true, result: { accepted: true, bootId }, revision: revision(), vm: null };
    }
    if (command !== 'password') {
      if (!Number.isInteger(b.expectedRevision)) throw invalid('expectedRevision','required');
      if (b.expectedRevision !== startRevision) throw conflict();
    }
    const config = base(), privateValues = secrets(); let fields = [], sensitive = false, dbChange = () => {}, runtimeChanged = false;
    if (command === 'instance') {
      body(b, ['expectedRevision', 'name', 'locale', 'timeZone', 'office']);
      for (const [key, variable] of [['name','AO_INSTANCE_NAME'], ['locale','AO_LOCALE'], ['timeZone','AO_TIME_ZONE']]) if (b[key] !== undefined) {
        const value = text(b[key], 'instance.'+key); envGuard('instance.'+key, variable, value, key === 'name' ? cfg.instanceName : key === 'locale' ? cfg.instanceLocale.split('-')[0] : cfg.timeZone);
        if (key === 'locale' && !['fr','en'].includes(value) || key === 'timeZone' && !IC.validZone(value)) throw invalid('instance.'+key, 'invalid');
        config.instance[key] = value; fields.push('instance.'+key);
      }
      if (b.office !== undefined) {
        body(b.office, ['finishedSessionWindowMinutes', 'agentPresenceWindowMinutes', 'idleRelocationMinutes']);
        const current = officeTimingEntries(), presence = { ...(config.office?.presence || {}) };
        for (const def of OFFICE_TIMINGS) if (b.office[def.key] !== undefined) {
          const value = b.office[def.key];
          if (!Number.isInteger(value) || value < 1 || value > 1440) throw invalid('office.' + def.key, 'range');
          envGuard('office.' + def.key, current[def.key].source === 'env' ? def.env : null, value, current[def.key].value);
          presence[def.key] = value; fields.push('office.' + def.key);
        }
        if (!Object.keys(b.office).length) throw invalid('office', 'empty-change');
        config.office = { ...(config.office || {}), presence };
      }
      if (!fields.length) throw invalid(null, 'empty-change');
    } else if (command === 'network') {
      body(b, ['expectedRevision', 'mode', 'port', 'publicUrl']); sensitive = true; active(req, true);
      try { config.network = networkConfig(b); } catch { throw invalid('network', 'invalid'); }
      for (const [key, variable] of [['host','HOST'],['port','PORT'],['publicUrl','AO_PUBLIC_URL'],['cookieSecure','PORTAL_COOKIE_SECURE']]) {
        const effective = variable === 'PORT' ? Number(env[variable]) : variable === 'PORTAL_COOKIE_SECURE' ? env[variable] === '1' : env[variable] || null;
        envGuard('network.'+key, variable, config.network[key], effective);
      }
      fields = ['network.mode','network.port','network.publicUrl'];
    } else if (command === 'access') {
      body(b, ['expectedRevision', 'draft', 'configDigest']); sensitive = true; active(req, true);
      let draft;
      try { draft = require('../access/draft').validateAccessDraft(b.draft); }
      catch (error) { if (error?.code === 'EACCESSDRAFT' || error?.code === 'EDOMAIN') throw invalid(error.field || 'draft.domain', error.issue || 'invalid'); throw error; }
      if (b.expectedRevision !== revision()) throw conflict();
      const wantedDigest = require('../access/service').configDigest(b.expectedRevision, draft);
      if (typeof b.configDigest !== 'string' || b.configDigest !== wantedDigest) throw invalid('configDigest', 'mismatch');
      envGuard('access.uiOrigins', 'AO_ALLOWED_ORIGINS', JSON.stringify(draft.uiOrigins), env.AO_ALLOWED_ORIGINS);
      config.access = draft;
      config.accessRevision = (config.accessRevision || 0) + 1;
      fields = ['access'];
    } else if (command === 'owner') {
      body(b, ['expectedRevision','displayName','email']); if (!ownerEnabled()) throw forbidden('external-account');
      if (b.displayName !== undefined) { envGuard('owner.displayName','PORTAL_DISPLAY_NAME'); config.owner.displayName = text(b.displayName,'owner.displayName'); fields.push('owner.displayName'); }
      if (b.email !== undefined) { active(req, true); sensitive = true; const email = text(b.email,'owner.email',254).toLowerCase(); if (!IC.EMAIL.test(email)) throw invalid('owner.email','invalid'); config.owner.email = email; fields.push('owner.email'); }
      if (!fields.length) throw invalid(null,'empty-change');
      dbChange = () => { store.persons.ensureOwner(config.owner.displayName,{rename:true}); store.users.amendOwner({email:config.owner.email,personId:store.owner.id}); };
    } else if (command === 'password') {
      body(b, ['password']); if (!ownerEnabled()) throw forbidden('external-account'); sensitive = true; active(req, true);
      if (typeof b.password !== 'string' || b.password.length < 12 || b.password.length > 1024) throw invalid('password','invalid');
      const passwordHash = await derivePassword(b.password); active(req,true);
      dbChange = () => store.users.rotatePassword(passwordHash); fields = ['owner.password'];
    } else if (command === 'agents') {
      body(b, ['expectedRevision','runtime','primary','agents']);
      const instance = config.version === 3 ? config.runtimes.find(r => r.id === b.runtime && r.enabled) : null;
      adapter(instance?.adapter || b.runtime);
      if (config.version === 3 ? !instance : b.runtime !== cfg.runtimeAdapter) throw invalid('runtime','not-selected');
      if (!Array.isArray(b.agents) || b.agents.length > 100 || new Set(b.agents.map(a=>a?.id)).size !== b.agents.length) throw invalid('agents','invalid');
      const names = Object.create(null), hidden = [];
      const validId = id => config.version === 3 ? typeof id === 'string' && id.length > 0 && Buffer.byteLength(id) <= 4096 && !/[\x00-\x1f\x7f]/.test(id) : IC.AGENT_ID.test(id || '');
      for (const a of b.agents) { body(a,['id','name','hidden']); if (!validId(a.id) || typeof a.hidden !== 'boolean') throw invalid('agents','invalid'); names[a.id] = a.name === null ? null : text(a.name,'agents.name'); if (a.hidden) hidden.push(a.id); }
      if (b.primary !== null && (!validId(b.primary) || !b.agents.some(a=>a.id===b.primary && !a.hidden))) throw invalid('agents.primary','invalid');
      const policyRuntimeId=config.version===3?b.runtime:'legacy',policyKind=config.version===3?instance.adapter:cfg.runtimeAdapter;
      const autoPolicy=store.runtimeAutoAdd?.get(policyRuntimeId,defaultAutoAdd(policyKind)),policyChanges=[];
      if(autoPolicy){
        const oldPrimary=config.version===3?parseId(config.agents.primary,'agent'):null;
        const priorIds=new Set([...(config.agents.configured?.[b.runtime]||[]),...Object.keys(config.agents.names?.[b.runtime]||{}),...autoPolicy.added.map(x=>x.id),...(oldPrimary?.runtime===b.runtime?[oldPrimary.local]:!oldPrimary&&config.agents.primary?[config.agents.primary]:[])]);
        const nextIds=new Set(b.agents.map(a=>a.id));
        for(const id of priorIds)if(!nextIds.has(id))policyChanges.push(['exclude',id]);
        for(const a of b.agents){
          if(a.hidden)policyChanges.push(['exclude',a.id]);
          else if(autoPolicy.excluded.includes(a.id))policyChanges.push(['allow',a.id]);
          else if(!priorIds.has(a.id)&&!autoPolicy.added.some(x=>x.id===a.id))policyChanges.push(['markAdded',a.id]);
        }
      }
      if (config.version !== 3 || b.runtime === 'legacy') {
        const local = cfg.runtimeInstances?.find(r => r.id === 'legacy')?.cfg || cfg;
        envGuard('agents.names','AO_AGENT_NAMES',names,local.agentNames); envGuard('agents.primary','AO_PRIMARY_AGENT',b.primary,local.primaryAgent);
      }
      if (b.primary !== null || config.version !== 3 || parseId(config.agents.primary, 'agent')?.runtime === b.runtime) config.agents.primary = config.version === 3 && b.primary ? scopedId(b.runtime, 'agent', b.primary) : b.primary;
      config.agents.names = {...config.agents.names,[b.runtime]:names}; config.agents.hidden = {...config.agents.hidden,[b.runtime]:hidden}; config.agents.configured = {...config.agents.configured,[b.runtime]:b.agents.map(a=>a.id)};
      dbChange = () => { for(const [operation,id] of policyChanges)store.runtimeAutoAdd[operation](policyRuntimeId,id,autoPolicy.enabled);for (const [id,name] of Object.entries(names)) store.persons.ensureAgent(config.version === 3 ? scopedId(b.runtime, 'agent', id) : id,name,{rename:true}); };
      fields = ['agents.names','agents.primary','agents.hidden'];
    } else if (command === 'autoAdd') {
      body(b,['expectedRevision','runtime','enabled']); active(req);
      if (!Number.isInteger(b.expectedRevision)) throw invalid('expectedRevision','required');
      if (b.expectedRevision !== revision()) throw conflict();
      if (typeof b.enabled !== 'boolean' || typeof b.runtime !== 'string') throw invalid('autoAdd','invalid');
      let runtimeId, kind;
      if (config.version === 3) { const instance=config.runtimes.find(r=>r.id===b.runtime&&r.enabled);if(!instance)throw invalid('runtime','not-selected');runtimeId=instance.id;kind=instance.adapter; }
      else { if(b.runtime!=='legacy'&&b.runtime!==cfg.runtimeAdapter)throw invalid('runtime','not-selected');runtimeId='legacy';kind=cfg.runtimeAdapter; }
      store.withTx(()=>{store.runtimeAutoAdd.setEnabled(runtimeId,b.enabled,defaultAutoAdd(kind));setRevision.run(b.expectedRevision+1);});controller?.refreshAutoAdd?.(runtimeId);
      req.settingsChanged=['runtimes.autoAdd'];changed({revision:revision(),changed:req.settingsChanged,restartRequired:vm(req).network.restartRequired});return {ok:true,result:{runtime:runtimeId,enabled:b.enabled},revision:revision(),vm:vm(req)};
    } else if (command === 'runtimes') {
      body(b, ['expectedRevision', 'runtimes', 'herdrEnabled']); sensitive = true; active(req, true);
      if (b.herdrEnabled !== undefined && typeof b.herdrEnabled !== 'boolean') throw invalid('herdrEnabled', 'invalid');
      if (!Array.isArray(b.runtimes) || b.runtimes.length > 32 || new Set(b.runtimes.map(r => r?.id)).size !== b.runtimes.length) throw invalid('runtimes', 'invalid');
      const upgraded = config.version === 3 ? { config, secrets: privateValues } : IC.upgradeV2(config, privateValues);
      const entries = [], credentials = {};
      for (const row of b.runtimes) {
        if (!row || !INSTANCE_ID.test(row.id || '') || typeof row.enabled !== 'boolean') throw invalid('runtimes', 'invalid');
        const A = adapter(row.adapter), previous = upgraded.config.runtimes.find(r => r.id === row.id);
        const bound = store.runtimeReferences.adapterFor(row.id);
        if (previous && previous.adapter !== row.adapter || bound && bound !== row.adapter) throw invalid('runtimes.id', 'identity-reuse');
        body(row, ['id', 'adapter', 'enabled', 'name', ...A.setup.settings.fields.map(f => f.id)]);
        const { enabled, name, ...input } = row, rt = connection(input, row.id);
        if (name !== undefined && (typeof name!=='string' || !name.trim() || name.length>80 || /[\x00-\x1f\x7f]/.test(name))) throw invalid('runtimes.name','invalid');
        if (row.id === 'legacy') { envGuard('runtime.adapter', 'AO_RUNTIME', row.adapter, cfg.runtimeAdapter); const old = A.setup.settings.values(cfg); for (const [key, variable] of Object.entries(A.setup.settings.envKeys)) envGuard('runtime.' + key, variable, rt[key], old[key]); }
        entries.push({ id: row.id, enabled, ...(name !== undefined ? {name:name.trim()} : previous?.name ? {name:previous.name} : {}), ...A.setup.config(rt) }); credentials[row.id] = { runtimeToken: A.setup.settings.secret(rt) };
        if (enabled && (!previous?.enabled || edited(rt))) { const { result } = await checked(rt,false,()=>active(req,true)); active(req, true); if (!result.ok) throw new ApiError('upstream_failed', { details: [{ issue: result.status }] }); checks.set(row.id, { ...result, checkedAt: now() }); }
      }
      upgraded.config.runtimes = entries; upgraded.secrets.runtimes = credentials;
      let sourceChanged = false;
      if (b.herdrEnabled !== undefined && upgraded.config.sources?.herdr !== b.herdrEnabled) {
        if (b.herdrEnabled && !orchestratorTeams?.detected) throw invalid('herdrEnabled', 'not-detected');
        upgraded.config.sources = { ...(upgraded.config.sources || {}), herdr: b.herdrEnabled };
        sourceChanged = true;
      }
      const selected = parseId(upgraded.config.agents.primary, 'agent'); if (selected && !entries.some(r => r.id === selected.runtime && r.enabled)) upgraded.config.agents.primary = null;
      fields = ['runtimes'];
      return persist(req, res, upgraded.config, upgraded.secrets, b.expectedRevision, fields, { sensitive, runtimeChanged: true, sourceChanged });
    } else if (command === 'runtime') {
      if (config.version === 3 && (config.runtimes.length !== 1 || config.runtimes[0].id !== 'legacy')) throw new ApiError('conflict', { details: [{ issue: 'runtime-instance-required' }] });
      body(b,['expectedRevision','runtime']); const rt = connection(b.runtime), A = adapter(rt.adapter); sensitive = edited(rt); active(req,sensitive);
      if (rt.adapter !== cfg.runtimeAdapter) throw invalid('runtime.adapter', 'instance-id-required');
      envGuard('runtime.adapter','AO_RUNTIME',rt.adapter,cfg.runtimeAdapter);
      const current = cfg.runtimeAdapter === rt.adapter ? A.setup.settings.values(cfg) : {};
      for (const [id,key] of Object.entries(A.setup.settings.envKeys)) envGuard('runtime.'+id,key,rt[id],current[id]);
      const {result} = await checked(rt,false,()=>active(req,sensitive)); active(req,sensitive); if (!result.ok) throw new ApiError('upstream_failed',{details:[{issue:result.status}]});
      if (rt.adapter !== cfg.runtimeAdapter) config.agents.primary = null;
      if (config.version === 3) { config.runtimes = [{ id: 'legacy', enabled: true, ...A.setup.config(rt) }]; privateValues.runtimes.legacy = { runtimeToken: A.setup.settings.secret(rt) }; }
      else { config.runtime = A.setup.config(rt); privateValues.runtimeToken = A.setup.settings.secret(rt); } runtimeChanged = true;
      checks.set(rt.adapter,{...result,checkedAt:now()}); fields = ['runtime.adapter',...A.setup.settings.fields.map(f=>'runtime.'+f.id)];
    } else throw new ApiError('not_found');
    const expected = command === 'password' ? startRevision : b.expectedRevision;
    if (!Number.isInteger(expected)) throw invalid('expectedRevision','required');
    const result = persist(req,res,config,privateValues,expected,fields,{sensitive,dbChange,runtimeChanged});
    if (command === 'password') { confirmations.clear(); auth.refreshSession(req,res,{revokeOthers:true}); result.vm = vm(req); }
    if (command === 'owner') auth.refreshSession(req,res);
    return result;
  }
  async function fixAll(req,res,b,startRevision) {
    active(req,true);
    const { SettingsFixAllRequest, SettingsFixAllResult } = require('../api/v2/vm/schemas'), s = require('../schema');
    if (!s.validate(SettingsFixAllRequest,b).ok) throw invalid('items','invalid-selection');
    if (b.expectedRevision !== startRevision) throw conflict();
    const declared = () => new Map(vm(req).diagnostics.flatMap(d=>d.fix?[[d.fix.id,d.fix]]:[]));
    const initial = declared();
    // Review the complete selection before the first write; no partial work on
    // malformed selections or omitted runtime privacy consent.
    for (const item of b.items) {
      const f = initial.get(item.id); if (!f) throw invalid('items','unknown-fix');
      if (f.requiresConsent && item.consent !== true) throw forbidden('runtime-consent','items');
    }
    let expected = startRevision;
    const items=[], fields=new Set();
    const safeError = error => {
      if (!(error instanceof ApiError)) return {code:'upstream_unavailable',issue:'unavailable'};
      const issue=error.details?.[0]?.issue;
      // Existing commands expose closed issues, never an exception's text.
      const safeIssues=['settings-revision','reauth-required','runtime-consent','stale-fix','EPLAN','ECONFIRM','ESTALEPLAN','EUNSAFEPATH','EROLLBACK','ECONFLICT','unavailable','publish-failed','refused','unauthorized','unreachable','not-configured','unsupported-format','capacity-limited','not-verified','env-override','identity-reuse','invalid-config'];
      return {code:error.code,issue:safeIssues.includes(issue)?issue:null};
    };
    async function reviewed(name,value) {
      // Delegate validation, guards, plans, backups, rollback and publication to
      // the same service commands used by their public single-action routes.
      const child=Object.create(req);child.body=value;
      active(req,true);if(revision()!==expected)throw conflict();
      return run(name,child,res);
    }
    for (const item of b.items) {
      const reviewedFix=initial.get(item.id);let result;
      try {
        active(req,true);if(revision()!==expected)throw conflict();
        const f=declared().get(item.id);
        if (!f || JSON.stringify(f.target)!==JSON.stringify(reviewedFix.target) || f.kind!==reviewedFix.kind) throw invalid('items','stale-fix');
        if(f.requiresInput) result={id:item.id,status:'input-required',changed:[],error:null,restartRequired:vm(req).network.restartRequired};
        else {
          let applied;
          if (['integration.install','integration.update'].includes(f.kind)) {
            const plan=await reviewed('integrationPlan',{runtime:f.target.runtime});
            applied=await reviewed('integrationApply',{planId:plan.result.planId,agentIds:[f.target.agentId],confirmed:true,action:'install'});
          } else if(f.kind==='runtime.enable') {
            if(!files.config || files.config.version!==3)throw invalid('items','stale-fix');
            const runtimes=files.config.runtimes.map(r=>{
              const child=cfg.runtimeInstances?.find(i=>i.id===r.id)?.cfg;
              if(!child)throw invalid('items','stale-fix');
              return {id:r.id,adapter:r.adapter,enabled:r.id===f.target.runtime?true:r.enabled,...(r.name?{name:r.name}:{}),...adapter(r.adapter).setup.settings.values(child)};
            });
            applied=await reviewed('runtimes',{expectedRevision:expected,runtimes});
          } else throw invalid('items','stale-fix');
          expected=applied.revision;
          const changed=applied.result.changed || ['integrations'];changed.forEach(f=>fields.add(f));
          result={id:item.id,status:'applied',changed,error:null,restartRequired:applied.vm.network.restartRequired};
        }
      } catch(error) {
        result={id:item.id,status:'failed',changed:[],error:safeError(error),restartRequired:vm(req).network.restartRequired};
      }
      items.push(result);
      store.audit.append({at:now(),requestId:req.requestId,actor:{kind:'human',personId:store.owner.id},command:'settings.fixAll.item',
        target:result.changed.join(',') || null,outcome:result.status==='applied'?'ok':result.status==='input-required'?'rejected':'failed',
        detail:result.status==='input-required'?'input-required':(result.error?.code || reviewedFix.kind).replace(/[_.]/g,'-')});
    }
    active(req);
    const fresh=vm(req), result={items,restartRequired:fresh.network.restartRequired};
    if(!s.validate(SettingsFixAllResult,result).ok)throw new ApiError('internal');
    req.settingsChanged=[...fields];
    return {ok:true,result,revision:revision(),vm:fresh};
  }
  auth.onRevoke(session => { if (session.allExcept) { for (const sid of confirmations.keys()) if (sid !== session.allExcept) confirmations.delete(sid); } else confirmations.delete(session.sid); });
  return { vm, run, officeTimings, accessConfig: () => files.config?.access || null, accessRevision: () => files.config?.accessRevision ?? null,
    useAuthorization: value => { if(!value?.reauthentication)throw new Error('shared reauthentication required');authorization=value; }, startDetection: options => discovery.start(options), close: () => { discovery.close(); confirmations.clear(); integration.invalidate(); for (const helper of integrations.values()) helper.invalidate(); planOwners.clear(); }, revision };
}
module.exports = { createSettings };
