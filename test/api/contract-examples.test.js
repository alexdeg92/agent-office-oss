'use strict';
// Contract 2.1 (PM decision on review-07): the authoritative examples and the shape checker.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { compareShape, compareExample, loadExample, urlFields, EXAMPLES_DIR } = require('../helpers/contract-shape');

const ROOT = path.resolve(__dirname, '..', '..');
const names = fs.readdirSync(EXAMPLES_DIR).filter((f) => f.endsWith('.json') && !f.endsWith('.types.json')).map((f) => f.slice(0, -5)).sort();

describe('contract-shape checker (strict, S6.2: R8-08/09)', () => {
  const ex = (n) => JSON.parse(JSON.stringify(loadExample(n).data));
  it('reports missing, unexpected and mistyped keys with their path', () => {
    assert.deepEqual(compareShape({ a: 1, b: { c: 'x' } }, { a: 2, b: { c: 'y' } }), []);
    assert.deepEqual(compareShape({ a: 1, b: { c: 'x' } }, { a: '2', b: { d: 'y' } }).sort(), ['$.a: expected number, got string', '$.b.c: missing', '$.b.d: unexpected']);
  });
  it('null only where the example (or its sidecar) allows it; a null-only field is unmodelled unless typed', () => {
    assert.deepEqual(compareShape({ a: null, b: 'x' }, { a: { deep: 1 }, b: null }).sort(),
      ['$.a: unmodelled (the example only shows null; declare its type in the sidecar)', '$.b: null, but the example never allows null here']);
    assert.deepEqual(compareShape({ a: null, b: 'x' }, { a: 'y', b: null }, { types: { '$.a': 'string' }, nullable: ['$.b'] }), []);
    assert.deepEqual(compareShape([{ s: 'x' }, { s: null }], [{ s: null }, { s: 'z' }]), [], 'nullability inferred when the example shows both forms');
  });
  it('R8-08: the reviewer\'s consumer-breaking mutations of the real examples are all reported', () => {
    const p = ex('project-vm'); p.flags = null;
    assert.ok(compareExample('project-vm', p).some((m) => m.startsWith('$.flags: null')));
    const b = ex('board-vm'); b.columns[0].cards = [{ oops: true }];
    assert.ok(compareExample('board-vm', b).some((m) => /\$\.columns\[\]\.cards\[\]\.(oops: unexpected|id: missing)/.test(m)));
    const q = ex('project-vm'); q.recentHistory[2].text.params = { nested: { anything: [] }, enabled: true };
    assert.ok(compareExample('project-vm', q).some((m) => /params\.(nested|enabled)/.test(m)));
    const r = ex('project-vm'); r.flags.push({ kind: 'label', key: 'x', label: 'x', removable: true, extra: 1 });
    assert.ok(compareExample('project-vm', r).length > 0, 'an extra field on a union member');
  });
  it('R8-09: a valid history item whose kind the example doesn\'t show passes (kind is a semantic enum)', () => {
    const p = ex('project-vm');
    p.recentHistory.push({ id: 'evt_x', at: 1, kind: 'project-created', group: 1, actor: { kind: 'system', name: 'Système' }, text: { key: 'historyKind.project-created' } });
    p.summaryMeta.author = { kind: 'system', name: 'Système' };   // a sidecar variant
    assert.deepEqual(compareExample('project-vm', p), []);
  });
  it('structural alternatives (FlagVM) must each match one member', () => {
    const e = [{ kind: 'label', key: 'k', removable: true }, { kind: 'priority', key: 'P1' }];
    assert.deepEqual(compareShape(e, [{ kind: 'priority', key: 'P2' }, { kind: 'label', key: 'x', removable: true }]), []);
    assert.ok(compareShape(e, [{ kind: 'priority', key: 'P2', removable: true, oops: 1 }]).length > 0);
  });
  it('LabelRef params: strings, numbers or nested LabelRefs; opaque subtrees by type only', () => {
    assert.deepEqual(compareShape({ text: { key: 'k' } }, { text: { key: 'k', params: { n: 1, s: 'a', r: { key: 'x', params: { m: 2 } } } } }), []);
    assert.ok(compareShape({ text: { key: 'k' } }, { text: { key: 'k', params: { bad: [1] } } }).length > 0);
    assert.deepEqual(compareShape({ manifest: { version: 2 } }, { manifest: { anything: [] } }, { opaque: ['$.manifest'] }), []);
  });
});

