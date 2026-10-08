'use strict';

const s = require('../schema');
const {
  PROJECT_STATUSES, PRIORITIES, RISK_KEYS, FLAG_KINDS, SOURCE_KINDS, HISTORY_KINDS, AGENT_STATES, CI_STATES,
  SOURCE_ERROR_CATEGORIES, MONOGRAM_ACCENTS,
} = require('./constants');
const { ProjectError, validation } = require('./errors');

const personId = s.string().refine((v) => /^per_[a-z0-9][a-z0-9_-]{0,63}$/.test(v), 'person id');
const projectId = s.string().refine((v) => /^prj_[a-z0-9][a-z0-9_-]{0,63}$/.test(v), 'project id');
const sourceId = s.string().refine((v) => /^src_[a-z0-9][a-z0-9_-]{0,63}$/.test(v), 'source id');
const eventId = s.string().refine((v) => /^evt_[a-z0-9][a-z0-9_-]{0,63}$/.test(v), 'event id');
const slug = s.string().refine((v) => /^[a-z0-9][a-z0-9-]{0,47}$/.test(v), 'slug');
const httpsUrl = s.string().refine((v) => /^https:\/\/\S+$/.test(v), 'https url');
const status = s.enumOf(PROJECT_STATUSES);
const priority = s.enumOf(PRIORITIES);
const riskKey = s.enumOf(RISK_KEYS);
const severity = s.enumOf(['high', 'medium', 'low']);

const actorSchema = s.discriminated('kind', {
  human: s.object({ kind: s.literal('human'), personId }, { extra: 'reject' }),
  agent: s.object({ kind: s.literal('agent'), personId }, { extra: 'reject' }),
  system: s.object({
    kind: s.literal('system'),
    component: s.enumOf(['engine', 'risk-monitor', 'scheduler']),
  }, { extra: 'reject' }),
});

const evidenceSchema = s.object({
  kind: s.enumOf(['cron-run', 'ci', 'session', 'manual', 'inactivity']),
  ref: s.string().min(1).max(300),
  at: s.ms(),
}, { extra: 'reject' }).nullable();

const labelFlag = s.object({
  kind: s.literal('label'),
  key: slug,
  label: s.string().min(1).max(40),
  addedBy: actorSchema,
  addedAt: s.ms(),
}, { extra: 'reject' });

const riskFlag = s.object({
  kind: s.literal('risk'),
  key: riskKey,
  severity,
  origin: s.enumOf(['auto', 'manual']),
  evidence: evidenceSchema,
  staleDays: s.int().min(1).max(3650).optional(),
  raisedAt: s.ms(),
  clearedAt: s.ms().nullable(),
  ack: s.object({ by: actorSchema, at: s.ms() }, { extra: 'reject' }).nullable(),
}, { extra: 'reject' }).refine((v) => {
  if (v.key === 'stale') return Number.isInteger(v.staleDays);
  return v.staleDays == null;
}, 'staleDays');

const featureFlag = s.object({
  kind: s.literal('feature'),
  key: s.string().min(1).max(80),
  state: s.enumOf(['on', 'off', 'unknown']),
  foundIn: s.object({
    path: s.string().min(1).max(300),
    line: s.int().min(1).nullable(),
  }, { extra: 'reject' }),
  scannedAt: s.ms(),
}, { extra: 'reject' });

const priorityFlag = s.object({
  kind: s.literal('priority'),
  key: priority,
}, { extra: 'reject' });

const flagSchema = s.discriminated('kind', {
  label: labelFlag, risk: riskFlag, feature: featureFlag, priority: priorityFlag,
});

const githubRef = s.object({
  owner: s.string().min(1).max(100),
  repo: s.string().min(1).max(100),
}, { extra: 'reject' });

const sessionGroupRef = s.discriminated('by', {
  group: s.object({
    by: s.literal('group'),
    groupId: s.string().min(1).max(200),
    name: s.string().min(1).max(200),
  }, { extra: 'reject' }),
  interlocutor: s.object({
    by: s.literal('interlocutor'),
    interlocutorId: s.string().refine((v) => /^discord-(user|channel):\d{17,20}$/.test(v), 'interlocutor id'),
  }, { extra: 'reject' }),
  keys: s.object({
    by: s.literal('keys'),
    sessionKeys: s.array(s.string().min(1).max(200)).min(1).max(100),
  }, { extra: 'reject' }),
});

const workspacePath = s.string().min(1).max(300);
const workspaceRef = s.object({ path: workspacePath }, { extra: 'reject' });
const workspaceRefWithRoot = s.object({
  rootId: slug,
  path: workspacePath,
}, { extra: 'reject' });

