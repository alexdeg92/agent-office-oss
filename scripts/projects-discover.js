#!/usr/bin/env node
'use strict';
/**
 * READ-ONLY dry run. Prints candidate projects and writes nothing:
 * no store, no import, no files, no gateway.
 *
 *   node scripts/projects-discover.js --owner alexdeg92 --root /abs/workspace [--sessions groups.json]
 *
 * stdout: JSON { generatedAt, candidates }
 * stderr: a French table
 *
 * Both --owner and --root are required. Missing either prints usage and
 * exits before any gh or git call. Session groups come only from --sessions
 * (a JSON file of canonical groups). This script never contacts the gateway.
 */

const fs = require('node:fs');
const { execFile } = require('node:child_process');
const { proposeCandidates, collectGithubRepos, collectWorkspaceFolders, formatTable, confidenceText } = require('../src/projects/discovery');
const { scrubGitEnv, stripRemoteCredentials } = require('../src/projects/sources/refs');

const USAGE = `Usage : node scripts/projects-discover.js --owner <github> --root <dossier> [--sessions <fichier.json>]

Lecture seule. N’écrit rien. Ne contacte pas la passerelle.
stdout : JSON des candidats. stderr : tableau en français.
`;

function parseArgs(argv) {
  const out = { owner: null, root: null, sessions: null, ignoreNames: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === '--owner' && next) { out.owner = next; i++; }
    else if (arg === '--root' && next) { out.root = next; i++; }
    else if (arg === '--sessions' && next) { out.sessions = next; i++; }
    else if (arg === '--ignore' && next != null) {
      out.ignoreNames = next.split(',').map((name) => name.trim()).filter(Boolean);
      i++;
    }
    else if (arg === '--help' || arg === '-h') out.help = true;
    else throw new Error(`Argument inconnu : ${arg}`);
  }
  return out;
}

function liveExec(argv, env) {
  return new Promise((resolve) => {
    execFile(argv[0], argv.slice(1), { timeout: 20000, maxBuffer: 4 * 1024 * 1024, env: scrubGitEnv(env) }, (err, stdout, stderr) => {
      resolve({ code: err && typeof err.code === 'number' ? err.code : (err ? 1 : 0), stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

function readSessionGroups(file) {
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(parsed)) throw new Error('Le fichier de sessions doit être un tableau JSON.');
  return parsed;
}

async function discoverCli({ owner, root, sessionGroups = [], ignoreNames, exec, listDirs, now = Date.now() }) {
  const github = await collectGithubRepos({ exec, owner });
  const workspaces = await collectWorkspaceFolders({ root, exec, listDirs, ignoreNames });
  const candidates = proposeCandidates({ now, github, workspaces, sessionGroups, owners: [owner], ignoreNames });
  return { generatedAt: now, candidates };
}

async function main(argv, io = process) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    io.stderr.write(`${err.message}\n${USAGE}`);
    return 1;
  }
  if (args.help || !args.owner || !args.root) {
    io.stderr.write(USAGE);
    return args.help ? 0 : 1;
  }
  let sessionGroups = [];
  if (args.sessions) {
    try {
      sessionGroups = readSessionGroups(args.sessions);
    } catch (err) {
      io.stderr.write(`Sessions illisibles.\n`);
      return 1;
    }
  }
  try {
    const result = await discoverCli({
      owner: args.owner,
      root: args.root,
      sessionGroups,
      ignoreNames: args.ignoreNames,
      exec: liveExec,
      now: Date.now(),
    });
    const printed = {
      generatedAt: result.generatedAt,
      candidates: result.candidates.map((candidate) => ({
        ...candidate,
        confidence: confidenceText(candidate.confidence),
      })),
    };
    io.stderr.write(stripRemoteCredentials(formatTable(result.candidates)));
    io.stdout.write(`${stripRemoteCredentials(JSON.stringify(printed, null, 2))}\n`);
    return 0;
  } catch (err) {
    io.stderr.write(`${stripRemoteCredentials(err.message || 'Découverte impossible.')}\n`);
    return 1;
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}

module.exports = { parseArgs, discoverCli, main, USAGE };
