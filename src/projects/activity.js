'use strict';

const { evaluateRisks } = require('./risks');
const { discordSnowflake } = require('./people');
const { matchSessions } = require('./sources/session-group');

const RUN_STATUS = new Set(['succeeded', 'failed', 'skipped', 'running', 'unrecognized']);
const HISTORY_RUN = new Set(['succeeded', 'failed', 'skipped']);

/**
 * Pure linking of canonical engine objects to projects.
 *
 * Workspace folders match `session.cwd` when that absolute path names the
 * folder. `goal.objective` is the fallback when cwd is missing or names none
 * of the linked folders. `messages` is `session.messageCount`, then a
 * transcript count, and null when both are unknown.
 * A flow-run is a CronRun whose jobId is explicitly linked to the project.
 * Any other CronRun whose session touches the project is a cron-run.
 * LiveEvents are not read and are not history.
 */

// architect-54 · the project tag: a project answers to the slug of its name, of a linked repo, folder or session group.
// A ticket slug (pivot-2735) also matches a longer name that starts with it ('PIVOT-2735 menu update').
const slugOf = (v) => String(v || '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
const TICKET_SLUG = /^[a-z]{2,10}-\d{1,6}$/;
function projectSlugs(project) {
  const out = new Set([slugOf(project.name)]);
  for (const source of project.sources || []) {
    if (!source || !source.ref) continue;
    if (source.kind === 'github') out.add(slugOf(source.ref.repo));
    if (source.kind === 'workspace' && typeof source.ref.path === 'string') out.add(slugOf(source.ref.path.split('/').filter(Boolean).pop()));
    if (source.kind === 'sessionGroup' && source.ref.name) out.add(slugOf(source.ref.name));
  }
  out.delete('');
  return out;
}
function projectsForSlug(projects, slug) {
  if (!slug) return [];
  return (projects || []).filter((p) => { const s = projectSlugs(p); return s.has(slug) || (TICKET_SLUG.test(slug) && [...s].some((x) => x.startsWith(slug + '-'))); });
}

function activeProjects(projects) {
  return (projects || []).filter((p) => p && typeof p.id === 'string' && p.id && p.archivedAt == null);
}

function repoKey(owner, name) {
  if (typeof owner !== 'string' || typeof name !== 'string' || !owner || !name) return null;
  return `${owner.toLowerCase()}/${name.toLowerCase()}`;
}

function escapeReg(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function mentionsPath(text, rel) {
  if (typeof text !== 'string' || typeof rel !== 'string') return false;
  const norm = rel.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  if (!norm || norm.split('/').includes('..')) return false;
  const hay = text.replace(/\\/g, '/');
  const re = new RegExp(`(?:^|[^A-Za-z0-9._-])${escapeReg(norm)}(?:$|[^A-Za-z0-9._-])`);
  return re.test(hay);
}

function normalPath(path) {
  if (typeof path !== 'string') return '';
  return path.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
}

function isPathPrefix(shorter, longer) {
  return longer.length > shorter.length && longer.startsWith(`${shorter}/`);
}

function workspacePaths(project, text, roots) {
  const paths = [];
  if (typeof text !== 'string' || !text) return paths;
  for (const source of project.sources || []) {
    if (!source || source.kind !== 'workspace' || !source.ref) continue;
    const norm = normalPath(source.ref.path);
    if (!norm) continue;
    if (source.ref.rootId) {
      const root = (roots || []).find((item) => item && item.id === source.ref.rootId);
      if (!root || typeof root.path !== 'string') continue;
      const abs = normalPath(`${normalPath(root.path)}/${norm}`);
      const id = `${source.ref.rootId}/${norm}`;
      if (!mentionsPath(text, abs) || paths.includes(id)) continue;
      paths.push(id);
      continue;
    }
    if (!mentionsPath(text, norm) || paths.includes(norm)) continue;
    paths.push(norm);
  }
  return paths;
}

function workspaceText(session, projects, roots) {
  const cwd = typeof session.cwd === 'string' ? session.cwd : '';
  if (cwd && projects.some((project) => workspacePaths(project, cwd, roots).length)) return cwd;
  return session.goal && typeof session.goal.objective === 'string' ? session.goal.objective : '';
}

function groupHit(ref, session) {
  if (!ref || (ref.by !== 'keys' && ref.by !== 'group' && ref.by !== 'interlocutor')) return null;
  try {
    if (!matchSessions(ref, [session]).length) return null;
  } catch {
    return null;
  }
  return ref.by;
}

function indexSessions(sessions) {
  const byKey = new Map();
  for (const session of sessions || []) {
    if (!session || typeof session.key !== 'string' || !session.key) continue;
    byKey.set(session.key, session);
  }
  return byKey;
}

function indexJobs(cronJobs) {
  const byId = new Map();
  for (const job of cronJobs || []) {
    if (!job || typeof job.id !== 'string' || !job.id) continue;
    byId.set(job.id, job);
  }
  return byId;
}

function explicitSets(links, activeIds) {
  const sessions = new Map();
  const jobs = new Map();
  const shas = new Map();
  const add = (map, projectId, value) => {
    if (!map.has(projectId)) map.set(projectId, new Set());
    map.get(projectId).add(value);
  };
  for (const link of links || []) {
    if (!link || !activeIds.has(link.projectId)) continue;
    if (typeof link.sessionKey === 'string' && link.sessionKey) add(sessions, link.projectId, link.sessionKey);
    if (typeof link.jobId === 'string' && link.jobId) add(jobs, link.projectId, link.jobId);
    if (typeof link.sha === 'string' && link.sha) add(shas, link.projectId, link.sha);
  }
  return { sessions, jobs, shas };
}

function has(map, projectId, value) {
  const set = map.get(projectId);
  return Boolean(set && set.has(value));
}

function assignSessions(projects, sessionsByKey, explicit, roots, hints = []) {
  // architect-54: sessions the agent tagged with a project's slug are linked as explicitly as a manual link
  const tagged = new Map();   // projectId → Set(sessionKey)
  for (const h of hints || []) {
    if (!h || typeof h.sessionKey !== 'string') continue;
    for (const p of projectsForSlug(projects, h.slug)) { if (!tagged.has(p.id)) tagged.set(p.id, new Set()); tagged.get(p.id).add(h.sessionKey); }
  }
  const matches = [];
  const ambiguous = [];
  const byProject = new Map();

  for (const session of sessionsByKey.values()) {
    const heartbeat = Boolean(session.class && session.class.heartbeatOf);
    const folderText = workspaceText(session, projects, roots);
    const hits = [];
    for (const project of projects) {
      const vias = new Set();
      let keyed = has(explicit.sessions, project.id, session.key) || has(tagged, project.id, session.key);
      if (keyed) vias.add('explicit');
      for (const source of project.sources || []) {
        if (!source || source.kind !== 'sessionGroup') continue;
        const hit = groupHit(source.ref, session);
        if (hit === 'keys') {
          keyed = true;
          vias.add('session-group');
        } else if (hit === 'group' || hit === 'interlocutor') vias.add('session-group');
      }
      const paths = workspacePaths(project, folderText, roots);
      if (paths.length) vias.add('workspace');
      if (!vias.size) continue;
      if (heartbeat && !keyed) continue;
      hits.push({
        project, vias, paths, firm: vias.has('explicit') || vias.has('session-group'),
      });
    }

    const chosen = hits.filter((hit) => hit.firm);
    const workspaceOnly = hits.filter((hit) => !hit.firm && hit.paths.length);
    if (workspaceOnly.length) {
      const specific = (hit) => hit.paths.filter((path) => !workspaceOnly.some((other) => (
        other !== hit && other.paths.some((longer) => isPathPrefix(path, longer))
      )));
      const owners = new Map();
      for (const hit of workspaceOnly) {
        for (const path of specific(hit)) {
          if (!owners.has(path)) owners.set(path, []);
          owners.get(path).push(hit);
        }
      }
      const conflicted = [];
      for (const hit of workspaceOnly) {
        const own = specific(hit).filter((path) => owners.get(path).length === 1);
        if (own.length) chosen.push(hit);
        else conflicted.push(hit);
      }
      if (conflicted.length > 1) {
        ambiguous.push({
          kind: 'session',
          ref: session.key,
          via: 'workspace',
          projectIds: conflicted.map((hit) => hit.project.id).sort(),
        });
      }
    }

    for (const hit of chosen) {
      const vias = [...hit.vias].sort();
      matches.push({
        projectId: hit.project.id,
        kind: 'session',
        ref: session.key,
        via: vias[0],
        vias,
      });
      if (!byProject.has(hit.project.id)) byProject.set(hit.project.id, []);
      byProject.get(hit.project.id).push(session);
    }
  }

  return { matches, ambiguous, byProject };
}

function projectsForRun(run, job, sessionProjects, sessionsByKey) {
  const ids = new Set();
  const addKey = (key) => {
    if (typeof key !== 'string' || !sessionProjects.has(key)) return;
    for (const id of sessionProjects.get(key)) ids.add(id);
  };
  addKey(run.sessionKey);
  if (job) addKey(job.sessionKey);
  for (const [key, projectIds] of sessionProjects) {
    const session = sessionsByKey.get(key);
    if (session && session.class && session.class.cronJobId === run.jobId) {
      for (const id of projectIds) ids.add(id);
    }
  }
  return ids;
}

function sessionAt(session) {
  if (Number.isInteger(session.updatedAt)) return session.updatedAt;
  const run = session.run || {};
  if (Number.isInteger(run.endedAt)) return run.endedAt;
  if (Number.isInteger(run.startedAt)) return run.startedAt;
  return null;
}

function sessionMessages(session, transcripts) {
  let best = null;
  for (const transcript of transcripts || []) {
    if (!transcript || transcript.sessionKey !== session.key) continue;
    if (!best || (transcript.fetchedAt || 0) >= (best.fetchedAt || 0)) best = transcript;
  }
  return require('./session-summary').messageCountOf(session, best);
}

function githubIndex(projects) {
  const index = new Map();
  for (const project of projects) {
    for (const source of project.sources || []) {
      if (!source || source.kind !== 'github' || !source.ref) continue;
      const key = repoKey(source.ref.owner, source.ref.repo);
      if (!key) continue;
      if (!index.has(key)) index.set(key, []);
      const list = index.get(key);
      if (!list.some((item) => item.id === project.id)) list.push(project);
    }
  }
  return index;
}

function considerCommit(bucket, project, sha, at, branch, via) {
  if (typeof sha !== 'string' || sha.length < 7 || sha.length > 64) return false;
  if (!Number.isInteger(at) || typeof branch !== 'string' || !branch) return false;
  const list = bucket.get(project.id) || [];
  list.push({ sha, at, branch, via });
  bucket.set(project.id, list);
  return true;
}

function assignCommits(projects, commits, explicit, ambiguous) {
  const matches = [];
  const byProject = new Map();
  const index = githubIndex(projects);
  const claimed = new Map();

  const claim = (key, commit, via) => {
    const owners = index.get(key) || [];
    if (owners.length === 1) {
      if (!claimed.has(commit.sha)) claimed.set(commit.sha, []);
      claimed.get(commit.sha).push({ project: owners[0], commit, via });
      return;
    }
    if (owners.length > 1) {
      ambiguous.push({
        kind: 'commit',
        ref: commit.sha,
        via: 'github',
        projectIds: owners.map((project) => project.id).sort(),
      });
    }
  };

  for (const project of projects) {
    const repo = project.repo;
    if (!repo || !Array.isArray(repo.commits)) continue;
    const key = repoKey(repo.owner, repo.name);
    if (!key) continue;
    for (const commit of repo.commits) {
      claim(key, {
        sha: commit.sha,
        at: commit.at,
        branch: commit.branch || repo.defaultBranch,
      }, 'github');
    }
  }

  for (const commit of commits || []) {
    const key = repoKey(commit && commit.owner, commit && (commit.name || commit.repo));
    if (!key || !commit) continue;
    claim(key, commit, 'github');
  }

  for (const [sha, hits] of claimed) {
    const unique = new Map();
    for (const hit of hits) unique.set(hit.project.id, hit);
    for (const hit of unique.values()) {
      if (!considerCommit(byProject, hit.project, sha, hit.commit.at, hit.commit.branch, hit.via)) continue;
      matches.push({ projectId: hit.project.id, kind: 'commit', ref: sha, via: hit.via, vias: [hit.via] });
    }
  }

  const pool = [];
  for (const project of projects) {
    const repo = project.repo;
    if (!repo || !Array.isArray(repo.commits)) continue;
    for (const commit of repo.commits) pool.push({ ...commit, branch: commit.branch || repo.defaultBranch });
  }
  for (const commit of commits || []) pool.push(commit);

  for (const project of projects) {
    const wanted = explicit.shas.get(project.id);
    if (!wanted) continue;
    const repo = project.repo;
    for (const sha of wanted) {
      const commit = pool.find((item) => item && item.sha === sha);
      if (!commit) continue;
      const branch = commit.branch || (repo && repo.defaultBranch);
      if (!considerCommit(byProject, project, sha, commit.at, branch, 'explicit')) continue;
      matches.push({ projectId: project.id, kind: 'commit', ref: sha, via: 'explicit', vias: ['explicit'] });
    }
  }

  return { matches, byProject };
}

function dedupeCommits(list) {
  const bySha = new Map();
  for (const commit of list || []) {
    const prev = bySha.get(commit.sha);
    if (!prev || commit.at >= prev.at) bySha.set(commit.sha, commit);
  }
  return [...bySha.values()];
}

function suggestPeople(sessions, agents) {
  const agentNames = new Map();
  for (const agent of agents || []) {
    if (agent && typeof agent.id === 'string' && typeof agent.name === 'string') agentNames.set(agent.id, agent.name);
  }
  const byLink = new Map();
  const add = (kind, links, sessionKey) => {
    const id = JSON.stringify({ kind, links });
    if (!byLink.has(id)) byLink.set(id, { kind, name: null, links, sessionKeys: [] });
    const row = byLink.get(id);
    if (!row.sessionKeys.includes(sessionKey)) row.sessionKeys.push(sessionKey);
  };

  for (const session of sessions) {
    const cls = session.class || {};
    if (cls.subagentId && cls.agentId) {
      add('agent', { agentId: cls.agentId, subagentId: cls.subagentId }, session.key);
    } else if (cls.agentId) {
      const links = { agentId: cls.agentId };
      add('agent', links, session.key);
      const row = byLink.get(JSON.stringify({ kind: 'agent', links }));
      if (row && row.name == null && agentNames.has(cls.agentId)) row.name = agentNames.get(cls.agentId);
    }
    const snow = discordSnowflake(cls.interlocutorId);
    if (snow) add('human', { discordUserId: snow }, session.key);
  }

  const people = [...byLink.values()];
  for (const person of people) person.sessionKeys.sort();
  people.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'agent' ? -1 : 1;
    const asub = a.links.subagentId || '';
    const bsub = b.links.subagentId || '';
    return (a.links.agentId || a.links.discordUserId || '').localeCompare(b.links.agentId || b.links.discordUserId || '')
      || asub.localeCompare(bsub);
  });
  return people;
}

