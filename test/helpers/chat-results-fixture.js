'use strict';
require('./scratch-home.cjs').refuseEntry(__filename);
const assert = require('node:assert/strict');
const { loadScenario, readFixture, gatewayHandlers } = require('./scenario');
const { startServer } = require('./harness');
const CHAT = 'agent:main:explicit:portal-chat';
const CHILDREN = ['agent:main:subagent:welcome-review', 'agent:main:subagent:mobile-review'];
const AUTHORS = ['Mira', 'Noor'];
const TITLES = ['Vérifier le parcours d’accueil', 'Tester la confirmation mobile'];
const RESULT = '**Vérifications terminées**\n\n| Contrôle | Résultat détaillé |\n| --- | --- |\n| Accueil | Parcours accessible sur téléphone et ordinateur |\n| Formulaire | Confirmation vérifiée après envoi |';
async function chatResultsFixture(publicUrl, {result=RESULT,completedChildren=false,durable=false}={}) {
  let chatSessionKey=CHAT;
  const scenario = loadScenario('synthetic-basic');
  const now = Date.now(); scenario.now = now;
  const list = readFixture(scenario.rpc['sessions.list']).body.value;
  const template = list.sessions.find(row => row.key === 'agent:main:main');
  const row = key => ({ ...template, key, sessionId: key, classification: undefined, isMain: key === template.key,
    updatedAt: now - 1000, hasActiveRun: true, status: 'running' });
  let sessions = [row(template.key), row(chatSessionKey), ...CHILDREN.map((key, index) => ({ ...row(key), parentSessionKey: chatSessionKey, label: AUTHORS[index],...(completedChildren?{updatedAt:now-3600000,hasActiveRun:false,status:'ok'}:{}) }))];
  const messages = [
    { role: 'user', timestamp: now - 60000, senderId: 'operator', senderName: 'Camille', content: 'Vérifie le parcours d’accueil et la confirmation sur téléphone.' },
    { role: 'assistant', timestamp: now - 55000, content: 'Deux sous-agents ont vérifié le parcours. Voici leurs résultats.' },
    ...CHILDREN.flatMap((key, index) => [
      { role: 'assistant', timestamp: now - 50000 + index, content: [{ type: 'toolCall', id: 'spawn-' + index, name: 'sessions_spawn', arguments: { taskName: TITLES[index] } }] },
      { role: 'toolResult', timestamp: now - 45000 + index, toolCallId: 'spawn-' + index, content: JSON.stringify({ status: 'accepted', childSessionKey: key }) },
    ]),
    { role: 'user', timestamp: now - 1000, provenance: { kind: 'internal_system' }, content:
      '[Subagent Context]\nChild completion results:\n' +
      'Child task 1:\n<prompt-data>' + TITLES[0] + '</prompt-data>\nstatus: ok\nChild result 1:\n<prompt-data>' + result + '</prompt-data>\n' +
      'Child task 2:\n<prompt-data>' + TITLES[1] + '</prompt-data>\nstatus: error\nChild result 2:\n<prompt-data>Le service de démonstration n’a pas répondu. **Aucune publication.**</prompt-data>' },
  ];
  const original = gatewayHandlers(scenario)['sessions.get'];
  const h = await startServer(scenario, { env: { ...(durable?{AO_RBAC_ENABLED:'1'}:{}), PORTAL_DISPLAY_NAME: 'Camille', AO_ENRICHERS: '', AO_PROJECTS_OWNERS: 'generic-org', ...(publicUrl ? { AO_PUBLIC_URL: publicUrl } : {}) }, handlers: {
    'sessions.list': () => ({ ...list, sessions, totalCount: sessions.length, count: sessions.length, hasMore: false, nextOffset: null }),
    'sessions.get': params => params.key === chatSessionKey ? { messages } : CHILDREN.includes(params.key) ? { messages: [{ role: 'assistant', timestamp: now - 1000, content: 'Vérification en cours.' }] } : original(params),
  } });
  try {
    const owner=h.withStore(db=>db.prepare('SELECT id FROM users WHERE email=?').get(require('./harness').TEST_EMAIL));
    const chatIdentity=require('../../src/api/chat-identity'),scope=chatIdentity.scopeForAccount(owner?.id||null);
    chatSessionKey=require('../../src/adapters/openclaw').definition.sessionKeyFor('main',chatIdentity.sessionRefForScope(scope),{purpose:'chat'});
    sessions=[row(template.key),row(chatSessionKey),...CHILDREN.map((key,index)=>({...row(key),parentSessionKey:chatSessionKey,label:AUTHORS[index],...(completedChildren?{updatedAt:now-3600000,hasActiveRun:false,status:'ok'}:{})}))];
    h.gw.emit('sessions.changed',{sessionKey:chatSessionKey,reason:'created'});
    await require('./harness').waitFor(async()=> (await h.get('/api/v3/views/sessions/'+encodeURIComponent(chatSessionKey))).status===200,
      {timeoutMs:10000,what:'the account-scoped Chat session to enter the runtime index'});
    const expectedLooks=[{character:'cosmo',variant:'sage',accessories:['scarf']},{character:'fen',variant:null,accessories:[]}];
    const current=await h.get('/api/v3/office/layout');assert.equal(current.status,200,current.text);
    const data=current.json.data.layout.data;
    for(let i=0;i<CHILDREN.length;i++) {
      const agentId='subagent:'+CHILDREN[i].split(':').at(-1),appearance={agentId,station:'auto',...expectedLooks[i]};
      const existing=data.agents.find(agent=>agent.agentId===agentId);
      if(existing)Object.assign(existing,appearance);else data.agents.push(appearance);
    }
    const saved=await h.request('PUT','/api/v3/office/layout',{expectedRevision:current.json.data.layout.revision,data});assert.equal(saved.status,200,saved.text);
    return { ...h, expectedLooks, children: CHILDREN, authors: AUTHORS, titles: TITLES, result, chatSessionKey };
  } catch(error) {
    await h.stop();
    throw error;
  }
}
async function readChat(h, version) {
  const response = await h.get(`/api/v${version}/views/chat`);
  assert.equal(response.status, 200, response.text);
  return response.json.data;
}
// Stage the real adapter-normalized compatibility transcript into the new
// durable session repository. This covers projection/rendering parity; it does
// not stand in for the v3 dispatch service's completion-event ingestion test.
async function chatResultsV3Fixture(publicUrl, options={}) {
  const h=await chatResultsFixture(publicUrl,{...options,durable:true});
  try {
    const transcript=await h.get('/api/v3/views/sessions/'+encodeURIComponent(h.chatSessionKey));assert.equal(transcript.status,200,transcript.text);
    const canonical=require('../../src/api/v2/vm/chat').buildChatVM({sessionKey:h.chatSessionKey,transcript:{events:transcript.json.data.events}});
    const index=await h.get('/api/v3/chat/agents');assert.equal(index.status,200,index.text);
    const target=index.json.data.agents.find(row=>row.kind==='agent');assert.ok(target);
    // This scenario exercises transcript projection and rendering, not the
    // runtime's session-creation capability. Seed the stored chat row through
    // the repository because the synthetic gateway is intentionally read-only.
    const sessionId='cs_'+require('node:crypto').randomBytes(24).toString('hex');
    h.withStore(db=>{
      const repo=require('../../src/store/repos/chat-v3').createChatV3Repo(db);
      const user=db.prepare('SELECT id FROM users WHERE email=?').get(require('./harness').TEST_EMAIL);
      assert.ok(user,'the fixture owner is present in the mounted store');
      const scope=require('../../src/api/chat-identity').scopeForAccount(user.id);
      const savedTarget=repo.target(scope,target.id);assert.ok(savedTarget,'the mounted agent index created the canonical target');
      repo.createSession({sessionId,principalScope:scope,agentId:target.id,runtimeId:savedTarget.runtime_id,nativeAgentId:savedTarget.native_agent_id,
        nativeSessionRef:`fixture:${scope}:${sessionId}`,title:'Résultats de vérification'});
      for(const message of canonical.messages)repo.addMessage(sessionId,{...message,id:'msg_'+require('node:crypto').randomBytes(24).toString('base64url'),body:{text:message.body?.text??message.text,blocks:message.body?.blocks||[]},meta:{...message.meta,senderInfo:message.senderInfo},attachments:[]});
    });
    return {...h,targetId:target.id,sessionId};
  } catch(error) {await h.stop();throw error;}
}
async function readChatV3(h) {
  const response=await h.get('/api/v3/chat/sessions/'+h.sessionId);assert.equal(response.status,200,response.text);return response.json.data;
}
module.exports = { chatResultsFixture, readChat, chatResultsV3Fixture, readChatV3 };
