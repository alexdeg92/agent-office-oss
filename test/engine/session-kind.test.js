'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { classifySession, RULES, keyShape, SESSION_KINDS } = require('../../src/adapters/openclaw/classify/session-kind');
const { listScenarios, readFixture } = require('../helpers/scenario');
const { matchGolden } = require('../helpers/golden');
const { isInterlocutorId } = require('../../src/engine/model/kinds');

const SF = '100000000000000001', UUID = 'ffffffff-0001-4000-8000-000000000001';
// One hand-made case per rule (rows only where the rule needs structured fields).
const CASES = [
  ['is-main', 'agent:main:main', { isMain: true }, 'primary'],
  ['main-key', 'agent:main:main', undefined, 'primary'],
  ['subagent', `agent:main:subagent:${UUID}`, undefined, 'subagent'],
  ['subagent-role', 'agent:main:spawned:x', { subagentRole: 'worker' }, 'subagent'],
  ['cron', `agent:main:cron:${UUID}`, undefined, 'scheduled'],
  ['dashboard', `agent:main:dashboard:${UUID}`, undefined, 'dashboard'],
  ['acp', `agent:claude:acp:${UUID}`, undefined, 'acp'],
  ['explicit', 'agent:main:explicit:portal-chat', undefined, 'explicit'],
  ['chat-direct', `agent:main:discord:direct:${SF}`, undefined, 'conversation-direct'],
  ['chat-group', `agent:main:discord:channel:${SF}`, undefined, 'conversation-group'],
  ['chat', 'agent:main:matrix:space:!abc', undefined, 'conversation'],
];

function fixtureKeys() {
  const out = [];
  for (const sc of listScenarios()) {
    const v = readFixture(sc.rpc['sessions.list'], sc.fixturesDir).body.value;
    for (const r of v.sessions) out.push({ sc: sc.name, key: r.key, row: r });
  }
  return out;
}

