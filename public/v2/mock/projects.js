// Mock Projets backend: invented French data plus the contract examples' entities (docs/architecture/examples/),
// the BoardVM / ProjectVM / Page<HistoryItemVM> builders — every output goes through conform() against the 2.1
// examples — and the project commands of api.md §5.4.
import { assetUrl } from '../config.js';
import { getLang } from '../i18n.js';
import { EXAMPLES, conform, exampleData } from './examples.js';
const MIN = 60_000, H = 60 * MIN, D = 24 * H;
const STATUSES = ['idea', 'todo', 'in-progress', 'in-review', 'shipped'];
const PRIORITY_RANK = { P0: 0, P1: 1, P2: 2, P3: 3, P4: 4, P5: 5, P6: 6, P7: 7, P8: 8, P9: 9 };   // architect-55
const RISK_LABELS = { blocked: 'Bloqué', 'flow-failing': 'Flow en échec', 'cron-failing': 'Cron en échec', 'ci-red': 'CI rouge' };
const RISK_SEVERITY = { blocked: 'high', 'flow-failing': 'high', 'cron-failing': 'high', 'ci-red': 'medium', stale: 'low' };
const TINTS = ['label-slate', 'label-indigo', 'label-teal', 'label-amber', 'label-rose', 'label-green'];
const CARD_FLAG_CAP = 3, CARD_PEOPLE_CAP = 4, HISTORY_PAGE = 20;

const RISK_LABELS_EN = { blocked: 'Blocked', 'flow-failing': 'Flow failing', 'cron-failing': 'Cron failing', 'ci-red': 'CI red' };
// Server-rendered flag labels follow the request's language (G3c: Accept-Language), so the mock follows the UI's.
const riskLabel = (key, staleDays) => (getLang() === 'en'
  ? (key === 'stale' ? (staleDays ? `Inactive for ${staleDays} d` : 'Inactive') : RISK_LABELS_EN[key] || key)
  : (key === 'stale' ? (staleDays ? `Inactif depuis ${staleDays} j` : 'Inactif') : RISK_LABELS[key] || key));
const Owner = { kind: 'human', personId: 'per_alex' };
const TIMMY = { kind: 'agent', personId: 'per_timmy' };
const SCOUT = { kind: 'agent', personId: 'per_scout' };
const SYSTEM = { kind: 'system', component: 'risk-monitor' };

export const PERSONS = new Map([
  ['per_alex', { id: 'per_alex', kind: 'human', name: 'Owner', avatarUrl: null, links: { isOwner: true } }],
  ['per_timmy', { id: 'per_timmy', kind: 'agent', name: 'Timmy', avatarUrl: assetUrl('bureau/assets/Characters/timmy/portrait.png'), links: { agentId: 'main' } }],
  ['per_scout', { id: 'per_scout', kind: 'agent', name: 'Scout', avatarUrl: null, links: { agentId: 'main', subagentId: 'scout' } }],
  ['per_marc', { id: 'per_marc', kind: 'human', name: 'Guest Tremblay', avatarUrl: null, links: {} }],
  ['per_julie', { id: 'per_julie', kind: 'human', name: 'Julie Gagnon', avatarUrl: null, links: {} }],
  ['per_rose', { id: 'per_rose', kind: 'git', name: 'Rosalie Ouellet', avatarUrl: null, links: {} }],
  ['per_kev', { id: 'per_kev', kind: 'git', name: 'Kevin Pelletier', avatarUrl: null, links: {} }],
]);
// People of the contract example (project-vm.json).
for (const p of exampleData(EXAMPLES.projectVm).people) PERSONS.set(p.id, { id: p.id, kind: p.kind, name: p.name, avatarUrl: p.avatarUrl, links: {} });
const LIVE = { per_timmy: 'working', per_scout: 'researching', per_0a1b2c3d4e5f6g7h: 'working' };

let seq = 100;
const nextId = (p) => `${p}_${(++seq).toString(36)}`;

