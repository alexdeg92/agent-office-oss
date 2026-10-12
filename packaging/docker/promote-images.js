'use strict';
// Promote verified registry manifests. This program never builds an image.
const fs = require('node:fs'), path = require('node:path');
const { execFileSync } = require('node:child_process');
const REPO = 'ghcr.io/alexdeg92/agent-office-oss';
const PLATFORMS = ['linux/amd64', 'linux/arm64'];
const CHECKS = ['contents', 'firstRun', 'api', 'demo'];
const SHA = /^sha256:[a-f0-9]{64}$/;
function pinnedBase() {
  const from = [...fs.readFileSync(path.join(__dirname, 'Dockerfile'), 'utf8').matchAll(/^FROM (\S+)/gm)].map(m => m[1]);
  if (from.length !== 2 || from[0] !== from[1] || !/^node:24-slim@sha256:[a-f0-9]{64}$/.test(from[0])) throw Error('both Docker stages require the same pinned base');
  return from[0].split('@')[1];
}
function validate({ source, base, evidence }) {
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(source) || !SHA.test(base)) throw Error('invalid source or base digest');
  if (!Array.isArray(evidence) || evidence.length !== PLATFORMS.length) throw Error('missing or duplicate platform verification');
  for (const platform of PLATFORMS) {
    const rows = evidence.filter(e => e.platform === platform);
    if (rows.length !== 1) throw Error('missing or duplicate platform verification: ' + platform);
    const row = rows[0];
    if (row.source !== source || row.base !== base || !SHA.test(row.digest) || CHECKS.some(k => row.checks?.[k] !== true)) throw Error('unverified source/base/digest/checks: ' + platform);
  }
  return PLATFORMS.map(p => evidence.find(e => e.platform === p));
}
function checkManifest(manifest, evidence) {
  if (!manifest || !Array.isArray(manifest.manifests) || manifest.manifests.length !== evidence.length ||
      evidence.some(e => !manifest.manifests.some(m => m.digest === e.digest && `${m.platform?.os}/${m.platform?.architecture}` === e.platform))) throw Error('published platform digests differ from verification');
  return manifest.manifests;
}
function promote({ repo = REPO, version, source, base, evidence, docker = args => execFileSync('docker', args, { encoding: 'utf8' }) }) {
  if (repo !== REPO || !/^\d+\.\d+\.\d+$/.test(version)) throw Error('invalid release repository/version');
  const rows = validate({ source, base, evidence });
  const candidate = repo + ':verified-' + source;
  docker(['buildx', 'imagetools', 'create', '--tag', candidate, ...rows.map(r => repo + '@' + r.digest)]);
  const descriptor = JSON.parse(docker(['buildx', 'imagetools', 'inspect', candidate, '--format', '{{json .Manifest}}']));
  if (!SHA.test(descriptor.digest)) throw Error('invalid produced index digest');
  const exact = repo + '@' + descriptor.digest;
  const manifests = checkManifest(JSON.parse(docker(['buildx', 'imagetools', 'inspect', exact, '--raw'])), rows);
  docker(['buildx', 'imagetools', 'create', '--tag', repo + ':' + version, '--tag', repo + ':latest', exact]);
  // Read each release tag back; both must point at the verified index.
  for (const tag of [version, 'latest']) {
    const published = JSON.parse(docker(['buildx', 'imagetools', 'inspect', repo + ':' + tag, '--format', '{{json .Manifest}}']));
    if (published.digest !== descriptor.digest) throw Error('published release index differs from verification');
  }
  return { source, base, index: descriptor.digest, platforms: manifests };
}
function record({ source, base, platform, digest, inspected, checks }) {
  if (!PLATFORMS.includes(platform) || !SHA.test(digest) || !SHA.test(base) || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(source)) throw Error('invalid image evidence');
  if (`${inspected.Os}/${inspected.Architecture}` !== platform || inspected.Config?.Labels?.['org.opencontainers.image.revision'] !== source) throw Error('image architecture/source does not match the build');
  if (CHECKS.some(k => checks?.[k] !== true)) throw Error('image checks incomplete');
  return { source, base, platform, digest, checks };
}
module.exports = { promote, validate, checkManifest, record, pinnedBase };
if (require.main === module) {
  try {
    const [mode, dir] = process.argv.slice(2);
    if (!dir || !['record', 'promote'].includes(mode)) throw Error('usage: promote-images.js record|promote evidence-directory');
    fs.mkdirSync(dir, { recursive: true });
    const source = process.env.GITHUB_SHA, base = pinnedBase();
    if (mode === 'record') {
      const image = process.env.IMAGE, platform = process.env.PLATFORM, digest = image?.split('@')[1];
      if (image !== REPO + '@' + digest || !SHA.test(digest || '')) throw Error('expected immutable produced image digest');
      const inspected = JSON.parse(execFileSync('docker', ['image', 'inspect', image], { encoding: 'utf8' }))[0];
      const row = record({ source, base, platform, digest, inspected, checks: Object.fromEntries(CHECKS.map(k => [k, true])) });
      fs.writeFileSync(path.join(dir, platform.replace('/', '-') + '.json'), JSON.stringify(row, null, 2) + '\n', { flag: 'wx' });
    } else {
      const evidence = fs.readdirSync(dir).filter(n => /^linux-(amd64|arm64)\.json$/.test(n)).map(n => JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8')));
      const result = promote({ version: process.env.GITHUB_REF_NAME?.replace(/^v/, ''), source, base, evidence });
      fs.writeFileSync(path.join(dir, 'published.json'), JSON.stringify(result, null, 2) + '\n');
    }
  } catch (e) { console.error('image release: ' + e.message); process.exitCode = 1; }
}
