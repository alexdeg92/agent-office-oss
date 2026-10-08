'use strict';

const { ACTIVITY_CLOCK_KINDS, PRIORITIES, PROJECT_STATUSES, RISK_SEVERITY, TIMMY_HISTORY_KINDS } = require('./constants');
const { conflict, notFound, sourceInUse, validation } = require('./errors');
const { assertName, assertSummary, displayRef, parse, refKeyOf, slugify, actorSchema } = require('./validate');
const { parseSourceInput } = require('./sources/refs');
const { riskLabel } = require('./labels');
const { resolveActor } = require('./actors');

function requireRevision(row, expected) {
  if (!Number.isInteger(expected)) throw validation('La révision est requise.', 'expectedRevision');
  if (expected !== row.revision) throw conflict(row.revision);
}

function event(env, projectId, fields) {
  const { at, actor, dedupeKey, ...payload } = fields;
  return {
    id: env.mint('evt'),
    projectId,
    at: at ?? env.at,
    actor: actor ?? env.actor,
    dedupeKey: dedupeKey ?? null,
    ...payload,
  };
}

function movesActivityClock(event) {
  if (!event) return false;
  if ((event.kind === 'flag-added' || event.kind === 'flag-removed') && event.flagKind === 'label') return true;
  return ACTIVITY_CLOCK_KINDS.includes(event.kind);
}

/** Max event time over the activity whitelist. Risk bookkeeping is ignored. */
function activityAtFromHistory(events, createdAt) {
  let at = createdAt;
  for (const event of events || []) {
    if (movesActivityClock(event) && Number.isInteger(event.at)) at = Math.max(at, event.at);
  }
  return at;
}

function touch(row, env) {
  return { ...row, revision: row.revision + 1, lastActivityAt: Math.max(row.lastActivityAt, env.at) };
}

function bumpOnly(row) {
  return { ...row, revision: row.revision + 1 };
}

function createProject(input, env) {
  const name = assertName(input.name);
  const status = input.status ?? 'idea';
  const priority = input.priority ?? 'P2';
  if (!PROJECT_STATUSES.includes(status)) throw validation('Statut invalide.', 'status');
  if (!PRIORITIES.includes(priority)) throw validation('Priorité invalide.', 'priority');
  const summary = assertSummary(input.summary ?? '');
  const id = env.mint('prj');
  const sources = [];
  const events = [event(env, id, { kind: 'project-created' })];
  for (const raw of input.sources || []) {
    const parsed = parseSourceInput(raw, sourceOptions(env));
    const refKey = refKeyOf(parsed.kind, parsed.ref);
    if (parsed.kind === 'github' && input.takenGithub && input.takenGithub.has(refKey)) throw sourceInUse();
    if (sources.some((s) => s.kind === parsed.kind && refKeyOf(s.kind, s.ref) === refKey)) continue;
    const source = {
      id: env.mint('src'),
      addedAt: env.at,
      addedBy: env.actor,
      kind: parsed.kind,
      ref: parsed.ref,
    };
    sources.push(source);
    events.push(event(env, id, { kind: 'source-linked', source: parsed.kind, ref: displayRef(parsed.kind, parsed.ref) }));
  }
  const earliest = Date.UTC(2020, 0, 1);
  const activityAt = Number.isInteger(input.activityAt) && input.activityAt >= earliest && input.activityAt <= env.at
    ? input.activityAt
    : env.at;
  const row = {
    id,
    name,
    status,
    priority,
    summary,
    summaryMeta: summary ? { author: env.actor, at: env.at } : null,
    lastActivityAt: activityAt,
    createdAt: env.at,
    revision: 1,
    archivedAt: null,
  };
  return { row, sources, flags: [], overrides: [], events };
}

