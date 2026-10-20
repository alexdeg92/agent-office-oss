'use strict';
/*
 * OpenClaw commands (ADR-001 §3 `commands`), through the `openclaw` CLI wrapper (argv arrays; the read-only guard is
 * inside the wrapper). S7c: flows, skills, the gateway restart, and the agent turn.
 * R1-12: values travel as `--opt=value` (one argv element: a value starting with '-' can never become a flag); ids are
 * validated by the caller AND placed after `--` (end of options), so a positional can never be parsed as an option.
 * Every command → { ok: true, … } or { failed: category }; upstream text is never returned.
 */
const { errorCategory } = require('../../engine/redact');
const { checkDispatchAuthority } = require('../../security/dispatch-context');
const crypto = require('node:crypto');

const failure = (r) => ({ failed: r && r.refused ? (r.refused === 'readonly' ? 'readonly' : r.refused) : errorCategory(r && (r.err || r.out)) });

// → { ok: true } | { failed: category } (never the CLI's text)
const outcome = (x) => (x.ok ? { ok: true } : { failed: x.failed });

function restartableUrl(value) {
  if (value == null) return false;
  try { const u=new URL(value); return ['ws:','wss:'].includes(u.protocol) && ['localhost','127.0.0.1','[::1]'].includes(u.hostname) && !u.username && !u.password; } catch { return false; }
}
function bind(cli, { gw = null, readonly = false, gatewayUrl = null, chatSendRpc = null, log = (message) => console.log(message) } = {}) {
  // R15-08: a zero exit is not enough: an explicit JSON refusal ({ok:false}) is a failure too
  const run = async (argv, timeoutMs) => {
    const r = await cli.run(argv, timeoutMs);
    if (!r || !r.ok) return Object.assign({ ok: false }, failure(r));
    const j = cli.parseJson(r.out);
    if (j && j.ok === false) return { ok: false, failed: 'not-ok' };
    return { ok: true, r, json: j };
  };

  const pinWebchatPolicy = async (key, agentId, timeoutMs, signal) => {
    if (typeof key !== 'string' || !key || !key.toLowerCase().startsWith('agent:' + String(agentId).toLowerCase() + ':') || /[\r\n]/.test(key)) return { failed: 'invalid-session' };
    if (readonly) return { failed: 'readonly' };
    const fencedKey=key.toLowerCase();
    const policy=await cli.run(['gateway','call','sessions.patch','--params='+JSON.stringify({key:fencedKey,sendPolicy:'deny'}),'--json'],Math.min(timeoutMs,15000),{signal});
    if(!policy?.ok||policy.refused)return failure(policy);
    const receipt=cli.parseJson(policy.out);
    if(receipt?.ok===true&&receipt.key===fencedKey&&receipt.entry?.sendPolicy==='deny')return {ok:true};
    const output=String(policy.out||''),lines=output.split(/\r?\n/);let offset=0,jsonOffset=null;
    for(const line of lines){const trimmed=line.trimStart();if(trimmed.startsWith('{')){jsonOffset=offset+line.length-trimmed.length;break;}offset+=line.length+1;}
    const sendPolicy=receipt?.entry?.sendPolicy;
    try{log('[openclaw] '+JSON.stringify({event:'chat.delivery_policy_unconfirmed',policyOk:policy.ok===true,
      refused:policy.refused==='readonly'||policy.refused==='busy'?policy.refused:(policy.refused?'other':null),outLength:output.length,
      parseOk:!!receipt,receiptOk:receipt?.ok===true,keyType:typeof receipt?.key,keyMatchesExpected:receipt?.key===fencedKey,
      hasEntry:!!receipt?.entry&&typeof receipt.entry==='object',entrySendPolicy:sendPolicy==='deny'||sendPolicy==='allow'?sendPolicy:(sendPolicy==null?'absent':'other'),
      firstNonJsonPrefixLength:jsonOffset}));}catch{}
    return {failed:'delivery-policy-unconfirmed'};
  };

  return {
    // Discuter uses OpenClaw's stored chat protocol. The adapter supplies a
    // short-lived operator.write socket, separate from the read-only ingest socket.
    async chatSend({ sessionKey, agentId, sessionId, message, idempotencyKey, expectedLeafEntryId, attachments = [], timeoutMs = 12000 }) {
      if (readonly) return { failed: 'readonly' };
      if (typeof sessionKey !== 'string' || !sessionKey || typeof agentId !== 'string' || !agentId ||
          typeof message !== 'string' || typeof idempotencyKey !== 'string' || !idempotencyKey||!Array.isArray(attachments)||attachments.length>5) return { failed: 'invalid-request' };
      if(!sessionKey.toLowerCase().startsWith('agent:'+agentId.toLowerCase()+':')||/[\r\n]/.test(sessionKey))return {failed:'invalid-session'};
      const protocolAttachments=[];
      for(const attachment of attachments){
        if(!attachment||!Buffer.isBuffer(attachment.content)||attachment.content.length<1||attachment.content.length>20*1024*1024||attachment.size!==attachment.content.length||
            typeof attachment.name!=='string'||!attachment.name||attachment.name.length>120||/[\u0000-\u001f\u007f/\\]/.test(attachment.name)||
            !['application/pdf','text/plain','image/png','image/jpeg','image/gif','image/webp'].includes(attachment.mimeType)||
            typeof attachment.sha256!=='string'||!/^([a-f0-9]{64})$/.test(attachment.sha256)||crypto.createHash('sha256').update(attachment.content).digest('hex')!==attachment.sha256)
          return {failed:'invalid-attachment'};
        protocolAttachments.push({fileName:attachment.name,mimeType:attachment.mimeType,content:attachment.content.toString('base64'),sizeBytes:attachment.size,origin:'file'});
      }
      const params = { sessionKey, agentId, ...(typeof sessionId === 'string' && sessionId ? { sessionId } : {}),
        message, idempotencyKey, ...(expectedLeafEntryId === null || typeof expectedLeafEntryId === 'string' ? { expectedLeafEntryId } : {}),...(protocolAttachments.length?{attachments:protocolAttachments}:{}) };
      // sessions.patch(sendPolicy) needs operator.admin, which the short-lived
      // write socket deliberately lacks; the CLI owns that paired authority.
      const policy=await pinWebchatPolicy(sessionKey,agentId,timeoutMs);
      if(policy.failed)return policy;
      let payload;
      if(chatSendRpc){try{checkDispatchAuthority();payload=await chatSendRpc('chat.send',params,timeoutMs);}catch{return {failed:'dispatch-failed'};}}
      else{
        const args = ['gateway', 'call', 'chat.send', '--params=' + JSON.stringify(params), '--json', '--timeout=' + String(Math.max(1000, Math.min(30000, timeoutMs)))];
        if (gatewayUrl) args.push('--expect-url=' + gatewayUrl);
        try{checkDispatchAuthority();}catch{return {failed:'dispatch-failed'};}
        const result = await cli.run(args, Math.max(15000, timeoutMs + 3000));
        if (!result?.ok || result.refused) return failure(result);
        payload = cli.parseJson(result.out);
      }
      if (!payload || typeof payload !== 'object' || Array.isArray(payload) || payload.ok === false) return { failed: 'invalid-output' };
      // A successful Gateway response is an admission receipt, not a reply.
      return { ok: true, receipt: payload };
    },

    // → { text, meta: { model, provider, tokens, durationMs } | null } or { failed: category }
    async agentTurn({ agentId, text, sessionRef, timeoutMs = 150000, signal, canDispatch }) {
      if (!/^[a-zA-Z0-9_-]{1,80}$/.test(String(agentId))) return { failed: 'invalid-agent' };
      const ref = sessionRef ? String(sessionRef) : 'agent:' + agentId + ':ao-internal';
      // OpenClaw canonicalizes agent session keys to lowercase. Keep the same
      // canonical key for the policy fence and the subsequent agent request.
      const key = (ref.startsWith('agent:') ? ref : 'agent:' + agentId + ':explicit:' + ref).toLowerCase();
      if (!key.startsWith('agent:' + String(agentId).toLowerCase() + ':') || /[\r\n]/.test(key)) return { failed: 'invalid-session' };
      if (readonly) return { failed: 'readonly' };
      // Persistent session policy also fences recovery of old AO sessions which
      // already inherited an external route. Refuse dispatch without its receipt.
      const policy = await pinWebchatPolicy(key,agentId,timeoutMs,signal);
      if(policy.failed)return policy;
      if (signal?.aborted) return { failed: 'killed-or-timeout' };
      if (canDispatch && !canDispatch()) return { failed: 'wrong-runtime' };
      // AO owns these replies. An omitted channel can inherit the owner's last
      // route when OpenClaw resumes an interrupted turn. Pin both ingress and
      // reply routing to OpenClaw's supported internal, transcript-only channel.
      const argv = ['agent', '--message=' + String(text), '--agent=' + String(agentId), '--json', '--timeout=' + String(Math.ceil(timeoutMs / 1000)), '--channel=webchat', '--reply-channel=webchat'];
      // Use the exact fenced key, avoiding implicit aliases/default-agent routing.
      argv.push('--session-key=' + key);
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

    // Restart only the bound local gateway through its RPC. No service binding is declared.
    async restartGateway() {
      // R15-02: the write policy holds at the adapter boundary too (RPC and service writes, not only the CLI's)
      if (readonly) return { failed: 'readonly' };
      if (gatewayUrl !== null && !restartableUrl(gatewayUrl)) return {failed:'unavailable'};
      if (gw) { try {
        const reply=await gw.call('gateway.restart.request', {reason:'portal'});
        if(reply?.ok===false)return {failed:'unavailable'};
        return {ok:true,via:'rpc'};
      } catch { /* the selected gateway refused or is unavailable */ } }
      // No host-manager fallback, including after a delayed RPC rejection.
      return {failed:'unavailable'};
    },
  };
}

module.exports = { bind, restartableUrl };
