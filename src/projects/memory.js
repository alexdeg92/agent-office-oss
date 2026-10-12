'use strict';

const { ProjectError, notFound, validation, conflict } = require('./errors');
const { mint: mintId } = require('./ids');
const { parse, projectSchema, projectSchemaWithRootIds, historySchema, personSchema, repoSchema, refKeyOf } = require('./validate');
const { normalizeWorkspaceRoots } = require('./roots');
const { authorHint } = require('./email');
const { stripRemoteCredentials } = require('./sources/refs');
const { derivePeople, matchPerson, sortFlags } = require('./people');
const plan = require('./plan');
const { evaluateRisks } = require('./risks');
const { admit, Person, HistoryEvent, Flag, Project, ProjectWithRootIds, ProjectSource, ProjectSourceWithRootIds } = require('./entities');
const { HISTORY_PAGE, SOURCE_ERROR_CATEGORIES } = require('./constants');

const REPOSITORY_METHODS = Object.freeze([
  'getProject', 'listProjects', 'getHistory', 'findActiveByGithub', 'sourceStats',
  'getSummaryTurn', 'claimSummary', 'completeSummary', 'abandonSummary',
  'createProject', 'rename', 'setStatus', 'reorder', 'setPriority', 'editSummary', 'edit',
  'addLabel', 'addFlag', 'removeFlag', 'setBlocked', 'ackRisk', 'linkSource', 'unlinkSource',
  'setArchived', 'setPersonOverride', 'applyRisks', 'applyProjectRisks', 'ingestActivity',
  'replaceFeatureFlags', 'appendHistory', 'importCandidates', 'putRepoCache', 'recordRepoFailure', 'putWorkspaceSnapshot', 'putSessionSnapshot',
  'upsertPerson', 'getPerson', 'listPersons', 'setLiveStates', 'createTaggedProject', 'tagSlugOwner',
]);

function deepFreeze(o) {
  if (!o || typeof o !== 'object' || Object.isFrozen(o)) return o;
  for (const v of Object.values(o)) deepFreeze(v);
  return Object.freeze(o);
}

function encodeCursor(event) {
  return Buffer.from(JSON.stringify({ at: event.at, id: event.id }), 'utf8').toString('base64url');
}

function resolvedPrimary(value) {
  const id = typeof value === 'function' ? value() : value;
  return id || 'main';
}

function decodeCursor(cursor) {
  try {
    const v = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (!v || !Number.isInteger(v.at) || typeof v.id !== 'string') throw new Error('bad');
    return v;
  } catch {
    throw new ProjectError('validation_failed', 'Curseur invalide.', { details: [{ field: 'cursor', issue: 'invalid' }] });
  }
}

function isOlder(event, cursor) {
  if (event.at !== cursor.at) return event.at < cursor.at;
  return event.id < cursor.id;
}

function firstGithub(sources) {
  return sources.filter((s) => s.kind === 'github')
    .sort((a, b) => a.addedAt - b.addedAt || (a.id < b.id ? -1 : 1))[0] || null;
}

class MemoryRepository {
  constructor(options = {}) {
    this.rows = new Map();
    this.sources = new Map();
    this.flags = new Map();
    this.overrides = new Map();
    this.history = new Map();
    this.persons = new Map();
    this.caches = new Map();
    this.workspaces = new Map();
    this.sessionSnaps = new Map();
    this.summaryTurns = new Map();    // internal; never part of the public project schema
    this.tagSlugs = new Map();           // architect-55: slug → { projectId, at } (a tag's slug creates a project once)
    this.liveStates = { ...(options.liveStates || {}) };
    this.ownerPersonId = options.ownerPersonId || null;
    this.timmyPersonId = options.timmyPersonId || null;
    this.primaryAgentId = options.primaryAgentId || null;
    this.locale = options.locale || null;
    this.timeZone = options.timeZone || null;
    this.githubOwners = Array.isArray(options.githubOwners) ? options.githubOwners : [];
    this.portability = options.portability === true;
    this.workspaceRootIds = options.workspaceRootIds === true;
    this.workspaceRoots = this.workspaceRootIds ? normalizeWorkspaceRoots(options.workspaceRoots || []) : [];
    this._projectSchema = this.workspaceRootIds ? projectSchemaWithRootIds : projectSchema;
    this.clock = options.now || (() => Date.now());
    this._randomBytes = options.randomBytes;
    for (const person of options.persons || []) this.upsertPerson(person);
  }

