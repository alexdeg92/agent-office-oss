#!/usr/bin/env node
'use strict';
/*
 * Capture redacted test fixtures from the live OpenClaw gateway and CLI (migration step S0).
 *
 * READ-ONLY. It calls an explicit allowlist of read RPCs, subscribes to the same event streams the
 * portal subscribes to, runs only `openclaw skills list|info --agent main --json` and `openclaw --version`,
 * and `df -B1 /`. It never reads openclaw.json (config fixtures are hand-written).
 *
 * Everything written passes through scripts/lib/fixture-redact.js (strict, default-deny), then a leak
 * scan. If the scan finds anything, nothing is written to the output directory (use --force-write to
 * inspect the files in a scratch --out directory anyway).
 *
 * Usage (run by the PM on the host, never by an agent):
 *   set -a; . ~/.config/agent-office.env; set +a
 *   node scripts/capture-fixtures.js --label capture-20261005 [--events-seconds 60] [--out test/fixtures/local]
 *       [--max-sessions 12] [--max-messages 40] [--no-skill-files] [--force-write]
 *
 * Output (relative to --out):
 *   gw/rpc/<method>/<version>/<label>[-<n>].json      RawEnvelope-style fixture files
 *   gw/event/<event>/<version>/<label>-<n>.json
 *   cli/<command>/<version>/<label>[-<n>].json
 *   host/df/<label>.json
 *   files/skills/<name>/SKILL.md                      scrambled, structure kept
 *   scenarios/<label>.json                            manifest used by the characterisation tests
 *   captures/<label>.report.md                        the redaction report (also printed)
 */
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { FixtureRedactor, scanLeaks } = require('./lib/fixture-redact');

const ROOT = path.resolve(__dirname, '..');

// ---------- args ----------
function parseArgs(argv) {
  // captures are local-only and gitignored (PM, on review-06)
  const a = { label: null, eventsSeconds: 60, out: path.join(ROOT, 'test', 'fixtures', 'local'), maxSessions: 12, maxMessages: 40, skillFiles: true, forceWrite: false };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i], v = () => argv[++i];
    if (k === '--label') a.label = v();
    else if (k === '--events-seconds') a.eventsSeconds = Number(v());
    else if (k === '--out') a.out = path.resolve(v());
    else if (k === '--max-sessions') a.maxSessions = Number(v());
    else if (k === '--max-messages') a.maxMessages = Number(v());
    else if (k === '--no-skill-files') a.skillFiles = false;
    else if (k === '--force-write') a.forceWrite = true;
    else if (k === '-h' || k === '--help') { console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(2, 26).join('\n')); process.exit(0); }
    else { console.error('unknown argument: ' + k); process.exit(2); }
  }
  if (!a.label || !/^[a-z0-9][a-z0-9-]{2,47}$/.test(a.label)) { console.error('--label is required, e.g. --label capture-20261005'); process.exit(2); }
  // R8-03: the output root must be inside test/fixtures/local (by real path, git-ignored), checked before connecting
  try { require('./lib/local-roots').assertLocal(a.out); } catch (e) { console.error(e.message); process.exit(2); }
  return a;
}

// ---------- read-only guards ----------
const READ_RPCS = new Set(['agents.list', 'sessions.list', 'cron.list', 'channels.status', 'sessions.usage',
  'sessions.describe', 'sessions.get', 'cron.runs', 'sessions.subscribe', 'sessions.messages.subscribe']);
const READ_CLI = [/^skills list --agent main --json$/, /^skills info [A-Za-z0-9._-]+ --agent main --json$/, /^--version$/];

function rpc(gw, method, params) {
  if (!READ_RPCS.has(method)) throw new Error('refused non-allowlisted RPC: ' + method);
  return gw._raw(method, params || {}, 20000);   // raw frame: we want {ok, payload, error} exactly as sent
}
function cli(args) {
  const line = args.join(' ');
  if (!READ_CLI.some((re) => re.test(line))) return Promise.reject(new Error('refused non-allowlisted CLI call: ' + line));
  const bin = process.env.OC_BIN || path.join(process.env.HOME || '', '.npm-global/bin/openclaw');
  return new Promise((resolve) => {
    execFile(bin, args, { timeout: 60000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ ok: !err, exitCode: err ? (err.code ?? 1) : 0, stdout: String(stdout || ''), stderrLines: String(stderr || '').split('\n').filter(Boolean).length });
    });
  });
}

