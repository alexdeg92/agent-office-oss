'use strict';
/*
 * architect-57 (B, C) · a project's comment thread (Owner: Projets ≈ a Slack project).
 *   - A person (or an agent's token) comments; an @mention of an agent DELIVERS the comment to that agent: one turn in
 *     the project's own session (agent:<id>:ao-projet-<slug>), with the project's context. Never a channel (no
 *     --deliver). The reply is posted back as the agent's comment (replyTo the mention). Serial per project.
 *   - The agent's status/priority changes (the project tag) show in the thread as system lines (from the history).
 *   - « Demander un résumé » runs in the same session: an event line, the reply as a comment, and the project summary.
 *   - Store writes are store class (read-only refuses them); a delivery needs OpenClaw writes, else it is 'unavailable'.
 * Topic `comments:<projectId>` (the first page); older pages by cursor.
 */
const { invalid, ApiError } = require('./errors');
const { labelsFor, resolveLocale } = require('../../i18n');
const { capabilitiesOf } = require('./vm/meta');

const { withTx } = require('../../store/db');
const { linkProjectActivity } = require('../../projects/activity');
const { indexOf, childKeys, completionResults, isFinal, finalText } = require('../../projects/session-results');
const { PROJECT_CONTEXT_READS, mayRead: mayReadComment } = require('../../security/comment-provenance');
const { runAuthorized } = require('../../security/dispatch-context');

const MAX_BODY = 4000;
const PAGE = 50;
const RECENT_IN_PROMPT = 8;
const TURN_MS = 150000;
const MENTION = /(^|[^\p{L}\p{N}_.@-])@([\p{L}\p{N}_][\p{L}\p{N}_.-]{0,63})/gu;