  now() { return this.clock(); }

  mint(prefix) { return mintId(prefix, this._randomBytes); }

  upsertPerson(person) {
    const value = parse(personSchema, person, 'Personne invalide.');
    admit(Person, value);
    this.persons.set(value.id, value);
    return this.getPerson(value.id);
  }

  getPerson(id) {
    const person = this.persons.get(id);
    return person ? deepFreeze(structuredClone(person)) : null;
  }

  listPersons() {
    return [...this.persons.values()].map((p) => deepFreeze(structuredClone(p)));
  }

  setLiveStates(map) { this.liveStates = { ...map }; }

  _ctx(id) {
    const row = this.rows.get(id);
    if (!row) throw notFound();
    return {
      row: structuredClone(row),
      sources: structuredClone(this.sources.get(id) || []),
      flags: structuredClone(this.flags.get(id) || []),
      overrides: structuredClone(this.overrides.get(id) || []),
      dedupeKeys: new Set((this.history.get(id) || []).map((e) => e.dedupeKey).filter(Boolean)),
    };
  }

  _commit(id, patch) {
    if (!patch || patch.noop) return;
    if (patch.events) {
      for (const e of patch.events) {
        parse(historySchema, e, 'Événement d’historique invalide.');
        admit(HistoryEvent, e);
      }
    }
    const overlay = {
      row: patch.row || this.rows.get(id),
      sources: patch.sources || this.sources.get(id) || [],
      flags: patch.flags || this.flags.get(id) || [],
      overrides: patch.overrides || this.overrides.get(id) || [],
    };
    if (overlay.row) this._assemble(id, overlay);
    if (patch.row) this.rows.set(id, patch.row);
    if (patch.sources) this.sources.set(id, patch.sources);
    if (patch.flags) this.flags.set(id, patch.flags);
    if (patch.overrides) this.overrides.set(id, patch.overrides);
    if (patch.events && patch.events.length) {
      const list = this.history.get(id) || [];
      for (const e of patch.events) {
        if (e.dedupeKey && list.some((x) => x.dedupeKey === e.dedupeKey)) continue;
        list.push(e);
      }
      this.history.set(id, list);
    }
    if (patch.unlinked) {
      this.workspaces.delete(patch.unlinked.id);
      this.sessionSnaps.delete(patch.unlinked.id);
    }
  }

  _run(id, input, fn) {
    const ctx = this._ctx(id);
    const env = plan.bindEnv(this, input);
    const patch = fn(ctx, input, env);
    this._commit(id, patch);
    return this.getProject(id);
  }

  _authors(sources) {
    const authors = [];
    for (const source of sources) {
      if (source.kind === 'github') {
        const cache = this.caches.get(refKeyOf('github', source.ref));
        if (cache) authors.push(...cache.authors);
      } else if (source.kind === 'workspace') {
        const snap = this.workspaces.get(source.id);
        if (snap) authors.push(...snap.authors);
      }
    }
    return authors;
  }

  _sessions(sources) {
    const sessions = [];
    for (const source of sources) {
      if (source.kind !== 'sessionGroup') continue;
      const snap = this.sessionSnaps.get(source.id);
      if (snap) sessions.push(...snap.sessions);
    }
    return sessions;
  }

