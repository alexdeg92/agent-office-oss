'use strict';
/*
 * SQL projects repository (S5; storage.md §5; projects.md "Wiring").
 *
 * One implementation of the domain rules: this class runs the projects module's own repository logic
 * (MemoryRepository, which applies plan.* and the module's schemas) on top of SQL-backed collections,
 * and wraps every public method in ONE transaction (BEGIN IMMEDIATE … COMMIT, ROLLBACK on throw). So a
 * rejected command writes nothing, and the rules are never copied into SQL.
 *
 * Each collection the logic uses is a small Map-shaped facade over one table (get/set/has/delete/keys/
 * values). Every JSON value is validated with the module's schemas on write and on read; a row that
 * fails on read is skipped and reported (store.invalid), never returned half-parsed.
 *
 * Passes test/projects/repository-contract.test.js unchanged (test/store/projects-repository.test.js).
 * Not stored: session-group snapshots (session data; rebuilt from the engine after a boot).
 */
const { MemoryRepository, REPOSITORY_METHODS } = require('../../projects/memory');
const { mapLegacyActors } = require('../../projects/actors');
const { check, flagSchema, sourceSchema, historySchema, personSchema, repoSchema, refKeyOf } = require('../../projects/validate');
const { withTx } = require('../db');

const J = (v) => JSON.stringify(v);
const P = (t) => JSON.parse(t);

function legacyPersonId(db, options) {
  const configured = typeof options.primaryAgentId === 'function' ? options.primaryAgentId() : options.primaryAgentId;
  const lookup = (agentId) => {
    if (!agentId) return null;
    const row = db.prepare("SELECT id FROM persons WHERE agent_id = ? AND ifnull(subagent_id, '') = ''").get(agentId);
    return row ? row.id : null;
  };
  return lookup(configured) || options.timmyPersonId || lookup('main') || null;
}

