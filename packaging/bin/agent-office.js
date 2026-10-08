#!/usr/bin/env -S node --
'use strict';
// npx entry for Agent Office. Secrets stay in the environment; this process never prints them.
//   agent-office start [--api-only] [--config file] [--data dir] [--port n] [--host addr] [--env-file file]
//   agent-office web [--port n] [--host addr] [--env-file file]
//   agent-office check-config [--env-file file]
//   agent-office hash-password
//   agent-office version

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const COMMANDS = new Set(['start', 'setup', 'web', 'check-config', 'hash-password', 'version', 'help', 'backup', 'restore', 'doctor', 'integrations']);
const REQUIRED_ENV = ['OC_GATEWAY_TOKEN', 'PORTAL_EMAIL', 'PORTAL_SECRET'];

const HELP = `agent-office <command>

  start [--api-only] [--config file] [--data dir] [--port n] [--host addr] [--env-file file]
      Start the UI at / and the API at /backend, on one port (default 18789).
      --api-only serves the API alone at /api (production split, or AO_API_ONLY=1).
      --config sets AO_CONFIG, --data sets AO_DATA_DIR.
      --env-file loads KEY=VALUE lines. A variable already set in the environment wins.
  setup [--config file] [--data dir] [--port n] [--host addr] [--env-file file]
      Start the browser setup wizard. Open the printed URL and enter the one-time code.
      An already configured instance keeps setup locked.
  web [--port n] [--host addr] [--env-file file]
      Start the static UI (scripts/serve-frontend.js). Default API base is /backend.
  check-config [--config file] [--data dir] [--env-file file]
      Report ok or missing for each key. Values and paths are not printed.
  backup <file> [--data dir] [--config file] [--include-secrets] [--force]
      An online, verified backup of the store and the config file (0600). Secrets only with --include-secrets.
  restore <file> [--data dir] [--config file] [--force]
      Restore a backup (stop the server first). Refused for another instance's backup or a newer schema.
  doctor [--json] [--lang fr|en] [--url <public URL>] [--api-base path] [--env-file file] [--config file] [--data dir] [--skip-runtime]
      Read-only checks of this install: environment (presence only), files and permissions, data directory, store,
      runtime, public URL and proxy headers (with --url), clock and disk. Never prints a value.
      Exit 0 ok, 1 warning, 2 failure.
  integrations [status|install|uninstall] [--agent id]… [--all] [--dry-run] [--force] [--json] [--lang fr|en]
      What Agent Office adds to the runtime's agents (OpenClaw: the project tag, a skill and an AGENTS.md block).
      Default: the primary agent. Idempotent; AGENTS.md is backed up before every change; uninstall removes it all.
  hash-password
      Read the login password from the terminal (no echo, asked twice) or from stdin.
      Print only the scrypt hash for PORTAL_PASSWORD_HASH.
      The password is not taken from arguments or the environment.
  version
      Print the package version.

With no command, flags apply to start (agent-office --data ./data).
`;

function packageRoot(from = __dirname) {
  return path.resolve(from, '..', '..');
}

function readVersion(root) {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  return String(pkg.version || '');
}

function parseArgs(argv) {
  const args = argv.slice(2);
  let command = 'start';
  let i = 0;
  if (args[0] && COMMANDS.has(args[0])) {
    command = args[0];
    i = 1;
  }
  if (command === 'hash-password') {
    if (args.length > 1) throw new Error('hash-password reads the password from the terminal or stdin');
    return { command, flags: new Set(), opts: {} };
  }
  const flags = new Set();
  const opts = {};
  const take = (name) => {
    const value = args[i + 1];
    if (!value || value.startsWith('-')) throw new Error(`missing value for --${name}`);
    opts[name] = value;
    i += 1;
  };
  for (; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--api-only') flags.add('api-only');
    else if (arg === '--help' || arg === '-h') flags.add('help');
    else if (arg === '--version' || arg === '-v') flags.add('version');
    else if (arg === '--config') take('config');
    else if (arg === '--data') take('data');
    else if (arg === '--port') take('port');
    else if (arg === '--host') take('host');
    else if (arg === '--env-file') take('envFile');
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (flags.has('version') && command === 'start' && !flags.has('api-only') && !opts.config && !opts.data) command = 'version';
  if (flags.has('help') && command === 'start') command = 'help';
  return { command, flags, opts };
}

function loadEnvFile(file, env) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (err) {
    const code = err && err.code ? err.code : 'error';
    throw new Error(`cannot read env file (${code})`);
  }
  const next = { ...env };
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const body = line.startsWith('export ') ? line.slice(7).trim() : line;
    const eq = body.indexOf('=');
    if (eq <= 0) continue;
    const key = body.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = body.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (next[key] == null || next[key] === '') next[key] = value;
  }
  return next;
}

function checkConfig(env, fileExists) {
  const exists = fileExists || ((p) => fs.existsSync(p));
  const lines = [];
  let ok = true;
  const state = (present) => (present ? 'ok' : 'missing');
  for (const key of REQUIRED_ENV) {
    const have = Boolean(env[key]);
    lines.push(`${key}: ${state(have)}`);
    if (!have) ok = false;
  }
  const hash = Boolean(env.PORTAL_PASSWORD_HASH);
  const plain = Boolean(env.PORTAL_PASSWORD);
  lines.push(`PORTAL_PASSWORD_HASH: ${state(hash)}`);
  if (!hash) lines.push(`PORTAL_PASSWORD: ${state(plain)}`);
  if (!hash && !plain) ok = false;
  lines.push(`AO_CONFIG: ${state(env.AO_CONFIG && exists(env.AO_CONFIG))}`);
  lines.push(`AO_DATA_DIR: ${state(env.AO_DATA_DIR && exists(env.AO_DATA_DIR))}`);
  return { ok, lines };
}

