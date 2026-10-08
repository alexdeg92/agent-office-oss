'use strict';
// Server labels by locale (G3c, explorer-06): fr (default) and en. The locale is the stored preference, else the best
// Accept-Language match, else fr.
const fr = require('./fr');
const en = require('./en');

const LOCALES = { fr, en };
const SUPPORTED = Object.keys(LOCALES);

// 'en-CA,en;q=0.9,fr;q=0.8' → 'en' (highest q among supported primary tags; ties keep header order)
function fromAcceptLanguage(header) {
  if (typeof header !== 'string' || !header) return null;
  let best = null, bestQ = 0;
  for (const part of header.split(',').slice(0, 20)) {
    const [tag, ...params] = part.trim().split(';');
    const lang = tag.trim().toLowerCase().split('-')[0];
    const qp = params.find((p) => p.trim().startsWith('q='));
    const q = qp ? Number(qp.trim().slice(2)) : 1;
    if (SUPPORTED.includes(lang) && Number.isFinite(q) && q > bestQ) { best = lang; bestQ = q; }
  }
  return best;
}
// explicit → pref → Accept-Language → the instance locale (AO_LOCALE, e.g. 'en-GB' → 'en'; G3b) → fr.
// `explicit` is the UI language the client asks for (GET /meta?locale=…): the language its FR/EN switch shows on that
// device. It wins over the stored preference, which another device may have set (frontend-23: an 'en' preference
// gave English labels inside a French UI).
const resolveLocale = ({ explicit = null, pref = null, acceptLanguage = null, instance = null } = {}) => {
  if (SUPPORTED.includes(explicit)) return explicit;
  if (SUPPORTED.includes(pref)) return pref;
  const inst = String(instance || '').toLowerCase().split('-')[0];
  return fromAcceptLanguage(acceptLanguage) || (SUPPORTED.includes(inst) ? inst : 'fr');
};
// G5: one dictionary, two contracts. 2.x never shows a 3.0-only key (its meta stays byte-identical) and 3.0 never shows a
// 2.x-only one; `prompt.*` keys are the server's own (agent prompts), never sent to a client.
const V3_ONLY = /^(sessionKind\.(primary|scheduled|conversation-direct|conversation-group|conversation|internal)|runtimeKind\..+|occupantRole\.(primary|scheduled|direct|group|conversation)|interlocutorKind\.(user|room)|resolution\.unresolvable)$/;
const V2_ONLY = /^(sessionKind\.(main|cron|chat-direct|chat-group|dashboard|acp|explicit)|occupantRole\.(main|cron|dm|channel)|interlocutorKind\.discord-(user|channel)|channel\.unrecognized)$/;
const SERVER_ONLY = /^prompt\./;
const cache = new Map();
/** → the label dictionary a client of `version` gets (all keys server-side when version is 'server') */
function labelsFor(locale, version = 2) {
  const L = (LOCALES[locale] || fr).LABELS;
  if (version === 'server') return L;
  const k = (LOCALES[locale] ? locale : 'fr') + '|' + version;
  if (!cache.has(k)) {
    const drop = version === 3 ? V2_ONLY : V3_ONLY;
    cache.set(k, Object.freeze(Object.fromEntries(Object.entries(L).filter(([key]) => !drop.test(key) && !SERVER_ONLY.test(key)))));
  }
  return cache.get(k);
}

module.exports = { resolveLocale, labelsFor, fromAcceptLanguage, SUPPORTED };
