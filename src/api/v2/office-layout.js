'use strict';
/*
 * S14b: the office layout on the store (api.md §3.10, §3.13, §5.5; data-model §12) and the UI preferences (§5.3).
 *   GET  /office/layout                 LayoutVM (topic `layout`, pushed again at theme.nextChangeAt)
 *   GET  /office/layout/revisions/:rev  { revision, updatedAt, updatedBy, data } (404 past retention)
 *   PUT  /office/layout                 { expectedRevision, data }   → CommandResult (revision, vm = LayoutVM); 409 with current
 *   PUT  /office/layout/theme           { expectedRevision, theme }  → replaces data.theme only
 *   GET  /prefs, PATCH /prefs           UiPrefs (topic `prefs`)
 * Validation is office-dev's shared validator (layout-rules.js validateLayout), after a structural check; its
 * messages are never sent (issues and fields only). Reset / restore are the normal PUT (no dedicated routes).
 */
const { ApiError, invalid } = require('./errors');
const { officeDefaults } = require('./vm/office');

const TZ = 'UTC';   // the fallback only: callers pass the instance time zone (G3a, ADR §12.7)
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

// The resolved office theme now, and when it next changes (auto mode; the night window may wrap midnight).
// review-16 R16-08: the boundary is a zoned calendar time computed by office-dev's shared theme module (Intl offsets),
// not « now + the wall-clock difference », which is an hour off on DST days.
const officeTheme = () => require('../../../public/v2/office/theme.js');
function resolveTheme(theme, now, tz = TZ) {
  const season = theme.season == null ? null : theme.season;
  if (theme.mode !== 'auto') return { resolved: theme.fixed || theme.day || 'day', mode: 'fixed', nextChangeAt: null, season };
  const { resolved, nextChangeAt } = officeTheme().nextChange(theme, now, tz);
  return { resolved, mode: 'auto', nextChangeAt, season };
}

// A structural check of OfficeLayoutDataV1 before the semantic validator (which assumes the shape).
function structural(d) {
  const obj = (v) => v && typeof v === 'object' && !Array.isArray(v);
  if (!obj(d)) return 'data';
  if (d.version !== 1) return 'version';
  if (!Number.isInteger(d.manifestVersion)) return 'manifestVersion';
  if (typeof d.room !== 'string') return 'room';
  if (!obj(d.theme) || !['auto', 'fixed'].includes(d.theme.mode)) return 'theme';
  for (const k of ['nightFrom', 'nightTo']) if (d.theme[k] !== undefined && !HHMM.test(String(d.theme[k]))) return 'theme';
  if (!Array.isArray(d.items) || d.items.length > 200 || !d.items.every((i) => obj(i) && typeof i.uid === 'string' && typeof i.asset === 'string'
    && ((Number.isInteger(i.x) && Number.isInteger(i.y)) || (typeof i.wall === 'string' && Number.isInteger(i.offset))))) return 'items';
  if (!Array.isArray(d.agents) || d.agents.length > 200 || !d.agents.every((a) => obj(a) && typeof a.agentId === 'string' && typeof a.character === 'string'
    && (a.accessories === undefined || (Array.isArray(a.accessories) && a.accessories.every((x) => typeof x === 'string'))))) return 'agents';
  // office-dev O8 (operations.md §4): presence { seenMinutes: integer 0–1440 }, optional
  if (d.presence !== undefined && !(obj(d.presence) && Object.keys(d.presence).every((k) => k === 'seenMinutes')
    && Number.isInteger(d.presence.seenMinutes) && d.presence.seenMinutes >= 0 && d.presence.seenMinutes <= 1440)) return 'presence';
  for (const k of Object.keys(d)) if (!['version', 'manifestVersion', 'room', 'theme', 'items', 'agents', 'presence'].includes(k)) return k;
  return null;
}

