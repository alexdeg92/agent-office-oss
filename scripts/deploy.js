#!/usr/bin/env node
'use strict';
// Deploy one commit on this host. Does not publish, and does not touch openclaw-gateway,
// ~/.openclaw, or Traefik.
//
//   node scripts/deploy.js [--target prod|rehearsal] SHA
//   scripts/deploy.sh …          (same command)
//
// prod (default): releases under DEPLOY_RELEASES_ROOT or ~/dev/project/agent-office-releases,
// symlink current, user units agent-office-api and agent-office-web,
// env ~/.config/agent-office-prod.env, smoke https://office.example.com
// rehearsal: symlink current-rehearsal, units agent-office-golive-api and agent-office-golive-web,
// env agent-office.env then agent-office-golive.env (later file wins).
//
// The config check prints only "key: ok" or "key: missing". EnvironmentFile values are
// parsed as data (the same literal rules as check-config). They are never sourced.
// Smoke logs in with AO_SMOKE_PASSWORD, or a prompt when this process has a terminal.
// That password is written to a mode-0600 file the smoke reads itself. It is not an
// argument, it is not taken from the env file, and smoke output is not printed.
// One flock(2) on the releases lock file admits a deploy. The kernel drops it when
// the holder dies; the file is not a pid, and this tool does not signal a pid.
// Each build and install step is its own transient user unit
// (ao-deploy-<sha>-<step>, KillMode=control-group). Abort and recovery are
// systemctl --user stop of that unit. The journal records the unit name and the
// last known-good SHA. A failed retry returns to the last known-good release.
// The release tree is git archive of the commit into the final directory, checked
// against the hash in REVISION, and made read-only before the symlink is switched.
// A release directory is removed only when its real path is not a symlink target,
// not a running unit's WorkingDirectory, and not one of the newest three per target.

const { spawn, spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let activeSecrets = [];
let journalState = null;
let lockHolder = null;
let activeStep = null;

const STEP_ENV = ['PATH', 'HOME', 'LANG', 'NPM_FAIL', 'NPM_HANG', 'NPM_LATE', 'NPM_BG', 'SYNTAX_FAIL'];

const PROD_UNITS = ['agent-office-api.service', 'agent-office-web.service'];
const REHEARSAL_UNITS = ['agent-office-golive-api.service', 'agent-office-golive-web.service'];
const ALL_UNITS = [...PROD_UNITS, ...REHEARSAL_UNITS];

function fail(message) {
  const err = new Error(message);
  err.deploy = true;
  return err;
}

function scrub(result) {
  return {
    status: result.status,
    stdout: redact(result.stdout, activeSecrets),
    stderr: redact(result.stderr, activeSecrets),
  };
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, {
        shell: false,
        windowsHide: true,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        cwd: opts.cwd,
        env: opts.env,
      });
    } catch {
      resolve(scrub({ status: 1, stdout: '', stderr: '' }));
      return;
    }
    const out = [];
    const err = [];
    let settled = false;
    child.stdout.on('data', (chunk) => out.push(chunk));
    child.stderr.on('data', (chunk) => err.push(chunk));
    const finish = (status) => {
      if (settled) return;
      settled = true;
      resolve(scrub({
        status,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
      }));
    };
    child.on('error', () => finish(1));
    child.on('close', (code) => finish(code == null ? 1 : code));
  });
}

function runSync(cmd, args, opts = {}) {
  const child = spawnSync(cmd, args, {
    encoding: 'utf8',
    shell: false,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    cwd: opts.cwd,
    env: opts.env,
  });
  return scrub({
    status: child.status == null ? 1 : child.status,
    stdout: child.stdout || '',
    stderr: child.stderr || '',
  });
}

function stepUnitName(sha, name) {
  return `ao-deploy-${sha}-${name}`;
}

function stepCtl() {
  return process.env.DEPLOY_STEP_CTL || 'systemctl';
}

function stopStepUnit(unit) {
  if (typeof unit !== 'string' || !/^ao-deploy-[0-9a-f]{40}-[a-z0-9-]+$/.test(unit)) return;
  spawnSync(stepCtl(), ['--user', 'stop', unit], { stdio: 'ignore' });
}

async function step(sha, name, cmd, args, opts = {}) {
  const unit = stepUnitName(sha, name);
  activeStep = unit;
  if (journalState) {
    journalState.stepUnit = unit;
    writeJournal(journalState);
  }
  const source = opts.env || process.env;
  const setenv = [];
  for (const key of STEP_ENV) {
    if (source[key] == null || /[\n\0]/.test(String(source[key]))) continue;
    setenv.push(`--setenv=${key}=${source[key]}`);
  }
  const argv = [
    '--user', '--wait', '--collect',
    '--property=KillMode=control-group',
    `--unit=${unit}`,
    ...setenv,
  ];
  if (opts.cwd) argv.push(`--property=WorkingDirectory=${opts.cwd}`);
  argv.push('--', cmd, ...args);
  const bin = process.env.DEPLOY_SYSTEMD_RUN || 'systemd-run';
  try {
    return await run(bin, argv, { env: source });
  } finally {
    stopStepUnit(unit);
    if (activeStep === unit) activeStep = null;
    if (journalState && journalState.stepUnit === unit) {
      journalState.stepUnit = null;
      try { writeJournal(journalState); } catch { /* journal dir already gone */ }
    }
  }
}

async function must(cmd, args, opts, what) {
  const result = await run(cmd, args, opts);
  if (result.status !== 0) throw fail(`${what} (exit ${result.status})`);
  return result;
}

