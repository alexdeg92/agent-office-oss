// Dev/test VM validation (PM, architect-23): every received VM is checked against the server's own schemas
// (public/v2/generated/vm-schemas.js). Here the strict reporter throws, so a bad VM fails the test loudly, with its path.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as vmcheck from '../../public/v2/vmcheck.js';
import { validateVM } from '../../public/v2/generated/vm-schemas.js';
import { createStream } from '../../public/v2/stream.js';

const example = (name) => JSON.parse(readFileSync(new URL(`../../docs/architecture/examples/${name}.json`, import.meta.url), 'utf8')).data;
const strict = () => vmcheck.enable({ onIssue: (where, name, issues) => { throw new Error(`${where}: ${name}: ${issues.map((i) => i.path + ' ' + i.detail).join('; ')}`); } });
afterEach(() => vmcheck.disable());

test('a VM with an undefined field fails, with the path; the contract example passes', () => {
  const h = example('health-vm');
  assert.deepEqual(validateVM('health', h), { ok: true });
  const bad = structuredClone(h);
  bad.cards[2].sub = undefined;
  const r = validateVM('health', bad);
  assert.equal(r.ok, false);
  assert.deepEqual(r.issues[0], { path: '$.cards[].sub', detail: 'undefined value' });
});

test('strict mode throws on GET (api path) and names the path', async () => {
  await strict();
  const bad = structuredClone(example('health-vm'));
  bad.level = undefined;
  assert.throws(() => vmcheck.check(vmcheck.schemaForPath('/api/v2/views/health'), bad, 'GET /api/v2/views/health'), /GET \/api\/v2\/views\/health: health: \$\.level undefined value/);
  assert.deepEqual(vmcheck.check('health', example('health-vm'), 'GET'), []);
});

test('the stream checks the topic state after the GET and after each applied delta', async () => {
  const seen = [];
  await vmcheck.enable({ onIssue: (where, name, issues) => seen.push({ where, name, path: issues[0].path }) });
  class Src { constructor() { this.l = {}; Src.last = this; } addEventListener(t, fn) { (this.l[t] ||= []).push(fn); } close() {} emit(type, f) { for (const fn of this.l[type] || []) fn({ data: JSON.stringify({ type, ...f }) }); } }
  const stream = createStream({
    openSource: () => new Src(), fetchVM: async () => ({ data: example('health-vm'), topic: { id: 'health', rev: 1 } }),
    postTopics: async () => null, postResync: async () => {}, modelVersion: 1, contractVersion: '2.4',
    check: (topic, data, where) => vmcheck.check(vmcheck.schemaForTopic(topic), data, where),
  });
  stream.subscribe('health', '/api/v2/views/health', () => {});
  stream.start();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(seen, [], 'the GET result is valid');
  Src.last.emit('hello', { streamId: 's', serverEpoch: 'e', modelVersion: 1, contractVersion: '2.4', resumed: true, topics: ['health'] });
  Src.last.emit('delta', { topic: 'health', rev: 2, baseRev: 1, ops: [{ op: 'set', path: ['level'], value: 'pas-un-niveau' }] });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].name, 'health');
  assert.equal(seen[0].path, '$.level');
  assert.match(seen[0].where, /delta health rev 2/);
  stream.stop();
});

test('paths and topics map to their schema names', () => {
  const paths = { '/api/v2/meta': 'meta', '/api/v2/me': 'me', '/api/v2/views/health': 'health', '/api/v2/views/projects?filter=at-risk': 'projects',
    '/api/v2/views/projects/prj_a': 'project', '/api/v2/views/projects/prj_a/history?cursor=x': 'history', '/api/v2/views/project-candidates': 'candidates',
    '/api/v2/views/logs?kind=cron&cursor=c': 'logs', '/api/v2/views/sessions/agent%3Amain': 'session', '/api/v2/views/skills/meteo': 'skill',
    '/api/v2/views/flows/f1': 'flow', '/api/v2/views/interlocutors/x': 'interlocutor', '/api/v2/views/chat': 'chat', '/api/v2/office/layout': 'layout',
    '/api/v2/views/office': 'office', '/api/v2/projects': null, '/api/v2/stream': null };
  for (const [p, name] of Object.entries(paths)) assert.equal(vmcheck.schemaForPath(p), name, p);
  const topics = { health: 'health', 'projects?filter=at-risk': 'projects', 'project:prj_a': 'project', 'logs?heartbeat=include&kind=cron': 'logs', 'session:agent%3Amain': 'session',
    'skill:meteo': 'skill', 'flow:f1': 'flow', 'interlocutor:x': 'interlocutor', chat: 'chat', layout: 'layout', office: 'office', prefs: 'prefs' };
  for (const [tp, name] of Object.entries(topics)) assert.equal(vmcheck.schemaForTopic(tp), name, tp);
});

test('off by default (production never loads the validator): check() does nothing', () => {
  const bad = { level: undefined };
  assert.deepEqual(vmcheck.check('health', bad, 'GET'), []);
  assert.equal(vmcheck.enabled(), false);
});
