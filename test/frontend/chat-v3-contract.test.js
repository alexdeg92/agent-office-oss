import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {createChatV3Mock} from '../../public/v2/mock/chat-v3.js';
const require=createRequire(import.meta.url),{validate}=require('../../src/schema'),{schemasFor}=require('../../src/api/v2/vm/schemas');
const check=(name,vm)=>assert.deepEqual(validate(schemasFor(3)[name],vm).issues,[]);
test('v3 Chat mocks consume canonical examples and create a session without changing another target',async()=>{
 const mock=createChatV3Mock({scenario:'1',onChange(){}}),agents=(await mock.handle('GET','/api/v3/chat/agents')).body.data;check('chatAgents',agents);
 const agent=agents.agents[0],path='/api/v3/chat/agents/'+agent.id+'/sessions',before=(await mock.handle('GET',path)).body.data;check('chatAgentSessions',before);
 const session=(await mock.handle('GET','/api/v3/chat/sessions/'+before.defaultSessionId)).body.data;check('chatSession',session);
 assert.deepEqual(session.messages[1].body.blocks.map(block=>block.type),['text','table','team-result']);
 const created=(await mock.handle('POST',path,{})).body.data.result.sessionId,list=(await mock.handle('GET',path)).body.data;check('chatAgentSessions',list);assert.equal(list.defaultSessionId,created);
 const empty=(await mock.handle('GET','/api/v3/chat/sessions/'+created)).body.data;check('chatSession',empty);assert.deepEqual(empty.messages,[]);
 assert.equal((await mock.handle('GET','/api/v3/chat/sessions/missing')).status,404);
 const team=agents.agents.find(row=>row.kind==='team');assert.equal((await mock.handle('POST','/api/v3/chat/agents/'+team.id+'/sessions',{})).status,404);
 const teamList=(await mock.handle('GET','/api/v3/chat/agents/'+team.id+'/sessions')).body.data;check('chatAgentSessions',teamList);assert.equal(teamList.capabilities.startSession,false);
});
test('empty mock uses the supplied agent-index empty label and stays schema valid',async()=>{
 const mock=createChatV3Mock({scenario:'vide',onChange(){}}),value=(await mock.handle('GET','/api/v3/chat/agents')).body.data;check('chatAgents',value);assert.deepEqual(value.agents,[]);assert.equal(value.labels.empty.key,'chat.agents.empty');
});