async function mustStep(sha, name, cmd, args, opts, what) {
  const result = await step(sha, name, cmd, args, opts);
  if (result.status !== 0) throw fail(`${what} (exit ${result.status})`);
  return result;
}

function logicalLines(text) {
  const lines = [];
  let buf = '';
  for (const raw of String(text).split('\n')) {
    if (raw.endsWith('\\')) {
      buf += raw.slice(0, -1);
      continue;
    }
    lines.push(buf + raw);
    buf = '';
  }
  if (buf) lines.push(buf);
  return lines;
}

function stripInlineComment(line) {
  let quote = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === '\\' && quote === '"') { i += 1; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (c === '#') return line.slice(0, i);
  }
  return line;
}

function serviceDirectives(text) {
  const out = [];
  let section = '';
  for (const raw of logicalLines(text)) {
    const line = stripInlineComment(raw).trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    const header = /^\[([^\]]+)\]$/.exec(line);
    if (header) { section = header[1]; continue; }
    if (section !== 'Service') continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    out.push({ key: line.slice(0, eq).trim(), value: line.slice(eq + 1).trim() });
  }
  return out;
}

function loadUnit(unitPath) {
  const chunks = [fs.readFileSync(unitPath, 'utf8')];
  const dropIn = unitPath + '.d';
  if (fs.existsSync(dropIn) && fs.statSync(dropIn).isDirectory()) {
    for (const name of fs.readdirSync(dropIn).filter((n) => n.endsWith('.conf')).sort()) {
      chunks.push(fs.readFileSync(path.join(dropIn, name), 'utf8'));
    }
  }
  const directives = chunks.flatMap(serviceDirectives);
  let execStart = [];
  let workingDirectory = null;
  for (const { key, value } of directives) {
    if (key === 'ExecStart') {
      if (value === '') execStart = [];
      else execStart.push(value);
    } else if (key === 'WorkingDirectory') workingDirectory = value;
  }
  return { execStart, workingDirectory };
}

function argvFromExecStartShow(text) {
  const source = String(text || '');
  const at = source.indexOf('argv[]=');
  if (at < 0) return [];
  let rest = source.slice(at + 'argv[]='.length);
  const end = rest.indexOf(' ;');
  if (end >= 0) rest = rest.slice(0, end);
  const args = [];
  let cur = '';
  let quote = null;
  for (let i = 0; i < rest.length; i++) {
    const c = rest[i];
    if (quote) {
      if (c === quote) quote = null;
      else cur += c;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (c === ' ' || c === '\n') {
      if (cur) { args.push(cur); cur = ''; }
      continue;
    }
    cur += c;
  }
  if (cur) args.push(cur);
  return args;
}

function resolvedScript(script) {
  if (!script || script.includes('\0')) return null;
  const abs = path.resolve(script);
  if (fs.existsSync(abs)) {
    try { return fs.realpathSync(abs); } catch { return null; }
  }
  const tail = [];
  let cur = abs;
  while (!fs.existsSync(cur)) {
    const parent = path.dirname(cur);
    if (parent === cur) return null;
    tail.push(path.basename(cur));
    cur = parent;
  }
  try { return path.join(fs.realpathSync(cur), ...tail.reverse()); }
  catch { return null; }
}

function containedPath(root, link, script) {
  const real = resolvedScript(script);
  if (!real) return false;
  let rootReal;
  try { rootReal = fs.realpathSync(root); } catch { rootReal = path.resolve(root); }
  if (real !== rootReal && !real.startsWith(rootReal + path.sep)) return false;
  try {
    const linkReal = fs.realpathSync(link);
    return real === linkReal || real.startsWith(linkReal + path.sep);
  } catch {
    // A missing link still has to fail as "previous release is missing".
    const scriptAbs = path.resolve(script);
    const linkAbs = path.resolve(link);
    return scriptAbs.startsWith(linkAbs + path.sep);
  }
}

async function unitRunsFrom(systemctl, unit, link, root) {
  const show = await run(systemctl, ['--user', 'show', '-p', 'ExecStart', '--value', unit]);
  const argv = argvFromExecStartShow(show.stdout);
  if (path.basename(argv[0] || '') !== 'node') return false;
  return containedPath(root, link, argv[1]);
}

function realpathOrNull(target) {
  try { return fs.realpathSync(target); } catch { return null; }
}

function historyShas(root, target) {
  const file = path.join(root, `.history-${target}`);
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').map((l) => l.trim()).filter((l) => /^[0-9a-f]{40}$/.test(l));
}

function protectedRealpaths(root, systemctl) {
  const found = new Set();
  const add = (target) => {
    const real = realpathOrNull(target);
    if (real) found.add(real);
  };
  for (const name of ['current', 'current-rehearsal']) add(path.join(root, name));
  for (const target of ['prod', 'rehearsal']) {
    const shas = historyShas(root, target).slice(-3);
    for (const sha of shas) add(path.join(root, sha));
  }
  const unitDir = process.env.DEPLOY_UNIT_DIR || path.join(process.env.HOME || '', '.config/systemd/user');
  for (const unit of ALL_UNITS) {
    const unitPath = path.join(unitDir, unit);
    if (!fs.existsSync(unitPath)) continue;
    let active = false;
    try {
      const result = execFileSyncStatus(systemctl, ['--user', 'is-active', '--quiet', unit]);
      active = result === 0;
    } catch { active = false; }
    if (!active) continue;
    const wd = loadUnit(unitPath).workingDirectory;
    if (wd) add(wd);
  }
  return found;
}

function execFileSyncStatus(cmd, args) {
  return runSync(cmd, args).status;
}

function loadMergedEnv(files) {
  const { loadEnvFile } = require('../packaging/bin/agent-office.js');
  let merged = {};
  for (const file of files) Object.assign(merged, loadEnvFile(file, {}));
  return merged;
}

function secretForms(secret) {
  const raw = String(secret);
  const forms = new Set();
  const add = (value) => { if (value && value.length >= 4) forms.add(value); };
  add(raw);
  if (raw.length >= 4) add(JSON.stringify(raw).slice(1, -1));
  add(raw.replace(/\\/g, '\\\\').replace(/"/g, '\\"'));
  for (const part of raw.split(/\s+/)) {
    if (part.length < 4 || part === raw) continue;
    add(part);
    add(JSON.stringify(part).slice(1, -1));
  }
  return [...forms].sort((a, b) => b.length - a.length);
}

function redact(text, secrets) {
  let out = String(text);
  const forms = [];
  for (const secret of secrets || []) forms.push(...secretForms(secret));
  forms.sort((a, b) => b.length - a.length);
  for (const form of forms) out = out.split(form).join('[redacted]');
  return out;
}

function promptPassword(question) {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    if (!stdin.isTTY || typeof stdin.setRawMode !== 'function') {
      reject(fail('set AO_SMOKE_PASSWORD or run in a terminal to type the smoke password'));
      return;
    }
    process.stderr.write(question);
    stdin.setRawMode(true);
    stdin.resume();
    let buf = '';
    const done = (value) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener('data', onData);
      process.stderr.write('\n');
      resolve(value);
    };
    const onData = (chunk) => {
      const text = chunk.toString('utf8');
      for (const ch of text) {
        if (ch === '\n' || ch === '\r') return done(buf);
        if (ch === '\u0003') {
          stdin.setRawMode(false);
          process.emit('SIGINT');
          return;
        }
        if (ch === '\u007f' || ch === '\b') buf = buf.slice(0, -1);
        else buf += ch;
      }
    };
    stdin.on('data', onData);
  });
}

