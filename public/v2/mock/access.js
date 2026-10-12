// Mock Habilitations (api.md 2.1 §3.5): AccessVM and InterlocutorVM, invented French data only
// (Discord ids are made-up 18-digit numbers starting 1000…; no real user, channel or server).
const MIN = 60_000, H = 60 * MIN, D = 24 * H;

export function createAccess(now = Date.now()) {
  const people = [
    // [id, kind, name, username/type, resolution, sessions, tokens, lastSeenAgo, policy, enabled, requireMention, extra]
    ['discord-user:100000000000000001', 'discord-user', 'Guest Tremblay', 'guest.t', 'resolved', 9, 58_930, 22 * MIN, 'pairing', null, null, { createdAgo: 900 * D }],
    ['discord-user:100000000000000002', 'discord-user', 'Julie Gagnon', 'julieg', 'resolved', 4, 21_404, 26 * H, 'pairing', null, null, { createdAgo: 600 * D }],
    ['discord-user:100000000000000003', 'discord-user', 'Sophie Côté', 'sophie', 'resolved', 2, 4_120, 3 * D, 'allowlist', null, null, { createdAgo: 1400 * D }],
    ['discord-user:100000000000000004', 'discord-user', null, null, 'failed', 1, 820, 12 * D, 'pairing', null, null, {}],
    ['discord-user:100000000000000005', 'discord-user', 'Rappels', 'rappels-bot', 'resolved', 1, 300, 5 * D, 'pairing', null, null, { bot: true, createdAgo: 200 * D }],
    ['discord-channel:100000000000000101', 'discord-channel', 'projets', 'text', 'resolved', 14, 131_402, 48 * MIN, 'allowlist', true, true, { topic: 'Suivi des projets en cours.', guild: 'Atelier Démo', createdAgo: 700 * D }],
    ['discord-channel:100000000000000102', 'discord-channel', 'clients', 'text', 'resolved', 6, 40_310, 2 * D, 'allowlist', true, false, { topic: 'Demandes des clients.', guild: 'Atelier Démo', createdAgo: 690 * D }],
    ['discord-channel:100000000000000103', 'discord-channel', 'général', 'text', 'resolved', 1, 1_900, 20 * D, 'allowlist', false, true, { topic: '', guild: 'Atelier Démo', createdAgo: 720 * D }],
    ['discord-channel:100000000000000104', 'discord-channel', null, null, 'pending', 1, 640, 40 * MIN, 'allowlist', null, null, {}],
  ];
  const rows = people.map(([id, kind, name, sub, resolution, sessionCount, totalTokens, ago, policy, enabled, requireMention, extra]) =>
    ({ id, kind, name, sub, resolution, sessionCount, totalTokens, lastSeenAt: now - ago, access: { policy, enabled, requireMention }, extra }));

  const sessionsOf = (r) => Array.from({ length: r.sessionCount }, (_, i) => {
    const key = r.kind === 'discord-user' ? `agent:main:discord:direct:${r.id.split(':')[1]}${i ? ':' + i : ''}` : `agent:main:discord:channel:${r.id.split(':')[1]}${i ? ':' + i : ''}`;
    return { id: key, updatedAt: r.lastSeenAt - i * 2 * D, tokens: Math.round(r.totalTokens / r.sessionCount), model: i % 2 ? 'claude-sonnet-5-5' : 'gpt-5.5' };
  });

  return {
    access() {
      const ordered = rows.slice().sort((a, b) => b.lastSeenAt - a.lastSeenAt);
      return {
        agents: [
          { id: 'main', name: 'Timmy', model: 'claude-opus-5-5', modelSource: 'inherited', runtime: null, isPrimary: true },
          { id: 'claude-code', name: 'Agent de code', model: 'claude-opus-5-5', modelSource: 'inherited', runtime: 'codex', isPrimary: false },
        ],
        interlocutors: ordered.map((r) => ({ id: r.id, kind: r.kind, name: r.name, avatarUrl: null, resolution: r.resolution, sessionCount: r.sessionCount,
          totalTokens: r.totalTokens, lastSeenAt: r.lastSeenAt, access: { ...r.access } })),
        policy: { dm: 'pairing', group: 'allowlist', channelsEnabled: rows.filter((r) => r.kind === 'discord-channel' && r.access.enabled).length,
          channelsTotal: rows.filter((r) => r.kind === 'discord-channel').length, execSecurity: 'allowlist' },
      };
    },
    interlocutor(id) {
      const r = rows.find((x) => x.id === id);
      if (!r) return null;
      const sessions = sessionsOf(r);
      const profile = r.resolution !== 'resolved' ? null : r.kind === 'discord-user'
        ? { displayName: r.name, username: r.sub, avatarUrl: null, isBot: !!r.extra.bot, createdAt: now - r.extra.createdAgo }
        : { name: r.name, type: r.sub, topic: r.extra.topic, guildName: r.extra.guild, createdAt: now - r.extra.createdAgo };
      return {
        id: r.id, kind: r.kind, resolution: r.resolution, profile, access: { ...r.access },
        stats: { sessionCount: r.sessionCount, totalTokens: r.totalTokens, firstSeenAt: sessions.length ? sessions[sessions.length - 1].updatedAt : null, lastSeenAt: r.lastSeenAt },
        sessions, primarySessionKey: sessions[0] ? sessions[0].id : null,
      };
    },
  };
}
