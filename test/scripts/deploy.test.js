'use strict';
// Hermetic checks for scripts/deploy.js. Each review-23 case is a separate test.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const root = path.join(__dirname, '..', '..');
const script = path.join(root, 'scripts', 'deploy.js');
const golive = path.join(root, 'scripts', 'golive-smoke.sh');
const CANARY = 'canary-deploy-secret-value';
const SMOKE_PW = 'smoke-only-password';

function rmTree(dir) {
  spawnSync('chmod', ['-R', 'u+w', dir], { stdio: 'ignore' });
  fs.rmSync(dir, { recursive: true, force: true });
}
const SHA = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const OLD = [
  'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  'cccccccccccccccccccccccccccccccccccccccc',
  'dddddddddddddddddddddddddddddddddddddddd',
  'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
];
const PARKED = 'ffffffffffffffffffffffffffffffffffffffff';

function writeExec(file, body) {
  fs.writeFileSync(file, body);
  fs.chmodSync(file, 0o755);
}

function fixture(opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-deploy-'));
  const bin = path.join(dir, 'bin');
  const releases = path.join(dir, 'releases');
  const units = path.join(dir, 'units');
  const repo = path.join(dir, 'repo');
  fs.mkdirSync(bin);
  fs.mkdirSync(releases);
  fs.mkdirSync(units);
  fs.mkdirSync(repo);
  fs.mkdirSync(path.join(dir, '.config'), { recursive: true });
  const token = opts.token || 'tok';
  const spaced = opts.spaced ? `OC_GATEWAY_TOKEN=alpha bravo\nPORTAL_SECRET=ok$(touch ${dir}/pwned)\n` : `PORTAL_SECRET=sess\nOC_GATEWAY_TOKEN=${token}\n`;
  fs.writeFileSync(path.join(dir, '.config', 'agent-office.env'), `PORTAL_EMAIL=owner@example.invalid\nPORTAL_PASSWORD=${CANARY}\n${spaced}`);
  fs.writeFileSync(path.join(dir, '.config', 'agent-office-golive.env'), 'PORT=18797\nHOST=127.0.0.1\nAO_API_ONLY=1\n');
  fs.writeFileSync(path.join(dir, '.config', 'agent-office-prod.env'), `PORTAL_EMAIL=owner@example.invalid\nPORTAL_PASSWORD_HASH=scrypt:x\nPORTAL_SECRET=sess\nOC_GATEWAY_TOKEN=tok\n`);
  const link = path.join(releases, 'current-rehearsal');
  const prodLink = path.join(releases, 'current');
  const log = path.join(dir, 'systemctl.log');
  const gitLog = path.join(dir, 'git.log');
  const npmLog = path.join(dir, 'npm.log');
  const nodeLog = path.join(dir, 'node.log');
  const stepLog = path.join(dir, 'systemd-run.log');
  const stepsDir = path.join(dir, 'steps');
  if (!opts.realGit) writeExec(path.join(bin, 'git'), `#!/bin/sh
printf '%s\\n' "$*" >> ${JSON.stringify(gitLog)}
gitdir=
if [ "$1" = "-C" ]; then gitdir=$2; shift 2; fi
case "$1" in
  rev-parse)
    if [ "$2" = "HEAD" ] && [ -n "$gitdir" ] && [ -f "$gitdir/HEAD" ]; then cat "$gitdir/HEAD"; exit 0; fi
    arg=$2
    if [ "$2" = "--verify" ]; then arg=$3; fi
    case "$arg" in
      [0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]*)
        printf '%s\\n' "\${arg%%^*}"; exit 0 ;;
    esac
    printf '%s\\n' ${SHA}; exit 0 ;;
  archive)
    sha=
    for a in "$@"; do
      case "$a" in
        [0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]*)
          sha=\${a%%^*} ;;
      esac
    done
    tmp=\$(mktemp -d)
    printf '%s\\n' "\$sha" > "\$tmp/HEAD"
    tar -c -C "\$tmp" .
    rm -rf "\$tmp"
    exit 0 ;;
  worktree)
    if [ "$2" = "add" ]; then mkdir -p "$4"; printf '%s\\n' "\${5%%^*}" > "$4/HEAD"; exit 0; fi
    if [ "$2" = "remove" ]; then rm -rf "$4"; exit 0; fi
    ;;
esac
exit 0
`);
  writeExec(path.join(bin, 'npm'), `#!/bin/sh
printf '%s\\n' "$*" >> ${JSON.stringify(npmLog)}
if [ "\${NPM_FAIL:-0}" = 1 ]; then exit 1; fi
if [ "\${NPM_HANG:-0}" = 1 ]; then echo $$ > ${JSON.stringify(path.join(dir, 'npm.pid'))}; exec /bin/sleep 60; fi
if [ "\${NPM_LATE:-0}" = 1 ]; then echo $$ > ${JSON.stringify(path.join(dir, 'npm.pid'))}; pwd > ${JSON.stringify(path.join(dir, 'npm.cwd'))}; while [ ! -f ${JSON.stringify(path.join(dir, 'late.gate'))} ]; do sleep 0.05; done; echo late > "\$PWD/LATE"; exit 0; fi
if [ "\${NPM_BG:-0}" = 1 ]; then
  (
    echo $$ > ${JSON.stringify(path.join(dir, 'bg.pid'))}
    echo started > ${JSON.stringify(path.join(dir, 'bg.started'))}
    while [ ! -f ${JSON.stringify(path.join(dir, 'bg.gate'))} ]; do sleep 0.05; done
    echo LATE-BACKGROUND > "\$PWD/LATE-BACKGROUND"
  ) &
  i=0
  while [ ! -f ${JSON.stringify(path.join(dir, 'bg.started'))} ]; do
    i=\$((i+1))
    if [ "\$i" -gt 50 ]; then exit 1; fi
    sleep 0.05
  done
  exit 0
fi
exit 0
`);
  writeExec(path.join(bin, 'systemd-run'), `#!${process.execPath}
'use strict';
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const log = ${JSON.stringify(stepLog)};
const steps = ${JSON.stringify(stepsDir)};
const args = process.argv.slice(2);
fs.appendFileSync(log, args.join(' ') + '\\n');
let unit = '';
let cwd = '';
const env = { ...process.env };
const cmd = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--') { cmd.push(...args.slice(i + 1)); break; }
  if (a.startsWith('--unit=')) unit = a.slice('--unit='.length);
  else if (a.startsWith('--property=WorkingDirectory=')) cwd = a.slice('--property=WorkingDirectory='.length);
  else if (a.startsWith('--setenv=')) {
    const rest = a.slice('--setenv='.length);
    const eq = rest.indexOf('=');
    if (eq > 0) env[rest.slice(0, eq)] = rest.slice(eq + 1);
  }
}
if (!cmd.length || !unit) process.exit(1);
fs.mkdirSync(steps, { recursive: true });
const child = spawn(cmd[0], cmd.slice(1), {
  cwd: cwd || undefined,
  env,
  detached: true,
  stdio: ['ignore', 'inherit', 'inherit'],
});
const pidfile = path.join(steps, unit + '.pid');
const finish = (code) => {
  try { process.kill(-child.pid, 'SIGKILL'); } catch { /* group already gone */ }
  try { fs.unlinkSync(pidfile); } catch { /* gone */ }
  process.exit(code == null ? 1 : code);
};
child.on('error', () => finish(1));
if (child.pid) fs.writeFileSync(pidfile, String(child.pid) + '\\n');
child.on('exit', (code) => finish(code));
`);
  writeExec(path.join(bin, 'node'), `#!/bin/sh
printf '%s\\n' "$*" >> ${JSON.stringify(nodeLog)}
if [ "$1" = "--check" ]; then
  if [ "$2" = "scripts/serve-frontend.js" ] && [ "\${SYNTAX_FAIL:-0}" = 1 ]; then exit 1; fi
  exit 0
fi
if [ "$1" = "-e" ]; then exit 0; fi
case "$1" in
  *smoke.js) exec ${JSON.stringify(process.execPath)} "$@" ;;
esac
exit 0
`);
  if (!opts.realCurl) {
    writeExec(path.join(bin, 'curl'), '#!/bin/sh\nprintf %s 200\nexit 0\n');
  }
  writeExec(path.join(bin, 'systemctl'), `#!/bin/sh
printf '%s\\n' "$*" >> ${JSON.stringify(log)}
prop=
prev=
unit=
for a in "$@"; do
  if [ "$prev" = "-p" ]; then prop=$a; fi
  prev=$a
  case "$a" in
    --user|-p|--value|--no-pager) ;;
    *) unit=$a ;;
  esac
done
piddir=${JSON.stringify(path.join(dir, 'pids'))}
mkdir -p "$piddir"
case "$2" in
  show)
    if [ "$prop" = "MainPID" ]; then
      if [ -f "$piddir/$unit" ]; then cat "$piddir/$unit"; else printf '0\\n'; fi
      exit 0
    fi
    ${JSON.stringify(process.execPath)} -e '
      const { loadUnit } = require(process.argv[1]);
      const u = loadUnit(process.argv[2]);
      const cmd = u.execStart.length ? u.execStart[u.execStart.length - 1] : "";
      const bin = (cmd.split(/\\s+/)[0]) || "";
      process.stdout.write("ExecStart={ path=" + bin + " ; argv[]=" + cmd + " ; ignore_errors=no ; pid=0 }\\n");
    ' ${JSON.stringify(script)} ${JSON.stringify(units)}/"$unit"
    exit 0
    ;;
  restart)
    n=$(grep -c ' restart ' ${JSON.stringify(log)} || true)
    if [ "\${FAIL_FIRST_RESTARTS:-0}" != 0 ] && [ "$n" -le "\${FAIL_FIRST_RESTARTS:-0}" ]; then exit 1; fi
    if [ "\${RESTART_LEAK:-0}" = 1 ]; then printf '%s\\n' "\${LEAK_VALUE:-}" >&2; fi
    wd=$(${JSON.stringify(process.execPath)} -e '
      const { loadUnit } = require(process.argv[1]);
      process.stdout.write(loadUnit(process.argv[2]).workingDirectory || "");
    ' ${JSON.stringify(script)} ${JSON.stringify(units)}/"$unit")
    if [ -f "$piddir/$unit" ]; then kill "$(cat "$piddir/$unit")" 2>/dev/null || true; fi
    if [ -n "$wd" ] && [ -d "$wd" ]; then
      ${JSON.stringify(process.execPath)} -e '
        const { spawn } = require("child_process");
        const fs = require("fs");
        const child = spawn("/bin/sleep", ["120"], { cwd: process.argv[1], detached: true, stdio: "ignore" });
        child.unref();
        fs.writeFileSync(process.argv[2], String(child.pid) + "\\n");
      ' "$wd" "$piddir/$unit"
    fi
    ;;
  stop)
    base=\${unit%.service}
    pidfile=${JSON.stringify(stepsDir)}/"\$base.pid"
    if [ -f "\$pidfile" ]; then
      pid=\$(tr -d ' \\n' < "\$pidfile")
      kill -TERM -"\$pid" 2>/dev/null || kill -TERM "\$pid" 2>/dev/null || true
      i=0
      while [ "\$i" -lt 40 ]; do
        kill -0 "\$pid" 2>/dev/null || exit 0
        sleep 0.05
        i=\$((i+1))
      done
      kill -KILL -"\$pid" 2>/dev/null || kill -KILL "\$pid" 2>/dev/null || true
    fi
    exit 0
    ;;
esac
exit 0
`);
  const smoke = path.join(dir, 'smoke.sh');
  const smokeLog = path.join(dir, 'smoke.log');
  writeExec(smoke, `#!/bin/sh
log=${JSON.stringify(smokeLog)}
if [ -z "\${AO_SMOKE_FILE:-}" ] || [ ! -f "\$AO_SMOKE_FILE" ]; then printf 'cred=missing\\n' >> "\$log"; exit 1; fi
printf 'cred-mode=%s\\n' "\$(stat -c %a "\$AO_SMOKE_FILE")" >> "\$log"
exp=\$(mktemp)
${JSON.stringify(process.execPath)} - "\$AO_SMOKE_FILE" > "\$exp" <<'EOF'
const fs = require('fs');
const text = fs.readFileSync(process.argv[2], 'utf8');
const sh = (v) => "'" + String(v).replace(/'/g, "'\\\\''") + "'";
for (const line of text.split('\\n')) {
  if (!line || line.startsWith('#')) continue;
  const eq = line.indexOf('=');
  if (eq < 1) continue;
  const key = line.slice(0, eq);
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
  process.stdout.write('export ' + key + '=' + sh(line.slice(eq + 1)) + '\\n');
}
EOF
. "\$exp"
rm -f "\$exp"
printf '%s\\n' "email=\${PORTAL_EMAIL+set} password=\${PORTAL_PASSWORD+set}" >> "\$log"
if [ "\${SMOKE_LEAK:-0}" = 1 ]; then ${JSON.stringify(process.execPath)} -e 'process.stderr.write(JSON.stringify({token:process.env.OC_GATEWAY_TOKEN})+"\\n")'; exit 1; fi
if [ "\${SMOKE_FRAG:-0}" = 1 ]; then ${JSON.stringify(process.execPath)} -e 'const t=process.env.OC_GATEWAY_TOKEN||""; process.stdout.write(t.slice(0,12)+"\\n"); process.stderr.write(t.slice(-12)+"\\n");'; exit "\${SMOKE_EXIT:-0}"; fi
if [ "\${PORTAL_PASSWORD:-}" = ${JSON.stringify(SMOKE_PW)} ]; then printf 'password=match\\n' >> "\$log"; fi
if [ -n "\${PORTAL_PASSWORD:-}" ] && [ "\${PORTAL_PASSWORD}" != ${JSON.stringify(SMOKE_PW)} ]; then printf 'password=other\\n' >> "\$log"; fi
exit "\${SMOKE_EXIT:-0}"
`);
  const env = {
    ...process.env,
    HOME: dir,
    PATH: `${bin}${opts.realCurl ? ':/usr/bin' : ''}:/usr/bin:/bin`,
    DEPLOY_RELEASES_ROOT: releases,
    DEPLOY_REPO: repo,
    DEPLOY_UNIT_DIR: units,
    DEPLOY_SYSTEMCTL: path.join(bin, 'systemctl'),
    DEPLOY_SMOKE: opts.smoke || smoke,
    DEPLOY_PUBLIC_URL: opts.publicUrl || 'http://127.0.0.1:9',
    AO_SMOKE_PASSWORD: opts.password === undefined ? SMOKE_PW : opts.password,
    SMOKE_EXIT: opts.smokeExit || '0',
    NPM_FAIL: opts.npmFail || '0',
    NPM_HANG: opts.npmHang || '0',
    RESTART_LEAK: opts.restartLeak || '0',
    SMOKE_LEAK: opts.smokeLeak || '0',
    SMOKE_FRAG: opts.smokeFrag || '0',
    NPM_LATE: opts.npmLate || '0',
    NPM_BG: opts.npmBg || '0',
    DEPLOY_GATE: opts.gate || '',
    DEPLOY_GATE_FILE: opts.gateFile || '',
    LEAK_VALUE: opts.token || '',
    DEPLOY_KILL_TIMEOUT_MS: '500',
    SYNTAX_FAIL: opts.syntaxFail || '0',
    FAIL_FIRST_RESTARTS: opts.failRestarts || '0',
    DEPLOY_FAIL_RESTORE: opts.failRestore || '0',
    DEPLOY_INTERRUPT: opts.interrupt || '',
    DEPLOY_SCOPE: '0',
  };
  if (opts.inheritPassword) env.PORTAL_PASSWORD = 'inherited-plaintext-password';
  if (opts.password === '') delete env.AO_SMOKE_PASSWORD;
  return { dir, bin, repo, releases, units, link, prodLink, log, gitLog, npmLog, nodeLog, stepLog, smokeLog, env, smoke };
}