async function smokePassword() {
  const fromEnv = process.env.AO_SMOKE_PASSWORD;
  if (fromEnv) return fromEnv;
  if (process.stdin.isTTY) return promptPassword('Smoke login password: ');
  throw fail('set AO_SMOKE_PASSWORD or run in a terminal to type the smoke password');
}

function parseArgs(argv) {
  let target = 'prod';
  let input = '';
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') return { help: true };
    if (arg === '--target') {
      target = argv[i + 1];
      if (!target) throw fail('missing value for --target');
      i += 1;
      continue;
    }
    if (arg.startsWith('-')) throw fail(`unknown option: ${arg}`);
    if (input) throw fail('too many arguments');
    input = arg;
  }
  if (!input) throw fail('usage: deploy.js [--target prod|rehearsal] SHA');
  if (target !== 'prod' && target !== 'rehearsal') throw fail('target must be prod or rehearsal');
  return { target, input };
}

function targetPlan(target, home) {
  if (target === 'prod') {
    return {
      linkName: 'current',
      units: PROD_UNITS,
      envFiles: [path.join(home, '.config/agent-office-prod.env')],
      publicUrl: process.env.DEPLOY_PUBLIC_URL || '',
    };
  }
  return {
    linkName: 'current-rehearsal',
    units: REHEARSAL_UNITS,
    envFiles: [path.join(home, '.config/agent-office.env'), path.join(home, '.config/agent-office-golive.env')],
    publicUrl: process.env.DEPLOY_PUBLIC_URL || '',
  };
}

function allowedUnit(target, unit) {
  if (unit.includes('openclaw-gateway') || unit.includes('traefik')) return false;
  if (PROD_UNITS.includes(unit)) return target === 'prod';
  if (REHEARSAL_UNITS.includes(unit)) return target === 'rehearsal';
  return false;
}

function previousRelease(link) {
  let st;
  try { st = fs.lstatSync(link); }
  catch { throw fail('previous release is missing'); }
  if (!st.isSymbolicLink()) throw fail(`${link} exists and is not a symlink`);
  const prev = fs.readlinkSync(link);
  const abs = path.resolve(path.dirname(link), prev);
  let dir;
  try { dir = fs.statSync(abs); }
  catch { throw fail('previous release is missing'); }
  if (!dir.isDirectory()) throw fail('previous release is missing');
  return prev;
}

