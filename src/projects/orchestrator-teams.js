'use strict';

// Projects can be contributed by any canonical orchestrator source. This
// projection deliberately consumes only the joined canonical snapshot; it does
// not know provider IDs, store paths, or a source's native task format.
const crypto = require('node:crypto');
const { redactChatIdentity } = require('../security/redact-text');
const { buildBoardVM, projectCapabilities, projectCapabilityRows } = require('./vm');
const { teamMemberId } = require('../engine/office/placement-identity');
const { allocateMemberAppearances } = require('../engine/office/member-appearance');

const TASK_COLUMN = Object.freeze({ open: 'todo', claimed: 'in-progress', working: 'in-progress',
  review: 'in-review', done: 'shipped', blocked: 'in-progress' });
const REVIEW_VERDICTS = new Set(['go', 'no-go', 'pending', 'unknown']);

function projectId(teamId) {
  return 'teamprj_' + crypto.createHash('sha256').update(String(teamId)).digest('hex').slice(0, 24);
}

function teamRows(snapshot) {
  if (Array.isArray(snapshot?.teams)) return snapshot.teams;
  return snapshot?.team ? [snapshot.team] : [];
}

function safeName(value) {
  return redactChatIdentity(value, { role: 'conversation', maxLength: 120 }) || 'Team';
}

function brandVM(value) {
  if (!value || typeof value !== 'object') return null;
  return { mark: String(value.mark || value.monogram || '?').slice(0, 12), providerName: value.providerName || null,
    logo: value.logo || null, logoDark: value.logoDark || null, color: value.color || null, foreground: value.foreground || null };
}

function sourceDescriptorFor(capabilities = {}) {
  const declared = capabilities.projectSource;
  const id = typeof declared?.id === 'string' && /^[a-z0-9][a-z0-9._-]{0,63}$/i.test(declared.id)
    ? declared.id : 'orchestrator';
  const label = safeName(declared?.label || 'Orchestrator');
  return { id: `team-source:${id}`, kind: 'orchestrator-team', runtime: null,
    label: { key: 'project.source.team', params: { label } }, brand: null };
}

// Reuse the already resolved OfficeVM look through private, exact joins only.
// Raw member portrait fields are source-owned and are not canonical appearances.
function officePortraitForMember(member, snapshot, office, { index = null, assignMemberAppearances = null } = {}) {
  if (!member || !Array.isArray(office?.occupants)) return null;
  const stable = office.occupants.filter(row => row.memberId === member.id || teamMemberId(row) === member.id || row.id === `team-member:${member.id}`);
  const exact = stable.filter(row => row.memberId === member.id);
  const primary = exact.filter(row => row.role === 'primary' || row.role === 'main');
  const joined = exact.length === 1 ? exact[0] : primary.length === 1 ? primary[0]
    : stable.length === 1 ? stable[0] : null;
  // The exact primary row is the canonical portrait for the member it
  // identifies. The primary-look exclusion below applies to other members'
  // fallback allocation, not to this identity-preserving join.
  if (joined && (joined.role === 'primary' || joined.role === 'main') && joined.look) {
    return { look: joined.look, avatarUrl: null };
  }
  const members = Array.isArray(snapshot?.members) ? snapshot.members : [member];
  const existing = new Map();
  const canonicalLooks = new Map();
  for (const row of members) {
    const exactMatches = (office.occupants || []).filter(occupant => occupant.memberId === row.id);
    const primaryMatch = exactMatches.filter(occupant => occupant.role === 'primary' || occupant.role === 'main');
    const matching = exactMatches.length === 1 ? exactMatches[0] : primaryMatch.length === 1 ? primaryMatch[0] : null;
    if (matching?.look) { existing.set(row.id, matching.look); canonicalLooks.set(row.id, matching.look); }
  }
  const owner = office.occupants.find(row => row.role === 'primary' || row.role === 'main');
  const primaryLook = owner?.look || null;
  const ownerFloor = owner?.floorId ?? owner?.floor ?? null;
  const reservedLooks = (office.occupants || []).filter(row => row === owner || (ownerFloor !== null
    && (row.floorId ?? row.floor) === ownerFloor)).map(row => row.look).filter(Boolean);
  if (typeof assignMemberAppearances === 'function') {
    const appearances = assignMemberAppearances(members.map(row => row.id), index,
      { preferredLooks: existing, canonicalLooks, reservedLooks, primaryLook });
    const look = appearances instanceof Map ? appearances.get(member.id) : appearances?.[member.id];
    if (look) return { look, avatarUrl: null };
  }
  const safeJoinedLook = joined?.look && (!primaryLook || `${joined.look.character}/${joined.look.variant || ''}` !== `${primaryLook.character}/${primaryLook.variant || ''}`)
    ? joined.look : null;
  const look = safeJoinedLook || allocateMemberAppearances(members.map(row => row.id), index, { existing, reservedLooks, primaryLook }).get(member.id);
  return look ? { look, avatarUrl: null } : null;
}