  _assemble(id, overlay) {
    const row = overlay ? overlay.row : this.rows.get(id);
    if (!row) return null;
    const sources = (overlay ? overlay.sources : (this.sources.get(id) || [])).slice()
      .sort((a, b) => a.addedAt - b.addedAt || (a.id < b.id ? -1 : 1));
    const storedFlags = overlay ? overlay.flags : (this.flags.get(id) || []);
    const overrideRows = overlay ? overlay.overrides : (this.overrides.get(id) || []);
    const persons = [...this.persons.values()];
    const gh = firstGithub(sources);
    let repo = null;
    let repoStatus = null;
    if (gh) {
      const cache = this.caches.get(refKeyOf('github', gh.ref));
      if (!cache) {
        repoStatus = { state: 'pending', lastAttemptAt: null, lastError: null };
      } else if (cache.lastError) {
        repoStatus = { state: 'error', lastAttemptAt: cache.lastAttemptAt, lastError: cache.lastError };
      } else if (cache.repo) {
        repoStatus = { state: 'ok', lastAttemptAt: cache.lastAttemptAt ?? cache.repo.fetchedAt, lastError: null };
      } else {
        repoStatus = { state: 'pending', lastAttemptAt: cache.lastAttemptAt, lastError: null };
      }
      if (cache && cache.repo) {
        repo = {
          ...cache.repo,
          commits: cache.repo.commits.map((c, i) => {
            const person = matchPerson(persons, cache.authors[i]);
            return { ...c, author: { name: c.author.name, personId: person ? person.id : null } };
          }),
        };
      }
    }
    const people = derivePeople({
      persons,
      authors: this._authors(sources),
      sessions: this._sessions(sources),
      overrides: overrideRows,
      liveStates: this.liveStates,
      primaryAgentId: resolvedPrimary(this.primaryAgentId),
      locale: this.locale || 'fr',
    });
    const flags = sortFlags(storedFlags.concat([{ kind: 'priority', key: row.priority }]));
    const project = {
      ...row,
      sources,
      repo,
      repoStatus,
      flags,
      people,
    };
    const plain = parse(this._projectSchema, project, 'Projet canonique invalide.');
    const ProjectEntity = this.workspaceRootIds ? ProjectWithRootIds : Project;
    const SourceEntity = this.workspaceRootIds ? ProjectSourceWithRootIds : ProjectSource;
    admit(ProjectEntity, plain);
    for (const source of plain.sources) admit(SourceEntity, source);
    for (const flag of plain.flags) admit(Flag, flag);
    return deepFreeze(plain);
  }

  getProject(id) { return this._assemble(id); }

  listProjects({ archived = 'exclude' } = {}) {
    const out = [];
    for (const id of this.rows.keys()) {
      const project = this._assemble(id);
      const isArchived = project.archivedAt != null;
      if (archived === 'exclude' && isArchived) continue;
      if (archived === 'only' && !isArchived) continue;
      out.push(project);
    }
    return out;
  }

  getHistory(projectId, { cursor, limit = HISTORY_PAGE } = {}) {
    if (!this.rows.has(projectId)) throw notFound();
    const size = Math.min(100, Math.max(1, limit));
    let events = (this.history.get(projectId) || []).slice().sort((a, b) => b.at - a.at || (a.id < b.id ? 1 : -1));
    if (cursor) {
      const mark = decodeCursor(cursor);
      events = events.filter((e) => isOlder(e, mark));
    }
    const page = events.slice(0, size).map((e) => deepFreeze(structuredClone(e)));
    const nextCursor = events.length > size ? encodeCursor(page[page.length - 1]) : null;
    return { events: page, nextCursor };
  }

  findActiveByGithub(owner, repo) {
    const key = `${owner}/${repo}`.toLowerCase();
    for (const project of this.listProjects({ archived: 'exclude' })) {
      if (project.sources.some((s) => s.kind === 'github' && refKeyOf('github', s.ref) === key)) return project;
    }
    return null;
  }

  sourceStats(projectId) {
    const out = {};
    for (const source of this.sources.get(projectId) || []) {
      if (source.kind === 'sessionGroup' && this.sessionSnaps.has(source.id)) {
        out[source.id] = { sessionCount: this.sessionSnaps.get(source.id).sessionCount };
      }
    }
    return out;
  }

  _takenGithub(exceptId) {
    const taken = new Set();
    for (const project of this.listProjects({ archived: 'exclude' })) {
      if (project.id === exceptId) continue;
      for (const source of project.sources) {
        if (source.kind === 'github') taken.add(refKeyOf('github', source.ref));
      }
    }
    return taken;
  }

