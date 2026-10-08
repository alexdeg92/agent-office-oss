'use strict';
/*
 * architect-54 · the project tag (OpenClaw adapter). The agent signals the project it works on by CALLING a no-op tool,
 * never in what it writes to people: the call exists only in the session transcript, which this parser reads.
 *
 *   node <skills>/projet/projet.js tag <slug> <statut> <P0-P9> [titre] [note…]   (the `projet` skill, through `exec`)
 *   projet tag <slug> <statut> <P0-P9> [titre] [note…]                           (the same, if the skill is on PATH)
 *   a tool named `projet` with { action: 'tag', slug, statut, priorite, titre, note }  (should it ever be a tool)
 *
 * slug   2 to 64 of [a-z0-9-], first a letter or digit; a ticket key (PIVOT-2735) is accepted and lower-cased.
 * statut idee | a-faire | en-cours | en-revue | livre (accents, spaces and a few synonyms accepted); anything else: the
 *        hint still links the conversation, with no status (`statusIssue: 'unknown'`; never the value).
 * P0-P9  the agent's priority (P0 = most urgent and important); optional for older calls (then `priority: null`).
 * titre  one argument (quote it for several words): the project's display name when it is new; at most 80 code points.
 * note   the rest, free text, at most 200 code points; for the project's history only, never parsed.
 * → [{ id, at, slug, status, statusIssue, priority, title, note }] in transcript order. Pure.
 */