function childEnv(env, opts, extra) {
  const next = { ...env, ...extra };
  if (opts.config) next.AO_CONFIG = opts.config;
  if (opts.data) next.AO_DATA_DIR = opts.data;
  if (opts.port) next.PORT = opts.port;
  if (opts.host) next.HOST = opts.host;
  return next;
}

function spawnPlan(parsed, env, root) {
  if (parsed.command === 'web') {
    return {
      script: path.join(root, 'scripts', 'serve-frontend.js'),
      args: [],
      env: childEnv(env, parsed.opts, {}),
    };
  }
  const apiOnly = parsed.flags.has('api-only') || env.AO_API_ONLY === '1';
  if (!apiOnly) {
    return {
      script: path.join(root, 'packaging', 'bin', 'combined.js'),
      args: [],
      env: childEnv(env, parsed.opts, {}),
    };
  }
  return {
    script: path.join(root, 'server.js'),
    args: [],
    env: childEnv(env, parsed.opts, { AO_API_ONLY: '1' }),
  };
}

function superviseChild(child) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (code) => {
      if (settled) return;
      settled = true;
      process.off('SIGTERM', onTerm);
      process.off('SIGINT', onInt);
      resolve(typeof code === 'number' ? code : 1);
    };
    const forward = (sig) => {
      if (settled || child.exitCode != null || child.signalCode != null) return;
      try { child.kill(sig); } catch { finish(1); }
    };
    const onTerm = () => forward('SIGTERM');
    const onInt = () => forward('SIGINT');
    process.on('SIGTERM', onTerm);
    process.on('SIGINT', onInt);
    child.on('error', () => finish(1));
    child.on('exit', (code) => finish(code));
  });
}

function main(argv, env, io = {}) {
  const root = io.root || packageRoot();
  const stdout = io.stdout || process.stdout;
  const stderr = io.stderr || process.stderr;
  const spawnChild = io.spawn || spawn;
  // architect-56 (docs/guide/project-tag.md): install / remove what Agent Office adds to the runtime's agents
  if (argv[2] === 'integrations') {
    return require(path.join(root, 'src', 'ops', 'integrations.js')).run(argv.slice(3), env, { out: (m) => stdout.write(m), err: (m) => stderr.write(m) }, { loadEnvFile });
  }
  // G11 (docs/guide/troubleshooting.md): read-only checks; exit 0 ok / 1 warning / 2 failure / 64 usage
  if (argv[2] === 'doctor') {
    return require(path.join(root, 'src', 'ops', 'doctor', 'cli.js')).run(argv.slice(3), env, { out: (m) => stdout.write(m), err: (m) => stderr.write(m) }, { loadEnvFile });
  }
  // G8 (docs/architecture/operations.md §2): backup and restore parse their own arguments; exit 0 / 1 refused / 2 failed
  if (argv[2] === 'backup' || argv[2] === 'restore') {
    return require(path.join(root, 'src', 'ops', 'cli.js')).run(argv[2], argv.slice(3), env, (m) => stdout.write(m + '\n'), (m) => stderr.write(m + '\n'));
  }
  let parsed;
  try { parsed = parseArgs(argv); } catch (err) {
    stderr.write(`${err.message}\n${HELP}`);
    return 2;
  }
  if (parsed.command === 'setup') {
    if (parsed.flags.has('help')) { stdout.write(HELP); return 0; }
    parsed.command = 'start';
    parsed.opts.host ||= '127.0.0.1';
    stdout.write(`Setup wizard: http://${parsed.opts.host}:${parsed.opts.port || env.PORT || 18789}/\n`);
  }
  if (parsed.command === 'help') {
    stdout.write(HELP);
    return 0;
  }
  if (parsed.command === 'version') {
    stdout.write(`${readVersion(root)}\n`);
    return 0;
  }
  const needsFile = parsed.command === 'check-config' || parsed.command === 'start' || parsed.command === 'web';
  let runtimeEnv = env;
  if (needsFile && parsed.opts.envFile) {
    try { runtimeEnv = loadEnvFile(parsed.opts.envFile, env); } catch (err) {
      stderr.write(`${err.message}\n`);
      return 1;
    }
  }
  if (parsed.command === 'check-config') {
    const result = checkConfig(childEnv(runtimeEnv, parsed.opts, {}), io.fileExists);
    stdout.write(`${result.lines.join('\n')}\n`);
    return result.ok ? 0 : 1;
  }
  if (parsed.command === 'hash-password') {
    const stripped = { ...env };
    delete stripped.PORTAL_PASSWORD;
    delete stripped.PORTAL_PASSWORD_HASH;
    const child = spawnChild(process.execPath, [path.join(root, 'scripts', 'hash-password.js')], {
      env: stripped,
      stdio: 'inherit',
    });
    return superviseChild(child);
  }
  const job = spawnPlan(parsed, runtimeEnv, root);
  const child = spawnChild(process.execPath, [job.script, ...job.args], { env: job.env, stdio: 'inherit' });
  return superviseChild(child);
}

module.exports = {
  parseArgs, loadEnvFile, checkConfig, spawnPlan, superviseChild, packageRoot, readVersion, main, HELP, REQUIRED_ENV,
};

if (require.main === module) {
  Promise.resolve(main(process.argv, process.env)).then((code) => process.exit(code));
}
