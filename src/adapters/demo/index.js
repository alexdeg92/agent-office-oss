'use strict';
/*
 * G6: the `demo` runtime adapter (ADR-001 §3, §13). A believable small team, synthesised, so Agent Office runs without
 * any agent runtime: try it, develop the UI, take screenshots. It is also the proof that the adapter interface is
 * complete: it hands the engine CANONICAL values only (ingestCanonical, §12.4); no gateway, no CLI, no network.
 *
 *   - Deterministic: a seeded PRNG (mulberry32) and a tick counter drive everything. The same seed and the same ticks
 *     give the same state; wall-clock time only stamps it (`now`). Tests drive tick() by hand.
 *   - Live: every TICK_MS a tick advances conversations, the primary's work, sub-agents, scheduled flows and
 *     transcripts, so the office, journal, logs, flows and health move.
 *   - Read-only: runtime writes (flows, skills, chat, restart) are not capabilities; the instance reports readonly.
 *   - Generic names and identifiers; texts in English or French (the instance locale).
 */
const setupSchema = require('../../schema');
const TICK_MS = 4000;

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

const TEXT = {
  en: {
    user: ['Can you check the release notes before Friday?', 'Any update on the dashboard bug?', 'Please summarise this week\'s feedback.',
      'Could you draft a reply to the supplier?', 'What changed in the latest build?', 'Can you book a review for Tuesday?'],
    reply: ['On it. I\'ll report back shortly.', 'Done: the summary is in the shared notes.', 'I found two issues; details below.',
      'Draft ready for your review.', 'Scheduled. You\'ll get a reminder.', 'Checked: nothing blocking.'],
    goal: ['Review the open pull requests', 'Collect this week\'s customer feedback', 'Prepare the release notes', 'Tidy the project notes'],
    jobs: [['Daily digest', 'A short summary of yesterday\'s activity.', 'Summarise yesterday and post the digest.'],
      ['Weekly report', 'Progress, risks and next steps.', 'Write the weekly report.'], ['Inbox sweep', 'Sort and label new messages.', 'Sort the inbox.']],
    skills: [['web-search', 'Search the web and cite sources.'], ['summarise', 'Summarise long documents.'], ['calendar', 'Read and propose meetings.'], ['notes', 'Keep shared project notes.']],
    tool: 'Searched 3 sources', summary: 'Posted the digest to the team channel.', error: 'The mail server did not answer.',
  },
  fr: {
    user: ['Peux-tu vérifier les notes de version avant vendredi ?', 'Du nouveau sur le bogue du tableau de bord ?', 'Peux-tu résumer les retours de la semaine ?',
      'Peux-tu préparer une réponse au fournisseur ?', 'Qu’est-ce qui a changé dans la dernière version ?', 'Peux-tu planifier une revue mardi ?'],
    reply: ['Je m’en occupe et je reviens vers toi.', 'C’est fait : le résumé est dans les notes partagées.', 'J’ai trouvé deux problèmes ; détails ci-dessous.',
      'Brouillon prêt pour relecture.', 'C’est planifié, tu auras un rappel.', 'Vérifié : rien de bloquant.'],
    goal: ['Relire les demandes de fusion ouvertes', 'Rassembler les retours clients de la semaine', 'Préparer les notes de version', 'Ranger les notes du projet'],
    jobs: [['Résumé quotidien', 'Un court résumé de l’activité de la veille.', 'Résume la veille et publie le résumé.'],
      ['Rapport hebdomadaire', 'Avancement, risques et prochaines étapes.', 'Rédige le rapport hebdomadaire.'], ['Tri de la boîte', 'Trier et étiqueter les nouveaux messages.', 'Trie la boîte de réception.']],
    skills: [['web-search', 'Chercher sur le web et citer les sources.'], ['summarise', 'Résumer de longs documents.'], ['calendar', 'Lire l’agenda et proposer des réunions.'], ['notes', 'Tenir les notes partagées du projet.']],
    tool: '3 sources consultées', summary: 'Résumé publié dans le canal de l’équipe.', error: 'Le serveur de messagerie n’a pas répondu.',
  },
};

