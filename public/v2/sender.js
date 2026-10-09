// Only the core Sender contract reaches the browser; runtime formats stay in adapters.
export const senderName = (event, fallback) => event?.senderInfo?.name || event?.sender || (event?.senderInfo?.kind === 'agent' ? 'Agent' : fallback);
export const senderKey = (event) => {
  const s = event?.senderInfo;
  return s && !s.id.includes('unknown:') ? `${s.runtime}:${s.channel || ''}:${s.kind}:${s.id}` : null;
};
export const senderInitials = (name) => String(name || '').trim().split(/[\s_-]+/).slice(0, 2).map((x) => [...x][0] || '').join('').toUpperCase();
export function senderColour(event) {
  const hint = event?.senderInfo?.avatarHint;
  const key = (hint?.startsWith('person:') ? hint.slice(7) : event?.senderInfo?.id) || senderName(event, 'user');
  let hash = 0; for (const char of key) hash = (hash * 31 + char.codePointAt(0)) >>> 0;
  return ['#675039', '#4c6173', '#526349', '#765065', '#645a7a', '#416764', '#765238'][hash % 7];
}

// A roster is deduplicated by identity, including unresolved identities. Unknown display names
// are counted together; two distinct people with the same real name remain distinct.
export function participantRoster(participants = [], subagents = []) {
  const people = new Map(), delegated = new Map();
  for (const p of [...participants, ...subagents]) {
    if (!['human', 'agent'].includes(p.kind)) continue;
    const map = p.delegation ? delegated : people;
    const key = p.delegation ? `${p.runtime}:${p.delegation.sessionKey}` : `${p.runtime}:${p.channel || ''}:${p.kind}:${p.id}`;
    const old = map.get(key);
    map.set(key, old ? { ...old, ...p, name: p.name || old.name } : p);
  }
  const unknown = { human: 0, agent: 0 }, names = [];
  for (const p of people.values()) {
    if (p.name) names.push(p.name); else unknown[p.kind]++;
  }
  return { count: people.size, names, unknown, subagents: [...delegated.values()] };
}
