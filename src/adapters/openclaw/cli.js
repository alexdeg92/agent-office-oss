'use strict';
/*
 * The one wrapper around the `openclaw` CLI.
 * - Read commands (skills list/info, --version) remain allowed in read-only mode.
 * - Four active children at most; foreground callers leave one slot for freshness reads.
 * - Everything else mutates OpenClaw and is refused when the instance is read-only (PORTAL_READONLY=1).
 *   This is the real guard; the Express middleware in src/api/http.js is only a backstop.
 * - Per-agent commands (`skills list`, `skills info`) must pass --agent (CLAUDE.md gotcha); the
 *   wrapper refuses them otherwise instead of letting the CLI return {ok:false} silently.
 */
const childProcess = require('child_process');
const { READONLY_MESSAGE } = require('../../config');

// architect-56: `agents list` and `approvals get` are reads too (the project-tag installer and doctor)
const READ_COMMANDS = [['skills', 'list'], ['skills', 'info'], ['--version'], ['agents', 'list'], ['approvals', 'get']];
const PER_AGENT = [['skills', 'list'], ['skills', 'info']];
const startsWith = (args, prefix) => prefix.every((p, i) => args[i] === p);
const MAX_ACTIVE = 4;
const RESERVED_FRESHNESS = 1;

function createCli({ bin, home, readonly, maxActive = MAX_ACTIVE, reservedFreshness = RESERVED_FRESHNESS, env = process.env }) {
  if (!Number.isInteger(maxActive) || maxActive < 2 || !Number.isInteger(reservedFreshness) || reservedFreshness < 1 || reservedFreshness >= maxActive) throw Error('invalid CLI admission limits');
  const isRead = (args) => READ_COMMANDS.some((p) => startsWith(args, p));
  let active = 0, foreground = 0;

  // → { ok, out, err } (same shape the routes used before S1)
  function run(args, timeoutMs, { signal, freshness = false } = {}) {
    if (readonly && !isRead(args)) return Promise.resolve({ ok: false, out: '', err: READONLY_MESSAGE, refused: 'readonly' });
    if (PER_AGENT.some((p) => startsWith(args, p)) && !args.includes('--agent')) {
      return Promise.resolve({ ok: false, out: '', err: 'openclaw ' + args.slice(0, 2).join(' ') + ' requires --agent', refused: 'missing-agent' });
    }
    if (signal?.aborted) return Promise.resolve({ ok: false, out: '', err: 'CLI command cancelled', code: null });
    // Only read commands may use the freshness reservation. No waiting queue:
    // reserve synchronously before execFile can dispatch or re-enter this wrapper.
    const readSlot = freshness && isRead(args);
    if (active >= maxActive || (!readSlot && foreground >= maxActive - reservedFreshness)) {
      return Promise.resolve({ ok: false, out: '', err: 'CLI command budget is busy', refused: 'busy' });
    }
    active++; if (!readSlot) foreground++;
    const release = () => { active--; if (!readSlot) foreground--; };
    return new Promise((resolve) => {
      try {
        const child = childProcess.execFile(bin, args, { timeout: timeoutMs || 60000, maxBuffer: 8 * 1024 * 1024, signal, env: Object.assign({}, env, { HOME: home }) }, (err, stdout, stderr) => {
          // code: process exit code (number), or null when killed by a signal / timeout
          resolve({ ok: !err, out: (stdout || '').toString(), err: (stderr || '').toString(), code: err ? (Number.isInteger(err.code) ? err.code : null) : 0 });
        });
        // Abort can invoke the callback before the child has actually closed.
        // Keep its slot until close, including spawn errors/timeouts/cancellation.
        child.once('close', release);
      } catch (error) { release(); throw error; }
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

module.exports = { createCli, MAX_ACTIVE, RESERVED_FRESHNESS };
