'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const cli = require('../../packaging/bin/agent-office.js');

const bin = path.join(__dirname, '..', '..', 'packaging', 'bin', 'agent-office.js');
const SECRET = 'token-value-should-not-appear';

function run(args, env) {
  return spawnSync(process.execPath, [bin, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

describe('agent-office bin', () => {
  it('prints the package version and nothing else', () => {
    const version = cli.readVersion(cli.packageRoot());
    assert.equal(version, JSON.parse(fs.readFileSync(path.join(cli.packageRoot(), 'package.json'), 'utf8')).version);
    const result = run(['version']);
    assert.equal(result.status, 0);
    assert.equal(result.stdout, `${version}\n`);
    assert.equal(result.stderr, '');
  });

  it('plans an API-only start without printing secrets', () => {
    const parsed = cli.parseArgs(['node', 'agent-office', 'start', '--api-only', '--data', '/var/lib/agent-office', '--config', '/etc/agent-office/config.json']);
    const job = cli.spawnPlan(parsed, { PORTAL_SECRET: SECRET, PATH: '/usr/bin' }, cli.packageRoot());
    assert.equal(path.basename(job.script), 'server.js');
    assert.equal(job.env.AO_API_ONLY, '1');
    assert.equal(job.env.AO_DATA_DIR, '/var/lib/agent-office');
    assert.equal(job.env.AO_CONFIG, '/etc/agent-office/config.json');
    assert.equal(job.env.PORTAL_SECRET, SECRET);
    assert.equal(JSON.stringify({ script: job.script, args: job.args }).includes(SECRET), false);
  });

  it('plans the one-port start unless the API-only flag or env is set', () => {
    const parsed = cli.parseArgs(['node', 'agent-office', 'start', '--port', '18789']);
    const job = cli.spawnPlan(parsed, {}, cli.packageRoot());
    assert.equal(path.basename(job.script), 'combined.js');
    assert.equal(job.env.AO_API_ONLY, undefined);
    assert.equal(job.env.PORT, '18789');
    const forced = cli.spawnPlan(parsed, { AO_API_ONLY: '1' }, cli.packageRoot());
    assert.equal(path.basename(forced.script), 'server.js');
    assert.equal(forced.env.AO_API_ONLY, '1');
  });

  it('plans the static UI on serve-frontend.js', () => {
    const parsed = cli.parseArgs(['node', 'agent-office', 'web', '--host', '0.0.0.0', '--port', '8080']);
    const job = cli.spawnPlan(parsed, { PORTAL_SECRET: SECRET }, cli.packageRoot());
    assert.equal(job.script.endsWith(`${path.sep}scripts${path.sep}serve-frontend.js`), true);
    assert.equal(job.env.HOST, '0.0.0.0');
    assert.equal(job.env.PORT, '8080');
    assert.equal(job.env.AO_API_ONLY, undefined);
  });

  it('check-config names missing variables and does not echo values', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-cfg-'));
    const missing = cli.checkConfig({
      OC_GATEWAY_TOKEN: SECRET,
      PORTAL_EMAIL: 'owner@example.com',
      PORTAL_PASSWORD: SECRET,
      AO_CONFIG: path.join(dir, 'missing.json'),
    });
    assert.equal(missing.ok, false);
    assert.equal(missing.lines.includes('PORTAL_SECRET: missing'), true);
    assert.equal(missing.lines.includes('OC_GATEWAY_TOKEN: ok'), true);
    assert.equal(missing.lines.includes('AO_CONFIG: missing'), true);
    assert.equal(missing.lines.join('\n').includes(SECRET), false);
    assert.equal(missing.lines.join('\n').includes('owner@example.com'), false);
    assert.equal(missing.lines.join('\n').includes(dir), false);

    const present = cli.checkConfig({
      OC_GATEWAY_TOKEN: SECRET,
      PORTAL_EMAIL: 'owner@example.com',
      PORTAL_PASSWORD: SECRET,
      PORTAL_SECRET: SECRET,
      AO_DATA_DIR: dir,
      AO_CONFIG: path.join(dir, 'config.json'),
    }, () => true);
    assert.equal(present.ok, true);
    assert.equal(present.lines.includes('AO_DATA_DIR: ok'), true);
    assert.equal(present.lines.includes('AO_CONFIG: ok'), true);
    assert.equal(present.lines.join('\n').includes(SECRET), false);
    assert.equal(present.lines.join('\n').includes(dir), false);

    const opted = run(['check-config', '--config', path.join(dir, 'missing.json'), '--data', dir], {
      OC_GATEWAY_TOKEN: SECRET,
      PORTAL_EMAIL: 'owner@example.com',
      PORTAL_PASSWORD: SECRET,
      PORTAL_SECRET: SECRET,
    });
    assert.equal(opted.status, 0);
    assert.match(opted.stdout, /AO_CONFIG: missing/);
    assert.match(opted.stdout, /AO_DATA_DIR: ok/);
    assert.equal(opted.stdout.includes(dir), false);
    assert.equal(opted.stdout.includes(SECRET), false);

    const proc = run(['check-config'], {
      OC_GATEWAY_TOKEN: SECRET,
      PORTAL_EMAIL: 'owner@example.com',
      PORTAL_PASSWORD: SECRET,
      PORTAL_SECRET: '',
    });
    assert.equal(proc.status, 1);
    assert.equal(`${proc.stdout}${proc.stderr}`.includes(SECRET), false);
    assert.match(proc.stdout, /PORTAL_SECRET: missing/);

    const hash = 'scrypt:16384:8:1:salt:key';
    const hashOnly = cli.checkConfig({
      OC_GATEWAY_TOKEN: SECRET,
      PORTAL_EMAIL: 'owner@example.com',
      PORTAL_PASSWORD_HASH: hash,
      PORTAL_SECRET: SECRET,
    });
    assert.equal(hashOnly.ok, true);
    assert.equal(hashOnly.lines.includes('PORTAL_PASSWORD_HASH: ok'), true);
    assert.equal(hashOnly.lines.includes('PORTAL_PASSWORD: missing'), false);
    assert.equal(hashOnly.lines.join('\n').includes(hash), false);
    assert.equal(present.lines.includes('PORTAL_PASSWORD: ok'), true);
    assert.equal(present.lines.includes('PORTAL_PASSWORD_HASH: missing'), true);

    const neither = cli.checkConfig({
      OC_GATEWAY_TOKEN: SECRET,
      PORTAL_EMAIL: 'owner@example.com',
      PORTAL_SECRET: SECRET,
    });
    assert.equal(neither.ok, false);
    assert.equal(neither.lines.includes('PORTAL_PASSWORD_HASH: missing'), true);
    assert.equal(neither.lines.includes('PORTAL_PASSWORD: missing'), true);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('the Homebrew formula names node, the npm tarball, a service, and a test', () => {
    const src = fs.readFileSync(path.join(cli.packageRoot(), 'packaging', 'homebrew', 'agent-office.rb'), 'utf8');
    assert.match(src, /depends_on "node"/);
    assert.match(src, /registry\.npmjs\.org\/@alexdeg92\/agent-office\/-\/agent-office-/);
    assert.match(src, /license "MIT"/);
    assert.match(src, /service do/);
    assert.match(src, /test do/);
    assert.match(src, /agent-office-service/);
    assert.equal(src.includes('SHA256_REPLACE'), false);
    assert.equal(/PORTAL_(PASSWORD|SECRET)\s*=\s*"/.test(src), false);
  });

  it('forwards SIGTERM and SIGINT to the start and web children and exits with their code', async () => {
    const { backendTarget } = require('../../packaging/bin/combined.js');
    assert.deepEqual(backendTarget('/backend/api/v2/meta'), { path: '/api/v2/meta' });
    assert.equal(backendTarget('/backend//secret').bad, true);
    assert.equal(backendTarget('/backend/%2e%2e/x').bad, true);
    assert.equal(backendTarget('/'), null);

    async function stop(kind, signal, markerText, code) {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-sig-'));
      const marker = path.join(root, 'marker');
      const ready = path.join(root, 'ready');
      fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
      const body = `'use strict';const fs=require('fs');fs.writeFileSync(${JSON.stringify(ready)},'1');`
        + `process.on('SIGTERM',()=>{fs.writeFileSync(${JSON.stringify(marker)},'TERM');process.exit(7)});`
        + `process.on('SIGINT',()=>{fs.writeFileSync(${JSON.stringify(marker)},'INT');process.exit(8)});`
        + `setInterval(()=>{},1000);`;
      fs.writeFileSync(kind === 'web' ? path.join(root, 'scripts', 'serve-frontend.js') : path.join(root, 'server.js'), body);
      const args = kind === 'web' ? ['web'] : ['start', '--api-only'];
      const parent = spawn(process.execPath, ['-e', `
        const { spawn } = require('node:child_process');
        const cli = require(${JSON.stringify(bin)});
        const parsed = cli.parseArgs(['node','agent-office',${args.map((a) => JSON.stringify(a)).join(',')}]);
        const job = cli.spawnPlan(parsed, {}, ${JSON.stringify(root)});
        const child = spawn(process.execPath, [job.script], { env: job.env, stdio: 'ignore' });
        cli.superviseChild(child).then((status) => process.exit(status));
      `], { stdio: 'ignore' });
      for (let i = 0; i < 50 && !fs.existsSync(ready); i += 1) await new Promise((r) => setTimeout(r, 20));
      assert.equal(fs.existsSync(ready), true);
      process.kill(parent.pid, signal);
      const status = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('supervisor did not exit')), 5000);
        parent.on('exit', (exitCode) => { clearTimeout(timer); resolve(exitCode); });
      });
      assert.equal(status, code);
      assert.equal(fs.readFileSync(marker, 'utf8'), markerText);
      fs.rmSync(root, { recursive: true, force: true });
    }
    await stop('start', 'SIGTERM', 'TERM', 7);
    await stop('web', 'SIGINT', 'INT', 8);
  });

  it('loads --env-file for check-config and the child, without printing values', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-env-'));
    const file = path.join(dir, 'agent-office.env');
    const token = 'from-file-token';
    fs.writeFileSync(file, [
      `OC_GATEWAY_TOKEN=${token}`,
      'PORTAL_EMAIL=owner@example.com',
      'PORTAL_PASSWORD=from-file-password',
      'PORTAL_SECRET=from-file-secret',
      '# comment',
      'export PORTAL_READONLY=1',
      '',
    ].join('\n'));
    const parsed = cli.parseArgs(['node', 'agent-office', 'check-config', '--env-file', file]);
    assert.equal(parsed.opts.envFile, file);
    const loaded = cli.loadEnvFile(file, { PORTAL_SECRET: 'already-set' });
    assert.equal(loaded.PORTAL_SECRET, 'already-set');
    assert.equal(loaded.OC_GATEWAY_TOKEN, token);
    assert.equal(loaded.PORTAL_READONLY, '1');
    let out = '';
    let err = '';
    const code = cli.main(['node', 'agent-office', 'check-config', '--env-file', file], {}, {
      stdout: { write(chunk) { out += chunk; } },
      stderr: { write(chunk) { err += chunk; } },
      fileExists: () => false,
    });
    assert.equal(code, 0);
    assert.equal(err, '');
    assert.match(out, /OC_GATEWAY_TOKEN: ok/);
    assert.equal(out.includes(token), false);
    assert.equal(out.includes('from-file-secret'), false);
    const missing = cli.main(['node', 'agent-office', 'check-config', '--env-file', path.join(dir, 'missing')], {}, {
      stdout: { write() {} },
      stderr: { write(chunk) { err += chunk; } },
    });
    assert.equal(missing, 1);
    assert.match(err, /cannot read env file/);
    assert.equal(err.includes(token), false);
    let seen = null;
    const started = await cli.main(['node', 'agent-office', 'start', '--api-only', '--env-file', file], {}, {
      spawn(_exe, args, options) {
        seen = { args, env: options.env };
        return {
          on(event, fn) { if (event === 'exit') fn(0); },
          kill() {},
        };
      },
      stdout: { write() {} },
      stderr: { write() {} },
    });
    assert.equal(started, 0);
    assert.equal(seen.env.OC_GATEWAY_TOKEN, token);
    assert.equal(seen.env.AO_API_ONLY, '1');
    assert.equal(JSON.stringify(seen.args).includes(token), false);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('rejects an unknown argument', () => {
    assert.throws(() => cli.parseArgs(['node', 'agent-office', 'start', '--owner', 'someone']), /unknown argument/);
    const proc = run(['start', '--nope']);
    assert.equal(proc.status, 2);
    assert.match(proc.stderr, /unknown argument/);
  });

  it('hash-password prints only a stdin hash and refuses an argument', async () => {
    const { verifyPassword } = require('../../src/security/password');
    const password = 'correct horse battery';
    const fromEnv = 'environment-password-value';
    const hashed = spawnSync(process.execPath, [bin, 'hash-password'], {
      encoding: 'utf8',
      input: `${password}\n`,
      env: { ...process.env, PORTAL_PASSWORD: fromEnv, PORTAL_PASSWORD_HASH: 'scrypt:not-used' },
    });
    assert.equal(hashed.status, 0, hashed.stderr);
    assert.match(hashed.stdout, /^scrypt:\d+:\d+:\d+:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+\n$/);
    assert.equal(`${hashed.stdout}${hashed.stderr}`.includes(password), false);
    assert.equal(`${hashed.stdout}${hashed.stderr}`.includes(fromEnv), false);
    assert.equal(await verifyPassword(password, hashed.stdout.trim()), true);
    assert.equal(await verifyPassword(fromEnv, hashed.stdout.trim()), false);

    const short = spawnSync(process.execPath, [bin, 'hash-password'], { encoding: 'utf8', input: 'court\n' });
    assert.equal(short.status, 1);
    assert.equal(short.stdout, '');

    const refused = spawnSync(process.execPath, [bin, 'hash-password', password], {
      encoding: 'utf8',
      env: { ...process.env, PORTAL_PASSWORD: fromEnv },
    });
    assert.equal(refused.status, 2);
    assert.equal(`${refused.stdout}${refused.stderr}`.includes(password), false);
    assert.equal(`${refused.stdout}${refused.stderr}`.includes(fromEnv), false);
  });

  it('a missing --env-file stays ours on the shebang, the Homebrew wrapper, and the Docker entrypoint', () => {
    const root = path.join(__dirname, '..', '..');
    const shebang = fs.readFileSync(bin, 'utf8').split('\n')[0];
    assert.equal(shebang, '#!/usr/bin/env -S node --');

    const dockerfile = fs.readFileSync(path.join(root, 'packaging', 'docker', 'Dockerfile'), 'utf8');
    const entryLine = dockerfile.match(/^ENTRYPOINT (\[.*\])$/m);
    assert.ok(entryLine, 'Dockerfile has an ENTRYPOINT');
    const entrypoint = JSON.parse(entryLine[1]);
    assert.deepEqual(entrypoint, ['node', '--', 'packaging/bin/agent-office.js']);

    const formula = fs.readFileSync(path.join(root, 'packaging', 'homebrew', 'agent-office.rb'), 'utf8');
    assert.match(formula, /exec "\$AO"/);
    assert.equal(/exec\s+node\b/.test(formula), false);

    const missing = path.join(os.tmpdir(), `ao-missing-env-${process.pid}`);
    const ours = (result, label) => {
      const text = `${result.stdout || ''}${result.stderr || ''}`;
      assert.equal(result.status, 1, `${label}: ${text}`);
      assert.match(result.stderr, /cannot read env file/);
      assert.equal(text.includes(missing), false, label);
      assert.equal(text.includes('not found'), false, label);
    };

    ours(spawnSync(bin, ['check-config', '--env-file', missing], { encoding: 'utf8' }), 'shebang');

    const dockerArgv = entrypoint.map((part) => {
      if (part === 'node') return process.execPath;
      if (part === 'packaging/bin/agent-office.js') return bin;
      return part;
    });
    ours(spawnSync(dockerArgv[0], [...dockerArgv.slice(1), 'check-config', '--env-file', missing], { encoding: 'utf8' }), 'docker');

    const wrapper = path.join(os.tmpdir(), `ao-brew-wrap-${process.pid}`);
    fs.writeFileSync(wrapper, `#!/bin/bash\nAO=${JSON.stringify(bin)}\nexec "$AO" check-config --env-file ${JSON.stringify(missing)}\n`, { mode: 0o755 });
    try {
      ours(spawnSync(wrapper, { encoding: 'utf8' }), 'homebrew');
    } finally {
      fs.rmSync(wrapper, { force: true });
    }
  });
});
