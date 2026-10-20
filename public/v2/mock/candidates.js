// Mock discovery candidates for « Importer des projets » (api.md 2.1 §3.14, §5.4): the contract example's candidates
// plus invented French ones, all conformed to candidates-vm.json; the import result follows import-result.json.
//   GET  /api/v2/views/project-candidates → CandidatesVM { scannedAt, candidates: CandidateVM[] } (a one-shot GET)
//   POST /api/v2/projects/import { keys, overrides? } → CommandResult<{ created: {key, id}[], skipped: {key, reason}[] }>
import { EXAMPLES, conform, exampleData } from './examples.js';
const MIN = 60_000, H = 60 * MIN, D = 24 * H;

export function seedCandidates(now = Date.now()) {
  const label = (s) => (s.kind === 'github' ? `${s.ref.owner}/${s.ref.repo}` : s.kind === 'workspace' ? s.ref.path : s.ref.by === 'keys' ? `${s.ref.sessionKeys.length} conversations` : s.ref.interlocutorId);
  const c = (key, name, suggestedStatus, confidence, reason, labels, sources, ago, summary = '') =>
    ({ id: key, key, name, summary, suggestedStatus, confidence, reason, labels, sources: sources.map((x) => ({ kind: x.kind, label: label(x), ref: x.ref })), lastActivityAt: ago == null ? null : now - ago });
  const list = [
    c('gh:atelier-demo/inventaire', 'Gestion de l’inventaire', 'in-progress', 'high',
      '12 commits cette semaine et une branche de fonctionnalité ouverte.', ['client'],
      [{ kind: 'github', ref: { owner: 'atelier-demo', repo: 'inventaire' } }, { kind: 'sessionGroup', ref: { by: 'keys', sessionKeys: ['inv-1', 'inv-2', 'inv-3', 'inv-4'] } }], 3 * H),
    c('gh:atelier-demo/carte-cadeau', 'Cartes-cadeaux en ligne', 'in-review', 'high',
      'Une demande de fusion attend une revue depuis deux jours.', ['client', 'site web'],
      [{ kind: 'github', ref: { owner: 'atelier-demo', repo: 'carte-cadeau' } }], 2 * D),
    c('ws:notes/demenagement', 'Déménagement du bureau', 'todo', 'medium',
      'Dossier de notes avec une liste de tâches, aucune n’est cochée.', ['interne'],
      [{ kind: 'workspace', ref: { path: 'notes/demenagement' } }], 6 * D),
    c('sg:discord-user:guest', 'Soumissions pour Guest Tremblay', 'in-progress', 'medium',
      '9 conversations avec Guest ce mois-ci portent sur des soumissions.', ['client'],
      [{ kind: 'sessionGroup', ref: { by: 'interlocutor', interlocutorId: 'discord-user:100000000000000001' } }], 20 * H),
    c('gh:atelier-demo/blogue', 'Blogue de l’atelier', 'shipped', 'high',
      'Déployé ; dernier commit il y a 3 semaines, aucune tâche ouverte.', ['site web'],
      [{ kind: 'github', ref: { owner: 'atelier-demo', repo: 'blogue' } }], 21 * D),
    c('ws:scripts/photos', 'Tri automatique des photos', 'idea', 'low',
      'Un seul script d’essai, jamais exécuté par une tâche planifiée.', ['perso'],
      [{ kind: 'workspace', ref: { path: 'scripts/photos' } }], 45 * D),
    c('gh:atelier-demo/dotfiles', 'Configuration du poste', 'shipped', 'low',
      'Dépôt personnel sans activité récente ; probablement pas un projet.', [],
      [{ kind: 'github', ref: { owner: 'atelier-demo', repo: 'dotfiles' } }], 120 * D),
    c('sg:keys:formation', 'Formation sur les outils IA', 'todo', 'medium',
      'Timmy a préparé un plan de formation en 3 séances, pas encore donné.', ['interne', 'formation'],
      [{ kind: 'sessionGroup', ref: { by: 'keys', sessionKeys: ['form-1', 'form-2'] } }, { kind: 'workspace', ref: { path: 'docs/formation' } }], 4 * D),
    c('ws:rapports/impots', 'Préparation des impôts', 'idea', 'low',
      'Dossier créé l’an dernier ; seulement deux fichiers.', ['perso', 'finances'],
      [{ kind: 'workspace', ref: { path: 'rapports/impots' } }], 200 * D),
  ];
  // The contract example's candidates come first (their keys are what import-result.json refers to).
  return [...exampleData(EXAMPLES.candidatesVm).candidates, ...list];
}

