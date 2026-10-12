// Mock Journaux: LogRowVM pages and SessionVM transcripts (api.md 2.1 §3.6): invented French data plus the contract
// example's session (session-vm.json); every SessionVM is conformed to that example.
import { EXAMPLES, conform, exampleData } from './examples.js';
import { PROPOSED_AGENT } from './meta.js';
// One session is live: every tick it appends trace events, so the list and the open transcript update over SSE.
const TRACE_STATE = () => { const v = globalThis.location && new URLSearchParams(location.search).get('trace'); return v === 'stale' || v === 'unavailable' ? v : 'fresh'; };
/** LogRowVM.title / SessionVM.title (2.4, Q03-A01): a LabelRef the UI shows in its language; genuine names stay raw params. */
function titleOf(row, example) {
  if (example && example.title) return example.title;
  if (row.titleRef) return row.titleRef;
  const base = row.kind === 'main' ? { key: 'sessionTitle.main' } : row.kind === 'dashboard' ? { key: 'sessionTitle.dashboard' }
    : row.kind === 'cron' ? { key: 'sessionTitle.cronNamed', params: { name: row.label.replace(/^.*·\s*/, '') } }
    : row.kind === 'subagent' && row.label.startsWith('Sous-agent · ') ? { key: 'sessionTitle.subagent', params: { id: row.label.slice(13) } }
    : { key: 'sessionTitle.named', params: { name: row.label } };
  return row.heartbeat ? { key: 'sessionTitle.heartbeat', params: { title: base } } : base;
}
const MIN = 60_000, H = 60 * MIN, D = 24 * H;
const MODELS = ['gpt-5.5', 'claude-opus-5-5', 'gpt-5.5-mini', 'claude-sonnet-5-5'];
const PAGE = 50;

const PEOPLE = ['Guest Tremblay', 'Julie Gagnon', 'Sophie Côté', 'Owner'];
const TOPICS = [
  ['les soumissions de la semaine', 'Préparer un tableau des soumissions envoyées cette semaine, avec les montants.'],
  ['la refonte du portail', 'Vérifier pourquoi le test de bout en bout échoue en préproduction.'],
  ['la veille concurrentielle', 'Résumer les nouveautés des cinq concurrents suivis.'],
  ['les factures d’octobre', 'Générer les factures du mois et signaler les adresses manquantes.'],
  ['le menu de Chez Lucie', 'Mettre à jour la page du menu avec les plats de la semaine.'],
  ['les sauvegardes', 'Écrire le script de copie chiffrée vers le second disque.'],
];