function unit(link, extra = '') {
  return `[Service]\nWorkingDirectory=${link}\nExecStart=/usr/bin/node ${link}/server.js\n${extra}`;
}

function writeRehearsalUnits(fx, text) {
  const body = text || unit(fx.link);
  for (const name of ['agent-office-golive-api.service', 'agent-office-golive-web.service']) {
    fs.writeFileSync(path.join(fx.units, name), body);
  }
}

function writeProdUnits(fx) {
  const body = unit(fx.prodLink);
  for (const name of ['agent-office-api.service', 'agent-office-web.service']) {
    fs.writeFileSync(path.join(fx.units, name), body);
  }
}

function reap(fx) {
  const piddir = path.join(fx.dir, 'pids');
  if (!fs.existsSync(piddir)) return;
  for (const name of fs.readdirSync(piddir)) {
    const pid = Number(fs.readFileSync(path.join(piddir, name), 'utf8'));
    if (pid) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
  }
}

function run(fx, args = ['--target', 'rehearsal', SHA]) {
  const result = spawnSync(process.execPath, [script, ...args], { env: fx.env, encoding: 'utf8', timeout: 20000 });
  if (!fx.keepPids) reap(fx);
  return result;
}

function output(result) {
  return result.stdout + result.stderr;
}

describe('scripts/deploy.js', () => {
  it('switches the symlink, restarts only the two rehearsal units, and does not print the env secret', () => {
    const fx = fixture();
    fs.mkdirSync(path.join(fx.releases, OLD[3]));
    fs.symlinkSync(path.join(fx.releases, OLD[3]), fx.link);
    fs.writeFileSync(path.join(fx.releases, '.history-rehearsal'), OLD.join('\n') + '\n');
    for (const sha of OLD) fs.mkdirSync(path.join(fx.releases, sha), { recursive: true });
    writeRehearsalUnits(fx);
    const result = run(fx);
    assert.equal(result.status, 0, output(result));
    assert.equal(output(result).includes(CANARY), false);
    assert.equal(output(result).includes(SMOKE_PW), false);
    assert.equal(fs.readlinkSync(fx.link), path.join(fx.releases, SHA));
    const ctl = fs.readFileSync(fx.log, 'utf8');
    assert.equal(ctl.includes(CANARY), false);
    const restarts = ctl.split('\n').filter((line) => line.includes(' restart '));
    assert.deepEqual(restarts, [
      '--user restart agent-office-golive-api.service',
      '--user restart agent-office-golive-web.service',
    ]);
    assert.equal(ctl.includes('openclaw-gateway') || ctl.includes('traefik'), false);
    const smoke = fs.readFileSync(fx.smokeLog, 'utf8');
    assert.match(smoke, /email=set password=set/);
    assert.match(smoke, /password=match/);
    assert.match(smoke, /cred-mode=600/);
    assert.match(result.stderr, /deploy: smoke exit 0/);
    assert.equal(smoke.includes(CANARY), false);
    assert.equal(fs.readdirSync(fx.releases).some((name) => name.startsWith('.smoke-')), false);
    const left = fs.readdirSync(fx.releases).filter((name) => /^[0-9a-f]{40}$/.test(name)).sort();
    assert.deepEqual(left, [OLD[2], OLD[3], SHA].sort());
    rmTree(fx.dir);
  });

  it('restores the previous symlink and restarts when smoke fails', () => {
    const fx = fixture({ smokeExit: '1' });
    const previous = path.join(fx.releases, OLD[3]);
    fs.mkdirSync(previous, { recursive: true });
    fs.symlinkSync(previous, fx.link);
    writeRehearsalUnits(fx);
    const result = run(fx);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /restored/);
    assert.equal(output(result).includes(CANARY), false);
    assert.equal(fs.readlinkSync(fx.link), previous);
    const restarts = fs.readFileSync(fx.log, 'utf8').split('\n').filter((line) => line.includes(' restart '));
    assert.equal(restarts.length, 4);
    assert.equal(restarts.every((line) => line.includes('agent-office-golive-')), true);
    rmTree(fx.dir);
  });

  it('does not switch or restart when ExecStart does not use the symlink', () => {
    const fx = fixture();
    fs.writeFileSync(path.join(fx.units, 'agent-office-golive-api.service'), '[Service]\nExecStart=/usr/bin/node /elsewhere/server.js\n');
    fs.writeFileSync(path.join(fx.units, 'agent-office-golive-web.service'), unit(fx.link));
    const result = run(fx);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /does not run from/);
    assert.equal(fs.existsSync(fx.gitLog), false);
    assert.equal(fs.existsSync(fx.log) && fs.readFileSync(fx.log, 'utf8').includes(' restart '), false);
    assert.equal(fs.existsSync(fx.link), false);
    rmTree(fx.dir);
  });

  it('R23-01 keeps the active release when a retry fails the last syntax check', () => {
    const fx = fixture({ syntaxFail: '1' });
    const live = path.join(fx.releases, SHA);
    fs.mkdirSync(live, { recursive: true });
    fs.writeFileSync(path.join(live, 'marker'), 'keep');
    fs.symlinkSync(live, fx.link);
    writeRehearsalUnits(fx);
    const result = run(fx);
    assert.equal(result.status, 1, output(result));
    assert.equal(fs.readlinkSync(fx.link), live);
    assert.equal(fs.readFileSync(path.join(live, 'marker'), 'utf8'), 'keep');
    const git = fs.existsSync(fx.gitLog) ? fs.readFileSync(fx.gitLog, 'utf8') : '';
    assert.equal(git.includes('worktree remove'), false);
    assert.equal(fs.existsSync(fx.npmLog), false);
    assert.equal(fs.existsSync(fx.log) && fs.readFileSync(fx.log, 'utf8').includes(' restart '), false);
    rmTree(fx.dir);
  });

  it('R23-01 does not delete the other target when a shared SHA fails preflight', () => {
    const fx = fixture({ syntaxFail: '1' });
    const shared = path.join(fx.releases, SHA);
    fs.mkdirSync(shared, { recursive: true });
    fs.writeFileSync(path.join(shared, 'marker'), 'prod');
    fs.symlinkSync(shared, fx.prodLink);
    writeRehearsalUnits(fx);
    const result = run(fx);
    assert.equal(result.status, 1, output(result));
    assert.equal(fs.readlinkSync(fx.prodLink), shared);
    assert.equal(fs.readFileSync(path.join(shared, 'marker'), 'utf8'), 'prod');
    assert.equal(fs.existsSync(fx.link), false);
    const git = fs.existsSync(fx.gitLog) ? fs.readFileSync(fx.gitLog, 'utf8') : '';
    assert.equal(git.includes('worktree remove'), false);
    rmTree(fx.dir);
  });

  it('R23-01 keeps a running unit WorkingDirectory that is not one of the newest three', () => {
    const fx = fixture();
    const parked = path.join(fx.releases, PARKED);
    fs.mkdirSync(parked, { recursive: true });
    fs.writeFileSync(path.join(parked, 'marker'), 'wd');
    fs.mkdirSync(path.join(fx.releases, OLD[3]), { recursive: true });
    fs.symlinkSync(path.join(fx.releases, OLD[3]), fx.link);
    fs.writeFileSync(path.join(fx.releases, '.history-rehearsal'), OLD[3] + '\n');
    writeRehearsalUnits(fx, `[Service]\nWorkingDirectory=${parked}\nExecStart=/usr/bin/node ${fx.link}/server.js\n`);
    const result = run(fx);
    assert.equal(result.status, 0, output(result));
    assert.equal(fs.readFileSync(path.join(parked, 'marker'), 'utf8'), 'wd');
    rmTree(fx.dir);
  });

  it('R23-02 fails when npm ci fails even if a later check would pass', () => {
    const fx = fixture({ npmFail: '1' });
    const previous = path.join(fx.releases, OLD[3]);
    fs.mkdirSync(previous, { recursive: true });
    fs.symlinkSync(previous, fx.link);
    writeRehearsalUnits(fx);
    const result = run(fx);
    assert.equal(result.status, 1, output(result));
    assert.match(result.stderr, /npm ci failed/);
    assert.equal(fs.readlinkSync(fx.link), previous);
    assert.equal(fs.existsSync(fx.nodeLog), false);
    assert.equal(fs.existsSync(fx.log) && fs.readFileSync(fx.log, 'utf8').includes(' restart '), false);
    rmTree(fx.dir);
  });

  it('R23-02 does not treat a still-active old process as a successful restart', () => {
    const fx = fixture({ failRestarts: '1' });
    const previous = path.join(fx.releases, OLD[3]);
    fs.mkdirSync(previous, { recursive: true });
    fs.symlinkSync(previous, fx.link);
    writeRehearsalUnits(fx);
    const result = run(fx);
    assert.equal(result.status, 1, output(result));
    assert.match(result.stderr, /restart failed/);
    assert.match(result.stderr, /restored/);
    assert.equal(fs.readlinkSync(fx.link), previous);
    const restarts = fs.readFileSync(fx.log, 'utf8').split('\n').filter((line) => line.includes(' restart '));
    assert.equal(restarts[0].includes('agent-office-golive-api.service'), true);
    rmTree(fx.dir);
  });

  it('R23-02 does not claim a restore when the rollback switch fails', () => {
    const fx = fixture({ smokeExit: '1', failRestore: '1' });
    const previous = path.join(fx.releases, OLD[3]);
    const next = path.join(fx.releases, SHA);
    fs.mkdirSync(previous, { recursive: true });
    fs.symlinkSync(previous, fx.link);
    writeRehearsalUnits(fx);
    const result = run(fx);
    assert.equal(result.status, 1, output(result));
    assert.equal(result.stderr.includes('restored'), false);
    assert.match(result.stderr, /restore failed/);
    assert.equal(fs.readlinkSync(fx.link), next);
    rmTree(fx.dir);
  });

  it('R23-03 refuses a hash-only profile before switching when no smoke password was given', () => {
    const fx = fixture({ password: '' });
    fx.env.PORTAL_PASSWORD = 'inherited-plaintext-password';
    const previous = path.join(fx.releases, OLD[3]);
    fs.mkdirSync(previous, { recursive: true });
    fs.symlinkSync(previous, fx.prodLink);
    writeProdUnits(fx);
    const result = run(fx, ['--target', 'prod', SHA]);
    assert.equal(result.status, 1, output(result));
    assert.match(result.stderr, /AO_SMOKE_PASSWORD/);
    assert.equal(fs.readlinkSync(fx.prodLink), previous);
    assert.equal(output(result).includes('inherited-plaintext-password'), false);
    assert.equal(fs.existsSync(fx.smokeLog), false);
    rmTree(fx.dir);
  });

  it('R23-04 keeps spaces, quotes, dollars and substitutions as data and does not run them', () => {
    const fx = fixture({ spaced: true });
    const previous = path.join(fx.releases, OLD[3]);
    fs.mkdirSync(previous, { recursive: true });
    fs.symlinkSync(previous, fx.link);
    writeRehearsalUnits(fx);
    const result = run(fx);
    assert.equal(result.status, 0, output(result));
    assert.equal(output(result).includes('bravo'), false);
    assert.equal(output(result).includes('not found'), false);
    assert.equal(output(result).includes(CANARY), false);
    assert.equal(fs.existsSync(path.join(fx.dir, 'pwned')), false);
    const smoke = fs.readFileSync(fx.smokeLog, 'utf8');
    assert.match(smoke, /password=match/);
    assert.equal(smoke.includes('bravo'), false);
    rmTree(fx.dir);
  });

  it('R23-05 exits non-zero and leaves the old link when interrupted before the switch', () => {
    const fx = fixture({ interrupt: 'before-replace' });
    const previous = path.join(fx.releases, OLD[3]);
    fs.mkdirSync(previous, { recursive: true });
    fs.symlinkSync(previous, fx.link);
    writeRehearsalUnits(fx);
    const result = run(fx);
    assert.equal(result.status, 143, output(result));
    assert.equal(fs.readlinkSync(fx.link), previous);
    assert.equal(fs.existsSync(fx.log) && fs.readFileSync(fx.log, 'utf8').includes(' restart '), false);
    rmTree(fx.dir);
  });

  it('R23-05 restores the previous link and exits non-zero when interrupted after the switch', () => {
    const fx = fixture({ interrupt: 'after-replace' });
    const previous = path.join(fx.releases, OLD[3]);
    fs.mkdirSync(previous, { recursive: true });
    fs.symlinkSync(previous, fx.link);
    writeRehearsalUnits(fx);
    const result = run(fx);
    assert.equal(result.status, 143, output(result));
    assert.match(result.stderr, /interrupted; restored/);
    assert.equal(fs.readlinkSync(fx.link), previous);
    rmTree(fx.dir);
  });

  it('R23-05 exits non-zero when interrupted during rollback', () => {
    const fx = fixture({ smokeExit: '1', interrupt: 'during-rollback' });
    const previous = path.join(fx.releases, OLD[3]);
    fs.mkdirSync(previous, { recursive: true });
    fs.symlinkSync(previous, fx.link);
    writeRehearsalUnits(fx);
    const result = run(fx);
    assert.notEqual(result.status, 0);
    assert.equal(result.status, 143, output(result));
    assert.equal(fs.readlinkSync(fx.link), previous);
    rmTree(fx.dir);
  });

  it('R23-06 ignores a symlink that appears only in a comment or another directive', () => {
    const fx = fixture();
    const comment = `# ExecStart=/usr/bin/node ${fx.link}/server.js\n[Service]\nEnvironment=NOTE=${fx.link}/\nExecStart=/usr/bin/node /elsewhere/server.js # ${fx.link}/server.js\n`;
    writeRehearsalUnits(fx, comment);
    const result = run(fx);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /does not run from/);
    assert.equal(fs.existsSync(fx.gitLog), false);
    rmTree(fx.dir);
  });

  it('R23-06 accepts an ExecStart that a drop-in sets and a comment does not', () => {
    const fx = fixture();
    const base = `[Service]\n# ${fx.link}/server.js\nExecStart=/usr/bin/node /elsewhere/server.js\n`;
    writeRehearsalUnits(fx, base);
    const drop = path.join(fx.units, 'agent-office-golive-api.service.d');
    fs.mkdirSync(drop);
    fs.writeFileSync(path.join(drop, 'override.conf'), `[Service]\nExecStart=\nExecStart=/usr/bin/node ${fx.link}/server.js\n`);
    const webDrop = path.join(fx.units, 'agent-office-golive-web.service.d');
    fs.mkdirSync(webDrop);
    fs.writeFileSync(path.join(webDrop, 'override.conf'), `[Service]\nExecStart=\nExecStart=/usr/bin/node ${fx.link}/scripts/serve-frontend.js\n`);
    const previous = path.join(fx.releases, OLD[3]);
    fs.mkdirSync(previous, { recursive: true });
    fs.symlinkSync(previous, fx.link);
    const result = run(fx);
    assert.equal(result.status, 0, output(result));
    assert.equal(fs.readlinkSync(fx.link), path.join(fx.releases, SHA));
    rmTree(fx.dir);
  });

  it('R25-01 SIGTERM after the API restart puts both units back on the previous release', () => {
    const fx = fixture({ interrupt: 'after-api-restart' });
    fx.keepPids = true;
    const previous = path.join(fx.releases, OLD[3]);
    fs.mkdirSync(previous, { recursive: true });
    fs.symlinkSync(previous, fx.link);
    writeRehearsalUnits(fx);
    const result = run(fx);
    assert.equal(result.status, 143, output(result));
    assert.match(result.stderr, /interrupted; restored/);
    assert.equal(result.stderr.includes('rollback failed'), false);
    assert.equal(fs.readlinkSync(fx.link), previous);
    for (const unit of ['agent-office-golive-api.service', 'agent-office-golive-web.service']) {
      const pid = Number(fs.readFileSync(path.join(fx.dir, 'pids', unit), 'utf8'));
      assert.equal(fs.realpathSync(fs.readlinkSync(`/proc/${pid}/cwd`)), fs.realpathSync(previous));
    }
    reap(fx);
    rmTree(fx.dir);
  });

  it('R25-02 kills the installer process group before releasing the lock', async () => {
    const fx = fixture({ npmHang: '1' });
    const previous = path.join(fx.releases, OLD[3]);
    fs.mkdirSync(previous, { recursive: true });
    fs.symlinkSync(previous, fx.link);
    writeRehearsalUnits(fx);
    const child = spawn(process.execPath, [script, '--target', 'rehearsal', SHA], { env: fx.env });
    const pidfile = path.join(fx.dir, 'npm.pid');
    for (let i = 0; i < 50 && !fs.existsSync(pidfile); i += 1) await new Promise((r) => setTimeout(r, 50));
    assert.equal(fs.existsSync(pidfile), true);
    const npmPid = Number(fs.readFileSync(pidfile, 'utf8'));
    child.kill('SIGTERM');
    const status = await new Promise((resolve) => child.on('close', resolve));
    assert.equal(status, 143);
    let alive = true;
    try { process.kill(npmPid, 0); } catch { alive = false; }
    assert.equal(alive, false);
    const lockFile = path.join(fx.releases, '.lock');
    let held = null;
    for (let i = 0; i < 40; i += 1) {
      held = spawnSync('flock', ['--exclusive', '--nonblock', lockFile, 'true'], { encoding: 'utf8' });
      if (held.status === 0) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    assert.equal(held.status, 0, held.stderr || held.stdout || 'lock still held');
    assert.equal(fs.readFileSync(lockFile, 'utf8').trim(), '');
    assert.equal(fs.readlinkSync(fx.link), previous);
    rmTree(fx.dir);
  });

  it('R25-03 a dead lock holder is recovered from the journal instead of blocking', () => {
    const fx = fixture();
    const previous = path.join(fx.releases, OLD[3]);
    const dest = path.join(fx.releases, SHA);
    fs.mkdirSync(previous, { recursive: true });
    fs.mkdirSync(dest, { recursive: true });
    fs.symlinkSync(dest, fx.link);
    fs.writeFileSync(path.join(fx.releases, '.lock'), '99999999\n');
    fs.writeFileSync(path.join(fx.releases, '.journal'), JSON.stringify({
      phase: 'switched', prev: previous, dest, sha: SHA, target: 'rehearsal', link: fx.link,
      restarted: true, verified: false,
      units: ['agent-office-golive-api.service', 'agent-office-golive-web.service'],
    }) + '\n');
    writeRehearsalUnits(fx);
    const result = run(fx);
    assert.equal(result.status, 0, output(result));
    assert.equal(output(result).includes('another deploy is running'), false);
    assert.match(result.stderr, /recovered; restored/);
    assert.equal(fs.readlinkSync(fx.link), dest);
    rmTree(fx.dir);
  });

  it('R25-03 a live lock holder still blocks a second deploy', () => {
    const fx = fixture();
    const previous = path.join(fx.releases, OLD[3]);
    fs.mkdirSync(previous, { recursive: true });
    fs.symlinkSync(previous, fx.link);
    writeRehearsalUnits(fx);
    const lockFile = path.join(fx.releases, '.lock');
    fs.writeFileSync(lockFile, '');
    const holder = spawn('flock', ['--exclusive', lockFile, 'sleep', '30'], { stdio: 'ignore' });
    let held = false;
    for (let i = 0; i < 40; i += 1) {
      const probe = spawnSync('flock', ['--exclusive', '--nonblock', lockFile, 'true'], { encoding: 'utf8' });
      if (probe.status !== 0) { held = true; break; }
      spawnSync('/bin/sleep', ['0.05']);
    }
    assert.equal(held, true);
    const result = run(fx);
    try { process.kill(holder.pid, 'SIGKILL'); } catch { /* already gone */ }
    assert.equal(result.status, 1, output(result));
    assert.match(result.stderr, /another deploy is running/);
    assert.equal(fs.readlinkSync(fx.link), previous);
    rmTree(fx.dir);
  });

  it('R25-04 rejects an ExecStart whose script is not the symlink even if an argument mentions it', () => {
    const fx = fixture();
    const body = `[Service]\nWorkingDirectory=/elsewhere\nExecStart=/usr/bin/node /elsewhere/server.js --note ${fx.link}/server.js\n`;
    writeRehearsalUnits(fx, body);
    const previous = path.join(fx.releases, OLD[3]);
    fs.mkdirSync(previous, { recursive: true });
    fs.symlinkSync(previous, fx.link);
    const result = run(fx);
    assert.equal(result.status, 1, output(result));
    assert.match(result.stderr, /does not run from/);
    assert.equal(fs.existsSync(fx.gitLog), false);
    assert.equal(fs.readlinkSync(fx.link), previous);
    rmTree(fx.dir);
  });

  it('R25-05 refuses a SHA-named symlink whose tree is a different commit', () => {
    const fx = fixture();
    const previous = path.join(fx.releases, OLD[3]);
    fs.mkdirSync(previous, { recursive: true });
    fs.writeFileSync(path.join(previous, 'HEAD'), OLD[3] + '\n');
    fs.symlinkSync(previous, path.join(fx.releases, SHA));
    fs.symlinkSync(previous, fx.link);
    writeRehearsalUnits(fx);
    const result = run(fx);
    assert.equal(result.status, 1, output(result));
    assert.match(result.stderr, new RegExp(`release ${SHA} is commit ${OLD[3]}`));
    assert.equal(fs.readlinkSync(fx.link), previous);
    assert.equal(fs.readlinkSync(path.join(fx.releases, SHA)), previous);
    const git = fs.existsSync(fx.gitLog) ? fs.readFileSync(fx.gitLog, 'utf8') : '';
    assert.equal(git.includes('worktree remove'), false);
    rmTree(fx.dir);
  });

  it('R25-06 redacts rollback output and JSON-escaped secrets', () => {
    const token = 'zz"secret\\value';
    const fx = fixture({ token, restartLeak: '1', smokeExit: '1' });
    const previous = path.join(fx.releases, OLD[3]);
    fs.mkdirSync(previous, { recursive: true });
    fs.symlinkSync(previous, fx.link);
    writeRehearsalUnits(fx);
    const leaked = run(fx);
    assert.equal(leaked.status, 1, output(leaked));
    assert.equal(fs.readlinkSync(fx.link), previous);
    assert.equal(output(leaked).includes(token), false);
    assert.equal(output(leaked).includes('zz\\"secret'), false);
    const escaped = fixture({ token, smokeLeak: '1' });
    fs.mkdirSync(path.join(escaped.releases, OLD[3]), { recursive: true });
    fs.symlinkSync(path.join(escaped.releases, OLD[3]), escaped.link);
    writeRehearsalUnits(escaped);
    const smoked = run(escaped);
    assert.equal(smoked.status, 1, output(smoked));
    const escapedForm = JSON.stringify(token).slice(1, -1);
    assert.equal(output(smoked).includes(token), false);
    assert.equal(output(smoked).includes(escapedForm), false);
    assert.equal(output(smoked).includes('secret\\\\value'), false);
    rmTree(fx.dir);
    rmTree(escaped.dir);
  });

  it('R25-07 refuses to switch when the previous release is missing or dangling', () => {
    const missing = fixture();
    writeRehearsalUnits(missing);
    const absent = run(missing);
    assert.equal(absent.status, 1, output(absent));
    assert.match(absent.stderr, /previous release is missing/);
    assert.equal(fs.existsSync(missing.link), false);
    assert.equal(fs.existsSync(missing.gitLog), false);
    const dangling = fixture();
    writeRehearsalUnits(dangling);
    fs.symlinkSync(path.join(dangling.releases, 'gone'), dangling.link);
    const hung = run(dangling);
    assert.equal(hung.status, 1, output(hung));
    assert.match(hung.stderr, /previous release is missing/);
    assert.equal(fs.readlinkSync(dangling.link), path.join(dangling.releases, 'gone'));
    assert.equal(fs.existsSync(dangling.gitLog), false);
    rmTree(missing.dir);
    rmTree(dangling.dir);
  });

  it('R28-01 a failed retry rolls back to the release recovery restored', () => {
    const fx = fixture({ smokeExit: '1' });
    fx.keepPids = true;
    const healthy = path.join(fx.releases, OLD[3]);
    const failed = path.join(fx.releases, SHA);
    fs.mkdirSync(healthy, { recursive: true });
    fs.mkdirSync(failed, { recursive: true });
    fs.symlinkSync(failed, fx.link);
    fs.writeFileSync(path.join(fx.releases, '.lock'), '99999999\n');
    fs.writeFileSync(path.join(fx.releases, '.journal'), JSON.stringify({
      phase: 'switched', prev: failed, lastKnownGood: OLD[3], dest: failed, sha: SHA,
      target: 'rehearsal', link: fx.link, restarted: true, verified: false,
      units: ['agent-office-golive-api.service', 'agent-office-golive-web.service'],
    }) + '\n');
    writeRehearsalUnits(fx);
    const result = run(fx, ['--target', 'rehearsal', OLD[2]]);
    assert.equal(result.status, 1, output(result));
    assert.match(result.stderr, /recovered; restored/);
    assert.match(result.stderr, /failed; restored/);
    assert.equal(fs.readlinkSync(fx.link), healthy);
    const journal = JSON.parse(fs.readFileSync(path.join(fx.releases, '.journal'), 'utf8'));
    assert.equal(journal.prev, healthy);
    assert.equal(journal.lastKnownGood, OLD[3]);
    assert.notEqual(journal.lastKnownGood, OLD[2]);
    for (const unit of ['agent-office-golive-api.service', 'agent-office-golive-web.service']) {
      const pid = Number(fs.readFileSync(path.join(fx.dir, 'pids', unit), 'utf8'));
      assert.equal(fs.realpathSync(fs.readlinkSync(`/proc/${pid}/cwd`)), fs.realpathSync(healthy));
    }
    reap(fx);
    rmTree(fx.dir);
  });

  it('R28-02 flock admits one deploy and the kernel releases it on death', async () => {
    const empty = fixture();
    const emptyPrev = path.join(empty.releases, OLD[3]);
    const emptyLock = path.join(empty.releases, '.lock');
    fs.mkdirSync(emptyPrev, { recursive: true });
    fs.symlinkSync(emptyPrev, empty.link);
    fs.writeFileSync(emptyLock, '');
    writeRehearsalUnits(empty);
    const allowed = run(empty);
    assert.equal(allowed.status, 0, output(allowed));
    assert.equal(output(allowed).includes('another deploy is running'), false);
    assert.equal(fs.readFileSync(emptyLock, 'utf8').trim(), '');

    const fx = fixture({ gate: 'hold-lock', gateFile: path.join(os.tmpdir(), 'ao-gate-' + process.pid) });
    const previous = path.join(fx.releases, OLD[3]);
    const lockFile = path.join(fx.releases, '.lock');
    fs.mkdirSync(previous, { recursive: true });
    fs.symlinkSync(previous, fx.link);
    writeRehearsalUnits(fx);
    const fresh = spawn(process.execPath, [script, '--target', 'rehearsal', SHA], { env: fx.env });
    const ready = fx.env.DEPLOY_GATE_FILE + '.ready';
    for (let i = 0; i < 80 && !fs.existsSync(ready); i += 1) await new Promise((r) => setTimeout(r, 50));
    assert.equal(fs.existsSync(ready), true, 'first deploy did not reach the lock gate');
    assert.equal(fs.readFileSync(lockFile, 'utf8').trim(), '');
    const second = spawnSync(process.execPath, [script, '--target', 'rehearsal', SHA], { env: { ...fx.env, DEPLOY_GATE: '' }, encoding: 'utf8' });
    assert.equal(second.status, 1, output(second));
    assert.match(second.stderr, /another deploy is running/);
    process.kill(fresh.pid, 'SIGKILL');
    await new Promise((resolve) => fresh.on('close', resolve));
    let free = false;
    for (let i = 0; i < 40; i += 1) {
      const probe = spawnSync('flock', ['--exclusive', '--nonblock', lockFile, 'true'], { encoding: 'utf8' });
      if (probe.status === 0) { free = true; break; }
      spawnSync('/bin/sleep', ['0.05']);
    }
    assert.equal(free, true, 'flock stayed held after the deploy was killed');
    const third = spawnSync(process.execPath, [script, '--target', 'rehearsal', SHA], { env: { ...fx.env, DEPLOY_GATE: '' }, encoding: 'utf8' });
    assert.equal(third.status, 0, output(third));
    try { fs.unlinkSync(fx.env.DEPLOY_GATE_FILE); fs.unlinkSync(ready); } catch { /* gone */ }

    const again = fixture({ gate: 'hold-lock', gateFile: path.join(os.tmpdir(), 'ao-gate-b-' + process.pid) });
    const healthy = path.join(again.releases, OLD[3]);
    const failed = path.join(again.releases, SHA);
    fs.mkdirSync(healthy, { recursive: true });
    fs.mkdirSync(failed, { recursive: true });
    fs.symlinkSync(failed, again.link);
    fs.writeFileSync(path.join(again.releases, '.lock'), '99999999\n');
    fs.writeFileSync(path.join(again.releases, '.journal'), JSON.stringify({
      phase: 'switched', prev: healthy, dest: failed, sha: SHA, target: 'rehearsal', link: again.link,
      restarted: false, verified: false, units: ['agent-office-golive-api.service', 'agent-office-golive-web.service'],
    }) + '\n');
    writeRehearsalUnits(again);
    const args = [script, '--target', 'rehearsal', SHA];
    const first = spawn(process.execPath, args, { env: again.env });
    const other = spawn(process.execPath, args, { env: again.env });
    const mark = again.env.DEPLOY_GATE_FILE + '.ready';
    let loser = null;
    let winner = null;
    for (let i = 0; i < 80 && !winner; i += 1) {
      await new Promise((r) => setTimeout(r, 50));
      if (fs.existsSync(mark)) winner = Number(fs.readFileSync(mark, 'utf8'));
    }
    assert.ok(winner, 'neither recovery published a lock');
    loser = winner === first.pid ? other : first;
    const closed = (child) => new Promise((resolve) => {
      child.once('close', resolve);
      if (child.exitCode !== null || child.signalCode !== null) resolve(child.exitCode);
    });
    const loserStatus = await closed(loser);
    assert.equal(loserStatus, 1);
    fs.writeFileSync(again.env.DEPLOY_GATE_FILE, '1');
    const winnerProc = winner === first.pid ? first : other;
    assert.equal(await closed(winnerProc), 0);
    const built = fs.readFileSync(again.gitLog, 'utf8').split('\n').filter((line) => line.includes(' archive '));
    assert.equal(built.length, 1);
    try { fs.unlinkSync(again.env.DEPLOY_GATE_FILE); fs.unlinkSync(mark); } catch { /* gone */ }
    rmTree(empty.dir);
    rmTree(fx.dir);
    rmTree(again.dir);
  });

  it('R28-03 a killed deploy takes its workers and the verified release stays immutable', async () => {
    const fx = fixture({ npmLate: '1' });
    const previous = path.join(fx.releases, OLD[3]);
    fs.mkdirSync(previous, { recursive: true });
    fs.symlinkSync(previous, fx.link);
    writeRehearsalUnits(fx);
    const killed = spawn(process.execPath, [script, '--target', 'rehearsal', SHA], { env: fx.env });
    const pidfile = path.join(fx.dir, 'npm.pid');
    for (let i = 0; i < 80 && !fs.existsSync(pidfile); i += 1) await new Promise((r) => setTimeout(r, 50));
    assert.equal(fs.existsSync(pidfile), true);
    const npmPid = Number(fs.readFileSync(pidfile, 'utf8'));
    killed.kill('SIGKILL');
    await new Promise((resolve) => killed.on('close', resolve));
    let alive = true;
    try { process.kill(npmPid, 0); } catch { alive = false; }
    assert.equal(alive, true, 'SIGKILL of the deploy signaled a worker pid');
    const journal = JSON.parse(fs.readFileSync(path.join(fx.releases, '.journal'), 'utf8'));
    assert.match(journal.stepUnit, /^ao-deploy-[0-9a-f]{40}-npm$/);
    const lockFile = path.join(fx.releases, '.lock');
    for (let i = 0; i < 40; i += 1) {
      const probe = spawnSync('flock', ['--exclusive', '--nonblock', lockFile, 'true'], { encoding: 'utf8' });
      if (probe.status === 0) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    fx.env.NPM_LATE = '0';
    const result = run(fx);
    assert.equal(result.status, 0, output(result));
    let still = true;
    try { process.kill(npmPid, 0); } catch { still = false; }
    assert.equal(still, false, 'recovery left the install unit running');
    fs.writeFileSync(path.join(fx.dir, 'late.gate'), '1');
    await new Promise((r) => setTimeout(r, 200));
    const active = fs.realpathSync(fs.readlinkSync(fx.link));
    assert.equal(fs.existsSync(path.join(active, 'LATE')), false);
    assert.equal(fs.statSync(active).mode & 0o222, 0);
    assert.equal(fs.statSync(path.join(active, '.manifest')).mode & 0o222, 0);
    spawnSync('chmod', ['-R', 'u+w', active]);
    fs.writeFileSync(path.join(active, 'marker'), 'tampered\n');
    const refused = run(fx);
    assert.equal(refused.status, 1, output(refused));
    assert.match(refused.stderr, /manifest does not match/);
    assert.equal(fs.readlinkSync(fx.link), path.join(fx.releases, SHA));
    rmTree(fx.dir);
  });

  it('R28-04 rejects an ExecStart that escapes the symlink with ..', () => {
    const fx = fixture();
    const previous = path.join(fx.releases, OLD[3]);
    fs.mkdirSync(previous, { recursive: true });
    fs.symlinkSync(previous, fx.link);
    const body = `[Service]\nWorkingDirectory=${fx.link}\nExecStart=/usr/bin/node ${fx.link}/../${OLD[2]}/server.js\n`;
    writeRehearsalUnits(fx, body);
    const result = run(fx);
    assert.equal(result.status, 1, output(result));
    assert.match(result.stderr, /does not run from/);
    assert.equal(fs.existsSync(fx.gitLog), false);
    assert.equal(fs.readlinkSync(fx.link), previous);
    rmTree(fx.dir);
  });

  it('R28-05 does not forward secret fragments from smoke', () => {
    const token = 'abcdefghijklMNOPQRSTUVWXYZ0123456789';
    const prefix = token.slice(0, 12);
    const suffix = token.slice(-12);
    const leaked = (result) => output(result).includes(prefix) || output(result).includes(suffix) || output(result).includes(token);
    const ok = fixture({ token, smokeFrag: '1' });
    const previous = path.join(ok.releases, OLD[3]);
    fs.mkdirSync(previous, { recursive: true });
    fs.symlinkSync(previous, ok.link);
    writeRehearsalUnits(ok);
    const success = run(ok);
    assert.equal(success.status, 0, output(success));
    assert.match(success.stderr, /deploy: smoke exit 0/);
    assert.equal(success.stdout.includes(prefix), false);
    assert.equal(leaked(success), false);
    const bad = fixture({ token, smokeFrag: '1', smokeExit: '1' });
    fs.mkdirSync(path.join(bad.releases, OLD[3]), { recursive: true });
    fs.symlinkSync(path.join(bad.releases, OLD[3]), bad.link);
    writeRehearsalUnits(bad);
    const failed = run(bad);
    assert.equal(failed.status, 1, output(failed));
    assert.match(failed.stderr, /restored/);
    assert.equal(leaked(failed), false);
    const recovered = fixture({ token, smokeFrag: '1' });
    const healthy = path.join(recovered.releases, OLD[3]);
    const dest = path.join(recovered.releases, SHA);
    fs.mkdirSync(healthy, { recursive: true });
    fs.mkdirSync(dest, { recursive: true });
    fs.symlinkSync(dest, recovered.link);
    fs.writeFileSync(path.join(recovered.releases, '.lock'), '99999999\n');
    fs.writeFileSync(path.join(recovered.releases, '.journal'), JSON.stringify({
      phase: 'switched', prev: healthy, dest, sha: SHA, target: 'rehearsal', link: recovered.link,
      restarted: false, verified: false,
      units: ['agent-office-golive-api.service', 'agent-office-golive-web.service'],
    }) + '\n');
    writeRehearsalUnits(recovered);
    const retry = run(recovered);
    assert.equal(retry.status, 0, output(retry));
    assert.match(retry.stderr, /recovered/);
    assert.equal(leaked(retry), false);
    rmTree(ok.dir);
    rmTree(bad.dir);
    rmTree(recovered.dir);
  });
});

