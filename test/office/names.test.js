'use strict';
// Display names never show a raw id (PM, staging regression): VM name → MetaVM.primaryAgent.name → « L’agent ».
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { displayName, isRawId } = require(path.join(__dirname, '..', '..', 'public/v2/office/names.js'));

describe('displayName', () => {
  it('uses the VM name when it is a real name', () => {
    assert.equal(displayName({ id: 'main', role: 'main', name: 'Nova' }), 'Nova');
    assert.equal(displayName({ id: 'subagent:7', role: 'subagent', name: ' Scout ' }), 'Scout');
  });
  it('never returns an id: main → primary agent name → « L’agent »; others → role label', () => {
    assert.equal(displayName({ id: 'main', role: 'main', name: 'main' }, { primaryName: 'Timmy' }), 'Timmy');
    assert.equal(displayName({ id: 'main', role: 'main', name: 'main' }), 'L’agent');
    assert.equal(displayName({ id: 'main', role: 'main', name: '' }, { primaryName: 'main' }), 'L’agent');
    assert.equal(displayName({ id: 'subagent:4f2a', role: 'subagent', name: 'subagent:4f2a' }), 'Sous-agent');
    assert.equal(displayName({ id: 'cron:x', role: 'cron', sourceName: 'agent:main:cron:x' }), 'Tâche planifiée');
  });
  it('isRawId recognises occupant ids, session keys and the primary id', () => {
    for (const n of ['main', 'subagent:abc', 'dm:123', 'agent:main:main', '', '  ']) assert.equal(isRawId(n, { role: 'main' }), true, n);
    for (const n of ['Timmy', 'Agent principal', 'Main Street bot']) assert.equal(isRawId(n, { role: 'main' }), false, n);
  });
  it('2.4 OccupantVM.title: a generated name is shown localized; a given name stays as written', () => {
    const sub = { id: 'subagent:ffffffff-0001', role: 'subagent', name: 'Sous-agent ffff', title: { key: 'sessionTitle.subagent', params: { id: 'ffff' } } };
    // the VM name is the server's (French) rendering of the title → the UI's rendering wins
    assert.equal(displayName(sub, { title: 'Sub-agent ffff', titleSource: 'Sous-agent ffff' }), 'Sub-agent ffff');
    // a layout name differs from the generated text → kept
    assert.equal(displayName({ ...sub, name: 'Éclaireur' }, { title: 'Sub-agent ffff', titleSource: 'Sous-agent ffff' }), 'Éclaireur');
    // a named session is its own name in every language
    assert.equal(displayName({ id: 'main', role: 'main', name: 'Nova', title: { key: 'sessionTitle.named', params: { name: 'Nova' } } }, { title: 'Nova', titleSource: 'Nova' }), 'Nova');
    // an unnamed primary session never shows « Session principale » as the agent's name
    assert.equal(displayName({ id: 'main', role: 'main', name: 'main', title: { key: 'sessionTitle.main' } }, { title: 'Main session', titleSource: 'Session principale' }), 'L’agent');
    // no title rendering available → the previous chain
    assert.equal(displayName(sub), 'Sous-agent ffff');
  });
});