// T-0058: two connectors with their adapter-declared marks; every row names its connector and agent.
const OPENCLAW = { id: 'legacy', adapter: 'openclaw', name: 'OpenClaw', mark: { monogram: 'OC', color: '#b23a0b', providerName: 'OpenClaw', logo: 'assets/connectors/openclaw.svg' } };
const CLAUDE = { id: 'claude-code', adapter: 'claude-code', name: 'Claude Code', mark: { monogram: 'CC', color: '#a34a2c', providerName: 'Claude Code', logo: 'assets/connectors/claude-code.svg' } };
const CODEX = { id: 'codex', adapter: 'codex', name: 'Codex', mark: { monogram: 'CX', color: '#187b67', providerName: 'Codex', logo: 'assets/connectors/codex.svg', logoDark: 'assets/connectors/codex-dark.svg' } };
const PRIMARY = { id: PROPOSED_AGENT.id, name: PROPOSED_AGENT.name };
function rowsSeed(now) {
  const rows = [];
  const add = (id, kind, channel, label, model, tokens, ago, extra = {}) => {
    const updatedAt = ago == null ? null : now - ago;
    rows.push({ id, kind, channel, label, model, modelProvider: model.startsWith('claude') ? 'anthropic' : 'openai', tokens, tokensKnown: true, updatedAt, live: false, heartbeat: false,
      execution: { status: 'unknown', evidence: { level: 'unknown', observedAt: updatedAt, expiresAt: null } }, connector: OPENCLAW, agent: PRIMARY, ...extra });
    const row = rows.at(-1);
    if (row.live && !extra.execution) row.execution = { status: 'running', evidence: { level: 'verified', observedAt: updatedAt, expiresAt: null } };
  };
  const coding = (slug, agent, label, ago, extra = {}) => add('rt:claude-code:session:' + slug, 'conversation', null, label, 'claude-opus-5-5', 0, ago,
    { tokensKnown: false, connector: CLAUDE, agent: { id: 'rt:claude-code:agent:' + agent, name: agent }, ...extra });
  coding('bureau-mobile', 'agent-office', 'Corriger le bureau mobile', 20_000, { live: true,
    execution: { status: 'unknown', evidence: { level: 'observed', observedAt: now - 20_000, expiresAt: now + 10_000 } } });
  coding('menu-semaine', 'portail-client', 'Ajouter le menu de la semaine', 35 * MIN);
  coding('sauvegardes', 'agent-office', 'Script de sauvegarde chiffrée', 6 * H);
  add('rt:codex:session:agent-office', 'conversation', null, 'Trier les résultats des tests', 'gpt-5.5', 0, 24 * MIN,
    { tokensKnown: false, connector: CODEX, agent: { id: 'rt:codex:agent:agent-office', name: 'Agent Office' } });
  add('agent:main:discord:channel:sans-nom', 'chat-group', 'discord', 'Groupe sans nom · Discord', MODELS[0], 4_210, 2 * H,
    { titleRef: { key: 'sessionTitle.groupUnnamed', params: { platform: { key: 'channel.discord' } } } });
  add('agent:main:main', 'main', null, 'Session principale de Timmy', MODELS[1], 412_380, 2 * MIN, { live: true });
  add('agent:main:main:heartbeat', 'main', null, 'Battement de la session principale', MODELS[2], 18_204, 9 * MIN, { heartbeat: true });
  add('agent:main:discord:direct:guest', 'chat-direct', 'discord', 'Guest Tremblay', MODELS[0], 58_930, 22 * MIN);
  add('agent:main:discord:channel:projets', 'chat-group', 'discord', '#projets', MODELS[0], 131_402, 48 * MIN);
  add('agent:main:subagent:scout-veille', 'subagent', null, 'Scout · veille concurrentielle', MODELS[2], 26_115, 55 * MIN);
  add('agent:main:cron:factures-mensuelles', 'cron', null, 'Factures mensuelles', MODELS[0], 9_870, 4 * D);
  add('agent:main:dashboard:7f2e', 'dashboard', null, 'Discussion du tableau de bord', MODELS[1], 7_402, 3 * H);
  add('agent:main:explicit:portal-chat', 'explicit', null, 'Discuter (portail)', MODELS[1], 64_008, 5 * H);
  add('agent:claude:acp:4b1d', 'acp', null, 'Agent de code · portail-client', MODELS[1], 245_110, 7 * H);
  add('agent:main:whatsapp:direct:julie', 'chat-direct', 'whatsapp', 'Julie Gagnon', MODELS[3], 3_512, 26 * H);
  add('agent:main:wechat:direct:sophie', 'chat-direct', 'wechat', 'Sophie Côté', MODELS[3], 1_208, 3 * D);
  add('agent:main:cron:audit-seo-nocturne', 'cron', null, 'Audit SEO nocturne', MODELS[2], 11_640, 30 * H);
  for (let i = 0; i < 58; i++) {
    const kinds = ['subagent', 'cron', 'chat-direct', 'dashboard', 'chat-group'];
    const kind = kinds[i % kinds.length];
    const [topic] = TOPICS[i % TOPICS.length];
    const label = kind === 'subagent' ? `Sous-agent · ${topic}` : kind === 'cron' ? `Tâche planifiée · ${topic}` : kind === 'chat-direct' ? PEOPLE[i % 3]
      : kind === 'chat-group' ? '#' + ['projets', 'clients', 'général'][i % 3] : `Tableau de bord · ${topic}`;
    add(`agent:main:${kind}:${(1000 + i).toString(36)}`, kind, kind.startsWith('chat') ? 'discord' : null, label, MODELS[i % MODELS.length],
      2_000 + ((i * 7919) % 90_000), (8 + i * 11) * H);
  }
  return rows;
}