function createFacades(db, options = {}) {
  const onInvalid = options.onInvalid || (() => {});
  const personIdForLegacy = () => legacyPersonId(db, options);
  const runtimeReferences = require('../runtime-references').createRuntimeReferences(db);
  const valid = (schema, v, table) => { if (check(schema, v).ok) return true; onInvalid(table); return false; };
  const parseRow = (text, schema, table, connectors) => {
    let v;
    try { v = P(text); if(connectors)v={...v,connectorIds:P(connectors)}; } catch (_) { onInvalid(table); return null; }
    v = mapLegacyActors(v, personIdForLegacy());
    return valid(schema, v, table) ? runtimeReferences.project(v) : null;
  };

  // ---- projects (row = the module's project row) --------------------------------------------
  const hasProvenance=db.prepare('PRAGMA table_info(project_sources)').all().some(row=>row.name==='connector_ids_json');
  const q = {
    rowGet: db.prepare('SELECT * FROM projects WHERE id = ?'),
    turnGet: () => db.prepare('SELECT summary_turn FROM projects WHERE id = ?'),
    turnSet: () => db.prepare('UPDATE projects SET summary_turn = ? WHERE id = ?'),
    rowIds: db.prepare('SELECT id FROM projects ORDER BY rowid'),
    rowUpsert: db.prepare(`INSERT INTO projects (id, name, status, priority, summary, summary_meta_json, last_activity_at, revision, created_at, archived_at)
      VALUES (:id, :name, :status, :priority, :summary, :summary_meta_json, :last_activity_at, :revision, :created_at, :archived_at)
      ON CONFLICT (id) DO UPDATE SET name = excluded.name, status = excluded.status, priority = excluded.priority, summary = excluded.summary,
        summary_meta_json = excluded.summary_meta_json, last_activity_at = excluded.last_activity_at, revision = excluded.revision, archived_at = excluded.archived_at`),
    srcGet: db.prepare('SELECT data_json'+(hasProvenance?', connector_ids_json':'')+' FROM project_sources WHERE project_id = ? ORDER BY rowid'),
    srcDel: db.prepare('DELETE FROM project_sources WHERE project_id = ?'),
    srcIns: db.prepare(hasProvenance?'INSERT INTO project_sources (id, project_id, kind, ref_key, data_json, connector_ids_json) VALUES (?, ?, ?, ?, ?, ?)':'INSERT INTO project_sources (id, project_id, kind, ref_key, data_json) VALUES (?, ?, ?, ?, ?)'),
    flagGet: db.prepare('SELECT data_json FROM project_flags WHERE project_id = ? ORDER BY rowid'),
    flagDel: db.prepare('DELETE FROM project_flags WHERE project_id = ?'),
    flagIns: db.prepare('INSERT INTO project_flags (project_id, kind, key, data_json) VALUES (?, ?, ?, ?)'),
    ovGet: db.prepare('SELECT person_id, role, hidden, added FROM project_people WHERE project_id = ? ORDER BY rowid'),
    ovDel: db.prepare('DELETE FROM project_people WHERE project_id = ?'),
    ovIns: db.prepare('INSERT INTO project_people (project_id, person_id, role, hidden, added) VALUES (?, ?, ?, ?, ?)'),
    evGet: db.prepare('SELECT data_json FROM history_events WHERE project_id = ? ORDER BY rowid'),
    evHas: db.prepare('SELECT 1 FROM history_events WHERE id = ?'),
    evIns: db.prepare('INSERT INTO history_events (id, project_id, at, kind, dedupe_key, data_json) VALUES (?, ?, ?, ?, ?, ?)'),
    perGet: db.prepare('SELECT * FROM persons WHERE id = ?'),
    perAll: db.prepare('SELECT * FROM persons ORDER BY created_at, rowid'),
    // G3b (migration 007): persons.discord_user_id is no longer written; a person's Discord id is a person_identities row
    perUpsert: db.prepare(`INSERT INTO persons (id, kind, name, avatar_url, is_owner, agent_id, subagent_id, git_email_hash, created_at, updated_at)
      VALUES (:id, :kind, :name, :avatar_url, :is_owner, :agent_id, :subagent_id, :git_email_hash, :now, :now)
      ON CONFLICT (id) DO UPDATE SET kind = excluded.kind, name = excluded.name, avatar_url = excluded.avatar_url, is_owner = excluded.is_owner,
        agent_id = excluded.agent_id, subagent_id = excluded.subagent_id,
        git_email_hash = excluded.git_email_hash, updated_at = excluded.updated_at`),
    identGet: db.prepare("SELECT external_id FROM person_identities WHERE person_id = ? AND family = 'discord'"),
    identDel: db.prepare("DELETE FROM person_identities WHERE person_id = ? AND family = 'discord'"),
    identIns: db.prepare("INSERT INTO person_identities (person_id, family, external_id, created_at) VALUES (?, 'discord', ?, ?)"),
    cacheGet: db.prepare('SELECT * FROM repo_cache WHERE owner_repo = ?'),
    cacheUpsert: db.prepare(`INSERT INTO repo_cache (owner_repo, data_json, authors_json, last_attempt_at, last_error) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (owner_repo) DO UPDATE SET data_json = excluded.data_json, authors_json = excluded.authors_json,
        last_attempt_at = excluded.last_attempt_at, last_error = excluded.last_error`),
    cacheDel: db.prepare('DELETE FROM repo_cache WHERE owner_repo = ?'),
    wsGet: db.prepare('SELECT data_json FROM workspace_snapshots WHERE source_id = ?'),
    wsUpsert: db.prepare('INSERT INTO workspace_snapshots (source_id, data_json) VALUES (?, ?) ON CONFLICT (source_id) DO UPDATE SET data_json = excluded.data_json'),
    wsDel: db.prepare('DELETE FROM workspace_snapshots WHERE source_id = ?'),
  };

  const rowOf = (r) => ({ id: r.id, name: r.name, status: r.status, priority: r.priority, summary: r.summary,
    summaryMeta: r.summary_meta_json ? runtimeReferences.project(mapLegacyActors(P(r.summary_meta_json), personIdForLegacy())) : null, lastActivityAt: r.last_activity_at,
    createdAt: r.created_at, revision: r.revision, archivedAt: r.archived_at });
  const rows = {
    get: (id) => { const r = q.rowGet.get(id); return r ? rowOf(r) : undefined; },
    has: (id) => !!q.rowGet.get(id),
    set(id, row) {
      q.rowUpsert.run({ id, name: row.name, status: row.status, priority: row.priority, summary: row.summary,
        summary_meta_json: row.summaryMeta ? J(row.summaryMeta) : null, last_activity_at: row.lastActivityAt,
        revision: row.revision, created_at: row.createdAt, archived_at: row.archivedAt ?? null });
      return rows;
    },
    keys: () => q.rowIds.all().map((r) => r.id)[Symbol.iterator](),
  };

  // per-project lists, replaced whole by the logic (set = delete + insert, in list order)
  const listFacade = (get, del, insert, schema, table) => ({
    get: (id) => { if (!q.rowGet.get(id)) return undefined; return get.all(id).map((r) => parseRow(r.data_json, schema, table, r.connector_ids_json)).filter(Boolean); },
    set(id, list) { del.run(id); for (const x of list) { if (!check(schema, x).ok) throw new Error(table + ' value rejected by its schema'); insert(id, x); } return this; },
  });
  const sources = listFacade(q.srcGet, q.srcDel, (id, s) => q.srcIns.run(s.id, id, s.kind, refKeyOf(s.kind, s.ref), J(s), ...(hasProvenance?[s.connectorIds?J(s.connectorIds):null]:[])), sourceSchema, 'project_sources');
  const flags = listFacade(q.flagGet, q.flagDel, (id, f) => q.flagIns.run(id, f.kind, f.key, J(f)), flagSchema, 'project_flags');
  const overrides = {
    get: (id) => (q.rowGet.get(id) ? q.ovGet.all(id).map((r) => ({ personId: r.person_id, role: r.role, hidden: !!r.hidden, added: !!r.added })) : undefined),
    set(id, list) { q.ovDel.run(id); for (const o of list) q.ovIns.run(id, o.personId, o.role ?? null, o.hidden ? 1 : 0, o.added ? 1 : 0); return this; },
  };
  // append-only: set() inserts the events not stored yet; nothing is ever updated or deleted
  const history = {
    get: (id) => (q.rowGet.get(id) ? q.evGet.all(id).map((r) => parseRow(r.data_json, historySchema, 'history_events')).filter(Boolean) : undefined),
    set(id, list) {
      for (const e of list) {
        if (q.evHas.get(e.id)) continue;
        if (!check(historySchema, e).ok) throw new Error('history event rejected by its schema');
        q.evIns.run(e.id, id, e.at, e.kind, e.dedupeKey ?? null, J(e));
      }
      return this;
    },
  };

  const personOf = (r) => {
    const links = {};
    if (r.agent_id) links.agentId = r.agent_id;
    if (r.subagent_id) links.subagentId = r.subagent_id;
    const discord = q.identGet.get(r.id);
    if (discord) links.discordUserId = discord.external_id;
    if (r.git_email_hash) links.gitEmailHash = r.git_email_hash;
    if (r.is_owner) links.isOwner = true;
    const p = { id: r.id, kind: r.kind, name: r.name, avatarUrl: r.avatar_url, links };
    return valid(personSchema, p, 'persons') ? p : null;
  };
  const persons = {
    get: (id) => { const r = q.perGet.get(id); return r ? personOf(r) || undefined : undefined; },
    has: (id) => !!q.perGet.get(id),
    set(id, p) {
      const l = p.links || {};
      q.perUpsert.run({ id, kind: p.kind, name: p.name, avatar_url: p.avatarUrl ?? null, is_owner: l.isOwner ? 1 : 0, agent_id: l.agentId ?? null,
        subagent_id: l.subagentId ?? null, git_email_hash: l.gitEmailHash ?? null, now: Date.now() });
      const cur = q.identGet.get(id);
      if ((cur ? cur.external_id : null) !== (l.discordUserId ?? null)) {
        q.identDel.run(id);
        if (l.discordUserId) q.identIns.run(id, l.discordUserId, Date.now());
      }
      return persons;
    },
    values: () => q.perAll.all().map(personOf).filter(Boolean)[Symbol.iterator](),
  };

  const caches = {
    get(key) {
      const r = q.cacheGet.get(key); if (!r) return undefined;
      const repo = r.data_json == null ? null : parseRow(r.data_json, repoSchema, 'repo_cache');
      if (r.data_json != null && !repo) return undefined;
      let authors; try { authors = P(r.authors_json); } catch (_) { onInvalid('repo_cache'); return undefined; }
      return { repo, authors, lastAttemptAt: r.last_attempt_at, lastError: r.last_error };
    },
    set(key, v) { q.cacheUpsert.run(key, v.repo ? J(v.repo) : null, J(v.authors || []), v.lastAttemptAt ?? null, v.lastError ?? null); return caches; },
    delete: (key) => q.cacheDel.run(key).changes > 0,
  };
  const workspaces = {
    get: (id) => { const r = q.wsGet.get(id); if (!r) return undefined; try { return P(r.data_json); } catch (_) { onInvalid('workspace_snapshots'); return undefined; } },
    has: (id) => !!q.wsGet.get(id),
    set(id, v) { q.wsUpsert.run(id, J(v)); return workspaces; },
    delete: (id) => q.wsDel.run(id).changes > 0,
  };
  // architect-55: the slugs the agent's tag created a project for (migration 011)
  const tagSlugs = {
    get: (slug) => { const r = db.prepare('SELECT project_id, created_at FROM project_tag_slugs WHERE slug = ?').get(slug); return r ? { projectId: r.project_id, at: r.created_at } : undefined; },
    has: (slug) => !!db.prepare('SELECT 1 FROM project_tag_slugs WHERE slug = ?').get(slug),
    set(slug, v) { db.prepare('INSERT OR IGNORE INTO project_tag_slugs (slug, project_id, created_at) VALUES (?, ?, ?)').run(slug, v.projectId, v.at); return tagSlugs; },
  };
  const summaryTurns = {
    get: id => q.turnGet().get(id)?.summary_turn || null,
    set(id, turnId) { q.turnSet().run(turnId, id); return this; },
    delete: id => q.turnSet().run(null, id).changes > 0,
  };
  return { rows, sources, flags, overrides, history, persons, caches, workspaces, tagSlugs, summaryTurns };
}