const foldMention = (v) => String(v || '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/\s+/g, '');
const slugOf = (v) => String(v || '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
const encodeCursor = (c) => Buffer.from(JSON.stringify({ seq: c.seq, at: c.createdAt }), 'utf8').toString('base64url');
function decodeCursor(raw) {
  try { const v = JSON.parse(Buffer.from(String(raw), 'base64url').toString('utf8')); if (Number.isInteger(v.seq) && Number.isInteger(v.at)) return v; } catch (_) { /* below */ }
  throw invalid('cursor', 'invalid');
}

// the project's slug: its tag's (a 'projet:<slug>' group), else its name's
function projectSlug(project) {
  const tag = (project.sources || []).find((x) => x.kind === 'sessionGroup' && x.ref && String(x.ref.groupId || '').startsWith('projet:'));
  return (tag && tag.ref.name) || slugOf(project.name).slice(0, 60) || project.id;
}
const sessionKeyOf = (agentId, project) => `agent:${agentId}:ao-projet-${projectSlug(project)}`;

/**
 * @param {object} deps { store, engine, runtime, topics, cfg, log, now }
 * → { attach(projects), mount(r, { authed, guard, ok }), summaryTurn(...) }
 */
function createProjectThread({ store, engine, runtime, topics, cfg, log = () => {}, now = () => Date.now(), pollMs = 5000, relayGraceMs = 30000, dispatchAuthority = null }) {
  const comments = store.comments;
  let service = null, repository = null;
  let closed = false;
  const sleepers = new Set();
  const jobs = new Set();
  const chains = new Map();   // projectId → the delivery chain (one turn at a time per project)
  const locale = () => resolveLocale({ instance: cfg && cfg.instanceLocale });
  const L = () => labelsFor(locale(), 'server');
  const fill = (tpl, p) => String(tpl).replace(/\{(\w+)\}/g, (_, k) => (p[k] == null ? '' : String(p[k])));
  const agents = () => engine.agents() || [];
  const primaryId = () => { const a = engine.primaryAgent(); return a ? a.id : null; };
  const agentName = (id) => (agents().find((a) => a.id === id) || {}).name || id;
  const invalidate = (projectId) => topics.invalidateIds(['comments:' + encodeURIComponent(projectId)]);
  const contextRequirements = PROJECT_CONTEXT_READS;
  const authorizeDelivery = (c,d) => {
    if (!dispatchAuthority) return;
    const user=dispatchAuthority.authorize(d.follow?.authority,{commands:c.kind==='event'?['projects.regenerateSummary','projects.retryComment']:['projects.comment','projects.retryComment'],
      requirements:[...(c.kind==='event'?[{resource:'projects.regenerate',level:'write'}]:[]),...contextRequirements]});
    if(c.author.kind!=='person'||c.author.id!==user.person_id)throw new ApiError('unauthorized');
    if(!capabilitiesOf(cfg).storeWrites||!capabilitiesOf(cfg).openclawWrites)throw new ApiError('readonly');
    return user;
  };

  function projectOf(id) {
    const p = repository && repository.getProject(id);
    if (!p) throw new ApiError('not_found');
    return p;
  }
  function mentionsOf(body) {
    const list = agents(), out = [];
    for (const m of String(body).normalize('NFC').matchAll(MENTION)) {
      const t = foldMention(m[2]).replace(/[.-]+$/, '');
      const a = list.find((x) => foldMention(x.id) === t) || list.find((x) => foldMention(x.name) === t);
      if (a && !out.includes(a.id)) out.push(a.id);
    }
    return out;
  }

  // ---- the VM ----
  const chipOf = (author) => {
    if (author.kind === 'system') return { kind: 'system', name: author.name };
    const isAgent = author.kind === 'agent';
    return { id: author.id || (isAgent ? 'agent' : store.owner.id), kind: isAgent ? 'agent' : 'human', name: isAgent ? agentName(author.id) : author.name, avatarUrl: null, state: null };
  };
  const mine = (c, actor) => (actor.kind === 'agent' ? c.author.kind === 'agent' && c.author.id === actor.agentId : c.author.kind === 'person' && c.author.id === actor.personId);
  function itemOf(c, actor) {
    const event = c.kind === 'event';
    return {
      id: c.id, kind: event ? 'event' : 'comment', at: c.createdAt, author: chipOf(c.author),
      body: event || c.deleted ? null : c.body,
      text: event ? { key: 'projectThread.event.' + c.body, params: { actor: chipOf(c.author).name } } : null,
      mentions: c.mentions.map((id) => ({ id, name: agentName(id) })),
      replyTo: c.replyTo,
      delivery: c.delivery.map((d) => ({ agentId: d.agentId, status: d.status, reason: d.reason || null })),
      editedAt: c.editedAt, deleted: c.deleted,
      editable: !event && !c.deleted && mine(c, actor),
      deletable: !event && !c.deleted && (actor.kind !== 'agent' || mine(c, actor)),
    };
  }
  // the agent's status/priority changes (the tag), from the project history, as system lines
  function systemLines(projectId, from, to) {
    let items = [];
    try { items = service.views.history({ id: projectId, limit: 100 }).items || []; } catch (_) { return []; }
    return items.filter((x) => (x.kind === 'status' || x.kind === 'priority') && x.actor && x.actor.kind === 'agent' && x.at >= from && x.at <= to)
      .map((x) => ({ id: 'hist:' + x.id, kind: 'system', at: x.at, author: x.actor, body: null, text: x.text, mentions: [], replyTo: null, delivery: [],
        editedAt: null, deleted: false, editable: false, deletable: false }));
  }
  function threadVM(projectId, { cursor = null, actor = { kind: 'human', personId:store.owner.id } } = {}) {
    const project = projectOf(projectId);
    const mark = cursor ? decodeCursor(cursor) : null;
    const rows = comments.page(projectId, { before: mark ? mark.seq : null, limit: PAGE + 1 });
    const more = rows.length > PAGE;
    const page = rows.slice(0, PAGE).reverse();   // oldest first
    // the system lines of this page's time span (the oldest page takes every older one); at an equal time, after the comments
    const upper = mark ? mark.at - 1 : Number.MAX_SAFE_INTEGER;
    const lower = more ? page[0].createdAt : 0;
    const items = page.map((c) => itemOf(c, actor));
    for (const line of systemLines(projectId, lower, upper)) {
      const at = items.findIndex((x) => x.at > line.at);
      items.splice(at < 0 ? items.length : at, 0, line);
    }
    const caps = capabilitiesOf(cfg), pid = primaryId();
    return {
      projectId, items, nextCursor: more ? encodeCursor(page[0]) : null,
      mentionable: agents().map((a) => ({ id: a.id, name: a.name || a.id, avatarUrl: null, primary: a.id === pid })),
      canComment: caps.storeWrites, canMention: caps.storeWrites && caps.openclawWrites,
      session: pid ? { key: sessionKeyOf(pid, project), route: '/journaux/' + encodeURIComponent(sessionKeyOf(pid, project)) } : null,
    };
  }

  // ---- delivery ----
  async function contextOf(project, { exclude = null, authorize = () => {}, user = null } = {}) {
    authorize();
    const l = L();
    const rows = []; let before = null;
    while (rows.length < RECENT_IN_PROMPT) {
      const page = comments.page(project.id, { before, limit: 50 });
      rows.push(...page.filter((c) => c.kind === 'comment' && !c.deleted && c.id !== exclude && (!dispatchAuthority || mayReadComment(store,user,c.id))));
      if (page.length < 50) break;
      before = page.at(-1).seq;
    }
    const recent = rows.slice(0, RECENT_IN_PROMPT).reverse()
      .map((c) => '- ' + (c.author.kind === 'agent' ? agentName(c.author.id) : c.author.name) + ' : ' + c.body.replace(/\s+/g, ' ').slice(0, 400));
    return fill(l['prompt.projectContext'], {
      name: project.name, slug: projectSlug(project), status: l['projectStatus.' + project.status] || project.status, priority: project.priority || '—',
      summary: (project.summary || '').replace(/\s+/g, ' ').slice(0, 800) || '—',
      sources: await linkedContext(project,authorize),
      recent: recent.length ? recent.join('\n') : l['prompt.noComments'],
    });
  }
  async function read(key, authorize = () => {}) {
    authorize();
    try {
      const r = await runAuthorized(authorize,()=>engine.request('transcript', key, { full: true, background: true }));
      authorize();
      return r?.ok ? engine.transcript(key) : null;
    } catch (e) { if(e instanceof ApiError)throw e;return null; }
  }
  async function linkedContext(project, authorize) {
    authorize();
    const sessions = engine.sessions();
    const matched = linkProjectActivity({ projects: [{ ...project, archivedAt: null }], sessions,
      projectHints: engine.projectHints?.() || [], workspaceRoots: repository.workspaceRoots || [] }).matches;
    const keys = new Set(matched.filter((m) => m.kind === 'session').map((m) => m.ref));
    // Explicit keys are useful even before sessions.list has discovered them.
    for (const s of project.sources || []) if (s.kind === 'sessionGroup' && s.ref?.by === 'keys') for (const key of s.ref.sessionKeys) keys.add(key);
    const ordered = [...keys].sort((a, b) => (engine.session(b)?.updatedAt || 0) - (engine.session(a)?.updatedAt || 0));
    const blocks = []; let left = 8000;
    for (const key of ordered) {
      if (left < 250) break;
      const t = await read(key,authorize) || engine.transcript(key);
      const ev = t?.events || [], session = engine.session(key);
      const ask = ev.findLast((e) => e.kind === 'user' && e.text && (!/\[Subagent Context\]/.test(e.text) || /\[Subagent Task\]/.test(e.text)));
      let result = finalText(t);
      // A parent may only contain a completion event; prefer the child's actual final reply when available.
      const children = childKeys(ev);
      const childResults = [];
      for (const child of children.slice(-8)) {
        const ct = await read(child,authorize) || engine.transcript(child);
        const text = finalText(ct);
        if (text) childResults.push(text);
      }
      if (childResults.length) result = childResults.join('\n\n');
      else if (!result) result = completionResults(ev).map((x) => x.text).join('\n\n');
      const block = fill(L()['prompt.projectConversation'], {
        key, children: children.join(', ') || '—', who: [ask?.sender, agentName(session?.class?.agentId || key.split(':')[1] || '')].filter(Boolean).join(' → '),
        when: new Date(session?.updatedAt || ask?.at || 0).toISOString(),
        request: (ask?.text || '—').split('[Subagent Task]').at(-1).trim().slice(0, 700), result: result.slice(0, 1500) || L()['prompt.noResult'],
      }).slice(0, left);
      blocks.push(block); left -= block.length + 2;
    }
    return blocks.join('\n\n') || (service.views.project({ id: project.id }).sources || []).map((s) => s.label).join(', ') || L()['prompt.noSources'];
  }
  function update(commentId, agentId, patch) {
    const c = comments.get(commentId);
    if (!c || closed) return;
    comments.setDelivery(commentId, c.delivery.map((d) => d.agentId === agentId ? { ...d, ...patch } : d));
    invalidate(c.projectId);
  }
  function enqueue(projectId, fn) {
    const prev = chains.get(projectId) || Promise.resolve();
    const next = prev.then(fn, fn).catch((e) => log('comments: delivery failed (' + (e?.code || 'error') + ')'));
    chains.set(projectId, next);
    next.finally(() => { if (chains.get(projectId) === next) chains.delete(projectId); });
    return next;
  }
  function pause() {
    return new Promise((resolve) => {
      const wake = () => { clearTimeout(timer); sleepers.delete(wake); resolve(); };
      const timer = setTimeout(wake, pollMs); timer.unref?.(); sleepers.add(wake);
    });
  }
  function postAgent(project, agentId, text, replyTo) {
    // Preserve the entire admitted message despite the per-comment limit.
    const chars = [...text];
    for (let at = 0; at < chars.length; at += MAX_BODY) comments.create({ projectId: project.id,
      author: { kind: 'agent', id: agentId, name: agentName(agentId) }, body: chars.slice(at, at + MAX_BODY).join(''), replyTo, provenance:contextRequirements, at: now() });
    invalidate(project.id);
  }
  function releaseSummary(c, d) {
    if (d.follow?.summary) service.commands.abandonSummary({ id: c.projectId, turnId: d.follow.summary.turnId });
  }
  function settleDelivery(c, d, status, reason) {
    withTx(store.db, () => {
      d.follow.phase = 'settled'; releaseSummary(c, d);
      update(c.id, d.agentId, { status, reason, follow: d.follow });
    });
  }
  function applySummary(c, d, text) {
    const meta = d.follow.summary;
    if (!meta) return;
    const p = projectOf(c.projectId);
    // Project tags may move the revision while the task runs. A person's summary edit still wins.
    if (p.summary !== meta.originalSummary && p.summary !== meta.lastSummary) return;
    const summary = text.slice(0, MAX_BODY);
    const done = service.commands.completeSummary({ id: p.id, turnId: meta.turnId, expectedRevision: p.revision,
      summary, actor: { kind: 'agent', agentId: d.agentId }, keepPending: true });
    if (done.result?.applied !== false) meta.lastSummary = summary;
  }
  function newDelivery(agentId, project, summary = null, authority = null) {
    return { agentId, status: 'pending', reason: null, follow: { phase: 'queued', sessionKey: sessionKeyOf(agentId, project),
      deadline: now() + 2 * 60 * 60 * 1000, cursor: null, seen: [], children: {}, results: [], summary, ...(authority?{authority}:{}) } };
  }
  async function follow(c, d) {
    const f = d.follow, project = projectOf(c.projectId);
    const t = await read(f.sessionKey);
    if (closed) return true;
    if (!t) { f.readOK = false; return false; }  // Gateway unavailable: retain the cursor; never consume last-good data as a new reply.
    f.readOK = true;
    const runEvents = (t.events || []).filter((e) => f.from == null ? e.at >= (f.startedAt || c.createdAt) : indexOf(e) >= f.from);
    const events = (t.events || []).filter((e) => f.cursor == null ? e.at >= (f.startedAt || c.createdAt) : indexOf(e) >= f.cursor);
    f.deferred ||= runEvents.some((e) => e.kind === 'tool' && /sessions_(yield|spawn)/.test(e.name + ' ' + e.input));
    for (const key of childKeys(runEvents)) if (!f.children[key]) f.children[key] = { done: false, text: null, at: null, posted: false };
    for (const result of completionResults(events)) if (!f.results.some((r) => r.id === result.id)) f.results.push({ ...result, receivedAt: now(), posted: false });
    const assistants = events.filter((e) => e.kind === 'assistant' && e.text?.trim());
    let terminal = f.terminal || null;
    const lastToolAt = Math.max(0, ...runEvents.filter((e) => e.kind === 'tool').map((e) => e.at || 0));
    if (terminal && terminal.at < lastToolAt) terminal = null;
    withTx(store.db, () => {
      for (const e of assistants) {
        if (!f.seen.includes(e.id)) {
          // The CLI reply may precede transcript visibility. Consume its matching event once.
          if (f.immediate === e.text.trim()) f.immediate = null;
          else postAgent(project, d.agentId, e.text.trim(), c.id);
          f.seen.push(e.id);
        }
        if (isFinal(e, events) && e.at >= lastToolAt) terminal = { text: e.text, at: e.at };
      }
      f.cursor = t.messageCount; f.terminal = terminal;
      update(c.id, d.agentId, { follow: f });
    });
    for (const [key, child] of Object.entries(f.children)) {
      const ct = await read(key);
      if (closed) return true;
      const text = finalText(ct);
      if (text) { child.done = true; child.text = text; child.at ??= now(); }
    }
    // Reading children admits their project tags too. Refresh before invalidating the thread's system lines.
    await service.refresh({ changes: [{ type: 'Transcript' }], skipRepos: true });
    if (closed) return true;
    withTx(store.db, () => {
      const childrenDone = Object.values(f.children).every((x) => x.done) || (f.results.length > 0 && f.results.length >= Object.keys(f.children).length);
      const latestResultAt = Math.max(0, ...f.results.map((x) => x.at || 0));
      if (terminal && childrenDone && terminal.at >= latestResultAt) {
        applySummary(c, d, terminal.text.trim());
        f.phase = 'settled'; d.status = 'replied'; releaseSummary(c, d);
      } else {
        // Give the parent a chance to relay. When it doesn't, publish the child result and keep watching for a late relay.
        const results = Object.values(f.children).filter((x) => x.done);
        const fallback = results.length ? results : f.results;
        for (const result of fallback) if (!result.posted && now() - (result.receivedAt ?? result.at) >= relayGraceMs) {
          const posted = [...Object.values(f.children), ...f.results].some((x) => x.posted && x.text === result.text);
          result.posted = true;
          if (posted) continue;
          postAgent(project, d.agentId, result.text, c.id); d.status = 'replied';
          applySummary(c, d, result.text);
        }
      }
      if (f.phase !== 'settled' && d.status !== 'replied') d.status = 'working';
      update(c.id, d.agentId, { status: d.status, reason: null, follow: f });
    });
    return f.phase === 'settled';
  }
  function schedule(comment, agentId) {
    const job = comment.id + ':' + agentId;
    if (jobs.has(job) || closed) return;
    jobs.add(job);
    return enqueue(comment.projectId, async () => {
      let c = comments.get(comment.id), d = c.delivery.find((x) => x.agentId === agentId);
      if (!d || !['pending', 'working'].includes(d.status) && d.follow?.phase !== 'tracking') return;
      if (!d.follow) d.follow = { ...newDelivery(agentId, projectOf(c.projectId)).follow, phase: 'tracking', deadline: c.createdAt + 7200000 };
      const f = d.follow;
      const queued = f.phase === 'queued';
      try {
        if (now() >= f.deadline) { settleDelivery(c, d, d.status === 'replied' ? 'replied' : 'no-reply', d.status === 'replied' ? null : 'timeout'); return; }
        if (f.phase === 'queued') {
          const user = authorizeDelivery(c,d);
          const project = projectOf(c.projectId);
          const authorize = () => authorizeDelivery(c,d);
          const context = await contextOf(project, { exclude: c.id, authorize, user });
          authorize();
          const baseline = await read(f.sessionKey,authorize);
          if (closed) return;
          // Recheck after every context await and directly before the new external effect.
          authorize();
          f.cursor = baseline ? baseline.messageCount : null; f.from = f.cursor;
          f.phase = 'tracking'; f.startedAt = now();
          update(c.id, agentId, { status: 'working', follow: f });
          const prompt = context + '\n\n' + (c.kind === 'event' ? fill(L()['prompt.projectSummary'], { name: project.name, status: project.status, sources: L()['prompt.projectSourcesAbove'] })
            : fill(L()['prompt.projectComment'], { author: c.author.name, body: c.body }));
          const out = await runAuthorized(authorize,()=>runtime.commands.agentTurn({ agentId, text: prompt, sessionRef: f.sessionKey, timeoutMs: TURN_MS }));
          if (closed) return;
          if (out?.failed) { settleDelivery(c, d, 'failed', out.failed); return; }
          const text = out?.text?.trim();
          if (text) withTx(store.db, () => { postAgent(project, agentId, text, c.id); f.immediate = text; d.status = 'working';
            update(c.id, agentId, { status: 'working', follow: f }); });
          const settled = await follow(c, d);
          if (settled) return;
          // A synchronous reply with a successful session read and no deferred work is complete.
          if (text && f.readOK && !f.deferred && !Object.keys(f.children).length && !f.results.length) {
            withTx(store.db, () => { applySummary(c, d, text); f.phase = 'settled'; releaseSummary(c, d); update(c.id, agentId, { status: 'replied', follow: f }); });
            return;
          }
          if (!text && f.readOK && !f.deferred && !Object.keys(f.children).length && engine.transcript(f.sessionKey)?.messageCount) {
            settleDelivery(c, d, 'failed', 'empty'); return;
          }
        }
        while (!closed) {
          if (now() >= f.deadline) {
            settleDelivery(c, d, d.status === 'replied' ? 'replied' : 'no-reply', d.status === 'replied' ? null : 'timeout'); return;
          }
          if (await follow(c, d)) return;
          await pause();
        }
      } catch (e) {
        if (e instanceof ApiError && queued) { settleDelivery(c,d,'failed',e.code==='readonly'?'readonly':'permission-denied'); return; }
        // Persisted tracking is retried by the worker/restart; never silently drop a pending delivery.
        log('comments: tracking interrupted (' + (e?.code || 'error') + ')');
        if (!closed) await pause();
      }
    }).finally(() => {
      jobs.delete(job);
      if (!closed) { const fresh = comments.get(comment.id), delivery = fresh?.delivery.find((x) => x.agentId === agentId);
        if (delivery && (['pending', 'working'].includes(delivery.status) || delivery.follow?.phase === 'tracking')) schedule(fresh, agentId); }
    });
  }
  function deliver(comment) { for (const d of comment.delivery) if (d.status === 'pending') schedule(comment, d.agentId); }
  function persistSummary(projectId, agentId, actor, meta, authority = null) {
    const project = projectOf(projectId);
    if (!meta.turnId || repository.getSummaryTurn(projectId) !== meta.turnId) throw new ApiError('conflict');
    return comments.create({ projectId, kind: 'event', author: authorOf(actor), body: 'summary-requested',
      delivery: [newDelivery(agentId, project, { ...meta, originalSummary: project.summary, lastSummary: null },authority)], at: now() });
  }
  function requestSummary(projectId, agentId, actor, meta) {
    const requested = withTx(store.db, () => persistSummary(projectId, agentId, actor, meta));
    invalidate(projectId); deliver(requested);
    return requested;
  }
  // The HTTP accept path claims the lock and inserts delivery in one transaction, before dispatch or 202.
  function startSummary(input, agentId, actor, req = null) {
    const authority = dispatchAuthority ? dispatchAuthority.capture(req) : null;
    if(dispatchAuthority)dispatchAuthority.authorize(authority,{commands:['projects.regenerateSummary'],requirements:contextRequirements});
    let requested;
    const accepted = withTx(store.db, () => {
      const turn = service.commands.regenerateSummary(input);
      requested = persistSummary(input.id, agentId, actor, { turnId: turn.result.turnId, expectedRevision: turn.revision },authority);
      return turn;
    });
    invalidate(input.id); deliver(requested);
    return accepted;
  }

  const authorOf = (actor) => (actor.kind === 'agent'
    ? { kind: 'agent', id: actor.agentId, name: agentName(actor.agentId) }
    : { kind: 'person', id: actor.personId, name: store.persons.list().find(p=>p.id===actor.personId)?.name || 'Owner' });

  function mount(r, { authed, guard, ok }) {
    topics.define('comments', { params: 'path', build: (p) => threadVM(p.key) });
    const wrap = (fn) => async (req, res, next) => { try { await fn(req, res); } catch (e) { next(e); } };
    const actorOf = (req) => require('../../security/request-actor').requestActor(req,store);
    const bodyOf = (req, allowed) => {
      const b = req.body || {};
      if (typeof b !== 'object' || Array.isArray(b)) throw invalid(null, 'invalid');
      for (const k of Object.keys(b)) if (!allowed.includes(k)) throw invalid(k, 'unexpected-field');
      if (typeof b.body !== 'string' || !b.body.trim()) throw invalid('body', 'required');
      if ([...b.body].length > MAX_BODY) throw invalid('body', 'too-long');
      return b.body.trim();
    };
    const own = (req) => {
      const c = comments.get(req.params.cid);
      if (!c || c.projectId !== req.params.id || c.kind !== 'comment') throw new ApiError('not_found');
      if (c.deleted) throw invalid(null, 'deleted');
      return c;
    };
    const send = (req, res, c, status = 200) => {
      const vm = itemOf(comments.get(c.id), actorOf(req));
      res.status(status);
      ok(res, { ok: true, result: { comment: vm }, revision: null, vm: null });
    };

    r.get('/views/projects/:id/comments', authed, wrap((req, res) => {
      projectOf(req.params.id);
      if (req.query.cursor) return ok(res, threadVM(req.params.id, { cursor: req.query.cursor, actor: actorOf(req) }), null, 'comments');
      const t = topics.current('comments:' + req.params.id, req.apiVersion);
      // the topic is built for a person; an agent token sees its own comments as editable
      if (actorOf(req).kind === 'agent') return ok(res, threadVM(req.params.id, { actor: actorOf(req) }), null, 'comments');
      ok(res, t.vm, { id: t.id, rev: t.rev });
    }));
    r.post('/projects/:id/comments', authed, guard('store'), wrap((req, res) => {
      const project = projectOf(req.params.id);
      const text = bodyOf(req, ['body', 'replyTo']);
      const replyTo = req.body.replyTo ?? null;
      if (replyTo !== null) {
        if (typeof replyTo !== 'string' || !replyTo) throw invalid('replyTo', 'invalid');
        const parent = comments.get(replyTo);
        if (!parent || parent.projectId !== project.id) throw new ApiError('not_found');
        if (parent.deleted) throw invalid('replyTo', 'deleted');
      }
      const actor = actorOf(req);
      const mentions = mentionsOf(text).filter((id) => !(actor.kind === 'agent' && id === actor.agentId));
      req.authorize?.();
      const related = !dispatchAuthority || contextRequirements.every(r=>store.policy.can(req.user,r.resource,r.level));
      const writable = capabilitiesOf(cfg).openclawWrites;
      const canDeliver = writable && related;
      const authority = canDeliver && mentions.length && dispatchAuthority ? dispatchAuthority.capture(req) : null;
      const delivery = mentions.map((agentId) => (canDeliver ? newDelivery(agentId, project,null,authority) : { agentId, status: 'unavailable', reason: writable ? 'permission-denied' : 'readonly' }));
      const c = comments.create({ projectId: project.id, author: authorOf(actor), body: text, mentions, replyTo, delivery, at: now() });
      invalidate(project.id);
      send(req, res, c, 201);
      if (canDeliver && mentions.length) deliver(c);
    }));
    r.post('/projects/:id/comments/:cid/retry', authed, guard('store'), guard('openclaw'), wrap((req, res) => {
      const project = projectOf(req.params.id), c = comments.get(req.params.cid);
      if (!c || c.projectId !== project.id) throw new ApiError('not_found');
      if (c.deleted) throw invalid(null, 'deleted');
      if (!mine(c, actorOf(req))) throw new ApiError('forbidden');
      const b = req.body || {};
      if (typeof b !== 'object' || Array.isArray(b)) throw invalid(null, 'invalid');
      for (const k of Object.keys(b)) if (k !== 'agentId') throw invalid(k, 'unexpected-field');
      const d = c.delivery.find((x) => x.agentId === b.agentId);
      if (!d || !['failed', 'no-reply'].includes(d.status)) throw invalid('agentId', 'not-retryable');
      if (jobs.has(c.id + ':' + d.agentId)) throw invalid('agentId', 'not-retryable');
      if (c.kind === 'event' && hasPendingSummary(c.projectId)) throw new ApiError('conflict');
      req.authorize?.();
      const authority = dispatchAuthority ? dispatchAuthority.capture(req) : null;
      if(dispatchAuthority&&c.kind==='event')dispatchAuthority.authorize(authority,{commands:['projects.retryComment'],requirements:[{resource:'projects.regenerate',level:'write'}]});
      withTx(store.db, () => {
        const turn = c.kind === 'event' ? service.commands.regenerateSummary({ id: project.id, expectedRevision: project.revision }) : null;
        const summary = turn ? { originalSummary: project.summary, lastSummary: null, turnId: turn.result.turnId } : null;
        comments.setDelivery(c.id, c.delivery.map((x) => x.agentId === d.agentId ? newDelivery(d.agentId, project, summary,authority) : x));
      });
      invalidate(project.id); send(req, res, c, 202); deliver(comments.get(c.id));
    }));
    r.patch('/projects/:id/comments/:cid', authed, guard('store'), wrap((req, res) => {
      const c = own(req);
      if (!mine(c, actorOf(req))) throw new ApiError('forbidden');
      const text = bodyOf(req, ['body']);
      req.authorize?.();
      // an edit never re-delivers: the mentions shown are the ones delivered
      send(req, res, comments.edit(c.id, text, c.mentions, now()));
      invalidate(c.projectId);
    }));
    r.delete('/projects/:id/comments/:cid', authed, guard('store'), wrap((req, res) => {
      const c = own(req);
      const actor = actorOf(req);
      if ((actor.kind === 'agent'||req.authorize) && !mine(c, actor)) throw new ApiError('forbidden');
      req.authorize?.();
      send(req, res, comments.remove(c.id, now()));
      invalidate(c.projectId);
    }));
  }

  function hasPendingSummary(projectId) { return !!repository.getSummaryTurn(projectId); }
  return {
    attach(projects) {
      service = projects.service; repository = projects.repository;
      if (capabilitiesOf(cfg).storeWrites && capabilitiesOf(cfg).openclawWrites) for (const c of comments.active()) {
        // Pre-016 retry records had a null id. Adopt once without sending the prompt again.
        withTx(store.db, () => {
          let changed = false;
          for (const d of c.delivery) {
            const meta = d.follow?.summary;
            if (c.kind !== 'event' || !meta || meta.turnId || !(['pending', 'working'].includes(d.status) || d.follow?.phase === 'tracking')) continue;
            const p = projectOf(c.projectId);
            if (repository.getSummaryTurn(p.id) || (p.summary !== meta.originalSummary && p.summary !== meta.lastSummary)) continue;
            meta.turnId = service.commands.regenerateSummary({ id: p.id, expectedRevision: p.revision }).result.turnId;
            changed = true;
          }
          if (changed) comments.setDelivery(c.id, c.delivery);
        });
        for (const d of c.delivery) if (['pending', 'working'].includes(d.status) || d.follow?.phase === 'tracking') schedule(c, d.agentId);
      }
    },
    close() { closed = true; for (const wake of [...sleepers]) wake(); },
    mount, requestSummary, startSummary, hasPendingSummary, runProjectTurn: enqueue, threadVM, mentionsOf, sessionKeyOf, idle: () => Promise.all([...chains.values()]),
  };
}

module.exports = { createProjectThread, projectSlug, sessionKeyOf };
