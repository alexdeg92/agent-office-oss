'use strict';
// Synthetic Codex rollout JSONL profile. Unknown event types/keys are counted and
// discarded; only message text allowed by the transcript view reaches the cache.
const { createHash } = require('node:crypto');
const { nameOf } = require('../../engine/model/sender');
const PROFILE = 'codex-rollout-v1';
const MAX_TEXT = 32768, MAX_ITEMS = 256;
const SESSION_KEYS = new Set(['id','timestamp','cwd','originator','cli_version','source','model_provider','thread_name','title','summary']);
const CONTEXT_KEYS = new Set(['model','cwd','current_date','timezone','approval_policy','sandbox_policy','model_provider']);
const ITEM_KEYS = new Set(['type','id','role','content','status','phase','name','call_id','arguments','output','text','message','timestamp']);
const COUNTS_KEYS = new Set(['total_token_usage','last_token_usage','model_context_window','total_cost_usd','model']);
const TOKEN_KEYS = new Set(['input_tokens','output_tokens','total_tokens','cached_input_tokens','reasoning_output_tokens']);
const ts = value => { const n=typeof value==='number'?value:typeof value==='string'?Date.parse(value):NaN; return Number.isSafeInteger(n)&&n>=0?n:null; };
const safeText = value => typeof value==='string'?value.slice(0,MAX_TEXT):'';
const eventId = (id,index) => 'msg:'+createHash('sha256').update(String(id||index)).digest('hex')+':0';
function extras(record, known, counters) { if(record&&typeof record==='object'&&!Array.isArray(record)) for(const key of Object.keys(record)) if(!known.has(key)) counters.unknownKeys=(counters.unknownKeys||0)+1; }
function projectName(cwd) {
  if(typeof cwd!=='string'||cwd.length>4096||/[\x00-\x1f\x7f]/.test(cwd))return null;
  const p=require('node:path'); const api=p.posix.isAbsolute(cwd)?p.posix:p.win32.isAbsolute(cwd)?p.win32:null;
  const name=api?.basename(cwd); return name&&!['.','..'].includes(name)&&name.length<=128?name:null;
}
function parse(lines, { sessionKey, agentId, counters = {} } = {}) {
  const events=[], result={events,sessionId:null,cwd:null,projectName:null,model:null,usage:null,at:null,activityAt:null,displayName:null,summary:null,recognizedLines:0};
  let sessionAt=null, latestMessageAt=null, stable=0, execution=null;
  const openTools=new Set();
  const markExecution=(status,line)=>{execution={status:status,at:ts(line?.timestamp)??ts(line?.payload?.timestamp)??sessionAt};};
  for(const line of lines.slice(-MAX_ITEMS)) {
    if(!line||typeof line!=='object'||Array.isArray(line)||typeof line.type!=='string'){counters.malformedLines=(counters.malformedLines||0)+1;continue;}
    const payload=line.payload&&typeof line.payload==='object'&&!Array.isArray(line.payload)?line.payload:{};
    if(line.type==='session_meta') {
      extras(payload,SESSION_KEYS,counters); result.sessionId=typeof payload.id==='string'&&payload.id.length<=128?payload.id:null;
      sessionAt=ts(payload.timestamp)||sessionAt; result.cwd=typeof payload.cwd==='string'?payload.cwd:null;
      result.projectName=projectName(result.cwd); result.displayName=typeof payload.title==='string'?safeText(payload.title):typeof payload.thread_name==='string'?safeText(payload.thread_name):null;
      result.summary=typeof payload.summary==='string'?safeText(payload.summary):null; result.recognizedLines++;
    } else if(line.type==='turn_context') {
      extras(payload,CONTEXT_KEYS,counters);
      // Codex may resume a thread from a different worktree. The first
      // session_meta cwd describes where it began; the latest turn_context is
      // the current project identity used for grouping.
      if (typeof payload.cwd === 'string') {
        result.cwd = payload.cwd;
        result.projectName = projectName(payload.cwd);
      }
      result.model=nameOf(payload.model)||result.model; result.recognizedLines++;
    } else if(line.type==='response_item') {
      extras(payload,ITEM_KEYS,counters); result.recognizedLines++;
      if(['function_call','custom_tool_call'].includes(payload.type)) {
        const callId=payload.call_id||payload.id;
        if(typeof callId==='string'&&callId.length<=256)openTools.add(callId);
        markExecution('running',line); continue;
      }
      if(['function_call_output','custom_tool_call_output'].includes(payload.type)) {
        const callId=payload.call_id||payload.id;
        if(typeof callId==='string')openTools.delete(callId);
        markExecution('running',line); continue;
      }
      if(payload.type!=='message'||!['user','assistant'].includes(payload.role))continue;
      const content=typeof payload.content==='string'?[{type:payload.role==='user'?'input_text':'output_text',text:payload.content}]:Array.isArray(payload.content)?payload.content:[];
      if(content.length>64){counters.oversizedItems=(counters.oversizedItems||0)+1;continue;}
      const at=ts(line.timestamp)??ts(payload.timestamp)??sessionAt;
      for(const [i,block] of content.entries()) {
        if(!block||typeof block!=='object'||Array.isArray(block)){counters.unknownContentBlocks=(counters.unknownContentBlocks||0)+1;continue;}
        if(!['input_text','output_text','text'].includes(block.type)||typeof block.text!=='string')continue;
        if(events.length>=MAX_ITEMS)events.shift();
        const kind=payload.role==='user'?'user':'assistant';
        events.push(kind==='user'?{id:eventId(payload.id??line.id??stable++,i),kind,at,text:safeText(block.text),truncated:block.text.length>MAX_TEXT,senderInfo:{kind:'human',id:'operator:'+sessionKey,name:null,runtime:'codex',channel:null,avatarHint:null},sender:null}
          :{id:eventId(payload.id??line.id??stable++,i),kind,at,text:safeText(block.text),truncated:block.text.length>MAX_TEXT,senderInfo:{kind:'agent',id:'agent:'+agentId,name:null,runtime:'codex',channel:null,avatarHint:null},model:result.model,provider:'openai',outputTokens:null,stopReason:payload.status==='completed'?'stop':null,error:null});
      }
      latestMessageAt=at;
      if(payload.role==='user') markExecution('running',line);
      else if(payload.status==='completed'&&openTools.size===0) markExecution('idle',line);
    } else if(line.type==='event_msg'&&payload.type==='token_count') {
      const info=payload.info&&typeof payload.info==='object'?payload.info:{}; extras(info,COUNTS_KEYS,counters);
      const usage=info.total_token_usage&&typeof info.total_token_usage==='object'?info.total_token_usage:{}; extras(usage,TOKEN_KEYS,counters);
      if(Number.isSafeInteger(usage.total_tokens)&&usage.total_tokens>=0)result.usage=usage.total_tokens;
      result.recognizedLines++;
    } else if(line.type==='event_msg'&&['task_started','task_complete','agent_reasoning','exec_command_begin'].includes(payload.type)) {
      result.recognizedLines++;
      if(payload.type==='task_complete') { openTools.clear(); markExecution('idle',line); }
      else if(payload.type==='task_started'||payload.type==='exec_command_begin') { result.activityAt=ts(line.timestamp)??ts(payload.timestamp)??sessionAt; markExecution('running',line); }
      else if(execution?.status==='running') markExecution('running',line);
    } else {
      counters.unknownLineTypes=(counters.unknownLineTypes||0)+1;
    }
    const at=ts(line.timestamp); if(at!==null)result.at=Math.max(result.at||0,at);
  }
  result.model=result.model||events.slice().reverse().find(e=>e.kind==='assistant'&&e.model)?.model||null;
  result.activityAt=execution?.at??latestMessageAt??result.activityAt;
  result.execution=execution;
  return result;
}
module.exports={PROFILE,parse,projectName,MAX_TEXT,MAX_ITEMS};
