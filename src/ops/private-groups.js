'use strict';
// Only local identity records can prove a private group. External NSS providers
// can hide primary or supplementary members, so membership fails closed.
const fs = require('node:fs'), path = require('node:path');
const USERDB_DIRS = ['/etc/userdb', '/run/userdb', '/run/host/userdb', '/usr/local/lib/userdb', '/usr/lib/userdb'];
function localRecords(fsx = fs) {
  // Test runners must inject identity data; they never inspect host accounts.
  if (fsx === fs && process.env.NODE_TEST_CONTEXT) return null;
  try {
    const records = { passwd: fsx.readFileSync('/etc/passwd', 'utf8'), group: fsx.readFileSync('/etc/group', 'utf8'), nsswitch: fsx.readFileSync('/etc/nsswitch.conf', 'utf8'), userdb: [], userdbChecked: true };
    if (/^[ \t]*(?:passwd|group|initgroups):[^\n]*\bsystemd\b/m.test(records.nsswitch)) for (const dir of USERDB_DIRS) {
      let names;
      try { names = fsx.readdirSync(dir); } catch (e) { if (e.code === 'ENOENT') continue; throw e; }
      for (const name of names.filter(n => /\.(user|group|membership)$/.test(n))) {
        const file = path.join(dir, name), st = fsx.lstatSync(file);
        if (!st.isFile() || st.isSymbolicLink()) throw new Error('unproven userdb record');
        records.userdb.push({ name, text: fsx.readFileSync(file, 'utf8') });
      }
    }
    return records;
  } catch { return null; }
}
function privateGroup(records, uid, gid) {
  const unknown = { allowed: false, reason: 'private group membership cannot be proven from local identity files' };
  if (!records || !['passwd', 'group', 'nsswitch'].every(k => typeof records[k] === 'string')) return unknown;
  let systemd = false;
  for (const key of ['passwd', 'group', 'initgroups']) {
    const entries = records.nsswitch.split('\n').map(s => s.split('#')[0].trim()).filter(s => s.startsWith(key + ':'));
    if (!entries.length && key === 'initgroups') continue;
    if (entries.length !== 1) return unknown;
    const modules = entries[0].slice(key.length + 1).replace(/\[[^\]]*\]/g, '').trim().split(/\s+/);
    if (!modules.includes('files') || modules.some(m => !['files', 'systemd'].includes(m))) return unknown;
    systemd ||= modules.includes('systemd');
  }
  const parse = text => text.split('\n').map(s => s.trim()).filter(s => s && !s.startsWith('#')).map(s => s.split(':'));
  const users = parse(records.passwd), groups = parse(records.group);
  if (users.some(u => u.length !== 7 || !/^\d+$/.test(u[2]) || !/^\d+$/.test(u[3])) ||
      groups.some(g => g.length !== 4 || !/^\d+$/.test(g[2]))) return unknown;
  const owners = users.filter(u => BigInt(u[2]) === uid), matches = groups.filter(g => BigInt(g[2]) === gid);
  if (owners.length !== 1 || matches.length !== 1) return unknown;
  const owner = owners[0], group = matches[0];
  let shared = users.some(u => BigInt(u[3]) === gid && BigInt(u[2]) !== uid) || group[3].split(',').filter(Boolean).some(name => name !== owner[0]);
  if (systemd) {
    if (!records.userdbChecked || !Array.isArray(records.userdb)) return unknown;
    for (const record of records.userdb) {
      if (record.name.endsWith('.membership')) {
        const match = /^([^:]+):([^:]+)\.membership$/.exec(record.name);
        if (!match) return unknown;
        if (match[2] === group[0] && match[1] !== owner[0]) shared = true;
      } else {
        let data; try { data = JSON.parse(record.text); } catch { return unknown; }
        if (!data || typeof data !== 'object' || Array.isArray(data) || data.perMachine || data.binding) return unknown;
        if (record.name.endsWith('.group') && (data.groupName === group[0] || String(data.gid) === String(gid))) {
          if (data.groupName !== group[0] || String(data.gid) !== String(gid)) return unknown;
          if (data.members !== undefined && !Array.isArray(data.members)) return unknown;
          if ((data.members || []).some(name => name !== owner[0])) shared = true;
        }
        if (record.name.endsWith('.user')) {
          if (typeof data.userName !== 'string' || !data.userName) return unknown;
          if (data.userName === owner[0] && data.uid !== undefined && String(data.uid) !== String(uid)) return unknown;
          if (data.memberOf !== undefined && !Array.isArray(data.memberOf)) return unknown;
          if (data.userName !== owner[0] && (String(data.gid) === String(gid) || (data.memberOf || []).includes(group[0]))) shared = true;
        }
      }
    }
  }
  if (shared) return { allowed: false, reason: 'group is shared; it is not the owner\'s private group' };
  return { allowed: true, owner: owner[0], group: group[0] };
}
module.exports = { localRecords, privateGroup };
