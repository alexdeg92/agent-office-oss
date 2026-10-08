'use strict';

const crypto = require('node:crypto');
const { ProjectError } = require('../errors');
const { authorHint } = require('../email');
const { parseGithubRef, stripRemoteCredentials } = require('./refs');
const { SOURCE_ERROR_CATEGORIES } = require('../constants');

const HTTPS = /^https:\/\/\S+$/;

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

function firstLine(message) {
  return String(message || '').split(/\r?\n/)[0].trim().slice(0, 200);
}

function runsOnBranch(runsPayload, branch) {
  const runs = runsPayload && Array.isArray(runsPayload.workflow_runs) ? runsPayload.workflow_runs : [];
  if (!branch) return runs;
  return runs.filter((run) => !run || !run.head_branch || run.head_branch === branch);
}

function mapCi(runsPayload, branch) {
  const run = runsOnBranch(runsPayload, branch)[0] || null;
  if (!run) return { state: 'none', at: null, url: null };
  const at = Date.parse(run.updated_at || run.created_at || '');
  const when = Number.isInteger(at) ? at : null;
  const rawUrl = typeof run.html_url === 'string' ? stripRemoteCredentials(run.html_url) : '';
  const url = rawUrl.startsWith('https://') ? rawUrl : null;
  const status = run.status;
  const conclusion = run.conclusion;
  if (status === 'queued' || status === 'in_progress' || status === 'waiting' || status === 'pending' || status === 'requested') {
    return { state: 'running', at: when, url };
  }
  if (conclusion === 'success') return { state: 'passing', at: when, url };
  if (conclusion === 'failure' || conclusion === 'cancelled' || conclusion === 'timed_out' || conclusion === 'startup_failure' || conclusion === 'action_required') {
    return { state: 'failing', at: when, url };
  }
  if (conclusion === 'skipped' || conclusion === 'neutral') return { state: 'none', at: when, url };
  if (conclusion == null && status == null) return { state: 'none', at: when, url };
  return { state: 'unrecognized', at: when, url };
}

function mapCommit(row) {
  const sha = row && (row.sha || '');
  const commit = row && row.commit;
  const at = Date.parse(commit && commit.author && commit.author.date || '');
  if (!/^[a-f0-9]{7,64}$/.test(sha) || !Number.isInteger(at)) return null;
  const gitAuthor = commit.author || {};
  const login = row.author && row.author.login;
  const hint = authorHint(gitAuthor.name || login, gitAuthor.email);
  return {
    sha,
    at,
    message: firstLine(commit.message),
    author: { name: hint.name, personId: null },
    hint,
  };
}

function httpsOnly(value) {
  if (typeof value !== 'string' || !value) return null;
  const clean = stripRemoteCredentials(value);
  return typeof clean === 'string' && HTTPS.test(clean) ? clean : null;
}

function customPreview(meta) {
  if (!meta || typeof meta !== 'object') return null;
  return httpsOnly(meta.openGraphImageUrl) || httpsOnly(meta.open_graph_image_url) || httpsOnly(meta.social_preview_url);
}

/** Cache-buster for the public OpenGraph URL. Stable until `node_id` or the repo stamp changes. */
function ogCacheHash(meta, owner, name) {
  const id = meta && typeof meta.node_id === 'string' && meta.node_id ? meta.node_id : `${owner}/${name}`;
  const stamp = meta && typeof meta.updated_at === 'string' ? meta.updated_at
    : meta && typeof meta.pushed_at === 'string' ? meta.pushed_at : '';
  return crypto.createHash('sha256').update(`${id}\n${stamp}`).digest('hex').slice(0, 16);
}

