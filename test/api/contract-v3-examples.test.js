'use strict';
/*
 * G5 · contract 3.0 examples (docs/architecture/api-v3.md, examples/v3/). Contract first: these hold the examples to the
 * documented deltas before any server code serves them.
 *   1. each v3 example differs from its 2.x example in SHAPE only by the listed deltas (nothing else drifts);
 *   2. vocabularies: the 3.0 names only (sessionKind, occupantRole, interlocutorKind, filters), no 2.x alias;
 *   3. no personal value at all (the portability tokens, 'main' as an id or role, with-timmy).
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { compareShape, compareExample } = require('../helpers/contract-shape');
const { TOKENS } = require('../portability/personal-literals');
const CONTRACT_PERSONAL_TOKENS = [...TOKENS, ['al', 'ex'].join('')];

const EX = path.join(__dirname, '..', '..', 'docs', 'architecture', 'examples');
const v2 = (n) => JSON.parse(fs.readFileSync(path.join(EX, n + '.json'), 'utf8'));
const v3 = (n) => JSON.parse(fs.readFileSync(path.join(EX, 'v3', n + '.json'), 'utf8'));
const V3 = fs.readdirSync(path.join(EX, 'v3')).filter((f) => f.endsWith('.json') && !f.endsWith('.types.json')).map((f) => f.slice(0, -5));
// Contract-only request/error/job examples are validated by their own suite. They are
// not v2→v3 VM migrations and must not silently enter the migration/schema inventory.
const MIGRATION_V3 = ['meta-vm', 'office-vm', 'office-store-vm', 'office-palette-vm', 'health-vm', 'layout-vm', 'logs-page', 'session-vm', 'chat-vm', 'access-vm', 'interlocutor-vm', 'flow-detail-vm', 'board-vm', 'orchestrators-vm', 'teams-vm'];
const ACCESS_CONTRACT = [
  'external-access-vm', 'external-access-setup-vm', 'external-access-plan-request', 'external-access-plan',
  'external-access-checks-request', 'external-access-check-status-request', 'external-access-cancel-request',
  'external-access-check-status', 'external-access-check-status-waiting', 'external-access-error',
];
const CHAT_CONTRACT = ['chat-agents-vm', 'chat-agent-sessions-vm', 'chat-session-vm', 'chat-attachment-result', 'chat-message-request', 'chat-read-ack-result'];
const PROJECTS_CONTRACT = ['project-create-vm', 'project-kickoff-vm'];

// api-v3.md D1–D8: the structural differences from 2.x, per VM (value-only changes are checked in 2.)
const SHAPE_DELTAS = {
  'office-vm': [], 'office-store-vm': [], 'office-palette-vm': [], 'health-vm': [], 'chat-vm': [],
  'layout-vm': ['$.layout.data.presence: unexpected'],   // office-dev O8 (operations.md §4)
  'logs-page': ['$.items[].runtimeKind: unexpected'],
  'session-vm': ['$.runtimeKind: unexpected'],
  'access-vm': ['$.interlocutors[].channel: unexpected', '$.interlocutors[].name: null, but the example never allows null here', '$.interlocutors[].access.policy: null, but the example never allows null here'],
  'interlocutor-vm': ['$.channel: unexpected'],
  'flow-detail-vm': ['$.job.sessionTarget: missing', '$.job.wakeMode: missing', '$.job.ext: unexpected'],
  'board-vm': ['$.agent: unexpected', '$.controls: unexpected', '$.columns[].label: unexpected',
    '$.columns[].taskCount: unexpected', '$.columns[].summaryLabel: unexpected',
    '$.columns[].cards[].flags.visible[].removable: unexpected',
    '$.columns[].cards[].people.visible[].state: null, but the example never allows null here',
    '$.columns[].cards[].thumb.repoLabel: null, but the example never allows null here',
    '$.columns[].cards[].thumb.url: null, but the example never allows null here'],
};

describe('G5 · contract 3.0 examples', () => {
  it('every migrated v3 VM is listed with its migration sidecar; access contracts have their own registry', () => {
    for (const n of MIGRATION_V3) {
      assert.ok(fs.existsSync(path.join(EX, 'v3', n + '.types.json')), `${n}: sidecar`);
      assert.ok(v3(n).data && v3(n).meta, n);
    }
    assert.deepEqual([...V3].sort(), [...MIGRATION_V3, ...ACCESS_CONTRACT, ...CHAT_CONTRACT, ...PROJECTS_CONTRACT].sort(), 'every v3 JSON example belongs to an explicit category');
    for (const n of ACCESS_CONTRACT) assert.ok(fs.existsSync(path.join(EX, 'v3', n + '.json')), `${n}: registered access contract`);
    for (const n of CHAT_CONTRACT) assert.ok(fs.existsSync(path.join(EX, 'v3', n + '.json')), `${n}: registered chat contract`);
    for (const n of PROJECTS_CONTRACT) assert.ok(fs.existsSync(path.join(EX, 'v3', n + '.json')), `${n}: registered project contract`);
    assert.equal(v3('meta-vm').data.contractVersion, require('../../src/api/v2/envelope').CONTRACT_VERSION_V3); assert.equal(v3('meta-vm').data.apiVersion, 3);
  });

  it('1. each differs from its 2.x example in shape only by the documented deltas', () => {
    for (const [n, want] of Object.entries(SHAPE_DELTAS)) assert.deepEqual([...new Set(compareShape(v2(n).data, v3(n).data))].sort(), want.slice().sort(), n);
  });

  it('2. 3.0 vocabularies only', () => {
    const enums = v3('meta-vm').data.enums;
    const rows = v3('logs-page').data.items.concat([v3('session-vm').data]);
    for (const r of rows) {
      assert.ok(enums.sessionKind.includes(r.kind), r.kind);
      assert.equal(r.kind === 'internal', r.runtimeKind != null, `${r.kind}/${r.runtimeKind}`);
      assert.ok(r.channel === null || /^[a-z][a-z0-9-]{0,31}$/.test(r.channel) && r.channel !== 'unrecognized', String(r.channel));
    }
    for (const o of v3('office-vm').data.occupants) {
      assert.ok(enums.occupantRole.includes(o.role), o.role);
      assert.equal(o.roleLabel.key, 'occupantRole.' + o.role);
      assert.ok(o.id === 'primary' ? o.role === 'primary' : o.id.startsWith(o.role + ':'), o.id);
    }
    for (const i of v3('access-vm').data.interlocutors.concat([v3('interlocutor-vm').data])) assert.ok(enums.interlocutorKind.includes(i.kind) && i.channel, i.id);
    for (const c of v3('health-vm').data.channels) assert.ok(!c.id.startsWith('raw:'), c.id);
    for (const a of v3('layout-vm').data.layout.data.agents) assert.ok(enums.occupantRole.includes(a.match.kind), a.match.kind);
    assert.deepEqual([v3('board-vm').data.filter, v3('board-vm').data.agent], ['with-agent', 'atlas']);
    assert.ok(v3('flow-detail-vm').data.job.ext.openclaw, 'OpenClaw-only fields in the adapter bag');
  });

  it('4. every v3 example validates against the 3.0 VM schemas of the server (the runtime check of /api/v3)', () => {
    const sch = require('../../src/schema');
    const { VM_SCHEMAS_V3 } = require('../../src/api/v2/vm/schemas');
    const NAME = { 'meta-vm': 'meta', 'office-vm': 'office', 'logs-page': 'logs', 'session-vm': 'session', 'chat-vm': 'chat', 'access-vm': 'access', 'interlocutor-vm': 'interlocutor',
      'health-vm': 'health', 'flow-detail-vm': 'flow', 'board-vm': 'projects', 'layout-vm': 'layout', 'orchestrators-vm': 'orchestrators', 'teams-vm': 'teams', 'office-store-vm': 'officeStore', 'office-palette-vm': 'officePalette' };
    for (const n of MIGRATION_V3) {
      const r = sch.validate(VM_SCHEMAS_V3[NAME[n]], v3(n).data);
      assert.deepEqual(r.ok ? [] : r.issues.filter((i) => i.severity === 'error').map((i) => i.path + ' ' + i.detail), [], n);
    }
    const chatNames = { 'chat-agents-vm': 'chatAgents', 'chat-agent-sessions-vm': 'chatAgentSessions', 'chat-session-vm': 'chatSession' };
    for (const [n, name] of Object.entries(chatNames)) {
      const r = sch.validate(VM_SCHEMAS_V3[name], v3(n).data);
      assert.deepEqual(r.ok ? [] : r.issues.filter((i) => i.severity === 'error').map((i) => i.path + ' ' + i.detail), [], n);
    }
    const projectNames = { 'project-create-vm': 'projectCreate', 'project-kickoff-vm': 'projectKickoff' };
    for (const [n, name] of Object.entries(projectNames)) {
      const r = sch.validate(VM_SCHEMAS_V3[name], v3(n).data);
      assert.deepEqual(r.ok ? [] : r.issues.filter((i) => i.severity === 'error').map((i) => i.path + ' ' + i.detail), [], n);
    }
  });

  it('chat public IDs carry at least 192 bits of generated entropy and bodies stay within the UTF-8 page contract', () => {
    const ids = [];
    const walk = (value) => {
      if (Array.isArray(value)) return value.forEach(walk);
      if (value && typeof value === 'object') {
        for (const [key, child] of Object.entries(value)) {
          if (['id', 'agentId', 'teamId', 'parentId', 'sessionId', 'defaultSessionId', 'attachmentId', 'throughMessageId', 'turnId'].includes(key) && typeof child === 'string' && /^(ca|cs|ct|att|turn|msg|idem)_/.test(child)) ids.push(child);
          walk(child);
        }
      }
    };
    for (const n of [...CHAT_CONTRACT, ...PROJECTS_CONTRACT]) walk(v3(n));
    for (const id of ids) assert.match(id, /^(?:ca|cs|ct|att|turn|msg|idem)_[A-Za-z0-9_-]{32,}$/ , id);
    assert.match(fs.readFileSync(path.join(EX, 'v3', 'chat-attachment-result.json'), 'utf8'), /Content-Digest.*sha-256=:[A-Za-z0-9+/]{43}=:/);
    assert.match(v3('chat-session-vm').meta.topic.id, /^chat-session\/cs_[A-Za-z0-9_-]{32,}$/);
    assert.match(fs.readFileSync(path.join(__dirname, '..', '..', 'docs', 'architecture', 'api-v3.md'), 'utf8'), /50 messages\/page/);
  });

  it('office example enumerates the rich state labels as required map entries', () => {
    const office = v3('office-vm').data;
    assert.deepEqual(office.stateLabels.executing, { key: 'agentState.executing' });
    assert.deepEqual(office.stateLabels.blocked, { key: 'agentState.blocked' });
    assert.deepEqual(compareExample('office-vm', office, { version: 3 }), []);
    const missing = structuredClone(office); delete missing.stateLabels.executing;
    assert.ok(compareExample('office-vm', missing, { version: 3 }).some(issue => issue === '$.stateLabels.executing: missing'));
  });

  it('3. no personal value: no portability token, no "main" id or role, no with-timmy', () => {
    const MAIN_OK = [/^\$\.manifest\./];   // the asset manifest is office-dev's opaque art data
    const walk = (v, at, out) => {
      if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${at}[${i}]`, out));
      else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, `${at}.${k}`, out);
      else if ((v === 'main' || v === 'with-timmy') && !MAIN_OK.some((re) => re.test(at))) out.push(at);
      return out;
    };
    for (const n of MIGRATION_V3) {
      const text = JSON.stringify(v3(n));
      for (const t of CONTRACT_PERSONAL_TOKENS) assert.ok(!text.includes(t), `${n}: ${t}`);
      assert.deepEqual(walk(v3(n).data, '$', []), [], n);
    }
    for (const n of [...CHAT_CONTRACT, ...PROJECTS_CONTRACT]) {
      const text = JSON.stringify(v3(n));
      for (const t of CONTRACT_PERSONAL_TOKENS) assert.ok(!text.includes(t), `${n}: ${t}`);
    }
  });
});
