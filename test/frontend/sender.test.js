import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTree, waterfall } from '../../public/v2/trace.js';
import { senderColour, senderName, senderInitials, participantRoster } from '../../public/v2/sender.js';
import { plainText } from '../../public/v2/md.js';
const ev = (id, name, at = 1) => ({ id: 'ev:' + at + ':0', kind: 'user', at, text: 'Bonjour', senderInfo: { id, name, kind: 'human', channel: 'discord', runtime: 'demo', avatarHint: null } });
test('consecutive messages group by stable sender ID, never by matching names or unknown IDs', () => {
  const a = ev('discord-user:a', 'Mira'), b = ev('discord-user:b', 'Mira', 3), unknown = ev('human:unknown:group', null, 4);
  const nodes = buildTree([a, { ...a, at: 2 }, b, unknown, unknown]);
  assert.equal(nodes.length, 4); assert.equal(nodes[0].events.length, 2); assert.equal(nodes[1].event.senderInfo.id, 'discord-user:b');
  assert.equal(waterfall([a, b]).rows[0].label, 'Mira');
});
test('avatars use stable identity colours across views and runtimes, and localized fallback', () => {
  const a = ev('discord-user:a', 'Mira');
  assert.equal(senderColour(a), senderColour({ ...a, senderInfo: { ...a.senderInfo, runtime: 'other' } }));
  assert.equal(senderColour({ ...a, senderInfo: { ...a.senderInfo, avatarHint: 'person:per_a' } }), senderColour(ev('per_a', 'Mira')));
  assert.equal(senderInitials('Mira Example'), 'ME'); assert.equal(senderName(ev('opaque', null), 'Utilisateur'), 'Utilisateur');
});

test('participant roster separates delegation, deduplicates stable IDs and counts unnamed agents together', () => {
  const human = ev('human-a', 'Mira').senderInfo, primary = { ...human, kind: 'agent', id: 'primary', name: null };
  const children = Array.from({ length: 9 }, (_, i) => ({ ...primary, id: 'opaque/' + i, delegation: { sessionKey: 'opaque/' + i, label: i === 0 ? 'Review' : null } }));
  const roster = participantRoster([human, human, primary, primary, { ...primary, id: 'primary-2' }, ...children], [children[0]]);
  assert.equal(roster.count, 3); assert.deepEqual(roster.names, ['Mira']);
  assert.deepEqual(roster.unknown, { human: 0, agent: 2 }); assert.equal(roster.subagents.length, 9);
  assert.equal(roster.subagents[0].delegation.label, 'Review');
});

test('summary plain text removes formatting before truncation and keeps code, labels and literal text', () => {
  assert.equal(plainText('Yep, **Montréal** is ready.\n- *Region*: `north-1`\n- [Docs](https://example.test)\n\n```js\nconst value = 1;\n```'), 'Yep, Montréal is ready.\nRegion: north-1\nDocs\nconst value = 1;');
  assert.equal(plainText('## Result\n> **Done**\n\n---\n1. Run `check`\n2. Deploy'), 'Result\nDone\nRun check\nDeploy');
  assert.equal(plainText('<script>alert(1)</script>'), '<script>alert(1)</script>');
});
