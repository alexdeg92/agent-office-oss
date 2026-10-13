'use strict';
// Synthetic Codex rollout JSONL profile. Unknown event types/keys are counted and
// discarded; only message text allowed by the transcript view reaches the cache.
const { createHash } = require('node:crypto');
const { nameOf } = require('../../engine/model/sender');
const { toolActivity, transcriptActivity, awaitingReplyText, WAITING_RECENCY_MS } = require('../transcript-execution');
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
function parse(lines, { sessionKey, agentId, counters = {}, now = Date.now, gapBeforeIndex = null } = {}) {
  const events=[], result={events,sessionId:null,cwd:null,projectName:null,model:null,usage:null,at:null,activityAt:null,activity:null,displayName:null,summary:null,recognizedLines:0};
  let sessionAt=null, latestMessageAt=null, stable=0, execution=null, anonymousExec=0, pendingReply=false, pendingReplyAt=null;
  let turnOpen=false, turnStartedAt=null, pendingExecOverflow=false;
  let preGapUncertain=false, preGapExec=new Set(), preGapTools=new Set(), tailTaskComplete=false;
  const pendingExec=new Set();
  const openTools=new Set();
  const markExecution=(status,line)=>{execution={status:status,at:ts(line?.timestamp)??ts(line?.payload?.timestamp)??sessionAt};};
  const markActivity=(kind,line)=>{const at=ts(line?.timestamp)??ts(line?.payload?.timestamp)??sessionAt;result.activityAt=at;result.activity={kind,since:at};};
  // Keep the compact lifecycle state for every line in the adapter's bounded
  // byte window. MAX_ITEMS bounds transcript events, not command obligations:
  // dropping older starts before applying later completions can silently lose
  // a still-running command.
  for(let lineIndex=0;lineIndex<lines.length;lineIndex++) {
    if(lineIndex===gapBeforeIndex) {
      // Head and tail are separate observations. Only source IDs can be
      // correlated across omitted bytes; every other lifecycle field (turn,
      // activity/since, reply wait, and execution status) resets here.
      preGapExec=new Set(pendingExec);
      preGapTools=new Set(openTools);
      preGapUncertain=pendingExecOverflow
        ||[...pendingExec].some(id=>id.startsWith('anonymous:'));
      turnOpen=false;turnStartedAt=null;pendingReply=false;pendingReplyAt=null;
      pendingExecOverflow=false;latestMessageAt=null;tailTaskComplete=false;
      result.activity=null;result.activityAt=null;execution=null;
    }
    const line=lines[lineIndex];
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
        markExecution('running',line); markActivity(toolActivity(payload.name),line); continue;
      }
      if(['function_call_output','custom_tool_call_output'].includes(payload.type)) {
        const callId=payload.call_id||payload.id;
        if(typeof callId==='string') {openTools.delete(callId);preGapTools.delete(callId);}
        markExecution('running',line); markActivity('thinking',line); continue;
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
      if(payload.role==='user') { pendingReply=false; pendingReplyAt=null; turnOpen=true; turnStartedAt=at; markExecution('running',line); markActivity('working',line); }
      else if(payload.role==='assistant'&&payload.status==='completed') {
        turnOpen=false; turnStartedAt=null; markExecution('idle',line);
        const answer=content.filter(block=>block&&typeof block.text==='string').map(block=>block.text).join('\n');
        pendingReply=awaitingReplyText(answer);
        pendingReplyAt=pendingReply?at:null;
        if(openTools.size||pendingExec.size||pendingExecOverflow||pendingReply) markActivity('waiting',line);
        else { result.activity=null; result.activityAt=at; }
      }
      else if(payload.role==='assistant') { turnOpen=true; turnStartedAt=at; markExecution('running',line); markActivity('thinking',line); }
    } else if(line.type==='event_msg'&&payload.type==='token_count') {
      const info=payload.info&&typeof payload.info==='object'?payload.info:{}; extras(info,COUNTS_KEYS,counters);
      const usage=info.total_token_usage&&typeof info.total_token_usage==='object'?info.total_token_usage:{}; extras(usage,TOKEN_KEYS,counters);
      if(Number.isSafeInteger(usage.total_tokens)&&usage.total_tokens>=0)result.usage=usage.total_tokens;
      result.recognizedLines++;
    } else if(line.type==='event_msg'&&['task_started','task_complete','agent_reasoning','exec_command_begin','exec_command_end','approval_request','exec_approval_request','request_user_input','user_input_requested'].includes(payload.type)) {
      result.recognizedLines++;
      if(payload.type==='task_complete'||payload.type==='exec_command_end') {
        if(payload.type==='task_complete') {
          // Codex task_complete is the sequential turn boundary for response
          // item tools; it closes even pre-gap tool calls before the tail's
          // idle state. A detached exec beginning wholly inside the byte gap
          // is not observable here; treating this boundary as idle is the
          // accepted tradeoff that avoids retaining completed sessions as
          // unknown indefinitely.
          turnOpen=false; turnStartedAt=null; openTools.clear();
          if(gapBeforeIndex!==null&&gapBeforeIndex!==undefined) { preGapTools.clear(); tailTaskComplete=true; }
        }
        else {
          const commandId=payload.command_id??payload.commandId??payload.call_id??payload.callId??payload.id;
          if((typeof commandId==='string'&&commandId.length<=256)||typeof commandId==='number') {
            pendingExec.delete(String(commandId));preGapExec.delete(String(commandId));
          }
        }
        const at=ts(line.timestamp)??ts(payload.timestamp)??sessionAt;
        const replyLive=pendingReply&&Number.isSafeInteger(pendingReplyAt)&&pendingReplyAt<= (typeof now==='function'?now():now)
          && (typeof now==='function'?now():now)-pendingReplyAt<WAITING_RECENCY_MS;
        if(turnOpen) {
          markExecution('running',{timestamp:turnStartedAt});
          markActivity('thinking',{timestamp:turnStartedAt});
        } else markExecution('idle',line);
        if(openTools.size||pendingExec.size||pendingExecOverflow||replyLive) {
          if(replyLive) markActivity('waiting',{timestamp:pendingReplyAt});
          else if(!turnOpen) markActivity('waiting',line);
        } else if(!turnOpen) { result.activity=null; result.activityAt=at; }
      }
      else if(payload.type==='task_started') { turnOpen=true; turnStartedAt=ts(line.timestamp)??ts(payload.timestamp)??sessionAt; markExecution('running',line); markActivity('working',line); }
      else if(payload.type==='exec_command_begin') {
        const commandId=payload.command_id??payload.commandId??payload.call_id??payload.callId??payload.id;
        const identity=typeof commandId==='string'&&commandId.length<=256||typeof commandId==='number'?String(commandId):`anonymous:${++anonymousExec}`;
        if(pendingExec.has(identity)) { /* duplicate begin is idempotent */ }
        else if(pendingExec.size<64) pendingExec.add(identity);
        else pendingExecOverflow=true;
        turnOpen=true; turnStartedAt=turnStartedAt??ts(line.timestamp)??ts(payload.timestamp)??sessionAt;
        markExecution('running',line); markActivity('executing',line);
      }
      else if(payload.type==='agent_reasoning') { markExecution('running',line); markActivity('thinking',line); }
      else if(payload.type==='approval_request'||payload.type==='exec_approval_request') { markExecution('running',line); markActivity('blocked',line); }
      else if(payload.type==='request_user_input'||payload.type==='user_input_requested') { markExecution('running',line); markActivity('waiting',line); }
    } else {
      counters.unknownLineTypes=(counters.unknownLineTypes||0)+1;
    }
    const at=ts(line.timestamp); if(at!==null)result.at=Math.max(result.at||0,at);
  }
  // A head obligation that the tail did not close may have completed in the
  // omitted bytes, so it cannot justify a live waiting/executing claim. The
  // tail may still establish fresh state of its own. Uncorrelatable overflow
  // or anonymous commands remain unknown regardless of what the tail shows.
  const preGapOpen=preGapExec.size>0||preGapTools.size>0;
  if(preGapUncertain||preGapOpen) {
    execution={status:'unknown',at:result.at??sessionAt};
    result.activity=null;
    result.activityAt=execution.at;
  }
  // Even without a known obligation, an idle tail cannot prove there was no
  // lifecycle event in the omitted bytes.
  else if(gapBeforeIndex!==null&&gapBeforeIndex!==undefined&&!tailTaskComplete&&execution?.status==='idle')
    execution={status:'unknown',at:result.at??sessionAt};
  result.model=result.model||events.slice().reverse().find(e=>e.kind==='assistant'&&e.model)?.model||null;
  result.activityAt=result.activityAt??execution?.at??latestMessageAt??null;
  if(result.activity) result.activity=transcriptActivity(result.activity.kind,result.activity.since,typeof now==='function'?now():now);
  result.execution=execution;
  return result;
}
module.exports={PROFILE,parse,projectName,MAX_TEXT,MAX_ITEMS};