function repoImage(meta, owner, name) {
  const custom = customPreview(meta);
  if (custom) return { kind: 'opengraph', url: custom };
  const url = `https://opengraph.githubassets.com/${ogCacheHash(meta, owner, name)}/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
  if (!HTTPS.test(url)) return null;
  return { kind: 'opengraph', url };
}

function topicsOf(meta) {
  const raw = meta && Array.isArray(meta.topics) ? meta.topics : [];
  const out = [];
  for (const topic of raw) {
    if (typeof topic !== 'string') continue;
    const slug = topic.trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9-]{0,49}$/.test(slug) || out.includes(slug)) continue;
    out.push(slug);
    if (out.length === 20) break;
  }
  return out;
}

/**
 * Turn recorded `gh api` payloads into a Repo plus author hints.
 * The image is the GitHub card only: a custom social preview when `gh` returns one, otherwise
 * the public OpenGraph URL. A live-site screenshot is applied later by the repo refresh.
 * The bytes are not fetched here.
 */
function repoFromPayloads({ meta, commits, runs, fetchedAt }) {
  const owner = meta && meta.owner && meta.owner.login;
  const name = meta && meta.name;
  const branch = meta && meta.default_branch;
  const url = meta && meta.html_url ? stripRemoteCredentials(meta.html_url) : meta && meta.html_url;
  if (!owner || !name || !branch || typeof url !== 'string' || !url.startsWith('https://')) {
    throw new ProjectError('upstream_failed', 'GitHub a renvoyé un dépôt incomplet.');
  }
  const image = repoImage(meta, owner, name);
  if (!image) throw new ProjectError('upstream_failed', 'GitHub a renvoyé un dépôt incomplet.');
  const mapped = (Array.isArray(commits) ? commits : []).map(mapCommit).filter(Boolean).slice(0, 10);
  return {
    repo: {
      url,
      owner,
      name,
      defaultBranch: branch,
      image,
      ci: mapCi(runs, branch),
      commits: mapped.map(({ sha, at, message, author }) => ({ sha, at, message, author })),
      fetchedAt,
      archived: Boolean(meta.archived),
      homepage: httpsOnly(meta.homepage),
      topics: topicsOf(meta),
    },
    authors: mapped.map((c) => c.hint),
  };
}

function classifyGh(stdout, stderr) {
  const text = `${stdout || ''}\n${stderr || ''}`;
  let category = 'error';
  if (/rate limit|HTTP 429|secondary rate/i.test(text)) category = 'rate-limited';
  else if (/timed? ?out|ETIMEDOUT/i.test(text)) category = 'timeout';
  else if (/\b404\b|not found/i.test(text)) category = 'not-found';
  else if (/ECONNREFUSED/i.test(text)) category = 'connection-refused';
  else if (/ECONNRESET|socket closed/i.test(text)) category = 'connection-closed';
  else if (/EACCES|EPERM|permission denied/i.test(text)) category = 'permission-denied';
  else if (/not valid json|invalid json|unexpected token/i.test(text)) category = 'invalid-json';
  return SOURCE_ERROR_CATEGORIES.includes(category) ? category : 'error';
}

async function runGh(exec, args) {
  let result;
  try {
    result = await exec(args);
  } catch {
    throw new ProjectError('upstream_failed', 'GitHub est indisponible.', { category: 'error' });
  }
  if (!result || result.code !== 0) {
    throw new ProjectError('upstream_failed', 'GitHub est indisponible.', {
      category: classifyGh(result && result.stdout, result && result.stderr),
    });
  }
  try {
    return parseJson(result.stdout);
  } catch (err) {
    if (err instanceof ProjectError && !err.category) err.category = 'invalid-json';
    throw err;
  }
}

function createGithubSource({ exec, owners } = {}) {
  if (typeof exec !== 'function') throw new ProjectError('internal', 'La source GitHub n’a pas d’exécuteur.');
  return {
    id: 'github',
    kind: 'github',
    parseRef(input) {
      return { kind: 'github', ref: parseGithubRef(input && (input.ref || input), owners) };
    },
    webUrl(ref) {
      return `https://github.com/${ref.owner}/${ref.repo}`;
    },
    openGraphUrl(ref, stamp) {
      return `https://opengraph.githubassets.com/${stamp}/${ref.owner}/${ref.repo}`;
    },
    async fetch(ref, { fetchedAt } = {}) {
      const parsed = parseGithubRef(ref, owners);
      const base = `repos/${parsed.owner}/${parsed.repo}`;
      const meta = await runGh(exec, ['gh', 'api', base]);
      const branch = meta && typeof meta.default_branch === 'string' ? encodeURIComponent(meta.default_branch) : '';
      if (!branch) throw new ProjectError('upstream_failed', 'GitHub a renvoyé un dépôt incomplet.');
      const commits = await runGh(exec, ['gh', 'api', `${base}/commits?sha=${branch}&per_page=10`]);
      const runs = await runGh(exec, ['gh', 'api', `${base}/actions/runs?branch=${branch}&per_page=1`]);
      const at = fetchedAt ?? Date.now();
      return repoFromPayloads({ meta, commits, runs, fetchedAt: at });
    },
  };
}

module.exports = { createGithubSource, repoFromPayloads, mapCi, parseJson, classifyGh, ogCacheHash };
