'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Worker } = require('node:worker_threads');
const safeFs = require('../../ops/safe-fs');
const { Team, TeamMember, Task, Review, TeamMessage } = require('../../model');

const LIMITS = Object.freeze({ tasks: 5000, inboxFiles: 2000, directoryEntries: 10_000, taskBytes: 1024 * 1024, taskTitle: 2048,
  rootBytes: 8 * 1024 * 1024, inboxLinesPerMember: 100_000, lineBytes: 256 * 1024, taskHistory: 5000, taskReviews: 2000,
  memberRecords: 2000, memberRecordBytes: 64 * 1024 });
const TASK_FILE = /^T-[A-Za-z0-9][A-Za-z0-9-]{0,39}\.json$/;
const MEMBER_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}\.jsonl$/;
const MEMBER_RECORD_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}\.json$/;
// agent-team-pm persists stable UUIDs as 32 lowercase hex digits (without
// separators), and marks pane session references with kind "id".
const MEMBER_ID = /^member:(?:[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i;
const STATES = new Set(['open', 'claimed', 'working', 'review', 'done', 'blocked']);
const VERDICTS = new Set(['go', 'no-go', 'pending', 'unknown']);
const WORKER_TIMEOUT_MS = 30_000;
const MAX_WORKER_RESULT_BYTES = 16 * 1024 * 1024;
const STALE_RETENTION_MS = 120_000;
const DEFAULT_POLL_INTERVAL_MS = 10_000;
const MIN_POLL_INTERVAL_MS = 5_000;
const MAX_POLL_INTERVAL_MS = 60_000;

class TeamStoreReadError extends Error {
  constructor(code) { super(code); this.name = 'TeamStoreReadError'; this.code = code; }
}

function digest(value) { return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 32); }
function opaque(prefix, value) { return `${prefix}_${digest(value)}`; }
function text(value, max, { allowEmpty = true } = {}) {
  if (typeof value !== 'string' || value.length > max || value.includes('\0')) return null;
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return allowEmpty || cleaned ? cleaned : null;
}
function timestamp(value) {
  if (value == null) return null;
  const iso = typeof value === 'string' && value.length <= 64 && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?$/.test(value)
    ? `${value}Z` : value;
  const parsed = typeof value === 'number' && Number.isSafeInteger(value) ? value : typeof iso === 'string' && iso.length <= 64 ? Date.parse(iso) : NaN;
  return Number.isSafeInteger(parsed) && parsed >= Date.UTC(2020, 0, 1) && parsed < Date.UTC(2100, 0, 1) ? parsed : null;
}
function checkTimestamp(value, nullable = true) {
  const result = timestamp(value);
  if (result == null && !(nullable && value == null)) throw new TeamStoreReadError('invalid_store');
  return result;
}
function sourceStatusShape(root, parents) { return { root, parents }; }

function checkJsonDepth(textValue) {
  let depth = 0, quoted = false, escape = false;
  for (const ch of textValue) {
    if (quoted) {
      if (escape) escape = false;
      else if (ch === '\\') escape = true;
      else if (ch === '"') quoted = false;
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === '{' || ch === '[') { if (++depth > 32) throw new TeamStoreReadError('depth_limit'); }
    else if (ch === '}' || ch === ']') depth--;
  }
}

function parseJson(textValue) {
  checkJsonDepth(textValue);
  try { return JSON.parse(textValue); } catch (_) { throw new TeamStoreReadError('invalid_store'); }
}

function directorySnapshot(dir, root, fsx = fs) {
  const st = fsx.lstatSync(dir, { bigint: true });
  if (!st.isDirectory() || st.isSymbolicLink()) throw new TeamStoreReadError('unsafe_root');
  const parents = safeFs.capture(dir, fsx).chain;
  if (!parents.some(row => row.path === root)) throw new TeamStoreReadError('unsafe_root');
  return sourceStatusShape(dir, parents);
}

function listEntries(dir, root, maxEntries, fsx = fs) {
  let rootDir;
  try { rootDir = directorySnapshot(dir, root, fsx); }
  catch (error) { if (error.code === 'ENOENT') return { names: [], snapshot: null }; throw error; }
  const names = [];
  const handle = fsx.opendirSync(dir);
  try {
    for (;;) {
      const entry = handle.readSync();
      if (!entry) break;
      if (names.length >= maxEntries) throw new TeamStoreReadError('entry_limit');
      names.push({ name: entry.name, file: entry.isFile(), directory: entry.isDirectory(), symlink: entry.isSymbolicLink() });
    }
  } finally { handle.closeSync(); }
  const after = directorySnapshot(dir, root, fsx);
  if (!after.parents.every((p, i) => rootDir.parents[i] && p.dev === rootDir.parents[i].dev && p.ino === rootDir.parents[i].ino)) {
    throw new TeamStoreReadError('unsafe_root');
  }
  return { names, snapshot: after };
}

function optionalText(value, max) {
  if (value == null) return null;
  const parsed = text(value, max);
  if (parsed == null) throw new TeamStoreReadError('invalid_store');
  return parsed;
}

function parseReviewers(value) {
  if (value == null) return [];
  const names = Array.isArray(value) ? value : value && typeof value === 'object' && !Array.isArray(value) ? Object.keys(value) : null;
  if (!names || names.length > 200) throw new TeamStoreReadError('invalid_store');
  const unique = new Set();
  for (const name of names) {
    const cleaned = text(name, 120, { allowEmpty: false });
    if (!cleaned) throw new TeamStoreReadError('invalid_store');
    unique.add(cleaned);
  }
  if (!Array.isArray(value)) for (const verdict of Object.values(value)) {
    if (verdict == null) continue; // the team store uses null for a reviewer who has not responded yet
    if (typeof verdict !== 'string' || !['go', 'no-go', 'pending', 'unknown'].includes(verdict)) throw new TeamStoreReadError('invalid_store');
  }
  return [...unique];
}

function parseTask(rawText, filenameId) {
  const value = parseJson(rawText);
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.id !== filenameId ||
      typeof value.title !== 'string' || !text(value.title, LIMITS.taskTitle) ||
      !Array.isArray(value.after) || value.after.length > 100 || !Array.isArray(value.history) || value.history.length > LIMITS.taskHistory ||
      value.reviews != null && (!Array.isArray(value.reviews) || value.reviews.length > LIMITS.taskReviews)) throw new TeamStoreReadError('invalid_store');
  if (!STATES.has(value.state) || value.prio != null && (!Number.isInteger(value.prio) || value.prio < 0 || value.prio > 3)) {
    throw new TeamStoreReadError('unsupported_store');
  }
  const owner = value.owner == null ? null : text(value.owner, 120, { allowEmpty: false });
  if (value.owner != null && !owner) throw new TeamStoreReadError('invalid_store');
  const createdBy = optionalText(value.created_by, 120);
  const commit = optionalText(value.commit, 160);
  const brief = optionalText(value.brief, 4096);
  const report = optionalText(value.report, 4096);
  const createdAt = checkTimestamp(value.created, false);
  const updatedAt = value.updated == null ? createdAt : checkTimestamp(value.updated, false);
  const reviewers = parseReviewers(value.reviewers);
  const sourceReviews = value.reviews || [];
  const reviews = [];
  for (const dependency of value.after) if (!text(dependency, 64, { allowEmpty: false })) throw new TeamStoreReadError('invalid_store');
  let unknownFields = Object.keys(value).filter(key => !['id', 'title', 'state', 'owner', 'prio', 'brief', 'after', 'reviewers', 'created_by', 'created', 'commit', 'report', 'history', 'updated', 'reviews'].includes(key)).length;
  for (const event of value.history) {
    if (!event || typeof event !== 'object' || Array.isArray(event) || !text(event.by, 120, { allowEmpty: false }) ||
        !text(event.event, 2048, { allowEmpty: false })) throw new TeamStoreReadError('invalid_store');
    checkTimestamp(event.ts, false);
    unknownFields += Object.keys(event).filter(key => !['ts', 'by', 'event'].includes(key)).length;
  }
  for (let index = 0; index < sourceReviews.length; index++) {
    const source = sourceReviews[index];
    const reviewer = source && typeof source === 'object' && !Array.isArray(source) ? text(source.by, 120, { allowEmpty: false }) : null;
    if (!reviewer) throw new TeamStoreReadError('invalid_store');
    // Review notes are private source text and are never projected. Accept
    // empty or long notes written by the team CLI, bounded by the task file cap.
    if (source.note != null && (typeof source.note !== 'string' || source.note.length > LIMITS.taskBytes || source.note.includes('\0'))) {
      throw new TeamStoreReadError('invalid_store');
    }
    unknownFields += Object.keys(source).filter(key => !['ts', 'by', 'verdict', 'note', 'report', 'commit'].includes(key)).length;
    const verdict = source.verdict == null ? 'pending' : VERDICTS.has(source.verdict) ? source.verdict : 'unknown';
    const at = checkTimestamp(source.ts, true);
    const pathValue = optionalText(source.report, 4096);
    reviews.push({ by: reviewer, verdict, createdAt: at, reportPresent: pathValue != null && pathValue !== '', ordinal: index });
  }
  if (value.reviewers && !Array.isArray(value.reviewers)) {
    for (const [reviewer, verdict] of Object.entries(value.reviewers)) if (verdict == null) {
      reviews.push({ by: text(reviewer, 120, { allowEmpty: false }), verdict: 'pending', createdAt: updatedAt, reportPresent: false, ordinal: reviews.length });
    }
  }
  const allReviewers = [...new Set([...reviewers, ...reviews.map(review => review.by)])];
  const people = new Set([createdBy, owner, ...allReviewers].filter(Boolean));
  return { id: filenameId, title: text(value.title, LIMITS.taskTitle), state: value.state, priority: value.prio ?? null, owner,
    reviewers: allReviewers, createdBy, createdAt, updatedAt, commit, reportPresent: report != null && report !== '', briefPresent: brief != null && brief !== '', reviews, people,
    unknownFields };
}