const VIA_RANK = { explicit: 0, 'session-group': 1, session: 2, github: 3, workspace: 4 };

function bestVia(vias) {
  return vias.slice().sort((a, b) => (VIA_RANK[a] ?? 9) - (VIA_RANK[b] ?? 9) || a.localeCompare(b))[0];
}

function collapseMatches(list) {
  const map = new Map();
  for (const item of list) {
    const key = `${item.projectId}\0${item.kind}\0${item.ref}`;
    const vias = item.vias ? item.vias.slice() : [item.via];
    const prev = map.get(key);
    if (!prev) {
      map.set(key, { ...item, vias });
      continue;
    }
    for (const via of vias) if (!prev.vias.includes(via)) prev.vias.push(via);
  }
  const matches = [...map.values()];
  for (const match of matches) {
    match.vias = match.vias.slice().sort((a, b) => (VIA_RANK[a] ?? 9) - (VIA_RANK[b] ?? 9) || a.localeCompare(b));
    match.via = bestVia(match.vias);
  }
  matches.sort((a, b) => a.projectId.localeCompare(b.projectId) || a.kind.localeCompare(b.kind) || String(a.ref).localeCompare(String(b.ref)));
  return matches;
}

function collapseAmbiguous(list) {
  const map = new Map();
  for (const item of list) {
    const key = `${item.kind}\0${item.ref}\0${item.via}`;
    const prev = map.get(key);
    if (!prev) {
      map.set(key, { ...item, projectIds: item.projectIds.slice() });
      continue;
    }
    for (const id of item.projectIds) if (!prev.projectIds.includes(id)) prev.projectIds.push(id);
    prev.projectIds.sort();
  }
  return [...map.values()].sort((a, b) => a.kind.localeCompare(b.kind) || String(a.ref).localeCompare(String(b.ref)));
}

