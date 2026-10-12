// The Bureau's lead and deck (editorial guide §1–2): one true sentence about the office now, from the OfficeVM
// only. Deterministic and pure: same VM, options and locale → same text. Selection order: no snapshot →
// disconnected / stale → reported errors → active work → neutral. No claim without a VM field behind it
// (OccupantVM has a state and a stateSince, not a request count, so the headline never counts requests).
import { s, list, duration } from './strings.js';
import { displayName, isRawId } from './names.js';
import { canonicalRole } from './layout-rules.js';
const isPrimary = (o) => canonicalRole(o.role) === 'primary';

const ACTIVE = ['working', 'thinking', 'researching', 'writing', 'calling', 'waiting'];
const MAX_DECK = 2;

/**
 * @param {object|undefined} vm  OfficeVM data (undefined while loading)
 * @param {{ error?: unknown, meta?: { generatedAt?: number, stale?: unknown[] }, primaryName?: string|null,
 *           now?: number, locale?: 'fr'|'en', time?: (ms:number)=>string, date?: (ms:number)=>string }} [o]
 * @returns {{ kind: string, lead: string, deck: string[], tone: 'neutral'|'warning'|'danger'|'live' }}
 */
export function headline(vm, o = {}) {
  const loc = o.locale;
  const now = o.now ?? Date.now();
  const time = o.time ?? ((ms) => new Intl.DateTimeFormat(loc === 'en' ? 'en-CA' : 'fr-CA', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(ms));
  const date = o.date ?? ((ms) => new Intl.DateTimeFormat(loc === 'en' ? 'en-CA' : 'fr-CA', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(ms));
  const S = (key, params) => s(key, params, loc);

  if (!vm) return o.error ? { kind: 'unavailable', lead: S('office.unavailable'), deck: [], tone: 'warning' } : { kind: 'loading', lead: S('office.loading'), deck: [], tone: 'neutral' };

  const occupants = vm.occupants ?? [];
  const primary = !isRawId(o.primaryName ?? '', { role: 'primary' }) ? o.primaryName.trim() : null;
  const nameOf = (occ) => displayName(occ, { primaryName: primary });
  const fallbackName = (occ) => isPrimary(occ) && !primary && isRawId(occ.name, occ) && isRawId(occ.sourceName, occ);
  // {agent} at the start of a sentence: the display name, else « L’agent » / “The agent” (guide §1).
  const agentLead = (occ) => (fallbackName(occ) ? S('office.agentFallback') : nameOf(occ));
  const agentInner = () => primary ?? S('office.agentFallbackInner');
  const deck = [];

  // Freshness first (guide §2; explorer-qa-02 Q02-01): when the occupants' states can't be confirmed (the gateway
  // is down, the stream is reconnecting, or the server marks a source stale), nothing is said in the present tense.
  // The retained states are told as the last observation, with no running duration.
  if (vm.connection?.gateway === 'down') {
    const lead = vm.connection.since ? S('office.disconnected', { agentInner: agentInner(), time: time(vm.connection.since) }) : S('office.disconnectedUnknown', { agentInner: agentInner() });
    return { kind: 'disconnected', lead, deck: [S('office.disconnectedDeck'), ...pastDeck()], tone: 'warning', stale: true };
  }
  if (o.meta?.stale?.length) {
    const when = o.meta.generatedAt ? S('office.lastSnapshot', { date: date(o.meta.generatedAt) }) : S('office.lastSnapshotUnknown');
    return { kind: 'stale', lead: S('office.unconfirmed'), deck: [when, ...pastDeck()], tone: 'warning', stale: true };
  }

  const errors = occupants.filter((x) => x.state === 'error');
  if (errors.length) {
    const lead = errors.length === 1 ? S('office.error', { n: 1, name: agentLead(errors[0]) }) : S('office.error', { n: errors.length, names: list(errors.map(nameOf), loc) });
    return { kind: 'error', lead, deck: [...deck, ...activeDeck(occupants.filter((x) => ACTIVE.includes(x.state)))].slice(0, MAX_DECK + 1), tone: 'danger' };
  }

  const active = occupants.filter((x) => ACTIVE.includes(x.state));
  if (active.length) {
    const [first, ...rest] = active;   // roster order: main first
    const lead = isPrimary(first)
      ? S(`office.state.${first.state}`, { agent: agentLead(first), duration: duration(Math.max(0, now - first.stateSince), loc) })
      : S(`office.sub.${first.state}`, { name: nameOf(first) });
    return { kind: 'active', lead, deck: [...deck, ...activeDeck(rest)], tone: 'live' };
  }

  if (occupants.some((x) => !['idle', 'offline'].includes(x.state))) return { kind: 'unknown', lead: S('office.unconfirmed'), deck, tone: 'warning' };
  const present = occupants.filter((x) => x.state !== 'offline').length;
  return { kind: 'idle', lead: S('office.noActiveRun'), deck: [...deck, present ? S('office.present', { n: present }) : S('office.empty')], tone: 'neutral' };

  /** « Au dernier relevé, Timmy travaillait. » — past tense, no duration (it can't be confirmed to continue). */
  function pastDeck() {
    const errs = occupants.filter((x) => x.state === 'error');
    const act = occupants.filter((x) => ACTIVE.includes(x.state));
    const named = [...errs, ...act].slice(0, MAX_DECK).map((x) => S(`office.past.${x.state}`, { name: isPrimary(x) ? agentLead(x) : nameOf(x) }));
    if (!named.length) return [S('office.past.none')];
    const more = errs.length + act.length - named.length;
    if (more > 0) named.push(S('office.past.more', { n: more }));
    return named;
  }

  function activeDeck(rest) {
    const shown = rest.slice(0, MAX_DECK).map((x) => S(`office.sub.${x.state}`, { name: nameOf(x) }));
    if (rest.length > MAX_DECK) shown.push(S('office.moreActive', { n: rest.length - MAX_DECK }));
    return shown;
  }
}
