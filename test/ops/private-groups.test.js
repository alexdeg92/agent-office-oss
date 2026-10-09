'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict');
const { privateGroup, localRecords } = require('../../src/ops/private-groups');
const base = { passwd: 'operator:x:1001:1001::/synthetic:/bin/false\n', group: 'operator:x:1001:\n', nsswitch: 'passwd: files\ngroup: files\n' };
const proof = records => privateGroup(records, 1001n, 1001n).allowed;
test('private group proof rejects primary/supplementary sharing even with an owner-matching group name', () => {
  assert.equal(proof(base), true);
  assert.equal(proof({ ...base, group: 'operator:x:1001:other\n' }), false);
  assert.equal(proof({ ...base, passwd: base.passwd + 'other:x:1002:1001::/other:/bin/false\n' }), false);
  assert.equal(proof({ ...base, group: 'operator:x:1001:operator\n' }), true);
});
test('unknown, ambiguous and externally supplied membership never proves a private group', () => {
  for (const records of [null, { ...base, group: '' }, { ...base, passwd: base.passwd + base.passwd },
    { ...base, group: base.group + 'alias:x:1001:\n' }, { ...base, passwd: '+::::::\n' },
    { ...base, nsswitch: 'passwd: files\ngroup: files\ninitgroups: files sss\n' },
    { ...base, nsswitch: 'passwd: compat\ngroup: files\n' },
    { ...base, nsswitch: 'passwd: files systemd\ngroup: files systemd\n' }]) assert.equal(proof(records), false);
});
test('systemd group/user/membership records are checked for added primary and supplementary members', () => {
  const records = { ...base, nsswitch: 'passwd: files systemd\ngroup: files [SUCCESS=merge] systemd\n', userdbChecked: true, userdb: [] };
  assert.equal(proof(records), true);
  for (const record of [
    { name: 'other:operator.membership', text: '' },
    { name: 'operator.group', text: JSON.stringify({ groupName: 'operator', gid: 1001, members: ['other'] }) },
    { name: 'other.user', text: JSON.stringify({ userName: 'other', gid: 1001 }) },
    { name: 'other.user', text: JSON.stringify({ userName: 'other', gid: 1002, memberOf: ['operator'] }) },
    { name: 'malformed.group', text: 'not-json' },
    { name: 'null.group', text: 'null' },
    { name: 'alias.group', text: JSON.stringify({ groupName: 'alias', gid: 1001 }) },
    { name: 'operator.user', text: JSON.stringify({ userName: 'operator', uid: 1002, gid: 1001 }) },
    { name: 'conditional.group', text: JSON.stringify({ groupName: 'operator', gid: 1001, perMachine: [{ members: ['other'] }] }) },
  ]) assert.equal(proof({ ...records, userdb: [record] }), false);
  assert.equal(proof({ ...records, userdb: [{ name: 'operator:operator.membership', text: '' }] }), true);
});
test('production record loader scans all userdb locations using injected filesystem data and fails closed on unreadable or linked records', () => {
  let scanned = [];
  const files = { '/etc/passwd': base.passwd, '/etc/group': base.group, '/etc/nsswitch.conf': 'passwd: files systemd\ngroup: files systemd\n', '/run/userdb/other:operator.membership': '' };
  const fsx = {
    readFileSync(file) { assert.ok(Object.hasOwn(files, file), 'unexpected host read: ' + file); return files[file]; },
    readdirSync(dir) { scanned.push(dir); return dir === '/run/userdb' ? ['other:operator.membership'] : []; },
    lstatSync() { return { isFile: () => true, isSymbolicLink: () => false }; },
  };
  assert.equal(proof(localRecords(fsx)), false); assert.equal(scanned.length, 5);
  assert.equal(localRecords({ ...fsx, readdirSync() { throw Object.assign(Error('denied'), { code: 'EACCES' }); } }), null);
  assert.equal(localRecords({ ...fsx, lstatSync() { return { isFile: () => false, isSymbolicLink: () => true }; } }), null);
  scanned = [];
  assert.equal(proof(localRecords({ ...fsx, readFileSync(file) { if (file === '/etc/nsswitch.conf') return '  passwd: files systemd\n group: files systemd\n'; return fsx.readFileSync(file); } })), false);
  assert.equal(scanned.length, 5, 'indented NSS rules still scan userdb');
});

test('identity probing is impossible in a test without an explicit fixture', () => {
  assert.equal(localRecords(), null);
});