const SLUG = /^[a-z0-9][a-z0-9-]{1,63}$/;
const STATUS = {
  idee: 'idea', idea: 'idea',
  'a-faire': 'todo', todo: 'todo', 'a-venir': 'todo',
  'en-cours': 'in-progress', encours: 'in-progress', 'in-progress': 'in-progress', actif: 'in-progress',
  'en-revue': 'in-review', revue: 'in-review', 'a-valider': 'in-review', 'in-review': 'in-review',
  livre: 'shipped', termine: 'shipped', fini: 'shipped', shipped: 'shipped', done: 'shipped',
};
const EXEC_TOOLS = new Set(['exec', 'bash', 'shell', 'process', 'terminal']);
const fold = (s) => String(s || '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().trim().replace(/[\s_]+/g, '-');

// a shell-like split: whitespace separates, single and double quotes group (no expansion is ever performed)
function words(line) {
  const out = []; let cur = null, q = null;
  for (const ch of String(line)) {
    if (q) { if (ch === q) q = null; else cur += ch; continue; }
    if (ch === '"' || ch === "'") { q = ch; cur = cur == null ? '' : cur; continue; }
    if (/\s/.test(ch)) { if (cur != null) { out.push(cur); cur = null; } continue; }
    cur = (cur == null ? '' : cur) + ch;
  }
  if (cur != null) out.push(cur);
  return out;
}

// the `tag` arguments after the program, from one command line (other commands on the line are ignored)
function tagArgsOf(command) {
  for (const segment of String(command).split(/&&|\|\||;|\n/)) {
    const w = words(segment.trim());
    const at = w.findIndex((x, i) => /(^|\/)projet(\.js)?$/.test(x) && w[i + 1] === 'tag');
    if (at >= 0) return w.slice(at + 2);
  }
  return null;
}

const cut = (s, n) => { const t = String(s || '').trim(); return t ? [...t].slice(0, n).join('') : null; };
function hintOf(args) {
  if (!args || args.length < 1) return null;
  const slug = fold(args[0]).replace(/[^a-z0-9-]/g, '');
  if (!SLUG.test(slug)) return null;
  const raw = args.length > 1 ? fold(args[1]) : '';
  const status = raw ? (STATUS[raw] || null) : null;
  let rest = args.slice(2);
  let priority = null;
  if (rest.length && /^p[0-9]$/i.test(rest[0])) { priority = rest[0].toUpperCase(); rest = rest.slice(1); }
  return { slug, status, statusIssue: raw && !status ? 'unknown' : null, priority, title: cut(rest[0], 80), note: cut(rest.slice(1).join(' '), 200) };
}

function inputOf(ev) {
  if (!ev || typeof ev.input !== 'string') return null;
  try { return JSON.parse(ev.input); } catch (_) { return ev.input; }   // clipped JSON: the raw text still carries the command
}

// The string literals of a piece of JavaScript ('…', "…", `…`), unescaped. architect-56: OpenClaw 2026.9.8's `exec` is
// a CODE-MODE tool: its arguments are { title, code } and the shell command is a literal inside `code`, e.g.
// return await exec({ command: 'node …/projet.js tag menu-builder en-cours P2 "Générateur de menus"' }).
function jsStrings(code) {
  const out = [];
  const src = String(code || '');
  const ESC = { n: '\n', t: '\t', r: '\r', 0: '\0' };
  for (let i = 0; i < src.length; i++) {
    const q = src[i];
    if (q !== "'" && q !== '"' && q !== '`') continue;
    let cur = '', j = i + 1, closed = false;
    for (; j < src.length; j++) {
      const ch = src[j];
      if (ch === '\\') { const nx = src[j + 1]; cur += nx in ESC ? ESC[nx] : (nx ?? ''); j++; continue; }
      if (ch === q) { closed = true; break; }
      cur += ch;
    }
    out.push(cur);   // an unclosed literal (clipped input) still counts
    i = closed ? j : src.length;
  }
  return out;
}
const unjson = (raw) => { try { return JSON.parse('"' + raw + '"'); } catch (_) { return raw.replace(/\\.?$/, '').replace(/\\(["\\/])/g, '$1'); } };
// every command line an exec call may run: `command`/`cmd`/`script` (a string or an argv array), and the literals of a
// code-mode `code`; from the parsed input, or from its text when the transcript clipped the JSON
function commandLinesOf(input) {
  const lines = [];
  const add = (v) => { if (typeof v === 'string') lines.push(v); else if (Array.isArray(v) && v.every((x) => typeof x === 'string')) lines.push(v.join(' ')); };
  if (input && typeof input === 'object') {
    add(input.command); add(input.cmd); add(input.script);
    if (typeof input.code === 'string') lines.push(...jsStrings(input.code));
  } else if (typeof input === 'string') {
    for (const key of ['command', 'cmd', 'script']) { const m = new RegExp('"' + key + '"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)').exec(input); if (m) lines.push(unjson(m[1])); }
    const c = /"code"\s*:\s*"((?:[^"\\]|\\.)*)/.exec(input);
    if (c) lines.push(...jsStrings(unjson(c[1])));
    if (!lines.length) lines.push(input);
  }
  return lines.filter((l) => /projet/.test(l));
}

/** @param transcript canonical Transcript ({ events: TraceEvent[] }) */
function projectHintsOf(transcript) {
  const out = [];
  for (const ev of (transcript && transcript.events) || []) {
    if (!ev || ev.kind !== 'tool') continue;
    const name = String(ev.name || '').toLowerCase();
    const input = inputOf(ev);
    const hints = [];
    if (name === 'projet') {
      const o = input && typeof input === 'object' ? input : {};
      if ((o.action || 'tag') === 'tag') hints.push(hintOf([o.slug, o.statut || o.status || '', o.priorite || o.priority || '', o.titre || o.title || '', o.note || ''].map((x) => (typeof x === 'string' ? x : '')).filter((x, i, a) => x || a.slice(i).some(Boolean))));
    } else if (EXEC_TOOLS.has(name)) {
      for (const line of commandLinesOf(input)) hints.push(hintOf(tagArgsOf(line)));
    }
    // one call may run several tags (a code block): each its own hint, ids stable per position
    hints.filter(Boolean).forEach((hint, n) => out.push(Object.assign({ id: n ? `${ev.id}#${n}` : ev.id, at: ev.at || null }, hint)));
  }
  return out;
}

// architect-55 (PM): is this trace event a project-tag call? Then the trace never shows it (metadata only), valid or
// not: a `projet` tool, or an exec whose command (or code) runs `projet tag` (the call's whole event, output included).
function isProjectTagEvent(ev) {
  if (!ev || ev.kind !== 'tool') return false;
  const name = String(ev.name || '').toLowerCase();
  if (name === 'projet') return true;
  if (!EXEC_TOOLS.has(name) || typeof ev.input !== 'string' || !/projet/.test(ev.input)) return false;
  return commandLinesOf(inputOf(ev)).some((l) => tagArgsOf(l) != null || /(^|[\s/"'])projet(\.js)?["']?\s+tag\b/.test(l));
}

module.exports = { projectHintsOf, isProjectTagEvent, commandLinesOf, jsStrings, tagArgsOf, words, STATUS };