function writeJournal(state) {
  const data = {
    phase: state.phase,
    prev: state.prev,
    dest: state.dest,
    sha: state.sha || null,
    target: state.target,
    link: state.link,
    restarted: Boolean(state.restarted),
    verified: Boolean(state.verified),
    units: state.units,
    publicUrl: state.publicUrl,
    lastKnownGood: state.lastKnownGood || null,
    stepUnit: state.stepUnit || null,
  };
  const file = path.join(state.root, '.journal');
  const tmp = path.join(state.root, `.journal.${process.pid}`);
  fs.writeFileSync(tmp, JSON.stringify(data) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
  try { fs.chmodSync(file, 0o600); } catch { /* already replaced */ }
}

function readJournal(root) {
  try { return JSON.parse(fs.readFileSync(path.join(root, '.journal'), 'utf8')); }
  catch { return null; }
}

function verifyUnitsOn(state, releaseDir) {
  const expected = fs.realpathSync(releaseDir);
  for (const unit of state.units) {
    const show = runSync(state.systemctl, ['--user', 'show', '-p', 'MainPID', '--value', unit]);
    const pid = String(show.stdout || '').trim();
    if (!/^[1-9]\d*$/.test(pid)) throw fail(`no MainPID for ${unit}`);
    let cwd;
    try { cwd = fs.readlinkSync(`/proc/${pid}/cwd`); }
    catch { throw fail(`${unit} is not running the restored release`); }
    if (fs.realpathSync(cwd) !== expected) throw fail(`${unit} is not running the restored release`);
  }
}

function releaseDirExists(target) {
  try { return fs.statSync(target).isDirectory(); }
  catch { return false; }
}

function shaOf(dir) {
  const base = path.basename(String(dir || ''));
  return /^[0-9a-f]{40}$/.test(base) ? base : null;
}

function knownGoodRelease(journal, root) {
  if (!journal) return null;
  if (journal.lastKnownGood && /^[0-9a-f]{40}$/.test(journal.lastKnownGood)) {
    const dir = path.join(root, journal.lastKnownGood);
    if (releaseDirExists(dir)) return dir;
  }
  if (journal.prev && journal.prev !== journal.dest && releaseDirExists(journal.prev)) return journal.prev;
  return null;
}

function manifestBody(dir) {
  const lines = [];
  const walk = (rel) => {
    const abs = rel ? path.join(dir, rel) : dir;
    const st = fs.lstatSync(abs);
    if (st.isSymbolicLink()) {
      lines.push(`link ${rel} ${fs.readlinkSync(abs)}`);
      return;
    }
    if (st.isDirectory()) {
      for (const name of fs.readdirSync(abs).sort()) {
        if (!rel && name === '.manifest') continue;
        walk(rel ? path.join(rel, name) : name);
      }
      return;
    }
    const hash = crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex');
    lines.push(`${hash}  ${rel}`);
  };
  walk('');
  return lines.sort().join('\n') + '\n';
}

function writeManifest(dir) {
  const body = manifestBody(dir);
  const file = path.join(dir, '.manifest');
  fs.writeFileSync(file, body, { mode: 0o644 });
  if (fs.readFileSync(file, 'utf8') !== body) throw fail('release manifest does not match');
}

function checkManifest(dir) {
  const file = path.join(dir, '.manifest');
  if (!fs.existsSync(file)) return;
  if (fs.readFileSync(file, 'utf8') !== manifestBody(dir)) throw fail('release manifest does not match');
}

function treeHash(dir) {
  const lines = [];
  const skipRoot = new Set(['REVISION', '.manifest', 'node_modules']);
  const walk = (rel) => {
    const abs = rel ? path.join(dir, rel) : dir;
    const st = fs.lstatSync(abs);
    if (st.isSymbolicLink()) {
      lines.push(`link ${rel} ${fs.readlinkSync(abs)}`);
      return;
    }
    if (st.isDirectory()) {
      for (const name of fs.readdirSync(abs).sort()) {
        if (!rel && skipRoot.has(name)) continue;
        walk(rel ? path.join(rel, name) : name);
      }
      return;
    }
    const hash = crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex');
    lines.push(`${hash}  ${rel}`);
  };
  walk('');
  return crypto.createHash('sha256').update(lines.sort().join('\n') + '\n').digest('hex');
}

function verifyRevision(dir, sha) {
  let text = '';
  try { text = fs.readFileSync(path.join(dir, 'REVISION'), 'utf8'); }
  catch { throw fail('release tree hash does not match'); }
  const [recordedSha, recordedHash] = text.split('\n');
  if (recordedSha !== sha || !recordedHash) throw fail('release tree hash does not match');
  if (treeHash(dir) !== recordedHash) throw fail('release tree hash does not match');
}

function freezeRelease(dir) {
  const result = spawnSync('chmod', ['-R', 'a-w', dir], { encoding: 'utf8' });
  if (result.status !== 0) throw fail('could not freeze the release');
}

function thawRelease(dir) {
  spawnSync('chmod', ['-R', 'u+w', dir], { stdio: 'ignore' });
}

function gate(name) {
  if (process.env.DEPLOY_GATE !== name) return;
  const file = process.env.DEPLOY_GATE_FILE;
  if (!file) return;
  fs.writeFileSync(file + '.ready', String(process.pid));
  const start = Date.now();
  while (!fs.existsSync(file)) {
    if (Date.now() - start > 20000) throw fail('gate timed out');
    spawnSync('/bin/sleep', ['0.05']);
  }
}

function reconcile(root, systemctl, home) {
  const journal = readJournal(root);
  stopStepUnit(journal && journal.stepUnit);
  if (!journal || journal.verified || journal.phase === 'recovered') return;
  if (!journal.link) return;
  const good = knownGoodRelease(journal, root);
  if (!good) return;
  const current = linkTarget(journal.link);
  const currentAbs = current ? path.resolve(path.dirname(journal.link), current) : null;
  const goodAbs = path.resolve(good);
  const drifted = currentAbs !== goodAbs;
  const mid = journal.restarted && (journal.phase === 'switched' || journal.phase === 'rolling-back' || journal.phase === 'switching');
  if (!drifted && !mid) return;
  const plan = targetPlan(journal.target || 'prod', home);
  try { activeSecrets = Object.values(loadMergedEnv(plan.envFiles)).filter(Boolean); }
  catch { activeSecrets = []; }
  const state = {
    phase: 'rolling-back',
    link: journal.link,
    prev: good,
    dest: journal.dest,
    sha: journal.sha,
    lastKnownGood: shaOf(good),
    target: journal.target,
    root,
    systemctl,
    units: journal.units && journal.units.length ? journal.units : plan.units,
    publicUrl: journal.publicUrl || plan.publicUrl,
    restarted: Boolean(journal.restarted),
    verified: false,
  };
  if (drifted) {
    switchLink(state, good);
    const restored = linkTarget(state.link);
    const restoredAbs = restored ? path.resolve(path.dirname(state.link), restored) : null;
    if (restoredAbs !== goodAbs) throw fail('recovery did not restore the symlink');
  }
  if (journal.restarted) {
    restartSync(state);
    verifyUnitsOn(state, goodAbs);
  }
  state.phase = 'recovered';
  state.restarted = false;
  writeJournal(state);
  process.stderr.write(`deploy: recovered; restored ${state.prev}\n`);
}

function releaseLock() {
  const holder = lockHolder;
  lockHolder = null;
  if (!holder) return;
  // Closing the pipe is what ends the holder. The kernel drops the flock when
  // that process exits. This does not signal a pid.
  try { holder.stdin.end(); } catch { /* already closed */ }
  try { holder.stdin.destroy(); } catch { /* already closed */ }
}

function holdFlock(file) {
  return new Promise((resolve, reject) => {
    let holder;
    try {
      holder = spawn('flock', [
        '--exclusive', '--nonblock', '--', file,
        process.execPath, '-e',
        'process.stdout.write("ready\\n",()=>{process.stdin.on("close",()=>process.exit(0));process.stdin.resume();});',
      ], { stdio: ['pipe', 'pipe', 'ignore'] });
    } catch {
      reject(fail('flock is required'));
      return;
    }
    let ready = false;
    let buf = '';
    const timer = setTimeout(() => {
      if (ready) return;
      try { holder.stdin.destroy(); } catch { /* gone */ }
      reject(fail('another deploy is running'));
    }, 5000);
    const giveUp = (err) => {
      if (ready) return;
      clearTimeout(timer);
      reject(fail(err && err.code === 'ENOENT' ? 'flock is required' : 'another deploy is running'));
    };
    holder.stdout.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      if (ready || !buf.includes('ready')) return;
      ready = true;
      clearTimeout(timer);
      resolve(holder);
    });
    holder.on('error', giveUp);
    holder.on('exit', () => giveUp());
  });
}

