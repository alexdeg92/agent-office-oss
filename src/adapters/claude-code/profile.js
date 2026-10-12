'use strict';
// A tolerant, bounded reader for the observed Claude Code JSONL profile. Claude
// adds record types and metadata over time, so unrecognised structure is counted
// and ignored without copying its values into diagnostics or logs.
const { createHash } = require('node:crypto');
const path = require('node:path');
const { nameOf, participantsOf } = require('../../engine/model/sender');
const PROFILE = 'claude-jsonl-observed-v1';
const { redactText } = require('../../security/redact-text');
const MAX_BLOCKS = 256, MAX_TEXT = 32768;
const SUBAGENT_TOOLS = new Set(['Task', 'Agent']);   // T-0062: the sub-agent tool's names across versions
const NON_SESSION_TYPES = new Set(['attachment', 'mode', 'permission-mode', 'atis-latch', 'last-prompt', 'ai-title',
  'queue-operation', 'progress', 'summary', 'file-history-snapshot']);
const TOP_KEYS = new Set(['type','title','sessionId','session_id','timestamp','parentUuid','isSidechain','uuid','userType','entrypoint',
  'cwd','version','gitBranch','message','apiBlockIndex','requestId','advisorModel','effort','perTurnEffort','attachment',
  'rendered','renderedRole','promptId','wireToolInputs','toolUseResult','sourceToolAssistantUUID','thinkingDurationMs',
  'permissionMode','mode','atis','lastPrompt','isMeta','isCompactSummary','agentId','subtype']);
const MESSAGE_KEYS = new Set(['role','content','model','id','type','container','stop_reason','stop_sequence','stop_details',
  'usage','input_transformations','diagnostics','context_management']);
const USAGE_KEYS = new Set(['input_tokens','output_tokens','cache_creation_input_tokens','cache_read_input_tokens',
  'service_tier','server_tool_use','speed']);
const BLOCK_KEYS = new Set(['type','text','thinking','id','name','input','tool_use_id','content','is_error','source','data',
  'mimeType','title','cache_control','citations']);
