'use strict';
/*
 * `agent-office doctor [--json] [--lang fr|en] [--url <public URL>] [--api-base <path>] [--env-file <file>]
 *                      [--config <file>] [--data <dir>] [--timeout <ms>] [--skip-runtime]`
 * Exit: 0 all ok, 1 a warning, 2 a failure, 64 a usage error. Never prints a value (src/ops/doctor/index.js).
 */
const { runDoctor, renderText, renderJson, secretValues, secretFileValues, scrub } = require('./index');

const USAGE = 'usage: agent-office doctor [--json] [--lang fr|en] [--url <public URL>] [--api-base <path>] [--env-file <file>] [--config <file>] [--data <dir>] [--timeout <ms>] [--skip-runtime]';
const VALUED = ['--lang', '--url', '--api-base', '--env-file', '--config', '--data', '--timeout'];

function parse(args) {
  const o = { json: false, skipRuntime: false, help: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--json') o.json = true;
    else if (a === '--skip-runtime') o.skipRuntime = true;
    else if (a === '--help' || a === '-h') o.help = true;
    else if (VALUED.includes(a)) {
      const v = args[++i];
      // --api-base '' is meaningful (the API at the root)
      if (v === undefined || (v.startsWith('-') && a !== '--api-base')) throw new Error(`missing value for ${a}`);
      o[a.slice(2).replace(/-(\w)/g, (m, c) => c.toUpperCase())] = v;
    // R32-03 / R33: never echo an argument VALUE (it may be a pasted credential). An unknown option keeps only its name
    // (before any '='), shown later only if it is a plain name that contains no configured secret; anything else: position
    } else if (a.startsWith('-')) throw Object.assign(new Error(`unknown option #${i + 1}`), { optionName: a.split('=')[0] });
    else throw new Error(`unknown argument #${i + 1}`);
  }
  if (o.lang && !['fr', 'en'].includes(o.lang)) throw new Error('--lang is fr or en');
  if (o.timeout !== undefined && !/^\d{3,6}$/.test(o.timeout)) throw new Error('--timeout is a number of milliseconds (100 to 999999)');
  if (o.url !== undefined && !/^https?:\/\/[^\s]+$/i.test(o.url)) throw new Error('--url is an http(s) URL');
  return o;
}

// R32-03: lines the env-file loader skips, reported by line number and key name only (never a value)
function envFileLint(file) {
  let text; try { text = require('fs').readFileSync(file, 'utf8'); } catch (_) { return []; }
  const out = [];
  text.split('\n').forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;
    const body = line.startsWith('export ') ? line.slice(7).trim() : line;
    const eq = body.indexOf('=');
    const key = eq > 0 ? body.slice(0, eq).trim() : null;
    if (key && /^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return;
    out.push({ line: i + 1, key: key && /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(key) ? key : null });
  });
  return out;
}

async function run(args, env = process.env, io = {}, deps = {}) {
  const out = io.out || ((m) => process.stdout.write(m)), err = io.err || ((m) => process.stderr.write(m));
  // the secrets this machine is configured with (env, instance secrets file): never in any line we print
  const secrets = () => [...new Set(secretValues(env, null).concat(secretFileValues(env)))].sort((a, b) => b.length - a.length);
  let o;
  try { o = parse(args); } catch (e) {
    const s = secrets();
    const n = e.optionName;
    const named = n && /^--?[a-z][a-z-]{0,24}$/.test(n) && !s.some((x) => n.includes(x) || x.includes(n.replace(/^-+/, ''))) ? ` (${n})` : '';
    err(scrub(`agent-office doctor: ${e.message}${named}\n${USAGE}\n`, s)); return 64;
  }
  if (o.help) { out(USAGE + '\n'); return 0; }
  let e2 = env, envFileIssues = [];
  if (o.envFile) {
    try { e2 = deps.loadEnvFile(o.envFile, env); } catch (e) { err(`agent-office doctor: ${e.message}\n`); return 64; }
    envFileIssues = envFileLint(o.envFile);
  }
  const report = await runDoctor({ env: e2, envFileIssues, url: o.url, apiBase: o.apiBase, locale: o.lang, skipRuntime: o.skipRuntime,
    timeoutMs: o.timeout ? Number(o.timeout) : undefined, dataDir: o.data, configFile: o.config, fetchImpl: deps.fetchImpl, now: deps.now });
  out(o.json ? renderJson(report) : renderText(report));
  return report.exitCode;
}

module.exports = { run, parse, USAGE };