describe('hash-only production smoke', () => {
  it('R23-03 runs golive-smoke.sh to completion without a password in the env file', async () => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1');
      const p = url.pathname;
      if (req.method === 'GET' && p === '/') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end('<!doctype html><html></html>');
        return;
      }
      if (req.method === 'GET' && p === '/backend/api/v2/meta') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: { env: 'production', capabilities: { storeWrites: true, openclawWrites: true } } }));
        return;
      }
      if (req.method === 'POST' && p === '/backend/api/login') {
        res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': 'taco_sess=abc; HttpOnly; Path=/' });
        res.end('{"ok":true}');
        return;
      }
      if (req.method === 'GET' && p === '/backend/api/v2/views/health') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: { level: 'ok', dataQuality: { issues: [] } } }));
        return;
      }
      if (req.method === 'GET' && p === '/backend/api/v2/stream') {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end('event: health\ndata: {}\n\n');
        return;
      }
      if (req.method === 'POST' && p === '/backend/api/logout') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"ok":true}');
        return;
      }
      if (req.method === 'GET' && p === '/backend/api/v2/me') {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end('{"error":"unauthorized"}');
        return;
      }
      if (req.method === 'GET' && (p === '/backend' || p === '/backend/')) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { code: 'not_found' } }));
        return;
      }
      res.writeHead(500, { 'content-type': 'text/plain' });
      res.end('unexpected ' + req.method + ' ' + p);
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const fx = fixture({
      realCurl: true,
      smoke: golive,
      publicUrl: `http://127.0.0.1:${port}`,
    });
    const previous = path.join(fx.releases, OLD[3]);
    fs.mkdirSync(previous, { recursive: true });
    fs.symlinkSync(previous, fx.prodLink);
    writeProdUnits(fx);
    const result = await new Promise((resolve) => {
      const child = spawn(process.execPath, [script, '--target', 'prod', SHA], { env: fx.env });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => { stdout += chunk; });
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      child.on('close', (status) => resolve({ status, stdout, stderr }));
    });
    server.close();
    assert.equal(result.status, 0, output(result));
    assert.match(result.stderr, /deploy: smoke exit 0/);
    assert.equal(result.stdout.includes('ok:'), false);
    assert.equal(output(result).includes(SMOKE_PW), false);
    assert.equal(output(result).includes(CANARY), false);
    assert.equal(fs.readlinkSync(fx.prodLink), path.join(fx.releases, SHA));
    const prodEnv = fs.readFileSync(path.join(fx.dir, '.config', 'agent-office-prod.env'), 'utf8');
    assert.equal(prodEnv.includes('PORTAL_PASSWORD='), false);
    reap(fx);
    rmTree(fx.dir);
  });

  it('R31-01 the deploy tool never kills by pid', () => {
    const src = fs.readFileSync(script, 'utf8');
    assert.equal(/process\.kill|\.kill\(/.test(src), false);
    assert.match(src, /systemctl', \['--user', 'stop'/);
    assert.equal(src.includes('worktree'), false);
  });

  it('R31-01 recovery does not signal a journaled worker pid', () => {
    const fx = fixture();
    const previous = path.join(fx.releases, OLD[3]);
    const dest = path.join(fx.releases, SHA);
    fs.mkdirSync(previous, { recursive: true });
    fs.mkdirSync(dest, { recursive: true });
    fs.symlinkSync(dest, fx.link);
    const sleeper = spawn('/bin/sleep', ['60'], { cwd: fx.dir, detached: true, stdio: 'ignore' });
    sleeper.unref();
    fs.writeFileSync(path.join(fx.releases, '.journal'), JSON.stringify({
      phase: 'switched', prev: previous, dest, sha: SHA, target: 'rehearsal', link: fx.link,
      restarted: true, verified: false, workers: [sleeper.pid],
      units: ['agent-office-golive-api.service', 'agent-office-golive-web.service'],
    }) + '\n');
    writeRehearsalUnits(fx);
    const result = run(fx);
    let alive = true;
    try { process.kill(sleeper.pid, 0); } catch { alive = false; }
    try { process.kill(sleeper.pid, 'SIGKILL'); } catch { /* already gone */ }
    assert.equal(alive, true, 'recovery signaled an unrelated pid');
    assert.equal(result.status, 0, output(result));
    const journal = JSON.parse(fs.readFileSync(path.join(fx.releases, '.journal'), 'utf8'));
    assert.equal(journal.workers, undefined);
    assert.equal(JSON.stringify(journal).includes(String(sleeper.pid)), false);
    rmTree(fx.dir);
  });

  it('R31-02 exports the commit with git archive and survives worktree prune', () => {
    const fx = fixture({ realGit: true });
    const gitEnv = {
      ...process.env,
      GIT_AUTHOR_NAME: 'Deploy',
      GIT_AUTHOR_EMAIL: 'dev@example.invalid',
      GIT_COMMITTER_NAME: 'Deploy',
      GIT_COMMITTER_EMAIL: 'dev@example.invalid',
    };
    const git = (args) => spawnSync('git', args, { cwd: fx.repo, encoding: 'utf8', env: gitEnv });
    assert.equal(git(['init']).status, 0);
    fs.writeFileSync(path.join(fx.repo, 'README'), 'hello\n');
    assert.equal(git(['add', 'README']).status, 0);
    assert.equal(git(['commit', '-m', 'init']).status, 0, git(['commit', '-m', 'init']).stderr);
    const sha = git(['rev-parse', 'HEAD']).stdout.trim();
    assert.match(sha, /^[0-9a-f]{40}$/);
    const previous = path.join(fx.releases, OLD[3]);
    fs.mkdirSync(previous, { recursive: true });
    fs.symlinkSync(previous, fx.link);
    writeRehearsalUnits(fx);
    const first = run(fx, ['--target', 'rehearsal', sha]);
    assert.equal(first.status, 0, output(first));
    const dest = path.join(fx.releases, sha);
    assert.equal(fs.readFileSync(path.join(dest, 'README'), 'utf8'), 'hello\n');
    assert.equal(fs.readFileSync(path.join(dest, 'REVISION'), 'utf8').split('\n')[0], sha);
    assert.equal(fs.existsSync(path.join(dest, '.git')), false);
    const listed = git(['worktree', 'list']).stdout;
    assert.equal(listed.includes(dest), false);
    assert.equal(git(['worktree', 'prune', '--expire', 'now']).status, 0);
    const again = run(fx, ['--target', 'rehearsal', sha]);
    assert.equal(again.status, 0, output(again));
    assert.equal(git(['worktree', 'list']).stdout.includes(dest), false);
    spawnSync('chmod', ['-R', 'u+w', dest]);
    fs.unlinkSync(path.join(dest, '.manifest'));
    fs.writeFileSync(path.join(dest, 'README'), 'tampered\n');
    const bad = run(fx, ['--target', 'rehearsal', sha]);
    assert.equal(bad.status, 1, output(bad));
    assert.match(bad.stderr, /tree hash does not match/);
    assert.equal(fs.readlinkSync(fx.link), dest);
    rmTree(fx.dir);
  });

  it('R31-03 a background install helper cannot write into the active release', async () => {
    const fx = fixture({ npmBg: '1' });
    const previous = path.join(fx.releases, OLD[3]);
    fs.mkdirSync(previous, { recursive: true });
    fs.symlinkSync(previous, fx.link);
    writeRehearsalUnits(fx);
    const result = run(fx);
    assert.equal(result.status, 0, output(result));
    const log = fs.readFileSync(fx.stepLog, 'utf8');
    assert.match(log, new RegExp(`--unit=ao-deploy-${SHA}-npm`));
    assert.match(log, /--wait/);
    assert.match(log, /--collect/);
    assert.match(log, /KillMode=control-group/);
    const helper = Number(fs.readFileSync(path.join(fx.dir, 'bg.pid'), 'utf8'));
    let alive = true;
    try { process.kill(helper, 0); } catch { alive = false; }
    assert.equal(alive, false, 'background helper outlived the install unit');
    fs.writeFileSync(path.join(fx.dir, 'bg.gate'), '1');
    await new Promise((r) => setTimeout(r, 200));
    const active = fs.realpathSync(fs.readlinkSync(fx.link));
    assert.equal(fs.existsSync(path.join(active, 'LATE-BACKGROUND')), false);
    assert.equal(fs.statSync(active).mode & 0o222, 0);
    rmTree(fx.dir);

    const probe = spawnSync('/usr/bin/systemd-run', ['--user', '--collect', '--quiet', '--pipe', '--wait', '--', '/bin/true'], { encoding: 'utf8' });
    if (probe.status !== 0) return;
    const real = fixture({ npmBg: '1' });
    const prev = path.join(real.releases, OLD[3]);
    fs.mkdirSync(prev, { recursive: true });
    fs.symlinkSync(prev, real.link);
    writeRehearsalUnits(real);
    const child = spawn(process.execPath, [script, '--target', 'rehearsal', SHA], {
      env: { ...real.env, DEPLOY_SYSTEMD_RUN: '/usr/bin/systemd-run', DEPLOY_STEP_CTL: '/usr/bin/systemctl' },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const started = path.join(real.dir, 'bg.started');
    for (let i = 0; i < 80 && !fs.existsSync(started); i += 1) await new Promise((r) => setTimeout(r, 50));
    assert.equal(fs.existsSync(started), true, 'real install unit did not start the helper');
    const status = await new Promise((resolve) => child.on('close', resolve));
    const realPid = Number(fs.readFileSync(path.join(real.dir, 'bg.pid'), 'utf8'));
    let realAlive = true;
    try { process.kill(realPid, 0); } catch { realAlive = false; }
    fs.writeFileSync(path.join(real.dir, 'bg.gate'), '1');
    await new Promise((r) => setTimeout(r, 200));
    const release = path.join(real.releases, SHA);
    assert.equal(status, 0, stdout + stderr);
    assert.equal(realAlive, false, 'real cgroup left the helper alive');
    assert.equal(fs.existsSync(path.join(release, 'LATE-BACKGROUND')), false);
    spawnSync('/usr/bin/systemctl', ['--user', 'stop', `ao-deploy-${SHA}-npm`], { stdio: 'ignore' });
    rmTree(real.dir);
  });

  it('R31-03 the release is read-only before the symlink switches', () => {
    const fx = fixture({ interrupt: 'before-replace' });
    const previous = path.join(fx.releases, OLD[3]);
    fs.mkdirSync(previous, { recursive: true });
    fs.symlinkSync(previous, fx.link);
    writeRehearsalUnits(fx);
    const result = run(fx);
    assert.equal(result.status, 143, output(result));
    const dest = path.join(fx.releases, SHA);
    assert.equal(fs.statSync(dest).mode & 0o222, 0);
    assert.equal(fs.readlinkSync(fx.link), previous);
    rmTree(fx.dir);
  });
});