/** CandidatesVM, conformed to the example. */
export const candidatesVM = (list, scannedAt) => conform(EXAMPLES.candidatesVm.data, { scannedAt, candidates: list, statusOptions: EXAMPLES.candidatesVm.data.statusOptions });

const statusIds = EXAMPLES.candidatesVm.data.statusOptions.map(option => option.id);
const slug = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48);
const fail = (status, code, message, details) => ({ status, body: { error: { code, message, ...(details ? { details } : {}), requestId: 'req_' + Math.random().toString(36).slice(2, 10) } } });

/**
 * Imports the chosen candidates into the mock projects db and removes them from the list.
 * → { list, created: {key, id}[], skipped: {key, reason}[] }, or { status, body } for a malformed request.
 * Per-candidate problems don't fail the whole import (import-result.json): an unknown key is skipped as 'unknown',
 * a key already imported as 'exists', and an invalid override as 'validation_failed'.
 */
export function importCandidates(db, list, body, now = Date.now(), imported = new Set()) {
  const keys = body && body.keys;
  const overrides = (body && body.overrides) || {};
  for (const k of Object.keys(body || {})) if (k !== 'keys' && k !== 'overrides') return fail(400, 'validation_failed', 'Certaines valeurs sont invalides.', [{ field: k, issue: 'unexpected-field' }]);
  if (!Array.isArray(keys) || !keys.length || keys.some((k) => typeof k !== 'string')) return fail(400, 'validation_failed', 'Choisissez au moins un projet.', [{ field: 'keys', issue: 'invalid' }]);
  const created = [], skipped = [];
  for (const key of keys) {
    const c = list.find((x) => x.key === key);
    if (!c) { skipped.push({ key, reason: imported.has(key) ? 'exists' : 'unknown' }); continue; }
    const o = overrides[key] || {};
    if ((o.name !== undefined && (!String(o.name).trim() || String(o.name).length > 80)) || (o.status !== undefined && !statusIds.includes(o.status))
      || (o.labels !== undefined && (!Array.isArray(o.labels) || o.labels.some((l) => typeof l !== 'string' || !l.trim() || l.length > 32)))) {
      skipped.push({ key, reason: 'validation_failed' }); continue;
    }
    const id = 'prj_' + (slug(o.name || c.name) || 'projet') + '-' + Math.random().toString(36).slice(2, 5);
    const actor = { kind: 'human', personId: 'per_alex' };
    const gh = c.sources.find((x) => x.kind === 'github');
    db.projects.set(id, {
      id, name: String(o.name || c.name).trim(), status: o.status || c.suggestedStatus, priority: 'P2', summary: c.summary || '', summaryMeta: null,
      sources: c.sources.map((x, i) => ({ id: `src_imp${created.length}${i}`, kind: x.kind, ref: x.ref, addedAt: now, addedBy: actor })),
      repo: gh ? { url: `https://github.com/${gh.ref.owner}/${gh.ref.repo}`, owner: gh.ref.owner, name: gh.ref.repo, defaultBranch: null, image: { kind: 'generated', url: null }, ci: { state: 'none', at: null, url: null }, commits: [], fetchedAt: null } : null,
      flags: [{ kind: 'priority', key: 'P2' }, ...(o.labels || c.labels).map((l) => ({ kind: 'label', key: slug(l), label: l, addedBy: actor, addedAt: now }))],
      people: [{ personId: 'per_alex', role: null, origin: 'manual', liveState: null, commitCount: null }],
      lastActivityAt: c.lastActivityAt || now, createdAt: now, revision: 1, archivedAt: null,
    });
    db.history.set(id, [{ id: 'evt_imp' + id, projectId: id, at: now, actor, dedupeKey: null, kind: 'project-created' }]);
    created.push({ key, id });
    imported.add(key);
  }
  const done = new Set(created.map((x) => x.key));
  const result = conform(EXAMPLES.importResult.data.result, { created, skipped });
  return { list: list.filter((x) => !done.has(x.key)), ...result };
}