async function acquireLock(root, systemctl, home) {
  const file = path.join(root, '.lock');
  fs.mkdirSync(root, { recursive: true });
  if (!fs.existsSync(file)) fs.writeFileSync(file, '', { mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch { /* already private */ }
  lockHolder = await holdFlock(file);
  try {
    reconcile(root, systemctl, home);
    gate('hold-lock');
  } catch (err) {
    releaseLock();
    throw err;
  }
}

async function releaseHead(dir) {
  let real;
  try { real = fs.realpathSync(dir); }
  catch { throw fail(`release ${path.basename(dir)} is not a directory`); }
  const revision = path.join(real, 'REVISION');
  if (fs.existsSync(revision)) {
    const sha = fs.readFileSync(revision, 'utf8').split('\n')[0].trim();
    if (!/^[0-9a-f]{40}$/.test(sha)) throw fail('cannot read release HEAD');
    return { real, head: sha };
  }
  const result = await must('git', ['-C', real, 'rev-parse', 'HEAD'], {}, 'cannot read release HEAD');
  return { real, head: result.stdout.trim() };
}

async function exportRelease(repo, dest, sha) {
  fs.mkdirSync(dest, { recursive: true });
  await mustStep(sha, 'archive', '/bin/bash', [
    '-c',
    'set -o pipefail; git -C "$1" archive --format=tar "$2" | tar -x -C "$3"',
    'bash', repo, sha, dest,
  ], {}, 'could not check out the release');
  const hash = treeHash(dest);
  fs.writeFileSync(path.join(dest, 'REVISION'), `${sha}\n${hash}\n`, { mode: 0o644 });
  const info = await releaseHead(dest);
  if (info.head !== sha) throw fail(`release ${sha} is commit ${info.head}, not ${sha}`);
  if (treeHash(dest) !== hash) throw fail('release tree hash does not match');
}

async function deploy(argv = process.argv, env = process.env) {
  const home = env.HOME || '';
  const root = env.DEPLOY_RELEASES_ROOT || path.join(home, 'dev/project/agent-office-releases');
  const repo = env.DEPLOY_REPO || path.resolve(__dirname, '..');
  const unitDir = env.DEPLOY_UNIT_DIR || path.join(home, '.config/systemd/user');
  const systemctl = env.DEPLOY_SYSTEMCTL || 'systemctl';
  const parsed = parseArgs(argv);
  if (parsed.help) {
    process.stdout.write('usage: deploy.js [--target prod|rehearsal] SHA\n');
    return 0;
  }
  const plan = targetPlan(parsed.target, home);
  const link = path.join(root, plan.linkName);
  process.env.DEPLOY_UNIT_DIR = unitDir;
  fs.mkdirSync(root, { recursive: true });

  const state = {
    phase: 'prepare',
    link,
    prev: null,
    dest: null,
    sha: null,
    target: parsed.target,
    verified: false,
    restarted: false,
    root,
    systemctl,
    units: plan.units,
    publicUrl: plan.publicUrl,
    secrets: [],
    lastKnownGood: null,
  };

  let exiting = false;
  const onSignal = (sig) => {
    if (exiting) return;
    exiting = true;
    try {
      stopStepUnit(activeStep);
      if (!state.verified && state.prev && state.dest && linkTarget(state.link) === state.dest) {
        state.phase = 'rolling-back';
        writeJournal(state);
        switchLink(state, state.prev);
        if (linkTarget(state.link) !== state.prev) throw fail('rollback did not restore the symlink');
        if (state.restarted) {
          restartSync(state);
          verifyUnitsOn(state, path.resolve(path.dirname(state.link), state.prev));
        }
        process.stderr.write(`deploy: interrupted; restored ${state.prev}\n`);
      }
      try { fs.unlinkSync(path.join(root, `.next-${process.pid}`)); } catch { /* no temp link */ }
    } catch {
      process.stderr.write('deploy: interrupted; rollback failed\n');
    }
    releaseLock();
    process.exit(sig === 'SIGINT' ? 130 : 143);
  };
  process.on('SIGTERM', () => onSignal('SIGTERM'));
  process.on('SIGINT', () => onSignal('SIGINT'));

  try {
    for (const unit of plan.units) {
      if (!allowedUnit(parsed.target, unit)) throw fail(`refusing to restart ${unit}`);
      const unitPath = path.join(unitDir, unit);
      if (!fs.existsSync(unitPath)) throw fail(`unit file missing: ${unit}`);
      if (!(await unitRunsFrom(systemctl, unit, link, root))) throw fail(`${unit} does not run from ${link}/`);
    }
    for (const file of plan.envFiles) {
      if (!fs.existsSync(file)) throw fail('env file missing');
    }
    previousRelease(link);
    await acquireLock(root, systemctl, home);
    const good = knownGoodRelease(readJournal(root), root);
    state.prev = good || previousRelease(link);
    state.lastKnownGood = shaOf(state.prev);
    journalState = state;
    writeJournal(state);

    const rev = await must('git', ['-C', repo, 'rev-parse', '--verify', parsed.input + '^{commit}'], {}, 'cannot resolve SHA');
    const sha = rev.stdout.trim();
    if (!/^[0-9a-f]{40}$/.test(sha)) throw fail('SHA is not a commit');
    const dest = path.join(root, sha);
    state.dest = dest;
    state.sha = sha;
    writeJournal(state);

    let reuse = false;
    let present = false;
    try { present = fs.lstatSync(dest) && true; } catch { present = false; }
    if (present) {
      let info = null;
      try { info = await releaseHead(dest); }
      catch { info = null; }
      if (info && info.head !== sha) throw fail(`release ${sha} is commit ${info.head}, not ${sha}`);
      const guarded = protectedRealpaths(root, systemctl);
      const alias = fs.lstatSync(dest).isSymbolicLink();
      const real = info ? info.real : realpathOrNull(dest);
      if (info && (alias || (real && guarded.has(real)))) reuse = true;
      else if (!info && (alias || (real && guarded.has(real)))) throw fail('cannot read release HEAD');
      else removeRelease(repo, dest, guarded);
    }
    const discard = () => {
      if (reuse || !fs.existsSync(dest)) return;
      thawRelease(dest);
      fs.rmSync(dest, { recursive: true, force: true });
    };
    const checkScripts = async () => {
      await mustStep(sha, 'check-server', 'node', ['--check', 'server.js'], { cwd: dest }, 'syntax check failed');
      await mustStep(sha, 'check-gateway', 'node', ['--check', 'gateway.js'], { cwd: dest }, 'syntax check failed');
      await mustStep(sha, 'check-frontend', 'node', ['--check', 'scripts/serve-frontend.js'], { cwd: dest }, 'syntax check failed');
    };
    if (!reuse) {
      try {
        await exportRelease(repo, dest, sha);
        await mustStep(sha, 'npm', 'npm', ['ci', '--omit=dev'], { cwd: dest }, 'npm ci failed');
        await mustStep(sha, 'sync', 'node', ['scripts/sync-design.js'], { cwd: dest }, 'sync-design failed');
        await checkScripts();
      } catch (err) {
        discard();
        throw err;
      }
    } else {
      await checkScripts();
    }

    const check = await step(sha, 'config', 'node', ['-e', `
      const { loadEnvFile, checkConfig } = require('./packaging/bin/agent-office.js');
      const files = process.argv.slice(1);
      let env = {};
      for (const file of files) Object.assign(env, loadEnvFile(file, {}));
      const result = checkConfig(env);
      process.stdout.write(result.lines.join('\\n') + '\\n');
      process.exit(result.ok ? 0 : 1);
    `, ...plan.envFiles], { cwd: dest });
    if (check.status !== 0) {
      discard();
      throw fail('config check failed');
    }
    if (fs.existsSync(path.join(dest, '.manifest'))) checkManifest(dest);
    verifyRevision(dest, sha);
    if (!fs.existsSync(path.join(dest, '.manifest'))) writeManifest(dest);
    freezeRelease(dest);

    const merged = loadMergedEnv(plan.envFiles);
    state.secrets = Object.values(merged);
    activeSecrets = state.secrets.filter(Boolean);
    const password = await smokePassword();
    state.secrets.push(password);
    activeSecrets = state.secrets.filter(Boolean);
    if (!password) throw fail('set AO_SMOKE_PASSWORD or run in a terminal to type the smoke password');

    state.phase = 'switching';
    writeJournal(state);
    await interrupt('before-replace');
    switchLink(state, dest);
    await interrupt('after-replace');
    if (linkTarget(state.link) !== dest) throw fail('symlink did not switch');
    state.phase = 'switched';
    writeJournal(state);

    try {
      await restartUnits(state);
      if (!(await httpReady(state))) throw fail(`GET ${plan.publicUrl}/ did not return 200`);
      const smoke = env.DEPLOY_SMOKE || path.join(dest, 'scripts/golive-smoke.sh');
      const status = await runSmoke(root, smoke, plan.publicUrl, merged, password);
      if (status !== 0) throw fail('smoke failed');
    } catch (err) {
      if (state.phase === 'switched') await rollback(state);
      throw err;
    }

    state.verified = true;
    state.phase = 'verified';
    state.lastKnownGood = sha;
    state.prev = dest;
    writeJournal(state);
    recordHistory(root, parsed.target, sha);
    prune(repo, root, systemctl);
    process.stdout.write(`deploy: ${parsed.target} is ${sha} (${link})\n`);
    return 0;
  } catch (err) {
    process.stderr.write(`deploy: ${redact(err.message, activeSecrets)}\n`);
    return 1;
  } finally {
    stopStepUnit(activeStep);
    releaseLock();
  }
}

function interrupt(point) {
  if (process.env.DEPLOY_INTERRUPT !== point) return;
  // A pending promise alone does not keep the event loop alive, so a self-sent
  // signal would be dropped and the process would exit 0. The timer holds it.
  const timer = setInterval(() => {}, 1000);
  process.emit('SIGTERM');
  return new Promise(() => { timer.ref(); });
}

function linkTarget(link) {
  try {
    if (!fs.lstatSync(link).isSymbolicLink()) return null;
    return fs.readlinkSync(link);
  } catch { return null; }
}

function switchLink(state, target) {
  if (process.env.DEPLOY_FAIL_RESTORE === '1' && state.phase === 'rolling-back') throw fail('restore failed');
  const tmp = path.join(state.root, `.next-${process.pid}`);
  try { fs.unlinkSync(tmp); } catch { /* first attempt */ }
  fs.symlinkSync(target, tmp);
  try { fs.renameSync(tmp, state.link); }
  catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* leave the error */ }
    throw err;
  }
}