let seq = 0;
const ev = (o) => ({ ...o });
// TraceEvent ids are stable: `ev:<messageIndex>:<partIndex>` (BRIEF, PM on frontend-03).
const identityOf = (e) => ({ kind: e.kind === 'user' ? 'human' : e.kind === 'system' ? 'system' : e.kind === 'tool' ? 'tool' : 'agent',
  id: e.kind === 'user' ? 'demo-user:' + (e.sender || 'unknown') : e.kind === 'tool' ? 'tool:' + e.name : e.kind === 'system' ? 'system:runtime' : 'agent:atlas',
  name: e.kind === 'user' ? e.sender || null : e.kind === 'tool' ? e.name : e.kind === 'system' ? null : 'Atlas', runtime: 'demo', channel: null, avatarHint: null });
const withIds = (events) => events.map((e, i) => ({ id: `ev:${i}:0`, ...e, senderInfo: e.senderInfo || identityOf(e) }));
const participantsOf = (events) => [...new Map(events.filter((e) => ['human', 'agent'].includes(e.senderInfo.kind)).map((e) => [e.senderInfo.id, e.senderInfo])).values()];

/** A plausible transcript for a row: user ask, thinking, tool calls (one failing), the answer. */
function transcriptFor(row, now) {
  const [, ask] = TOPICS[Math.abs([...row.id].reduce((h, c) => h * 31 + c.charCodeAt(0), 0)) % TOPICS.length];
  const t0 = (row.updatedAt ?? now) - 6 * MIN;
  // SessionVM user events carry `sender: string | null` (never undefined: JSON would drop the key).
  const sender = (row.kind === 'chat-direct' ? row.label : row.kind === 'chat-group' ? 'Guest Tremblay' : row.kind === 'cron' ? null : 'Owner') ?? null;
  const at = (s) => t0 + s * 1000;
  const events = [];
  if (row.kind === 'cron' || row.kind === 'subagent') events.push(ev({ kind: 'system', at: at(0), text: row.kind === 'cron' ? `Exécution planifiée : ${row.label}.` : 'Sous-agent lancé par Timmy avec un objectif délimité.', truncated: false }));
  events.push(ev({ kind: 'user', at: at(2), sender, text: ask, truncated: false }));
  events.push(ev({ kind: 'thinking', at: at(4), text: 'Je commence par retrouver les fichiers concernés, puis je vérifie les données avant de répondre.', truncated: false }));
  events.push(ev({ kind: 'assistant', at: at(6), model: row.model, provider: null, outputTokens: 182, text: 'Je regarde ça. Je cherche d’abord les informations à jour.', truncated: false, stopReason: 'toolUse', error: null }));
  events.push(ev({ kind: 'tool', at: at(7), callId: 'c' + ++seq, name: 'web_search', toolKind: 'search', input: '{"query":"' + ask.slice(0, 40) + '"}', output: '5 résultats, 2 pertinents.', isError: false, durationMs: 1_420, truncated: false }));
  events.push(ev({ kind: 'tool', at: at(10), callId: 'c' + ++seq, name: 'read_file', toolKind: 'file-read', input: '{"path":"projets/notes.md"}', output: '# Notes\n- point 1\n- point 2\n…', isError: false, durationMs: 85, truncated: true }));
  events.push(ev({ kind: 'tool', at: at(12), callId: 'c' + ++seq, name: 'exec', toolKind: 'exec', input: '{"cmd":"npm test"}', output: '1 test en échec : délai dépassé (30 s).', isError: true, durationMs: 31_200, truncated: false }));
  events.push(ev({ kind: 'observation', at: at(44), text: 'Le test échoue par délai ; ce n’est pas lié au changement récent.', truncated: false }));
  events.push(ev({ kind: 'tool', at: at(46), callId: 'c' + ++seq, name: 'memory_search', toolKind: 'memory', input: '{"q":"test instable"}', output: 'Note du 2 oct. : test connu comme instable.', isError: false, durationMs: 210, truncated: false }));
  events.push(ev({ kind: 'assistant', at: at(50), model: row.model, provider: null, outputTokens: 640,
    text: `Voici ce que j’ai trouvé :\n\n1. Les données sont à jour.\n2. Le test en échec est connu comme instable ; je l’ai relancé.\n\nJe vous envoie le résumé sur Discord.`, truncated: false, stopReason: 'toolUse', error: null }));
  events.push(ev({ kind: 'tool', at: at(55), callId: 'c' + ++seq, name: 'message', toolKind: 'message', input: '{"channel":"discord","to":"' + (sender || 'Owner') + '"}', output: 'Message envoyé.', isError: false, durationMs: 640, truncated: false }));
  events.push(ev({ kind: 'assistant', at: at(57), model: row.model, provider: null, outputTokens: 24, text: 'C’est fait.', truncated: false, stopReason: 'stop', error: null }));
  if (row.kind === 'chat-group') {
    const human = (name, id, text, seconds) => ev({ kind: 'user', at: at(seconds), sender: name, text, truncated: false, senderInfo: { kind: 'human', id: 'discord-user:' + id, name, runtime: 'demo', channel: 'discord', avatarHint: null } });
    events.splice(events[0]?.kind === 'system' ? 1 : 0, 1,
      human('Mira', '100000000000000001', 'Préparons la prochaine version du portail.', 0),
      human('Mira', '100000000000000001', 'Je propose de commencer par les tests de connexion.', 1),
      human('Jules', '100000000000000002', 'Je peux vérifier les parcours sur mobile.', 2),
      human('Noor', '100000000000000003', 'Je m’occupe du compte rendu et du suivi.', 3));
  }
  return events;
}