function edit(ctx, input, env) {
  requireRevision(ctx.row, input.expectedRevision);
  const events = [];
  let row = { ...ctx.row };
  if (input.name != null && input.name !== row.name) {
    const name = assertName(input.name);
    events.push(event(env, row.id, { kind: 'renamed', from: row.name, to: name }));
    row.name = name;
  }
  if (input.summary != null && input.summary !== row.summary) {
    const summary = assertSummary(input.summary);
    events.push(event(env, row.id, { kind: 'summary-edited' }));
    row.summary = summary;
    row.summaryMeta = { author: env.actor, at: env.at };
  }
  if (input.priority != null && input.priority !== row.priority) {
    if (!PRIORITIES.includes(input.priority)) throw validation('Priorité invalide.', 'priority');
    events.push(event(env, row.id, { kind: 'priority', from: row.priority, to: input.priority }));
    row.priority = input.priority;
  }
  if (!events.length) return { noop: true };
  return { row: touch(row, env), events };
}

function setStatus(ctx, input, env) {
  requireRevision(ctx.row, input.expectedRevision);
  if (!PROJECT_STATUSES.includes(input.status)) throw validation('Statut invalide.', 'status');
  if (input.status === ctx.row.status) return { noop: true };
  const row = { ...touch(ctx.row, env), status: input.status };
  return {
    row,
    events: [event(env, row.id, { kind: 'status', from: ctx.row.status, to: input.status })],
  };
}

/**
 * A board drop. In-column order is computed (priority, then last activity,
 * then id). There is no index argument.
 */
function reorder(ctx, input, env) {
  if (Object.prototype.hasOwnProperty.call(input, 'index')) {
    throw validation('La position dans la colonne n’est pas enregistrée.', 'index');
  }
  return setStatus(ctx, input, env);
}

function addLabel(ctx, input, env) {
  requireRevision(ctx.row, input.expectedRevision);
  const { key, label } = slugify(input.label);
  if (ctx.flags.some((f) => f.kind === 'label' && f.key === key)) return { noop: true };
  const flag = { kind: 'label', key, label, addedBy: env.actor, addedAt: env.at };
  return {
    row: touch(ctx.row, env),
    flags: ctx.flags.concat(flag),
    events: [event(env, ctx.row.id, { kind: 'flag-added', flagKind: 'label', key, label })],
  };
}

function setBlocked(ctx, input, env) {
  requireRevision(ctx.row, input.expectedRevision);
  if (ctx.flags.some((f) => f.kind === 'risk' && f.key === 'blocked' && f.clearedAt == null)) return { noop: true };
  const flags = ctx.flags.filter((f) => !(f.kind === 'risk' && f.key === 'blocked'));
  flags.push({
    kind: 'risk',
    key: 'blocked',
    severity: RISK_SEVERITY.blocked,
    origin: 'manual',
    evidence: { kind: 'manual', ref: 'blocked', at: env.at },
    raisedAt: env.at,
    clearedAt: null,
    ack: null,
  });
  return {
    row: bumpOnly(ctx.row),
    flags,
    events: [
      event(env, ctx.row.id, { kind: 'flag-added', flagKind: 'risk', key: 'blocked', label: riskLabel('blocked') }),
      event(env, ctx.row.id, { kind: 'risk-raised', key: 'blocked', severity: 'high' }),
    ],
  };
}

function addFlag(ctx, input, env) {
  if (input.kind === 'label') return addLabel(ctx, input, env);
  if (input.kind === 'risk' && input.key === 'blocked') return setBlocked(ctx, input, env);
  throw validation('Ce drapeau n’est pas modifiable.', 'kind', 'flag-not-writable');
}

function removeFlag(ctx, input, env) {
  requireRevision(ctx.row, input.expectedRevision);
  if (input.kind === 'priority') throw validation('Ce drapeau ne peut pas être retiré.', 'flag', 'flag-not-removable');
  const flag = ctx.flags.find((f) => f.kind === input.kind && f.key === input.key && (f.kind !== 'risk' || f.clearedAt == null));
  if (!flag) throw notFound('Drapeau introuvable.');
  if (flag.kind === 'feature' || (flag.kind === 'risk' && (flag.key !== 'blocked' || flag.origin !== 'manual'))) {
    throw validation('Ce drapeau ne peut pas être retiré.', 'flag', 'flag-not-removable');
  }
  if (flag.kind !== 'label' && flag.kind !== 'risk') {
    throw validation('Ce drapeau ne peut pas être retiré.', 'flag', 'flag-not-removable');
  }
  const flags = ctx.flags.filter((f) => f !== flag);
  return {
    row: flag.kind === 'label' ? touch(ctx.row, env) : bumpOnly(ctx.row),
    flags,
    events: [event(env, ctx.row.id, { kind: 'flag-removed', flagKind: flag.kind, key: flag.key })],
  };
}

