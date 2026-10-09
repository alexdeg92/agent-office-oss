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
const { buildChatVM } = require('./vm/chat');
const { LABELS } = require('../../i18n/fr');

const FLOW_ID = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/;
const SKILL_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;   // no '.': the name becomes a config path segment
const CRON_FIELD = /^[0-9A-Za-z*/,\-]+$/;
const RESTART_COOLDOWN_MS = 2 * 60 * 1000;
const CHAT_REF = 'portal-chat';
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
  return new ApiError('upstream_failed', { details: [{ issue: String(x.failed || 'error') }] });
}

/**
 * @param {object} p   { r, engine, topics, runtime, authed, guard, ok, views, now, log }
 */
function mountCommands({ r, engine, topics, store, runtime, authed, guard, ok, views, now = () => Date.now(), log = () => {} }) {
  const cmd = runtime && runtime.commands;
  const need = (fn) => { if (!cmd || typeof cmd[fn] !== 'function') throw new ApiError('not_found'); return cmd[fn]; };
  const primary = () => { const a = engine.primaryAgent(); return a ? a.id : null; };   // G3a: the one resolver
  const needPrimary = () => { const id = primary(); if (!id) throw new ApiError('upstream_unavailable', { details: [{ issue: 'agent-unknown' }] }); return id; };
  const job = (id) => { if (!FLOW_ID.test(String(id))) throw invalid('jobId', 'invalid-id'); const j = engine.cronJobs().find((x) => x.id === id); if (!j) throw new ApiError('not_found'); return j; };
  // After a flow write: re-read the list (and the job's runs), then the flow topics rebuild.
  const afterFlows = async (jobId) => {
    if (runtime && runtime.refreshFlows) { try { await runtime.refreshFlows(); } catch (_) { /* the next poll catches up */ } }
    if (jobId && views) views.pull('flowRuns', jobId, { limit: 25 }, { force: true }).catch(() => {});
    topics.invalidate('flows'); topics.invalidate('flow'); topics.invalidate('office');
  };

  // R22-05 (api-v3.md D1): a command the adapter DECLARES unavailable doesn't exist on this instance: 404 not_found, before
  // the read-only guard, whatever functions the adapter happens to have.
  const CAPS = { flowWrite: (c) => !!(c.flows && c.flows.write), skillToggle: (c) => !!(c.skills && c.skills.toggle), chat: (c) => !!c.chat, restart: (c) => !!c.restart };
  const capable = (name) => (req, res, next) => { const c = (engine.runtime().capabilities) || {}; return CAPS[name](c) ? next() : next(new ApiError('not_found')); };

  // ---- flows ------------------------------------------------------------------------------------------------
  r.post('/flows', authed, capable('flowWrite'), guard('openclaw'), async (req, res) => {
    // G5 (api-v3.md D7): 3.0 may name the agent (a listed one) when the runtime declares multi-agent flows; default the primary
    const caps = (engine.runtime().capabilities || {}).flows || {};
    const multi = req.apiVersion === 3 && caps.multiAgent === true;
    noExtra(req.body, multi ? ['name', 'cron', 'tz', 'message', 'agentId'] : ['name', 'cron', 'tz', 'message']);
    const b = check(req.body, { partial: false });
    let agentId = needPrimary();
    if (multi && req.body.agentId !== undefined) {
      if (typeof req.body.agentId !== 'string' || !engine.agents().some((a) => a.id === req.body.agentId)) throw invalid('agentId', 'unknown-agent');
      agentId = req.body.agentId;
    }
    const x = await need('flowCreate')(Object.assign(b, { agentId }));
    if (!x.ok) throw failed(x);
    await afterFlows(x.jobId);
    ok(res, result({ jobId: x.jobId }));
  });
  r.patch('/flows/:jobId', authed, capable('flowWrite'), guard('openclaw'), async (req, res) => {
    const j = job(req.params.jobId);
    noExtra(req.body, ['name', 'cron', 'tz', 'message']);
    if (!Object.keys(req.body).length) throw invalid(null, 'empty');
    if (!(j.schedule && j.schedule.kind === 'cron' && j.payload && j.payload.kind === 'agent-turn')) throw invalid('jobId', 'not-editable');
    const b = check(req.body, { partial: true });
    const x = await need('flowEdit')(j.id, b);
    if (!x.ok) throw failed(x);
    await afterFlows(j.id);
    ok(res, result());
  });
  r.put('/flows/:jobId/enabled', authed, capable('flowWrite'), guard('openclaw'), async (req, res) => {
    const j = job(req.params.jobId);
    noExtra(req.body, ['enabled']);
    if (typeof req.body.enabled !== 'boolean') throw invalid('enabled', 'invalid');
    const x = await need('flowSetEnabled')(j.id, req.body.enabled);
    if (!x.ok) throw failed(x);
    await afterFlows(j.id);
    ok(res, result());
  });
  r.post('/flows/:jobId/runs', authed, capable('flowWrite'), guard('openclaw'), async (req, res) => {
    const j = job(req.params.jobId);
    noExtra(req.body || {}, []);
    const runs = engine.cronRuns(j.id);
    if (runs && runs.runs.some((x) => x.status === 'running')) throw new ApiError('conflict', { details: [{ issue: 'run-pending' }] });
    const x = await need('flowRun')(j.id);
    if (!x.ok) throw failed(x);
    await afterFlows(j.id);
    ok(res, result());
  });
  r.delete('/flows/:jobId', authed, capable('flowWrite'), guard('openclaw'), async (req, res) => {
    const j = job(req.params.jobId);
    noExtra(req.body || {}, []);
    const x = await need('flowDelete')(j.id);
    if (!x.ok) throw failed(x);
    await afterFlows(null);
    ok(res, result());
  });

  // ---- skills -----------------------------------------------------------------------------------------------
  r.put('/skills/:name/enabled', authed, capable('skillToggle'), guard('openclaw'), async (req, res) => {
    const name = req.params.name;
    if (!SKILL_ID.test(name)) throw invalid('name', 'invalid-id');
    if (!engine.skills().some((s) => s.name === name)) throw new ApiError('not_found');
    noExtra(req.body, ['enabled']);
    if (typeof req.body.enabled !== 'boolean') throw invalid('enabled', 'invalid');
    const x = await need('skillSetEnabled')(name, req.body.enabled);
    if (!x.ok) throw failed(x);
    if (views) views.pendingRestart.add(name);
    if (runtime && runtime.refreshSkills) runtime.refreshSkills().catch(() => {});
    topics.invalidate('skills'); topics.invalidate('skill');
    ok(res, result({ needsRestart: true }));
  });

  // ---- the gateway restart (kills the agent's running work: confirmed, rate-limited, audited) ----------------------
  let lastRestart = 0;
  r.post('/gateway/restart', authed, capable('restart'), guard('openclaw'), async (req, res) => {
    noExtra(req.body, ['confirm']);
    if (req.body.confirm !== 'redemarrer') throw invalid('confirm', 'invalid');
    if (lastRestart && now() - lastRestart < RESTART_COOLDOWN_MS) throw new ApiError('rate_limited');
    const restart = need('restartGateway');
    lastRestart = now();
    const x = await restart();
    if (!x.ok) { lastRestart = 0; throw failed(x); }
    ok(res, result({ via: x.via }));
  });

  // ---- chat: an async agent turn; progress on the `chat` topic ---------------------------------------------------
  let pending = null;            // { turnId, since, text }
  const errors = [];             // failed turns (role 'error'), newest last, at most 20
  const local = [];              // R15-03: finished turns' messages, shown until the transcript confirms them (≤ 40)
  // R22-07: the chat belongs to the resolver's primary; without one there is no chat (503 agent-unknown), never a guess
  const chatKey = () => {
    const agentId = needPrimary();
    const known = engine.sessions().find((s) => s.class.kind === 'explicit' && s.class.explicitKey === CHAT_REF && s.class.agentId === agentId);
    if (known) return known.key;
    const def = runtime && runtime.definition;
    return def && def.sessionKeyFor ? def.sessionKeyFor(agentId, CHAT_REF) : CHAT_REF;
  };
  topics.define('chat', { build: () => buildChatVM({ sessionKey: chatKey(), transcript: engine.transcript(chatKey()), pending, errors, local, senderContext: { runtime: runtime?.definition?.id || 'generic', operator: store?.owner, agent: (() => { const a = engine.primaryAgent(); return a ? { ...a, id: 'agent:' + a.id } : null; })(), people: store?.persons.senderPeople?.() || store?.persons.list() || [] } }) });
  r.get('/views/chat', authed, async (req, res) => {
    const key = chatKey();
    if (views && engine.session(key)) await views.pull('transcript', key, {}, { force: true });
    const t = topics.current('chat', req.apiVersion); ok(res, t.vm, { id: t.id, rev: t.rev });
  });
  r.post('/chat/messages', authed, capable('chat'), guard('openclaw'), (req, res) => {
    noExtra(req.body, ['text']);
    const text = req.body.text;
    if (typeof text !== 'string' || !text.trim() || text.length > 8000) throw invalid('text', 'length');
    if (pending) throw new ApiError('conflict', { details: [{ issue: 'turn-pending' }] });
    const turn = need('agentTurn');
    const agentId = needPrimary();
    const turnId = 'turn_' + crypto.randomBytes(8).toString('hex');
    pending = { turnId, since: now(), text };
    topics.invalidate('chat');
    res.status(202);
    ok(res, result({ turnId }));
    const sent = pending;
    Promise.resolve().then(() => turn({ agentId, text, sessionRef: CHAT_REF, timeoutMs: CHAT_TIMEOUT_MS })).then((x) => {
      // R15-03: the sent message and a successful reply are kept until the transcript shows them
      local.push({ id: 'sent_' + turnId, role: 'user', at: sent.since, since: sent.since, text: sent.text, meta: null });
      if (!x.failed && x.text) local.push({ id: 'reply_' + turnId, role: 'assistant', at: Math.max(now(), sent.since + 1), since: sent.since, text: x.text,
        meta: x.meta ? { model: x.meta.model, tokens: x.meta.tokens, durationMs: x.meta.durationMs } : null });
      while (local.length > 40) local.shift();
      if (x.failed) {
        errors.push({ id: 'err_' + turnId, at: now(), text: LABELS['chat.turnFailed'] + ' (' + (LABELS['sourceError.' + x.failed] || x.failed) + ')' });
        if (errors.length > 20) errors.shift();
      }
    }).catch(() => { errors.push({ id: 'err_' + turnId, at: now(), text: LABELS['chat.turnFailed'] }); })
      .finally(async () => {
        if (views) { try { await views.pull('transcript', chatKey(), {}, { force: true }); } catch (_) { /* shown on the next read */ } }
        pending = null;
        topics.invalidate('chat');
      });
  });

  return { chatState: () => ({ pending, errors: errors.slice() }) };
}

module.exports = { mountCommands, RESTART_COOLDOWN_MS, CHAT_REF };