function historySort(a, b) {
  return a.at - b.at || (a.dedupeKey < b.dedupeKey ? -1 : a.dedupeKey > b.dedupeKey ? 1 : 0);
}

function ingestFrom(history) {
  const commits = [];
  const flowRuns = [];
  const cronRuns = [];
  const sessions = [];
  for (const event of history) {
    if (event.kind === 'commit') commits.push({ sha: event.shas[0], branch: event.branch, at: event.at });
    else if (event.kind === 'flow-run') {
      flowRuns.push({
        jobId: event.jobId, runId: event.runId, status: event.status, durationMs: event.durationMs, at: event.at,
      });
    } else if (event.kind === 'cron-run') {
      cronRuns.push({
        jobId: event.jobId, runId: event.runId, status: event.status, durationMs: event.durationMs, at: event.at,
      });
    } else if (event.kind === 'session') {
      sessions.push({
        sessionKey: event.sessionKey, messages: event.messages, tokens: event.tokens, at: event.at,
      });
    }
  }
  return { commits, flowRuns, cronRuns, sessions };
}

function runSignal(run) {
  return { jobId: run.jobId, runId: run.id, status: run.status, at: run.at };
}

function signalSort(a, b) {
  return a.jobId.localeCompare(b.jobId) || a.at - b.at || a.runId.localeCompare(b.runId);
}

