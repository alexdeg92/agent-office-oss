'use strict';
/*
 * One redaction step for short free text that leaves a runtime and reaches a view: session titles, summaries,
 * labels, goals and configured descriptions (agent-identity-1 §5, security-112). Every adapter and the office
 * projection call this same function, so a summary is redacted whatever source produced it.
 *   - URL userinfo is dropped (`https://user:pass@host` → `https://host`) and credential query values are masked;
 *   - credential assignments (`password=…`, `"token": "…"`, `api-key: …`, `Authorization: Bearer …`) keep the
 *     name and lose the value;
 *   - known token shapes (provider keys, GitHub/GitLab/Slack/npm tokens, AWS key ids, JWTs, PEM blocks) and any
 *     long unbroken high-entropy run are masked;
 *   - control characters become spaces, whitespace collapses, only the first line is kept, and the result is
 *     bounded in code points.
 * Masks use `…` so a redacted value never looks like a real one. Never throws; a non-string gives null.
 */
const MASK = '…';
const NAMES = String.raw`(?:pass(?:word|wd|phrase)?|pwd|secret|client[_-]?secret|token|access[_-]?token|refresh[_-]?token|auth(?:orization)?|api[_-]?key|apikey|access[_-]?key|private[_-]?key|credentials?|cookie|session[_-]?(?:id|token)|bearer)`;

const RULES = [
  // PEM blocks (a pasted key, even when the line structure is gone)
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, MASK],
  // URL userinfo: scheme://user[:pass]@host
  [/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, '$1'],
  // credential query parameters: ?token=…, &password=…
  [new RegExp(String.raw`([?&;]${NAMES}=)[^&#\s]*`, 'gi'), '$1' + MASK],
  // Authorization schemes
  [/\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{8,}/g, '$1 ' + MASK],
  // assignments: name = value, name: value, "name": "value" (quoted or bare value)
  [new RegExp(String.raw`(["']?\b${NAMES}["']?\s*[:=]\s*)(?:"[^"]*"?|'[^']*'?|[^\s,;&]+)`, 'gi'), '$1' + MASK],
  // known token shapes
  [/\b(?:sk|pk|rk)-(?:ant-|proj-|live-|test-)?[A-Za-z0-9_-]{12,}/g, MASK],
  [/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{16,}|npm_[A-Za-z0-9]{30,}|xox[abeprs]-[A-Za-z0-9-]{10,})/g, MASK],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, MASK],
  [/\bAIza[0-9A-Za-z_-]{30,}/g, MASK],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, MASK],
  // any long unbroken key-like run (hex digests, base64 secrets); plain words and file paths stay readable
  [/[A-Za-z0-9_+/=-]{32,}/g, (run) => keyLike(run) ? MASK : run],
];
const mixed = (s) => /\d/.test(s) && /[A-Za-z]/.test(s);
function keyLike(run) {
  if (!run.includes('/')) return mixed(run);
  // base64 may contain '/': one segment of 16+ mixed characters, or a 40+ run with both letter cases and digits
  return run.split('/').some((seg) => seg.length >= 16 && mixed(seg)) || run.length >= 40 && /[a-z]/.test(run) && /[A-Z]/.test(run) && /\d/.test(run) && !/\/[a-z-]+\//.test(run);
}

function redactText(value, { maxLength = 320, firstLine = true } = {}) {
  if (typeof value !== 'string') return null;
  let text = firstLine ? value.split(/\r\n|\r|\n|\u2028|\u2029/, 1)[0] : value;
  for (const [re, to] of RULES) text = text.replace(re, to);
  text = text.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, ' ').replace(/\s+/g, ' ').trim();
  const points = [...text];
  if (points.length > maxLength) text = points.slice(0, Math.max(1, maxLength - 1)).join('').trimEnd() + MASK;
  return text || null;
}

const CHAT_ROLES = new Set(['direct', 'group', 'conversation', 'conversation-direct', 'conversation-group', 'dm', 'channel']);
function isRawChatIdentity(value, { id = '', role = '' } = {}) {
  if (typeof value !== 'string') return false;
  const text = value.trim();
  const identity = String(id || '');
  const explicitAccountId = /\buser\s*id\s*[:#=]?\s*\d{4,}/i;
  // Chat platforms often append a bare account snowflake to a display name.
  // Treat a 15–20 digit token as an identifier only in chat-shaped records.
  const embeddedAccountId = /(?:^|\D)\d{15,20}(?=\D|$)/;
  const typedChatId = /(?:^|[\s([{])(?:[a-z][a-z0-9_-]{0,31}[-_:])?(?:user|channel):[^\s)\]}]+/i;
  if (explicitAccountId.test(text) || typedChatId.test(text)) return true;
  const chatLike = CHAT_ROLES.has(String(role)) || typedChatId.test(identity);
  return chatLike && (/^\d{5,}$/.test(text) || embeddedAccountId.test(text));
}

function redactChatIdentity(value, { id = '', role = '', maxLength = 320 } = {}) {
  if (typeof value !== 'string') return null;
  if (isRawChatIdentity(value, { id, role })) return 'Conversation';
  return redactText(value, { maxLength });
}

module.exports = { redactText, isRawChatIdentity, redactChatIdentity };
