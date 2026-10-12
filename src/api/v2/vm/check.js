'use strict';
/*
 * Runtime VM validation (PM audit (B), part 2): every VM is checked against its schema (vm/schemas.js) BEFORE it is
 * sent, by topic rebuilds and by every route response.
 *   - dev and test: a violation THROWS (a builder bug fails loudly, in tests and on a developer's machine);
 *   - production and staging: the response sends the LAST GOOD VM of that topic (or 500 if there is none), and a
 *     quarantine issue `vm.invalid` (channel `vm.<name>`, the schema path; value-free) shows on Santé.
 * Never a malformed payload, and never `undefined` anywhere (the schemas reject it; JSON would silently drop it).
 */
const s = require('../../../schema');
const { schemasFor } = require('./schemas');
const { classesFor } = require('./classes');
const { undefinedPath } = require('../../../model/entity');

class VmError extends Error {
  constructor(name, issues) {
    super('invalid ' + name + ' VM: ' + issues.map((i) => i.path + ' ' + i.detail).slice(0, 5).join('; '));
    this.name = 'VmError'; this.vm = name; this.issues = issues;
  }
}

/**
 * @param {object} o
 * @param {'throw'|'fallback'} o.mode
 * @param {(issue) => void} [o.report]   quarantine sink (production)
 */
// G5: `version` picks the contract's schemas (2 or 3); issues name the channel 'vm.<name>' (2) or 'vm.v3.<name>' (3)
function createVmCheck({ mode, report = () => {}, resolve = () => {}, version = 2 }) {
  const VM_SCHEMAS = schemasFor(version), VM_CLASSES = classesFor(version);
  const channelOf = (name) => (version === 3 ? 'vm.v3.' : 'vm.') + name;
  const lastGood = new Map();   // key (topic id or route name) → VM
  function issuesOf(name, vm) {
    const schema = VM_SCHEMAS[name];
    if (!schema) return [{ path: '$', detail: 'no schema for ' + name }];
    const u = undefinedPath(vm);
    if (u) return [{ path: u, detail: 'undefined value' }];
    const r = s.validate(schema, vm);
    return r.ok ? [] : r.issues.filter((i) => i.severity === 'error');
  }
  // → the VM to send: an instance of its section's class (frozen), or the last good one in fallback mode; throws in throw mode
  function check(name, vm, key = name) {
    const issues = issuesOf(name, vm);
    if (!issues.length) { const typed = new VM_CLASSES[name](vm); lastGood.set(key, typed); try { resolve(channelOf(name), name); } catch {} return typed; }
    if (mode === 'throw') throw new VmError(name, issues);
    for (const i of issues.slice(0, 5)) report({ code: 'vm.invalid', severity: 'error', channel: channelOf(name), path: i.path });
    if (lastGood.has(key)) return lastGood.get(key);
    throw new VmError(name, issues);
  }
  return { check, issuesOf };
}

module.exports = { createVmCheck, VmError };
