'use strict';
/*
 * R8-03 (S6.2): captured real-data fixtures and everything derived from them may ONLY be written under
 * test/fixtures/local/ or test/golden/local/ (gitignored, PM decision on review-06), whatever --out/--fixtures
 * flag is passed and whatever the file name. Paths are compared by filesystem identity (realpath of the
 * nearest existing ancestor), so `..` segments and symlinks can't escape. When git is available, the target
 * must also be git-ignored.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const LOCAL_FIXTURES = path.join(ROOT, 'test', 'fixtures', 'local');
const LOCAL_GOLDEN = path.join(ROOT, 'test', 'golden', 'local');

const { identityOf } = require('../../src/config');   // realpath identity, dangling symlinks followed (R8-01/03)
const inside = (child, parent) => child === parent || child.startsWith(parent + path.sep);

function gitIgnored(p) {
  try { execFileSync('git', ['-C', ROOT, 'rev-parse', '--is-inside-work-tree'], { stdio: 'ignore' }); } catch (_) { return true; }   // no git: nothing to commit into
  try { execFileSync('git', ['-C', ROOT, 'check-ignore', '-q', '--no-index', path.relative(ROOT, p) || '.'], { stdio: 'ignore' }); return true; } catch (_) { return false; }
}

class LocalRootError extends Error {}

// Throws unless `target` (a directory or a file to be written) is inside one of the local roots, by identity.
function assertLocal(target, roots = [LOCAL_FIXTURES, LOCAL_GOLDEN]) {
  const t = identityOf(target);
  const ok = roots.some((r) => {
    const rid = identityOf(r);
    // a local root that is itself a symlink back into the repository (e.g. local → ..) is not a local root
    if (rid !== path.resolve(r) && inside(rid, identityOf(ROOT))) return false;
    return inside(t, rid);
  });
  if (!ok) throw new LocalRootError(`refusing to write capture-derived data outside test/fixtures/local or test/golden/local: ${path.relative(ROOT, path.resolve(target)) || target}`);
  if (inside(t, ROOT) && !gitIgnored(t)) throw new LocalRootError(`refusing: ${path.relative(ROOT, t)} is not git-ignored`);
  return t;
}

module.exports = { assertLocal, identityOf, LocalRootError, LOCAL_FIXTURES, LOCAL_GOLDEN, ROOT };