  /**
   * architect-55 · a project the agent's tag creates on its own: claims the slug and creates the project in one step.
   * → the project, or null when the slug was claimed before (whatever happened to that project since).
   */
  createTaggedProject(input) {
    const slug = String(input.slug || '');
    if (!/^[a-z0-9][a-z0-9-]{1,63}$/.test(slug) || this.tagSlugs.has(slug)) return null;
    const project = this.createProject({ name: input.name, status: input.status, priority: input.priority, summary: '', actor: input.actor, component: input.component,
      at: input.at, sources: [{ kind: 'sessionGroup', ref: { by: 'group', groupId: 'projet:' + slug, name: slug } }] });
    this.tagSlugs.set(slug, { projectId: project.id, at: input.at ?? this.now() });
    return project;
  }

  tagSlugOwner(slug) { const e = this.tagSlugs.get(String(slug || '')); return e ? e.projectId : null; }

  createProject(input) {
    const env = plan.bindEnv(this, input);
    const patch = plan.createProject({ ...input, takenGithub: this._takenGithub(null) }, env);
    for (const e of patch.events) parse(historySchema, e, 'Événement d’historique invalide.');
    this.rows.set(patch.row.id, patch.row);
    this.sources.set(patch.row.id, patch.sources);
    this.flags.set(patch.row.id, patch.flags);
    this.overrides.set(patch.row.id, patch.overrides);
    this.history.set(patch.row.id, []);
    this._commit(patch.row.id, { events: patch.events });
    return this.getProject(patch.row.id);
  }

  getSummaryTurn(id) { this._ctx(id); return this.summaryTurns.get(id) || null; }

  claimSummary({ id, expectedRevision, turnId, mintTurn }) {
    const { row } = this._ctx(id);
    if (!Number.isInteger(expectedRevision)) throw validation('La révision est requise.', 'expectedRevision');
    if (expectedRevision !== row.revision) throw conflict(row.revision);
    if (this.summaryTurns.get(id)) throw new ProjectError('conflict', 'Une régénération est déjà en cours.', {
      revision: row.revision, details: [{ field: 'summary', issue: 'turn-pending' }],
    });
    if (mintTurn) turnId = mintTurn();
    if (typeof turnId !== 'string' || !turnId) throw validation('Tour invalide.', 'turnId');
    this.summaryTurns.set(id, turnId);
    return { project: this.getProject(id), turnId };
  }

  completeSummary(input) {
    const { row } = this._ctx(input.id);
    if (!input.turnId || this.summaryTurns.get(input.id) !== input.turnId || row.revision !== input.expectedRevision) {
      return { applied: false, project: this.getProject(input.id) };
    }
    // Bypass manual edit cancellation. A child fallback keeps the same turn until the parent settles.
    const project = this._run(input.id, input, plan.edit);
    if (!input.keepPending) this.summaryTurns.delete(input.id);
    return { applied: true, project };
  }

  abandonSummary({ id, turnId }) {
    this._ctx(id);
    if (turnId && this.summaryTurns.get(id) === turnId) this.summaryTurns.delete(id);
  }

  edit(input) {
    const before = this._ctx(input.id).row.summary;
    const project = this._run(input.id, input, plan.edit);
    if (before !== project.summary) this.summaryTurns.delete(input.id);
    return project;
  }
  rename(input) { return this.edit(input); }
  setPriority(input) { return this.edit(input); }
  editSummary(input) { return this.edit(input); }
  setStatus(input) { return this._run(input.id, input, plan.setStatus); }
  reorder(input) { return this._run(input.id, input, plan.reorder); }
  addLabel(input) { return this._run(input.id, input, plan.addLabel); }
  addFlag(input) { return this._run(input.id, input, plan.addFlag); }
  setBlocked(input) { return this._run(input.id, input, plan.setBlocked); }
  removeFlag(input) { return this._run(input.id, input, plan.removeFlag); }
  ackRisk(input) { return this._run(input.id, input, plan.ackRisk); }

