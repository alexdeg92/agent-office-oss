// G5 (api-v3.md): the pages read 2.5 and 3.0 values the same way, unlabelled open vocabularies render raw in 3.0,
// and navigation follows MetaVM.runtime.capabilities (a 2.x server declares none: everything stays).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { configure } from '../../public/v2/config.js';
import { isRoom, isPerson, channelOf, boardFilter, runtimeCan } from '../../public/v2/vocab.js';
import { setMeta, setLang, t } from '../../public/v2/i18n.js';
import { interlocutorName } from '../../public/v2/pages/access-rules.js';

test('D5: rooms and people in either contract; the channel defaults to Discord on 2.x', () => {
  assert.ok(isRoom({ kind: 'discord-channel' }) && isRoom({ kind: 'room', channel: 'matrix' }));
  assert.ok(isPerson({ kind: 'discord-user' }) && isPerson({ kind: 'user', channel: 'telegram' }));
  assert.equal(channelOf({ kind: 'user', channel: 'telegram' }), 'telegram');
  assert.equal(channelOf({ kind: 'discord-user' }), 'discord');
  assert.equal(interlocutorName({ id: 'matrix-room:abc', kind: 'room', channel: 'matrix', name: 'général' }), '#général');
});

test('D8: the « with the agent » filter follows the configured contract; old links keep working', () => {
  configure({ apiVersion: 2 });
  assert.deepEqual(['with-agent', 'with-timmy', 'at-risk', 'nope'].map(boardFilter), ['with-timmy', 'with-timmy', 'at-risk', null]);
  configure({ apiVersion: 3 });
  assert.deepEqual(['with-agent', 'with-timmy'].map(boardFilter), ['with-agent', 'with-agent']);
  configure({});
});

test('D1: on 3.0 an unlabelled channel, provider, model or agent renders its raw value, never « Autre »', () => {
  setLang('fr');
  setMeta({ apiVersion: 3, labels: { 'channel.telegram': 'Telegram' }, enums: {} });
  assert.deepEqual([t('channel.telegram'), t('channel.matrix'), t('provider.acme-llm'), t('runtimeKind.acp')], ['Telegram', 'matrix', 'acme-llm', 'acp']);
  assert.match(t('healthCard.inconnu'), /Autre/, 'other namespaces keep the « Autre (id) » rule');
  setMeta({ labels: {}, enums: {} });
  assert.match(t('channel.matrix'), /Autre/, '2.x keeps R12-07');
});

test('D1: navigation follows the runtime capabilities; a 2.x meta (none declared) keeps everything', () => {
  const v3 = { runtime: { capabilities: { chat: false, flows: { read: true, write: false }, skills: { read: true } } } };
  assert.deepEqual(['chat', 'flows.read', 'flows.write', 'skills.read', 'sessions', undefined].map((c) => runtimeCan(c, v3)), [false, true, false, true, true, true]);
  assert.equal(runtimeCan('chat', { runtime: { id: 'openclaw' } }), true);
  assert.equal(runtimeCan('chat', null), true);
});
