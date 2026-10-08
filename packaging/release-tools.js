'use strict';
// Pure helpers for packaging/release.sh. No network, no git, no publish.

const fs = require('node:fs');
const path = require('node:path');

function assertVersion(version) {
  if (!/^[0-9]+\.[0-9]+\.[0-9]+$/.test(String(version || ''))) {
    throw new Error('version must be X.Y.Z');
  }
  return version;
}

function updateFormula(src, version, sha256) {
  assertVersion(version);
  if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error('sha256 must be 64 hex characters');
  const url = `https://registry.npmjs.org/@alexdeg92/agent-office/-/agent-office-${version}.tgz`;
  let out = src;
  const replace = (re, line, label) => {
    if (!re.test(out)) throw new Error(`formula ${label} line not found`);
    out = out.replace(re, line);
  };
  replace(/^  url ".*"$/m, `  url "${url}"`, 'url');
  out = out.replace(/^  mirror ".*"\n/m, "");
  replace(/^  sha256 "[a-f0-9]{64}"$/m, `  sha256 "${sha256}"`, 'sha256');
  // Homebrew scans the version from the URL. An explicit `version` line is redundant and fails `brew audit`.
  out = out.replace(/^  version "[^"]+"\n/m, '');
  out = out.replace(/^# sha256 is the packed tarball for .*$/m, `# sha256 is the packed tarball for ${version}.`);
  return out;
}

function releaseNotes(changelog, version) {
  assertVersion(version);
  const lines = String(changelog).split('\n');
  const start = lines.findIndex((line) => line === `## ${version}` || line.startsWith(`## ${version} `));
  if (start < 0) throw new Error(`CHANGELOG.md has no section for ${version}`);
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (lines[i].startsWith('## ')) { end = i; break; }
  }
  return `${lines.slice(start, end).join('\n').trim()}\n`;
}

function publishCommands(version) {
  assertVersion(version);
  const tar = `dist/alexdeg92-agent-office-${version}.tgz`;
  return [
    '# Operator commands; never run by this script.',
    `npm publish ${tar} --access public`,
    '',
    `gh release create v${version} ${tar} --notes-file dist/RELEASE_NOTES.md --repo alexdeg92/agent-office-oss`,
    '# In the tap repo alexdeg92/homebrew-tap: copy packaging/homebrew/agent-office.rb to Formula/agent-office.rb, commit, and push that repo.',
    '',
    `docker tag agent-office:${version} ghcr.io/alexdeg92/agent-office-oss:${version}`,
    `docker push ghcr.io/alexdeg92/agent-office-oss:${version}`,
    '',
  ].join('\n');
}

function stagePackage(root, dest) {
  const pkgPath = path.join(root, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  fs.mkdirSync(dest, { recursive: true });
  delete pkg.private;
  fs.writeFileSync(path.join(dest, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`);
  const readme = path.join(root, 'README.md');
  if (fs.existsSync(readme)) fs.copyFileSync(readme, path.join(dest, 'README.md'));
  for (const entry of pkg.files || []) {
    if (entry.startsWith('!')) continue;
    const from = path.join(root, entry);
    if (!fs.existsSync(from)) throw new Error(`package file missing: ${entry}`);
    fs.cpSync(from, path.join(dest, entry), { recursive: true });
  }
  for (const entry of pkg.files || []) {
    if (!entry.startsWith('!')) continue;
    fs.rmSync(path.join(dest, entry.slice(1)), { recursive: true, force: true });
  }
}

module.exports = { assertVersion, updateFormula, releaseNotes, publishCommands, stagePackage };
