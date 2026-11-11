'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {normaliseSession}=require('../../src/adapters/openclaw/normalise/session');
const {normaliseChannels}=require('../../src/adapters/openclaw/normalise/channel');
const raw=require('../fixtures/channel-account-dm.json').body.value;

test('account-scoped human DMs produce the same person identity as legacy DM keys on any channel',()=>{
  for(const [channel,family,peer] of [['wechat-native-isolated','wechat','synthetic-peer'],['whatsapp','whatsapp','synthetic-peer'],['discord','discord','100000000000000001'],['matrix','matrix','synthetic-peer']]){
    for(const account of ['synthetic-account','main','42']){
      const {session}=normaliseSession({...raw,key:`agent:synthetic-agent:${channel}:${account}:direct:${peer}`});
      assert.equal(session.class.kind,'conversation-direct');assert.equal(session.class.channel,family);
      assert.equal(session.class.interlocutorId,`${family}-user:${peer}`);
      assert.equal(normaliseSession({key:`agent:synthetic-agent:${channel}:direct:${peer}`}).session.class.interlocutorId,session.class.interlocutorId);
    }
  }
});

test('account scopes preserve groups, legacy colon-containing peers, internal/main keys and heartbeat identity',()=>{
  const classify=key=>normaliseSession({key}).session.class;
  assert.equal(classify('agent:synthetic-agent:matrix:account:room:room:server').interlocutorId,'matrix-room:room:server');
  assert.equal(classify('agent:synthetic-agent:matrix:direct:person:server').interlocutorId,'matrix-user:person:server');
  assert.equal(classify(raw.key+':heartbeat').interlocutorId,'wechat-user:synthetic-peer');
  assert.equal(classify('agent:synthetic-agent:main').kind,'primary');
  assert.equal(classify('agent:synthetic-agent:explicit:wechat:direct:peer').kind,'explicit');
  assert.equal(classify('agent:synthetic-agent:matrix:huddle:peer').kind,'conversation');
});

test('native isolated channel status uses the existing WeChat label and canonical alias',()=>{
  const channels=normaliseChannels({channels:{'wechat-native-isolated':{configured:true,connected:true}}},()=>{});
  assert.equal(channels[0].id,'wechat');assert.equal(channels[0].label,'WeChat');
});
