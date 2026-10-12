'use strict';
// MetaVM and MeVM (api.md §3.1).
const { ENUMS } = require('../../../i18n/fr');
const { labelsFor } = require('../../../i18n');
const { MODEL_VERSION, CONTRACT_VERSION, CONTRACT_VERSION_V3 } = require('../envelope');
const { version: PACKAGE_VERSION } = require('../../../../package.json');
const { BOOT_ID } = require('../../../ops/boot-identity');

const envOf = (instance) => (instance === 'production' || instance === 'staging' ? instance : 'dev');

// G6: a runtime without write commands (demo) is read-only for runtime writes, whatever PORTAL_READONLY says
function capabilitiesOf(cfg) { return { openclawWrites: !cfg.readonly && cfg.runtimeWritable !== false, storeWrites: !cfg.readonlyStore }; }

// G2 (frontend-06): the runtime as the adapter names it; the UI never writes a runtime's name itself.
const runtimeOf = (rt, locale) => (rt ? { id: rt.adapterId, name: rt.name,
  gatewayLabel: (rt.gatewayLabels && rt.gatewayLabels[locale]) || rt.gatewayLabel } : null);

// G3c: labels (and the runtime's gateway label) in the request's locale (prefs, then Accept-Language; default fr)
function buildMetaVM(cfg, { engine = null, locale = 'fr', authenticated = false } = {}) {
  // Runtime/agent metadata may originate in private files. Bootstrap never reads it.
  if (!authenticated) engine = null;
  const capabilities = capabilitiesOf(cfg);
  const primary = engine && engine.primaryAgent ? engine.primaryAgent() : null;
  return { bootId: cfg.bootId || BOOT_ID, modelVersion: MODEL_VERSION, apiVersion: 2, contractVersion: CONTRACT_VERSION, serverVersion: PACKAGE_VERSION + '+' + envOf(cfg.instance),
    env: envOf(cfg.instance), capabilities, readonly: !capabilities.openclawWrites, runtime: runtimeOf(engine && engine.runtime(), locale),
    // G3a (ADR §12.2, §12.9, frontend-06): the resolver's agent, so the UI never names it; the instance's zone and locale
    primaryAgent: primary ? { id: primary.id, name: primary.name, avatarUrl: null } : null,
    // G4: configured = false only in setup mode (api.md §5.7)
    instance: { timeZone: cfg.timeZone || 'UTC', locale: cfg.instanceLocale || 'fr-CA', configured: cfg.configured !== false },
    locale, labels: labelsFor(locale), enums: ENUMS };
}

// ---- contract 3.0 (G5, api-v3.md D1) ----
const ENUMS_V3 = Object.freeze(Object.assign(Object.fromEntries(Object.entries(ENUMS).filter(([k]) => k !== 'channel')), {
  sessionKind: ['primary', 'subagent', 'scheduled', 'conversation-direct', 'conversation-group', 'conversation', 'internal', 'unrecognized'],
  occupantRole: ['primary', 'agent', 'subagent', 'scheduled', 'direct', 'group', 'conversation', 'session'],
  interlocutorKind: ['user', 'room'],
}));
// Labels for the OPEN vocabularies, as data: every channel, provider, model and agent that occurred gets an entry (the
// adapter's label when it has one, else the raw value); a key the dictionary already has is never overridden.
function dynamicLabels(engine, base) {
  const out = {};
  const put = (k, v) => { if (v != null && v !== '' && !Object.prototype.hasOwnProperty.call(base, k) && !Object.prototype.hasOwnProperty.call(out, k)) out[k] = String(v); };
  if (!engine) return out;
  for (const c of engine.channels()) if (c.id !== 'unrecognized') put('channel.' + c.id, c.label || c.id);
  for (const ss of engine.sessions()) {
    if (ss.class.channel && ss.class.channel !== 'unrecognized') put('channel.' + ss.class.channel, ss.class.channel);
    if (ss.model) { put('model.' + ss.model.id, ss.model.id); if (ss.model.provider) put('provider.' + ss.model.provider, ss.model.provider); }
    if (ss.provider) put('provider.' + ss.provider, ss.provider);
  }
  for (const ag of engine.agents()) put('agent.' + ag.id, ag.name || ag.id);
  return out;
}
function buildMetaVM3(cfg, { engine = null, locale = 'fr', authenticated = false } = {}) {
  if (!authenticated) engine = null;
  const capabilities = capabilitiesOf(cfg);
  const primary = engine && engine.primaryAgent ? engine.primaryAgent() : null;
  const rt = engine && engine.runtime();
  const base = labelsFor(locale, 3);
  return { bootId: cfg.bootId || BOOT_ID, modelVersion: MODEL_VERSION, apiVersion: 3, contractVersion: CONTRACT_VERSION_V3, serverVersion: PACKAGE_VERSION + '+' + envOf(cfg.instance),
    env: envOf(cfg.instance), capabilities, readonly: !capabilities.openclawWrites,
    runtime: rt ? Object.assign(runtimeOf(rt, locale), { version: rt.version || null, capabilities: rt.capabilities || {} }) : null,
    runtimes: engine?.runtimes ? engine.runtimes().map(r => ({ id: r.id, adapter: r.adapter, name: r.name || r.adapter, enabled: r.enabled,
      connection: r.connection, capabilities: r.capabilities || {} })) : rt ? [{ id: 'legacy', adapter: rt.adapterId, name: rt.name,
        enabled: true, connection: engine.gateway().connected ? 'connected' : 'disconnected', capabilities: rt.capabilities || {} }] : [],
    primaryAgent: primary ? { id: primary.id, name: primary.name, avatarUrl: null } : null,
    instance: { name: authenticated ? cfg.instanceName || null : null, timeZone: cfg.timeZone || 'UTC', locale: cfg.instanceLocale || 'fr-CA', configured: cfg.configured !== false },
    locale, locales: ['fr', 'en'], labels: Object.assign({}, base, dynamicLabels(engine, base)), enums: ENUMS_V3 };
}

function buildMeVM({ session, cfg, engine, ownerName, roleName = null }) {
  return { email: session.email, displayName: (ownerName && ownerName()) || cfg.displayName || session.email.split('@')[0], gateway: engine.gateway().connected ? 'up' : 'down', capabilities: capabilitiesOf(cfg), sessionExpiresAt: session.exp, ...(roleName ? { roleName } : {}) };
}

module.exports = { buildMetaVM, buildMetaVM3, buildMeVM, capabilitiesOf, envOf, ENUMS_V3 };
