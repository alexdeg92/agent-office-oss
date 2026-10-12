// Habilitations (F6, design/explorations/habilitations, explorer-05 « evidence before permission claims »): the
// sentences of the page from AccessVM. Pure: VM → message descriptors. A policy describes a rule; an interlocutor's
// presence in the logs never confirms authorization; an unknown value is neither yes nor no.
import { isRoom } from '../vocab.js';

/** External harnesses take precedence over a model the runtime may never use. */
export function agentExecution(a) {
  if (a.runtime) return a.runtime;
  if (!a.model) return { msg: a.modelSource === 'inherited' ? 'access.agent.defaultModel' : 'editorial.notProvided' };
  return a.modelSource === 'inherited' ? { msg: 'access.agent.inheritedModel', params: { model: a.model } } : a.model;
}

/** A channel's display name with exactly one « # » (explorer-qa-03 Q03-F07: some names arrive with it already). */
export function interlocutorName(i) {
  if (i.name) return isRoom(i) ? '#' + String(i.name).replace(/^#+/, '') : i.name;
  const short = String(i.id).split(':').pop().slice(-6);
  return { msg: isRoom(i) ? 'access.unnamedChannel' : 'access.unnamedUser', params: { id: short } };
}

/** The lead: the direct-message rule as received (or that none was), then the other rules and the standing caveat. */
export function lead(vm) {
  const p = vm.policy || {};
  const head = [p.dm ? { key: 'access.head.dm', params: { policy: { lower: { key: 'accessPolicy.' + p.dm } } } } : { key: 'access.head.unknown', tone: 'warning' }];
  const stand = [];
  if (p.group) stand.push({ key: 'access.stand.group', params: { policy: { lower: { key: 'accessPolicy.' + p.group } } } });
  if (typeof p.channelsTotal === 'number' && p.channelsTotal > 0) stand.push({ key: 'access.stand.channels', params: { n: p.channelsEnabled ?? 0, total: p.channelsTotal } });
  if (p.execSecurity) stand.push({ key: 'access.stand.exec', params: { policy: { lower: { key: 'execSecurity.' + p.execSecurity } } } });
  stand.push({ key: 'access.stand.caveat' });
  return { head, stand };
}

/** One interlocutor's access, first (Q03-F06): enabled / disabled / unconfirmed, then the policy received. */
export function accessSentences(i) {
  const a = i.access || {};
  const out = [a.enabled === true ? { key: 'access.enabled' } : a.enabled === false ? { key: 'access.disabled', tone: 'warning' } : { key: 'access.unknown', tone: 'warning' }];
  if (a.policy) out.push({ key: 'access.policy', params: { policy: { lower: { key: 'accessPolicy.' + a.policy } } } });
  if (a.requireMention === true) out.push({ key: 'access.mention' });
  return out;
}

/** The rules as ledger rows: [label key, value LabelRef | message] (unknown stays « Non renseigné »). */
export function rules(vm) {
  const p = vm.policy || {};
  const v = (ns, x) => (x ? { key: ns + '.' + x } : { msg: 'editorial.notProvided' });
  return [
    ['access.rule.dm', v('accessPolicy', p.dm)],
    ['access.rule.group', v('accessPolicy', p.group)],
    ['access.rule.exec', v('execSecurity', p.execSecurity)],
    ['access.rule.channels', typeof p.channelsTotal === 'number' ? { msg: 'access.rule.channelsValue', params: { n: p.channelsEnabled ?? 0, total: p.channelsTotal } } : { msg: 'editorial.notProvided' }],
  ];
}
