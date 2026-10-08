'use strict';
/*
 * OpenClaw commands (ADR-001 §3 `commands`), through the `openclaw` CLI wrapper (argv arrays; the read-only guard is
 * inside the wrapper). S7c: flows, skills, the gateway restart, and the agent turn.
 * R1-12: values travel as `--opt=value` (one argv element: a value starting with '-' can never become a flag); ids are
 * validated by the caller AND placed after `--` (end of options), so a positional can never be parsed as an option.
 * Every command → { ok: true, … } or { failed: category }; upstream text is never returned.
 */
const { errorCategory } = require('../../engine/redact');

const failure = (r) => ({ failed: r && r.refused ? (r.refused === 'readonly' ? 'readonly' : r.refused) : errorCategory(r && (r.err || r.out)) });

// → { ok: true } | { failed: category } (never the CLI's text)
const outcome = (x) => (x.ok ? { ok: true } : { failed: x.failed });

function bind(cli, { gw = null, restartService = null, readonly = false } = {}) {
  // R15-08: a zero exit is not enough: an explicit JSON refusal ({ok:false}) is a failure too
  const run = async (argv, timeoutMs) => {
    const r = await cli.run(argv, timeoutMs);
    if (!r || !r.ok) return Object.assign({ ok: false }, failure(r));
    const j = cli.parseJson(r.out);
    if (j && j.ok === false) return { ok: false, failed: 'not-ok' };
    return { ok: true, r, json: j };
  };

  return {
    // → { text, meta: { model, provider, tokens, durationMs } | null } or { failed: category }
    async agentTurn({ agentId, text, sessionRef, timeoutMs = 150000, signal }) {
      const argv = ['agent', '--message=' + String(text), '--agent=' + String(agentId), '--json', '--timeout=' + String(Math.ceil(timeoutMs / 1000))];
      if (sessionRef) argv.push('--session-key=' + String(sessionRef));
      const r = await cli.run(argv, timeoutMs + 20000, { signal });
      // R13-06: a failed, refused or timed-out process is a failure whatever it printed; then the envelope must be a reply
      if (!r || r.refused) return { failed: r && r.refused === 'readonly' ? 'readonly' : (r && r.refused) || 'error' };
      if (!r.ok) return { failed: r.code == null ? 'killed-or-timeout' : 'exit-' + Math.min(255, Math.max(0, r.code)) };
      const j = cli.parseJson(r.out);
      if (!j || typeof j !== 'object') return { failed: 'invalid-output' };
      if (j.ok === false) return { failed: 'not-ok' };
      const res = j.result && typeof j.result === 'object' ? j.result : null;
      if (!res || !Array.isArray(res.payloads)) return { failed: 'invalid-output' };
      const payloads = res.payloads;
      const am = res.meta && res.meta.agentMeta;
      const meta = am ? { model: typeof am.model === 'string' ? am.model : null, provider: typeof am.provider === 'string' ? am.provider : null,
        tokens: am.usage && Number.isInteger(am.usage.total) ? am.usage.total : null,
        durationMs: res.meta && Number.isInteger(res.meta.durationMs) ? res.meta.durationMs : null } : null;
      const files = payloads.flatMap((p) => p ? [p.mediaUrl, ...(Array.isArray(p.mediaUrls) ? p.mediaUrls : [])] : []).filter((v) => typeof v === 'string');
      return { files, text: payloads.map((p) => p && p.text).filter(Boolean).join('\n').trim(), meta };
    },

    // Create is fixed to one agent and an isolated session (R3-11); the caller passes the primary agent.
    async flowCreate({ name, cron, tz, message, agentId }) {
      const x = await run(['cron', 'add', '--name=' + name, '--cron=' + cron, '--tz=' + tz, '--message=' + message, '--agent=' + agentId, '--session=isolated', '--json'], 60000);
      if (!x.ok) return { failed: x.failed };
      const j = x.json;   // --json: the reply must be a JSON acknowledgement
      if (!j || typeof j !== 'object') return { failed: 'invalid-output' };
      const id = j.id || j.jobId || (j.job && j.job.id);
      return { ok: true, jobId: typeof id === 'string' ? id : null };
    },
    async flowEdit(jobId, { name, cron, tz, message }) {
      const argv = ['cron', 'edit'];
      if (name !== undefined) argv.push('--name=' + name);
      if (cron !== undefined) argv.push('--cron=' + cron);
      if (tz !== undefined) argv.push('--tz=' + tz);
      if (message !== undefined) argv.push('--message=' + message);
      argv.push('--', jobId);
      return run(argv, 60000).then(outcome);
    },
    flowSetEnabled: (jobId, enabled) => run(['cron', enabled ? 'enable' : 'disable', '--', jobId], 60000).then(outcome),
    flowRun: (jobId) => run(['cron', 'run', '--', jobId], 60000).then(outcome),
    flowDelete: (jobId) => run(['cron', 'rm', '--json', '--', jobId], 60000).then(outcome),
    // The toggle takes effect after a gateway restart (needsRestart).
    skillSetEnabled: (name, enabled) => run(['config', 'set', 'skills.entries.' + name + '.enabled', enabled ? 'true' : 'false'], 60000).then(outcome),

    // The gateway restart: the gateway's own RPC first, else the service manager (when one is configured).
    async restartGateway() {
      // R15-02: the write policy holds at the adapter boundary too (RPC and service writes, not only the CLI's)
      if (readonly) return { failed: 'readonly' };
      if (gw) { try { await gw.call('gateway.restart.request', { reason: 'portal' }); return { ok: true, via: 'rpc' }; } catch (_) { /* fall through */ } }
      if (!restartService) return { failed: 'unavailable' };
      const r = await restartService();
      return r.ok ? { ok: true, via: 'systemctl' } : { failed: 'error' };
    },
  };
}

module.exports = { bind };