function ackRisk(ctx, input, env) {
  requireRevision(ctx.row, input.expectedRevision);
  if (typeof input.ack !== 'boolean') throw validation('Accusé de réception invalide.', 'ack');
  const flag = ctx.flags.find((f) => f.kind === 'risk' && f.key === input.key);
  if (!flag || flag.clearedAt != null) throw notFound('Risque introuvable.');
  const acked = flag.ack != null;
  if (input.ack === acked) return { noop: true };
  const next = {
    ...flag,
    ack: input.ack ? { by: env.actor, at: env.at } : null,
  };
  const flags = ctx.flags.map((f) => (f === flag ? next : f));
  const kind = input.ack ? 'risk-acked' : 'risk-unacked';
  return {
    row: bumpOnly(ctx.row),
    flags,
    events: [event(env, ctx.row.id, { kind, key: flag.key })],
  };
}

function linkSource(ctx, input, env) {
  requireRevision(ctx.row, input.expectedRevision);
  const parsed = parseSourceInput(input.source || input, sourceOptions(env));
  const refKey = refKeyOf(parsed.kind, parsed.ref);
  if (ctx.sources.some((s) => s.kind === parsed.kind && refKeyOf(s.kind, s.ref) === refKey)) return { noop: true };
  if (parsed.kind === 'github' && input.takenById && input.takenById !== ctx.row.id) throw sourceInUse();
  const source = {
    id: env.mint('src'),
    addedAt: env.at,
    addedBy: env.actor,
    kind: parsed.kind,
    ref: parsed.ref,
  };
  return {
    row: touch(ctx.row, env),
    sources: ctx.sources.concat(source),
    events: [event(env, ctx.row.id, { kind: 'source-linked', source: parsed.kind, ref: displayRef(parsed.kind, parsed.ref) })],
  };
}

function unlinkSource(ctx, input, env) {
  requireRevision(ctx.row, input.expectedRevision);
  const source = ctx.sources.find((s) => s.id === input.sourceId);
  if (!source) throw notFound('Source introuvable.');
  return {
    row: touch(ctx.row, env),
    sources: ctx.sources.filter((s) => s !== source),
    events: [event(env, ctx.row.id, {
      kind: 'source-unlinked',
      source: source.kind,
      ref: displayRef(source.kind, source.ref),
    })],
    unlinked: source,
  };
}

function setArchived(ctx, input, env) {
  requireRevision(ctx.row, input.expectedRevision);
  if (typeof input.archived !== 'boolean') throw validation('Archivage invalide.', 'archived');
  const archived = input.archived;
  if (archived === (ctx.row.archivedAt != null)) return { noop: true };
  if (!archived && input.takenById && input.takenById !== ctx.row.id) throw sourceInUse();
  return {
    row: bumpOnly({ ...ctx.row, archivedAt: archived ? env.at : null }),
    events: [event(env, ctx.row.id, { kind: archived ? 'archived' : 'restored' })],
  };
}

function setPersonOverride(ctx, input, env) {
  requireRevision(ctx.row, input.expectedRevision);
  if (!input.person || !input.personId) throw notFound('Personne introuvable.');
  if (input.role != null && (typeof input.role !== 'string' || input.role.length < 1 || input.role.length > 80)) {
    throw validation('Rôle invalide.', 'role');
  }
  const prev = ctx.overrides.find((o) => o.personId === input.personId);
  const next = {
    personId: input.personId,
    role: input.role === undefined ? (prev && prev.role) || null : input.role,
    hidden: input.hidden === undefined ? Boolean(prev && prev.hidden) : Boolean(input.hidden),
    added: prev ? prev.added : !input.derived,
  };
  if (input.added === true) next.added = true;
  const same = prev
    && prev.role === next.role
    && Boolean(prev.hidden) === next.hidden
    && Boolean(prev.added) === next.added;
  if (same) return { noop: true };
  const overrides = ctx.overrides.filter((o) => o.personId !== input.personId).concat(next);
  return {
    row: bumpOnly(ctx.row),
    overrides,
    events: [event(env, ctx.row.id, {
      kind: 'people-override', personId: next.personId, role: next.role, hidden: next.hidden,
    })],
  };
}