function mapTasks(snapshot, teamId) {
  const members = new Map((snapshot?.members || []).filter(row => row?.teamId === teamId)
    .map(row => [row.id, row]));
  const reviews = new Map();
  for (const review of snapshot?.reviews || []) {
    if (!review || typeof review.taskId !== 'string') continue;
    const rows = reviews.get(review.taskId) || [];
    rows.push(review); reviews.set(review.taskId, rows);
  }
  const tasks = (snapshot?.tasks || []).filter(task => task?.teamId === teamId).map(task => {
    const column = TASK_COLUMN[task.state] || 'todo';
    const ownerRow = task.ownerMemberId ? members.get(task.ownerMemberId) : null;
    const latestByReviewer = new Map();
    for (const review of reviews.get(task.id) || []) {
      if (!review.reviewerMemberId) continue;
      const previous = latestByReviewer.get(review.reviewerMemberId);
      if (!previous || (review.createdAt || 0) >= (previous.createdAt || 0)) latestByReviewer.set(review.reviewerMemberId, review);
    }
    const reviewers = [...new Set([...(task.reviewerMemberIds || []), ...latestByReviewer.keys()])].map(id => {
      const member = members.get(id), review = latestByReviewer.get(id);
      const verdict = REVIEW_VERDICTS.has(review?.verdict) ? review.verdict : 'pending';
      return { id, name: member ? safeName(member.name) : null, verdict,
        verdictLabel: { key: `project.taskReview.${verdict}` } };
    });
    const title = redactChatIdentity(task.title, { role: 'conversation', maxLength: 240 }) || 'Task';
    return { id: task.id, title, state: task.state, column, columnLabel: { key: `projectStatus.${column}` },
      priority: Number.isInteger(task.priority) ? `P${task.priority}` : null,
      owner: ownerRow ? { id: ownerRow.id, name: safeName(ownerRow.name) } : null, reviewers,
      createdAt: task.createdAt ?? null, updatedAt: task.updatedAt ?? null,
      lastActivityAt: task.updatedAt ?? task.createdAt ?? null };
  }).sort((a, b) => (b.lastActivityAt || 0) - (a.lastActivityAt || 0) || a.id.localeCompare(b.id));
  return tasks;
}

function statusOf(tasks) {
  if (tasks.some(row => row.column === 'in-progress')) return 'in-progress';
  if (tasks.some(row => row.column === 'in-review')) return 'in-review';
  if (tasks.some(row => row.column === 'todo')) return 'todo';
  return tasks.length ? 'shipped' : 'todo';
}

