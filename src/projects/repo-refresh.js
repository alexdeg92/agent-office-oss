'use strict';

const { SOURCE_ERROR_CATEGORIES } = require('./constants');
const { ProjectError } = require('./errors');
const { capturePublicSite, SCREENSHOT_FRESH_MS } = require('./screenshot');

/** data-model §9.3: one fetch per linked repo every 10 minutes. */
const REPO_FRESH_MS = 10 * 60 * 1000;
const BACKOFF_MAX_MS = 60 * 60 * 1000;
const BACKOFF_BASE_MS = Object.freeze({
  'rate-limited': 15 * 60 * 1000,
  timeout: 2 * 60 * 1000,
});
const DEFAULT_BACKOFF_MS = 60 * 1000;

function backoffMs(category, streak) {
  const base = BACKOFF_BASE_MS[category] || DEFAULT_BACKOFF_MS;
  const steps = Math.min(Math.max(0, streak | 0), 5);
  return Math.min(base * (2 ** steps), BACKOFF_MAX_MS);
}

function cacheKey(owner, name) {
  return `${String(owner).toLowerCase()}/${String(name).toLowerCase()}`;
}

function viewOf(repository, owner, name) {
  const project = repository.findActiveByGithub(owner, name);
  if (!project) return { project: null, repo: null, lastError: null, lastAttemptAt: null };
  const status = project.repoStatus || {};
  return {
    project,
    repo: project.repo,
    lastError: status.lastError || null,
    lastAttemptAt: status.lastAttemptAt ?? null,
  };
}

/**
 * Refresh one linked repo through an injected GitHub source.
 * One fetch is in flight per owner/repo. A fresh cache is left alone for 10 minutes.
 * A failed `gh` waits out a backoff (longer for rate limits) before the next try.
 * Success is written with `putRepoCache`, then commit history (`commit:<sha>`) and `applyProjectRisks`.
 */
function createRepoRefresh({ source, capture, resolve, now = () => Date.now() } = {}) {
  if (!source || typeof source.fetch !== 'function') {
    throw new ProjectError('internal', 'La source GitHub n’a pas de fetch.');
  }
  const inflight = new Map();
  const streaks = new Map();
  const shots = new Map();

  function gateOf(view, key, at) {
    if (view.lastError) {
      const remembered = streaks.get(key);
      const category = remembered ? remembered.category : view.lastError;
      const streak = remembered ? remembered.n : 0;
      if (Number.isInteger(view.lastAttemptAt)) {
        const until = view.lastAttemptAt + backoffMs(category, streak);
        if (at < until) return { status: 'backoff', category, until };
      }
    }
    const fetchedAt = view.repo && view.repo.fetchedAt;
    if (!view.lastError && Number.isInteger(fetchedAt) && at < fetchedAt + REPO_FRESH_MS) {
      return { status: 'fresh', until: fetchedAt + REPO_FRESH_MS };
    }
    return { status: 'fetch' };
  }

  async function applyScreenshot(snap, previous, key, when) {
    const homepage = snap.repo.homepage;
    const prevImage = previous.repo && previous.repo.image;
    const remembered = shots.get(key);
    const samePage = previous.repo && previous.repo.homepage === homepage;
    if (prevImage && prevImage.kind === 'screenshot' && samePage && remembered
      && remembered.homepage === homepage && when < remembered.at + SCREENSHOT_FRESH_MS) {
      snap.repo.image = { kind: 'screenshot', url: prevImage.url };
      return;
    }
    const shot = await capturePublicSite(homepage, { capture, resolve });
    if (!shot) return;
    snap.repo.image = shot;
    shots.set(key, { homepage, at: when });
  }

  async function run(repository, owner, name, key, when) {
    const previous = viewOf(repository, owner, name);
    let snap;
    try {
      snap = await source.fetch({ owner, repo: name }, { fetchedAt: when });
    } catch (err) {
      const category = err && SOURCE_ERROR_CATEGORIES.includes(err.category) ? err.category : 'error';
      repository.recordRepoFailure({ owner, name, at: when, error: category });
      const prev = streaks.get(key);
      const n = prev && prev.category === category ? prev.n + 1 : 0;
      streaks.set(key, { n, category });
      return { status: 'error', category, until: when + backoffMs(category, n) };
    }
    streaks.delete(key);
    await applyScreenshot(snap, previous, key, when);
    repository.putRepoCache({ owner, name, repo: snap.repo, authors: snap.authors });
    const project = repository.findActiveByGithub(owner, name);
    if (project) {
      repository.ingestActivity({
        id: project.id,
        actor: 'system',
        component: 'scheduler',
        at: when,
        commits: snap.repo.commits.map((commit) => ({
          sha: commit.sha,
          branch: snap.repo.defaultBranch,
          at: commit.at,
        })),
      });
      repository.applyProjectRisks({ id: project.id, at: when, actor: 'system' });
    }
    return { status: 'ok', fetchedAt: snap.repo.fetchedAt };
  }

  function refresh(repository, { owner, name, at } = {}) {
    const key = cacheKey(owner, name);
    const existing = inflight.get(key);
    if (existing) return existing;
    const when = Number.isInteger(at) ? at : now();
    const gate = gateOf(viewOf(repository, owner, name), key, when);
    if (gate.status !== 'fetch') return Promise.resolve(gate);
    const job = run(repository, owner, name, key, when).finally(() => {
      if (inflight.get(key) === job) inflight.delete(key);
    });
    inflight.set(key, job);
    return job;
  }

  return { refresh, backoffMs, freshMs: REPO_FRESH_MS };
}

module.exports = { createRepoRefresh, backoffMs, REPO_FRESH_MS, BACKOFF_MAX_MS, SCREENSHOT_FRESH_MS };
