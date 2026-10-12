'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { forbiddenIn, missingAssets } = require('../../packaging/check-pack');

const root = path.join(__dirname, '..', '..');

describe('packed file list', () => {
  it('rejects local captures, instance files, env files, and reports', () => {
    const hits = forbiddenIn([
      '.env.example',
      'public/v2/app.js',
      'test/fixtures/local/scenarios/capture.json',
      'test/golden/local/v1/x.json',
      'instance/traefik.yml',
      '.env',
      'config/.env.local',
      'design/reports/projects-21.md',
      'design/office/manifest.example.json',
      'public/v2/bureau/assets/Characters/badge/worn/idle.png',
      'public/v2/bureau/assets/Characters/debug/pose.png',
      'test/fixtures/office.json',
    ]);
    const why = hits.map((hit) => `${hit.why}:${hit.path}`).sort();
    assert.deepEqual(why, [
      '.env:.env',
      '.env:config/.env.local',
      'debug art:public/v2/bureau/assets/Characters/debug/pose.png',
      'design sources:design/office/manifest.example.json',
      'design sources:design/reports/projects-21.md',
      'design/reports:design/reports/projects-21.md',
      'fixtures/local:test/fixtures/local/scenarios/capture.json',
      'golden/local:test/golden/local/v1/x.json',
      'instance/:instance/traefik.yml',
      'test fixtures:test/fixtures/local/scenarios/capture.json',
      'test fixtures:test/fixtures/office.json',
      'worn art:public/v2/bureau/assets/Characters/badge/worn/idle.png',
    ]);
    assert.equal(forbiddenIn(['.env.example', 'src/config.js', 'src/ops/startup-diagnostics.js', 'src/settings/diagnostics.js']).length, 0);
    assert.deepEqual(forbiddenIn(['src/ops/other-diagnostics.js']), [{ why: 'debug art', path: 'src/ops/other-diagnostics.js' }]);
    assert.deepEqual(forbiddenIn(['src/settings/other-diagnostics.js', 'public/v2/bureau/assets/Characters/diagnostics.png']), [
      { why: 'debug art', path: 'src/settings/other-diagnostics.js' },
      { why: 'debug art', path: 'public/v2/bureau/assets/Characters/diagnostics.png' },
    ]);
    assert.deepEqual(missingAssets(['public/v2/app.js']), ['public/v2/index.html', 'public/v2/bureau/bureau.css']);
    assert.deepEqual(missingAssets(['public/v2/index.html', 'public/v2/bureau/bureau.css']), []);
  });

  it('fails when the packed frontend has no Bureau bundle', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ao-pack-')), 'pack.json');
    fs.writeFileSync(file, JSON.stringify([{ files: [{ path: 'public/v2/app.js' }, { path: '.env.example' }] }]));
    const check = spawnSync(process.execPath, ['packaging/check-pack.js', file], { cwd: root, encoding: 'utf8' });
    assert.equal(check.status, 1);
    assert.match(check.stderr, /missing frontend asset: public\/v2\/bureau\/bureau\.css/);
  });

  it('the workflows verify before release and obtain credentials only from secrets', () => {
    const ci = fs.readFileSync(path.join(root, '.github/workflows/ci.yml'), 'utf8');
    const release = fs.readFileSync(path.join(root, '.github/workflows/release.yml'), 'utf8');
    assert.match(ci, /node-version: 24/);
    assert.match(ci, /npm ci/);
    assert.match(ci, /npm run test:release/);
    assert.match(ci, /node scripts\/build-frontend\.js/);
    assert.match(ci, /npm pack --dry-run --json/);
    assert.match(ci, /stagePackage/);
    assert.ok(ci.indexOf('node scripts/build-frontend.js') < ci.indexOf('npm run test:release'));
    assert.ok(ci.indexOf('npm run test:release') < ci.indexOf('stagePackage'));
    assert.match(release, /tags: \['v\*'\]/);
    assert.match(release, /needs: verify/);
    assert.match(release, /if: github\.repository == 'alexdeg92\/agent-office-oss'/);
    assert.match(release, /npm publish .*--access public --provenance/);
    assert.match(release, /platforms: linux\/amd64,linux\/arm64/);
    assert.match(release, /repository: alexdeg92\/homebrew-tap/);
    assert.match(release, /NODE_AUTH_TOKEN: \$\{\{ secrets\.NPM_TOKEN \}\}/);
    assert.match(release, /password: \$\{\{ secrets\.GITHUB_TOKEN \}\}/);
    assert.match(release, /token: \$\{\{ secrets\.TAP_TOKEN \}\}/);
    assert.match(ci, /check-pack\.js/);
    assert.match(ci, /docker build/);
    assert.match(ci, /packaging\/first-run\.test\.js/);
    assert.ok(ci.indexOf('docker build') < ci.indexOf('packaging/first-run.test.js'));
    assert.ok(ci.indexOf('packaging/first-run.test.js') < ci.indexOf('smoke.sh'));
    assert.match(ci, /smoke\.sh/);
    assert.match(ci, /demo-smoke\.sh/);
    assert.ok(ci.indexOf('smoke.sh') < ci.indexOf('demo-smoke.sh'));
    assert.match(ci, /ruby -c/);
    assert.equal(ci.includes('${{ secrets'), false);
  });

  it('the staged pack list is clean and contains the frontend bundle', () => {
    const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-stage-pack-'));
    const file = path.join(dest, 'pack.json');
    const staged = spawnSync(process.execPath, ['-e', 'require("./packaging/release-tools").stagePackage(process.cwd(), process.argv[1])', dest], { cwd: root, encoding: 'utf8' });
    assert.equal(staged.status, 0, staged.stderr);
    const packed = spawnSync('npm', ['pack', '--dry-run', '--json'], { cwd: dest, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    assert.equal(packed.status, 0, packed.stderr);
    fs.writeFileSync(file, packed.stdout);
    const check = spawnSync(process.execPath, ['packaging/check-pack.js', file], { cwd: root, encoding: 'utf8' });
    assert.equal(check.status, 0, check.stderr);
    assert.match(check.stdout, /pack: ok/);
    fs.rmSync(dest, { recursive: true, force: true });
  });
});