function applyRisks(ctx, input, env) {
  const plan = input.plan || { raise: [], clear: [], refresh: [] };
  if (!plan.raise.length && !plan.clear.length && !plan.refresh.length) return { noop: true };
  let flags = ctx.flags.slice();
  const events = [];
  for (const item of plan.raise) {
    flags = flags.filter((f) => !(f.kind === 'risk' && f.key === item.key));
    const flag = {
      kind: 'risk',
      key: item.key,
      severity: item.severity,
      origin: 'auto',
      evidence: item.evidence,
      raisedAt: env.at,
      clearedAt: null,
      ack: null,
    };
    if (item.staleDays != null) flag.staleDays = item.staleDays;
    flags.push(flag);
    events.push(event(env, ctx.row.id, { kind: 'risk-raised', key: item.key, severity: item.severity }));
  }
  for (const key of plan.clear) {
    flags = flags.map((f) => (f.kind === 'risk' && f.key === key && f.clearedAt == null
      ? { ...f, clearedAt: env.at }
      : f));
    events.push(event(env, ctx.row.id, { kind: 'risk-cleared', key }));
  }
  let cardChanged = plan.raise.length > 0 || plan.clear.length > 0;
  for (const item of plan.refresh) {
    flags = flags.map((f) => {
      if (f.kind !== 'risk' || f.key !== item.key || f.clearedAt != null) return f;
      const next = { ...f, evidence: item.evidence };
      if (item.staleDays != null) next.staleDays = item.staleDays;
      if (item.unack) next.ack = null;
      return next;
    });
    if (item.unack) {
      cardChanged = true;
      events.push(event(env, ctx.row.id, { kind: 'risk-unacked', key: item.key }));
    }
  }
  // A risk write is not project activity: it must not reset the stale clock.
  return {
    row: cardChanged ? bumpOnly(ctx.row) : ctx.row,
    flags,
    events,
  };
}

function ingestActivity(ctx, input, env) {
  const seen = ctx.dedupeKeys || new Set();
  const events = [];
  const push = (dedupeKey, fields) => {
    if (seen.has(dedupeKey)) return;
    seen.add(dedupeKey);
    events.push(event(env, ctx.row.id, { ...fields, dedupeKey }));
  };
  for (const c of input.commits || []) {
    push(`commit:${c.sha}`, { kind: 'commit', branch: c.branch, shas: [c.sha], at: c.at });
  }
  for (const run of input.flowRuns || []) {
    push(`flow-run:${run.runId}`, {
      kind: 'flow-run', jobId: run.jobId, runId: run.runId, status: run.status, durationMs: run.durationMs ?? null, at: run.at,
    });
  }
  for (const run of input.cronRuns || []) {
    push(`cron-run:${run.runId}`, {
      kind: 'cron-run', jobId: run.jobId, runId: run.runId, status: run.status, durationMs: run.durationMs ?? null, at: run.at,
    });
  }
  for (const session of input.sessions || []) {
    push(`session:${session.sessionKey}@${session.at}`, {
      kind: 'session', sessionKey: session.sessionKey, messages: session.messages, tokens: session.tokens, at: session.at,
    });
  }
  if (!events.length) return { noop: true };
  return {
    row: { ...ctx.row, lastActivityAt: activityAtFromHistory(events, ctx.row.lastActivityAt) },
    events,
  };
}