function sourceSchemaFor(workspaceRootIds) {
  return s.discriminated('kind', {
    github: s.object({
      id: sourceId, addedAt: s.ms(), addedBy: actorSchema,
      kind: s.literal('github'), ref: githubRef,
    }, { extra: 'reject' }),
    workspace: s.object({
      id: sourceId, addedAt: s.ms(), addedBy: actorSchema,
      kind: s.literal('workspace'), ref: workspaceRootIds ? workspaceRefWithRoot : workspaceRef,
    }, { extra: 'reject' }),
    sessionGroup: s.object({
      id: sourceId, addedAt: s.ms(), addedBy: actorSchema,
      kind: s.literal('sessionGroup'), ref: sessionGroupRef,
    }, { extra: 'reject' }),
    manual: s.object({
      id: sourceId, addedAt: s.ms(), addedBy: actorSchema,
      kind: s.literal('manual'), ref: s.literal(null),
    }, { extra: 'reject' }),
  });
}

const sourceSchema = sourceSchemaFor(false);
const sourceSchemaWithRootIds = sourceSchemaFor(true);

const personSchema = s.object({
  id: personId,
  kind: s.enumOf(['human', 'agent', 'git']),
  name: s.string().min(1).max(80),
  avatarUrl: httpsUrl.nullable(),
  links: s.object({
    agentId: s.string().min(1).max(80).optional(),
    subagentId: s.string().min(1).max(80).optional(),
    discordUserId: s.snowflake().optional(),
    gitEmailHash: s.string().refine((v) => /^[a-f0-9]{64}$/.test(v), 'sha256').optional(),
    isOwner: s.boolean().optional(),
  }, { extra: 'reject' }),
}, { extra: 'reject' });

const projectPersonSchema = s.object({
  personId,
  role: s.string().min(1).max(80).nullable(),
  origin: s.enumOf(['derived', 'manual']),
  liveState: s.enumOf(AGENT_STATES).nullable(),
  commitCount: s.int().min(0).nullable(),
}, { extra: 'reject' });

const repoSchema = s.object({
  url: httpsUrl,
  owner: s.string().min(1),
  name: s.string().min(1),
  defaultBranch: s.string().min(1).max(200),
  image: s.discriminated('kind', {
    screenshot: s.object({ kind: s.literal('screenshot'), url: httpsUrl }, { extra: 'reject' }),
    opengraph: s.object({ kind: s.literal('opengraph'), url: httpsUrl }, { extra: 'reject' }),
    monogram: s.object({
      kind: s.literal('monogram'),
      initials: s.string().min(1).max(8),
      accent: s.enumOf(MONOGRAM_ACCENTS),
    }, { extra: 'reject' }),
  }),
  ci: s.object({
    state: s.enumOf(CI_STATES),
    at: s.ms().nullable(),
    url: httpsUrl.nullable(),
  }, { extra: 'reject' }),
  commits: s.array(s.object({
    sha: s.string().refine((v) => /^[a-f0-9]{7,64}$/.test(v), 'sha'),
    at: s.ms(),
    author: s.object({
      name: s.string().min(1).max(120),
      personId: personId.nullable(),
    }, { extra: 'reject' }),
    message: s.string().max(200),
  }, { extra: 'reject' })).max(10),
  fetchedAt: s.ms(),
  archived: s.boolean().optional(),
  homepage: httpsUrl.nullable().optional(),
  topics: s.array(s.string().refine((v) => /^[a-z0-9][a-z0-9-]{0,49}$/.test(v), 'topic')).max(20).optional(),
}, { extra: 'reject' });

const summaryMetaSchema = s.object({ author: actorSchema, at: s.ms() }, { extra: 'reject' }).nullable();

function projectSchemaFor(workspaceRootIds) {
  return s.object({
  id: projectId,
  name: s.string().min(1).max(80),
  status,
  priority,
  summary: s.string().max(4000),
  summaryMeta: summaryMetaSchema,
  sources: s.array(workspaceRootIds ? sourceSchemaFor(true) : sourceSchema),
  repo: repoSchema.nullable(),
  flags: s.array(flagSchema),
  people: s.array(projectPersonSchema),
  lastActivityAt: s.ms(),
  createdAt: s.ms(),
  revision: s.int().min(1),
  repoStatus: s.object({
    state: s.enumOf(['pending', 'ok', 'error']),
    lastAttemptAt: s.ms().nullable(),
    lastError: s.enumOf(SOURCE_ERROR_CATEGORIES).nullable(),
  }, { extra: 'reject' }).nullable(),
  archivedAt: s.ms().nullable(),
}, { extra: 'reject' });
}

const projectSchema = projectSchemaFor(false);
const projectSchemaWithRootIds = projectSchemaFor(true);