// G5 (api-v3.md D4, ADR §12.6): every SAVE is normalised to the 3.0 rule names, every read is served in the caller's
// contract version, both with office-dev's own toVocabulary (layout-rules.js), so client and server can't disagree.
// Stored layouts are never rewritten except by a save.
const rulesLib = () => officeDefaults().rules;
// O8: `presence` is 3.0 only: a 2.x read doesn't show it (a 2.x save keeps the stored value: `incoming`)
function asVersion(data, version) {
  if (!data || !Array.isArray(data.agents)) return data;
  const out = rulesLib().toVocabulary(data, version === 3 ? '3.0' : '2.x');
  if (version !== 3 && out.presence !== undefined) { const { presence, ...rest } = out; return rest; }   // eslint-disable-line no-unused-vars
  return out;
}
// agentsSeen rows are stored canonical (R22-04; older rows may be 2.x): served in the caller's names
const LEGACY_ROLE = { primary: 'main', scheduled: 'cron', direct: 'dm', group: 'channel' };
function seenAs(x, version) {
  const lr = rulesLib();
  const id = lr.canonicalRuleId(x.id) || x.id, role = lr.canonicalRole(x.role) || x.role;
  if (version === 3) return Object.assign({}, x, { id, role });
  const id2 = id === 'primary' ? 'main' : id.replace(/^([a-z]+):/, (m, r) => (LEGACY_ROLE[r] || r) + ':');
  return Object.assign({}, x, { id: id2, role: LEGACY_ROLE[role] || role });
}

function validate(data) {
  const bad = structural(data);
  if (bad) throw invalid(bad, 'invalid');
  const off = officeDefaults();
  let errors;
  try { errors = off.rules.validateLayout(data, off.index); } catch (_) { throw invalid('data', 'invalid'); }
  if (errors && errors.length) {
    throw new ApiError('validation_failed', { details: errors.slice(0, 50).map((e) => Object.assign({ issue: String(e.code) },
      e.uid ? { field: 'items.' + e.uid } : e.agentId ? { field: 'agents.' + e.agentId } : {})) });
  }
}

/**
 * @param {object} p  { r, store, topics, authed, guard, ok, actorOf, actorRefOf, now }
 *   actorOf(ref) → ActorVM; actorRefOf(req) → the ActorRef stored with a save
 */
