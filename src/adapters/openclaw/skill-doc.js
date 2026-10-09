'use strict';
/*
 * SKILL.md reader (R1-11). A skill's document is read only when ALL hold:
 *   - the basename is exactly SKILL.md;
 *   - its path is inside an APPROVED root, whose canonical path/identity is captured once (OpenClaw's documented skill
 *     locations: the package's skills/, custodian-skills/ and dist/extensions/<x>/skills; <home>/.openclaw/skills;
 *     each agent's <workspace>/skills; <home>/.agents/skills). `skills.load.extraDirs` is not approved;
 *   - it's a regular file of at most MAX_BYTES.
 * Anything else reads as '' (the VM's documented "unreadable or outside approved roots"). Never throws.
 */
const fs = require('fs');
const path = require('path');
const safeFs = require('../../ops/safe-fs');

const MAX_BYTES = 256 * 1024;

const real = (p) => { try { return fs.realpathSync(p); } catch (_) { return null; } };
const inside = (file, root) => file.startsWith(root.endsWith(path.sep) ? root : root + path.sep);

// The installed package directory, from the openclaw executable (a symlink into <prefix>/lib/node_modules/openclaw).
function packageDirOf(bin) {
  const r = bin ? real(bin) : null;
  if (!r) return null;
  let d = path.dirname(r);
  for (let i = 0; i < 4 && d !== path.dirname(d); i++, d = path.dirname(d)) {
    try { if (JSON.parse(fs.readFileSync(path.join(d, 'package.json'), 'utf8')).name === 'openclaw') return d; } catch (_) { /* keep looking */ }
  }
  return null;
}

/**
 * @param {object} o
 * @param {string} o.home               the runtime home (config.openclawHome)
 * @param {string|null} o.bin           the openclaw executable
 * @param {() => string[]} [o.workspaces]  agent workspace dirs (canonical Agent.workspace)
 */
function createSkillDocReader({ home, bin, workspaces = () => [], fsx = fs }) {
  const pkg = packageDirOf(bin), approved = new Map();
  function catalog() {
    const list = [];
    if (pkg) {
      list.push(path.join(pkg, 'skills'), path.join(pkg, 'custodian-skills'));
      try { for (const e of fs.readdirSync(path.join(pkg, 'dist', 'extensions'), { withFileTypes: true })) if (e.isDirectory()) list.push(path.join(pkg, 'dist', 'extensions', e.name, 'skills')); } catch (_) { /* none */ }
    }
    if (home) list.push(path.join(home, '.openclaw', 'skills'), path.join(home, '.agents', 'skills'));
    for (const w of workspaces()) if (typeof w === 'string' && path.isAbsolute(w)) list.push(path.join(w, 'skills'));
    return list.flatMap(p => {
      try {
        if (!approved.has(p)) {
          const root = safeFs.canonicalPath(p), captured = safeFs.capture(root);
          if (captured.missing.length) return [];
          approved.set(p, { root, parents: captured.chain });
        }
        return [approved.get(p)];
      } catch { return []; }
    });
  }

  // → { markdown, frontmatter } ('' / {} when refused or unreadable)
  function read(filePath) {
    const none = { markdown: '', frontmatter: {} };
    if (typeof filePath !== 'string' || !path.isAbsolute(filePath) || path.basename(filePath) !== 'SKILL.md') return none;
    let file, rootSnapshots;
    try { file = safeFs.canonicalPath(filePath); rootSnapshots = catalog(); } catch { return none; }
    if (!rootSnapshots.some(r => inside(file, r.root))) return none;
    let raw;
    try {
      raw = safeFs.read(filePath, { roots: rootSnapshots.map(r => r.root), rootSnapshots, maxBytes: MAX_BYTES, fsx }).text;
    } catch (_) { return none; }
    const fm = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
    if (!fm) return { markdown: raw, frontmatter: {} };
    const frontmatter = {};
    for (const line of fm[1].split(/\r?\n/)) { const m = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/); if (m) frontmatter[m[1]] = m[2]; }
    return { markdown: raw.slice(fm[0].length), frontmatter };
  }

  catalog(); // Pin existing configured roots before the first document request.
  return { read, roots: () => catalog().map(r => r.root) };
}

module.exports = { createSkillDocReader, packageDirOf, MAX_BYTES };