  linkSource(input) {
    const ctx = this._ctx(input.id);
    const env = plan.bindEnv(this, input);
    let takenById = null;
    const parsedKind = input.source && input.source.kind || input.kind;
    const ref = input.source ? input.source.ref : input.ref;
    if (parsedKind === 'github' && ref) {
      const other = this.findActiveByGithub(ref.owner, ref.repo);
      if (other && other.id !== input.id) takenById = other.id;
    }
    const patch = plan.linkSource(ctx, { ...input, takenById }, env);
    this._commit(input.id, patch);
    return this.getProject(input.id);
  }

  unlinkSource(input) { return this._run(input.id, input, plan.unlinkSource); }

  setArchived(input) {
    const ctx = this._ctx(input.id);
    const env = plan.bindEnv(this, input);
    let takenById = null;
    if (input.archived === false) {
      for (const source of ctx.sources) {
        if (source.kind !== 'github') continue;
        const other = this.findActiveByGithub(source.ref.owner, source.ref.repo);
        if (other) takenById = other.id;
      }
    }
    const patch = plan.setArchived(ctx, { ...input, takenById }, env);
    this._commit(input.id, patch);
    return this.getProject(input.id);
  }

  setPersonOverride(input) {
    const ctx = this._ctx(input.id);
    const env = plan.bindEnv(this, input);
    if (!this.persons.has(input.personId)) throw notFound('Personne introuvable.');
    const derived = new Set(derivePeople({
      persons: [...this.persons.values()],
      authors: this._authors(ctx.sources),
      sessions: this._sessions(ctx.sources),
      overrides: [],
      primaryAgentId: resolvedPrimary(this.primaryAgentId),
      locale: this.locale || 'fr',
    }).map((p) => p.personId));
    const patch = plan.setPersonOverride(ctx, { ...input, person: true, derived: derived.has(input.personId) }, env);
    this._commit(input.id, patch);
    return this.getProject(input.id);
  }

  applyRisks(input) { return this._run(input.id, input, plan.applyRisks); }

  applyProjectRisks(input) {
    const project = this.getProject(input.id);
    if (!project) throw notFound();
    const at = input.at ?? this.now();
    const planResult = evaluateRisks({
      now: at,
      lastActivityAt: project.lastActivityAt,
      flows: input.flows || [],
      crons: input.crons || [],
      ci: input.ci === undefined ? (project.repo ? project.repo.ci : null) : input.ci,
      staleDays: input.staleDays,
      current: project.flags,
    });
    return this.applyRisks({
      id: input.id,
      expectedRevision: input.expectedRevision,
      plan: planResult,
      actor: input.actor ?? 'system',
      component: input.component || 'risk-monitor',
      at,
    });
  }

  ingestActivity(input) { return this._run(input.id, input, plan.ingestActivity); }

  replaceFeatureFlags(input) { return this._run(input.id, input, plan.replaceFeatureFlags); }

  appendHistory(input) { return this._run(input.id, input, plan.appendHistory); }

  importCandidates(input) {
    const env = plan.bindEnv(this, { ...input, actor: input.actor || 'owner' });
    const wanted = Array.isArray(input.keys) ? input.keys : null;
    const all = input.candidates || [];
    const chosen = wanted ? all.filter((c) => wanted.includes(c.key)) : all.slice();
    const created = [];
    const skipped = [];
    if (wanted) {
      for (const key of wanted) {
        if (!all.some((c) => c.key === key)) skipped.push({ key, reason: 'unknown' });
      }
    }
    for (const candidate of chosen) {
      const gh = (candidate.sources || []).find((s) => s.kind === 'github');
      if (gh && gh.ref) {
        const existing = this.findActiveByGithub(gh.ref.owner, gh.ref.repo);
        if (existing) {
          skipped.push({ key: candidate.key, reason: 'exists' });
          continue;
        }
      }
      try {
        const override = input.overrides && input.overrides[candidate.key];
        const patch = plan.importCandidate({
          ...candidate,
          name: override && override.name != null ? override.name : candidate.name,
          status: override && override.status != null ? override.status : candidate.status,
          labels: override && Array.isArray(override.labels) ? override.labels : candidate.labels,
          activityAt: candidate.lastActivityAt,
          takenGithub: this._takenGithub(null),
        }, env);
        for (const ev of patch.events) parse(historySchema, ev, 'Événement d’historique invalide.');
        this.rows.set(patch.row.id, patch.row);
        this.sources.set(patch.row.id, patch.sources);
        this.flags.set(patch.row.id, patch.flags);
        this.overrides.set(patch.row.id, []);
        this.history.set(patch.row.id, []);
        this._commit(patch.row.id, { events: patch.events });
        created.push({ key: candidate.key, id: patch.row.id });
      } catch {
        skipped.push({ key: candidate.key, reason: 'validation_failed' });
      }
    }
    return { ok: true, result: { created, skipped }, revision: null, vm: null };
  }