function httpCode(url) {
  const result = runSync('curl', ['-s', '-o', '/dev/null', '-w', '%{http_code}', '--max-time', '2', url]);
  return result.status === 0 ? result.stdout.trim() : '000';
}

function restartSync(state) {
  let previous = null;
  for (const unit of state.units) {
    if (previous) {
      const active = runSync(state.systemctl, ['--user', 'is-active', '--quiet', previous]);
      if (active.status !== 0) throw fail(`unit did not become active: ${previous}`);
    }
    const restarted = runSync(state.systemctl, ['--user', 'restart', unit]);
    if (restarted.status !== 0) throw fail(`restart failed: ${unit}`);
    previous = unit;
  }
  for (const unit of state.units) {
    const active = runSync(state.systemctl, ['--user', 'is-active', '--quiet', unit]);
    if (active.status !== 0) throw fail(`unit did not become active: ${unit}`);
  }
  verifyUnitsOn(state, path.resolve(path.dirname(state.link), linkTarget(state.link)));
}

async function restartUnits(state) {
  state.restarted = true;
  writeJournal(state);
  let previous = null;
  for (const unit of state.units) {
    if (previous) {
      const active = await run(state.systemctl, ['--user', 'is-active', '--quiet', previous]);
      if (active.status !== 0) throw fail(`unit did not become active: ${previous}`);
    }
    const restarted = await run(state.systemctl, ['--user', 'restart', unit]);
    if (restarted.status !== 0) throw fail(`restart failed: ${unit}`);
    await interrupt(unit.includes('-api.service') ? 'after-api-restart' : 'after-web-restart');
    previous = unit;
  }
  for (const unit of state.units) {
    const active = await run(state.systemctl, ['--user', 'is-active', '--quiet', unit]);
    if (active.status !== 0) throw fail(`unit did not become active: ${unit}`);
  }
}