describe('contract examples (docs/architecture/examples)', () => {
  it('the minimum set the PM asked for exists', () => {
    for (const n of ['project-vm', 'board-vm', 'candidates-vm', 'import-request', 'import-result', 'office-vm', 'layout-vm', 'error-409-project']) assert.ok(names.includes(n), n);
  });

  it('responses use the one success envelope or the one error format (api.md §2)', () => {
    for (const n of names) {
      const x = loadExample(n);
      if (n.endsWith('-request')) continue;
      if (n.startsWith('error-')) { assert.deepEqual(Object.keys(x), ['error']); assert.ok(x.error.code && x.error.message && x.error.requestId, n); continue; }
      assert.deepEqual(Object.keys(x).sort(), ['data', 'meta'], n);
      for (const k of ['modelVersion', 'generatedAt', 'stale']) assert.ok(k in x.meta, `${n}: meta.${k}`);
    }
  });

  it('every Collection has unique, stable string ids', () => {
    const check = (v, p) => {
      if (Array.isArray(v)) {
        if (v.length && v.every((x) => x && typeof x === 'object' && 'id' in x)) {
          const ids = v.map((x) => x.id); assert.equal(new Set(ids).size, ids.length, p + ': duplicate ids');
          assert.ok(ids.every((i) => typeof i === 'string'), p + ': ids are strings');
        }
        v.forEach((x, i) => check(x, p + '[' + i + ']'));
      } else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) if (k !== 'manifest') check(x, p + '.' + k);
    };
    for (const n of names) check(loadExample(n), n);
  });

  it('the 409 carries a full ProjectVM; history pages and recentHistory share HistoryItemVM', () => {
    const pvm = loadExample('project-vm').data;
    assert.deepEqual(compareExample('project-vm', loadExample('error-409-project').error.current.vm), []);
    assert.equal(loadExample('error-409-project').error.current.revision, loadExample('error-409-project').error.current.vm.revision);
    assert.deepEqual(compareExample('history-page', { items: pvm.recentHistory, nextCursor: null }), [], 'recentHistory items are HistoryItemVMs');
  });

  it('board cards are ProjectVM projections (shared fields have the same shape)', () => {
    const pvm = loadExample('project-vm').data;
    for (const col of loadExample('board-vm').data.columns) for (const card of col.cards) {
      for (const k of ['id', 'name', 'priority', 'revision', 'status', 'lastActivityAt']) assert.deepEqual(compareShape(pvm[k], card[k]), [], k);
      assert.deepEqual(compareShape(pvm.thumb, card.thumb, { nullable: ['$.url', '$.repoLabel'] }), []);
      assert.equal(card.status, col.id); assert.equal(col.count, col.cards.length);
    }
  });

  it('import request and result are consistent with the candidates', () => {
    const keys = loadExample('candidates-vm').data.candidates.map((c) => c.key);
    const req = loadExample('import-request');
    assert.ok(req.keys.every((k) => keys.includes(k)));
    assert.ok(Object.keys(req.overrides).every((k) => req.keys.includes(k)), 'overrides only for selected keys');
    const r = loadExample('import-result').data;
    assert.equal(r.revision, null); assert.equal(r.vm, null);
    assert.deepEqual([...r.result.created, ...r.result.skipped].map((x) => x.key).sort(), [...req.keys].sort());
    for (const c of loadExample('candidates-vm').data.candidates) assert.equal(c.id, c.key);
  });

  it('LayoutVM embeds the office layout example verbatim and the current manifest version', () => {
    const vm = loadExample('layout-vm').data;
    const read = (f) => JSON.parse(fs.readFileSync(path.join(ROOT, 'design', 'office', f), 'utf8'));
    assert.deepEqual(vm.layout.data, read('layout.example.json'));
    assert.deepEqual(vm.default.data, read('layout.example.json'));
    // the manifest is opaque in the contract (its shape is manifest.schema.json, owned by office-dev) and changes with
    // every art batch: only its version must match; the example's copy is a snapshot (re-synced at contract changes)
    assert.equal(vm.manifest.version, read('manifest.example.json').version);
  });

  it('SessionVM events are a keyed Collection with ev:<message>:<part> ids', () => {
    for (const e of loadExample('session-vm').data.events) assert.match(e.id, /^ev:\d+:\d+$/);
  });
});

describe('contract-shape · envelope mode (S6.2)', () => {
  it('a whole Ok<T> body: data with the sidecar, meta against the envelope model', () => {
    const body = JSON.parse(JSON.stringify(loadExample('project-vm')));
    assert.deepEqual(compareExample('project-vm', body, { envelope: true }), []);
    body.meta.stale = ['gateway', 'cli']; body.data.repo = null;
    assert.deepEqual(compareExample('project-vm', body, { envelope: true }), [], 'nullable repo (sidecar), stale ids');
    body.meta.stale = [1]; body.extra = true;
    assert.deepEqual(compareExample('project-vm', body, { envelope: true }).sort(), ['$.extra: unexpected', '$.meta.stale[]: expected string, got number']);
  });
});

// frontend-07: the UI never prefixes data URLs, so every URL field in a VM is absolute (or null).
describe('URLs in VMs are absolute (frontend-07)', () => {
  it('every *url / *Url string in every example is absolute http(s)', () => {
    for (const n of names) {
      if (n === 'layout-vm') continue;   // the manifest holds asset paths relative to the asset root (office-dev's contract), not VM URLs
      // a runtime gateway URL (setup, G4) is a WebSocket address, not a link for the UI to load
      for (const [p, u] of urlFields(loadExample(n))) assert.match(u, /gatewayUrl$/i.test(p) ? /^wss?:\/\// : /^https?:\/\//, `${n} ${p}: ${u}`);
    }
  });
  it('createPublicUrls builds absolute API media URLs from the public origin + prefix, or null', () => {
    const { createPublicUrls } = require('../../src/api/v2/urls');
    assert.equal(createPublicUrls({ publicUrl: 'https://timmy.example/', publicApiBase: '/backend' }).forApi('/api/v2/media/a.png'), 'https://timmy.example/backend/api/v2/media/a.png');
    assert.equal(createPublicUrls({ publicUrl: null }).forApi('/api/v2/media/a.png'), null);
    assert.throws(() => createPublicUrls({ publicUrl: 'https://x', publicApiBase: 'backend' }));
  });
});