function parseInboxFile(rawText, filenameMember) {
  const complete = rawText.endsWith('\n');
  const lines = rawText.split('\n');
  if (!complete) lines.pop(); // Writer may be in the middle of its final append.
  if (lines.length > LIMITS.inboxLinesPerMember) throw new TeamStoreReadError('line_limit');
  const messages = []; let unknownFields = 0;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (!line) continue;
    if (Buffer.byteLength(line) > LIMITS.lineBytes) throw new TeamStoreReadError('line_limit');
    const value = parseJson(line);
    if (!value || typeof value !== 'object' || Array.isArray(value) || !text(value.from, 120, { allowEmpty: false }) ||
        value.to != null && !text(value.to, 120, { allowEmpty: false }) || typeof value.text !== 'string' || value.text.length > LIMITS.lineBytes ||
        value.task != null && !text(value.task, 64, { allowEmpty: false })) throw new TeamStoreReadError('invalid_store');
    unknownFields += Object.keys(value).filter(key => !['ts', 'from', 'to', 'text', 'task'].includes(key)).length;
    messages.push({ index, filenameMember, from: text(value.from, 120), to: value.to == null ? null : text(value.to, 120),
      task: value.task == null ? null : text(value.task, 64),
      createdAt: checkTimestamp(value.ts, false), bodyPresent: value.text.length > 0 });
  }
  return { messages, unknownFields };
}

