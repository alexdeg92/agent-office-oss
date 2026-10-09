'use strict';
/*
 * architect-57 (Owner: the project history's session rows) · what the agent DID in a session, deterministic, from its
 * canonical transcript (no model call): the final reply's first line, the number of steps (tool calls), the files it
 * produced (write/edit tools, or a command's output path), and the tokens. FR or EN.
 *   « Plan de l’infolettre : 3 numéros, outil Brevo, calendrier · 5 étapes · fichiers : plan.md · 25 734 jetons »
 * Also: the message count (the session's, else the transcript's), never null when either is known.
 */
const path = require('path');

const T = {
  fr: { steps: (n) => `${n} étape${n > 1 ? 's' : ''}`, files: (l) => `fichier${l.length > 1 ? 's' : ''} : ${l.join(', ')}`, tokens: (n) => `${fmt(n, 'fr')} jetons`, failed: (n) => `${n} échec${n > 1 ? 's' : ''}` },
  en: { steps: (n) => `${n} step${n > 1 ? 's' : ''}`, files: (l) => `file${l.length > 1 ? 's' : ''}: ${l.join(', ')}`, tokens: (n) => `${fmt(n, 'en')} tokens`, failed: (n) => `${n} failed` },
};
const fmt = (n, locale) => new Intl.NumberFormat(locale === 'en' ? 'en-CA' : 'fr-CA').format(n).replace(/ /g, ' ');
const WRITE_TOOLS = new Set(['write', 'edit', 'apply_patch', 'create_file', 'str_replace', 'str_replace_editor']);

// the first meaningful line of a reply: markdown and decorations stripped, at most 140 code points
function firstLine(text) {
  for (const raw of String(text || '').split('\n')) {
    const l = raw.replace(/^[\s>#*\-–•]+|\*\*|__|`/g, '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').trim();
    if (l.length >= 3) return [...l].length > 140 ? [...l].slice(0, 139).join('') + '…' : l;
  }
  return null;
}
const parse = (s) => { try { return JSON.parse(s); } catch (_) { return null; } };
// the file a write/edit tool produced (its path argument), as a base name
function fileOf(ev) {
  if (!WRITE_TOOLS.has(String(ev.name || '').toLowerCase())) return null;
  const input = parse(ev.input);
  const p = input && (input.path || input.file_path || input.filePath || input.file || input.target);
  return typeof p === 'string' && p ? path.posix.basename(p) : null;
}

/**
 * @param {object|null} transcript  canonical Transcript
 * @param {object} [o] { tokens, locale, hidden(ev) }  hidden: events never counted (the project-tag call)
 * → { summary: string|null, steps, files: string[], reply: string|null }
 */
function summarizeSession(transcript, { tokens = null, locale = 'fr', hidden = null } = {}) {
  const t = T[locale === 'en' ? 'en' : 'fr'];
  const events = ((transcript && transcript.events) || []).filter((e) => !(hidden && hidden(e)));
  const tools = events.filter((e) => e.kind === 'tool');
  const failed = tools.filter((e) => e.isError).length;
  const files = [...new Set(tools.map(fileOf).filter(Boolean))].slice(0, 3);
  const lastReply = events.filter((e) => e.kind === 'assistant' && e.text).pop();
  const reply = lastReply ? firstLine(lastReply.text) : null;
  if (!transcript) return { summary: null, steps: 0, files: [], reply: null };
  const parts = [];
  if (reply) parts.push(reply);
  if (tools.length) parts.push(t.steps(tools.length) + (failed ? ` (${t.failed(failed)})` : ''));
  if (files.length) parts.push(t.files(files));
  if (Number.isInteger(tokens) && tokens > 0) parts.push(t.tokens(tokens));
  return { summary: parts.length ? parts.join(' · ') : null, steps: tools.length, files, reply };
}

/** the session's message count: its own, else the transcript's, else the conversation turns in the transcript */
function messageCountOf(session, transcript, conversationCount = null) {
  if (session && Number.isInteger(session.messageCount) && session.messageCount > 0) return session.messageCount;
  // sessions.list may report 0 for an existing DM/sub-agent. Transcript.messageCount also includes tool results;
  // count the actual person/agent exchanges instead. A real empty transcript still returns zero.
  if (Number.isInteger(conversationCount)) return conversationCount;
  if (transcript && Array.isArray(transcript.events) && (transcript.events.length || !transcript.messageCount)) return transcript.events.filter((e) => e.kind === 'user' || e.kind === 'assistant').length;
  if (transcript && Number.isInteger(transcript.messageCount)) return transcript.messageCount;
  if (session && session.messageCount === 0) return 0;
  return null;
}

function conversationSummary(transcript, { agent = '', locale = 'fr', hidden = null } = {}) {
  if (!transcript) return null;
  const events = (transcript.events || []).filter((e) => !(hidden && hidden(e)));
  const ask = events.find((e) => e.kind === 'user' && e.text);
  const result = summarizeSession(transcript, { locale, hidden });
  const replies = events.filter((e) => e.kind === 'assistant' && e.text);
  const outcome = replies.findLast((e) => e.text.trim().length >= 60) || replies.at(-1);
  const en = locale === 'en';
  const parts = [];
  if (ask) parts.push(`${ask.senderInfo?.name || ask.sender || (ask.senderInfo?.kind === 'agent' ? 'Agent' : en ? 'User' : 'Utilisateur')} : ${firstLine(ask.text.split('[Subagent Task]').at(-1)) || ''}`);
  if (result.steps) parts.push(`${agent || (en ? 'Agent' : 'Agent')} : ${result.steps} ${en ? (result.steps === 1 ? 'step' : 'steps') : (result.steps === 1 ? 'étape' : 'étapes')}${result.files.length ? ' · ' + result.files.join(', ') : ''}`);
  if (outcome) parts.push(`${en ? 'Result' : 'Résultat'} : ${String(outcome.text).replace(/\s+/g, ' ').trim().slice(0, 280)}`);
  return parts.length ? parts.join(' → ') : null;
}

module.exports = { summarizeSession, conversationSummary, messageCountOf, firstLine };
