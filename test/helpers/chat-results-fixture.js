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
async function chatResultsFixture(publicUrl, {result=RESULT,completedChildren=false}={}) {
  const scenario = loadScenario('synthetic-basic');
  const now = Date.now(); scenario.now = now;
  const list = readFixture(scenario.rpc['sessions.list']).body.value;
  const template = list.sessions.find(row => row.key === 'agent:main:main');
  const row = key => ({ ...template, key, sessionId: key, classification: undefined, isMain: key === template.key,
    updatedAt: now - 1000, hasActiveRun: true, status: 'running' });
  const sessions = [row(template.key), row(CHAT), ...CHILDREN.map((key, index) => ({ ...row(key), parentSessionKey: CHAT, label: AUTHORS[index],...(completedChildren?{updatedAt:now-3600000,hasActiveRun:false,status:'ok'}:{}) }))];
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
  const h = await startServer(scenario, { env: { PORTAL_DISPLAY_NAME: 'Camille', AO_ENRICHERS: '', AO_PROJECTS_OWNERS: 'generic-org', ...(publicUrl ? { AO_PUBLIC_URL: publicUrl } : {}) }, handlers: {
    'sessions.list': () => ({ ...list, sessions, totalCount: sessions.length, count: sessions.length, hasMore: false, nextOffset: null }),
    'sessions.get': params => params.key === CHAT ? { messages } : CHILDREN.includes(params.key) ? { messages: [{ role: 'assistant', timestamp: now - 1000, content: 'Vérification en cours.' }] } : original(params),
  } });
  const expectedLooks=[{character:'cosmo',variant:'sage',accessories:['scarf']},{character:'fen',variant:null,accessories:[]}];
  if(completedChildren) {
    const current=await h.get('/api/v3/office/layout');assert.equal(current.status,200,current.text);
    const data=current.json.data.layout.data;
    for(let i=0;i<CHILDREN.length;i++)data.agents.push({agentId:'subagent:'+CHILDREN[i].split(':').at(-1),station:'auto',...expectedLooks[i]});
    const saved=await h.request('PUT','/api/v3/office/layout',{expectedRevision:current.json.data.layout.revision,data});assert.equal(saved.status,200,saved.text);
  }
  return { ...h, expectedLooks, children: CHILDREN, authors: AUTHORS, titles: TITLES, result };
}
async function readChat(h, version) {
  const response = await h.get(`/api/v${version}/views/chat`);
  assert.equal(response.status, 200, response.text);
  return response.json.data;
}
module.exports = { chatResultsFixture, readChat };