/** Invented projects, built relative to `now` so relative times stay plausible. */
export function seed(now = Date.now()) {
  const ago = (ms) => now - ms;
  const commits = (owner, repo, list) => list.map(([sha, msg, who, t]) => ({ sha, at: ago(t), author: { name: PERSONS.get(who)?.name || who, personId: who.startsWith('per_') ? who : null }, message: msg }));
  const repo = (owner, name, ci, list, branch = 'main') => ({
    url: `https://github.com/${owner}/${name}`, owner, name, defaultBranch: branch,
    image: { kind: 'generated', url: null }, ci: { state: ci, at: ago(40 * MIN), url: null },
    commits: commits(owner, name, list), fetchedAt: ago(4 * MIN),
  });
  const label = (l, by = Owner, at = ago(10 * D)) => ({ kind: 'label', key: l.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-'), label: l, addedBy: by, addedAt: at });
  const risk = (key, at, extra = {}) => ({ kind: 'risk', key, severity: RISK_SEVERITY[key], origin: key === 'blocked' ? 'manual' : 'auto', evidence: null, raisedAt: at, clearedAt: null, ack: null, ...extra });
  const feature = (key, state) => ({ kind: 'feature', key, state, foundIn: { path: 'config/flags.json', line: null }, scannedAt: ago(2 * H) });
  const person = (personId, role = null, origin = 'derived', commitCount = null) => ({ personId, role, origin, liveState: null, commitCount });
  const src = (kind, ref, at) => ({ id: nextId('src'), kind, ref, addedAt: at, addedBy: Owner });

  const P = [
    {
      id: 'prj_portail', name: 'Refonte du portail client', status: 'in-progress', priority: 'P1',
      summary: 'Nouvelle version du portail où les clients suivent leurs commandes et téléchargent leurs factures.\n\nLe parcours de connexion est terminé ; Timmy prépare la page de suivi. Le déploiement en préproduction échoue depuis hier soir à cause d’un test de bout en bout instable.',
      summaryMeta: { author: TIMMY, at: ago(3 * H) },
      sources: [src('github', { owner: 'atelier-demo', repo: 'portail-client' }, ago(30 * D)), { ...src('sessionGroup', { by: 'group', groupId: 'Portail client', name: 'Portail client' }, ago(20 * D)), sessionCount: 3 }],
      repo: repo('atelier-demo', 'portail-client', 'failing', [
        ['a41f9c2', 'Page de suivi : liste des commandes', 'per_timmy', 25 * MIN], ['77be013', 'Corrige le délai du test de connexion', 'per_rose', 5 * H],
        ['0c9d4e1', 'Ajoute le téléchargement des factures PDF', 'per_rose', 26 * H], ['e2a8f70', 'Met à jour les dépendances', 'per_kev', 3 * D], ['91d3b5a', 'Parcours de connexion terminé', 'per_timmy', 4 * D],
      ]),
      flags: [label('client'), label('site web'), risk('ci-red', ago(14 * H), { evidence: { kind: 'ci', ref: 'run-482', at: ago(14 * H) } }), feature('portail.suivi-v2', 'on')],
      people: [person('per_alex', 'Responsable', 'manual'), person('per_marc', 'Client'), person('per_timmy', 'Développement'), person('per_scout', 'Recherche'), person('per_rose', null, 'derived', 14), person('per_kev', null, 'derived', 3)],
      lastActivityAt: ago(25 * MIN), createdAt: ago(32 * D),
    },
    {
      id: 'prj_factures', name: 'Automatisation des factures', status: 'in-review', priority: 'P0',
      summary: 'Timmy génère les factures mensuelles à partir des feuilles de temps et les envoie après validation. Le flux du 1er octobre a échoué sur deux clients sans adresse de facturation.',
      summaryMeta: { author: Owner, at: ago(2 * D) },
      sources: [src('workspace', { path: 'projets/factures' }, ago(40 * D)), src('github', { owner: 'atelier-demo', repo: 'factures' }, ago(40 * D))],
      repo: repo('atelier-demo', 'factures', 'passing', [['5be0a13', 'Valide l’adresse avant l’envoi', 'per_timmy', 3 * H], ['c17f2d8', 'Gabarit PDF bilingue', 'per_timmy', 2 * D]]),
      flags: [risk('flow-failing', ago(4 * D), { evidence: { kind: 'cron-run', ref: 'run-77', at: ago(4 * D) } }), label('client'), label('finances'), feature('factures.pdf-v2', 'on'), feature('factures.relances', 'off')],
      people: [person('per_alex', 'Validation', 'manual'), person('per_timmy', 'Exécution'), person('per_julie', 'Comptabilité')],
      lastActivityAt: ago(3 * H), createdAt: ago(41 * D),
    },
    {
      id: 'prj_lucie', name: 'Site du restaurant Chez Lucie', status: 'todo', priority: 'P2',
      summary: 'Site vitrine avec le menu de la semaine et la réservation en ligne. En attente des photos de la cliente.',
      summaryMeta: { author: Owner, at: ago(6 * D) },
      sources: [src('github', { owner: 'atelier-demo', repo: 'chez-lucie' }, ago(9 * D))],
      repo: repo('atelier-demo', 'chez-lucie', 'none', [['3fa91bc', 'Squelette du site', 'per_kev', 8 * D]]),
      flags: [label('client'), label('site web')],
      people: [person('per_alex', 'Responsable', 'manual'), person('per_marc', 'Client'), person('per_kev', null, 'derived', 1)],
      lastActivityAt: ago(6 * D), createdAt: ago(9 * D),
    },
    {
      id: 'prj_depenses', name: 'Tableau des dépenses', status: 'idea', priority: 'P7',
      summary: '', summaryMeta: null,
      sources: [src('manual', null, ago(40 * D))], repo: null,
      flags: [label('perso'), risk('stale', ago(7 * D), { staleDays: 21, evidence: { kind: 'inactivity', ref: '21', at: ago(7 * D) } })],
      people: [person('per_alex', null, 'manual')],
      lastActivityAt: ago(21 * D), createdAt: ago(40 * D),
    },
    {
      id: 'prj_veille', name: 'Veille concurrentielle hebdomadaire', status: 'in-progress', priority: 'P2',
      summary: 'Chaque lundi, Scout parcourt les sites de cinq concurrents et Timmy rédige une synthèse de deux pages.',
      summaryMeta: { author: TIMMY, at: ago(26 * H) },
      sources: [src('sessionGroup', { by: 'keys', sessionKeys: ['veille-1', 'veille-2'] }, ago(15 * D))], repo: null,
      flags: [label('recherche')],
      people: [person('per_timmy', 'Synthèse'), person('per_scout', 'Recherche'), person('per_alex', 'Lecture', 'manual')],
      lastActivityAt: ago(50 * MIN), createdAt: ago(15 * D),
    },
    {
      id: 'prj_ventes', name: 'Rapport mensuel des ventes', status: 'shipped', priority: 'P2',
      summary: 'Rapport généré le premier jour ouvrable du mois et envoyé sur Discord.', summaryMeta: { author: TIMMY, at: ago(5 * D) },
      sources: [src('workspace', { path: 'rapports/ventes' }, ago(60 * D))], repo: null,
      flags: [label('finances')], people: [person('per_timmy', 'Rédaction'), person('per_julie', 'Lecture')],
      lastActivityAt: ago(4 * D), createdAt: ago(60 * D),
    },
    {
      id: 'prj_sauvegardes', name: 'Sauvegardes du serveur', status: 'todo', priority: 'P1',
      summary: 'Copie chiffrée quotidienne vers un second disque, puis hebdomadaire hors site. Bloqué : le disque externe n’est pas encore livré.',
      summaryMeta: { author: Owner, at: ago(3 * D) }, sources: [src('manual', null, ago(12 * D))], repo: null,
      flags: [risk('blocked', ago(3 * D), { evidence: { kind: 'manual', ref: 'Owner', at: ago(3 * D) } }), label('perso'), label('infra')],
      people: [person('per_alex', 'Responsable', 'manual'), person('per_timmy', 'Scripts')],
      lastActivityAt: ago(3 * D), createdAt: ago(12 * D),
    },
    {
      id: 'prj_reservation', name: 'Application de réservation', status: 'idea', priority: 'P4',
      summary: '', summaryMeta: null, sources: [src('manual', null, ago(5 * D))], repo: null,
      flags: [label('client')], people: [person('per_alex', null, 'manual'), person('per_marc', 'Client')],
      lastActivityAt: ago(5 * D), createdAt: ago(5 * D),
    },
    {
      id: 'prj_accueil', name: 'Guide d’accueil des employés', status: 'shipped', priority: 'P9',
      summary: 'Guide de 12 pages rédigé avec Timmy à partir des notes d’équipe.', summaryMeta: { author: Owner, at: ago(18 * D) },
      sources: [src('workspace', { path: 'docs/accueil' }, ago(30 * D))], repo: null,
      flags: [label('interne')], people: [person('per_alex', null, 'manual'), person('per_timmy', 'Rédaction')],
      lastActivityAt: ago(18 * D), createdAt: ago(30 * D),
    },
    {
      id: 'prj_seo', name: 'Audit SEO du site vitrine', status: 'in-review', priority: 'P1',
      summary: 'Scout vérifie chaque nuit les balises et les liens morts. La tâche planifiée a échoué deux nuits de suite ; Owner en a pris connaissance.',
      summaryMeta: { author: TIMMY, at: ago(9 * H) },
      sources: [src('github', { owner: 'atelier-demo', repo: 'site-vitrine' }, ago(20 * D))],
      repo: repo('atelier-demo', 'site-vitrine', 'running', [['b8e21f4', 'Corrige 14 liens morts', 'per_timmy', 9 * H], ['d02c7aa', 'Ajoute les balises Open Graph', 'per_rose', 2 * D]]),
      flags: [risk('cron-failing', ago(30 * H), { ack: { by: Owner, at: ago(20 * H) }, evidence: { kind: 'cron-run', ref: 'run-311', at: ago(30 * H) } }), label('site web'), feature('seo.rapport-nocturne', 'unknown')],
      people: [person('per_scout', 'Analyse'), person('per_timmy', 'Correctifs'), person('per_alex', null, 'manual'), person('per_rose', null, 'derived', 6)],
      lastActivityAt: ago(9 * H), createdAt: ago(20 * D),
    },
    {
      id: 'prj_infolettre', name: 'Infolettre de l’automne', status: 'todo', priority: 'P5',
      summary: 'Brouillon à préparer avec les nouveautés du trimestre.', summaryMeta: { author: Owner, at: ago(2 * D) },
      sources: [src('manual', null, ago(2 * D))], repo: null,
      flags: [label('client'), label('communication')], people: [person('per_alex', null, 'manual'), person('per_julie', 'Relecture')],
      lastActivityAt: ago(2 * D), createdAt: ago(2 * D),
    },
  ];
  // Test hook (?mock=…&image-hostile=1): a schema-valid but hostile screenshot URL (review-07 R7-04).
  if (globalThis.location && new URLSearchParams(location.search).has('image-hostile')) {
    const lucie = P.find((x) => x.id === 'prj_lucie');
    lucie.repo.image = { kind: 'screenshot', url: "https://example.invalid/x');position:fixed;inset:0;z-index:999999;background:red;--x:url('x" };
  }
  P.push(fromExampleVM(exampleData(EXAMPLES.projectVm)));
  const projects = new Map();
  const history = new Map();
  for (const p of P) {
    if (p.fromExample) { projects.set(p.id, p); history.set(p.id, p.fromExample); delete p.fromExample; continue; }
    p.revision = 3; p.archivedAt = null;
    p.flags.unshift({ kind: 'priority', key: p.priority });
    projects.set(p.id, p);
    history.set(p.id, seedHistory(p, now));
  }
  return { projects, history };
}

/** The example ProjectVM, turned back into the mock's internal project + history (so commands work on it too). */
function fromExampleVM(vm) {
  const actorOf = (chip) => (chip.kind === 'system' ? SYSTEM : { kind: chip.kind === 'agent' ? 'agent' : 'human', personId: chip.id });
  const flags = vm.flags.map((f) => (f.kind === 'risk' ? { kind: 'risk', key: f.key, severity: f.severity, origin: f.removable ? 'manual' : 'auto', evidence: null, raisedAt: vm.lastActivityAt - 4 * H, clearedAt: null, ack: f.acked ? { by: Owner, at: vm.lastActivityAt } : null }
    : f.kind === 'feature' ? { kind: 'feature', key: f.key, state: f.state, foundIn: { path: 'config/flags.json', line: null }, scannedAt: vm.lastActivityAt }
    : f.kind === 'label' ? { kind: 'label', key: f.key, label: f.label, addedBy: Owner, addedAt: vm.createdAt } : { kind: 'priority', key: f.key }));
  const kindPayload = (h) => {
    const p = (h.text && h.text.params) || {};
    switch (h.kind) {
      case 'status': return { from: p.from.key.split('.')[1], to: p.to.key.split('.')[1] };
      case 'commit': return { branch: p.branch, shas: ['ex' + Math.random().toString(16).slice(2, 9)] };
      case 'risk-raised': return { key: p.risk.key.split('.')[1], severity: 'medium' };
      case 'flow-run': return { jobId: p.job, runId: 'ex', status: h.text.key.endsWith('succeeded') ? 'succeeded' : 'failed', durationMs: 128_000 };
      default: return {};
    }
  };
  // One internal event per grouped item (a group of n commits becomes one event with n shas).
  // `group` counts merged events: a group of n commits becomes n internal commit events.
  const events = vm.recentHistory.flatMap((h) => Array.from({ length: h.group || 1 }, (_, i) =>
    ({ id: i ? `${h.id}_${i}` : h.id, projectId: vm.id, at: h.at - i, actor: actorOf(h.actor), dedupeKey: null, kind: h.kind, ...kindPayload(h) })));
  return {
    id: vm.id, name: vm.name, status: vm.status, priority: vm.priority, summary: vm.summary,
    summaryMeta: vm.summaryMeta ? { author: actorOf(vm.summaryMeta.author), at: vm.summaryMeta.at } : null,
    sources: vm.sources.map((s) => ({ id: s.id, kind: s.kind, label: s.label, ref: s.ref, addedAt: s.addedAt, addedBy: Owner, sessionCount: s.sessionCount })),
    repo: vm.repo ? { url: vm.repo.url, owner: vm.repo.owner, name: vm.repo.name, defaultBranch: vm.repo.defaultBranch, image: { kind: vm.thumb.kind, url: vm.thumb.url },
      ci: vm.repo.ci, commits: vm.repo.commits.map((c) => ({ sha: c.sha, at: c.at, author: { name: c.author, personId: null }, message: c.message })), fetchedAt: vm.repo.fetchedAt } : null,
    flags, people: vm.people.map((pp) => ({ personId: pp.id, role: pp.role, origin: pp.origin, liveState: null, commitCount: pp.commitCount })),
    lastActivityAt: vm.lastActivityAt, createdAt: vm.createdAt, revision: vm.revision, archivedAt: null, fromExample: events,
  };
}

function seedHistory(p, now) {
  const ev = [];
  const add = (at, actor, kind, extra = {}) => ev.push({ id: nextId('evt'), projectId: p.id, at, actor, dedupeKey: null, kind, ...extra });
  add(p.createdAt, Owner, 'project-created');
  const path = STATUSES.slice(0, STATUSES.indexOf(p.status) + 1);
  const span = Math.max(1, p.lastActivityAt - p.createdAt);
  path.slice(1).forEach((to, i) => add(p.createdAt + ((i + 1) / path.length) * span * 0.8, i % 2 ? TIMMY : Owner, 'status', { from: path[i], to }));
  for (const f of p.flags) {
    if (f.kind === 'label') add(Math.min(f.addedAt, p.createdAt + span * 0.1), Owner, 'flag-added', { flagKind: 'label', key: f.key, label: f.label });
    if (f.kind === 'risk') {
      add(f.raisedAt, f.origin === 'manual' ? Owner : SYSTEM, f.origin === 'manual' ? 'flag-added' : 'risk-raised', f.origin === 'manual' ? { flagKind: 'risk', key: f.key, label: riskLabel(f.key) } : { key: f.key, severity: f.severity });
      if (f.ack) add(f.ack.at, f.ack.by, 'risk-acked', { key: f.key });
    }
  }
  if (p.repo) {
    const byAuthor = p.repo.commits;
    for (const c of byAuthor) add(c.at, c.author.personId && PERSONS.get(c.author.personId).kind === 'agent' ? { kind: 'agent', personId: c.author.personId } : { kind: 'human', personId: c.author.personId || 'per_rose' }, 'commit', { branch: p.repo.defaultBranch, shas: [c.sha] });
  }
  if (p.id === 'prj_factures') {
    add(now - 4 * D, TIMMY, 'flow-run', { jobId: 'factures-mensuelles', runId: 'r1', status: 'failed', durationMs: 45_000 });
    add(now - 34 * D, TIMMY, 'flow-run', { jobId: 'factures-mensuelles', runId: 'r0', status: 'succeeded', durationMs: 128_000 });
  }
  if (p.id === 'prj_seo') {
    for (const [i, t] of [[1, 30 * H], [2, 54 * H]]) add(now - t, SCOUT, 'cron-run', { jobId: 'audit-seo-nocturne', runId: 'c' + i, status: 'failed', durationMs: 45_000 });
  }
  if (p.id === 'prj_veille' || p.id === 'prj_portail') {
    add(p.lastActivityAt, TIMMY, 'session', { sessionKey: p.id === 'prj_veille' ? 'agent:main:subagent:ffffffff-0001-4000-8000-000000000001' : 'agent:main:discord:direct:guest', messages: 14, tokens: 22_104 });
    add(p.lastActivityAt - 2 * H, TIMMY, 'agent-action', { action: 'delegated', subjectPersonId: 'per_scout', note: '' });
  }
  if (p.summaryMeta) add(p.summaryMeta.at, p.summaryMeta.author, 'summary-edited');
  return ev.sort((a, b) => b.at - a.at);
}

// ---- view models: api.md 2.0 §3.9 shapes (mirroring the projects module's builders) ----
const JOBS = { 'factures-mensuelles': 'Factures mensuelles', 'audit-seo-nocturne': 'Audit SEO nocturne' };
const ORDER = { human: 0, agent: 1, git: 2 };

function chipOf(personId) {
  const per = PERSONS.get(personId);
  if (!per) return null;
  return { id: per.id, kind: per.kind, name: per.name, avatarUrl: per.avatarUrl, state: per.kind === 'agent' ? LIVE[per.id] ?? null : null };
}
const actorVm = (a) => (!a || a.kind === 'system' ? { kind: 'system', name: 'Système' } : chipOf(a.personId) || { kind: 'system', name: 'Quelqu’un' });

/** HistoryItemVM.text as a LabelRef: key in the historyKind namespace; params are raw data (LabelRefs, numbers, ISO durations). */
const iso = (ms) => { const t = Math.round(ms / 1000); return `PT${Math.floor(t / 60) ? Math.floor(t / 60) + 'M' : ''}${t % 60}S`; };
const riskRef = (key, staleDays) => (key === 'stale' ? { key: 'risk.stale', params: { n: staleDays ?? 14 } } : { key: 'risk.' + key });
function historyText(group) {
  const e = group[0], n = group.length;
  // Params carry raw data only; the actor is HistoryItemVM.actor (the client fills `{actor}` from it).
  const k = (key, params = {}) => (Object.keys(params).length ? { key: 'historyKind.' + key, params } : { key: 'historyKind.' + key });
  switch (e.kind) {
    case 'status': return k('status', { from: { key: 'projectStatus.' + e.from }, to: { key: 'projectStatus.' + e.to } });
    case 'renamed': case 'priority': return k(e.kind, { from: e.from, to: e.to });
    case 'commit': return k(n > 1 ? 'commit.other' : 'commit.one', { n, branch: e.branch });
    case 'flow-run': case 'cron-run': {
      const ok = e.status === 'succeeded';
      if (n > 1) return k(`${e.kind}.group.${ok ? 'succeeded' : 'failed'}`, { n });
      return k(`${e.kind}.${ok ? 'succeeded' : 'failed'}`, { job: JOBS[e.jobId] || e.jobId, duration: e.durationMs == null ? '—' : iso(e.durationMs) });
    }
    case 'session': return k(Number.isInteger(e.messages) ? 'session' : 'session.noCount', { session: sessionOf(e).label, ...(Number.isInteger(e.messages) ? { messages: e.messages } : {}), tokens: e.tokens || 0 });
    case 'risk-raised': case 'risk-cleared': case 'risk-acked': case 'risk-unacked': return k(e.kind, { risk: riskRef(e.key) });
    case 'flag-added': return e.flagKind === 'risk' ? k('flag-added.risk', { risk: riskRef(e.key) }) : k('flag-added.label', { label: e.label });
    case 'flag-removed': return e.flagKind === 'risk' ? k('flag-removed.risk', { risk: riskRef(e.key) }) : k('flag-removed.label', { label: e.key });
    case 'source-linked': case 'source-unlinked': return k(e.kind, { ref: e.ref });
    case 'agent-action': return k('agent-action.' + e.action, { subject: e.subjectPersonId ? actorVm({ kind: 'agent', personId: e.subjectPersonId }).name : '—' });
    default: return k(e.kind);
  }
}
function sessionOf(e) {
  const subagent = e.sessionKey.includes(':subagent:');
  const name = PERSONS.get(subagent ? 'per_scout' : 'per_timmy').name;
  return { key: e.sessionKey, people: [actorVm({ kind: 'agent', personId: subagent ? 'per_scout' : 'per_timmy' }), ...(!subagent ? [actorVm({ kind: 'human', personId: 'per_marc' })] : [])], channel: subagent ? null : 'Discord', label: { key: subagent ? 'historySession.subagent' : 'historySession.conversation', params: subagent ? { agent: name } : { agent: name, channel: 'Discord', who: PERSONS.get('per_marc').name } },
    summary: getLang() === 'en' ? 'Prepared the follow-up plan · 5 steps · files: plan.md' : 'A préparé le plan de suivi · 5 étapes · fichiers : plan.md',
    messages: Number.isInteger(e.messages) ? e.messages : null, tokens: e.tokens || 0, route: '/journaux/' + encodeURIComponent(e.sessionKey) };
}
const sameActor = (a, b) => JSON.stringify(a.actor) === JSON.stringify(b.actor);
const canGroup = (a, b) => (a.kind === 'commit' && b.kind === 'commit' ? a.branch === b.branch && sameActor(a, b)
  : (a.kind === 'flow-run' || a.kind === 'cron-run') && a.kind === b.kind ? a.jobId === b.jobId && a.status === b.status : false);
function presentHistory(events) {
  const groups = [];
  for (const e of events) { const prev = groups.at(-1); if (prev && canGroup(prev[0], e)) prev.push(e); else groups.push([e]); }
  return groups.map((g) => ({ id: g[0].id, at: g[0].at, kind: g[0].kind, actor: actorVm(g[0].actor), text: historyText(g), group: g.length, ...(g[0].kind === 'session' ? { session: sessionOf(g[0]) } : {}) }));
}

const compareCards = (a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || b.lastActivityAt - a.lastActivityAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
function initials(name) {
  const parts = String(name).trim().split(/\s+/).filter(Boolean);
  return (parts.length >= 2 ? parts.slice(0, 2).map((w) => [...w][0]) : [...(parts[0] || '?')].slice(0, 2)).join('').toLocaleUpperCase('fr-CA');
}
function tintOf(id) { let h = 0; for (const ch of id) h = (h + ch.charCodeAt(0)) >>> 0; return TINTS[h % TINTS.length]; }
/** ProjectImage (api.md 2.3): screenshot → opengraph → monogram; `accent` hashed from the project id. */
function imageOf(p) {
  const img = p.repo && p.repo.image;
  const usable = img && img.url && (img.kind === 'opengraph' || img.kind === 'screenshot');
  return { kind: usable ? img.kind : 'monogram', url: usable ? img.url : null, initials: initials(p.name), accent: tintOf(p.id).replace(/^label-/, '') };
}
/** ThumbVM = ProjectImage + repoLabel. */
function thumbOf(p) {
  const { kind, url, initials: ini, accent } = imageOf(p);
  return { kind, url, repoLabel: p.repo ? `${p.repo.owner}/${p.repo.name}` : null, initials: ini, accent };
}
/** FlagVM, discriminated by kind (§3.9, §3.12). */
function flagVm(f) {
  switch (f.kind) {
    case 'priority': return { kind: 'priority', key: f.key, label: f.key };
    case 'risk': return { kind: 'risk', key: f.key, label: riskLabel(f.key, f.staleDays), severity: f.severity, acked: f.ack != null, removable: f.key === 'blocked' && f.origin === 'manual' };
    case 'feature': return { kind: 'feature', key: f.key, label: f.key, state: f.state };
    default: return { kind: 'label', key: f.key, label: f.label, removable: true };
  }
}
function cardFlags(flags) {
  const risks = flags.filter((f) => f.kind === 'risk' && f.clearedAt == null && f.ack == null);
  const rest = flags.filter((f) => f.kind !== 'risk');
  const shown = rest.slice(0, CARD_FLAG_CAP);
  return { visible: risks.concat(shown).map(flagVm), hiddenCount: rest.length - shown.length };
}
function people(p) {
  return p.people.map((pp) => { const c = chipOf(pp.personId); return c && { ...c, role: pp.role, origin: pp.origin, commitCount: pp.commitCount }; })
    .filter(Boolean).sort((a, b) => ORDER[a.kind] - ORDER[b.kind] || (a.id === 'per_timmy' ? -1 : b.id === 'per_timmy' ? 1 : 0));
}
function sourceLabel(s) {
  if (s.kind === 'github') return `${s.ref.owner}/${s.ref.repo}`;
  if (s.kind === 'workspace') return s.ref.path;
  if (s.label) return s.label;   // example-backed sources carry the server's label
  if (s.kind === 'sessionGroup') return s.ref.by === 'group' ? s.ref.name : s.ref.by === 'keys' ? `${s.ref.sessionKeys.length} sessions` : s.ref.interlocutorId;
  return 'manuel';
}
function repoVm(r, p) {
  if (!r) return null;
  const fetched = r.defaultBranch != null;
  return { state: fetched ? 'ok' : 'pending', url: r.url, owner: r.owner, name: r.name, image: imageOf(p), defaultBranch: r.defaultBranch, branch: r.defaultBranch,
    ci: fetched ? r.ci : null, commits: r.commits.map((c) => ({ sha: c.sha, at: c.at, author: c.author.name, message: c.message })),
    fetchedAt: fetched ? r.fetchedAt : null, lastError: null };
}

export function buildBoardVM(db, filter = 'all') {
  const sel = [...db.projects.values()].filter((p) => p.archivedAt == null).filter((p) =>
    filter === 'at-risk' ? p.flags.some((f) => f.kind === 'risk' && f.clearedAt == null)
      : filter === 'with-timmy' ? p.people.some((pp) => pp.personId === 'per_timmy') : true);
  const columns = STATUSES.map((status) => {
    const cards = sel.filter((p) => p.status === status).sort(compareCards).map((p) => {
      const ppl = people(p).map(({ id, kind, name, avatarUrl, state }) => ({ id, kind, name, avatarUrl, state }));
      return { id: p.id, name: p.name, priority: p.priority, revision: p.revision, status: p.status, thumb: thumbOf(p), flags: cardFlags(p.flags),
        people: { visible: ppl.slice(0, CARD_PEOPLE_CAP), hiddenCount: Math.max(0, ppl.length - CARD_PEOPLE_CAP) }, lastActivityAt: p.lastActivityAt };
    });
    return { id: status, count: cards.length, cards };
  });
  return conform(EXAMPLES.boardVm.data, { filter, columns });
}

export function buildProjectVM(db, id) {
  const p = db.projects.get(id);
  if (!p) return null;
  const page = historyPage(db, id, null);
  return conform(EXAMPLES.projectVm.data, {
    id: p.id, revision: p.revision, name: p.name, status: p.status, priority: p.priority, archived: p.archivedAt != null,
    summary: p.summary, summaryMeta: p.summaryMeta ? { author: actorVm(p.summaryMeta.author), at: p.summaryMeta.at } : null,
    thumb: thumbOf(p),
    flags: p.flags.filter((f) => f.kind !== 'risk' || f.clearedAt == null).map(flagVm),
    sources: p.sources.map((s) => ({ id: s.id, kind: s.kind, label: sourceLabel(s), ref: s.ref ?? null, addedAt: s.addedAt, sessionCount: s.sessionCount ?? (s.kind === 'sessionGroup' && s.ref.by === 'keys' ? s.ref.sessionKeys.length : null) })),
    repo: repoVm(p.repo, p),
    people: people(p),
    recentHistory: page.items, historyNextCursor: page.nextCursor,
    lastActivityAt: p.lastActivityAt, createdAt: p.createdAt,
  });
}

/** Page<HistoryItemVM>: { items, nextCursor }; the cursor is an opaque offset into the grouped list. */
export function historyPage(db, id, cursor, limit = HISTORY_PAGE) {
  const all = presentHistory(db.history.get(id) || []);
  let start = 0;
  if (cursor) { start = Number(atob(cursor)); if (!Number.isInteger(start) || start < 0) return null; }
  const items = all.slice(start, start + limit);
  return conform(EXAMPLES.historyPage.data, { items, nextCursor: start + limit < all.length ? btoa(String(start + limit)) : null });
}

// ---- commands (api.md §5.3); each returns { status, body } or { result, touched: [projectIds] } ----
class CmdError extends Error { constructor(status, code, message, details) { super(message); Object.assign(this, { status, code, details }); } }
// Shape of error-409-project.json: no `details`, the authoritative state in `current`.
const conflict = (p) => Object.assign(new CmdError(409, 'conflict', 'Le projet a changé entre-temps.'), { projectId: p.id });
function checkBody(body, allowed, required = []) {
  for (const k of Object.keys(body || {})) if (!allowed.includes(k)) throw new CmdError(400, 'validation_failed', 'Certaines valeurs sont invalides.', [{ field: k, issue: 'champ inconnu' }]);
  for (const k of required) if (body[k] === undefined) throw new CmdError(400, 'validation_failed', 'Certaines valeurs sont invalides.', [{ field: k, issue: 'obligatoire' }]);
}
function touch(db, p, actor, kind, extra, now = Date.now()) {
  p.revision++; p.lastActivityAt = now;
  db.history.get(p.id).unshift({ id: nextId('evt'), projectId: p.id, at: now, actor, dedupeKey: null, kind, ...extra });
}
const slug = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48);

export function command(db, method, path, body, { conflictMode = false, actor = Owner } = {}) {
  try {
    if (method === 'POST' && path === '/api/v2/projects') {
      checkBody(body, ['name', 'status', 'priority', 'summary', 'sources'], ['name']);
      const name = String(body.name).trim();
      if (!name || name.length > 80) throw new CmdError(400, 'validation_failed', 'Le nom doit compter entre 1 et 80 caractères.', [{ field: 'name', issue: 'longueur' }]);
      if (body.status && !STATUSES.includes(body.status)) throw new CmdError(400, 'validation_failed', 'Statut inconnu.', [{ field: 'status', issue: 'enum' }]);
      if (body.priority && !(body.priority in PRIORITY_RANK)) throw new CmdError(400, 'validation_failed', 'Priorité inconnue.', [{ field: 'priority', issue: 'enum' }]);
      const now = Date.now();
      const id = 'prj_' + (slug(name) || 'projet') + '-' + (++seq).toString(36);
      const priority = body.priority || 'P2';
      const p = { id, name, status: body.status || 'idea', priority, summary: body.summary || '', summaryMeta: body.summary ? { author: actor, at: now } : null,
        sources: [{ id: nextId('src'), kind: 'manual', ref: null, addedAt: now, addedBy: actor }], repo: null,
        flags: [{ kind: 'priority', key: priority }], people: [{ personId: actor.personId, role: null, origin: 'manual', liveState: null, commitCount: null }],
        lastActivityAt: now, createdAt: now, revision: 1, archivedAt: null };
      db.projects.set(id, p);
      db.history.set(id, [{ id: nextId('evt'), projectId: id, at: now, actor, dedupeKey: null, kind: 'project-created' }]);
      return { result: { id }, revision: 1, touched: [id] };
    }
    const m = /^\/api\/v2\/projects\/([^/]+)(\/.*)?$/.exec(path);
    if (!m) return null;
    const p = db.projects.get(decodeURIComponent(m[1]));
    if (!p) throw new CmdError(404, 'not_found', 'Ce projet n’existe plus.');
    const rest = m[2] || '';
    // Every write to an existing project carries expectedRevision (PM, 2026-10-05); a mismatch is a 409.
    const { expectedRevision, ...fields } = body || {};
    if (expectedRevision === undefined) throw new CmdError(400, 'validation_failed', 'Certaines valeurs sont invalides.', [{ field: 'expectedRevision', issue: 'obligatoire' }]);
    if (conflictMode) { p.revision++; throw conflict(p); } // scenario « conflit »: someone else wrote first
    if (expectedRevision !== p.revision) throw conflict(p);
    body = fields;

    if (method === 'PUT' && rest === '/status') {
      checkBody(body, ['status'], ['status']);
      if (!STATUSES.includes(body.status)) throw new CmdError(400, 'validation_failed', 'Statut inconnu.', [{ field: 'status', issue: 'enum' }]);
      if (body.status === p.status) return { result: undefined, revision: p.revision, touched: [] };
      const from = p.status; p.status = body.status;
      touch(db, p, actor, 'status', { from, to: body.status });
      return { revision: p.revision, touched: [p.id] };
    }
    if (method === 'PATCH' && rest === '') {
      checkBody(body, ['name', 'summary', 'priority']);
      if (body.summary !== undefined) {
        if (String(body.summary).length > 4000) throw new CmdError(400, 'validation_failed', 'Le résumé dépasse 4 000 caractères.', [{ field: 'summary', issue: 'longueur' }]);
        p.summary = String(body.summary); p.summaryMeta = { author: actor, at: Date.now() }; touch(db, p, actor, 'summary-edited', {});
      }
      if (body.priority !== undefined && body.priority !== p.priority) {
        if (!(body.priority in PRIORITY_RANK)) throw new CmdError(400, 'validation_failed', 'Priorité inconnue.', [{ field: 'priority', issue: 'enum' }]);
        const from = p.priority; p.priority = body.priority; p.flags = p.flags.map((f) => (f.kind === 'priority' ? { kind: 'priority', key: body.priority } : f));
        touch(db, p, actor, 'priority', { from, to: body.priority });
      }
      if (body.name !== undefined && body.name !== p.name) {
        const name = String(body.name).trim();
        if (!name || name.length > 80) throw new CmdError(400, 'validation_failed', 'Le nom doit compter entre 1 et 80 caractères.', [{ field: 'name', issue: 'longueur' }]);
        const from = p.name; p.name = name; touch(db, p, actor, 'renamed', { from, to: name });
      }
      return { revision: p.revision, touched: [p.id] };
    }
    if (method === 'POST' && rest === '/flags') {
      if (body && body.kind === 'label') {
        checkBody(body, ['kind', 'label'], ['label']);
        const label = String(body.label).trim();
        if (!label || label.length > 32) throw new CmdError(400, 'validation_failed', 'L’étiquette doit compter entre 1 et 32 caractères.', [{ field: 'label', issue: 'longueur' }]);
        const key = slug(label);
        if (p.flags.some((f) => f.kind === 'label' && f.key === key)) throw new CmdError(409, 'conflict', 'Cette étiquette existe déjà.');
        p.flags.push({ kind: 'label', key, label, addedBy: actor, addedAt: Date.now() });
        touch(db, p, actor, 'flag-added', { flagKind: 'label', key, label });
      } else if (body && body.kind === 'risk' && body.key === 'blocked') {
        checkBody(body, ['kind', 'key']);
        if (!p.flags.some((f) => f.kind === 'risk' && f.key === 'blocked' && f.clearedAt == null)) {
          p.flags.push({ kind: 'risk', key: 'blocked', severity: 'high', origin: 'manual', evidence: { kind: 'manual', ref: actor.personId, at: Date.now() }, raisedAt: Date.now(), clearedAt: null, ack: null });
          touch(db, p, actor, 'flag-added', { flagKind: 'risk', key: 'blocked', label: 'Bloqué' });
        }
      } else throw new CmdError(400, 'validation_failed', 'Seules les étiquettes et le risque « Bloqué » peuvent être ajoutés.', [{ field: 'kind', issue: 'enum' }]);
      return { revision: p.revision, touched: [p.id] };
    }
    const del = /^\/flags\/(label|risk)\/([^/]+)$/.exec(rest);
    if (method === 'DELETE' && del) {
      const [, kind, key] = del;
      if (kind === 'risk' && key !== 'blocked') throw new CmdError(400, 'validation_failed', 'Les risques automatiques ne peuvent pas être retirés ; prenez-en connaissance.', [{ field: 'key', issue: 'auto' }]);
      const before = p.flags.length;
      p.flags = p.flags.filter((f) => !(f.kind === kind && f.key === decodeURIComponent(key)));
      if (p.flags.length !== before) touch(db, p, actor, 'flag-removed', { flagKind: kind, key: decodeURIComponent(key) });
      return { revision: p.revision, touched: [p.id] };
    }
    const ack = /^\/flags\/risk\/([^/]+)\/ack$/.exec(rest);
    if (method === 'PUT' && ack) {
      checkBody(body, ['ack'], ['ack']);
      const f = p.flags.find((x) => x.kind === 'risk' && x.key === ack[1] && x.clearedAt == null);
      if (!f) throw new CmdError(404, 'not_found', 'Ce risque n’est plus actif.');
      if (!!f.ack !== !!body.ack) {
        f.ack = body.ack ? { by: actor, at: Date.now() } : null;
        touch(db, p, actor, body.ack ? 'risk-acked' : 'risk-unacked', { key: f.key });
      }
      return { revision: p.revision, touched: [p.id] };
    }
    if (method === 'POST' && rest === '/sources') {
      checkBody(body, ['source'], ['source']);
      const src = body.source || {};
      if (src.kind !== 'github' || !src.ref || !/^[\w.-]+$/.test(src.ref.owner || '') || !/^[\w.-]+$/.test(src.ref.repo || '')) {
        throw new CmdError(400, 'validation_failed', 'Indiquez le dépôt sous la forme propriétaire/nom.', [{ field: 'source.ref', issue: 'invalid' }]);
      }
      if (p.sources.some((x) => x.kind === 'github' && x.ref.owner === src.ref.owner && x.ref.repo === src.ref.repo)) return { revision: p.revision, touched: [] };
      const now = Date.now();
      p.sources.push({ id: nextId('src'), kind: 'github', ref: { owner: src.ref.owner, repo: src.ref.repo }, addedAt: now, addedBy: actor });
      // `repo` derives from the first github source; a new one is not fetched yet: RepoVM.state 'pending'.
      if (!p.repo) p.repo = { url: `https://github.com/${src.ref.owner}/${src.ref.repo}`, owner: src.ref.owner, name: src.ref.repo, defaultBranch: null,
        image: { kind: 'generated', url: null }, ci: { state: 'none', at: null, url: null }, commits: [], fetchedAt: null };
      touch(db, p, actor, 'source-linked', { source: 'github', ref: `${src.ref.owner}/${src.ref.repo}` });
      return { revision: p.revision, touched: [p.id] };
    }
    return null;
  } catch (err) {
    if (err instanceof CmdError) {
      // 409 on a project write carries the authoritative state (api.md 2.0 §2.2).
      const current = err.projectId && db.projects.has(err.projectId) ? { revision: db.projects.get(err.projectId).revision, vm: buildProjectVM(db, err.projectId) } : undefined;
      return { status: err.status, body: { error: { code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}), requestId: 'req_' + Math.random().toString(36).slice(2, 10), ...(current ? { current } : {}) } } };
    }
    throw err;
  }
}