function modelOf(team, members, tasks, snapshot, capabilities, options = {}) {
  const lead = members.find(row => row.roleKind === 'lead') || null;
  const label = safeName(team.label || lead?.name);
  const leadName = lead ? safeName(lead.name) : null;
  const name = leadName && leadName !== label ? `${label} · ${leadName}` : label;
  const taskTimes = tasks.map(row => row.lastActivityAt).filter(Number.isSafeInteger);
  return { id: projectId(team.id), name, status: statusOf(tasks), priority: tasks.map(row => row.priority).filter(Boolean).sort()[0] || 'P9',
    revision: Number.isSafeInteger(snapshot?.revision) && snapshot.revision >= 0 ? snapshot.revision : 0,
    archivedAt: null, readOnly: capabilities.teamTasks?.write !== true, commentCapability: 'read-only', historyCapability: 'unsupported',
    flags: tasks.some(row => row.state === 'blocked') ? [{ kind: 'risk', key: 'blocked', severity: 'high', ack: null,
      clearedAt: null, origin: 'source', staleDays: null }] : [], people: [], sources: [], repo: null, cover: null,
    createdAt: Number.isSafeInteger(team.observedAt) ? team.observedAt : 0,
    lastActivityAt: taskTimes.length ? Math.max(...taskTimes) : Number.isSafeInteger(team.observedAt) ? team.observedAt : null,
    teamProject: { teamId: team.id, label, readOnly: capabilities.teamTasks?.write !== true, taskCount: tasks.length,
      summaryLabel: { key: 'project.team.summary', params: { tasks: tasks.length } },
      roster: rosterOf(team, members, snapshot, options),
      sourceDescriptor: sourceDescriptorFor(capabilities) } };
}

// The roster is a server-shaped presentation tree. It contains stable IDs and
// explicit depth/order/parent labels so clients never reconstruct hierarchy.
function rosterOf(team, inputMembers, snapshot, options = {}) {
  const members = inputMembers.slice().sort((a, b) => (a.roleKind === 'lead' ? 0 : 1) - (b.roleKind === 'lead' ? 0 : 1)
    || String(a.id).localeCompare(String(b.id)));
  const byId = new Map(members.map(member => [member.id, member]));
  const orderById = new Map(members.map((member, order) => [member.id, order]));
  const parentOf = member => byId.has(member.parentMemberId) && member.parentMemberId !== member.id ? member.parentMemberId : null;
  const depthOf = member => {
    let depth = 0, parent = parentOf(member), visited = new Set([member.id]);
    while (parent && !visited.has(parent) && depth < members.length) {
      visited.add(parent); depth++; parent = parentOf(byId.get(parent));
    }
    return depth;
  };
  const groupId = `roster:${team.id}`;
  const rows = members.map(member => {
    const parentId = parentOf(member), parent = parentId ? byId.get(parentId) : null;
    const status = member.status || 'unknown';
    const runtimeInfo = member.runtimeKind && typeof options.runtimeOf === 'function' ? options.runtimeOf(member.runtimeKind) : null;
    const providerName = runtimeInfo?.providerName || member.brand?.providerName || member.runtimeKind || null;
    const brand = brandVM(runtimeInfo?.brand || member.brand);
    const source = member.sourceDescriptor || (member.runtimeKind ? {
      id: `runtime:${member.runtimeKind}`, kind: 'runtime', runtime: member.runtimeKind,
      label: { key: 'project.source.label', params: { label: providerName } }, brand,
    } : null);
    const portrait = typeof options.portraitForMember === 'function' ? options.portraitForMember(member, snapshot) : null;
    return {
      id: member.id, order: orderById.get(member.id), parentId, groupId, rosterDepth: depthOf(member),
      roleLabel: member.roleLabel && String(member.roleLabel).trim().toLocaleLowerCase('en') !== safeName(member.name).trim().toLocaleLowerCase('en')
        ? member.roleLabel : null, parentLabel: parent ? safeName(parent.name) : null,
      identity: { id: member.id, name: safeName(member.name), context: member.sourceAgentName ? safeName(member.sourceAgentName) : null,
        provider: providerName, teamId: team.id, parentId, status,
        statusLabel: { key: `project.memberStatus.${status}` } },
      portrait: { look: portrait?.look || null, avatarUrl: portrait?.avatarUrl || null }, source,
    };
  });
  const label = safeName(team.label || 'Team');
  return { groups: [{ id: groupId, label, order: 0, parentGroupId: null, memberIds: rows.map(row => row.id),
    memberCount: rows.length, memberCountLabel: { key: 'project.team.memberCount', params: { n: rows.length } }, depth: 0 }],
  members: rows, memberCount: rows.length, memberCountLabel: { key: 'project.team.memberCount', params: { n: rows.length } } };
}

