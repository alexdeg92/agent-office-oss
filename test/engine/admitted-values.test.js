'use strict';
/*
 * R1-07: the engine must admit payload VALUES unchanged (raw schemas are pass-through: declared
 * fields typed, others kept). For every fixture of every scenario, the value stored in the registry
 * must deep-equal the decoded input unless the engine reported a dropped row. Then prove the check
 * has teeth: for every channel, a schema mutant that silently deletes one field is caught.
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createEngine, DEFAULT_SCHEMAS } = require('../../src/engine');
const { Schema } = require('../../src/schema');
const { listScenarios } = require('../helpers/scenario');
const { envelopesOf } = require('../helpers/feed');

const CANONICAL_STORED = new Set(['config.openclaw']);

function decoded(env) {
  const b = env.body;
  if (b.kind === 'json') return b.value;
  if (b.kind === 'text') { const i = b.value.indexOf('{'); try { return i < 0 ? undefined : JSON.parse(b.value.slice(i)); } catch (_) { return undefined; } }
  return undefined;
}

// → list of "channel#key: reason" for every accepted envelope whose stored value differs from its input
function mismatches(schemas, sc) {
  const out = [];
  for (const env of envelopesOf(sc)) {
    const e = createEngine({ schemas, now: () => sc.now });
    e.setOpenclawVersion(sc.openclawVersion);
    const r = e.ingest(env);
    if (!r.ok) continue;
    if (r.issues.some((i) => i.code === 'shape.item-dropped')) continue;      // reported, by design
    // channels whose registry value is canonical by design (the config projection) are checked elsewhere
    if (CANONICAL_STORED.has(env.channel)) continue;
    const stored = e.latest(env.channel, env.context && env.context.key);
    try { assert.deepStrictEqual(stored && stored.value, decoded(env)); } catch (_) { out.push(`${env.channel}#${(env.context && env.context.key) || ''}`); }
  }
  return out;
}

// A schema whose output silently loses the first nested own property it finds (deepest-first walk).
function dropOneField(def) {
  const inner = def.schema;
  const mutant = new Schema('mutant', (v, p, ctx) => {
    const r = inner.run(v, p, ctx);
    if (!r.ok) return r;
    const clone = JSON.parse(JSON.stringify(r.value));
    (function drop(o) {
      if (!o || typeof o !== 'object') return false;
      for (const k of Object.keys(o)) { if (o[k] && typeof o[k] === 'object' && drop(o[k])) return true; }
      const keys = Object.keys(o); if (!keys.length || Array.isArray(o)) return false;
      delete o[keys[0]]; return true;
    })(clone);
    return { ok: true, value: clone };
  });
  return Object.assign({}, def, { schema: mutant });
}

for (const sc of listScenarios()) {
  describe(`admitted values · ${sc.name}`, () => {
    it('every accepted payload is stored exactly as received', () => {
      assert.deepEqual(mismatches(DEFAULT_SCHEMAS, sc), []);
    });

    it('a field-removal mutation is caught on every channel present in the scenario', () => {
      const channels = [...new Set(envelopesOf(sc).filter((env) => DEFAULT_SCHEMAS[env.channel]).map((env) => env.channel))];
      assert.ok(channels.length >= 8, 'enough channels to be meaningful');
      const missed = channels.filter((ch) => {
        const schemas = Object.assign({}, DEFAULT_SCHEMAS, { [ch]: dropOneField(DEFAULT_SCHEMAS[ch]) });
        return !mismatches(schemas, sc).some((m) => m.startsWith(ch + '#'));
      });
      // a channel can only escape if every one of its payloads was empty or rejected
      assert.deepEqual(missed, []);
    });
  });
}
