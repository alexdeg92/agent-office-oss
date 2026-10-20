'use strict';
/*
 * S7c: the OpenClaw-class v2 commands (api.md §5.1, §5.2) on the adapter's `commands`: flows CRUD and run, the skill
 * toggle, the gateway restart, and the async chat turn (progress on the `chat` topic).
 *   - every body is validated with extra fields rejected; ids are validated, never stripped (R1-12: invalid or
 *     leading-dash → 400 invalid-id);
 *   - guard('openclaw'): 403 readonly on a read-only instance (the CLI wrapper refuses too);
 *   - audited by the audit router (src/api/audit.js); results use CommandResult; the VMs follow over SSE.
 */
const crypto = require('crypto');
const { ApiError, invalid } = require('./errors');
const {resolveWireId}=require('./runtime-projection');
const { buildChatVM } = require('./vm/chat');
const { LABELS } = require('../../i18n/fr');
const { humanPerson } = require('../../security/request-actor');
const { resolveSender } = require('../../engine/model/sender');
const { runAuthorized } = require('../../security/dispatch-context');
const { CHAT_REF } = require('../chat-constants');
const { scopeForAccount, sessionRefForScope, supportsPrincipalChat } = require('../chat-identity');

const FLOW_ID = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/;
const SKILL_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;   // no '.': the name becomes a config path segment
const CRON_FIELD = /^[0-9A-Za-z*/,\-]+$/;
const RESTART_COOLDOWN_MS = 2 * 60 * 1000;
const CHAT_TIMEOUT_MS = 150000;

const TZS = (() => { try { return new Set(Intl.supportedValuesOf('timeZone').concat(['UTC'])); } catch (_) { return new Set(['UTC']); } })();
const result = (r = null) => ({ ok: true, result: r, revision: null, vm: null });

function noExtra(body, allowed) {
  if (body == null || typeof body !== 'object' || Array.isArray(body)) throw invalid(null, 'invalid');
  for (const k of Object.keys(body)) if (!allowed.includes(k)) throw invalid(k, 'unexpected-field');
}
function check(b, { partial }) {
  const out = {};
  if (b.name !== undefined) { if (typeof b.name !== 'string' || !b.name.trim() || b.name.trim().length > 80) throw invalid('name', 'length'); out.name = b.name.trim(); }
  if (b.cron !== undefined) {
    const parts = typeof b.cron === 'string' ? b.cron.trim().split(/\s+/) : [];
    if (parts.length !== 5 || !parts.every((p) => CRON_FIELD.test(p))) throw invalid('cron', 'cron-format');
    out.cron = parts.join(' ');
  }
  if (b.tz !== undefined) { if (typeof b.tz !== 'string' || !TZS.has(b.tz)) throw invalid('tz', 'unknown-tz'); out.tz = b.tz; }
  if (b.message !== undefined) { if (typeof b.message !== 'string' || !b.message.trim() || b.message.length > 4000) throw invalid('message', 'length'); out.message = b.message; }
  if (!partial) for (const f of ['name', 'cron', 'tz', 'message']) if (out[f] === undefined) throw invalid(f, 'required');
  return out;
}
// A failed CLI command → 502 upstream_failed (readonly → 403), with the category as the detail issue.
function failed(x) {
  if (x.failed === 'readonly') return new ApiError('readonly');
  if (x.failed === 'busy') return new ApiError('rate_limited', { details: [{ issue: 'command-busy' }] });
  return new ApiError('upstream_failed', { details: [{ issue: String(x.failed || 'error') }] });
}

/**
 * @param {object} p   { r, engine, topics, runtime, authed, guard, ok, views, now, log }
 */
