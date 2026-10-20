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
const JSON_LOG_PREFIX = /^\[[a-z0-9/_.-]+\](?:\s|$)/;
const OPENCLAW_VERSION_BANNER = /^🦞 OpenClaw \d{4}\.\d{1,2}\.\d+(?:[-+][A-Za-z0-9.-]+)?$/;

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

  // OpenClaw can write its version banner and colored logger lines to stdout
  // around its --json result. Strip SGR color codes, then accept only those
  // known prefixes around exactly one complete JSON object. Arbitrary text
  // and extra JSON documents remain ambiguous and fail closed.
  function parseJson(out) {
    const text = String(out || '').replace(/\x1b\[[0-9;]*m/g, '');
    let offset=0,bannerSeen=false;
    while(offset<text.length){
      const lineEnd=text.indexOf('\n',offset),end=lineEnd<0?text.length:lineEnd;
      const line=text.slice(offset,end).replace(/\r$/,'');
      if(!line.trim()){if(lineEnd<0)break;offset=lineEnd+1;continue;}
      // OpenClaw adds logger subsystems over time, so accept only the bounded
      // logger-tag grammar here rather than pinning a brittle tag inventory.
      // Ordinary text and malformed tags are never skipped.
      if(JSON_LOG_PREFIX.test(line)){if(lineEnd<0)break;offset=lineEnd+1;continue;}
      if(!bannerSeen&&OPENCLAW_VERSION_BANNER.test(line)){bannerSeen=true;if(lineEnd<0)break;offset=lineEnd+1;continue;}
      const leading=line.match(/^\s*/)?.[0].length||0,start=offset+leading,first=text[start];
      if(first!=='{'&&first!=='[')return null;
      let depth=0,inString=false,escaped=false,docEnd=-1;
      for(let i=start;i<text.length;i++){
        const char=text[i];
        if(inString){if(escaped)escaped=false;else if(char==='\\')escaped=true;else if(char==='"')inString=false;continue;}
        if(char==='"'){inString=true;continue;}
        if(char==='{'||char==='[')depth++;
        else if(char==='}'||char===']'){depth--;if(depth===0){docEnd=i+1;break;}if(depth<0)break;}
      }
      if(docEnd<=start)return null;
      let value;try{value=JSON.parse(text.slice(start,docEnd));}catch{return null;}
      const suffix = text.slice(docEnd);
      if(!value||typeof value!=='object'||Array.isArray(value)||!suffix.split(/\r?\n/).every((line) => !line.trim() || JSON_LOG_PREFIX.test(line)))return null;
      return value;
    }
    return null;
  }

  return { run, parseJson, isRead };
}

module.exports = { createCli, MAX_ACTIVE, RESERVED_FRESHNESS };
