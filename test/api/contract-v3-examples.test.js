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
const { compareShape } = require('../helpers/contract-shape');
const { TOKENS } = require('../portability/personal-literals');

const EX = path.join(__dirname, '..', '..', 'docs', 'architecture', 'examples');
const v2 = (n) => JSON.parse(fs.readFileSync(path.join(EX, n + '.json'), 'utf8'));
const v3 = (n) => JSON.parse(fs.readFileSync(path.join(EX, 'v3', n + '.json'), 'utf8'));
const V3 = fs.readdirSync(path.join(EX, 'v3')).filter((f) => f.endsWith('.json') && !f.endsWith('.types.json')).map((f) => f.slice(0, -5));

// api-v3.md D1–D8: the structural differences from 2.x, per VM (value-only changes are checked in 2.)
const SHAPE_DELTAS = {
  'office-vm': [], 'health-vm': [],
  'layout-vm': ['$.layout.data.presence: unexpected'],   // office-dev O8 (operations.md §4)
  'logs-page': ['$.items[].runtimeKind: unexpected'],
  'session-vm': ['$.runtimeKind: unexpected'],
  'access-vm': ['$.interlocutors[].channel: unexpected', '$.interlocutors[].name: null, but the example never allows null here', '$.interlocutors[].access.policy: null, but the example never allows null here'],
  'interlocutor-vm': ['$.channel: unexpected'],
  'flow-detail-vm': ['$.job.sessionTarget: missing', '$.job.wakeMode: missing', '$.job.ext: unexpected'],
  'board-vm': ['$.agent: unexpected'],
};

describe('G5 · contract 3.0 examples', () => {
  it('every v3 example is listed here, has a sidecar, and is an Ok envelope with contract 3.0 where it says so', () => {
    for (const n of V3) {
      assert.ok(n === 'meta-vm' || Object.prototype.hasOwnProperty.call(SHAPE_DELTAS, n), `${n}: list its deltas`);
      assert.ok(fs.existsSync(path.join(EX, 'v3', n + '.types.json')), `${n}: sidecar`);
      assert.ok(v3(n).data && v3(n).meta, n);
    }
    assert.equal(v3('meta-vm').data.contractVersion, '3.2'); assert.equal(v3('meta-vm').data.apiVersion, 3);
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
    const NAME = { 'meta-vm': 'meta', 'office-vm': 'office', 'logs-page': 'logs', 'session-vm': 'session', 'access-vm': 'access', 'interlocutor-vm': 'interlocutor',
      'health-vm': 'health', 'flow-detail-vm': 'flow', 'board-vm': 'projects', 'layout-vm': 'layout' };
    for (const n of V3) {
      const r = sch.validate(VM_SCHEMAS_V3[NAME[n]], v3(n).data);
      assert.deepEqual(r.ok ? [] : r.issues.filter((i) => i.severity === 'error').map((i) => i.path + ' ' + i.detail), [], n);
    }
  });

  it('3. no personal value: no portability token, no "main" id or role, no with-timmy', () => {
    const MAIN_OK = [/^\$\.manifest\./];   // the asset manifest is office-dev's opaque art data
    const walk = (v, at, out) => {
      if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${at}[${i}]`, out));
      else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, `${at}.${k}`, out);
      else if ((v === 'main' || v === 'with-timmy') && !MAIN_OK.some((re) => re.test(at))) out.push(at);
      return out;
    };
    for (const n of V3) {
      const text = JSON.stringify(v3(n));
      for (const t of TOKENS) assert.ok(!text.includes(t), `${n}: ${t}`);
      assert.deepEqual(walk(v3(n).data, '$', []), [], n);
    }
  });
});
