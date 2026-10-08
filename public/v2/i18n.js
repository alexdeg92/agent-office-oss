// Labels for enum keys come from GET /api/v2/meta (api.md §1); this module only looks them up.
// LabelRef = { key, params? }. Params are raw data (BRIEF, PM on frontend-02): a param may itself be a LabelRef
// (resolved recursively), numbers are formatted with fmt, ISO 8601 durations become « 2 min 8 s ».
// UI strings (F6, editorial-guide.md §2) live in the message registry (messages.js), fr and en, with full-sentence
// keys, named params and explicit zero/one/other variants: msg(key, params), or rich() to style the params.
// Language: the user's choice in the FR/EN switch (ao.locale), else French. The browser's language is never used:
// the product is French by default (PM, 2026-10-06).
import { interpolate, number, duration, parseIsoDuration, setLocale as setFmtLocale, value as fmtValue, relative, dateTime, time } from './fmt.js';
import { MESSAGES } from './messages.js';
import { LABELS_EN } from './locales/labels.en.js';

export const LANGS = ['fr', 'en'];
const INTL = { fr: 'fr-CA', en: 'en-CA' };
let lang = 'fr';
const langListeners = new Set();
/** The UI language: the user's explicit choice, else French (never the browser's language). */
export const negotiate = (pref) => (LANGS.includes(pref) ? pref : 'fr');
export const getLang = () => lang;
export const intlLocale = () => INTL[lang];
/** Switches the UI language (formatters included) and notifies listeners; the caller re-renders. */
export function setLang(l) {
  lang = LANGS.includes(l) ? l : 'fr';
  setFmtLocale(INTL[lang]);
  for (const fn of langListeners) fn(lang);
  return lang;
}
export const onLang = (fn) => { langListeners.add(fn); return () => langListeners.delete(fn); };

let labels = {};
let labelsLocale = 'fr';   // the language of `labels` (MetaVM.locale, G3c); the en mirror only fills a mismatch
let enums = {};
let primaryAgent = null;
const missing = new Set();
let contract3 = false;   // MetaVM.apiVersion 3 (G5): open vocabularies render their raw value when unlabelled
const OPEN_LABELS = /^(channel|provider|model|agent|runtimeKind)\./;
const MAX_DEPTH = 4;

export function setMeta(meta) {
  labels = (meta && meta.labels) || {}; enums = (meta && meta.enums) || {}; primaryAgent = (meta && meta.primaryAgent) || null;
  labelsLocale = (meta && meta.locale) || 'fr';
  contract3 = !!(meta && meta.apiVersion === 3);
  for (const fn of langListeners) fn(lang);   // new labels: re-render
}

// Platform rule (BRIEF, PM on Owner's product direction): the agent's name is DATA, never a literal in UI code.
// It comes from MetaVM.primaryAgent; without one, sentences use the localized noun (« l’agent » / « the agent »),
// capitalised when it starts a sentence. Never an agent id (editorial guide §1).
/** The primary agent's display name, or « l’agent » / « the agent ». */
export const agentName = () => (primaryAgent && primaryAgent.name) || msg('agent.fallback');
/** The primary agent's portrait URL, if the server provides one. */
export const agentAvatar = () => (primaryAgent && primaryAgent.avatarUrl) || null;
/** Fills `{agent}` in a UI sentence. The fallback is lower-case, so it starts a sentence capitalised. */
export function withAgent(text) {
  return String(text).replace(/\{agent\}/g, (m, i) => { const n = agentName(); return i === 0 && !(primaryAgent && primaryAgent.name) ? n.charAt(0).toUpperCase() + n.slice(1) : n; });
}

const isRef = (v) => v != null && typeof v === 'object' && typeof v.key === 'string';

// Typed params a UI message may carry besides LabelRefs (raw data, formatted here):
//   { n, unit } → fmt.value · { ago: ms } → relative time · { at: ms } → date and time · { clock: ms } → time
//   { msg: key, params? } → a UI message from messages.js · { lower: param } → the param in lower case (a label inside a sentence) · [a, b, c] → a localized list
function resolveParam(v, depth) {
  if (isRef(v)) return depth < MAX_DEPTH ? lookup(v.key, v.params, depth + 1) : v.key;
  if (Array.isArray(v)) return new Intl.ListFormat(INTL[lang], { type: 'conjunction' }).format(v.map((x) => resolveParam(x, depth + 1)));
  if (v && typeof v === 'object') {
    if ('msg' in v) return depth < MAX_DEPTH ? msg(v.msg, v.params) : v.msg;   // a UI message (messages.js), not a server label
    if ('lower' in v) return resolveParam(v.lower, depth + 1).toLocaleLowerCase(INTL[lang]);
    if ('ago' in v) return relative(v.ago, v.now);
    if ('at' in v) return dateTime(v.at, v.now);
    if ('clock' in v) return time(v.clock);
    if ('n' in v && 'unit' in v) return fmtValue(v);
  }
  if (typeof v === 'number') return number(v);
  if (typeof v === 'string') { const ms = parseIsoDuration(v); return ms == null ? v : duration(ms); }
  return v == null ? '' : String(v);
}