const AGENTS = [
  { id: 'nova', name: 'Nova', model: 'demo-large', primary: true },
  { id: 'sage', name: 'Sage', model: 'demo-medium', primary: false },
  { id: 'pixel', name: 'Pixel', model: 'demo-small', primary: false },
];
const PROVIDER = 'demo-ai';
// conversations: [channel, scope, peer, agent] → interlocutor '<channel>-user:<peer>' / '<channel>-room:<peer>'
const CONVERSATIONS = [['telegram', 'direct', 'alice', 'nova'], ['slack', 'group', 'general', 'nova'], ['slack', 'direct', 'bruno', 'sage'], ['webchat', 'direct', 'visitor-7', 'pixel']];

const definition = {
  id: 'demo',
  name: 'Demo',
  mark: { monogram: 'DM', color: '#6e56cf' },
  testedWith: null,
  schemas: {}, routes: {}, eventPrefix: 'demo.event.',
  gatewayLabel: 'Runtime de démonstration',
  gatewayLabels: { fr: 'Runtime de démonstration', en: 'Demo runtime' },
  sessionKeyFor: (agentId, ref) => 'demo:' + agentId + ':explicit:' + ref,
  normalise: {
    session: (row) => ({ session: row }),       // a canonical runtime: rows are already Sessions
    runtimeHealth: () => ({ version: 'demo', pluginsLoaded: null, eventLoop: null }),
  },
  // rows arrive classified (canonical); this is only asked about a key the runtime never sent
  classifySession: () => ({ kind: 'unrecognized', ruleId: 'demo', agentId: null, channel: null, heartbeatOf: null, background: false, rawClassification: null }),
  // read-only: no runtime write is a capability (the instance also reports readonly)
  capabilities: () => ({ sessions: true, transcripts: true, activity: 'run-state',
    flows: { read: true, write: false, schedules: ['cron'], multiAgent: false }, skills: { read: true, toggle: false, detail: true },
    channels: true, interlocutors: true, chat: false, restart: false, costs: true, subagents: true, sessionGroups: false }),
};