function parseMemberRecord(rawText, filename) {
  const value = parseJson(rawText);
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      !MEMBER_ID.test(value.id || '') ||
      !text(value.name, 120, { allowEmpty: false }) || value.role != null && !text(value.role, 80, { allowEmpty: false }) ||
      value.runtime != null && !text(value.runtime, 64, { allowEmpty: false }) ||
      value.herdrPane != null && !text(value.herdrPane, 256, { allowEmpty: false }) ||
      value.session != null && (!value.session || typeof value.session !== 'object' || Array.isArray(value.session) ||
        !text(value.session.source, 80, { allowEmpty: false }) || !['agent_session', 'id'].includes(value.session.kind) ||
        !text(value.session.value, 1024, { allowEmpty: false })) ||
      value.spawnedBy != null && !MEMBER_ID.test(value.spawnedBy) ||
      value.registered != null && timestamp(value.registered) == null || value.updated != null && timestamp(value.updated) == null) {
    throw new TeamStoreReadError('invalid_store');
  }
  const roleLabel = value.role == null ? null : text(value.role, 80, { allowEmpty: false });
  // This adapter owns the native role vocabulary. Core consumers see only the
  // canonical leadership kind and a bounded source label for display.
  const roleKind = roleLabel == null ? 'unknown' : /^pm$/i.test(roleLabel) || /^lead(?:er)?$/i.test(roleLabel) ? 'lead' : 'member';
  const runtime = text(value.runtime, 64, { allowEmpty: false });
  // The team skill uses `claude`; the adapter identity is claude-code.
  return { id: value.id, name: text(value.name, 120, { allowEmpty: false }), roleKind, roleLabel, runtime: runtime === 'claude' ? 'claude-code' : runtime,
    herdrPane: text(value.herdrPane, 256, { allowEmpty: false }), session: value.session ? { source: text(value.session.source, 80, { allowEmpty: false }),
      kind: text(value.session.kind, 80, { allowEmpty: false }), value: text(value.session.value, 1024, { allowEmpty: false }) } : null,
    spawnedBy: value.spawnedBy || null, registered: timestamp(value.registered), updated: timestamp(value.updated),
    unknownFields: Object.keys(value).filter(key => !['id', 'name', 'role', 'runtime', 'herdrPane', 'session', 'spawnedBy', 'registered', 'updated'].includes(key)).length };
}