function historySchemaFor(kind) {
  const base = {
    id: eventId,
    projectId,
    at: s.ms(),
    actor: actorSchema,
    dedupeKey: s.string().min(1).max(200).nullable(),
    kind: s.literal(kind),
  };
  const extra = {
    'project-created': {},
    status: { from: status, to: status },
    priority: { from: priority, to: priority },
    commit: { branch: s.string().min(1).max(200), shas: s.array(s.string().min(7).max(64)).min(1).max(20) },
    'flow-run': runPayload(),
    'cron-run': runPayload(),
    session: {
      sessionKey: s.string().min(1).max(200),
      messages: s.int().min(0).nullable(),
      tokens: s.int().min(0),
    },
    'risk-raised': { key: riskKey, severity },
    'risk-cleared': { key: riskKey },
    'risk-acked': { key: riskKey },
    'risk-unacked': { key: riskKey },
    'flag-added': { flagKind: s.enumOf(['label', 'risk']), key: s.string().min(1).max(80), label: s.string().min(1).max(40) },
    'flag-removed': { flagKind: s.enumOf(['label', 'risk']), key: s.string().min(1).max(80) },
    'summary-edited': {},
    'source-linked': { source: s.enumOf(SOURCE_KINDS), ref: s.string().min(1).max(300) },
    'source-unlinked': { source: s.enumOf(SOURCE_KINDS), ref: s.string().min(1).max(300) },
    'agent-action': {
      action: s.enumOf(['delegated', 'commented']),
      subjectPersonId: personId.nullable(),
      note: s.string().max(500),
    },
    renamed: { from: s.string().min(1).max(80), to: s.string().min(1).max(80) },
    archived: {},
    restored: {},
    'people-override': {
      personId,
      role: s.string().min(1).max(80).nullable().optional(),
      hidden: s.boolean().optional(),
    },
    'flags-updated': {
      flags: s.array(s.object({
        key: s.string().min(1).max(80),
        state: s.enumOf(['on', 'off', 'unknown']),
      }, { extra: 'reject' })).max(100),
    },
  };
  return s.object({ ...base, ...extra[kind] }, { extra: 'reject' });
}

function runPayload() {
  return {
    jobId: s.string().min(1).max(120),
    runId: s.string().min(1).max(200),
    status: s.enumOf(['succeeded', 'failed', 'skipped', 'running', 'unrecognized']),
    durationMs: s.int().min(0).nullable(),
  };
}

const historySchemas = Object.fromEntries(HISTORY_KINDS.map((k) => [k, historySchemaFor(k)]));
const historySchema = s.discriminated('kind', historySchemas);

function check(schema, value) {
  return s.validate(schema, value);
}

function parse(schema, value, message = 'Donnée invalide.') {
  const r = check(schema, value);
  if (!r.ok) {
    throw new ProjectError('validation_failed', message, {
      details: r.issues.filter((i) => i.severity === 'error').slice(0, 8).map((i) => ({
        field: i.path, issue: i.detail,
      })),
    });
  }
  return r.value;
}

function slugify(label) {
  const text = String(label ?? '').trim();
  if (text.length < 1 || text.length > 40) throw validation('L’étiquette doit faire entre 1 et 40 caractères.', 'label');
  const key = text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
  if (!/^[a-z0-9][a-z0-9-]{0,47}$/.test(key)) throw validation('Étiquette invalide.', 'label');
  return { key, label: text };
}

function assertName(name) {
  if (typeof name !== 'string' || name.trim() !== name || name.length < 1 || name.length > 80) {
    throw validation('Le nom doit faire entre 1 et 80 caractères.', 'name');
  }
  return name;
}

function assertSummary(summary) {
  if (typeof summary !== 'string' || summary.length > 4000) {
    throw validation('Le résumé dépasse 4000 caractères.', 'summary');
  }
  return summary;
}

function refKeyOf(kind, ref) {
  if (kind === 'github') return `${ref.owner}/${ref.repo}`.toLowerCase();
  if (kind === 'workspace') return ref.rootId ? `${ref.rootId}/${ref.path}` : ref.path;
  if (kind === 'manual') return 'manual';
  if (kind === 'sessionGroup' && ref.by === 'group') return `group:${ref.groupId}`;
  if (kind === 'sessionGroup' && ref.by === 'interlocutor') return `interlocutor:${ref.interlocutorId}`;
  if (kind === 'sessionGroup' && ref.by === 'keys') return `keys:${[...ref.sessionKeys].sort().join('\n')}`;
  throw validation('Source invalide.', 'source');
}

function displayRef(kind, ref) {
  if (kind === 'github') return `${ref.owner}/${ref.repo}`;
  if (kind === 'workspace') return ref.rootId ? `${ref.rootId}/${ref.path}` : ref.path;
  if (kind === 'manual') return 'manual';
  if (kind === 'sessionGroup' && ref.by === 'group') return ref.name;
  if (kind === 'sessionGroup' && ref.by === 'interlocutor') return ref.interlocutorId;
  if (kind === 'sessionGroup' && ref.by === 'keys') return ref.sessionKeys.join(',');
  return kind;
}

module.exports = {
  personId, projectId, actorSchema, flagSchema, sourceSchema, sourceSchemaWithRootIds, personSchema, projectSchema, projectSchemaWithRootIds,
  historySchema, repoSchema, check, parse, slugify, assertName, assertSummary, refKeyOf, displayRef,
  FLAG_KINDS,
};