function replaceFeatureFlags(ctx, input, env) {
  const incoming = (input.features || []).map((f) => ({
    kind: 'feature',
    key: f.key,
    state: f.state,
    foundIn: { path: f.foundIn.path, line: f.foundIn.line ?? null },
    scannedAt: env.at,
  }));
  const keys = new Set();
  for (const f of incoming) {
    if (keys.has(f.key)) throw validation('Drapeau de fonctionnalité en double.', 'flag');
    keys.add(f.key);
  }
  const previous = ctx.flags.filter((f) => f.kind === 'feature');
  const sig = (list) => list.map((f) => `${f.key}\0${f.state}`).sort().join('\n');
  const flags = ctx.flags.filter((f) => f.kind !== 'feature').concat(incoming);
  if (sig(previous) === sig(incoming)) {
    const placed = (f) => `${f.foundIn.path}:${f.foundIn.line ?? ''}`;
    const samePlace = previous.length === incoming.length && previous.every((f) => {
      const next = incoming.find((g) => g.key === f.key);
      return next && placed(next) === placed(f);
    });
    if (samePlace) return { noop: true };
    return { row: ctx.row, flags, events: [] };
  }
  const snapshot = incoming
    .map((f) => ({ key: f.key, state: f.state }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return {
    row: bumpOnly(ctx.row),
    flags,
    events: [event(env, ctx.row.id, { kind: 'flags-updated', flags: snapshot })],
  };
}

function appendHistory(ctx, input, env) {
  requireRevision(ctx.row, input.expectedRevision);
  if (!TIMMY_HISTORY_KINDS.includes(input.kind)) throw validation('Cet événement n’est pas ouvert à Timmy.', 'kind');
  const dedupeKey = input.dedupeKey || null;
  if (dedupeKey && ctx.dedupeKeys && ctx.dedupeKeys.has(dedupeKey)) return { noop: true };
  const at = input.eventAt || env.at;
  const fields = { kind: input.kind, dedupeKey, at };
  if (input.kind === 'commit') {
    fields.branch = input.branch;
    fields.shas = input.shas;
  } else if (input.kind === 'flow-run' || input.kind === 'cron-run') {
    fields.jobId = input.jobId;
    fields.runId = input.runId;
    fields.status = input.status;
    fields.durationMs = input.durationMs ?? null;
  } else if (input.kind === 'session') {
    fields.sessionKey = input.sessionKey;
    fields.messages = input.messages;
    fields.tokens = input.tokens;
  } else {
    fields.action = input.action;
    fields.subjectPersonId = input.subjectPersonId ?? null;
    fields.note = input.note ?? '';
  }
  const ev = event(env, ctx.row.id, fields);
  return {
    row: { ...ctx.row, lastActivityAt: activityAtFromHistory([ev], ctx.row.lastActivityAt) },
    events: [ev],
  };
}

function importCandidate(input, env) {
  const patch = createProject({
    name: input.name,
    status: input.status,
    priority: input.priority || 'P2',
    summary: input.summary || '',
    sources: input.sources,
    activityAt: input.activityAt,
    takenGithub: input.takenGithub,
  }, env);
  for (const raw of input.labels || []) {
    const { key, label } = slugify(raw.label || raw.key || raw);
    if (patch.flags.some((f) => f.kind === 'label' && f.key === key)) continue;
    patch.flags.push({ kind: 'label', key, label, addedBy: env.actor, addedAt: env.at });
    patch.events.push(event(env, patch.row.id, { kind: 'flag-added', flagKind: 'label', key, label }));
  }
  return patch;
}

function bindEnv(repo, input) {
  const at = input.at ?? repo.now();
  const actor = parse(actorSchema, resolveActor(input.actor, {
    ownerPersonId: repo.ownerPersonId,
    component: input.component,
    persons: typeof repo.listPersons === 'function' ? repo.listPersons() : [],
  }), 'Acteur invalide.');
  return {
    at,
    actor,
    mint: (prefix) => repo.mint(prefix),
    githubOwners: repo.githubOwners,
    workspaceRootIds: repo.workspaceRootIds === true,
    workspaceRoots: repo.workspaceRoots || [],
  };
}

function sourceOptions(env) {
  return {
    githubOwners: env.githubOwners,
    workspaceRootIds: env.workspaceRootIds,
    workspaceRoots: env.workspaceRoots,
  };
}

module.exports = {
  createProject, edit, setStatus, reorder, addLabel, addFlag, setBlocked, removeFlag, ackRisk,
  linkSource, unlinkSource, setArchived, setPersonOverride, applyRisks, ingestActivity,
  replaceFeatureFlags, appendHistory, importCandidate, bindEnv,
  movesActivityClock, activityAtFromHistory,
};