const unsupported = () => Object.assign(new Error('unsupported transcript format'), { code: 'EFORMAT', reasonCode: 'no-recognizable-session-lines' });
function countExtra(record, known, counters) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return;
  for (const key of Object.keys(record)) if (!known.has(key)) counters.unknownKeys = (counters.unknownKeys || 0) + 1;
}
function skip(counters, type, recognizedType = false) {
  counters.ignoredLines = (counters.ignoredLines || 0) + 1;
  if (recognizedType) counters.metadataLines = (counters.metadataLines || 0) + 1;
  else counters.unknownLineTypes = (counters.unknownLineTypes || 0) + 1;
  return { events: [], at: null, model: null, projectName: null, summary: null, recognized: false };
}
// agent-identity-1: titles and first prompts go through the one shared redactor (security-112)
const safeSummary = (value) => redactText(value);
function malformed(counters) {
  counters.malformedLines = (counters.malformedLines || 0) + 1;
  counters.ignoredLines = (counters.ignoredLines || 0) + 1;
  return { events: [], at: null, model: null, projectName: null, recognized: false };
}
const eventId = (uuid, part) => 'msg:' + createHash('sha256').update(uuid).digest('hex') + ':' + part;
const text = value => typeof value === 'string' ? value.slice(0, MAX_TEXT) : '';
function timestamp(value) {
  const at = typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isSafeInteger(at) && at >= 0 ? at : null;
}
function json(value) { try { return JSON.stringify(value ?? {}); } catch { return ''; } }
// Display metadata only: never open cwd or reconstruct a path from the lossy
// project storage key. Keep the first accepted basename per file generation.
function projectBasename(cwd) {
  if (typeof cwd !== 'string' || cwd.length > 4096 || /[\x00-\x1f\x7f]/.test(cwd)) return null;
  const format = path.posix.isAbsolute(cwd) ? path.posix : path.win32.isAbsolute(cwd) ? path.win32 : null;
  const name = format?.basename(cwd);
  return name && !['.', '..'].includes(name) && name.length <= 255 ? name : null;
}
// sidechainAgent (T-0062): this file is that sub-agent's own transcript (<session>/subagents/agent-<id>.jsonl)
function mapRecord(row, { sessionKey, agentId, fallbackId, runtime = 'claude-code', counters = {}, sidechainAgent = null }) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return skip(counters, null);
  countExtra(row, TOP_KEYS, counters);
  if (row.type === 'ai-title') {
    counters.ignoredLines = (counters.ignoredLines || 0) + 1;
    counters.metadataLines = (counters.metadataLines || 0) + 1;
    return { events: [], at: timestamp(row.timestamp), model: null, projectName: null, summary: safeSummary(row.title), recognized: false };
  }
  if (typeof row.type !== 'string' || !['user', 'assistant', 'system'].includes(row.type))
    return skip(counters, row.type, NON_SESSION_TYPES.has(row.type));
  if (row.message == null || typeof row.message !== 'object' || Array.isArray(row.message)) return malformed(counters);
  const m = row.message; countExtra(m, MESSAGE_KEYS, counters);
  countExtra(m.usage, USAGE_KEYS, counters);
  const sid = row.sessionId ?? row.session_id;
  const at = timestamp(row.timestamp);
  const ownSidechain = !!sidechainAgent && row.agentId === sidechainAgent;
  if (sid != null && (typeof sid !== 'string' || sid !== sessionKey && !ownSidechain) || at === null) return malformed(counters);
  const uuid = row.uuid == null ? fallbackId : row.uuid;
  if (typeof uuid !== 'string' || !uuid || uuid.length > 256 || m.content != null && typeof m.content !== 'string' && !Array.isArray(m.content)) {
    return malformed(counters);
  }
  const content = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content || [];
  if (content.length > MAX_BLOCKS) return malformed(counters);
  const sender = kind => ({ kind, id: kind === 'agent' ? 'agent:' + agentId : kind === 'human' ? 'operator:' + sessionKey : 'system:transcript',
    name: null, runtime, channel: null, avatarHint: null });
  const events = [];
  for (let part = 0; part < content.length; part++) {
    const b = content[part];
    if (!b || typeof b !== 'object' || Array.isArray(b) || typeof b.type !== 'string') {
      counters.unknownContentBlocks = (counters.unknownContentBlocks || 0) + 1; continue;
    }
    countExtra(b, BLOCK_KEYS, counters);
    const id = eventId(uuid, part), common = { id, at, truncated: false };
    if (b.type === 'text' || b.type === 'thinking') {
      const injected = row.type === 'user' && (row.isMeta || row.isCompactSummary || row.isSidechain || row.agentId);
      const kind = b.type === 'thinking' ? 'thinking' : injected ? 'system' : row.type;
      const value = b.type === 'thinking' ? b.thinking : b.text;
      if (typeof value !== 'string') { counters.unknownContentBlocks = (counters.unknownContentBlocks || 0) + 1; continue; }
      events.push({ ...common, kind, text: text(value), truncated: value.length > MAX_TEXT,
        senderInfo: sender(row.type === 'user' ? injected ? 'system' : 'human' : row.type === 'system' ? 'system' : 'agent'),
        ...(kind === 'user' ? { sender: null } : {}), ...(kind === 'assistant' ? { model: nameOf(m.model), provider: null,
          outputTokens: Number.isSafeInteger(m.usage?.output_tokens) && m.usage.output_tokens >= 0 ? m.usage.output_tokens : null,
          stopReason: m.stop_reason === 'end_turn' ? 'stop' : m.stop_reason === 'tool_use' ? 'toolUse' : null, error: null } : {}) });
    } else if (b.type === 'tool_use' && row.type === 'assistant' && typeof b.id === 'string' && b.id.length <= 512 && typeof b.name === 'string') {
      const input = json(b.input);
      events.push({ ...common, kind: 'tool', callId: b.id, name: b.name.slice(0, 128), toolKind: 'other', input: text(input), output: '',
        isError: false, durationMs: null, truncated: input.length > MAX_TEXT,
        senderInfo: { ...sender('tool'), id: 'tool:' + b.id, name: b.name.slice(0, 128) } });
    } else if (b.type === 'tool_result' && row.type === 'user' && typeof b.tool_use_id === 'string') {
      const result = typeof b.content === 'string' ? b.content : Array.isArray(b.content) ? b.content.filter(c => c?.type === 'text' && typeof c.text === 'string').map(c => {
        countExtra(c, BLOCK_KEYS, counters); return c.text;
      }).join('\n') : '';
      if (Array.isArray(b.content)) for (const child of b.content) if (child?.type && child.type !== 'text') counters.unknownContentBlocks = (counters.unknownContentBlocks || 0) + 1;
      events.push({ resultFor: b.tool_use_id, output: text(result), isError: b.is_error === true, truncated: result.length > MAX_TEXT });
    } else counters.unknownContentBlocks = (counters.unknownContentBlocks || 0) + 1;
  }
  counters.recognizedLines = (counters.recognizedLines || 0) + 1;
  const firstPrompt = row.type === 'user' && (!row.isSidechain || sidechainAgent) ? content.find(b => b?.type === 'text' && typeof b.text === 'string')?.text : null;
  // T-0062: a sub-agent tool call (its description) and its result (the spawned agent id, when the runtime records it)
  const spawns = [];
  if (row.type === 'assistant') for (const b of content) if (b?.type === 'tool_use' && SUBAGENT_TOOLS.has(b.name) && typeof b.id === 'string' && b.id.length <= 512)
    spawns.push({ callId: b.id, description: safeSummary(typeof b.input?.description === 'string' ? b.input.description : null) });
  const spawned = row.toolUseResult && typeof row.toolUseResult === 'object' ? row.toolUseResult.agentId : null;
  if (row.type === 'user' && typeof spawned === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(spawned)) for (const b of content) if (b?.type === 'tool_result' && typeof b.tool_use_id === 'string' && b.tool_use_id.length <= 512)
    spawns.push({ callId: b.tool_use_id, agentId: spawned });
  let execution = null;
  if (row.type === 'user' && !row.isMeta && !row.isCompactSummary && !row.isSidechain && !row.agentId) execution = { status: 'running', at };
  else if (row.type === 'assistant') {
    const openTool = content.some(b => b?.type === 'tool_use');
    if (m.stop_reason === 'end_turn' || m.stop_reason === 'stop_sequence') execution = { status: 'idle', at };
    else if (m.stop_reason === 'tool_use' || openTool || m.stop_reason == null) execution = { status: 'running', at };
    else execution = { status: 'idle', at };
  }
  return { events, at, model: nameOf(m.model), projectName: projectBasename(row.cwd), summary: safeSummary(firstPrompt), recognized: true,
    ...(execution ? { execution } : {}), ...(spawns.length ? { spawns } : {}) };
}
function mergeRecord(events, record) {
  for (const event of record.events) {
    if (event.resultFor) {
      const call = events.find(e => e.kind === 'tool' && e.callId === event.resultFor);
      if (call) Object.assign(call, { output: event.output, isError: event.isError, truncated: call.truncated || event.truncated });
    } else if (!events.some(e => e.id === event.id)) events.push(event);
  }
  if (events.length > 256) events.splice(0, events.length - 256);
  return events;
}
const transcript = (sessionKey, events, fetchedAt) => ({ sessionKey, fetchedAt, messageCount: events.length,
  window: { from: 0, to: events.length }, events, participants: participantsOf(events) });
module.exports = { PROFILE, mapRecord, mergeRecord, transcript };
