// Pure helpers for the Projets board (no DOM). The server orders cards; the client only needs the same rule to show
// where a dragged card will land and to place an optimistic move until the server's VM confirms it.

export const STATUSES = ['idea', 'todo', 'in-progress', 'in-review', 'shipped'];
export const FILTERS = ['all', 'at-risk', 'with-timmy', 'with-agent'];   // D8: both contracts' names; vocab.boardFilter picks the configured one
/** Priority rank from its digit (P0 first); anything unrecognised sorts after every priority. */
export const priorityRank = (p) => { const m = /^P(\d)$/.exec(p || ''); return m ? Number(m[1]) : 99; };

/** The server's card order (data-model §9.1): priority P0 first, then lastActivityAt desc, then id. */
export function compareCards(a, b) {
  return priorityRank(a.priority) - priorityRank(b.priority) || b.lastActivityAt - a.lastActivityAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/** Most recent activity first, then id (the board's « Tri : activité récente »). */
export const byActivity = (a, b) => b.lastActivityAt - a.lastActivityAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** Index at which `card` lands in `cards` (a column, without the card itself) by the server's order. */
export function landingIndex(cards, card) {
  const i = cards.findIndex((c) => c.id !== card.id && compareCards(card, c) < 0);
  return i === -1 ? cards.filter((c) => c.id !== card.id).length : i;
}

/**
 * Applies optimistic moves to a BoardVM's columns. overrides: Map(cardId → { status, at }).
 * A moved card gets lastActivityAt = at (the server touches it on write), and lands where the server will put it.
 * Returns new columns (counts updated); the VM is not mutated.
 */
export function applyOverrides(columns, overrides) {
  if (!overrides || overrides.size === 0) return columns;
  const moved = [];
  const stripped = columns.map((col) => {
    const cards = col.cards.filter((c) => {
      const o = overrides.get(c.id);
      if (o && o.status !== col.id) { moved.push({ ...c, lastActivityAt: o.at ?? c.lastActivityAt, _status: o.status }); return false; }
      return true;
    });
    return cards.length === col.cards.length ? col : { ...col, cards };
  });
  return stripped.map((col) => {
    const incoming = moved.filter((c) => c._status === col.id);
    if (!incoming.length) return col.cards.length === col.count ? col : { ...col, count: col.cards.length };
    const cards = col.cards.slice();
    for (const { _status, ...card } of incoming) cards.splice(landingIndex(cards, card), 0, card);
    return { ...col, count: cards.length, cards };
  });
}

/** Overrides the VM already reflects (the card sits in its target column) can be dropped. */
export function settledOverrides(columns, overrides) {
  const done = [];
  for (const [id, o] of overrides) {
    const col = columns.find((c) => c.cards.some((x) => x.id === id));
    if (!col || col.id === o.status) done.push(id);
  }
  return done;
}

/** Finds a card and its column in a BoardVM's columns. */
export function findCard(columns, id) {
  for (const col of columns) { const card = col.cards.find((c) => c.id === id); if (card) return { card, status: col.id }; }
  return null;
}

/** Next/previous column for the keyboard path (←/→), clamped at the ends. */
export function stepStatus(status, delta) {
  const i = STATUSES.indexOf(status);
  return STATUSES[Math.max(0, Math.min(STATUSES.length - 1, i + delta))];
}

const fold = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
/** Search (view-only): every word of the query appears in the name, accents and case ignored. */
export function matchesQuery(name, q) {
  const words = fold(q).split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const n = fold(name);
  return words.every((w) => n.includes(w));
}

const hash = (s) => { let h = 0; for (const ch of String(s)) h = (h * 31 + ch.charCodeAt(0)) >>> 0; return h; };
export const LABEL_TONES = ['slate', 'indigo', 'teal', 'amber', 'rose', 'green'];
/** Label chip hue, hashed from the label key so a label keeps its colour everywhere (LabelChip README). */
export function labelTone(key) { return LABEL_TONES[hash(key) % LABEL_TONES.length]; }

/**
 * Monogram accent (api.md 2.3 `accent`): one of the six label hues. Anything else (or a 2.2 `tint` such as
 * 'label-teal' / 'label-3') is mapped or hashed from the project id, so a project keeps its colour everywhere.
 */
export function accentTone(accent, id = '') {
  const v = String(accent || '').replace(/^label-/, '');
  if (LABEL_TONES.includes(v)) return v;
  if (/^\d+$/.test(v)) return LABEL_TONES[(Number(v) + LABEL_TONES.length - 1) % LABEL_TONES.length];
  return labelTone(id);
}
/** @deprecated 2.2 name. */
export const tintTone = accentTone;

/** Flags in display order (LabelChip README): priority, risk, feature, label. */
const KIND_ORDER = { priority: 0, risk: 1, feature: 2, label: 3 };
export function sortFlags(flags) {
  return flags.map((f, i) => [f, i]).sort(([a, i], [b, j]) => (KIND_ORDER[a.kind] ?? 9) - (KIND_ORDER[b.kind] ?? 9) || i - j).map(([f]) => f);
}

/**
 * An image URL the UI may load (review-07 R7-04): https anywhere, or same-origin (e.g. <basePath>bureau/…), else null.
 * Characters that could ever matter in another context (quotes, parentheses, semicolons, whitespace) are
 * percent-encoded. The result is only ever used as an <img src>, never inside a style.
 */
export function safeImageUrl(url, origin = globalThis.location ? globalThis.location.origin : 'http://localhost') {
  if (typeof url !== 'string' || !url || url.startsWith('//')) return null;
  let u;
  try { u = new URL(url, origin); } catch { return null; }
  if (!(u.protocol === 'https:' || u.origin === origin)) return null;
  if (u.username || u.password) return null;
  return u.href.replace(/['"();\s]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0'));
}
