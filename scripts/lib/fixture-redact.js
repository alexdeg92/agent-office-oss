'use strict';
/*
 * Strict redaction for test fixtures captured from the live OpenClaw gateway and CLI.
 *
 * Policy (default deny, R1-02): every string is scrambled or faked unless an ALLOWLIST keeps it;
 * patterns alone never keep a value. Every kept value is recorded for the report.
 *
 *   secret keys        → '[redacted]'
 *   person keys        → scrambled text (names, usernames, labels)
 *   session keys       → grammar words (KEY_WORDS) kept, every other segment faked
 *   id keys            → faked, except protocol ids (PROTOCOL_IDS: 'main', 'default')
 *   enum keys          → kept only as strict lowercase tokens (no spaces, no 5+ digit runs)
 *   names              → OpenClaw tool names (TOOL_NAMES) and PUBLIC skills (bundled/extra) kept;
 *                        custom skills, jobs, agents… faked (slugs) or scrambled
 *   protocol lists     → method/event/capability/scope names kept as strict tokens
 *   cron keys          → expr kept if cron-like; tz kept if an IANA name
 *   object keys        → identifier-shaped names kept; ids faked; anything else hashed
 *   URLs               → allowlisted hosts and route words; every other segment hashed
 *   anything else      → scrambled, keeping whitespace, punctuation, case and short digit runs
 *   epoch-ms numbers   → shifted by a per-capture offset (relative order kept)
 *   token counts       → rounded to the nearest 100
 *
 * Fakes are recognisable so scanLeaks() can tell them from real data:
 *   snowflake → '100000' + digits   uuid → 'ffffffff-…'   email → 'user-<hex>@example.invalid'
 *
 * The mapping raw → fake is keyed by a random per-run salt that is never written anywhere, so the
 * same raw id gets the same fake within one capture (sessions.list and sessions.get stay consistent).
 */
const crypto = require('crypto');

/*
 * PM diagnostics privacy rule (BRIEF, on review-05), fixture side: a field NAME is kept only if a schema
 * declares it; map keys are replaced unless they are protocol vocabulary (channel ids…); a string VALUE is
 * kept only if it belongs to a known enum vocabulary (exact lists below, built from the protocol values
 * seen in the 2026.9.8 captures); anything else becomes a fake.
 */