function projectSnapshot({ root, label = null, now = () => Date.now(), fsx = fs, includeInbox = false } = {}) {
  if (!root || typeof root !== 'string' || root.includes('\0')) throw new TeamStoreReadError('root_not_configured');
  const rootPath = safeFs.canonicalPath(path.resolve(root));
  const rootStat = fsx.lstatSync(rootPath, { bigint: true });
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new TeamStoreReadError('unsafe_root');
  const rootParents = safeFs.capture(rootPath, fsx).chain;
  const rootSnapshot = sourceStatusShape(rootPath, rootParents);
  const storeId = opaque('store', ['agent-team-pm', path.resolve(root), String(rootStat.dev), String(rootStat.ino)]);
  const teamId = opaque('team', [storeId, 'default']);
  const teamLabel = text(label, 160, { allowEmpty: false }) || 'Team';
  const tasksDir = path.join(rootPath, 'tasks'), inboxDir = path.join(rootPath, 'inbox'), membersDir = path.join(rootPath, 'members');
  const taskListing = listEntries(tasksDir, rootPath, LIMITS.directoryEntries, fsx);
  // Inbox records contain arbitrary message bodies. Do not even enumerate that
  // directory unless the owner explicitly enables message-metadata ingestion.
  const inboxListing = includeInbox ? listEntries(inboxDir, rootPath, LIMITS.directoryEntries, fsx) : { names: [], snapshot: null };
  const memberListing = listEntries(membersDir, rootPath, LIMITS.directoryEntries, fsx);
  const snapshots = [rootSnapshot, taskListing.snapshot, inboxListing.snapshot, memberListing.snapshot].filter(Boolean);
  if (taskListing.names.some(entry => TASK_FILE.test(entry.name) && !entry.file) ||
      inboxListing.names.some(entry => MEMBER_FILE.test(entry.name) && !entry.file) ||
      memberListing.names.some(entry => MEMBER_RECORD_FILE.test(entry.name) && !entry.file)) throw new TeamStoreReadError('unsafe_file');
  const taskEntries = taskListing.names.filter(entry => entry.file && TASK_FILE.test(entry.name)).sort((a, b) => a.name.localeCompare(b.name));
  const inboxEntries = inboxListing.names.filter(entry => entry.file && MEMBER_FILE.test(entry.name)).sort((a, b) => a.name.localeCompare(b.name));
  const memberEntries = memberListing.names.filter(entry => entry.file && MEMBER_RECORD_FILE.test(entry.name)).sort((a, b) => a.name.localeCompare(b.name));
  if (taskEntries.length > LIMITS.tasks || inboxEntries.length > LIMITS.inboxFiles || memberEntries.length > LIMITS.memberRecords) throw new TeamStoreReadError('row_limit');

  const files = [
    ...taskEntries.map(entry => ({ entry, kind: 'task', maxBytes: LIMITS.taskBytes, file: path.join(tasksDir, entry.name) })),
    ...inboxEntries.map(entry => ({ entry, kind: 'inbox', maxBytes: LIMITS.rootBytes, file: path.join(inboxDir, entry.name) })),
    ...memberEntries.map(entry => ({ entry, kind: 'member', maxBytes: LIMITS.memberRecordBytes, file: path.join(membersDir, entry.name) })),
  ];
  let loaded;
  try { loaded = safeFs.readMany(files.map(row => ({ file: row.file, maxBytes: row.maxBytes })),
    { roots: [rootPath], rootSnapshots: snapshots, maxBytesTotal: LIMITS.rootBytes, fsx, encoding: 'utf8' }); }
  catch (error) { throw new TeamStoreReadError(error?.code === 'ENOENT' ? 'source_changed' : error?.code === 'EFSBOUND' ? 'root_limit' : 'unsafe_file'); }
  let unknownFields = 0;
  let skippedTaskCount = 0;
  let skippedMemberCount = 0;
  const sourceTasks = [];
  const sourceMessages = [];
  const sourceMembers = [];
  files.forEach((file, index) => {
    const content = loaded[index].text;
    if (file.kind === 'task') {
      try {
        const parsed = parseTask(content, file.entry.name.slice(0, -5));
        unknownFields += parsed.unknownFields; sourceTasks.push(parsed);
      } catch (error) {
        // Bad task content is isolated to that row. Resource, containment and
        // parser safety limits still fail the scan closed for the whole root.
        if (!(error instanceof TeamStoreReadError) || !['invalid_store', 'unsupported_store'].includes(error.code)) throw error;
        skippedTaskCount++;
      }
    } else if (file.kind === 'inbox') {
      const parsed = parseInboxFile(content, file.entry.name.slice(0, -6));
      sourceMessages.push(...parsed.messages); unknownFields += parsed.unknownFields;
    } else {
      try {
        const parsed = parseMemberRecord(content, file.entry.name);
        unknownFields += parsed.unknownFields; sourceMembers.push(parsed);
      } catch (error) {
        if (!(error instanceof TeamStoreReadError) || !['invalid_store', 'unsupported_store'].includes(error.code)) throw error;
        skippedMemberCount++;
      }
    }
  });
  const memberIdCounts = new Map();
  for (const member of sourceMembers) memberIdCounts.set(member.id, (memberIdCounts.get(member.id) || 0) + 1);
  const duplicateMemberCount = [...memberIdCounts.values()].reduce((total, count) => total + (count > 1 ? count : 0), 0);
  if (duplicateMemberCount) {
    skippedMemberCount += duplicateMemberCount;
    for (let index = sourceMembers.length - 1; index >= 0; index--) {
      if (memberIdCounts.get(sourceMembers[index].id) > 1) sourceMembers.splice(index, 1);
    }
  }

  const explicitByName = new Map();
  for (const member of sourceMembers) {
    const rows = explicitByName.get(member.name) || [];
    rows.push(member); explicitByName.set(member.name, rows);
  }
  const stableByName = new Map([...explicitByName].filter(([, rows]) => rows.length === 1).map(([name, rows]) => [name, rows[0].id]));
  // Names on task rows and inbox metadata are descriptive source text, not
  // stable identities. Only the member registry may assign a person ID.
  const memberId = name => explicitByName.has(name) && explicitByName.get(name).length === 1 ? stableByName.get(name) : null;
  const stableIds = new Set(sourceMembers.map(member => member.id));
  const parents = new Set(sourceMembers.map(member => member.spawnedBy).filter(Boolean));
  const members = sourceMembers.map(member => {
    const roleKind = member.roleKind === 'unknown'
      ? (member.spawnedBy ? 'member' : parents.has(member.id) ? 'lead' : 'unknown') : member.roleKind;
    const roleEvidence = member.roleKind !== 'unknown' ? 'explicit' : roleKind !== 'unknown' ? 'derived-from-structure' : 'unknown';
    return TeamMember.from({ id: member.id, teamId, name: member.name, roleKind, roleLabel: member.roleLabel,
    roleEvidence, sourceAgentName: null, runtimeKind: member.runtime, hostAgentId: null,
    parentMemberId: stableIds.has(member.spawnedBy) ? member.spawnedBy : null, status: 'active' });
  });
  const taskId = name => opaque('task', [teamId, name]);
  const reviewerMemberIds = source => [...new Set(source.reviewers.map(memberId).filter(Boolean))];
  const messagesByTask = new Map();
  const messages = [];
  for (const message of sourceMessages) {
    const tid = message.task ? taskId(message.task) : null;
    if (tid) messagesByTask.set(tid, (messagesByTask.get(tid) || 0) + 1);
    messages.push(TeamMessage.from({ id: opaque('message', [storeId, message.filenameMember, message.index]), teamId,
      taskId: tid, fromMemberId: memberId(message.from), toMemberId: message.to ? memberId(message.to) : null,
      createdAt: message.createdAt, bodyPresent: message.bodyPresent }));
  }
  const reviews = [];
  const tasks = sourceTasks.map(source => {
    const tid = taskId(source.id);
    const reviewRows = source.reviews.map(review => {
      const row = Review.from({ id: opaque('review', [storeId, source.id, review.ordinal, review.by, review.verdict]), taskId: tid,
        reviewerMemberId: memberId(review.by), verdict: review.verdict, createdAt: review.createdAt, reportPresent: review.reportPresent });
      reviews.push(row); return row;
    });
    const task = Task.from({ id: tid, teamId, title: source.title, state: source.state, priority: source.priority,
      ownerMemberId: source.owner ? memberId(source.owner) : null, reviewerMemberIds: reviewerMemberIds(source),
      createdAt: source.createdAt, updatedAt: source.updatedAt, commit: source.commit, reportPresent: source.reportPresent,
      briefPresent: source.briefPresent, messageCount: messagesByTask.get(tid) || 0 });
    return { task, reviews: reviewRows };
  });
  const team = Team.from({ id: teamId, storeId, label: teamLabel, status: 'active', observedAt: timestamp(now()) });
  if (!team || members.some(member => !member) || messages.some(message => !message) || reviews.some(review => !review) || tasks.some(row => !row.task)) {
    throw new TeamStoreReadError('invalid_store');
  }
  const snapshot = { team, members: Object.freeze(members), tasks: Object.freeze(tasks.map(row => row.task)),
    reviews: Object.freeze(reviews), messages: Object.freeze(messages), diagnostics: Object.freeze({ unknownFields, skippedTaskCount, skippedMemberCount,
      bytes: loaded.reduce((total, row) => total + row.bytes, 0), taskCount: tasks.length, messageCount: messages.length }) };
  Object.defineProperty(snapshot, 'privateMemberRefs', { enumerable: false, value: Object.freeze(Object.fromEntries(sourceMembers.map(member => [member.id, Object.freeze({
    name: member.name, herdrPane: member.herdrPane, runtime: member.runtime, session: member.session, spawnedBy: member.spawnedBy,
  })]))) });
  return Object.freeze(snapshot);
}