function teamProjects(snapshot, capabilities = {}, options = {}) {
  return teamRows(snapshot).filter(team => team && typeof team.id === 'string').map(team => {
    const members = (snapshot.members || []).filter(member => member?.teamId === team.id);
    const tasks = mapTasks(snapshot, team.id);
    const model = modelOf(team, members, tasks, snapshot, capabilities, options);
    return { ...model, tasks };
  });
}

function appendTeamProjects(board, snapshot, { filter = 'all', locale = 'fr', capabilities = {} } = {}) {
  const projects = teamProjects(snapshot, capabilities);
  if (!projects.length) return board;
  const eligible = filter === 'all' ? projects : filter === 'at-risk'
    ? projects.filter(project => project.flags.some(flag => flag.kind === 'risk')) : [];
  for (const project of eligible) {
    const model = { ...project, people: [], flags: project.flags, sources: [], repo: null };
    const card = buildBoardVM([model], { filter: 'all', locale }).columns.flatMap(column => column.cards)[0];
    if (!card) continue;
    const column = board.columns.find(row => row.id === project.status);
    if (!column) continue;
    column.cards.push({ ...card, origin: 'orchestrator-team', teamProject: {
      teamId: project.teamProject.teamId, label: project.teamProject.label,
      readOnly: project.teamProject.readOnly, taskCount: project.teamProject.taskCount,
    } });
    column.cards.sort((a, b) => (a.priority || 'P9').localeCompare(b.priority || 'P9')
      || (b.lastActivityAt || 0) - (a.lastActivityAt || 0) || a.name.localeCompare(b.name));
    column.count = column.cards.length;
  }
  return board;
}

function buildTeamProjectVM(snapshot, id, capabilities = {}, options = {}) {
  const project = teamProjects(snapshot, capabilities, options).find(row => row.id === id);
  if (!project) return null;
  const columns = ['idea', 'todo', 'in-progress', 'in-review', 'shipped'].map(status => {
    const tasks = project.tasks.filter(task => task.column === status);
    return { id: status, label: { key: `projectStatus.${status}` }, count: tasks.length, tasks };
  });
  const sourceDescriptors = [project.teamProject.sourceDescriptor];
  return { id: project.id, revision: project.revision, name: project.name, status: project.status,
    priority: project.priority, archived: false, summary: null, summaryMeta: null,
    thumb: { kind: 'monogram', url: null, initials: project.name.slice(0, 2).toUpperCase(), accent: 'slate', repoLabel: null }, cover: null,
    flags: [], sources: [], repo: null, people: [], recentHistory: [], historyNextCursor: null,
    lastActivityAt: project.lastActivityAt, createdAt: project.createdAt,
    sourceDescriptors, statusLabel: { key: `projectStatus.${project.status}` }, statusTransitions: [],
    counts: { sessions: null, agents: project.teamProject.roster.memberCount, activity: project.teamProject.taskCount },
    capabilities: projectCapabilities(project),
    capabilityRows: projectCapabilityRows(projectCapabilities(project)),
    teamProject: { teamId: project.teamProject.teamId, label: project.teamProject.label,
      readOnly: project.teamProject.readOnly,
      taskCount: project.teamProject.taskCount,
      defaultColumnId: columns.find(column=>column.count>0)?.id || columns[0].id,
      mobilePeopleLabel: { key:'project.team.people.mobile',params:{n:project.teamProject.roster.memberCount} },
      summaryLabel: project.teamProject.summaryLabel,
      roster: project.teamProject.roster,
      capabilities: { comments: 'read-only', history: 'unsupported', repository: 'unsupported' }, columns } };
}

module.exports = { TASK_COLUMN, projectId, teamProjects, appendTeamProjects, buildTeamProjectVM, officePortraitForMember, sourceDescriptorFor };
