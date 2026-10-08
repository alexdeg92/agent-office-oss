'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { ProjectError } = require('./errors');
const { DEFAULT_IGNORE_DIR_NAMES, STALE_AFTER_DAYS } = require('./constants');
const { resolveInside, assertGitContained, scrubGitEnv, stripRemoteCredentials } = require('./sources/refs');
const { workspaceRef } = require('./roots');

const DAY_MS = 24 * 60 * 60 * 1000;
const SHIPPED_AFTER_DAYS = 180;
const STOP_SLUGS = new Set(['main', 'test', 'tmp', 'src', 'app', 'web', 'www', 'git', 'repo']);

const LABEL_RULES = [
  { key: 'client', portableKey: 'client', label: 'client', labelKey: 'candidateLabel.client', re: /\b(client|clients|customer|contrat)\b/i, topics: ['client', 'customer'] },
  { key: 'perso', portableKey: 'personal', label: 'perso', labelKey: 'candidateLabel.personal', re: /\b(perso|personnel|personal|hobby)\b/i, topics: ['personal', 'perso', 'hobby'] },
  { key: 'site-web', portableKey: 'website', label: 'site web', labelKey: 'candidateLabel.website', re: /\b(site web|website|homepage|blog)\b/i, topics: ['website', 'blog', 'homepage'] },
];

const TAG_STATUSES = new Set(require('./constants').PROJECT_STATUSES);
const TAG_PRIORITIES = new Set(require('./constants').PRIORITIES);

