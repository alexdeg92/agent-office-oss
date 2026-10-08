'use strict';
/*
 * The one wrapper around the `openclaw` CLI.
 * - Read commands (skills list/info, --version) always run.
 * - Everything else mutates OpenClaw and is refused when the instance is read-only (PORTAL_READONLY=1).
 *   This is the real guard; the Express middleware in src/api/http.js is only a backstop.
 * - Per-agent commands (`skills list`, `skills info`) must pass --agent (CLAUDE.md gotcha); the
 *   wrapper refuses them otherwise instead of letting the CLI return {ok:false} silently.
 */
const { execFile } = require('child_process');
const { READONLY_MESSAGE } = require('../../config');

// architect-56: `agents list` and `approvals get` are reads too (the project-tag installer and doctor)
const READ_COMMANDS = [['skills', 'list'], ['skills', 'info'], ['--version'], ['agents', 'list'], ['approvals', 'get']];
const PER_AGENT = [['skills', 'list'], ['skills', 'info']];
const startsWith = (args, prefix) => prefix.every((p, i) => args[i] === p);

function createCli({ bin, home, readonly }) {
  const isRead = (args) => READ_COMMANDS.some((p) => startsWith(args, p));

  // → { ok, out, err } (same shape the routes used before S1)
  function run(args, timeoutMs, { signal } = {}) {
    if (readonly && !isRead(args)) return Promise.resolve({ ok: false, out: '', err: READONLY_MESSAGE, refused: 'readonly' });
    if (PER_AGENT.some((p) => startsWith(args, p)) && !args.includes('--agent')) {
      return Promise.resolve({ ok: false, out: '', err: 'openclaw ' + args.slice(0, 2).join(' ') + ' requires --agent', refused: 'missing-agent' });
    }
    return new Promise((resolve) => {
      execFile(bin, args, { timeout: timeoutMs || 60000, maxBuffer: 8 * 1024 * 1024, signal, env: Object.assign({}, process.env, { HOME: home }) }, (err, stdout, stderr) => {
        // code: process exit code (number), or null when killed by a signal / timeout
        resolve({ ok: !err, out: (stdout || '').toString(), err: (stderr || '').toString(), code: err ? (Number.isInteger(err.code) ? err.code : null) : 0 });
      });
    });
  }

  // Most CLI commands print text before the JSON: parse from the first '{'. → object | null
  function parseJson(out) {
    const i = (out || '').indexOf('{');
    if (i < 0) return null;
    try { return JSON.parse(out.slice(i)); } catch (_) { return null; }
  }

  return { run, parseJson, isRead };
}

module.exports = { createCli };