class SqlProjectsRepository extends MemoryRepository {
  _captureSourceProvenance(id,previous,next) {
    // Automatic annotation must preserve every raw row, including rows the
    // read facade quarantines. This runs inside capture's existing transaction.
    const hasColumn=this.db.prepare('PRAGMA table_info(project_sources)').all().some(row=>row.name==='connector_ids_json');
    if(!hasColumn)return false; // pre-030 repository readers remain compatible
    const update=this.db.prepare("UPDATE project_sources SET connector_ids_json=? WHERE id=? AND project_id=? AND kind='sessionGroup'");
    for(let n=0;n<next.length;n++)if(next[n]!==previous[n])update.run(J(next[n].connectorIds),next[n].id,id);
  }
  constructor(db, options = {}) {
    super(Object.assign({}, options, { persons: [] }));
    this.db = db;
    Object.assign(this, createFacades(db, options));
    this.sessionSnaps = new Map();       // session data: not stored (rebuilt from the engine)
    withTx(db, () => { for (const person of options.persons || []) this.upsertPerson(person); });
  }
}

// One transaction per public call: a command that throws (409, validation) writes nothing.
for (const name of REPOSITORY_METHODS) {
  const base = MemoryRepository.prototype[name];
  if (typeof base !== 'function') throw new Error('repository method missing: ' + name);
  SqlProjectsRepository.prototype[name] = function (...args) { return withTx(this.db, () => base.apply(this, args)); };
}

function createProjectsRepository(db, options) { return new SqlProjectsRepository(db, options); }

module.exports = { createProjectsRepository, SqlProjectsRepository, createFacades };