function looseSlug(value) {
  return String(value || '')
    .normalize('NFD').replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function similarSlug(a, b) {
  if (!a || !b || a.length < 3 || b.length < 3) return false;
  if (STOP_SLUGS.has(a) || STOP_SLUGS.has(b)) return false;
  const strip = (s) => s.replace(/-(web|app|site|repo)$/, '');
  const left = strip(a);
  const right = strip(b);
  return left.length >= 3 && left === right;
}

function githubFromRemote(url) {
  if (typeof url !== 'string') return null;
  const text = stripRemoteCredentials(url).trim().replace(/\.git$/, '');
  const ssh = /^git@github\.com:([^/\s]+)\/([^/\s]+)$/i.exec(text);
  const https = /^https:\/\/github\.com\/([^/\s]+)\/([^/\s]+)$/i.exec(text);
  const match = ssh || https;
  if (!match) return null;
  if (!/^[A-Za-z0-9._-]+$/.test(match[1]) || !/^[A-Za-z0-9._-]+$/.test(match[2])) return null;
  return { owner: match[1], repo: match[2] };
}

function remoteHost(url) {
  if (typeof url !== 'string') return '';
  const text = stripRemoteCredentials(url).trim();
  const ssh = /^git@([^:\s]+):/i.exec(text);
  if (ssh) return ssh[1].toLowerCase();
  try { return new URL(text).hostname.toLowerCase(); } catch { return ''; }
}

/** GitLab and Gitea remotes are recognised and reported, never fetched. */
function unsupportedHost(url) {
  const host = remoteHost(url);
  if (!host || host === 'github.com' || host.endsWith('.github.com')) return null;
  if (host === 'gitlab.com' || host.endsWith('.gitlab.com')) return 'gitlab';
  if (host === 'gitea.com' || host === 'gitea.io' || host.endsWith('.gitea.io')) return 'gitea';
  return null;
}

function parseJson(stdout) {
  const text = String(stdout ?? '');
  const start = text.search(/[[{]/);
  if (start < 0) throw new ProjectError('upstream_failed', 'GitHub a renvoyé une réponse illisible.');
  try {
    return JSON.parse(text.slice(start));
  } catch {
    throw new ProjectError('upstream_failed', 'GitHub a renvoyé une réponse illisible.');
  }
}

function suggestLabels({ description = '', topics = [], portability = false } = {}) {
  const topicSet = new Set(topics.map((t) => String(t).toLowerCase()));
  const labels = [];
  for (const rule of LABEL_RULES) {
    if (rule.topics.some((t) => topicSet.has(t)) || rule.re.test(description)) {
      labels.push(portability
        ? { key: rule.portableKey, label: { key: rule.labelKey } }
        : { key: rule.key, label: rule.label });
    }
  }
  return labels;
}

function reason(portability, key, params, french) {
  if (!portability) return french;
  return params ? { key, params } : { key };
}

function suggestStatus({ now, lastActivityAt, archived, recentDays = STALE_AFTER_DAYS, shippedDays = SHIPPED_AFTER_DAYS, portability = false }) {
  if (archived) {
    return { status: 'shipped', confidence: 'high', statusBecause: 'github-archived', reason: reason(portability, 'candidateReason.github-archived', null, 'Le dépôt GitHub est archivé.') };
  }
  if (!Number.isInteger(lastActivityAt)) {
    return { status: 'idea', confidence: 'low', statusBecause: 'no-activity', reason: reason(portability, 'candidateReason.no-activity', null, 'Aucune activité connue.') };
  }
  const age = now - lastActivityAt;
  if (age <= recentDays * DAY_MS) {
    return {
      status: 'in-progress', confidence: 'high', statusBecause: 'recent-activity',
      reason: reason(portability, 'candidateReason.recent-activity', { n: recentDays }, `Activité dans les ${recentDays} derniers jours.`),
    };
  }
  if (age >= shippedDays * DAY_MS) {
    return {
      status: 'todo', confidence: 'low', statusBecause: 'inactive-long',
      reason: reason(portability, 'candidateReason.inactive-long', { n: shippedDays }, `Aucune activité depuis ${shippedDays} jours, sans signe de livraison.`),
    };
  }
  return { status: 'todo', confidence: 'medium', statusBecause: 'stale', reason: reason(portability, 'candidateReason.stale', null, 'Pas d’activité récente.') };
}

function ignoreSet(names) {
  const list = names == null ? DEFAULT_IGNORE_DIR_NAMES : names;
  return new Set(list.map((name) => String(name).toLowerCase()));
}

function isIgnoredPath(rel, names) {
  const skip = ignoreSet(names);
  return String(rel || '').split('/').some((part) => skip.has(part.toLowerCase()));
}

function boundedText(value, max) {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > max) return '';
  return trimmed;
}

function groupRefOf(groupId, name) {
  const id = boundedText(groupId, 200);
  const label = boundedText(name, 200) || id;
  if (!id || !label) return null;
  return { by: 'group', groupId: id, name: label };
}

function keysRefOf(keys) {
  const unique = [...new Set((keys || []).filter((k) => typeof k === 'string' && k.length > 0 && k.length <= 200))].slice(0, 100);
  if (!unique.length) return null;
  return { by: 'keys', sessionKeys: unique };
}

function collectSessionKeys(group) {
  const keys = [];
  if (Array.isArray(group.sessionKeys)) keys.push(...group.sessionKeys);
  if (Array.isArray(group.sessions)) {
    for (const session of group.sessions) {
      if (typeof session === 'string') keys.push(session);
      else if (session && typeof session.key === 'string') keys.push(session.key);
      else if (session && typeof session.sessionKey === 'string') keys.push(session.sessionKey);
    }
  }
  if (typeof group.key === 'string') keys.push(group.key);
  return keys;
}

function normalizeSessionGroup(group) {
  if (!group || typeof group !== 'object') return null;
  let ref = null;
  if (group.ref && group.ref.by === 'group') {
    ref = groupRefOf(group.ref.groupId, group.ref.name || group.name);
  } else if (group.ref && group.ref.by === 'keys' && Array.isArray(group.ref.sessionKeys)) {
    ref = keysRefOf(group.ref.sessionKeys);
  } else if (group.ref && group.ref.by === 'interlocutor' && typeof group.ref.interlocutorId === 'string') {
    ref = { by: 'interlocutor', interlocutorId: group.ref.interlocutorId };
  } else if (group.groupId || group.id || group.name || group.displayName) {
    const id = group.groupId || group.id || group.name || group.displayName;
    const label = group.name || group.displayName || id;
    ref = groupRefOf(id, label);
  } else if (typeof group.interlocutorId === 'string' && group.interlocutorId) {
    ref = { by: 'interlocutor', interlocutorId: group.interlocutorId };
  } else {
    ref = keysRefOf(collectSessionKeys(group));
  }
  const name = group.name || group.slug || group.displayName || (ref && (ref.name || ref.interlocutorId)) || '';
  const slug = looseSlug(group.slug || group.name || name);
  if (!ref && slug) ref = groupRefOf(group.groupId || group.id || slug, name || slug);
  if (!ref || (ref.by === 'keys' && ref.sessionKeys.length === 0)) return null;
  let lastActivityAt = null;
  if (Number.isInteger(group.lastActivityAt)) lastActivityAt = group.lastActivityAt;
  else if (typeof group.lastActivityAt === 'string') {
    const parsed = Date.parse(group.lastActivityAt);
    if (Number.isInteger(parsed)) lastActivityAt = parsed;
  }
  // architect-54: a project tag's status (the agent said where the project stands) wins over the activity-based guess
  const statusHint = TAG_STATUSES.has(group.statusHint) ? group.statusHint : null;
  const priorityHint = TAG_PRIORITIES.has(group.priorityHint) ? group.priorityHint : null;
  return { name: name || slug, slug, lastActivityAt, ref, statusHint, priorityHint };
}

function foldTarget(slug, buckets) {
  let best = null;
  for (const bucket of buckets) {
    if (!bucket.slug || bucket.slug.length < 3 || STOP_SLUGS.has(bucket.slug)) continue;
    if (slug !== bucket.slug && !slug.startsWith(`${bucket.slug}-`)) continue;
    if (!best || bucket.slug.length > best.slug.length) best = bucket;
  }
  return best;
}

function maxAt(a, b) {
  if (!Number.isInteger(a)) return Number.isInteger(b) ? b : null;
  if (!Number.isInteger(b)) return a;
  return Math.max(a, b);
}

function displayName(value) {
  const name = String(value || '').trim().slice(0, 80);
  return name || 'Sans nom';
}

/**
 * Pure merge. A workspace joins a GitHub repo when its remote URL is that
 * repo. A session group joins when its name or slug is similar to exactly
 * one repo (or one workspace folder, if it did not match two buckets).
 */
function proposeCandidates({
  now,
  github = [],
  workspaces = [],
  sessionGroups = [],
  owners = [],
  workspaceRootIds = false,
  portability = false,
  locale = 'fr',
  ignoreNames,
  recentDays,
  shippedDays,
} = {}) {
  const allow = new Set((owners || []).map((o) => o.toLowerCase()));
  const buckets = [];
  const notices = [];
  const seenNotice = new Set();
  const noteUnsupported = (url) => {
    const host = unsupportedHost(url);
    if (!host) return;
    const remote = stripRemoteCredentials(String(url)).trim();
    const id = `${host}\n${remote}`;
    if (seenNotice.has(id)) return;
    seenNotice.add(id);
    notices.push({ host, remote, issue: 'not-supported', key: 'candidateNotice.host-not-supported' });
  };
  const workspaceKey = (folder) => (workspaceRootIds ? `ws:${folder.rootId}/${folder.path}` : `ws:${folder.path}`);
  const crossesRoot = (bucket, folder) => workspaceRootIds && bucket.sources.some((source) => (
    source.kind === 'workspace' && source.ref.rootId && source.ref.rootId !== folder.rootId
  ));

  for (const repo of github) {
    if (!repo || !repo.owner || !repo.repo) continue;
    if (!allow.has(String(repo.owner).toLowerCase())) continue;
    const pushed = Date.parse(repo.pushedAt || '');
    buckets.push({
      key: `gh:${repo.owner}/${repo.repo}`.toLowerCase(),
      name: displayName(repo.name || repo.repo),
      summary: String(repo.description || '').slice(0, 4000),
      description: String(repo.description || ''),
      topics: Array.isArray(repo.topics) ? repo.topics : [],
      archived: Boolean(repo.archived),
      lastActivityAt: Number.isInteger(pushed) ? pushed : null,
      slug: looseSlug(repo.repo),
      sources: [{ kind: 'github', ref: { owner: repo.owner, repo: repo.repo } }],
      merged: [],
    });
  }

  const consumedWs = new Set();
  const folders = workspaces
    .filter((folder) => folder && folder.path && !isIgnoredPath(folder.path, ignoreNames))
    .map((folder) => ({
      ...folder,
      remote: folder.remote ? (stripRemoteCredentials(String(folder.remote)).trim() || null) : folder.remote,
    }));
  const attachFolder = (bucket, folder, how) => {
    bucket.sources.push({ kind: 'workspace', ref: workspaceRef(folder, { workspaceRootIds }) });
    bucket.merged.push(how);
    bucket.lastActivityAt = maxAt(bucket.lastActivityAt, folder.lastCommitAt);
    consumedWs.add(folder);
  };
  for (const folder of folders) {
    if (folder && folder.remote) noteUnsupported(folder.remote);
    const remote = githubFromRemote(folder.remote);
    if (remote && allow.size && !allow.has(remote.owner.toLowerCase())) {
      consumedWs.add(folder);
      continue;
    }
    if (!remote) continue;
    const key = `gh:${remote.owner}/${remote.repo}`.toLowerCase();
    const hit = buckets.find((b) => b.key === key);
    if (!hit) continue;
    attachFolder(hit, folder, 'remote-url');
  }
  const byRemote = new Map();
  for (const folder of folders) {
    if (consumedWs.has(folder) || !folder.remote) continue;
    const remote = githubFromRemote(folder.remote);
    const key = remote ? `gh:${remote.owner}/${remote.repo}`.toLowerCase() : `remote:${String(folder.remote).trim()}`;
    if (!byRemote.has(key)) byRemote.set(key, []);
    byRemote.get(key).push(folder);
  }
  for (const [key, group] of byRemote) {
    const remote = githubFromRemote(group[0].remote);
    const base = remote ? remote.repo : path.posix.basename(group[0].path);
    const slug = looseSlug(base);
    let bucket = buckets.find((b) => b.slug === slug && b.sources.some((s) => s.kind !== 'sessionGroup'));
    if (!bucket) {
      bucket = {
        key: remote ? key : workspaceKey(group[0]),
        name: displayName(base),
        summary: '',
        description: '',
        topics: [],
        archived: false,
        lastActivityAt: null,
        slug,
        sources: [],
        merged: [],
      };
      buckets.push(bucket);
    }
    for (const folder of group) {
      if (consumedWs.has(folder)) continue;
      attachFolder(bucket, folder, 'remote-url');
    }
  }
  const loose = folders.filter((folder) => !consumedWs.has(folder))
    .sort((a, b) => looseSlug(path.posix.basename(a.path)).length - looseSlug(path.posix.basename(b.path)).length
      || a.path.localeCompare(b.path));
  for (const folder of loose) {
    const base = path.posix.basename(folder.path);
    const slug = looseSlug(base);
    let parent = foldTarget(slug, buckets);
    if (parent && crossesRoot(parent, folder)) parent = null;
    if (parent && parent.slug !== slug) {
      attachFolder(parent, folder, 'name-prefix');
      continue;
    }
    if (parent && parent.slug === slug) {
      attachFolder(parent, folder, 'name');
      continue;
    }
    buckets.push({
      key: workspaceKey(folder),
      name: displayName(base),
      summary: '',
      description: '',
      topics: [],
      archived: false,
      lastActivityAt: Number.isInteger(folder.lastCommitAt) ? folder.lastCommitAt : null,
      slug,
      sources: [{ kind: 'workspace', ref: workspaceRef(folder, { workspaceRootIds }) }],
      merged: [],
    });
    consumedWs.add(folder);
  }

  const groups = sessionGroups.map(normalizeSessionGroup).filter(Boolean);
  const consumedSg = new Set();
  for (const group of groups) {
    const slugs = [looseSlug(group.name), group.slug].filter(Boolean);
    const hits = buckets.filter((b) => slugs.some((slug) => similarSlug(slug, b.slug)));
    if (hits.length !== 1) continue;
    hits[0].sources.push({ kind: 'sessionGroup', ref: group.ref });
    hits[0].merged.push('session-slug');
    if (group.statusHint) hits[0].statusHint = group.statusHint;
    if (group.priorityHint) hits[0].priorityHint = group.priorityHint;
    hits[0].lastActivityAt = maxAt(hits[0].lastActivityAt, group.lastActivityAt);
    consumedSg.add(group);
  }
  for (const group of groups) {
    if (consumedSg.has(group)) continue;
    const name = displayName(group.name || group.slug);
    const slug = group.slug || looseSlug(name) || 'groupe';
    const refBit = group.ref.by === 'group'
      ? `group:${group.ref.groupId}`
      : (group.ref.interlocutorId || (group.ref.sessionKeys && group.ref.sessionKeys[0]) || slug);
    buckets.push({
      key: group.ref.by === 'group' ? `sg:group:${group.ref.groupId}` : `sg:${slug}:${refBit}`,
      name,
      summary: '',
      description: '',
      topics: [],
      archived: false,
      lastActivityAt: group.lastActivityAt,
      slug,
      sources: [{ kind: 'sessionGroup', ref: group.ref }],
      merged: [],
      statusHint: group.statusHint || null,
      priorityHint: group.priorityHint || null,
    });
  }

  const candidates = buckets.map((b) => {
    const suggested = b.statusHint
      ? { status: b.statusHint, confidence: 'high', statusBecause: 'agent-tag', reason: reason(portability, 'candidateReason.agent-tag', null, 'Indiqué par l’agent (étiquette projet).') }
      : suggestStatus({ now, lastActivityAt: b.lastActivityAt, archived: b.archived, recentDays, shippedDays, portability });
    return {
      key: b.key,
      name: b.name,
      summary: b.summary,
      status: suggested.status,
      confidence: suggested.confidence,
      statusBecause: suggested.statusBecause,
      reason: suggested.reason,
      labels: suggestLabels({ description: b.description, topics: b.topics, portability }),
      lastActivityAt: b.lastActivityAt,
      sources: b.sources,
      merged: b.merged,
      ...(b.priorityHint ? { priority: b.priorityHint } : {}),   // architect-54: used by the import (not shown in the VM)
    };
  });
  candidates.sort((a, b) => {
    const at = (b.lastActivityAt || 0) - (a.lastActivityAt || 0);
    if (at) return at;
    return a.name.localeCompare(b.name, locale) || (a.key < b.key ? -1 : 1);
  });
  candidates.notices = notices;
  return candidates;
}

async function runExec(exec, argv) {
  let result;
  try {
    result = await exec(argv);
  } catch {
    throw new ProjectError('upstream_failed', 'GitHub est indisponible.');
  }
  if (!result || result.code !== 0) throw new ProjectError('upstream_failed', 'GitHub est indisponible.');
  return result.stdout;
}

async function collectGithubRepos({ exec, owner, limit = 100 }) {
  const stdout = await runExec(exec, [
    'gh', 'repo', 'list', owner, '--limit', String(limit),
    '--json', 'name,description,url,isArchived,pushedAt,repositoryTopics',
  ]);
  const rows = parseJson(stdout);
  if (!Array.isArray(rows)) throw new ProjectError('upstream_failed', 'GitHub a renvoyé une réponse illisible.');
  return rows.map((row) => {
    const fromUrl = githubFromRemote(row.url);
    return {
      owner: (fromUrl && fromUrl.owner) || owner,
      repo: row.name,
      name: row.name,
      description: row.description || '',
      archived: Boolean(row.isArchived),
      pushedAt: row.pushedAt || null,
      topics: Array.isArray(row.repositoryTopics) ? row.repositoryTopics.map((t) => t && t.name).filter(Boolean) : [],
    };
  }).filter((row) => row.repo);
}

function listGitDirs(root, ignoreNames) {
  const found = [];
  const skip = new Set(['.git', 'node_modules', ...ignoreSet(ignoreNames)]);
  function walk(abs, rel, depth) {
    if (depth > 2) return;
    let entries;
    try {
      entries = fs.readdirSync(abs, { withFileTypes: true });
    } catch {
      return;
    }
    if (rel && entries.some((e) => e.name === '.git')) {
      found.push(rel.split(path.sep).join('/'));
      return;
    }
    for (const ent of entries) {
      if (!ent.isDirectory() || skip.has(ent.name.toLowerCase()) || ent.name.startsWith('.')) continue;
      walk(path.join(abs, ent.name), rel ? path.join(rel, ent.name) : ent.name, depth + 1);
    }
  }
  walk(path.resolve(root), '', 0);
  return found.sort();
}

async function collectWorkspaceFolders({ root, exec, listDirs = listGitDirs, ignoreNames, rootId }) {
  const dirs = await listDirs(root, ignoreNames);
  const folders = [];
  for (const rel of dirs) {
    if (isIgnoredPath(rel, ignoreNames)) continue;
    let abs;
    try {
      abs = resolveInside(root, rel).abs;
    } catch {
      continue;
    }
    try {
      assertGitContained(root, abs);
    } catch {
      continue;
    }
    let remote = null;
    let lastCommitAt = null;
    try {
      const remoteRun = await exec(['git', '-C', abs, 'remote', 'get-url', 'origin'], scrubGitEnv(process.env));
      if (remoteRun && remoteRun.code === 0) {
        remote = stripRemoteCredentials(String(remoteRun.stdout || '')).trim() || null;
      }
    } catch { /* keep going; one folder must not abort the scan */ }
    try {
      const logRun = await exec(['git', '-C', abs, 'log', '-1', '--format=%aI'], scrubGitEnv(process.env));
      if (logRun && logRun.code === 0) {
        const at = Date.parse(String(logRun.stdout || '').trim());
        if (Number.isInteger(at)) lastCommitAt = at;
      }
    } catch { /* same */ }
    const folder = { path: rel, remote, lastCommitAt };
    if (rootId) folder.rootId = rootId;
    folders.push(folder);
  }
  return folders;
}

const { STATUS_LABELS, confidenceText } = require('./labels');

function formatTable(candidates, { portability = false } = {}) {
  const header = portability
    ? ['candidate.column.name', 'candidate.column.status', 'candidate.column.confidence', 'candidate.column.reason', 'candidate.column.sources']
    : ['Nom', 'Statut suggéré', 'Confiance', 'Raison', 'Sources'];
  const cell = (value) => (value && typeof value === 'object' && value.key ? value.key : String(value ?? ''));
  const rows = candidates.map((c) => [
    c.name,
    portability ? `projectStatus.${c.status}` : (STATUS_LABELS[c.status] || c.status),
    portability ? `confidence.${c.confidence}` : confidenceText(c.confidence),
    cell(c.reason) || '—',
    c.sources.map((s) => {
      if (s.kind === 'github') return `${s.ref.owner}/${s.ref.repo}`;
      if (s.kind === 'workspace') return s.ref.rootId ? `${s.ref.rootId}/${s.ref.path}` : s.ref.path;
      if (s.kind === 'sessionGroup') {
        if (s.ref.by === 'group') return s.ref.name;
        if (s.ref.by === 'interlocutor') return s.ref.interlocutorId;
        return 'sessions';
      }
      return s.kind;
    }).join(' · ') || '—',
  ]);
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const line = (cells) => cells.map((cell, i) => cell.padEnd(widths[i])).join('  ').trimEnd();
  const table = [
    portability ? `candidate.heading (${candidates.length})` : `Candidats (${candidates.length})`,
    '',
    line(header),
    line(widths.map((w) => '-'.repeat(w))),
    ...rows.map(line),
    '',
  ].join('\n');
  const notes = (candidates.notices || []).map((notice) => `${notice.key} ${notice.host}`);
  return notes.length ? `${table}${notes.join('\n')}\n` : table;
}

module.exports = {
  looseSlug, similarSlug, githubFromRemote, suggestLabels, suggestStatus, normalizeSessionGroup,
  proposeCandidates, isIgnoredPath,
  collectGithubRepos, collectWorkspaceFolders, listGitDirs, formatTable, confidenceText,
  SHIPPED_AFTER_DAYS, DAY_MS,
};
