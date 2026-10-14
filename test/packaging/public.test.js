'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { scan } = require('../../packaging/check-public');
const { exportTree } = require('../../packaging/export-public');
const root = path.resolve(__dirname, '../..');

test('public gate scans arbitrary paths, extensions and binary metadata without exposing matches', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-public-gate-'));
  const env = { PORTAL_EMAIL: 'private-owner@personal.invalid', PUBLIC_PRIVATE_NAMES: 'Private Person', OC_GATEWAY_TOKEN: 'runtime-private-value' };
  const seeds = [
    ['/home/' + ('al' + 'ex'), 'private literal'],
    [['100', '120', '237', '123'].join('.'), 'private literal'],
    ['cater' + 'flow', 'private literal'],
    [env.PORTAL_EMAIL, 'private literal'],
    ['Private Person', 'private person name'],
    [env.OC_GATEWAY_TOKEN, 'private literal'],
    ['987654' + '321098765432', 'chat ID'],
    ['telegram userId: ' + '987654321', 'Telegram ID'],
    ['{"chat_id":"-' + '987654321' + '"}', 'Telegram ID'],
    ['sk-' + 'x'.repeat(40), 'provider token'],
    [['-----BEGIN', 'PRIVATE KEY-----'].join(' '), 'private key'],
  ];
  try {
    fs.mkdirSync(path.join(dir, 'unexpected'));
    const file = path.join(dir, 'unexpected', 'blob.unknown');
    fs.writeFileSync(file, 'owner@example.invalid 100000000000000000');
    assert.deepEqual(scan(dir, env).findings, []);
    fs.writeFileSync(file, 'a@example.test b@ci.agents.test c@host.invalid d@site.example');
    assert.deepEqual(scan(dir, env).findings, [], 'RFC 2606/6761 reserved TLDs are synthetic');
    fs.writeFileSync(file, 'a@b.test a@sub.example.test o@example.com o@x.example.org o@example.net');
    assert.deepEqual(scan(dir, env).findings, [], 'whole reserved domains pass');
    // critic-427: each look-alike is assembled at runtime so this source never holds it; each must stay a finding
    for (const lookAlike of [['person@fixture.test', 'é.com'], ['a@b.test', '.com'], ['a@b.test', 'ing'], ['a@b.t', 'ést'], ['a@b.test', '1'], ['a@b.test', '-x.com'], ['owner@example', '.ca'], ['owner@sub.example', '.ca'], ['owner@example.com', 'é'], ['owner@example', '.co']]) {
      fs.writeFileSync(file, lookAlike.join(''));
      assert.ok(scan(dir, env).findings.some(h => h.rule === 'email'), `look-alike #${lookAlike[1]} is still an email finding`);
    }
    for (const [seed, rule] of seeds) {
      fs.writeFileSync(file, Buffer.concat([Buffer.from([0]), Buffer.from(seed)]));
      const findings = scan(dir, env).findings;
      assert.ok(findings.some(h => h.rule === rule), rule);
      assert.equal(JSON.stringify(findings).includes(seed), false, 'matched values must not be printed');
    }
    fs.unlinkSync(file);
    const constantsDir = path.join(dir, 'src/projects');
    fs.mkdirSync(constantsDir, { recursive: true });
    const constantsFile = path.join(constantsDir, 'constants.js');
    const personal = ['al', 'ex'].join('');
    const declaration = "const OWNER_ACTOR_SHORT = Object.freeze(['owner', '" + personal + "']);";
    fs.writeFileSync(constantsFile, declaration + '\n');
    fs.writeFileSync(constantsFile, "const OWNER_ACTOR_SHORT = Object.freeze(['owner']);\n");
    assert.deepEqual(scan(dir, env).findings, [], 'the owner alias is generic and resolves through configured owner identity');
    fs.appendFileSync(constantsFile, '// ' + personal + '\n');
    assert.ok(scan(dir, env).findings.some((hit) => hit.rule === 'private person name'), 'other names in the same file fail');
    fs.writeFileSync(file, declaration);
    assert.ok(scan(dir, env).findings.some((hit) => hit.file === 'unexpected/blob.unknown' && hit.rule === 'private person name'), 'the personal alias fails outside the removed legacy declaration');
    fs.rmSync(path.join(dir, 'src'), { recursive: true });
    fs.unlinkSync(file);
    fs.writeFileSync(path.join(dir, env.OC_GATEWAY_TOKEN + '.txt'), '');
    assert.equal(JSON.stringify(scan(dir, env).findings).includes(env.OC_GATEWAY_TOKEN), false, 'credential filenames are redacted');
    fs.unlinkSync(path.join(dir, env.OC_GATEWAY_TOKEN + '.txt'));
    fs.mkdirSync(path.join(dir, 'instance'));
    assert.ok(scan(dir, env).findings.some(h => h.rule === 'local-only path'));
    fs.rmdirSync(path.join(dir, 'instance'));
    fs.symlinkSync(root, file);
    assert.equal(scan(dir, env).findings[0].rule, 'symlink');
    const missingEmail = spawnSync(process.execPath, [path.join(root, 'packaging/check-public.js'), dir], { env: { PATH: process.env.PATH }, encoding: 'utf8' });
    assert.equal(missingEmail.status, 2);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('export excludes history and captures, preserves runtime integration, and rebuilds reproducibly', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-public-export-'));
  try {
    exportTree(dir);
    for (const file of ['.git', 'instance', 'CLAUDE.md', 'agent-office.service', 'design/reports', 'design/explorations', 'test/fixtures/local', 'test/golden/local', 'design/assets/tools']) {
      assert.equal(fs.existsSync(path.join(dir, file)), false, file);
    }
    assert.ok(fs.existsSync(path.join(dir, 'integrations/openclaw/projet/projet.js')));
    for (const file of ['public/v2/assets/connectors/openclaw.svg', 'public/v2/assets/connectors/claude-code.svg', 'public/v2/assets/connectors/codex.svg', 'public/v2/assets/connectors/codex-dark.svg', 'public/v2/assets/connectors/provenance.json']) {
      assert.ok(fs.existsSync(path.join(dir, file)), `${file} is present in the public export`);
    }
    assert.ok(fs.existsSync(path.join(dir, 'design/assets/Office/monitor-screens/manifest.json')), 'registered monitor frame enumeration remains available to a public rebuild');
    const before = fs.readFileSync(path.join(dir, 'public/v2/index.html'), 'utf8');
    const build = spawnSync(process.execPath, ['scripts/build-frontend.js'], { cwd: dir, encoding: 'utf8' });
    assert.equal(build.status, 0, build.stderr);
    assert.equal(fs.readFileSync(path.join(dir, 'public/v2/index.html'), 'utf8'), before);
    assert.throws(() => exportTree(dir), /absent or empty/);
    assert.throws(() => exportTree(root), /contain the source/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