/** Timmy moves a project by himself (the later agent API), so the board shows a live move from someone else. */
export function timmyMove(db) {
  const p = db.projects.get('prj_veille');
  if (!p) return null;
  const to = p.status === 'in-progress' ? 'in-review' : 'in-progress';
  const from = p.status; p.status = to;
  touch(db, p, TIMMY, 'status', { from, to });
  return p.id;
}

// architect-57: the mock thread uses the same item shape as CommentThreadVM, oldest first.
const mentionable = () => ['per_timmy', 'per_scout'].map((id, i) => { const p = PERSONS.get(id); return { id: i ? 'scout' : 'main', name: p.name, avatarUrl: p.avatarUrl, primary: !i }; });
function threadRows(db, id) {
  db.comments ||= new Map();
  if (!db.comments.has(id)) {
    const p = db.projects.get(id);
    if (id === EXAMPLES.comments.data.projectId) { db.comments.set(id, exampleData(EXAMPLES.comments).items); return db.comments.get(id); }
    db.comments.set(id, p ? [commentItem({ id: 'cmt_'+id, at: p.lastActivityAt - 60000, author: chipOf('per_alex'), body: getLang() === 'en' ? 'The project is ready for the next step.' : 'Le projet est prêt pour la prochaine étape.', editable: true, deletable: true })] : []);
  }
  return db.comments.get(id);
}
function commentItem(fields) {
  return { id: nextId('cmt'), kind: 'comment', at: Date.now(), author: chipOf('per_alex'), body: null, text: null, mentions: [], replyTo: null, delivery: [], editedAt: null, deleted: false, editable: false, deletable: true, ...fields };
}
export function buildCommentsVM(db, id, { cursor = null, canComment = true, canMention = true } = {}) {
  const p = db.projects.get(id); if (!p) return null;
  const rows = threadRows(db, id).slice();
  const lines = presentHistory(db.history.get(id) || []).filter((e) => ['status', 'priority'].includes(e.kind) && e.actor.kind === 'agent').map((e) => commentItem({ id: 'hist:'+e.id, kind: 'system', at: e.at, author: {...e.actor,state:null}, text: e.text, deletable: false }));
  for (const line of lines) {const at=rows.findIndex((c) => c.at>line.at);rows.splice(at<0 ? rows.length : at,0,line);}
  let end=rows.length;
  try {if(cursor) end=Number(atob(cursor));} catch {return null;}
  if (!Number.isInteger(end) || end < 0 || end > rows.length) return null;
  const start = Math.max(0, end-50);
  const key = 'agent:main:ao-projet-'+slug(p.name);
  return conform(EXAMPLES.comments.data, { projectId: id, items: rows.slice(start,end), nextCursor: start ? btoa(String(start)) : null, mentionable: mentionable(), canComment, canMention,
    session: { key, route: '/journaux/'+encodeURIComponent(key) } });
}
export function commentCommand(db, method, id, cid, body, { canMention = true } = {}) {
  if (!db.projects.has(id)) return { error: [404, 'not_found', 'Ce projet n’existe plus.'] };
  const rows = threadRows(db,id);
  const old = cid && rows.find((c) => c.id === cid);
  if (cid && (!old || old.kind !== 'comment')) return { error: [404, 'not_found', 'Ce commentaire n’existe plus.'] };
  if (old?.deleted) return { error: [400,'validation_failed','Ce message est supprimé.'] };
  if (method === 'PATCH' && old && !old.editable) return { error: [403, 'forbidden', 'Vous ne pouvez modifier que vos commentaires.'] };
  if (method !== 'DELETE' && (typeof body?.body !== 'string' || !body.body.trim() || [...body.body].length > 4000 || Object.keys(body).some((k) => !['body','replyTo'].includes(k)))) return { error: [400, 'validation_failed', 'Le commentaire doit compter entre 1 et 4 000 caractères.'] };
  if (method === 'DELETE') { old.body = null; old.deleted = true; old.editable = old.deletable = false; return { comment: old }; }
  if (method === 'PATCH') { old.body = body.body.trim(); old.editedAt = Date.now(); return { comment: old }; }
  const parent = body.replyTo && rows.find(c=>c.id===body.replyTo);
  if (body.replyTo != null && (!parent || parent.deleted)) return {error:[400,'validation_failed','Réponse invalide.']};
  const mentions = mentionable().filter((a) => new RegExp('(^|[^\\p{L}\\p{N}_.@-])@(?:'+a.id+'|'+a.name.replace(/\s/g,'')+')(?![\\p{L}\\p{N}_-])', 'iu').test(body.body)).map(({id,name}) => ({id,name}));
  const c = commentItem({ body: body.body.trim(), replyTo:body.replyTo || null, mentions, delivery: mentions.map((a) => ({ agentId: a.id, status: canMention ? 'pending' : 'unavailable', reason: canMention ? null : 'readonly' })), editable: true });
  rows.push(c); return { comment: c };
}
export function replyToComment(db, id, c, { fail = false, summary = false, agentId = null } = {}) {
  const rows = threadRows(db,id), p = db.projects.get(id);
  for (const d of c.delivery.filter(d=>!agentId || d.agentId===agentId)) {
    d.status = fail ? 'failed' : 'replied'; d.reason = fail ? 'timeout' : null;
    if (!fail) {
      const a = mentionable().find((a) => a.id === d.agentId);
      const text = getLang() === 'en' ? 'The follow-up plan is ready. Please review the next step.' : 'Le plan de suivi est prêt. La prochaine étape est à valider.';
      rows.push(commentItem({ author: { id: a.id, kind: 'agent', name: a.name, avatarUrl: a.avatarUrl, state: null }, body: text, replyTo: c.id }));
      if (summary) { p.summary = text; p.summaryMeta = { author: TIMMY, at: Date.now() }; touch(db,p,TIMMY,'summary-edited',{}); }
    }
  }
}
export function requestSummary(db,id,body) {
  const p = db.projects.get(id);
  if (!p) return { error: [404,'not_found','Ce projet n’existe plus.'] };
  if (p.summaryPending) return { error: [409,'conflict','Un résumé est déjà en cours.'] };
  if (body?.expectedRevision !== p.revision) return { status:409, body:{ error:{code:'conflict',message:'Le projet a changé entre-temps.',requestId:'req_mock',current:{revision:p.revision,vm:buildProjectVM(db,id)}}} };
  if (Object.keys(body).some((k) => k !== 'expectedRevision')) return { error:[400,'validation_failed','Champ inconnu.'] };
  p.summaryPending = true;
  const c = commentItem({ kind:'event', text:{key:'projectThread.event.summary-requested',params:{actor:chipOf('per_alex').name}}, delivery:[{agentId:'main',status:'pending',reason:null}], deletable:false });
  threadRows(db,id).push(c); return { comment:c, turnId:nextId('turn'), revision:p.revision };
}

export function retryComment(db,id,cid,body) {
  if(!db.projects.has(id))return {error:[404,'not_found','Projet introuvable.']};
  const c=threadRows(db,id).find(c=>c.id===cid);
  if(!c || c.deleted)return {error:[404,'not_found','Message introuvable.']};
  if(c.author.id!==chipOf('per_alex').id)return {error:[403,'forbidden','Ce message appartient à une autre personne.']};
  const d=c.delivery.find(d=>d.agentId===body.agentId);
  if(!d || !['failed','no-reply'].includes(d.status))return {error:[400,'validation_failed','Livraison non réessayable.']};
  d.status='pending';d.reason=null;return {comment:c};
}