// Same rules as server.js classifySession (S0 characterises today's behaviour); used only to pick samples.
function legacyType(key) {
  if (!key) return 'other';
  if (/:main$/.test(key)) return 'main';
  if (key.includes('heartbeat')) return 'system';
  if (key.includes(':subagent:')) return 'subagent';
  if (key.includes(':cron:')) return 'cron';
  if (key.includes(':discord:')) return key.includes('channel') ? 'channel' : 'dm';
  return 'other';
}

// ---------- main ----------
async function main() {
  const args = parseArgs(process.argv.slice(2));
  for (const k of ['OC_GATEWAY_TOKEN']) if (!process.env[k]) { console.error(`Missing ${k}. Load the env file first (see usage).`); process.exit(2); }

  const red = new FixtureRedactor();
  const files = new Map();                 // relative path → string content
  const scenario = { name: args.label, origin: 'capture', openclawVersion: null, now: null, rpc: {}, events: { onConnect: [] }, cli: {}, host: {}, notes: [] };
  const envelope = (source, channel, params, body) => ({ $fixture: { source, channel, origin: 'capture', openclawVersion: scenario.openclawVersion, params: params ? red.redact(params, '$params') : undefined }, body });
  // Every file goes through the final sweep (any 17–20 digit run in any string or number → shared id map).
  const put = (rel, obj) => { files.set(rel, typeof obj === 'string' ? red.sweepString(obj) : JSON.stringify(red.sweep(obj), null, 2) + '\n'); return rel; };
  const log = (m) => console.error('[capture] ' + m);

  // --- gateway ---
  const { Gateway } = require(path.join(ROOT, 'gateway.js'));
  const gw = new Gateway({
    url: process.env.OC_GATEWAY_URL || 'ws://127.0.0.1:18793',
    gatewayToken: process.env.OC_GATEWAY_TOKEN,
    // ADR-001 §12.1: the same derivation as the server (one runtime home; OC_* overrides)
    ...(({ identityPath, stateDbPath }) => ({ identityPath, stateDbPath }))(require(path.join(ROOT, 'src', 'config.js')).openclawPaths(process.env)),
  });
  if (gw.notConfigured) throw new Error('gateway not configured (' + gw.notConfigured + ')');
  // Intercept the connect response to learn the server version (gateway.js discards it).
  let hello = null;
  const origRaw = gw._raw.bind(gw);
  gw._raw = async (method, params, t) => { const r = await origRaw(method, params, t); if (method === 'connect' && r && r.ok) hello = r.payload; return r; };

  const events = new Map();                // event name → [payload]
  gw.on('gwevent', (name, payload) => {
    const list = events.get(name) || []; events.set(name, list);
    // Signature = every field that distinguishes event variants; up to 4 per signature, 16 per event name.
    // (capture-20261005-active kept only 2 sessions.changed because all shared kind 'direct'.)
    const p = payload && typeof payload === 'object' ? payload : {};
    const sig = [p.type, p.kind, p.operation, p.tool, p.status, p.reason, p.activitySummary && p.activitySummary.state, p.hasActiveRun].map((x) => (x == null ? '' : String(x))).join('|');
    if (list.length < 16 && list.filter((x) => x.sig === sig).length < 4) list.push({ sig, at: Date.now(), payload });
  });
  gw.on('log', (m) => log('gateway: ' + String(m).replace(/[A-Za-z0-9+/_-]{24,}/g, '[…]')));
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('gateway did not connect within 20 s')), 20000);
    gw.once('open', () => { clearTimeout(t); resolve(); });
    gw.start();
  });
  log('connected');

  // version
  const helloVersion = hello && ((hello.server && hello.server.version) || hello.version || hello.serverVersion);
  let version = typeof helloVersion === 'string' ? helloVersion : null;
  if (!version) { const v = await cli(['--version']); const m = v.stdout.match(/\d{4}\.\d+\.\d+/); version = m ? m[0] : 'unknown'; }
  scenario.openclawVersion = version;
  if (hello) put(`gw/hello/${version}/${args.label}.json`, envelope('gateway', 'gw.hello', null, { kind: 'json', value: red.redact(hello) }));
  log('openclaw version ' + version);

  const saveRpc = async (method, params, suffix) => {
    const r = await rpc(gw, method, params);
    const body = r.ok ? { kind: 'json', value: red.redact(r.payload) } : { kind: 'error', message: red.text((r.error && r.error.message) || 'rpc failed'), code: r.error && r.error.code };
    const rel = put(`gw/rpc/${method}/${version}/${args.label}${suffix ? '-' + suffix : ''}.json`, envelope('gateway', 'gw.rpc.' + method, params, body));
    return { r, rel };
  };

  // subscribe first so events flow while we fetch
  await rpc(gw, 'sessions.subscribe', {}); await rpc(gw, 'sessions.messages.subscribe', {});

  for (const m of ['agents.list', 'cron.list', 'channels.status', 'sessions.usage']) scenario.rpc[m] = (await saveRpc(m, {})).rel;
  const sl = await saveRpc('sessions.list', { limit: 300 });
  scenario.rpc['sessions.list'] = sl.rel;

  // sample sessions: up to 2 per legacy type, newest first
  const sessions = (sl.r.ok && sl.r.payload && Array.isArray(sl.r.payload.sessions)) ? sl.r.payload.sessions : [];
  const perType = new Map(); const picked = [];
  for (const s of sessions.slice().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))) {
    const t = legacyType(s.key); const n = perType.get(t) || 0;
    if (n < 2 && picked.length < args.maxSessions) { perType.set(t, n + 1); picked.push(s.key); }
  }
  scenario.rpc['sessions.get'] = { param: 'key', files: {} };
  scenario.rpc['sessions.describe'] = { param: 'key', files: {} };
  let i = 0;
  for (const key of picked) {
    i++;
    const fakeKey = red.redact(key, '$', 'key');
    const g = await rpc(gw, 'sessions.get', { key });
    if (g.ok && g.payload && Array.isArray(g.payload.messages) && g.payload.messages.length > args.maxMessages) {
      scenario.notes.push(`sessions.get ${i}: trimmed to the last ${args.maxMessages} of ${g.payload.messages.length} messages`);
      g.payload = Object.assign({}, g.payload, { messages: g.payload.messages.slice(-args.maxMessages) });
    }
    const gBody = g.ok ? { kind: 'json', value: red.redact(g.payload) } : { kind: 'error', message: red.text((g.error && g.error.message) || 'rpc failed') };
    scenario.rpc['sessions.get'].files[fakeKey] = put(`gw/rpc/sessions.get/${version}/${args.label}-${i}.json`, envelope('gateway', 'gw.rpc.sessions.get', { key }, gBody));
    scenario.rpc['sessions.describe'].files[fakeKey] = (await saveRpc('sessions.describe', { key }, String(i))).rel;
  }

  // cron runs: up to 4 jobs, enabled first
  const cronList = await rpc(gw, 'cron.list', {});
  const jobs = (cronList.ok && cronList.payload && Array.isArray(cronList.payload.jobs)) ? cronList.payload.jobs : [];
  scenario.rpc['cron.runs'] = { param: 'jobId', files: {} };
  let j = 0;
  for (const job of jobs.slice().sort((a, b) => (b.enabled ? 1 : 0) - (a.enabled ? 1 : 0)).slice(0, 4)) {
    j++;
    scenario.rpc['cron.runs'].files[red.redact(job.id, '$', 'id')] = (await saveRpc('cron.runs', { jobId: job.id }, String(j))).rel;
  }

  // --- CLI ---
  const cliEnvelope = (channel, args2, res) => envelope('cli', channel, { argv: args2 }, { kind: 'text', exitCode: res.exitCode, value: redactCliText(red, res.stdout) });
  const list = await cli(['skills', 'list', '--agent', 'main', '--json']);
  scenario.cli['skills.list'] = put(`cli/skills.list/${version}/${args.label}.json`, cliEnvelope('cli.skills.list', ['skills', 'list', '--agent', 'main', '--json'], list));
  const skills = parseFromBrace(list.stdout);
  const all = (skills && Array.isArray(skills.skills)) ? skills.skills : [];
  const pick = [];
  const want = [(s) => s.eligible !== false && !s.disabled, (s) => s.disabled, (s) => s.eligible === false && !s.disabled, (s) => /workspace/.test(s.source || '')];
  for (const w of want) { const s = all.find((x) => w(x) && !pick.includes(x)); if (s) pick.push(s); }
  scenario.cli['skills.info'] = {};
  let k = 0;
  for (const s of pick) {
    k++;
    const name = String(s.name);
    if (!/^[A-Za-z0-9._-]+$/.test(name)) continue;
    const res = await cli(['skills', 'info', name, '--agent', 'main', '--json']);
    const info = parseFromBrace(res.stdout);
    // SKILL.md: copied scrambled; filePath replaced by a placeholder the fake CLI resolves
    const fakeName = red.redact(name, '$', 'name');
    let post = null;
    if (info && typeof info.filePath === 'string') {
      const placeholder = `{{FIXTURES_DIR}}/files/skills/${fakeName}/SKILL.md`;
      post = (json) => { if (json && typeof json === 'object') json.filePath = placeholder; };
      if (args.skillFiles) {
        try {
          const st = fs.statSync(info.filePath);
          if (st.size < 64 * 1024) put(`files/skills/${fakeName}/SKILL.md`, scrambleMarkdown(red, fs.readFileSync(info.filePath, 'utf8')));
        } catch (_) { scenario.notes.push(`skills.info ${k}: SKILL.md not readable`); }
      }
    }
    const env2 = envelope('cli', 'cli.skills.info', { argv: ['skills', 'info', '<name>', '--agent', 'main', '--json'] },
      { kind: 'text', exitCode: res.exitCode, value: redactCliText(red, res.stdout, post) });
    scenario.cli['skills.info'][fakeName] = put(`cli/skills.info/${version}/${args.label}-${k}.json`, env2);
  }

  // --- host ---
  const df = await new Promise((resolve) => execFile('df', ['-B1', '/'], { timeout: 4000 }, (err, out) => resolve(err ? '' : String(out))));
  scenario.host.df = put(`host/df/${args.label}.json`, envelope('host', 'host.df', null, { kind: 'text', value: df.replace(/^\/dev\/\S+/m, '/dev/disk0') }));

  // --- events ---
  log(`listening to events for ${args.eventsSeconds} s…`);
  await new Promise((r) => setTimeout(r, args.eventsSeconds * 1000));
  for (const [name, list2] of events) {
    if (name === 'connect.challenge') continue;
    list2.forEach((e, n) => {
      const rel = put(`gw/event/${name}/${version}/${args.label}-${n + 1}.json`, envelope('gateway', 'gw.event.' + name, null, { kind: 'json', value: red.redact(e.payload) }));
      if (name === 'health' && n === 0) scenario.events.onConnect.push(rel);
      (scenario.events.observed = scenario.events.observed || []).push(rel);
    });
  }
  scenario.now = Date.now() + red.timeShiftMs;
  gw._retry = () => {};
  try { gw.ws && gw.ws.close(); } catch (_) {}

  put(`scenarios/${args.label}.json`, scenario);

  // --- leak scan over everything we are about to write ---
  const extra = [process.env.OC_GATEWAY_TOKEN, process.env.PORTAL_PASSWORD, process.env.PORTAL_SECRET, process.env.PORTAL_EMAIL];
  const leaks = [];
  for (const [rel, content] of files) leaks.push(...scanLeaks(content, rel, extra));
  // R1-02: the report itself is scanned; if anything at all is flagged, only counts are printed.
  let report = red.reportMarkdown(args.label, leaks);
  leaks.push(...scanLeaks(report, `captures/${args.label}.report.md`, extra));
  if (leaks.length) report = red.reportMarkdown(args.label, leaks, { minimal: true });
  files.set(`captures/${args.label}.report.md`, report);

  console.log(report);
  if (leaks.length && !args.forceWrite) {
    console.error(`[capture] ${leaks.length} possible leak(s): NOTHING WRITTEN. Fix the redaction rules, or rerun with --force-write (still under test/fixtures/local) to inspect.`);
    process.exit(1);
  }
  for (const [rel, content] of files) {
    const abs = path.join(args.out, rel);
    require('./lib/local-roots').assertLocal(abs);     // every file, whatever its name (R8-03)
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  console.error(`[capture] wrote ${files.size} files under ${path.relative(process.cwd(), args.out) || '.'}`);
  process.exit(0);
}