function scanInWorker({ root, label = null, nowMs, includeInbox = false }) {
  let cancel;
  const promise = new Promise((resolve, reject) => {
    const worker = new Worker(path.join(__dirname, 'store-reader-worker.js'), { workerData: { root, label, nowMs, includeInbox },
      env: process.env.NODE_TEST_CONTEXT ? { NODE_TEST_CONTEXT: process.env.NODE_TEST_CONTEXT } : {},
      resourceLimits: { maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 16, stackSizeMb: 2 } });
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      if (error) { void worker.terminate(); reject(error); } else { void worker.terminate(); resolve(value); }
    };
    cancel = () => finish(new TeamStoreReadError('disabled'));
    const timer = setTimeout(() => finish(new TeamStoreReadError('timeout')), WORKER_TIMEOUT_MS);
    timer.unref?.();
    worker.once('message', message => {
      if (!message || message.ok !== true || typeof message.json !== 'string' || Buffer.byteLength(message.json) > MAX_WORKER_RESULT_BYTES) {
        finish(new TeamStoreReadError(message?.error === 'timeout' ? 'timeout' : message?.error || 'read_failed')); return;
      }
      let raw;
      try { raw = JSON.parse(message.json); } catch { finish(new TeamStoreReadError('read_failed')); return; }
      const snapshot = { team: Team.from(raw.team), members: raw.members.map(TeamMember.from), tasks: raw.tasks.map(Task.from),
        reviews: raw.reviews.map(Review.from), messages: raw.messages.map(TeamMessage.from), diagnostics: raw.diagnostics };
      if (!snapshot.team || snapshot.members.includes(null) || snapshot.tasks.includes(null) || snapshot.reviews.includes(null) || snapshot.messages.includes(null)) {
        finish(new TeamStoreReadError('invalid_store')); return;
      }
      const hydrated = { ...snapshot, members: Object.freeze(snapshot.members), tasks: Object.freeze(snapshot.tasks),
        reviews: Object.freeze(snapshot.reviews), messages: Object.freeze(snapshot.messages), diagnostics: Object.freeze(snapshot.diagnostics) };
      Object.defineProperty(hydrated, 'privateMemberRefs', { enumerable: false, value: Object.freeze(raw.privateMemberRefs || {}) });
      finish(null, Object.freeze(hydrated));
    });
    worker.once('error', () => finish(new TeamStoreReadError('read_failed')));
    worker.once('exit', code => { if (code !== 0) finish(new TeamStoreReadError('read_failed')); });
  });
  promise.cancel = () => cancel?.();
  return promise;
}