function lookup(key, params, depth) {
  // G3c: the server sends labels in the requested locale; the client's en mirror is only a fallback (older server, mocks).
  const label = (lang !== labelsLocale && lang === 'en' && LABELS_EN[key]) || labels[key];
  if (label == null) {
    // R12-07, open vocabulary: a key the dictionary doesn't know (a new provider, channel, card…) renders as
    // « Autre (id) » / « Other (id) » with its safe id, never as a raw key or a guessed known name.
    const id = key.includes('.') ? key.slice(key.indexOf('.') + 1) : key;
    if (contract3 && OPEN_LABELS.test(key)) return id;   // api-v3.md D1: the raw value, never « autre » (expected, no warning)
    if (!missing.has(key)) { missing.add(key); console.warn('[i18n] label manquant :', key); }
    return msg('vocab.other', { id: id.replace(/[^\w.:@/-]/g, '').slice(0, 64) });
  }
  if (!params) return label;
  const resolved = {};
  for (const [k, v] of Object.entries(params)) resolved[k] = resolveParam(v, depth);
  return interpolate(label, resolved);
}

/** t('healthLevel.ok') → « Normal »; t('healthSub.cores', {n: 8}) → « Sur 8 cœurs ». A missing key renders as the key (and warns once). */
export function t(key, params) { return lookup(key, params, 0); }
/** Renders a LabelRef ({key, params}); a plain string is returned as is. */
export function label(ref) { return isRef(ref) ? lookup(ref.key, ref.params, 0) : ref == null ? '' : String(ref); }
export const has = (key) => key in labels;
export const enumOf = (name) => enums[name] || [];

// ---- UI messages (messages.js) ----

const plural = {};
const pluralOf = (n) => (plural[lang] || (plural[lang] = new Intl.PluralRules(INTL[lang]))).select(n);

/** The template for `key` in the current language (French as fallback), with its plural variant chosen. */
function template(key, params = {}) {
  let e = MESSAGES[lang]?.[key];
  if (e == null) {
    if (!missing.has('msg:' + key)) { missing.add('msg:' + key); console.warn('[i18n] message manquant :', key); }
    e = MESSAGES.fr[key] ?? MESSAGES.fr['common.translationMissing'] ?? 'Texte indisponible';
  }
  if (typeof e === 'object') {
    const n = params[e.$count || 'n'];
    e = (n === 0 && e.zero != null) ? e.zero : e[typeof n === 'number' ? pluralOf(n) : 'other'] ?? e.other;
  }
  return e;
}
/** A param as text: numbers via fmt, LabelRefs resolved, ISO durations spelled out, null → ''. */
const paramText = (v) => (isRef(v) ? lookup(v.key, v.params, 1) : resolveParam(v, 1));
const capital = (s) => s.charAt(0).toUpperCase() + s.slice(1);

/** Splits a message into text and params: [{ text } | { name, value }]. `{agent}` defaults to agentName(). */
export function parts(key, params = {}) {
  const tpl = template(key, params);
  const out = [];
  let last = 0;
  tpl.replace(/\{(\w+)\}/g, (m, name, at) => {
    if (at > last) out.push({ text: tpl.slice(last, at) });
    let value = name in params ? paramText(params[name]) : name === 'agent' ? agentName() : m;
    // Only the localized fallback noun is capitalized at sentence start; a supplied name keeps its own case (explorer-06).
    if (at === 0 && name === 'agent' && !(name in params) && !(primaryAgent && primaryAgent.name)) value = capital(value);
    out.push({ name, value, raw: params[name] });
    last = at + m.length;
    return m;
  });
  if (last < tpl.length) out.push({ text: tpl.slice(last) });
  return out;
}
/** msg('bulletin.sources.fresh', { n: 5, total: 6 }) → « 5 sources sur 6 sont à jour. » */
export const msg = (key, params) => parts(key, params).map((p) => ('text' in p ? p.text : p.value)).join('');
/** Like msg(), with each param passed through wrap(name, text, raw) (e.g. to style figures): an array for rendering. */
export const rich = (key, params, wrap) => parts(key, params).map((p) => ('text' in p ? p.text : wrap(p.name, p.value, p.raw)));
/** Every message key, for the coverage test. */
export const messageKeys = (l) => Object.keys(MESSAGES[l] || {});