function parseFromBrace(s) { const i = String(s).indexOf('{'); if (i < 0) return null; try { return JSON.parse(s.slice(i)); } catch (_) { return null; } }

// CLI stdout = optional text prefix + JSON. Redact the JSON structurally and scramble the prefix.
function redactCliText(red, stdout, post) {
  const i = stdout.indexOf('{');
  if (i < 0) return red.text(stdout);
  const prefix = stdout.slice(0, i), rest = stdout.slice(i);
  let json; try { json = JSON.parse(rest); } catch (_) { return red.text(prefix) + red.text(rest); }
  const out = red.redact(json);
  if (post) post(out);
  return red.text(prefix) + JSON.stringify(out, null, 2) + '\n';
}

// Keep markdown structure (front matter keys, headings, list markers, code fences); scramble words.
function scrambleMarkdown(red, md) {
  return md.split('\n').map((line) => {
    const fm = line.match(/^([A-Za-z0-9_-]+):(\s*)(.*)$/);
    if (fm) return fm[1] + ':' + fm[2] + (fm[1] === 'name' ? red.redact(fm[3], '$', 'name') : red.text(fm[3]));
    if (/^(```|---)/.test(line)) return line;
    return red.text(line);
  }).join('\n');
}

if (require.main === module) main().catch((e) => { console.error('[capture] failed: ' + e.message); process.exit(1); });
module.exports = { redactCliText, scrambleMarkdown, legacyType, READ_RPCS, READ_CLI };