async function httpReady(state) {
  for (let i = 0; i < 30; i++) {
    const ui = await run('curl', ['-s', '-o', '/dev/null', '-w', '%{http_code}', '--max-time', '2', state.publicUrl + '/']);
    const api = await run('curl', ['-s', '-o', '/dev/null', '-w', '%{http_code}', '--max-time', '2', state.publicUrl + '/backend/api/v2/meta']);
    if (ui.status === 0 && api.status === 0 && ui.stdout === '200' && api.stdout === '200') return true;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

function writeSmokeFile(root, merged, password) {
  const file = path.join(root, `.smoke-${process.pid}`);
  const lines = [];
  for (const [key, value] of Object.entries(merged)) {
    if (key === 'PORTAL_PASSWORD' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    if (String(value).includes('\n')) continue;
    lines.push(`${key}=${value}`);
  }
  lines.push(`PORTAL_PASSWORD=${password}`);
  fs.writeFileSync(file, lines.join('\n') + '\n', { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  return file;
}

function runSmoke(root, smoke, url, merged, password) {
  const file = writeSmokeFile(root, merged, password);
  const env = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    LANG: process.env.LANG || 'C',
    AO_SMOKE_FILE: file,
  };
  if (process.env.SMOKE_EXIT) env.SMOKE_EXIT = process.env.SMOKE_EXIT;
  if (process.env.SMOKE_LEAK) env.SMOKE_LEAK = process.env.SMOKE_LEAK;
  if (process.env.SMOKE_FRAG) env.SMOKE_FRAG = process.env.SMOKE_FRAG;
  return new Promise((resolve) => {
    let child;
    let settled = false;
    const finish = (status) => {
      if (settled) return;
      settled = true;
      try { fs.unlinkSync(file); } catch { /* already gone */ }
      process.stderr.write(`deploy: smoke exit ${status}\n`);
      resolve(status);
    };
    try {
      child = spawn(smoke, [url], { shell: false, detached: true, stdio: 'ignore', env });
    } catch {
      finish(1);
      return;
    }
    child.on('error', () => finish(1));
    child.on('close', (code) => finish(code == null ? 1 : code));
  });
}

async function rollback(state) {
  await interrupt('during-rollback');
  if (!state.prev) throw fail('failed and there is no previous release to restore');
  state.phase = 'rolling-back';
  writeJournal(state);
  switchLink(state, state.prev);
  if (linkTarget(state.link) !== state.prev) throw fail('rollback did not restore the symlink');
  try { restartSync(state); }
  catch (err) {
    if (err.deploy && /restart failed/.test(err.message)) throw err;
    throw fail(`restored ${state.prev} but the public URL did not recover`);
  }
  if (httpCode(state.publicUrl + '/') !== '200' || httpCode(state.publicUrl + '/backend/api/v2/meta') !== '200') {
    throw fail(`restored ${state.prev} but the public URL did not recover`);
  }
  process.stderr.write(`deploy: failed; restored ${state.prev} and restarted ${state.units.join(' ')}\n`);
}

function removeRelease(repo, dir, guarded) {
  const real = realpathOrNull(dir);
  if (!real) return;
  if (guarded.has(real)) throw fail(`refusing to remove a release still in use: ${path.basename(dir)}`);
  thawRelease(dir);
  fs.rmSync(dir, { recursive: true, force: true });
  if (realpathOrNull(dir)) throw fail(`could not remove old release ${path.basename(dir)}`);
}

function recordHistory(root, target, sha) {
  const file = path.join(root, `.history-${target}`);
  const prev = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const lines = prev.split('\n').map((l) => l.trim()).filter(Boolean);
  lines.push(sha);
  const next = lines.slice(-3).join('\n') + '\n';
  const tmp = path.join(root, `.history-${target}.${process.pid}`);
  fs.writeFileSync(tmp, next, { mode: 0o600 });
  fs.renameSync(tmp, file);
  fs.chmodSync(file, 0o600);
}

function prune(repo, root, systemctl) {
  const guarded = protectedRealpaths(root, systemctl);
  let entries = [];
  try { entries = fs.readdirSync(root); } catch { return; }
  for (const name of entries) {
    if (!/^[0-9a-f]{40}$/.test(name)) continue;
    const dir = path.join(root, name);
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) continue;
    const real = realpathOrNull(dir);
    if (!real || guarded.has(real)) continue;
    try { removeRelease(repo, dir, guarded); }
    catch (err) { process.stderr.write(`deploy: ${err.message}\n`); }
  }
}

function enterScope() {
  const token = crypto.randomBytes(6).toString('hex');
  const unit = `agent-office-deploy-${token}`;
  const probe = spawnSync('systemd-run', [
    '--user', '--collect', '--quiet', '--pipe', '--wait', '--', '/bin/true',
  ], { encoding: 'utf8' });
  if (probe.status !== 0) {
    process.env.DEPLOY_IN_SCOPE = '1';
    return deploy(process.argv, process.env).then((code) => process.exit(code));
  }
  if (process.env.DEPLOY_SCOPE_FILE) {
    fs.writeFileSync(process.env.DEPLOY_SCOPE_FILE, `${unit}.service\n`, { mode: 0o600 });
  }
  const envFile = path.join(fs.realpathSync(os.tmpdir()), `ao-deploy-env-${token}`);
  const lines = ['DEPLOY_IN_SCOPE=1', `DEPLOY_SCOPE_UNIT=${unit}`];
  for (const [key, value] of Object.entries(process.env)) {
    if (key === 'DEPLOY_IN_SCOPE' || key === 'DEPLOY_SCOPE_UNIT') continue;
    if (value == null || /[\n\0]/.test(String(value))) continue;
    lines.push(`${key}=${value}`);
  }
  fs.writeFileSync(envFile, lines.join('\n') + '\n', { mode: 0o600 });
  const child = spawn('systemd-run', [
    '--user', '--collect', '--wait', '--pipe',
    '--property=KillMode=control-group',
    `--unit=${unit}`,
    '--',
    process.execPath, __filename, `--scope-env=${envFile}`, ...process.argv.slice(2),
  ], { stdio: 'inherit' });
  const forward = () => {
    spawnSync('/usr/bin/systemctl', ['--user', 'stop', `${unit}.service`], { stdio: 'ignore' });
  };
  const finish = (code) => {
    try { fs.unlinkSync(envFile); } catch { /* inner already removed it */ }
    process.exit(code == null ? 1 : code);
  };
  process.on('SIGTERM', forward);
  process.on('SIGINT', forward);
  child.on('error', () => {
    try { fs.unlinkSync(envFile); } catch { /* gone */ }
    process.env.DEPLOY_IN_SCOPE = '1';
    deploy(process.argv, process.env).then((code) => process.exit(code));
  });
  child.on('exit', (code) => finish(code));
}

function loadScopeEnv() {
  const flag = process.argv.find((arg) => arg.startsWith('--scope-env='));
  if (!flag) return;
  const file = flag.slice('--scope-env='.length);
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { text = ''; }
  try { fs.unlinkSync(file); } catch { /* already gone */ }
  for (const line of text.split('\n')) {
    if (!line) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    process.env[line.slice(0, eq)] = line.slice(eq + 1);
  }
  process.argv = process.argv.filter((arg) => arg !== flag);
}

function main() {
  loadScopeEnv();
  if (process.env.DEPLOY_IN_SCOPE === '1' || process.env.DEPLOY_SCOPE === '0') {
    return deploy(process.argv, process.env).then((code) => process.exit(code));
  }
  return enterScope();
}

if (require.main === module) main();

module.exports = {
  deploy, loadUnit, unitRunsFrom, loadMergedEnv, protectedRealpaths, serviceDirectives, parseArgs,
  argvFromExecStartShow, redact,
};