const DECLARED = require('../../src/engine').declaredFieldNames();
const CHANNEL_IDS = ['discord', 'whatsapp', 'wechat', 'openclaw-weixin', 'webchat'];
const KEY_VOCAB = new Set(CHANNEL_IDS.concat(['default']));
const THINKING = ['low', 'medium', 'high', 'xhigh', 'ultra', 'max', 'off', 'minimal'];
const VOCAB = {
  action: ['finished', 'cancel', 'generate', 'started'],
  actorType: ['human', 'agent', 'system'],
  api: ['openai-chatgpt-responses', 'cli', 'openclaw-transcript', 'openai-responses', 'anthropic-messages'],
  channel: CHANNEL_IDS.concat(['last', 'stable']), lastChannel: CHANNEL_IDS,
  chatType: ['channel', 'direct', 'group'], peerKind: ['channel', 'direct', 'group'],
  classification: ['direct', 'channel', 'subagent', 'heartbeat', 'explicit', 'cron', 'acp', 'main', 'group', 'dashboard'],
  cloudPlacementExecutionMode: ['worker-turn'], controlUiBuildSource: ['bundled'],
  completionStatus: ['succeeded', 'failed', 'skipped'], createdVia: ['spawn', 'run', 'cron', 'channel'],
  defaultPermissionMode: ['full'], deliverySuppressionReason: ['silent'],
  deliveryStatus: ['not-requested', 'not-delivered', 'delivered', 'failed', 'skipped'], lastDeliveryStatus: ['not-requested', 'not-delivered', 'delivered', 'failed', 'skipped'],
  effectiveFastModeSource: ['default', 'session'], effectiveQueueMode: ['steer'], effectiveResponseUsage: ['off'],
  dmPolicy: ['allowlist', 'pairing', 'open', 'disabled'], groupPolicy: ['allowlist', 'pairing', 'open', 'disabled'],
  guildMembers: ['limited', 'enabled', 'disabled'], messageContent: ['limited', 'enabled', 'disabled'], presence: ['limited', 'enabled', 'disabled'],
  healthState: ['stopped', 'idle', 'running', 'healthy', 'degraded'], idKind: ['user', 'channel'],
  kind: ['direct', 'group', 'internal_system', 'inter_session', 'agentTurn', 'cron', 'every', 'at', 'command', 'results', 'brew', 'heartbeat', 'auth',
    'created', 'goal_changed', 'image', 'inline', 'text', 'compaction', 'message', 'main'],
  lastRunStatus: ['ok', 'error', 'skipped'], lastStatus: ['ok', 'error', 'skipped'],
  lifecycle: ['stopped', 'ready', 'running', 'starting', 'stopping'], method: ['token'],
  modelOverrideSource: ['user', 'auto'], modelSelectionTarget: ['session'],
  mode: ['run', 'none', 'trusted', 'announce', 'gateway'], ownership: ['explicit'], phase: ['accepting'],
  provider: ['openai', 'anthropic', 'claude-cli', 'discord', 'openclaw', 'deepseek', 'brave', 'webchat', 'openrouter', 'google', 'xai', 'ollama'],
  modelProvider: ['openai', 'anthropic', 'claude-cli', 'openclaw', 'deepseek', 'openrouter', 'google', 'xai', 'ollama'],
  role: ['assistant', 'user', 'custom', 'operator', 'system', 'toolResult', 'tool'], scope: ['instance', 'per-sender', 'operator.read'],
  senderKind: ['unknown', 'bot', 'user'], sessionTarget: ['isolated', 'main'], severity: ['error', 'warn', 'info'], sharingRole: ['owner'],
  source: ['model', 'openclaw-bundled', 'openai-responses', 'last', 'pre-prompt-estimate', 'openclaw-workspace', 'openclaw-workshop', 'openclaw-extra',
    'web_fetch', 'openclaw-custodian', 'agent-run', 'memory', 'web_search', 'cron-setup', 'config'],
  state: ['local', 'available', 'stale', 'updating', 'unavailable', 'current'],
  status: ['done', 'ok', 'complete', 'failed', 'completed', 'pending', 'accepted', 'active', 'killed', 'timeout', 'error', 'fresh', 'budget_limited',
    'in_progress', 'forbidden', 'started', 'yielded', 'running', 'skipped'],
  statusState: ['not-linked', 'linked'], stopReason: ['stop', 'toolUse', 'error'], subagentRole: ['leaf', 'orchestrator', 'worker'],
  subagentRunState: ['historical', 'running', 'active'], surface: ['discord', 'webchat'],
  thinkingDefault: THINKING, thinkingLevel: THINKING, tokenSource: ['config', 'env'], tokenStatus: ['available', 'missing'],
  type: ['agent', 'observation', 'text', 'thinking', 'toolCall', 'tool_use', 'toolUse', 'human', 'legacy', 'system', 'remote', 'openai_responses_terminal',
    'hello-ok', 'image'],
  visibility: ['shared', 'read-only', 'suggest', 'draft'], wakeMode: ['now', 'next-heartbeat'],
};
const LIST_VOCAB = {
  thinkingOptions: THINKING, allowedSessionVisibilities: VOCAB.visibility, scopes: ['operator.read', 'operator.write', 'operator.admin'],
  channelOrder: CHANNEL_IDS,
  loaded: ['acpx', 'anthropic', 'brave', 'browser', 'canvas', 'codex', 'cua-computer', 'device-pair', 'discord', 'file-transfer', 'geolocation', 'github',
    'google-meet', 'linux-node', 'memory-core', 'ollama', 'openai', 'openclaw-weixin', 'openrouter', 'talk-voice', 'whatsapp', 'xai'],
  events: ['connect.challenge', 'agent', 'chat', 'chat.metadata.changed', 'models.snapshot', 'ui.command', 'session.approval', 'session.message',
    'session.narration', 'session.observer', 'session.operation', 'session.sharing', 'session.sharing.evidence', 'session.suggestion', 'session.typing',
    'session.tool', 'sessions.changed', 'health', 'tick', 'cron', 'presence', 'shutdown'],
  methods: ['health', 'agents.list', 'sessions.list', 'sessions.get', 'sessions.describe', 'sessions.usage', 'sessions.subscribe', 'sessions.messages.subscribe',
    'cron.list', 'cron.runs', 'channels.status', 'channels.start', 'channels.stop', 'logs.tail', 'gateway.restart.request', 'diagnostics.stability'],
};
// Public model ids: known families (optionally provider-prefixed). 'alice-private-model' does not match.
// R6-02: a model id is kept only if it is an EXACT reviewed public identifier (optionally behind known
// provider prefixes). A family-shaped name ('gpt-private-client-merger') is not evidence of being public:
// anything else is faked. Extend this list only after review.
const PUBLIC_MODEL_IDS = new Set(['gpt-5', 'gpt-5.5', 'gpt-5-mini', 'claude-sonnet-5', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-4-5', 'claude-fable-5-1', 'delivery-mirror']);
const MODEL_PROVIDERS = new Set(['openai', 'anthropic', 'google', 'deepseek', 'openrouter', 'moonshotai', 'xai', 'ollama', 'claude-cli']);
const isPublicModel = (s) => { const parts = String(s).split('/'); const id = parts.pop(); return PUBLIC_MODEL_IDS.has(id) && parts.every((p) => MODEL_PROVIDERS.has(p)); };
const MODEL_KEYS = new Set(['model', 'primary', 'responseModel', 'activeModel', 'fallbacks']);
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

const SECRET_KEY_RE = /(token|secret|password|passwd|api_?key|authorization|cookie|credentials?|signature|nonce|private_?key(_?pem)?|public_?key(_?pem)?|key_?pem)$/i;
const PERSON_KEYS = new Set(['username', 'globalName', 'global_name', 'displayName', 'display', 'senderName', 'senderLabel',
  'label', 'author', 'authorName', 'email', 'e164', 'jid', 'lid', 'owner', 'nick', 'nickname', 'title', 'guildName', 'rawName', 'fullName', 'name_full']);
const SESSION_KEY_KEYS = new Set(['key', 'sessionKey', 'primaryKey', 'parentKey', 'parentSessionKey', 'spawnedBy', 'requesterSessionKey', 'childSessionKey', 'session',
  'mainKey', 'controlOwnerSessionKey', 'childSessions']);
const ID_KEY_RE = /^(id|.*Id|.*_id|.*Ids|uid|runId|callId)$/;
const PROTOCOL_IDS = new Set(['main', 'default']);
// Session-key grammar (same vocabulary as the runtime classifier) + the portal's own key.
const KEY_WORDS = new Set(['agent', 'main', 'subagent', 'cron', 'dashboard', 'acp', 'explicit', 'discord', 'whatsapp', 'wechat', 'openclaw-weixin',
  'telegram', 'slack', 'signal', 'direct', 'dm', 'channel', 'group', 'thread', 'slash', 'heartbeat', 'portal-chat']);
// OpenClaw built-in tool names (seen in capture-20261005 + documented built-ins). Anything else is faked.
const TOOL_NAMES = new Set(['exec', 'process', 'read', 'write', 'edit', 'apply_patch', 'web_search', 'web_fetch', 'browser', 'image', 'image_generate',
  'memory_search', 'memory_get', 'message', 'sessions_spawn', 'sessions_send', 'sessions_list', 'sessions_history', 'sessions_yield', 'session_status',
  'subagents', 'progress_card', 'cron', 'gateway', 'canvas', 'nodes', 'tts', 'agents_list']);
const PUBLIC_SKILL_SOURCES = new Set(['openclaw-bundled', 'openclaw-extra']);
const NAME_KEYS = new Set(['name', 'toolName', 'tool', 'skillKey', 'toolsAllow']);
const SKILL_REQ_KEYS = new Set(['bins', 'anyBins', 'env', 'config', 'os', 'missingBins', 'primaryEnv']);
const PROTOCOL_LIST_KEYS = new Set(['methods', 'events', 'capabilities', 'scopes', 'caps', 'channelOrder', 'loaded', 'reasons', 'thinkingOptions',
  'allowedSessionVisibilities', 'fallbacks']);
const ROUTE_WORDS = new Set(['api', 'v9', 'v10', 'avatars', 'icons', 'attachments', 'channels', 'users', 'guilds', 'emojis', 'banners', 'embed', 'repos', 'blob', 'tree', 'raw']);
const FAKE_ID_PREFIXES = new Set(['toolu_', 'call_', 'msg_', 'run_', 'resp_', 'sess_', 'id_']);
// Exactly what fakeId() generates (see hx(): every 8th hex char is a letter).
const FAKE_SHAPE_RE = /^(?:100000\d{11,14}|ffffffff-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}|\+1555\d{7}|(?:toolu|call|msg|run|resp|sess|id)_(?=[0-9a-f]{8,24}$)(?:[a-f][0-9a-f]{0,7}){1,3})$/;
const ENUM_KEYS = new Set(['kind', 'type', 'role', 'status', 'state', 'source', 'lifecycle', 'wakeMode', 'sessionTarget', 'action',
  'deliveryStatus', 'statusState', 'healthState', 'tokenSource', 'tokenStatus', 'dmPolicy', 'groupPolicy', 'policy', 'security',
  'event', 'method', 'mode', 'scheduleKind', 'payloadKind', 'channel', 'platform', 'version', 'model', 'modelProvider', 'provider',
  'stopReason', 'api', 'operation', 'phase', 'stream', 'level', 'scope', 'presence', 'guildMembers', 'messageContent', 'primary',
  // OpenClaw protocol vocabulary seen in the 2026.9.8 capture (classification inputs for S3); values must still look like enums
  'classification', 'peerKind', 'chatType', 'subagentRole', 'subagentRunState', 'visibility', 'createdVia', 'sharingRole', 'surface',
  'lastChannel', 'completionStatus', 'lastRunStatus', 'lastStatus', 'lastDeliveryStatus', 'deliverySuppressionReason', 'effectiveQueueMode',
  'effectiveResponseUsage', 'effectiveFastModeSource', 'thinkingDefault', 'thinkingLevel', 'senderKind', 'idKind', 'defaultPermissionMode',
  'ownership', 'controlUiBuildSource', 'cloudPlacementExecutionMode', 'modelSelectionTarget', 'modelOverrideSource', 'severity',
  'actorType', 'goalStatus', 'deliveryMode']);
// removed from the enum keep list (R1-02): reason, domain, intent, icon, route, emoji, pluginId — free text or identities
const CRON_KEYS = new Set(['expr', 'tz', 'cron', 'timezone']);
const TOKEN_KEY_RE = /tokens?$|Tokens$|_tokens$/;

// A protocol token: lowercase start, no spaces, no 5+ digit run (checked separately).
const TOKEN_RE = /^[a-z][a-zA-Z0-9_./+-]{0,63}$/;   // lowercase start, camelCase allowed (agentTurn, toolCall); no ":" or spaces (R1-02)
const VERSION_RE = /^\d{4}\.\d{1,2}\.\d{1,3}$/;
const SLUG_RE = /^[a-z0-9][a-z0-9_.:/@+-]{0,63}$/;
const IDENT_KEY_RE = /^[A-Za-z_$][A-Za-z0-9_$-]{0,63}$/;
const TZ_RE = /^(UTC|[A-Z][A-Za-z_]+\/[A-Z][A-Za-z_]+(\/[A-Z][A-Za-z_]+)?)$/;
const CRON_RE = /^[0-9*/,\-?LW# A-Za-z_]{1,64}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MS_MIN = 1.4e12, MS_MAX = 2.6e12;
const OPAQUE_RE = /[A-Za-z0-9+/_=-]{32,}/;                 // hashes, base64, tokens embedded anywhere
const MIME_KEYS = ['media_type', 'mediaType', 'mimeType', 'mime_type', 'contentType', 'content_type'];
const URL_HOSTS = new Set(['discord.com', 'cdn.discordapp.com', 'media.discordapp.net', 'github.com', 'api.github.com', 'avatars.githubusercontent.com', 'example.invalid']);
const COST_KEY_RE = /cost/i;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:?\d{2})$/;

const LOREM = ('lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua '
  + 'enim ad minim veniam quis nostrud exercitation ullamco laboris nisi aliquip ex ea commodo consequat duis aute irure in reprehenderit '
  + 'voluptate velit esse cillum fugiat nulla pariatur excepteur sint occaecat cupidatat non proident sunt culpa qui officia deserunt mollit anim id est laborum').split(' ');

class FixtureRedactor {
  constructor(opts = {}) {
    this.salt = opts.salt || crypto.randomBytes(32);
    this.timeShiftMs = opts.timeShiftMs != null ? opts.timeShiftMs : -(30 + crypto.randomInt(335)) * 86400000;
    // Re-redacting input that is ALREADY redacted: values shaped exactly like our own fakes map to
    // themselves, so a second pass keeps ids stable instead of faking fakes.
    this.assumeRedacted = !!opts.assumeRedacted;
    this.ids = new Map();          // raw → fake (never exported)
    this.fakes = new Set();        // every fake id produced, so the final sweep leaves them alone
    this.mime = [];                // media type of the enclosing object, for base64 placeholders
    this.publicCtx = [];           // inside a public (bundled/extra) skill object?
    this.publicNames = new Set();  // public skill names seen so far (kept everywhere they reappear)
    this.report = {
      secretsRemoved: new Map(),   // path → count
      kept: new Map(),             // `${rule}:${key}` → Map(value → count)
      keptKeySegments: new Map(),  // session-key segment → count
      counts: { scrambled: 0, person: 0, idsFaked: 0, sessionKeys: 0, timestampsShifted: 0, tokensRounded: 0, swept: 0, costsRounded: 0, floatsRounded: 0, emails: 0, urls: 0, blobs: 0, hashes: 0 },
    };
  }

  // --- primitives -------------------------------------------------------------------------
  h(s, n = 16) { return crypto.createHmac('sha256', this.salt).update(String(s)).digest('hex').slice(0, n); }
  // Hex for generated fakes: every 8th char is a letter, so a fake never contains a 9+ digit run
  // (otherwise the final sweep could rewrite part of a fake hash or 'id_' fake).
  hx(s, n) { let out = ''; let i = 0; while (out.length < n) out += this.h(s + '#' + i++, 64); return out.slice(0, n).replace(/./g, (c, k) => (k % 8 === 0 && /\d/.test(c) ? 'abcdef'[Number(c) % 6] : c)); }
  hNum(s, len) { let out = ''; let i = 0; while (out.length < len) { out += BigInt('0x' + this.h(s + '#' + i++, 15)).toString(10); } return out.slice(0, len); }

  fakeId(raw) {
    raw = String(raw);
    if (this.ids.has(raw)) return this.ids.get(raw);
    if (this.assumeRedacted && FAKE_SHAPE_RE.test(raw)) { this.ids.set(raw, raw); this.fakes.add(raw); return raw; }
    let fake;
    if (/^\d{17,20}$/.test(raw)) fake = '100000' + this.hNum(raw, raw.length - 6);
    else if (/^\d+$/.test(raw)) fake = this.hNum(raw, raw.length);
    else if (UUID_RE.test(raw)) { const x = this.h(raw, 24); fake = `ffffffff-${x.slice(0, 4)}-4${x.slice(4, 7)}-8${x.slice(7, 10)}-${x.slice(10, 22)}`; }
    else if (/^\+?\d[\d -]{6,}$/.test(raw)) fake = '+1555' + this.hNum(raw, 7);
    else { const m = raw.match(/^([a-z]{1,8}_)/i); const pre = m && FAKE_ID_PREFIXES.has(m[1].toLowerCase()) ? m[1] : 'id_'; fake = pre + this.hx(raw, Math.max(8, Math.min(24, raw.length - pre.length))); }
    this.ids.set(raw, fake);
    this.fakes.add(fake);
    this.report.counts.idsFaked++;
    return fake;
  }

  // Same length, recognisable as fake ('00000000' prefix), optional 'algo:' prefix kept.
  fakeHash(raw) {
    this.report.counts.hashes++;
    const m = String(raw).match(/^([a-z0-9-]{2,12}[:$])?([\s\S]*)$/i);
    const prefix = m[1] || '', body = m[2];
    return prefix + ('00000000' + this.hx(raw, Math.max(body.length - 8, 0))).slice(0, Math.max(body.length, 1));
  }

  // Base64 payloads (images, attachments) → a short placeholder keeping media type and byte length.
  blob(b64, mime) {
    this.report.counts.blobs++;
    const clean = String(b64).replace(/\s+/g, '');
    const pad = (clean.match(/=+$/) || [''])[0].length;
    return `[base64 ${mime || 'application/octet-stream'} ${Math.max(0, Math.floor(clean.length * 3 / 4) - pad)} bytes]`;
  }

  // URLs keep scheme, allowlisted hosts, short route words and file extensions; snowflakes are faked
  // with the shared id map, everything else becomes a short hash. Query strings and fragments are dropped.
  url(raw) {
    this.report.counts.urls++;
    const m = raw.match(/^([a-z][a-z0-9+.-]*):\/\/([^/?#]*)([^?#]*)/i);
    if (!m) return 'https://example.invalid/' + this.h(raw, 8);
    const host = URL_HOSTS.has(m[2].toLowerCase()) ? m[2].toLowerCase() : 'example.invalid';
    const segs = m[3].split('/').map((seg) => {
      if (!seg) return seg;
      const sf = seg.match(/^(\d{17,20})(\.[a-z0-9]{1,5})?$/i);
      if (sf) return this.fakeId(sf[1]) + (sf[2] || '');
      if (ROUTE_WORDS.has(seg)) return seg;
      const ext = (seg.match(/\.[a-z0-9]{1,5}$/i) || [''])[0];
      return this.h(seg, 8) + ext;
    });
    return `${m[1].toLowerCase()}://${host}${segs.join('/')}`;
  }

  scrambleText(s) {
    this.report.counts.scrambled++;
    const saved = [];
    const protect = (v) => { saved.push(v); return '\u0000' + (saved.length - 1) + '\u0000'; };
    const mime = this.mime[this.mime.length - 1];
    s = String(s)
      .replace(/data:([\w.+-]+\/[\w.+-]+)?(?:;[\w=.-]+)*;base64,([A-Za-z0-9+/=\s]*)/g, (m, mt, b64) => protect('data:' + (mt || 'application/octet-stream') + ';base64,' + this.blob(b64, mt)))
      .replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, (m) => { this.report.counts.emails++; return protect('user-' + this.h(m, 6) + '@example.invalid'); })
      .replace(/[a-z][a-z0-9+.-]{1,15}:\/\/[^\s)"'<>\]]+/gi, (m) => protect(this.url(m)))
      .replace(new RegExp('(?:\\b(?:sha1|sha256|sha384|sha512|md5|blake2b|blake3):)?' + OPAQUE_RE.source, 'gi'), (m) => {
        if (!(/\d/.test(m) && /[A-Za-z]/.test(m))) return m;
        if (m.includes('/') && m.split('/').every((seg) => seg.length < 24)) return m;   // a path, not a token
        return protect(m.length >= 200 || mime ? this.blob(m, mime) : this.fakeHash(m));
      })
      .replace(/(?<!\d)\d{17,20}(?!\d)/g, (m) => protect(this.fakes.has(m) ? m : this.fakeId(m)))
      .replace(/\+\d[\d -]{6,}\d/g, (m) => protect('+1555' + this.hNum(m, 7)));
    let n = 0;
    s = s.replace(/(\u0000\d+\u0000)|(\p{L}+)|(\d+)/gu, (m, keep, word, digits) => {
      if (keep) return keep;
      if (digits) return digits.length <= 2 ? digits : this.hNum(digits + ':' + n++, digits.length);
      const base = LOREM[parseInt(this.h(word.toLowerCase(), 6), 16) % LOREM.length];
      let w = base; while (w.length < word.length) w += base; w = w.slice(0, word.length);
      if (word === word.toUpperCase() && word.length > 1) return w.toUpperCase();
      if (word[0] === word[0].toUpperCase() && word[0] !== word[0].toLowerCase()) return w[0].toUpperCase() + w.slice(1);
      return w;
    });
    return s.replace(/\u0000(\d+)\u0000/g, (m, i) => saved[Number(i)]);
  }

  sessionKey(raw) {
    this.report.counts.sessionKeys++;
    return String(raw).split(':').map((seg) => {
      if (seg === '') return seg;
      if (KEY_WORDS.has(seg)) { this.report.keptKeySegments.set(seg, (this.report.keptKeySegments.get(seg) || 0) + 1); return seg; }
      // mixed segments like 'channel-1000000000000000000' keep a grammar-word prefix only
      const m = seg.match(/^([a-z][a-z-]*[a-z])([-_])(\d{5,}|[0-9a-f-]{8,})$/i);
      if (m && KEY_WORDS.has(m[1])) { this.report.keptKeySegments.set(m[1], (this.report.keptKeySegments.get(m[1]) || 0) + 1); return m[1] + m[2] + this.fakeId(m[3]); }
      return this.fakeId(seg);
    }).join(':');
  }

  keep(rule, key, value) {
    const k = rule + ':' + key; let m = this.report.kept.get(k); if (!m) { m = new Map(); this.report.kept.set(k, m); }
    m.set(value, (m.get(value) || 0) + 1);
    return value;
  }

  // --- final sweep ------------------------------------------------------------------------
  // Last pass over EVERY string (values and keys, any depth, embedded JSON, paths, prefixes) and EVERY
  // number: any 17–20 digit run that is not one of our fakes goes through the shared id map. This also
  // catches digit runs that appear by chance inside generated hex (fake hashes, 'id_' fakes).
  sweepString(str) {
    return String(str).replace(/(?<!\d)\d{17,20}(?!\d)/g, (m) => {
      if (this.fakes.has(m)) return m;
      this.report.counts.swept++;
      return this.fakeId(m);
    });
  }
  sweepNumber(n) {
    if (!Number.isFinite(n) || Math.abs(n) < 1e16 || Math.abs(n) >= 1e20) return n;
    const digits = Math.abs(n).toFixed(0);
    if (digits.length < 17 || digits.length > 20) return n;
    this.report.counts.swept++;
    return Math.sign(n) * Number(this.fakeId(digits));
  }
  sweep(v) {
    if (typeof v === 'string') return this.sweepString(v);
    if (typeof v === 'number') return this.sweepNumber(v);
    if (Array.isArray(v)) return v.map((x) => this.sweep(x));
    if (v && typeof v === 'object') { const o = {}; for (const [k, x] of Object.entries(v)) o[this.sweepString(k)] = this.sweep(x); return o; }
    return v;
  }

  // --- tree walk ---------------------------------------------------------------------------
  redact(value, path = '$', key = '') { return this.sweep(this._redact(value, path, key)); }

  _redact(value, path = '$', key = '') {
    if (value === null || typeof value === 'boolean') return value;
    if (typeof value === 'number') return this.number(value, key);
    if (typeof value === 'string') return this.string(value, path, key);
    if (Array.isArray(value)) return value.map((v, i) => this._redact(v, path + '[' + i + ']', key));
    if (typeof value === 'object') {
      const out = {};
      const mk = MIME_KEYS.find((k) => typeof value[k] === 'string' && /^[\w.+-]+\/[\w.+-]+$/.test(value[k]));
      this.mime.push(mk ? value[mk] : this.mime[this.mime.length - 1]);
      const isPublicSkill = Object.prototype.hasOwnProperty.call(value, 'source') && PUBLIC_SKILL_SOURCES.has(value.source);
      if (isPublicSkill && typeof value.name === 'string') this.publicNames.add(value.name);
      this.publicCtx.push(isPublicSkill);
      try {
      for (const [k, v] of Object.entries(value)) {
        const outKey = this.objectKey(k);
        const p = path + '.' + (outKey === k ? k : '<id>');
        // R6-03: a secret field is removed whatever its leaf type (an integer PIN is a secret too).
        if (SECRET_KEY_RE.test(k) && v !== null) {
          this.report.secretsRemoved.set(p, (this.report.secretsRemoved.get(p) || 0) + 1);
          out[outKey] = '[redacted]';
          continue;
        }
        out[outKey] = this._redact(v, p, k);
      }
      } finally { this.mime.pop(); this.publicCtx.pop(); }
      return out;
    }
    return null; // undefined, functions: not JSON
  }

  objectKey(k) {
    if (/^\d{5,}$/.test(k) || UUID_RE.test(k)) return this.fakeId(k);
    if (/@/.test(k)) return 'user-' + this.h(k, 6) + '@example.invalid';
    if (k.startsWith('agent:')) return this.sessionKey(k);
    // identifier-shaped field names are kept (protocol fields); token/id-looking ones are scrambled;
    // anything else (spaces, punctuation, free text used as a map key) is hashed (R1-02)
    if ((OPAQUE_RE.test(k) && /\d/.test(k) && /[A-Za-z]/.test(k)) || /\d{17,20}/.test(k)) return this.scrambleText(k);
    if (DECLARED.has(k) || KEY_VOCAB.has(k)) return k;       // PM rule: declared names and protocol map keys only
    return 'k_' + this.hx(k, 10);
  }

  number(n, key) {
    if (Number.isInteger(n) && n >= MS_MIN && n <= MS_MAX) { this.report.counts.timestampsShifted++; return n + this.timeShiftMs; }
    if (TOKEN_KEY_RE.test(key) && Number.isFinite(n) && n > 0) { this.report.counts.tokensRounded++; return Math.round(n / 100) * 100; }
    if (COST_KEY_RE.test(key) && Number.isFinite(n)) { this.report.counts.costsRounded++; return Math.round(n * 1e4) / 1e4; }
    if (!Number.isInteger(n) && Number.isFinite(n)) { const r = Math.round(n * 1e6) / 1e6; if (r !== n) this.report.counts.floatsRounded++; return r; }
    return n;
  }

  string(s, path, key) {
    if (ISO_RE.test(s)) { const t = Date.parse(s); if (Number.isFinite(t)) { this.report.counts.timestampsShifted++; return new Date(t + this.timeShiftMs).toISOString(); } }
    if (looksSecret(s)) { this.report.secretsRemoved.set(path, (this.report.secretsRemoved.get(path) || 0) + 1); return '[redacted]'; }
    if (PERSON_KEYS.has(key)) { this.report.counts.person++; return this.scrambleText(s); }
    if (s.startsWith('agent:') || (SESSION_KEY_KEYS.has(key) && /^[\w:.+@-]+$/.test(s))) return this.sessionKey(s);
    const opaque = OPAQUE_RE.test(s);
    const token = TOKEN_RE.test(s) && !/\d{5,}/.test(s);
    const inPublic = this.publicCtx[this.publicCtx.length - 1] === true;
    if (ID_KEY_RE.test(key)) return PROTOCOL_IDS.has(s) ? this.keep('id', key, s) : this.fakeId(s);
    if (MIME_KEYS.includes(key) && /^[\w.+-]+\/[\w.+-]+$/.test(s)) return this.keep('mime', key, s);
    if (opaque) return this.scrambleText(s);       // hashes, base64 and tokens are never kept verbatim
    if (CRON_KEYS.has(key)) {
      if (key === 'tz' || key === 'timezone') { if (TZ_RE.test(s)) return this.keep('cron', key, s); }
      else if (CRON_RE.test(s) && !/[A-Za-z]{4,}/.test(s)) return this.keep('cron', key, s);
    }
    if (key === 'version' && VERSION_RE.test(s)) return this.keep('enum', key, s);
    if (MODEL_KEYS.has(key) && isPublicModel(s)) return this.keep('model', key, s);
    if (own(VOCAB, key) && VOCAB[key].includes(s)) return this.keep('enum', key, s);
    if (own(LIST_VOCAB, key) && LIST_VOCAB[key].includes(s)) return this.keep('protocol', key, s);
    if (ENUM_KEYS.has(key) || PROTOCOL_LIST_KEYS.has(key) || MODEL_KEYS.has(key)) return token ? this.fakeId(s) : this.scrambleText(s);   // not vocabulary
    if (NAME_KEYS.has(key)) {
      if (TOOL_NAMES.has(s)) return this.keep('tool', key, s);
      if ((inPublic || this.publicNames.has(s)) && SLUG_RE.test(s)) return this.keep('public-skill', key, s);
      return SLUG_RE.test(s) ? this.fakeId(s) : this.scrambleText(s);
    }
    if (SKILL_REQ_KEYS.has(key)) return inPublic && SLUG_RE.test(s.toLowerCase()) ? this.keep('public-skill', key, s) : this.fakeId(s);
    if (/^\d{17,20}$/.test(s) || UUID_RE.test(s)) return this.fakeId(s);
    return this.scrambleText(s);
  }

  // Markdown/plain text that must keep its structure (SKILL.md, CLI prefix lines).
  text(s) { return this.sweepString(this.scrambleText(s)); }

  // --- report ------------------------------------------------------------------------------
  // minimal: counts and leak rules only (used when a scan flagged something: never print kept values then)
  reportMarkdown(title, leaks, { minimal = false } = {}) {
    const r = this.report, lines = [`# Redaction report: ${title}`, ''];
    lines.push('## Counts', '', '| what | n |', '| --- | --- |');
    for (const [k, v] of Object.entries(r.counts)) lines.push(`| ${k} | ${v} |`);
    lines.push(`| secrets removed | ${[...r.secretsRemoved.values()].reduce((a, b) => a + b, 0)} |`, '');
    lines.push('Timestamps were shifted by a random whole number of days (not recorded). Ids were replaced by fakes keyed with a random salt (not recorded).', '');
    if (minimal) {
      lines.push('## Leak scan', '', 'Possible leaks found: kept-value lists are withheld from this report.', '');
      for (const l of leaks) lines.push(`- **${l.rule}** in \`${l.file}\` at offset ${l.offset}`);
      return lines.join('\n') + '\n';
    }
    lines.push('## Secret-like values removed (paths)', '');
    if (!r.secretsRemoved.size) lines.push('_none_');
    for (const [p, n] of [...r.secretsRemoved].sort()) lines.push(`- \`${p}\` ×${n}`);
    lines.push('', '## Values kept verbatim (review these)', '');
    for (const [k, m] of [...r.kept].sort()) {
      const vals = [...m].sort((a, b) => b[1] - a[1]).map(([v, n]) => `\`${String(v).replace(/`/g, "'")}\`${n > 1 ? ' ×' + n : ''}`);
      lines.push(`- **${k}**: ${vals.join(', ')}`);
    }
    lines.push('', '## Session-key segments kept verbatim', '');
    lines.push([...r.keptKeySegments].sort().map(([s, n]) => `\`${s}\` ×${n}`).join(', ') || '_none_');
    lines.push('', '## Leak scan', '');
    if (!leaks.length) lines.push('No leaks found.');
    for (const l of leaks) lines.push(`- **${l.rule}** in \`${l.file}\` at offset ${l.offset}`);
    return lines.join('\n') + '\n';
  }
}

function looksSecret(s) {
  return /-----BEGIN [A-Z ]*(PRIVATE|PUBLIC) KEY-----/.test(s)
    || /^Bot [A-Za-z0-9._-]{20,}$/.test(s)
    || /^(sk|pk|rk|xox[abpr]|ghp|gho|ghs|github_pat|glpat)[-_][A-Za-z0-9_-]{16,}$/.test(s)
    || /^[MN][A-Za-z\d_-]{23,25}\.[A-Za-z\d_-]{6}\.[A-Za-z\d_-]{27,}$/.test(s)      // Discord bot token shape
    || /^eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}$/.test(s);   // JWT
}

/*
 * Scan serialized fixture text for anything that looks like real data. `extraSecrets` are exact
 * strings (e.g. the gateway token from the environment) that must not appear; they are never printed.
 */
function scanLeaks(text, file, extraSecrets = []) {
  const found = [];
  const add = (rule, offset) => found.push({ rule, file, offset });
  const scan = (rule, re, ok) => { for (const m of text.matchAll(re)) if (!ok || !ok(m[0])) add(rule, m.index); };
  scan('snowflake-not-fake', /(?<!\d)\d{17,20}(?!\d)/g, (s) => s.startsWith('100000') || /^1[4-9]\d{11}$/.test(s));
  scan('uuid-not-fake', /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, (s) => s.toLowerCase().startsWith('ffffffff-'));
  scan('email-not-fake', /[\w.+-]+@[\w-]+(\.[\w-]+)+/g, (s) => s.endsWith('@example.invalid') || /@(example\.(com|org|invalid)|users\.noreply\.github\.com)$/.test(s) && s.startsWith('user-'));
  scan('pem-block', /-----BEGIN [A-Z ]*KEY-----/g);
  scan('bot-token', /Bot [A-Za-z0-9._-]{20,}/g);
  scan('api-key-prefix', /\b(sk|xox[abpr]|ghp|gho|ghs|github_pat|glpat)[-_][A-Za-z0-9_-]{16,}/g);
  scan('discord-token-shape', /\b[MN][A-Za-z\d_-]{23,25}\.[A-Za-z\d_-]{6}\.[A-Za-z\d_-]{27,}/g);
  scan('jwt', /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g);
  scan('long-opaque-string', /[A-Za-z0-9+/_-]{40,}={0,2}/g, (s) => !(/\d/.test(s) && /[A-Z]/.test(s) && /[a-z]/.test(s)) || s.split('/').every((seg) => seg.length < 24));
  scan('long-hex-string', /\b[0-9a-f]{32,}\b/gi, (s) => s.startsWith('00000000'));
  scan('phone-number', /\+\d{9,15}\b/g, (s) => s.startsWith('+1555'));
  scan('home-path', /\/home\/[a-z_][a-z0-9_-]*/g);
  for (const sec of extraSecrets) if (sec && sec.length >= 6) { let i = text.indexOf(sec); while (i >= 0) { add('known-secret-value', i); i = text.indexOf(sec, i + 1); } }
  return found;
}

module.exports = { FixtureRedactor, scanLeaks, looksSecret };