/**
 * @param {object} input
 * @param {object[]} input.projects canonical projects (sources, repo, flags, lastActivityAt)
 * @param {object[]} [input.sessions] canonical Sessions
 * @param {object[]} [input.cronRuns] canonical CronRuns
 * @param {object[]} [input.cronJobs] canonical CronJobs, used for sessionKey
 * @param {object[]} [input.transcripts] canonical Transcripts, for session message counts
 * @param {object[]} [input.agents] canonical Agents, for suggestion names
 * @param {object[]} [input.commits] `{ owner, name, sha, at, branch? }` besides each project's `repo.commits`
 * @param {object[]} [input.links] `{ projectId, sessionKey? , jobId?, sha? }` — jobId marks a flow
 * @param {number} [input.now] clock for `evaluateRisks`
 */
function linkProjectActivity(input = {}) {
  const projects = activeProjects(input.projects);
  const activeIds = new Set(projects.map((project) => project.id));
  const explicit = explicitSets(input.links, activeIds);
  const sessionsByKey = indexSessions(input.sessions);
  const jobsById = indexJobs(input.cronJobs);
  const sessionAssign = assignSessions(projects, sessionsByKey, explicit, input.workspaceRoots || [], input.projectHints || []);
  const ambiguous = sessionAssign.ambiguous.slice();
  const commitAssign = assignCommits(projects, input.commits, explicit, ambiguous);

  const sessionProjects = new Map();
  for (const [projectId, list] of sessionAssign.byProject) {
    for (const session of list) {
      if (!sessionProjects.has(session.key)) sessionProjects.set(session.key, new Set());
      sessionProjects.get(session.key).add(projectId);
    }
  }

  const runsById = new Map();
  for (const run of input.cronRuns || []) {
    if (!run || typeof run.id !== 'string' || typeof run.jobId !== 'string') continue;
    if (!RUN_STATUS.has(run.status) || !Number.isInteger(run.at)) continue;
    const prev = runsById.get(run.id);
    if (!prev || run.at >= prev.at) runsById.set(run.id, run);
  }

  const runMatches = [];
  const runsByProject = new Map();
  for (const run of runsById.values()) {
    const job = jobsById.get(run.jobId) || null;
    const touched = projectsForRun(run, job, sessionProjects, sessionsByKey);
    for (const project of projects) {
      const flow = has(explicit.jobs, project.id, run.jobId);
      const cron = !flow && touched.has(project.id);
      if (!flow && !cron) continue;
      const kind = flow ? 'flow' : 'cron';
      runMatches.push({
        projectId: project.id,
        kind,
        ref: run.id,
        via: flow ? 'explicit' : 'session',
        vias: [flow ? 'explicit' : 'session'],
      });
      if (!runsByProject.has(project.id)) runsByProject.set(project.id, []);
      runsByProject.get(project.id).push({ run, kind });
    }
  }

  const matches = collapseMatches([...sessionAssign.matches, ...commitAssign.matches, ...runMatches]);
  const ambiguousOut = collapseAmbiguous(ambiguous);

  const byProject = {};
  for (const project of projects) {
    const history = [];
    const seen = new Set();
    const push = (event) => {
      if (seen.has(event.dedupeKey)) return;
      seen.add(event.dedupeKey);
      history.push(event);
    };

    for (const session of sessionAssign.byProject.get(project.id) || []) {
      const at = sessionAt(session);
      if (at == null) continue;
      const tokens = session.usage && Number.isInteger(session.usage.total) ? session.usage.total : 0;
      push({
        projectId: project.id,
        dedupeKey: `session:${session.key}@${at}`,
        kind: 'session',
        at,
        sessionKey: session.key,
        messages: sessionMessages(session, input.transcripts),
        tokens,
      });
    }

    for (const item of runsByProject.get(project.id) || []) {
      if (!HISTORY_RUN.has(item.run.status)) continue;
      const kind = item.kind === 'flow' ? 'flow-run' : 'cron-run';
      push({
        projectId: project.id,
        dedupeKey: `${kind}:${item.run.id}`,
        kind,
        at: item.run.at,
        jobId: item.run.jobId,
        runId: item.run.id,
        status: item.run.status,
        durationMs: Number.isInteger(item.run.durationMs) ? item.run.durationMs : null,
      });
    }

    for (const commit of dedupeCommits(commitAssign.byProject.get(project.id))) {
      push({
        projectId: project.id,
        dedupeKey: `commit:${commit.sha}`,
        kind: 'commit',
        at: commit.at,
        branch: commit.branch,
        shas: [commit.sha],
      });
    }

    history.sort(historySort);
    const flows = [];
    const crons = [];
    for (const item of runsByProject.get(project.id) || []) {
      if (item.run.status === 'unrecognized') continue;
      (item.kind === 'flow' ? flows : crons).push(runSignal(item.run));
    }
    flows.sort(signalSort);
    crons.sort(signalSort);
    const riskInput = { flows, crons };
    const riskPlan = Number.isInteger(input.now) ? evaluateRisks({
      now: input.now,
      lastActivityAt: project.lastActivityAt,
      flows,
      crons,
      ci: project.repo && project.repo.ci ? project.repo.ci : null,
      current: Array.isArray(project.flags) ? project.flags : [],
    }) : null;

    const matched = sessionAssign.byProject.get(project.id) || [];
    byProject[project.id] = {
      history,
      ingest: ingestFrom(history),
      riskInput,
      riskPlan,
      people: suggestPeople(matched, input.agents),
      channels: [...new Set(matched.map((session) => session.class && session.class.channel).filter((channel) => typeof channel === 'string' && channel))].sort(),
    };
  }

  return { matches, ambiguous: ambiguousOut, byProject };
}

module.exports = { projectsForSlug, projectSlugs, linkProjectActivity, mentionsPath };
