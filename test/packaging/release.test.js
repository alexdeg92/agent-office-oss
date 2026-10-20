'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const tools = require('../../packaging/release-tools');

const root = path.join(__dirname, '..', '..');
const releaseSh = path.join(root, 'packaging', 'release.sh');

function runRelease(args) {
  return spawnSync(releaseSh, args, { encoding: 'utf8', cwd: root });
}

describe('release tooling', () => {
  it('rejects a missing or invalid version before touching the tree', () => {
    const before = fs.readFileSync(path.join(root, 'package.json'), 'utf8');
    const missing = runRelease([]);
    assert.equal(missing.status, 2);
    assert.match(missing.stderr, /usage/);
    const bad = runRelease(['--version', '1.2']);
    assert.equal(bad.status, 2);
    assert.equal(fs.readFileSync(path.join(root, 'package.json'), 'utf8'), before);
  });

  it('refuses a dirty tree before npm test or a version bump', () => {
    const dirty = spawnSync('git', ['status', '--porcelain'], { encoding: 'utf8', cwd: root }).stdout;
    if (!dirty.trim()) return;
    const before = fs.readFileSync(path.join(root, 'package.json'), 'utf8');
    const result = runRelease(['--version', '9.9.9']);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /not clean/);
    assert.equal(fs.readFileSync(path.join(root, 'package.json'), 'utf8'), before);
    assert.equal(result.stdout.includes('npm publish'), false);
  });

  it('fails closed when git status itself fails', () => {
    const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-git-'));
    fs.writeFileSync(path.join(binDir, 'git'), '#!/bin/sh\nexit 128\n');
    fs.chmodSync(path.join(binDir, 'git'), 0o755);
    const result = spawnSync(releaseSh, ['--version', '9.9.9'], {
      encoding: 'utf8',
      cwd: root,
      env: { ...process.env, PATH: `${binDir}:${process.env.PATH}` },
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /git status failed/);
    assert.equal(result.stdout.includes('npm test'), false);
    fs.rmSync(binDir, { recursive: true, force: true });
  });

  it('updates the formula url and sha256 and extracts release notes', () => {
    const formula = fs.readFileSync(path.join(root, 'packaging', 'homebrew', 'agent-office.rb'), 'utf8');
    const sha = 'a'.repeat(64);
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    const tarball = pkg.name.replace(/^@/, '').replace('/', '-') + '-1.2.3.tgz';
    const next = tools.updateFormula(formula, '1.2.3', sha, pkg, tarball);
    const repository = pkg.repository.url.replace(/^git\+/, '').replace(/\.git$/, '');
    assert.ok(next.includes(`url "${repository}/releases/download/v1.2.3/${tarball}"`));
    assert.doesNotMatch(next, /registry\.npmjs\.org/);
    assert.match(next, new RegExp(`sha256 "${sha}"`));
    assert.doesNotMatch(next, /^ {2}version "/m);
    assert.match(next, /packed tarball for 1\.2\.3/);
    assert.equal(next.includes('e3e19027163818ce854ce75a62630dc1fc6d303897c4bf014e69f98bbbe5b94c'), false);
    assert.equal(fs.readFileSync(path.join(root, 'packaging', 'homebrew', 'agent-office.rb'), 'utf8'), formula);

    const changelog = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');
    const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
    const firstHeading = changelog.split('\n').find((line) => line.startsWith('## '));
    // The newest section leads; the packaged version (bumped by release.sh after the tests) must have one too.
    assert.match(firstHeading, /^## \d+\.\d+\.\d+ - \d{4}-\d{2}-\d{2}$/);
    const notes = tools.releaseNotes(changelog, version);
    assert.match(notes, new RegExp('^## ' + version.replace(/\./g, '\\.') + ' '));
    assert.equal(notes.includes('## 0.9.0'), false);
    assert.throws(() => tools.releaseNotes('# Changelog\n\n## 1.0.0\n\ntext\n', '2.0.0'), /no section/);
  });

  it('formula release URLs follow foreign repository metadata and the exact packed asset filename', () => {
    const formula = fs.readFileSync(path.join(root, 'packaging', 'homebrew', 'agent-office.rb'), 'utf8');
    const sha = 'b'.repeat(64), tarball = 'example-tools-client-2.4.6.tgz';
    for (const repository of ['https://github.com/example-org/example-repo.git', { type: 'git', url: 'git+https://github.com/example-org/example-repo.git' }]) {
      const next = tools.updateFormula(formula, '2.4.6', sha, { repository }, tarball);
      assert.ok(next.includes('url "https://github.com/example-org/example-repo/releases/download/v2.4.6/example-tools-client-2.4.6.tgz"'));
      assert.ok(next.includes(`sha256 "${sha}"`));
      assert.doesNotMatch(next, /registry\.npmjs\.org|^ {2}mirror /m);
    }
  });

  it('formula generation rejects invalid repository metadata and unsafe asset filenames', () => {
    const formula = fs.readFileSync(path.join(root, 'packaging', 'homebrew', 'agent-office.rb'), 'utf8'), sha = 'b'.repeat(64);
    const credentialUrl = new URL('https://github.com/example-org/example-repo'); credentialUrl.username = 'fixture-user';
    for (const repository of [undefined, 'https://example.invalid/org/repo', 'https://github.com.example.invalid/org/repo', 'http://github.com/org/repo', credentialUrl.href, 'https://github.com/org/repo?token=fixture', 'https://github.com/org/repo/tree/main']) {
      assert.throws(() => tools.updateFormula(formula, '2.4.6', sha, { repository }, 'client-2.4.6.tgz'), /repository metadata/);
    }
    for (const tarball of ['', '../client.tgz', 'client.tgz"\n  system "command', 'https://example.invalid/client.tgz']) {
      assert.throws(() => tools.updateFormula(formula, '2.4.6', sha, { repository: 'https://github.com/example-org/example-repo' }, tarball), /tarball filename/);
    }
  });

  it('prints publish commands and does not include a secret', () => {
    const text = tools.publishCommands('1.2.3', 'sha256:' + 'f'.repeat(64));
    assert.match(text, /npm publish dist\/alexdeg92-agent-office-1\.2\.3\.tgz/);
    assert.match(text, /gh release create v1\.2\.3.*--repo alexdeg92\/agent-office-oss/);
    assert.match(text, /alexdeg92\/homebrew-tap/);
    assert.match(text, /docker tag sha256:f{64} ghcr\.io\/alexdeg92\/agent-office-oss:1\.2\.3/);
    assert.match(text, /docker push ghcr\.io\/alexdeg92\/agent-office-oss:1\.2\.3/);
    assert.equal(text.includes('PORTAL_SECRET'), false);
  });

  it('R16-09: prepares the current version 1.0.0 and a later version', () => {
    const script = fs.readFileSync(releaseSh, 'utf8');
    const line = script.split('\n').find((row) => row.includes('npm version "$version"'));
    assert.ok(line);
    const flags = line.trim().replace(/^npm version "\$version"\s*/, '').split(/\s+/).filter(Boolean);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-ver-'));
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'ao-rel', version: '1.0.0' }));
    const same = spawnSync('npm', ['version', '1.0.0', ...flags], { cwd: dir, encoding: 'utf8' });
    assert.equal(same.status, 0, same.stderr);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).version, '1.0.0');
    const bump = spawnSync('npm', ['version', '1.2.3', ...flags], { cwd: dir, encoding: 'utf8' });
    assert.equal(bump.status, 0, bump.stderr);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).version, '1.2.3');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('stages the package without an env file and with the design bundle', () => {
    const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-stage-'));
    tools.stagePackage(root, dest);
    assert.equal(fs.existsSync(path.join(dest, '.env')), false);
    assert.equal(fs.existsSync(path.join(dest, 'package.json')), true);
    assert.equal(fs.existsSync(path.join(dest, 'packaging', 'bin', 'agent-office.js')), true);
    assert.equal(fs.existsSync(path.join(dest, 'public', 'v2', 'mock')), false);
    const staged = JSON.parse(fs.readFileSync(path.join(dest, 'package.json'), 'utf8'));
    assert.equal(staged.private, undefined);
    assert.equal(Object.hasOwn(staged, 'private'), false);
    const readme = fs.readFileSync(path.join(dest, 'README.md'), 'utf8');
    assert.match(readme, /agent-office start/);
    assert.equal(readme.includes('cater' + 'flow'), false);
    const script = fs.readFileSync(path.join(root, 'packaging', 'release.sh'), 'utf8');
    assert.ok(script.indexOf('node scripts/build-frontend.js') < script.indexOf('\nnpm run test:release\n'));
    fs.rmSync(dest, { recursive: true, force: true });
  });
});
