'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const ROOT = path.resolve(__dirname, '..');
const { plan } = require('../scripts/sync-design');
function exportTree(dest) {
  const gitRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: ROOT }).toString().trim();
  if (fs.realpathSync(gitRoot) !== fs.realpathSync(ROOT)) throw new Error('source must be its own Git checkout; initialize the exported repository first');
  dest = path.resolve(dest);
  if (dest === ROOT || ROOT.startsWith(dest + path.sep)) throw new Error('destination must not contain the source tree');
  if (fs.existsSync(dest) && (!fs.statSync(dest).isDirectory() || fs.readdirSync(dest).length)) throw new Error('destination must be absent or empty');
  const allowedRoots = new Set(['src', 'public', 'scripts', 'test', 'docs', 'packaging', 'integrations', '.github']);
  const rootFiles = new Set(['package.json', 'package-lock.json', 'server.js', 'gateway.js', 'README.md', 'LICENSE', 'SECURITY.md', 'CONTRIBUTING.md', 'CHANGELOG.md', '.env.example', '.gitignore', '.dockerignore']);
  const sourceAssets = new Set(plan().map(([src]) => path.relative(ROOT, src).split(path.sep).join('/')));
  // sync-design reads this build input to enumerate registered screen frames;
  // it is not itself copied to the runtime bundle by plan().
  sourceAssets.add('design/assets/Office/monitor-screens/manifest.json');
  // ls-files --cached also lists tracked files deleted in the worktree. Export the current tree,
  // including staged/unstaged removals, rather than attempting to copy those index-only paths.
  const deleted = new Set(execFileSync('git', ['ls-files', '-z', '--deleted'], { cwd: ROOT, maxBuffer: 256 * 1024 * 1024 }).toString().split('\0').filter(Boolean));
  const files = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: ROOT, maxBuffer: 256 * 1024 * 1024 }).toString().split('\0').filter((file) => file && !deleted.has(file));
  // The built frontend is intentionally ignored by git, but needed in the exported checkout.
  function built(dir) {
    for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const rel = `${dir}/${entry.name}`;
      if (entry.isDirectory()) built(rel); else files.push(rel);
    }
  }
  if (fs.existsSync(path.join(ROOT, 'public/v2/bureau'))) built('public/v2/bureau');
  fs.mkdirSync(dest, { recursive: true });
  let count = 0, bytes = 0;
  for (const rel of [...new Set(files)].sort()) {
    if (/^(?:test\/(?:fixtures|golden)\/local|design\/(?:reports|explorations)|instance|agent-office\.service)(?:\/|$)/.test(rel)) continue;
    if (/(?:^|\/)(?:node_modules|\.git)(?:\/|$)/.test(rel) || /(?:^|\/)\.env(?:\.|$)/.test(rel) && rel !== '.env.example') continue;
    if (/\.(?:pem|key|token|sqlite|db)(?:$|-)/.test(rel)) continue;
    const top = rel.split('/')[0];
    if (top === 'design') {
      // Keep reproducible design sources, runtime images and their public font licences.
      if (!/^design\/(?:css|components|fonts|office|scripts|identity-1)\//.test(rel) && !['design/tokens.json', 'design/icons.json'].includes(rel) && !sourceAssets.has(rel)) continue;
    } else if (!allowedRoots.has(top) && !rootFiles.has(rel)) continue;
    const from = path.join(ROOT, rel), to = path.join(dest, rel);
    const st = fs.lstatSync(from);
    if (!st.isFile()) throw new Error(`non-regular source file: ${rel}`);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    let data = fs.readFileSync(from);
    // Any retained design metadata must use repo-relative provenance paths.
    if (/^design\/.*\.(?:json|md)$/.test(rel)) {
      const prefix = '/home/' + ('al' + 'ex/');
      data = Buffer.from(data.toString().replace(new RegExp(prefix + '[^"\\s]*?/(?=design/)', 'g'), ''));
    }
    fs.writeFileSync(to, data, { mode: st.mode & 0o777 }); count++; bytes += data.length;
  }
  console.log(`export: ${count} files, ${bytes} bytes (no Git history)`);
  return { count, bytes };
}
if (require.main === module) {
  try { if (!process.argv[2]) throw new Error('missing destination'); exportTree(process.argv[2]); }
  catch (e) { console.error(`export: ${e.message}`); process.exitCode = 1; }
}
module.exports = { exportTree };