function mountOfficeLayout({ r, store, topics, authed, guard, ok, actorOf, actorRefOf, timeZone = TZ, now = () => Date.now() }) {
  const off = officeDefaults();
  const active = () => store.office.active(() => off.layout);
  const vmOf = (version = 2) => {
    const l = active(), t = now();
    return {
      layout: { id: l.id, name: l.name, revision: l.revision, updatedAt: l.updatedAt, updatedBy: actorOf(l.updatedBy), data: asVersion(l.data, version) },
      manifest: off.manifest,
      theme: resolveTheme(l.data.theme, t, timeZone),
      default: { data: asVersion(off.layout, version) },
      revisions: store.office.revisions(l.id).map((x) => ({ id: String(x.revision), revision: x.revision, updatedAt: x.updatedAt, updatedBy: actorOf(x.updatedBy) })),
      agentsSeen: store.office.seenRecent(t).map((x) => seenAs(x, version)),
    };
  };
  topics.define('layout', { build: (_, P) => vmOf(P.version) });
  topics.define('prefs', { build: () => store.office.prefs() });

  // the theme flips at nextChangeAt: push the layout topic then
  let themeTimer = null;
  const armTheme = () => {
    clearTimeout(themeTimer);
    const next = resolveTheme(active().data.theme, now(), timeZone).nextChangeAt;
    if (next == null) return;
    themeTimer = setTimeout(() => { topics.invalidate('layout'); topics.invalidate('office'); armTheme(); }, Math.max(1000, Math.min(next - now() + 500, 2 ** 31 - 1)));
    if (themeTimer.unref) themeTimer.unref();
  };
  armTheme();

  const send = (res, id) => { const t = topics.current(id, res.req.apiVersion); ok(res, t.vm, { id: t.id, rev: t.rev }); };
  // a save, from either version, is stored in the 3.0 names (after the structural check: toVocabulary assumes the shape)
  // R22-06 (api-v3.md D4): a v3 save takes 3.0 names only; a 2.x rule id or match kind is 400 'v2-name' (v2 saves take both)
  const incoming = (req, data) => {
    const bad = structural(data); if (bad) throw invalid(bad, 'invalid');
    if (req.apiVersion === 3) {
      const lr = rulesLib();
      for (const a of data.agents) {
        const c = lr.canonicalRuleId(a.agentId);
        const kind = a.match && a.match.kind, ck = kind ? lr.canonicalRole(kind) : null;
        if ((c && c !== a.agentId) || (ck && ck !== kind)) throw invalid('agents.' + a.agentId, 'v2-name');
      }
    }
    // O8: a 2.x client never sees presence, so its save keeps the stored value
    const stored = active().data && active().data.presence;
    const withPresence = req.apiVersion !== 3 && data.presence === undefined && stored ? Object.assign({}, data, { presence: stored }) : data;
    return asVersion(withPresence, 3);
  };
  const body = (req, allowed) => {
    const b = req.body;
    if (!b || typeof b !== 'object' || Array.isArray(b)) throw invalid(null, 'invalid');
    for (const k of Object.keys(b)) if (!allowed.includes(k)) throw invalid(k, 'unexpected-field');
    if (!Number.isInteger(b.expectedRevision)) throw invalid('expectedRevision', 'required');
    return b;
  };
  const commit = (req, res, data) => {
    const out = store.office.save({ expectedRevision: req.body.expectedRevision, data, actor: actorRefOf(req) });
    if (!out.ok) throw new ApiError('conflict', { current: { revision: out.current.revision, vm: vmOf(req.apiVersion) } });
    topics.invalidate('layout'); topics.invalidate('office'); armTheme();
    ok(res, { ok: true, result: null, revision: out.layout.revision, vm: vmOf(req.apiVersion) });
  };

  r.get('/office/layout', authed, (req, res) => send(res, 'layout'));
  r.get('/office/layout/revisions/:rev', authed, (req, res) => {
    const n = Number(req.params.rev);
    if (!/^\d{1,9}$/.test(req.params.rev)) throw invalid('rev', 'invalid');
    const x = store.office.revision(active().id, n);
    if (!x) throw new ApiError('not_found');
    ok(res, { revision: x.revision, updatedAt: x.updatedAt, updatedBy: actorOf(x.updatedBy), data: asVersion(x.data, req.apiVersion) });
  });
  r.put('/office/layout', authed, guard('store'), (req, res) => {
    const b = body(req, ['expectedRevision', 'data']);
    const data = incoming(req, b.data);
    validate(data);
    commit(req, res, data);
  });
  r.put('/office/layout/theme', authed, guard('store'), (req, res) => {
    const b = body(req, ['expectedRevision', 'theme']);
    const data = asVersion(Object.assign({}, active().data, { theme: b.theme }), 3);
    validate(data);
    commit(req, res, data);
  });

  r.get('/prefs', authed, (req, res) => send(res, 'prefs'));
  r.patch('/prefs', authed, guard('store'), (req, res) => {
    const b = req.body;
    if (!b || typeof b !== 'object' || Array.isArray(b)) throw invalid(null, 'invalid');
    for (const k of Object.keys(b)) if (k !== 'uiTheme' && k !== 'locale') throw invalid(k, 'unexpected-field');
    if (b.uiTheme !== undefined && !['system', 'dark', 'light'].includes(b.uiTheme)) throw invalid('uiTheme', 'invalid');
    if (b.locale !== undefined && b.locale !== null && !['fr', 'en'].includes(b.locale)) throw invalid('locale', 'invalid');   // G3c; null = follow the browser
    store.office.setPrefs(b);
    topics.invalidate('prefs');
    ok(res, { ok: true, result: store.office.prefs(), revision: null, vm: null });
  });

  return { active, close: () => clearTimeout(themeTimer) };
}

module.exports = { mountOfficeLayout, resolveTheme, structural, asVersion };