  _ensureAuthors(authors) {
    for (const hint of authors) {
      if (!hint || !hint.emailHash) continue;
      if ([...this.persons.values()].some((p) => p.links.gitEmailHash === hint.emailHash)) continue;
      this.upsertPerson({
        id: this.mint('per'),
        kind: 'git',
        name: authorHint(hint.name, null).name,
        avatarUrl: null,
        links: { gitEmailHash: hint.emailHash },
      });
    }
  }

  recordRepoFailure({ owner, name, at, error }) {
    if (!SOURCE_ERROR_CATEGORIES.includes(error)) throw validation('Catégorie d’erreur inconnue.', 'error');
    const key = `${owner}/${name}`.toLowerCase();
    const prev = this.caches.get(key);
    this.caches.set(key, {
      repo: prev && prev.repo ? prev.repo : null,
      authors: prev && prev.authors ? prev.authors : [],
      lastAttemptAt: at ?? this.now(),
      lastError: error,
    });
  }

  putRepoCache({ owner, name, repo, authors }) {
    const key = `${owner}/${name}`.toLowerCase();
    const cleanAuthors = (authors || []).map((hint) => ({
      name: authorHint(hint && hint.name, null).name,
      emailHash: hint && hint.emailHash || null,
    }));
    let cleanRepo = null;
    if (repo) {
      cleanRepo = structuredClone(repo);
      if (Array.isArray(cleanRepo.commits)) {
        cleanRepo.commits = cleanRepo.commits.map((commit) => ({
          ...commit,
          author: {
            ...(commit.author || {}),
            name: authorHint(commit.author && commit.author.name, null).name,
          },
        }));
      }
      if (typeof cleanRepo.url === 'string') cleanRepo.url = stripRemoteCredentials(cleanRepo.url);
      parse(repoSchema, cleanRepo, 'Dépôt invalide.');
    }
    const next = {
      repo: cleanRepo,
      authors: cleanAuthors,
      lastAttemptAt: cleanRepo ? cleanRepo.fetchedAt : null,
      lastError: null,
    };
    const prev = this.caches.get(key);
    this.caches.set(key, next);
    try {
      for (const id of this.rows.keys()) {
        const sources = this.sources.get(id) || [];
        if (sources.some((s) => s.kind === 'github' && refKeyOf('github', s.ref) === key)) this._assemble(id);
      }
    } catch (err) {
      if (prev) this.caches.set(key, prev);
      else this.caches.delete(key);
      throw err;
    }
    this._ensureAuthors(cleanAuthors);
  }

  putWorkspaceSnapshot({ sourceId, authors, branch, commits }) {
    const cleanAuthors = (authors || []).map((hint) => ({
      ...hint,
      name: authorHint(hint && hint.name, null).name,
    }));
    const cleanCommits = (commits || []).map((commit) => ({
      ...commit,
      author: commit.author
        ? { ...commit.author, name: authorHint(commit.author.name, null).name }
        : commit.author,
    }));
    this.workspaces.set(sourceId, { authors: cleanAuthors, branch, commits: cleanCommits });
    this._ensureAuthors(cleanAuthors);
  }

  putSessionSnapshot({ sourceId, sessions, sessionCount }) {
    const list = sessions || [];
    this.sessionSnaps.set(sourceId, { sessions: structuredClone(list), sessionCount: sessionCount ?? list.length });
  }
}

function createMemoryRepository(options) {
  return new MemoryRepository(options);
}

module.exports = { createMemoryRepository, MemoryRepository, REPOSITORY_METHODS, encodeCursor };