export function createLogs(now = Date.now(), { empty = false } = {}) {
  const rows = empty ? [] : rowsSeed(now);
  const transcripts = new Map();
  const cwds = new Map();
  if (!empty) {
    // The contract example's session, as is (its events keep their ids).
    const ex = exampleData(EXAMPLES.sessionVm);
    rows.push({ id: ex.key, kind: ex.kind, channel: null, label: ex.label, model: ex.model, modelProvider: ex.modelProvider, tokens: ex.tokens, tokensKnown: true,
      updatedAt: ex.updatedAt, live: false, heartbeat: false, execution: { status: ex.run.status, evidence: ex.run.evidence }, connector: OPENCLAW, agent: PRIMARY, example: ex });
    transcripts.set(ex.key, ex.events);
    cwds.set(ex.key, ex.cwd);
  }
  const transcript = (key) => {
    if (!transcripts.has(key)) {
      const row = rows.find((r) => r.id === key);
      if (!row) return null;
      transcripts.set(key, withIds(transcriptFor(row, now)));
    }
    return transcripts.get(key);
  };
  const order = () => rows.sort((a, b) => (b.updatedAt ?? -1) - (a.updatedAt ?? -1) || (a.id < b.id ? -1 : 1));
  order();
  return {
    /** Page<LogRowVM>: ?kind filters; cursor = opaque offset. Returns null for an invalid cursor. */
    page(kind, cursor, limit = PAGE, { heartbeats = false, connector = null, agent = null } = {}) {
      const visible = rows.filter((r) => (!kind || r.kind === kind) && (heartbeats || !r.heartbeat));
      const list = visible.filter((r) => (!connector || r.connector?.id === connector) && (!agent || r.agent?.id === agent));
      const connectors = new Map(), agents = new Map();
      for (const r of visible) {
        if (r.connector) connectors.set(r.connector.id, { ...r.connector, count: (connectors.get(r.connector.id)?.count || 0) + 1 });
        if (r.agent) agents.set(r.agent.id, { ...r.agent, connectorId: r.connector?.id || null, count: (agents.get(r.agent.id)?.count || 0) + 1 });
      }
      const byName = (x, y) => x.name.localeCompare(y.name) || x.id.localeCompare(y.id);
      let start = 0;
      if (cursor) { start = Number(atob(cursor)); if (!Number.isInteger(start) || start < 0) return null; }
      return { items: list.slice(start, start + limit).map(({ example, titleRef, ...r }) => ({ ...r, title: titleOf({ ...r, titleRef }, example) })), nextCursor: start + limit < list.length ? btoa(String(start + limit)) : null,
        facets: { connectors: [...connectors.values()].sort(byName), agents: [...agents.values()].sort(byName) } };
    },
    /** SessionVM, or null for an unknown key. */
    session(key) {
      const row = rows.find((r) => r.id === key);
      if (!row) return null;
      const events = transcript(key);
      if (row.example) return conform(EXAMPLES.sessionVm.data, { ...row.example, title: titleOf(row, row.example), traceState: TRACE_STATE(), participants: participantsOf(events), events: events.map((e) => ({ ...e })) });
      const running = row.live;
      const failed = !running && events.some((e) => e.kind === 'assistant' && e.stopReason === 'error');
      return conform(EXAMPLES.sessionVm.data, {
        key, label: row.label, title: titleOf(row), kind: row.kind, model: row.model, modelProvider: row.modelProvider, tokens: row.tokens, updatedAt: row.updatedAt,
        run: { status: running ? 'running' : failed ? 'failed' : row.kind === 'cron' ? 'succeeded' : 'unknown', endReason: failed ? 'error' : null,
          evidence: { level: running || failed || row.kind === 'cron' ? 'verified' : 'unknown', observedAt: row.updatedAt, expiresAt: null } },
        messageCount: events.filter((e) => e.kind !== 'tool').length + 40 * (row.kind === 'main'), window: { from: Math.max(0, events.length - 120), to: events.length },
        toolCount: events.filter((e) => e.kind === 'tool').length, participants: participantsOf(events), subagents: [], events: events.map((e) => ({ ...e })),
        // 2.4 (R16-07): ?trace=stale|unavailable previews the transcript read failing or unsupported.
        traceState: TRACE_STATE(),
        cwd: cwds.get(key) ?? (row.kind === 'acp' ? 'dev/project/portail-client' : null),
      });
    },
    /** The live main session does one more step; returns the touched key. */
    tick(t = Date.now()) {
      const row = rows.find((r) => r.live && r.kind === 'main') || rows.find((r) => r.live);   // newer live rows may sort first
      if (!row) return null;
      const events = transcript(row.id);
      const n = events.length;
      const step = n % 3;
      const id = `ev:${(this.n = (this.n || 1000) + 1)}:0`;
      if (step === 0) events.push({ id, kind: 'thinking', at: t, text: 'Je vérifie l’étape suivante avant de continuer.', truncated: false });
      else if (step === 1) events.push({ id, kind: 'tool', at: t, callId: 'c' + ++seq, name: 'web_fetch', toolKind: 'web', input: '{"url":"https://exemple.ca/page"}', output: 'Page récupérée (12 Ko).', isError: false, durationMs: 900 + (n % 5) * 200, truncated: false });
      else events.push({ id, kind: 'assistant', at: t, model: row.model, provider: null, outputTokens: 90, text: `Étape ${Math.floor(n / 3)} terminée ; je poursuis.`, truncated: false, stopReason: 'toolUse', error: null });
      events.at(-1).senderInfo = identityOf(events.at(-1));
      if (events.length > 120) events.splice(0, events.length - 120);
      row.tokens += 350; row.updatedAt = t; row.execution = { status: 'running', evidence: { level: 'verified', observedAt: t, expiresAt: null } };
      order();
      return row.id;
    },
  };
}