/** The deterministic team. `now()` stamps; `seed` and the tick count decide everything else. */
function createDemoTeam({ seed = 1, locale = 'en', now = () => Date.now() } = {}) {
  const rnd = mulberry32(seed);
  const T = TEXT[String(locale).toLowerCase().startsWith('fr') ? 'fr' : 'en'];
  const pick = (list) => list[Math.floor(rnd() * list.length)];
  const t0 = now();
  let tick = 0, subSeq = 0;
  const sessions = new Map();       // key → mutable session state
  const transcripts = new Map();    // key → [{ kind, text, at, ... }]
  const runs = new Map();           // jobId → [CronRun]
  const flowState = [];

  const idle = () => ({ status: 'idle', endReason: null, evidence: 'status-field', evidenceLevel: 'verified', observedAt: t0, expiresAt: null, startedAt: null, endedAt: null, hasActiveSubagentRun: false, runtimeMs: null, lastRunId: null, lastError: null });
  const agentOf = (id) => AGENTS.find((a) => a.id === id);
  function addSession(key, cls, extra = {}) {
    const a = agentOf(cls.agentId);
    const s = { key, sessionId: 'demo-' + key.replace(/[^a-z0-9]+/gi, '-'), cls: Object.assign({ ruleId: 'demo', channel: null, heartbeatOf: null, background: false, rawClassification: null }, cls),
      displayName: extra.displayName || null, model: { id: a.model, provider: PROVIDER }, total: Math.floor(500 + rnd() * 4000), updatedAt: t0 - Math.floor(rnd() * 3600000),
      run: idle(), parentKey: extra.parentKey || null, goal: extra.goal || null, interactive: true, done: false };
    sessions.set(key, s); transcripts.set(key, []);
    return s;
  }
  function say(key, kind, text) {
    const list = transcripts.get(key); const at = now();
    list.push(kind === 'assistant' ? { kind, text, at, model: sessions.get(key).model.id, provider: PROVIDER, outputTokens: 40 + Math.floor(rnd() * 200), stopReason: 'stop', error: null }
      : kind === 'tool' ? { kind, text, at } : { kind, text, at, sender: null });
    if (list.length > 40) list.shift();
  }
  function start(s) { s.run = Object.assign(idle(), { status: 'running', evidence: 'status-field', evidenceLevel: 'verified', observedAt: now(), startedAt: now(), lastRunId: 'r' + tick }); s.updatedAt = now(); }
  function finish(s, ok = true) {
    const started = s.run.startedAt || now();
    s.run = Object.assign(idle(), { status: ok ? 'succeeded' : 'failed', endReason: ok ? null : 'error', evidence: 'status-field', evidenceLevel: 'verified', observedAt: now(), startedAt: started, endedAt: now(),
      runtimeMs: Math.max(0, now() - started), lastRunId: s.run.lastRunId, lastError: ok ? null : T.error });
    s.total += 200 + Math.floor(rnd() * 1800); s.updatedAt = now();
  }

  // the team at tick 0
  for (const a of AGENTS) addSession('demo:' + a.id + ':primary', { kind: 'primary', agentId: a.id }, { displayName: a.name });
  for (const [channel, scope, peer, agentId] of CONVERSATIONS) {
    addSession(`demo:${agentId}:${channel}:${scope}:${peer}`, { kind: scope === 'direct' ? 'conversation-direct' : 'conversation-group', agentId, channel, chatScope: scope,
      interlocutorId: `${channel}-${scope === 'direct' ? 'user' : 'room'}:${peer}` });
  }
  T.jobs.forEach(([name, description, message], i) => {
    const id = 'demo-job-' + (i + 1);
    flowState.push({ id, name, description, message, every: [15, 40, 25][i], enabled: i !== 2, agentId: AGENTS[i % AGENTS.length].id, lastStatus: null, lastAt: null });
    runs.set(id, []);
    addSession('demo:' + AGENTS[i % AGENTS.length].id + ':scheduled:' + id, { kind: 'scheduled', agentId: AGENTS[i % AGENTS.length].id, cronJobId: id, background: true });
  });
  for (const key of sessions.keys()) { say(key, 'user', pick(T.user)); say(key, 'assistant', pick(T.reply)); }

  function step() {
    tick += 1;
    // conversations: a message comes in, the agent answers a tick or two later
    for (const s of sessions.values()) {
      if (!s.cls.kind.startsWith('conversation')) continue;
      if (s.run.status === 'running') { if (rnd() < 0.55) { say(s.key, 'assistant', pick(T.reply)); finish(s, rnd() > 0.04); } }
      else if (rnd() < 0.18) { say(s.key, 'user', pick(T.user)); start(s); }
    }
    // the primary works in bursts and delegates to sub-agents
    const primary = sessions.get('demo:nova:primary');
    if (primary.run.status === 'running') {
      if (rnd() < 0.3 && [...sessions.values()].filter((x) => x.cls.kind === 'subagent' && !x.done).length < 3) {
        subSeq += 1;
        const key = 'demo:nova:subagent:' + String(subSeq).padStart(4, '0');
        const sub = addSession(key, { kind: 'subagent', agentId: 'nova', subagentId: 'sub-' + String(subSeq).padStart(4, '0'), background: true }, { parentKey: primary.key, goal: pick(T.goal) });
        sub.updatedAt = now(); say(key, 'user', sub.goal); say(key, 'tool', T.tool); start(sub);
      }
      if (rnd() < 0.25) { say(primary.key, 'assistant', pick(T.reply)); finish(primary); }
    } else if (rnd() < 0.3) { say(primary.key, 'user', pick(T.user)); start(primary); }
    for (const s of sessions.values()) {
      if (s.cls.kind !== 'subagent' || s.done || s.run.status !== 'running') continue;
      if (rnd() < 0.35) { say(s.key, 'assistant', pick(T.reply)); finish(s, rnd() > 0.1); s.done = true; }
    }
    // keep the five latest sub-agents
    const subs = [...sessions.values()].filter((x) => x.cls.kind === 'subagent').sort((a, b) => a.key.localeCompare(b.key));
    for (const s of subs.slice(0, Math.max(0, subs.length - 5))) { sessions.delete(s.key); transcripts.delete(s.key); }
    // scheduled flows fire on their period (in ticks); a run starts, then ends on the next tick
    for (const f of flowState) {
      const s = sessions.get('demo:' + f.agentId + ':scheduled:' + f.id);
      if (s.run.status === 'running') {
        const ok = rnd() > 0.12;
        say(s.key, 'assistant', ok ? T.summary : T.error); finish(s, ok);
        f.lastStatus = ok ? 'succeeded' : 'failed'; f.lastAt = now();
        const list = runs.get(f.id);
        list.unshift({ id: f.id + ':' + tick, jobId: f.id, sessionKey: s.key, at: f.lastAt, action: 'finished', status: f.lastStatus, completionStatus: null,
          durationMs: s.run.runtimeMs, nextRunAt: f.lastAt + f.every * TICK_MS, model: { id: s.model.id, provider: PROVIDER },
          usage: { total: 1200, input: 900, output: 300 }, delivery: { status: ok ? 'delivered' : null, delivered: ok, channel: ok ? 'slack' : null },
          summary: ok ? T.summary : '', error: ok ? null : T.error });
        if (list.length > 25) list.pop();
      } else if (f.enabled && tick % f.every === 0) { say(s.key, 'user', f.message); start(s); }
    }
  }

  // ---- canonical projections ----
  function sessionList() {
    return [...sessions.values()].map((s) => ({
      key: s.key, sessionId: s.sessionId, class: Object.assign({}, s.cls), displayName: s.displayName,
      model: { id: s.model.id, provider: PROVIDER }, provider: PROVIDER, usage: { total: s.total, input: Math.floor(s.total * 0.7), output: s.total - Math.floor(s.total * 0.7) },
      updatedAt: s.updatedAt, run: Object.assign({}, s.run), costUsd: Math.round(s.total * 0.000004 * 10000) / 10000,
      parentKey: s.parentKey, childKeys: s.cls.kind === 'primary' && s.cls.agentId === 'nova' ? [...sessions.values()].filter((x) => x.parentKey === s.key).map((x) => x.key) : [],
      goal: s.goal ? { objective: s.goal, status: s.done ? 'done' : 'active', tokensUsed: s.total, tokenBudget: null } : null,
      cwd: null, messageCount: transcripts.get(s.key).length, interactive: s.interactive, group: null,
    }));
  }
  const agents = () => AGENTS.map((a) => ({ id: a.id, name: a.name, workspace: null, model: { primary: a.model, provider: PROVIDER }, modelSource: 'explicit', runtime: null, fallbackModels: [], isPrimary: a.primary,
    mainSessionKey: 'demo:' + a.id + ':primary' }));
  const flows = () => flowState.map((f) => ({ id: f.id, name: f.name, description: f.description, enabled: f.enabled, schedule: { kind: 'cron', expr: `*/${f.every} * * * *`, tz: null },
    agentId: f.agentId, sessionTarget: 'isolated', wakeMode: 'now',
    payload: { kind: 'agent-turn', message: f.message, timeoutSeconds: null, model: null, toolsAllow: null, lightContext: false },
    delivery: { mode: 'announce', channel: 'slack', to: null }, steps: [f.message], createdAt: t0 - 30 * 86400000, updatedAt: t0 - 86400000,
    nextRunAt: f.enabled ? now() + (f.every - (tick % f.every)) * TICK_MS : null, lastRunAt: f.lastAt, lastRunStatus: f.lastStatus, lastRunError: f.lastStatus === 'failed' ? T.error : null,
    lastDeliveryStatus: f.lastStatus === 'succeeded' ? 'delivered' : null, deleteAfterRun: false, sessionKey: 'demo:' + f.agentId + ':scheduled:' + f.id,
    health: f.lastStatus == null ? 'never-run' : f.lastStatus === 'failed' ? 'failing' : 'ok' }));
  const skills = () => T.skills.map(([name, description], i) => ({ name, emoji: null, description, source: i < 2 ? 'bundled' : 'workspace', rawSource: null, bundled: i < 2,
    status: 'active', visibility: { model: true, command: i === 3, user: true }, homepage: null, missing: null }));
  const skillInfo = (name) => ({ name, filePath: 'demo://skills/' + name, always: false, source: 'bundled', blockedBy: { allowlist: false, agentFilter: false, platform: false },
    requirements: null, missing: null, install: [], homepage: null });
  const channels = () => [['telegram', 'Telegram', 'connected'], ['slack', 'Slack', 'running'], ['webchat', 'Web chat', 'running'], ['email', 'E-mail', 'not-configured']]
    .map(([id, label, health]) => ({ id, rawId: id, label, configured: health !== 'not-configured', health, lastError: null, lastStartAt: health === 'not-configured' ? null : t0 - 86400000,
      lastInboundAt: null, accounts: [], policy: { dm: null, group: null } }));
  function transcript(key) {
    const list = transcripts.get(key); if (!list) return null;
    return { sessionKey: key, fetchedAt: now(), messageCount: list.length, window: { from: 0, to: list.length },
      events: list.map((e, i) => (e.kind === 'tool'
        ? { id: `ev:${i}:0`, kind: 'tool', at: e.at, callId: null, name: 'web_search', toolKind: 'search', input: '', output: e.text, isError: false, durationMs: 800, truncated: false }
        : Object.assign({ id: `ev:${i}:0`, kind: e.kind, at: e.at, text: e.text, truncated: false }, e.kind === 'assistant'
          ? { model: e.model, provider: e.provider, outputTokens: e.outputTokens, stopReason: e.stopReason, error: e.error } : { sender: e.sender }))) };
  }
  return { step, sessionList, agents, flows, runs: (id) => runs.get(id) || null, skills, skillInfo, channels, transcript, tick: () => tick,
    skillDoc: (filePath) => { const name = String(filePath || '').replace(/^demo:\/\/skills\//, ''); return { markdown: '# ' + name + '\n\n' + ((T.skills.find((x) => x[0] === name) || [])[1] || ''), frontmatter: {} }; } };
}

function createRuntime(cfg) {
  const team = createDemoTeam({ seed: Number.isInteger(cfg.demoSeed) ? cfg.demoSeed : 1, locale: cfg.instanceLocale || 'en' });
  let engine = null, timer = null;
  const feed = () => {
    if (!engine) return;
    engine.ingestCanonical('agents', team.agents());
    engine.ingestCanonical('sessions.snapshot', team.sessionList());
    engine.ingestCanonical('flows', team.flows());
  };
  const reads = {
    transcript: async (key) => { const t = team.transcript(key); if (!t) return { ok: false, category: 'not-found' }; engine.ingestCanonical('transcript', t, { key }); return { ok: true }; },
    flowRuns: async (id) => { const r = team.runs(id); if (!r) return { ok: false, category: 'not-found' }; engine.ingestCanonical('flowRuns', r, { key: id }); return { ok: true }; },
    skillInfo: async (name) => { engine.ingestCanonical('skillInfo', team.skillInfo(name), { key: name }); return { ok: true }; },
  };
  return {
    definition, gw: null, cli: null, reads, team,
    attach(e) { engine = e; engine.setReads(reads); },
    start(e, hooks = {}) {
      engine = e;
      engine.ingestCanonical('hello', { version: 'demo', protocol: null, events: [] });
      engine.ingestCanonical('config', { discord: null, execSecurity: 'allowlist', skillsEnabled: {} });
      engine.ingestCanonical('channels', team.channels());
      engine.ingestCanonical('skills', team.skills());
      feed();
      engine.setGatewayConnected(true);
      if (hooks.refreshed) hooks.refreshed();
      timer = setInterval(() => { team.step(); feed(); if (hooks.refreshed) hooks.refreshed(); }, TICK_MS);
      if (timer.unref) timer.unref();
    },
    // tests: advance n ticks synchronously
    tick(n = 1) { for (let i = 0; i < n; i++) team.step(); feed(); },
    close() { clearInterval(timer); },
    skillDoc: (filePath) => team.skillDoc(filePath),
    commands: {},                 // no runtime write (capabilities say so; the guard answers readonly first)
    refreshFlows: async () => feed(),
    refreshSkills: async () => { if (engine) engine.ingestCanonical('skills', team.skills()); },
  };
}

// G11: `agent-office doctor`: a synthesised team has no runtime to check
const doctor = async (ctx) => ctx.add('runtime', 'runtime.demo', 'info', 'runtime.demo');

const setup = { connect: true, capabilities: { brand: { mark: 'D', color: '#966d1f', foreground: '#ffffff' } },
  env: ({ runtime }) => runtime.demo ? { AO_DEMO_SEED: String(runtime.demo.seed) } : {},
  configSchema: setupSchema.object({ adapter: setupSchema.literal('demo'), demo: setupSchema.object({ seed: setupSchema.int().min(0).max(999999999) }, { extra: 'reject' }).optional() }, { extra: 'reject' }), name: 'Démo', fields: [], defaultGatewayUrl: null, config: () => ({ adapter: definition.id, demo: { seed: 1 } }),
  agents: () => AGENTS.map((a) => ({ id: a.id, name: a.name, nameSource: 'demo', isPrimary: a.primary, model: a.model })) };
setup.discover = async () => setup.agents();
setup.settings = { optional:true, fields: [], envKeys: {}, values: () => ({}), resolve: () => ({ adapter: 'demo' }),
  probe: async () => ({ status: 'connected', protocol: null, latencyMs: null, gw: null }), secret: () => null, detectedValues: () => ({}) };
module.exports = { definition, createRuntime, createDemoTeam, AGENTS, TICK_MS, doctor, setup };