describe('SessionKind classifier', () => {
  it('every rule has a case where it is the first match', () => {
    for (const [ruleId, key, row, kind] of CASES) {
      const c = classifySession(key, row);
      assert.equal(c.ruleId, ruleId, key); assert.equal(c.kind, kind, key);
    }
    assert.deepEqual(RULES.map((r) => r.id).sort(), CASES.map((c) => c[0]).sort(), 'a rule without a test case');
  });

  it('every fixture key is classified (no unrecognized) — real capture included', () => {
    const bad = fixtureKeys().filter((k) => classifySession(k.key, k.row).kind === 'unrecognized').map((k) => `${k.sc} ${keyShape(k.key)}`);
    assert.deepEqual(bad, []);
  });

  it('heartbeat is a variant, not a kind', () => {
    const c = classifySession(`agent:main:discord:channel:${SF}:heartbeat`, { isBackground: true });
    assert.equal(c.kind, 'conversation-group'); assert.equal(c.heartbeatOf, `agent:main:discord:channel:${SF}`); assert.equal(c.background, true);
    assert.equal(classifySession('agent:main:main:heartbeat', { isMain: false }).kind, 'primary');
  });

  it('isMain is ignored on a heartbeat row (the row describes the variant)', () => {
    assert.equal(classifySession('agent:main:dashboard:x:heartbeat', { isMain: true }).kind, 'dashboard');
  });

  it('Discord interlocutors keep their exact 2.x ids: direct users and bare channel snowflakes only', () => {
    assert.equal(classifySession(`agent:main:discord:direct:${SF}`).interlocutorId, 'discord-user:' + SF);
    assert.equal(classifySession(`agent:main:discord:channel:${SF}`).interlocutorId, 'discord-channel:' + SF);
    assert.equal(classifySession(`agent:main:discord:slash:${SF}`).interlocutorId, undefined);
    assert.equal(classifySession(`agent:main:discord:channel:agent:main:discord:direct:${SF}`).interlocutorId, undefined);
    const w = classifySession('agent:main:wechat:group:x');
    assert.equal(w.kind, 'conversation-group'); assert.equal(w.channel, 'wechat'); assert.equal(w.interlocutorId, 'wechat-room:x');
    assert.equal(classifySession('agent:main:openclaw-weixin:direct:x').channel, 'wechat');
  });

  it('G3b · any channel slug classifies; other families get generic, opaque interlocutor ids (§12.3, §12.5)', () => {
    const t = classifySession('agent:atlas:telegram:direct:foreign-user');
    assert.deepEqual([t.kind, t.channel, t.agentId, t.interlocutorId], ['conversation-direct', 'telegram', 'atlas', 'telegram-user:foreign-user']);
    const r = classifySession('agent:atlas:matrix:room:!room:example.org');
    assert.deepEqual([r.kind, r.channel, r.interlocutorId], ['conversation-group', 'matrix', 'matrix-room:!room:example.org']);
    const u = classifySession('agent:atlas:slack:huddle:C42');
    assert.deepEqual([u.kind, u.channel, u.interlocutorId], ['conversation', 'slack', undefined]);
    // not a channel: the reserved key words, an invalid slug, a peer with control characters
    assert.equal(classifySession('agent:main:cron:direct:x').kind, 'unrecognized');
    assert.equal(classifySession('agent:main:Telegram:direct:x').kind, 'unrecognized');
    assert.equal(classifySession('agent:main:telegram:direct:a\u0001b').interlocutorId, undefined);
  });

  it('G3b · property: a random valid slug and scope always classify as a conversation (seeded)', () => {
    let seed = 42; const rnd = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
    const A = 'abcdefghijklmnopqrstuvwxyz', B = A + '0123456789-';
    const slug = (max) => A[rnd(26)] + Array.from({ length: rnd(max) }, () => B[rnd(B.length)]).join('');
    const reserved = new Set(['main', 'subagent', 'cron', 'dashboard', 'acp', 'explicit', 'heartbeat']);
    for (let i = 0; i < 1000; i++) {
      const ch = slug(31); if (reserved.has(ch)) continue;
      const scope = ['direct', 'dm', 'group', 'channel', 'room', 'thread', slug(8)][rnd(7)];
      const peer = slug(20) + (rnd(2) ? ':' + slug(5) : '');
      const c = classifySession(`agent:${slug(6)}:${ch}:${scope}:${peer}`);
      const want = ['direct', 'dm'].includes(scope) ? 'conversation-direct' : ['group', 'channel', 'room', 'thread', 'slash'].includes(scope) ? 'conversation-group' : 'conversation';
      assert.equal(c.kind, want, `${ch}:${scope}`);
      assert.equal(c.channel, ch === 'weixin' ? 'wechat' : ch);
      if (ch !== 'discord' && want !== 'conversation') assert.equal(c.interlocutorId, `${ch}-${want === 'conversation-direct' ? 'user' : 'room'}:${peer}`);
    }
  });

  it('unknown shapes are unrecognized, never thrown on (fuzz)', () => {
    const parts = ['agent', 'main', 'claude', 'discord', 'channel', 'direct', 'cron', 'subagent', 'heartbeat', SF, UUID, '', 'x:y', '::'];
    let seed = 7; const rnd = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
    for (let i = 0; i < 2000; i++) {
      const key = Array.from({ length: 1 + rnd(6) }, () => parts[rnd(parts.length)]).join(':');
      const c = classifySession(key, rnd(2) ? { isMain: !!rnd(2), subagentRole: rnd(3) ? undefined : 'w' } : undefined,
        rnd(2) ? { baseRow: { subagentRole: rnd(2) ? 'w' : undefined, isMain: !!rnd(2) } } : {});
      // closed unions and identity invariants (R2-09)
      assert.ok(SESSION_KINDS.includes(c.kind), key);
      assert.ok(c.channel === null || /^[a-z][a-z0-9-]{0,31}$/.test(c.channel), key);
      if (c.kind === 'subagent') assert.ok(typeof c.subagentId === 'string' && c.subagentId.length > 0, key);
      if (c.kind === 'scheduled') assert.ok(typeof c.cronJobId === 'string' && c.cronJobId.length > 0, key);
      if (c.heartbeatOf !== null) assert.equal(key, c.heartbeatOf + ':heartbeat');
      if (/:heartbeat$/.test(key)) assert.notEqual(c.heartbeatOf, null, key);
      if (c.interlocutorId) assert.ok(isInterlocutorId(c.interlocutorId), c.interlocutorId);
      if (c.interlocutorId && c.channel === 'discord') assert.match(c.interlocutorId, /^discord-(user|channel):\d{17,20}$/);
      assert.equal(c.kind === 'unrecognized', c.ruleId === 'none', key);
    }
    assert.equal(classifySession('portal-chat').kind, 'unrecognized');
    assert.equal(classifySession(undefined).kind, 'unrecognized');
  });

  for (const sc of listScenarios()) {
    it(`classification table matches golden · ${sc.name}`, () => {
      const table = {};
      for (const k of fixtureKeys().filter((x) => x.sc === sc.name)) {
        const c = classifySession(k.key, k.row);
        const t = `${keyShape(k.key)} → ${c.kind} (${c.ruleId})${c.heartbeatOf ? ' heartbeat' : ''}${c.interlocutorId ? ' ' + c.interlocutorId.split(':')[0] : ''}`;
        table[t] = (table[t] || 0) + 1;
      }
      matchGolden('engine-sessions', sc.name, 'classification', Object.fromEntries(Object.entries(table).sort()));
    });
  }
});
