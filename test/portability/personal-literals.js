'use strict';
/*
 * The "no personal literals" scanner (ADR-001 §6.1, §12.8). Scans src/**, public/v2/** and the committed tests and
 * fixtures for the words of Owner's own instance. An occurrence is allowed only by an entry of personal-literals.allow.json:
 *   { file, token, line, count, reason }   `line` = the exact (trimmed) line, `count` = how many times the token
 *                                           occurs on it. So an allowance exempts THOSE occurrences only: another
 *                                           token on the same line, an edited line or a new line all fail.
 * The tokens are assembled here so this file never matches itself.
 */
const fs = require('fs');
const path = require('path');

const TOKENS = [('al' + 'ex') + 'deg92', '/home/' + ('al' + 'ex'), 'Tim' + 'my', 'cater' + 'flow', 'America/' + 'Toronto'];
const ROOTS = ['src', 'public/v2', 'test'];
const SKIP_DIRS = new Set(['node_modules', '.git']);
// R20-07: only the two gitignored roots of captured real data (never committed) are skipped, by exact path; a
// directory named 'local' anywhere else is scanned like any other
const SKIP_PATHS = new Set(['test/fixtures/local', 'test/golden/local']);
const TEXT = /\.(js|mjs|cjs|json|md|html|css|txt|svg|sql|sh)$/i;
const SELF = new Set(['test/portability/personal-literals.js', 'test/portability/personal-literals.allow.json']);

function* files(root, rel = '') {
  for (const e of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
    const r = rel ? rel + '/' + e.name : e.name;
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name) && !SKIP_PATHS.has(r)) yield* files(root, r); } else if (TEXT.test(e.name)) yield r;
  }
}

/** → [{ file, token, line, count }] for the tree at `root` (one entry per distinct line and token) */
function scan(root) {
  const out = [];
  for (const top of ROOTS) {
    if (!fs.existsSync(path.join(root, top))) continue;
    for (const rel of files(root, top)) {
      if (SELF.has(rel)) continue;
      const text = fs.readFileSync(path.join(root, rel), 'utf8');
      if (!TOKENS.some((t) => text.includes(t))) continue;
      for (const raw of text.split('\n')) {
        for (const token of TOKENS) {
          const count = raw.split(token).length - 1;
          if (count) out.push({ file: rel, token, line: raw.trim(), count });
        }
      }
    }
  }
  return out;
}

const keyOf = (x) => JSON.stringify([x.file, x.token, x.line]);

/** → { unallowed: [...], stale: [...] }: occurrences without an exact allowance, and allowances that match nothing */
function check(root, allow) {
  const left = new Map();
  for (const a of allow) left.set(keyOf(a), (left.get(keyOf(a)) || 0) + a.count);
  const unallowed = [];
  for (const x of scan(root)) {
    const n = left.get(keyOf(x)) || 0;
    if (n >= x.count) left.set(keyOf(x), n - x.count);
    else unallowed.push(Object.assign({}, x, { allowed: n }));
  }
  const stale = allow.filter((a) => (left.get(keyOf(a)) || 0) > 0);
  return { unallowed, stale };
}

module.exports = { TOKENS, scan, check, keyOf };