function mountCommands({ r, engine, topics, store, runtime, authed, guard, ok, views, now = () => Date.now(), log = () => {} }) {
  const cmd = runtime && runtime.commands;
  const pendingFlowRuns = new Set();
  const need = (fn) => { if (!cmd || typeof cmd[fn] !== 'function') throw new ApiError('not_found'); return cmd[fn]; };
  const dispatch = (req, fn, ...args) => { const run = need(fn); return runAuthorized(req.authorize,()=>run(...args)); };
  const live = req => { try { req.authorize?.(); return true; } catch (_) { return false; } };
  const primary = () => { const a = engine.primaryAgent(); return a ? a.id : null; };   // G3a: the one resolver
  const needPrimary = () => { const id = primary(); if (!id) throw new ApiError('upstream_unavailable', { details: [{ issue: 'agent-unknown' }] }); return id; };
  const job = (id,version) => { if (!FLOW_ID.test(String(id)) && !require('../../runtime-ids').parseId(id, 'flow')) throw invalid('jobId', 'invalid-id'); const key = resolveWireId(engine,id,'flow',version); const j = engine.cronJobs().find((x) => x.id === key); if (!j) throw new ApiError('not_found'); return j; };
  // After a flow write: re-read the list (and the job's runs), then the flow topics rebuild.
  const afterFlows = async (req, jobId) => {
    if (live(req) && runtime && runtime.refreshFlows) { try { await runAuthorized(req.authorize,()=>runtime.refreshFlows()); } catch (_) { /* the next poll catches up */ } }
    // A successful write does not confer permission to read run history. Recheck after the list refresh too.
    const historyAuthority = req.authorize ? () => { req.authorize(); if(!store.policy.can(req.user,'logs','read'))throw new ApiError('forbidden'); } : null;
    if (live(req) && jobId && views && (!req.authorize || store.policy.can(req.user, 'logs', 'read'))) runAuthorized(historyAuthority,()=>views.pull('flowRuns', jobId, { limit: 25 }, { force: true })).catch(() => {});
    topics.invalidate('flows'); topics.invalidate('flow'); topics.invalidate('office');
  };

  // R22-05 (api-v3.md D1): a command the adapter DECLARES unavailable doesn't exist on this instance: 404 not_found, before
  // the read-only guard, whatever functions the adapter happens to have.
  const CAPS = { flowWrite: (c) => !!(c.flows && c.flows.write), skillToggle: (c) => !!(c.skills && c.skills.toggle),
    // A shared runtime chat session is unsafe in a multi-user installation.
    // Adapters opt into portal chat only when they can make a stable distinct
    // session for each authenticated account.
    chat: supportsPrincipalChat, restart: (c) => !!c.restart };
  const targetRuntime = req => {
    const params=req?.params||{},body=req?.body||{};
    const wire=params.jobId || params.name || body.agentId;
    const kind=params.jobId?'flow':params.name?'skill':'agent';
    const key=wire?resolveWireId(engine,wire,kind,req?.apiVersion):primary();
    return body.runtimeId && engine.runtimeForInstance ? engine.runtimeForInstance(body.runtimeId) : engine.runtimeFor ? engine.runtimeFor(key) : engine.runtime();
  };
  const capable = (name) => (req, res, next) => CAPS[name](targetRuntime(req)?.capabilities || {}) ? next() : next(new ApiError('not_found'));

  // ---- flows ------------------------------------------------------------------------------------------------
  r.post('/flows', authed, capable('flowWrite'), guard('openclaw'), async (req, res) => {
    // G5 (api-v3.md D7): 3.0 may name the agent (a listed one) when the runtime declares multi-agent flows; default the primary
    const caps = (targetRuntime(req)?.capabilities || {}).flows || {};
    const multi = req.apiVersion === 3 && caps.multiAgent === true;
    noExtra(req.body, multi ? ['name', 'cron', 'tz', 'message', 'agentId', 'runtimeId'] : req.apiVersion === 3 ? ['name', 'cron', 'tz', 'message', 'runtimeId'] : ['name', 'cron', 'tz', 'message']);
    const b = check(req.body, { partial: false });
    let agentId = needPrimary();
    if (req.body.runtimeId && !req.body.agentId) {
      const source=engine.instances?.find(i=>i.id===req.body.runtimeId && i.enabled);
      const local=source?.engine?.primaryAgent()?.id || source?.engine?.agents()[0]?.id;
      if (!local) throw invalid('runtimeId','unknown-agent');
      agentId=require('../../runtime-ids').scopedId(source.id,'agent',local);
    }
    if (multi && req.body.agentId !== undefined) {
      if (typeof req.body.agentId !== 'string' || !engine.agents().some((a) => a.id === req.body.agentId)) throw invalid('agentId', 'unknown-agent');
      agentId = req.body.agentId;
    }
    if (engine.instances) {
      const eligible = engine.runtimes().filter(r => r.enabled && r.capabilities?.flows?.write);
      if (eligible.length > 1 && !req.body.runtimeId) throw invalid('runtimeId', 'required');
      const scope = req.body.runtimeId || eligible[0]?.id;
      if (!engine.agents().some(a => a.id === agentId && require('../../runtime-ids').parseId(a.id, 'agent')?.runtime === scope)) throw invalid('agentId', 'wrong-runtime');
    }
    const x = await dispatch(req, 'flowCreate', Object.assign(b, { agentId, ...(req.body.runtimeId ? { runtimeId: req.body.runtimeId } : {}) }));
    if (!x.ok) throw failed(x);
    await afterFlows(req, x.jobId);
    ok(res, result({ jobId: x.jobId }));
  });
  r.patch('/flows/:jobId', authed, capable('flowWrite'), guard('openclaw'), async (req, res) => {
    const j = job(req.params.jobId,req.apiVersion);
    noExtra(req.body, ['name', 'cron', 'tz', 'message']);
    if (!Object.keys(req.body).length) throw invalid(null, 'empty');
    if (!(j.schedule && j.schedule.kind === 'cron' && j.payload && j.payload.kind === 'agent-turn')) throw invalid('jobId', 'not-editable');
    const b = check(req.body, { partial: true });
    const x = await dispatch(req, 'flowEdit', j.id, b);
    if (!x.ok) throw failed(x);
    await afterFlows(req, j.id);
    ok(res, result());
  });
  r.put('/flows/:jobId/enabled', authed, capable('flowWrite'), guard('openclaw'), async (req, res) => {
    const j = job(req.params.jobId,req.apiVersion);
    noExtra(req.body, ['enabled']);
    if (typeof req.body.enabled !== 'boolean') throw invalid('enabled', 'invalid');
    const x = await dispatch(req, 'flowSetEnabled', j.id, req.body.enabled);
    if (!x.ok) throw failed(x);
    await afterFlows(req, j.id);
    ok(res, result());
  });
  r.post('/flows/:jobId/runs', authed, capable('flowWrite'), guard('openclaw'), async (req, res) => {
    const j = job(req.params.jobId,req.apiVersion);
    noExtra(req.body || {}, []);
    const runs = engine.cronRuns(j.id);
    if (pendingFlowRuns.has(j.id) || (runs && runs.runs.some((x) => x.status === 'running'))) throw new ApiError('conflict', { details: [{ issue: 'run-pending' }] });
    pendingFlowRuns.add(j.id);
    try {
      const x = await dispatch(req, 'flowRun', j.id);
      if (!x.ok) throw failed(x);
      await afterFlows(req, j.id);
      ok(res, result());
    } finally { pendingFlowRuns.delete(j.id); }
  });
  r.delete('/flows/:jobId', authed, capable('flowWrite'), guard('openclaw'), async (req, res) => {
    const j = job(req.params.jobId,req.apiVersion);
    noExtra(req.body || {}, []);
    const x = await dispatch(req, 'flowDelete', j.id);
    if (!x.ok) throw failed(x);
    await afterFlows(req, null);
    ok(res, result());
  });

  // ---- skills -----------------------------------------------------------------------------------------------
  r.put('/skills/:name/enabled', authed, capable('skillToggle'), guard('openclaw'), async (req, res) => {
    const native = req.params.name;
    const name = resolveWireId(engine,native,'skill',req.apiVersion);
    if (!SKILL_ID.test(name) && !require('../../runtime-ids').parseId(name, 'skill')) throw invalid('name', 'invalid-id');
    if (!engine.skills().some((s) => s.name === name)) throw new ApiError('not_found');
    noExtra(req.body, ['enabled']);
    if (typeof req.body.enabled !== 'boolean') throw invalid('enabled', 'invalid');
    const x = await dispatch(req, 'skillSetEnabled', name, req.body.enabled);
    if (!x.ok) throw failed(x);
    if (views) views.pendingRestart.add(name);
    if (live(req) && runtime && runtime.refreshSkills) runAuthorized(req.authorize,()=>runtime.refreshSkills()).catch(() => {});
    topics.invalidate('skills'); topics.invalidate('skill');
    ok(res, result({ needsRestart: true }));
  });

  // ---- the gateway restart (kills the agent's running work: confirmed, rate-limited, audited) ----------------------
  let lastRestart = 0;
  r.post('/gateway/restart', authed, capable('restart'), guard('openclaw'), async (req, res) => {
    noExtra(req.body, req.apiVersion === 3 ? ['confirm', 'runtimeId'] : ['confirm']);
    if (engine.runtimes?.().filter(r => r.enabled && r.capabilities?.restart).length > 1 && !req.body.runtimeId) throw invalid('runtimeId', 'required');
    if (req.body.confirm !== 'redemarrer') throw invalid('confirm', 'invalid');
    if (lastRestart && now() - lastRestart < RESTART_COOLDOWN_MS) throw new ApiError('rate_limited');
    const restart = need('restartGateway');
    req.authorize?.();
    lastRestart = now();
    const x = await runAuthorized(req.authorize,()=>restart(req.body.runtimeId ? { runtimeId: req.body.runtimeId } : undefined));
    if (!x.ok) { lastRestart = 0; throw failed(x); }
    ok(res, result({ via: x.via }));
  });

  // ---- chat: an async agent turn; progress on the `chat` topic ---------------------------------------------------
  const chatStates = new Map(); // authenticated-account scope → isolated pending/errors/local transcript overlay
  const chatOperators = new Map(); // authenticated-account scope → canonical Person used for transcript echoes
  const identifyChatSession = session => {
    const scope = scopeForAccount(session?.userId, store);
    if (!chatOperators.has(scope)) {
      const user = session?.userId && store?.users?.byId?.(session.userId);
      const person = user && store?.persons?.list?.().find(row => row.id === user.person_id);
      const owner = store?.users?.owner?.();
      const singleOwner = scope === scopeForAccount(null, store);
      chatOperators.set(scope, person || (singleOwner || owner && user?.id === owner.id ? store?.persons?.owner?.() || store?.owner : null));
    }
    return scope;
  };
  const identifyChatRequest = req => identifyChatSession({ userId: req?.user?.id || req?.session?.userId || req?.principal?.id || null });
  const chatStateFor = scope => {
    if (!chatStates.has(scope)) chatStates.set(scope, { pending: null, errors: [], local: [] });
    return chatStates.get(scope);
  };
  // R22-07: every account chats with the resolver's primary, but through its
  // own adapter-declared session identity. No account key is accepted from the
  // request body or topic query.
  const chatKey = scope => {
    const agentId = needPrimary();
    const ref = sessionRefForScope(scope);
    const known = engine.sessions().find((s) => s.class.kind === 'explicit' && s.class.explicitKey === ref && s.class.agentId === agentId);
    if (known) return known.key;
    const def = runtime && runtime.definition;
    if (!def?.sessionKeyFor) throw new ApiError('not_found');
    const key = def.sessionKeyFor(agentId, ref, { purpose: 'chat', ownerScope: scope });
    if (!key || typeof key !== 'string') throw new ApiError('not_found');
    return key;
  };
  const chatTopic = scope => 'chat?scope=' + encodeURIComponent(scope);
  topics.define('chat', { params: ['scope'], build: ({ scope }) => {
    if (!supportsPrincipalChat(targetRuntime({params:{},body:{}})?.capabilities || {})) throw new ApiError('not_found');
    if (!/^[a-f0-9]{64}$/.test(String(scope || ''))) throw new ApiError('not_found');
    const state = chatStateFor(scope), key = chatKey(scope);
    return buildChatVM({ sessionKey: key, transcript: engine.transcript(key), pending: state.pending, errors: state.errors, local: state.local,
    avatarFor: views?.chatAvatarFor,
    senderContext: { runtime: runtime?.definition?.id || 'generic', operator: chatOperators.get(scope) || null,
      agent: (() => { const a = engine.primaryAgent(); return a ? { ...a, id: 'agent:' + a.id } : null; })(),
      people: store?.persons.senderPeople?.() || store?.persons.list() || [], sessionOf: sessionKey => engine.session(sessionKey) } });
  } });
  r.get('/views/chat', authed, capable('chat'), async (req, res) => {
    const scope = identifyChatRequest(req), key = chatKey(scope);
    req.authorize?.();
    if (views && engine.session(key)) await runAuthorized(req.authorize,()=>views.pull('transcript', key, {}, { force: true }));
    const t = topics.current(chatTopic(scope), req.apiVersion); ok(res, t.vm, { id: 'chat', rev: t.rev });
  });
  r.post('/chat/messages', authed, capable('chat'), guard('openclaw'), (req, res) => {
    noExtra(req.body, ['text']);
    const text = req.body.text;
    if (typeof text !== 'string' || !text.trim() || text.length > 8000) throw invalid('text', 'length');
    const scope = identifyChatRequest(req), state = chatStateFor(scope), key = chatKey(scope), ref = sessionRefForScope(scope);
    if (state.pending) throw new ApiError('conflict', { details: [{ issue: 'turn-pending' }] });
    const turn = need('agentTurn');
    const agentId = needPrimary();
    const turnId = 'turn_' + crypto.randomBytes(8).toString('hex');
    req.authorize?.();
    const acceptedPersonId=humanPerson(req,store),acceptedPerson=store?.persons?.list?.().find(p=>p.id===acceptedPersonId)||null;
    if(acceptedPerson)chatOperators.set(scope,acceptedPerson);
    const senderInfo = resolveSender({ role: 'user' }, { runtime: runtime?.definition?.id || 'generic', operator: acceptedPerson });
    state.pending = { turnId, since: now(), text, senderInfo };
    topics.invalidate('chat');
    res.status(202);
    ok(res, result({ turnId }));
    const sent = state.pending;
    Promise.resolve().then(() => runAuthorized(req.authorize,()=>turn({ agentId, text, sessionRef: ref, timeoutMs: CHAT_TIMEOUT_MS }))).then((x) => {
      // R15-03: the sent message and a successful reply are kept until the transcript shows them
      state.local.push({ id: 'sent_' + turnId, role: 'user', at: sent.since, since: sent.since, text: sent.text, senderInfo: sent.senderInfo, meta: null });
      if (!x.failed && x.text) state.local.push({ id: 'reply_' + turnId, role: 'assistant', at: Math.max(now(), sent.since + 1), since: sent.since, text: x.text,
        meta: x.meta ? { model: x.meta.model, tokens: x.meta.tokens, durationMs: x.meta.durationMs } : null });
      while (state.local.length > 40) state.local.shift();
      if (x.failed) {
        state.errors.push({ id: 'err_' + turnId, at: now(), text: LABELS['chat.turnFailed'] + ' (' + (LABELS['sourceError.' + x.failed] || x.failed) + ')' });
        if (state.errors.length > 20) state.errors.shift();
      }
    }).catch(() => { state.errors.push({ id: 'err_' + turnId, at: now(), text: LABELS['chat.turnFailed'] }); if (state.errors.length > 20) state.errors.shift(); })
      .finally(async () => {
        if (live(req) && views) { try { await runAuthorized(req.authorize,()=>views.pull('transcript', key, {}, { force: true })); } catch (_) { /* shown on the next read */ } }
        state.pending = null;
        topics.invalidate('chat');
      });
  });

  return { chatState: (scope = scopeForAccount(store?.users?.owner?.()?.id, store)) => { const state = chatStateFor(scope); return { pending: state.pending, errors: state.errors.slice() }; }, identifyChatSession,
    chatAvailable: req => supportsPrincipalChat(targetRuntime(req || {params:{},body:{}})?.capabilities || {}) };
}

module.exports = { mountCommands, RESTART_COOLDOWN_MS, CHAT_REF };