function createTeamStoreReader(options = {}) {
  let current = null;
  let inFlight = null;
  let activeScan = null;
  let failures = 0;
  let nextRetryAt = 0;
  let disabled = false;
  let generation = 0;
  let lastReportedSkippedTaskCount = null;
  let lastReportedSkippedMemberCount = null;
  let timer = null;
  const now = options.now || (() => Date.now());
  const scanner = options.scan || scanInWorker;
  const unavailable = status => Object.freeze({ team: null, members: Object.freeze([]), tasks: Object.freeze([]), reviews: Object.freeze([]),
    messages: Object.freeze([]), diagnostics: Object.freeze({ status }) });
  const stale = (status, at) => {
    if (!current || at - current.team.observedAt > STALE_RETENTION_MS) { current = null; return unavailable(status); }
    const team = Team.from({ ...current.team.toJSON(), status: 'stale' });
    return Object.freeze({ ...current, team, diagnostics: Object.freeze({ ...current.diagnostics, status }) });
  };
  async function refresh() {
    if (disabled) return unavailable('unavailable');
    if (inFlight) return inFlight;
    const startedAt = now();
    if (startedAt < nextRetryAt) return stale('backoff', startedAt);
    const runGeneration = generation;
    activeScan = scanner({ root: options.root, label: options.label, nowMs: startedAt, includeInbox: options.includeInbox === true });
    inFlight = Promise.resolve(activeScan).then(snapshot => {
      if (disabled || generation !== runGeneration) return unavailable('unavailable');
      const skippedTaskCount = Number.isSafeInteger(snapshot?.diagnostics?.skippedTaskCount)
        ? Math.max(0, Math.min(5000, snapshot.diagnostics.skippedTaskCount)) : 0;
      if (skippedTaskCount > 0 && skippedTaskCount !== lastReportedSkippedTaskCount && typeof options.log === 'function') {
        // The event contains only a bounded count. Never log task IDs, contents,
        // filenames or the selected host path.
        try { options.log({ event: 'team.tasks.partial', skippedTaskCount }); } catch (_) { /* logging cannot fail ingestion */ }
      }
      lastReportedSkippedTaskCount = skippedTaskCount;
      const skippedMemberCount = Number.isSafeInteger(snapshot?.diagnostics?.skippedMemberCount)
        ? Math.max(0, Math.min(5000, snapshot.diagnostics.skippedMemberCount)) : 0;
      if (skippedMemberCount > 0 && skippedMemberCount !== lastReportedSkippedMemberCount && typeof options.log === 'function') {
        try { options.log({ event: 'team.members.partial', skippedMemberCount }); } catch (_) { /* logging cannot fail ingestion */ }
      }
      lastReportedSkippedMemberCount = skippedMemberCount;
      current = snapshot;
      failures = 0; nextRetryAt = 0;
      return snapshot;
    }).catch(error => {
      if (disabled || generation !== runGeneration) return unavailable('unavailable');
      failures++;
      nextRetryAt = now() + Math.min(60_000, 1000 * (2 ** Math.min(failures - 1, 6)));
      const code = error instanceof TeamStoreReadError ? error.code : 'read_failed';
      return stale(code === 'unsupported_store' ? 'unsupported' : code, now());
    }).finally(() => { inFlight = null; activeScan = null; });
    return inFlight;
  }

  function start({ onSnapshot = () => {}, intervalMs = DEFAULT_POLL_INTERVAL_MS } = {}) {
    if (disabled) return false;
    if (typeof onSnapshot !== 'function') throw new TypeError('onSnapshot must be a function');
    const interval = Math.max(MIN_POLL_INTERVAL_MS, Math.min(MAX_POLL_INTERVAL_MS,
      Number.isFinite(intervalMs) ? Math.trunc(intervalMs) : DEFAULT_POLL_INTERVAL_MS));
    if (timer) clearInterval(timer);
    const tick = () => { refresh().then(snapshot => { if (!disabled) onSnapshot(snapshot); }).catch(() => {}); };
    tick(); timer = setInterval(tick, interval); timer.unref?.();
    return interval;
  }
  function stop() { if (timer) clearInterval(timer); timer = null; }
  function disable() { disabled = true; generation++; stop(); activeScan?.cancel?.(); current = null; nextRetryAt = 0; }
  function enable() { disabled = false; nextRetryAt = 0; }
  return Object.freeze({ refresh, start, stop, disable, enable, get current() { return current; }, get enabled() { return !disabled; }, get failureCount() { return failures; } });
}

module.exports = { createTeamStoreReader, projectSnapshot, TeamStoreReadError, LIMITS, WORKER_TIMEOUT_MS, STALE_RETENTION_MS,
  DEFAULT_POLL_INTERVAL_MS, MIN_POLL_INTERVAL_MS, MAX_POLL_INTERVAL_MS };
