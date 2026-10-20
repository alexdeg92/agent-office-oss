'use strict';
const { withTx } = require('../db');
const HEX64 = /^[a-f0-9]{64}$/;
const OPAQUE = /^(?:ca|cs|ct|att|msg|turn)_[A-Za-z0-9_-]{32,}$/;
const CHAT_MIME = new Set(['application/pdf','text/plain','image/png','image/jpeg','image/gif','image/webp']);
// Keep a single viewer from monopolizing a shared pane while preserving the pane-wide backstop.
const MAX_QUEUED_PANE_MESSAGES_PER_PRINCIPAL = 250;
const json = value => JSON.stringify(value);
function createChatV3Repo(db, { now = () => Date.now(), onInvalid = () => {} } = {}) {
  const sessions = db.prepare('SELECT * FROM chat_v3_sessions WHERE principal_scope=? AND session_id=? AND deleted_at IS NULL');
  const targets = db.prepare('SELECT * FROM chat_v3_targets WHERE principal_scope=? AND target_id=?');
  function targetForRef(scope,kind,sourceRef){if(!HEX64.test(String(scope||''))||!['agent','team'].includes(kind)||typeof sourceRef!=='string')return null;return db.prepare('SELECT * FROM chat_v3_targets WHERE principal_scope=? AND target_kind=? AND source_ref=?').get(scope,kind,sourceRef)||null;}
  function createTarget(row){if(!validOwner(row.principalScope,row.id)||!['agent','team'].includes(row.kind)||typeof row.sourceRef!=='string'||!row.sourceRef||typeof row.runtimeId!=='string'||!row.runtimeId||typeof row.nativeAgentId!=='string'||!row.nativeAgentId)throw new Error('invalid chat target');withTx(db,()=>db.prepare('INSERT OR IGNORE INTO chat_v3_targets(target_id,principal_scope,target_kind,source_ref,runtime_id,native_agent_id,created_at) VALUES(?,?,?,?,?,?,?)').run(row.id,row.principalScope,row.kind,row.sourceRef,row.runtimeId,row.nativeAgentId,now()));return targetForRef(row.principalScope,row.kind,row.sourceRef);}
  function target(scope,id){return validOwner(scope,id)?targets.get(scope,id)||null:null;}
  function targetRows(scope){return HEX64.test(String(scope||''))?db.prepare('SELECT * FROM chat_v3_targets WHERE principal_scope=? ORDER BY target_kind,target_id').all(scope):[];}
  function validOwner(scope, id) { return HEX64.test(String(scope || '')) && OPAQUE.test(String(id || '')); }
  function parse(row, table) { try { return row ? row : null; } catch { onInvalid(table); return null; } }
  function createSession(row) {
    if (!validOwner(row.principalScope,row.sessionId) || !OPAQUE.test(row.agentId) || !target(row.principalScope,row.agentId) || typeof row.runtimeId!=='string' || !row.runtimeId || !row.nativeAgentId || !row.nativeSessionRef) throw new Error('invalid chat session');
    const t = now();
    withTx(db, () => db.prepare(`INSERT INTO chat_v3_sessions(session_id,principal_scope,agent_id,runtime_id,native_agent_id,native_session_ref,title,created_at,updated_at,pane_member_id)
      VALUES(?,?,?,?,?,?,?,?,?,?)`).run(row.sessionId,row.principalScope,row.agentId,row.runtimeId,row.nativeAgentId,row.nativeSessionRef,String(row.title||'').slice(0,160),t,t,
        typeof row.paneMemberId==='string'&&row.paneMemberId?row.paneMemberId:null));
    return get(row.principalScope,row.sessionId);
  }
  function get(scope,id) { if(!validOwner(scope,id))return null;return parse(sessions.get(scope,id),'chat_v3_sessions'); }
  function list(scope,agentId,{filter='active'}={}) {
    if(!HEX64.test(String(scope||''))||!OPAQUE.test(String(agentId||'')))return [];
    if(!['active','archived'].includes(filter))return [];
    return db.prepare(`SELECT * FROM chat_v3_sessions WHERE principal_scope=? AND agent_id=? AND deleted_at IS NULL AND ${filter==='archived'?'archived_at IS NOT NULL':'archived_at IS NULL'} ORDER BY updated_at DESC, session_id`).all(scope,agentId);
  }
  function hasPaneSessions(scope,agentId){if(!HEX64.test(String(scope||''))||!OPAQUE.test(String(agentId||'')))return false;
    return !!db.prepare('SELECT 1 AS found FROM chat_v3_sessions WHERE principal_scope=? AND agent_id=? AND pane_member_id IS NOT NULL LIMIT 1').get(scope,agentId);}
  function activeSummary(scope,agentId){if(!HEX64.test(String(scope||''))||!OPAQUE.test(String(agentId||'')))return {unreadCount:0,defaultSessionId:null};
    const row=db.prepare(`SELECT coalesce(sum(unread_count),0) AS unread_count,
      (SELECT session_id FROM chat_v3_sessions WHERE principal_scope=? AND agent_id=? AND deleted_at IS NULL AND archived_at IS NULL ORDER BY updated_at DESC,session_id LIMIT 1) AS default_session_id
      FROM chat_v3_sessions WHERE principal_scope=? AND agent_id=? AND deleted_at IS NULL AND archived_at IS NULL`).get(scope,agentId,scope,agentId);
    return {unreadCount:row.unread_count,defaultSessionId:row.default_session_id||null};}
  function archivedCount(scope,agentId){if(!HEX64.test(String(scope||''))||!OPAQUE.test(String(agentId||'')))return 0;return db.prepare('SELECT count(*) AS n FROM chat_v3_sessions WHERE principal_scope=? AND agent_id=? AND deleted_at IS NULL AND archived_at IS NOT NULL').get(scope,agentId).n;}
  function renameSession(scope,id,title,at=now()) {if(typeof title!=='string'||Array.from(title).length<1||Array.from(title).length>120||!Number.isSafeInteger(at))return null;return withTx(db,()=>{
    const row=get(scope,id);if(!row)return null;if(row.pending_turn_id)return {kind:'turn-pending'};
    db.prepare('UPDATE chat_v3_sessions SET title=?,updated_at=? WHERE principal_scope=? AND session_id=? AND deleted_at IS NULL').run(title,at,scope,id);return {kind:'updated',session:get(scope,id)};
  });}
  function setArchived(scope,id,archived,at=now()) {if(typeof archived!=='boolean'||!Number.isSafeInteger(at))return null;return withTx(db,()=>{
    const row=get(scope,id);if(!row)return null;db.prepare('UPDATE chat_v3_sessions SET archived_at=?,updated_at=? WHERE principal_scope=? AND session_id=? AND deleted_at IS NULL').run(archived?at:null,at,scope,id);return {archived,session:get(scope,id)};
  });}
  function softDelete(scope,id,at=now(),undoMs=30000) {if(!Number.isSafeInteger(at)||!Number.isSafeInteger(undoMs)||undoMs<1||undoMs>30000)return null;return withTx(db,()=>{
    const row=get(scope,id);if(!row)return null;if(row.pending_turn_id)return {kind:'turn-pending'};
    const undoUntil=at+undoMs;db.prepare('UPDATE chat_v3_sessions SET deleted_at=?,delete_after=? WHERE principal_scope=? AND session_id=? AND deleted_at IS NULL').run(at,undoUntil,scope,id);return {kind:'deleted',deletedAt:at,undoUntil};
  });}
  function undoDelete(scope,id,at=now()) {if(!Number.isSafeInteger(at))return null;return withTx(db,()=>{
    const row=db.prepare('SELECT * FROM chat_v3_sessions WHERE principal_scope=? AND session_id=? AND deleted_at IS NOT NULL').get(scope,id);if(!row)return null;
    if(!Number.isSafeInteger(row.delete_after)||row.delete_after<=at)return {kind:'expired'};
    db.prepare('UPDATE chat_v3_sessions SET deleted_at=NULL,delete_after=NULL,updated_at=? WHERE principal_scope=? AND session_id=? AND deleted_at IS NOT NULL').run(at,scope,id);return {kind:'restored',session:get(scope,id)};
  });}
  function purgeExpired(scope,at=now(),limit=20,removeStorage=()=>false) {if(!HEX64.test(String(scope||''))||!Number.isSafeInteger(at)||!Number.isSafeInteger(limit)||limit<1||limit>20||typeof removeStorage!=='function')return {sessions:[],storageNames:[]};
    return withTx(db,()=>{
      const rows=db.prepare('SELECT session_id,agent_id FROM chat_v3_sessions WHERE principal_scope=? AND deleted_at IS NOT NULL AND delete_after IS NOT NULL AND delete_after<=? ORDER BY delete_after,session_id LIMIT ?').all(scope,at,limit);
      const storageNames=[],purged=[];for(const row of rows){const names=db.prepare('SELECT storage_name FROM chat_v3_attachments WHERE principal_scope=? AND session_id=?').all(scope,row.session_id).map(item=>item.storage_name);let filesRemoved=true;
        for(const name of names){let removed=false;try{removed=removeStorage(name)===true;}catch{}if(removed)storageNames.push(name);else filesRemoved=false;}
        if(filesRemoved&&db.prepare('DELETE FROM chat_v3_sessions WHERE principal_scope=? AND session_id=? AND deleted_at IS NOT NULL AND delete_after<=?').run(scope,row.session_id,at).changes)purged.push(row);}
      return {sessions:purged,storageNames};
    });}
  function all(scope) { if(!HEX64.test(String(scope||'')))return [];return db.prepare('SELECT * FROM chat_v3_sessions WHERE principal_scope=? AND deleted_at IS NULL ORDER BY updated_at DESC, session_id').all(scope); }
  // Chat session references are opaque adapter-owned values. This narrow
  // projection lets adapters detect aliases in their process-wide key space
  // without exposing another principal's session metadata or message bodies.
  function sessionRefsForRuntime(runtimeId) {
    if(typeof runtimeId!=='string'||!runtimeId)return [];
    return db.prepare('SELECT session_id,runtime_id,native_agent_id,native_session_ref FROM chat_v3_sessions WHERE runtime_id=?').all(runtimeId);
  }
  function messages(sessionId,{before=null,limit=50}={}) {
    if(!OPAQUE.test(String(sessionId||'')))return [];
    let rows;
    if(before==null) rows=db.prepare('SELECT * FROM chat_v3_messages WHERE session_id=? ORDER BY sequence DESC LIMIT ?').all(sessionId,Math.min(50,Math.max(1,limit)));
    else rows=db.prepare('SELECT * FROM chat_v3_messages WHERE session_id=? AND sequence<? ORDER BY sequence DESC LIMIT ?').all(sessionId,Number(before),Math.min(50,Math.max(1,limit)));
    return rows.reverse().map(row=>{try{return {...row,body:JSON.parse(row.body_json),statusLabel:row.status_label_json?JSON.parse(row.status_label_json):null,meta:row.meta_json?JSON.parse(row.meta_json):null,attachments:JSON.parse(row.attachments_json)};}catch{onInvalid('chat_v3_messages');return null;}}).filter(Boolean);
  }
  function messageForTurn(sessionId,turnId){if(!OPAQUE.test(String(sessionId||''))||!OPAQUE.test(String(turnId||'')))return null;const row=db.prepare("SELECT * FROM chat_v3_messages WHERE session_id=? AND role='user' AND turn_id=? ORDER BY sequence LIMIT 1").get(sessionId,turnId);if(!row)return null;try{return {...row,body:JSON.parse(row.body_json),attachments:JSON.parse(row.attachments_json)};}catch{onInvalid('chat_v3_messages');return null;}}
  function addMessage(sessionId,row,{unread=false}={}) {
    const session=db.prepare('SELECT session_id FROM chat_v3_sessions WHERE session_id=? AND deleted_at IS NULL').get(sessionId);if(!session)throw new Error('unknown session');
    const current=db.prepare('SELECT coalesce(max(sequence),0) AS n FROM chat_v3_messages WHERE session_id=?').get(sessionId).n;
    const body=json(row.body);if(Buffer.byteLength(body)>65536)throw new Error('chat message body too large');
    const seq=current+1,t=Number.isSafeInteger(row.at)?row.at:now();
    withTx(db,()=>{
      db.prepare(`INSERT INTO chat_v3_messages(session_id,sequence,message_id,turn_id,at,role,kind,body_json,title,status,status_label_json,meta_json,attachments_json,unread)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(sessionId,seq,row.id,row.turnId||null,t,row.role,row.kind||'message',body,row.title||null,row.status||null,row.statusLabel?json(row.statusLabel):null,row.meta?json(row.meta):null,json(row.attachments||[]),unread?1:0);
      db.prepare('UPDATE chat_v3_sessions SET updated_at=?, unread_count=unread_count+?, pending_turn_id=NULL,pending_since=NULL,retry_eligible_turn_id=NULL WHERE session_id=?').run(t,unread?1:0,sessionId);
    });return seq;
  }
  function setPending(sessionId,turnId,at) { db.prepare('UPDATE chat_v3_sessions SET pending_turn_id=?,pending_since=?,updated_at=? WHERE session_id=? AND deleted_at IS NULL').run(turnId,at,at,sessionId); }
  function clearPending(sessionId,{retryEligible=false,turnId=null}={}) { db.prepare('UPDATE chat_v3_sessions SET pending_turn_id=NULL,pending_since=NULL,retry_eligible_turn_id=? WHERE session_id=?').run(retryEligible?turnId:null,sessionId); }
  function acknowledge(scope,sessionId,messageId) {
    return withTx(db,()=>{
      const row=get(scope,sessionId);if(!row)return null;
      const message=db.prepare('SELECT sequence FROM chat_v3_messages WHERE session_id=? AND message_id=?').get(sessionId,messageId);if(!message)return null;
      db.prepare('UPDATE chat_v3_messages SET unread=0 WHERE session_id=? AND sequence<=?').run(sessionId,message.sequence);
      const count=db.prepare('SELECT count(*) AS n FROM chat_v3_messages WHERE session_id=? AND unread=1').get(sessionId).n;
      db.prepare('UPDATE chat_v3_sessions SET unread_count=?,updated_at=? WHERE session_id=?').run(count,now(),sessionId);
      const indexRevision=db.prepare('SELECT coalesce(max(updated_at),0) AS t FROM chat_v3_sessions WHERE principal_scope=?').get(scope).t;
      return {unreadCount:count,indexRevision:indexRevision+1,sessionRevision:message.sequence+1};
    });
  }
  function reserveIdempotency({scope,method,route,key,requestHash,ttlMs=86400000}) {
    if(!HEX64.test(scope)||!/^[A-Z]+$/.test(method)||typeof route!=='string'||route.length>256||!/^[A-Za-z0-9._~-]{16,128}$/.test(key)||!HEX64.test(requestHash))throw new Error('invalid idempotency reservation');
    return withTx(db,()=>{
      const t=now(),old=db.prepare('SELECT * FROM chat_v3_idempotency WHERE principal_scope=? AND method=? AND route_key=? AND idem_key=?').get(scope,method,route,key);
      if(old&&old.expires_at<=t){db.prepare('DELETE FROM chat_v3_idempotency WHERE principal_scope=? AND method=? AND route_key=? AND idem_key=?').run(scope,method,route,key);}
      else if(old){if(old.request_hash!==requestHash)return {kind:'conflict'};return {kind:old.state,result:old.result_json?JSON.parse(old.result_json):null,status:old.status_code};}
      db.prepare(`INSERT INTO chat_v3_idempotency(principal_scope,method,route_key,idem_key,request_hash,state,created_at,expires_at)
      VALUES(?,?,?,?,?,'in-flight',?,?)`).run(scope,method,route,key,requestHash,t,t+ttlMs);
      return {kind:'reserved'};
    });
  }
  function idempotencyResult({scope,method,route,key,requestHash}) {
    const old=db.prepare('SELECT * FROM chat_v3_idempotency WHERE principal_scope=? AND method=? AND route_key=? AND idem_key=?').get(scope,method,route,key);
    if(!old||old.expires_at<=now())return {kind:'missing'};
    if(old.request_hash!==requestHash)return {kind:'conflict'};
    return {kind:old.state,result:old.result_json?JSON.parse(old.result_json):null,status:old.status_code};
  }
  function acceptTurn({scope,method,route,key,requestHash,sessionId,turnId,at,message,attachmentIds=[],principalId=null,paneMemberId=null,defaultTitle=null,firstMessageTitle=null,sendNow=false,ttlMs=86400000}) {
    if(!HEX64.test(String(scope||''))||!/^[A-Z]+$/.test(String(method||''))||typeof route!=='string'||route.length>256||!/^[A-Za-z0-9._~-]{16,128}$/.test(String(key||''))||!HEX64.test(String(requestHash||''))||!OPAQUE.test(String(sessionId||''))||!OPAQUE.test(String(turnId||''))||!Number.isSafeInteger(at)||typeof sendNow!=='boolean'||!message||message.role!=='user'||!OPAQUE.test(String(message.id||''))||!Array.isArray(attachmentIds)||new Set(attachmentIds).size!==attachmentIds.length||attachmentIds.some(id=>!OPAQUE.test(String(id||'')))||principalId!==null&&(typeof principalId!=='string'||principalId.length<1||principalId.length>128)||defaultTitle!==null&&(typeof defaultTitle!=='string'||defaultTitle.length>160)||firstMessageTitle!==null&&(typeof firstMessageTitle!=='string'||firstMessageTitle.length<1||firstMessageTitle.length>120)||!Number.isSafeInteger(ttlMs)||ttlMs<1)throw new Error('invalid chat turn acceptance');
    return withTx(db,()=>{
      const t=now(),old=db.prepare('SELECT * FROM chat_v3_idempotency WHERE principal_scope=? AND method=? AND route_key=? AND idem_key=?').get(scope,method,route,key);
      if(old&&old.expires_at<=t)db.prepare('DELETE FROM chat_v3_idempotency WHERE principal_scope=? AND method=? AND route_key=? AND idem_key=?').run(scope,method,route,key);
      else if(old){if(old.request_hash!==requestHash)return {kind:'conflict'};return {kind:old.state,result:old.result_json?JSON.parse(old.result_json):null,status:old.status_code};}

      const session=db.prepare('SELECT * FROM chat_v3_sessions WHERE principal_scope=? AND session_id=? AND deleted_at IS NULL').get(scope,sessionId);
      if(!session)return {kind:'not-found'};
      if(session.pending_turn_id)return {kind:'turn-pending'};
      const attachmentRows=attachmentIds.map(id=>db.prepare("SELECT * FROM chat_v3_attachments WHERE principal_scope=? AND session_id=? AND attachment_id=? AND state='staged' AND expires_at>? ").get(scope,sessionId,id,t));
      if(attachmentRows.some(row=>!row))return {kind:'attachments-not-found'};
      for(const row of attachmentRows){
        if(db.prepare("UPDATE chat_v3_attachments SET state='bound' WHERE attachment_id=? AND principal_scope=? AND session_id=? AND state='staged' AND expires_at>?").run(row.attachment_id,scope,sessionId,t).changes!==1)return {kind:'attachments-not-found'};
      }
      if(firstMessageTitle&&(!session.title||defaultTitle&&session.title===defaultTitle)&&!db.prepare("SELECT 1 AS ok FROM chat_v3_messages WHERE session_id=? AND role='user' LIMIT 1").get(sessionId))
        db.prepare('UPDATE chat_v3_sessions SET title=? WHERE principal_scope=? AND session_id=?').run(firstMessageTitle,scope,sessionId);

      const body=json(message.body);if(Buffer.byteLength(body)>65536)throw new Error('chat message body too large');
      const sequence=db.prepare('SELECT coalesce(max(sequence),0)+1 AS n FROM chat_v3_messages WHERE session_id=?').get(sessionId).n;
      db.prepare(`INSERT INTO chat_v3_messages(session_id,sequence,message_id,turn_id,at,role,kind,body_json,title,status,status_label_json,meta_json,attachments_json,unread)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,0)`).run(sessionId,sequence,message.id,turnId,at,message.role,message.kind||'message',body,message.title||null,message.status||null,message.statusLabel?json(message.statusLabel):null,message.meta?json(message.meta):null,json(message.attachments||[]));
      const changed=db.prepare('UPDATE chat_v3_sessions SET pending_turn_id=?,pending_since=?,updated_at=? WHERE principal_scope=? AND session_id=? AND pending_turn_id IS NULL AND deleted_at IS NULL').run(turnId,at,at,scope,sessionId).changes;
      if(changed!==1)throw new Error('chat turn acceptance lost session reservation');
      const result={turnId};
      db.prepare(`INSERT INTO chat_v3_idempotency(principal_scope,method,route_key,idem_key,request_hash,state,status_code,result_json,created_at,expires_at)
        VALUES(?,?,?,?,?,'uncertain',202,?,?,?)`).run(scope,method,route,key,requestHash,json(result),t,t+ttlMs);
      db.prepare(`INSERT INTO chat_v3_turn_dispatches(session_id,turn_id,principal_id,state,created_at,send_now) VALUES(?,?,?,'queued',?,?)`).run(sessionId,turnId,principalId,t,sendNow?1:0);
      if(paneMemberId&&!sendNow)db.prepare(`INSERT INTO chat_v3_pane_queue(session_id,turn_id,pane_member_id,principal_scope,principal_id,queued_at,state) VALUES(?,?,?,?,?,?,'sending')`)
        .run(sessionId,turnId,paneMemberId,scope,principalId,at);
      return {kind:'accepted',result,status:202};
    });
  }
  function enqueuePaneMessage({scope,method,route,key,requestHash,sessionId,turnId,paneMemberId,at,message,principalId=null,defaultTitle=null,firstMessageTitle=null,statusLabel,ttlMs=86400000}) {
    if(!HEX64.test(String(scope||''))||!/^[A-Z]+$/.test(String(method||''))||typeof route!=='string'||route.length>256||!/^[A-Za-z0-9._~-]{16,128}$/.test(String(key||''))||!HEX64.test(String(requestHash||''))||!OPAQUE.test(String(sessionId||''))||!OPAQUE.test(String(turnId||''))||typeof paneMemberId!=='string'||paneMemberId.length<1||paneMemberId.length>256||!Number.isSafeInteger(at)||!message||message.role!=='user'||!OPAQUE.test(String(message.id||''))||!statusLabel||principalId!==null&&(typeof principalId!=='string'||principalId.length<1||principalId.length>128)||!Number.isSafeInteger(ttlMs)||ttlMs<1)throw new Error('invalid queued pane message');
    return withTx(db,()=>{
      const t=now(),old=db.prepare('SELECT * FROM chat_v3_idempotency WHERE principal_scope=? AND method=? AND route_key=? AND idem_key=?').get(scope,method,route,key);
      if(old&&old.expires_at<=t)db.prepare('DELETE FROM chat_v3_idempotency WHERE principal_scope=? AND method=? AND route_key=? AND idem_key=?').run(scope,method,route,key);
      else if(old){if(old.request_hash!==requestHash)return {kind:'conflict'};return {kind:old.state,result:old.result_json?JSON.parse(old.result_json):null,status:old.status_code};}
      const session=db.prepare('SELECT * FROM chat_v3_sessions WHERE principal_scope=? AND session_id=? AND deleted_at IS NULL').get(scope,sessionId);
      if(!session)return {kind:'not-found'};
      if(db.prepare("SELECT count(*) AS n FROM chat_v3_pane_queue WHERE state='queued' AND session_id=?").get(sessionId).n>=100)return {kind:'queue-full'};
      if(db.prepare("SELECT count(*) AS n FROM chat_v3_pane_queue WHERE state='queued' AND principal_scope=?").get(scope).n>=MAX_QUEUED_PANE_MESSAGES_PER_PRINCIPAL)return {kind:'queue-full'};
      if(db.prepare("SELECT count(*) AS n FROM chat_v3_pane_queue WHERE state='queued' AND pane_member_id=?").get(paneMemberId).n>=1000)return {kind:'queue-full'};
      if(firstMessageTitle&&(!session.title||defaultTitle&&session.title===defaultTitle)&&!db.prepare("SELECT 1 AS ok FROM chat_v3_messages WHERE session_id=? AND role='user' LIMIT 1").get(sessionId))
        db.prepare('UPDATE chat_v3_sessions SET title=? WHERE principal_scope=? AND session_id=?').run(firstMessageTitle,scope,sessionId);
      const body=json(message.body);if(Buffer.byteLength(body)>65536)throw new Error('chat message body too large');
      const sequence=db.prepare('SELECT coalesce(max(sequence),0)+1 AS n FROM chat_v3_messages WHERE session_id=?').get(sessionId).n;
      db.prepare(`INSERT INTO chat_v3_messages(session_id,sequence,message_id,turn_id,at,role,kind,body_json,title,status,status_label_json,meta_json,attachments_json,unread)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,0)`).run(sessionId,sequence,message.id,turnId,at,message.role,'message',body,null,'queued',json(statusLabel),null,'[]');
      db.prepare(`INSERT INTO chat_v3_pane_queue(session_id,turn_id,pane_member_id,principal_scope,principal_id,queued_at,state) VALUES(?,?,?,?,?,?,'queued')`)
        .run(sessionId,turnId,paneMemberId,scope,principalId,at);
      const result={turnId};
      db.prepare(`INSERT INTO chat_v3_idempotency(principal_scope,method,route_key,idem_key,request_hash,state,status_code,result_json,created_at,expires_at)
        VALUES(?,?,?,?,?,'uncertain',202,?,?,?)`).run(scope,method,route,key,requestHash,json(result),t,t+ttlMs);
      db.prepare('UPDATE chat_v3_sessions SET updated_at=? WHERE principal_scope=? AND session_id=?').run(at,scope,sessionId);
      return {kind:'accepted',result,status:202};
    });
  }
  function hasPaneQueue(paneMemberId){return !!db.prepare("SELECT 1 AS found FROM chat_v3_pane_queue WHERE pane_member_id=? AND state IN ('queued','sending') LIMIT 1").get(paneMemberId);}
  function queuedPaneMessage(scope,sessionId,turnId){if(!validOwner(scope,sessionId)||!OPAQUE.test(String(turnId||'')))return false;return !!db.prepare("SELECT 1 AS found FROM chat_v3_pane_queue q JOIN chat_v3_sessions s ON s.session_id=q.session_id AND s.principal_scope=q.principal_scope WHERE q.principal_scope=? AND q.session_id=? AND q.turn_id=? AND q.state='queued' AND s.deleted_at IS NULL AND s.pending_turn_id IS NULL").get(scope,sessionId,turnId);}
  function paneHasPending(paneMemberId){return !!db.prepare('SELECT 1 AS found FROM chat_v3_sessions WHERE pane_member_id=? AND deleted_at IS NULL AND pending_turn_id IS NOT NULL LIMIT 1').get(paneMemberId);}
  function queuedPaneMembers(limit=256,afterPaneMemberId='',throughQueueId=null){
    const boundedLimit=Math.min(256,Math.max(1,Number.isSafeInteger(limit)?limit:256));
    if(typeof afterPaneMemberId!=='string'||afterPaneMemberId.length>256)throw new Error('invalid queued pane cursor');
    const watermark=throughQueueId===null?db.prepare("SELECT coalesce(max(queue_id),0) AS id FROM chat_v3_pane_queue WHERE state='queued'").get().id:throughQueueId;
    if(!Number.isSafeInteger(watermark)||watermark<0)throw new Error('invalid queued pane watermark');
    const members=db.prepare("SELECT pane_member_id FROM chat_v3_pane_queue WHERE state='queued' AND queue_id<=? AND pane_member_id>? GROUP BY pane_member_id ORDER BY pane_member_id LIMIT ?")
      .all(watermark,afterPaneMemberId,boundedLimit).map(row=>row.pane_member_id);
    return {members,nextCursor:members.at(-1)||afterPaneMemberId,throughQueueId:watermark,done:members.length<boundedLimit};
  }
  function promotePaneQueue(paneMemberId,at=now()) {if(typeof paneMemberId!=='string'||!paneMemberId||!Number.isSafeInteger(at))return null;return withTx(db,()=>{
    const queued=db.prepare(`SELECT q.session_id,q.turn_id,q.principal_id,q.queue_id FROM chat_v3_pane_queue q
      JOIN chat_v3_sessions s ON s.session_id=q.session_id AND s.principal_scope=q.principal_scope
      WHERE q.pane_member_id=? AND q.state='queued' AND s.deleted_at IS NULL AND s.pending_turn_id IS NULL
      AND NOT EXISTS (SELECT 1 FROM chat_v3_sessions active WHERE active.pane_member_id=q.pane_member_id AND active.deleted_at IS NULL AND active.pending_turn_id IS NOT NULL)
      ORDER BY q.queue_id LIMIT 1`).get(paneMemberId);
    if(!queued)return null;
    const session=db.prepare('SELECT pending_turn_id FROM chat_v3_sessions WHERE session_id=? AND deleted_at IS NULL').get(queued.session_id);
    if(!session||session.pending_turn_id)return null;
    if(db.prepare('UPDATE chat_v3_sessions SET pending_turn_id=?,pending_since=?,updated_at=? WHERE session_id=? AND pending_turn_id IS NULL AND deleted_at IS NULL').run(queued.turn_id,at,at,queued.session_id).changes!==1)return null;
    db.prepare("UPDATE chat_v3_pane_queue SET state='sending' WHERE queue_id=? AND state='queued'").run(queued.queue_id);
    db.prepare("INSERT INTO chat_v3_turn_dispatches(session_id,turn_id,principal_id,state,created_at,send_now) VALUES(?,?,?,'queued',?,0)").run(queued.session_id,queued.turn_id,queued.principal_id,at);
    return db.prepare(`${turnDispatchSelect} WHERE d.session_id=? AND d.turn_id=?`).get(queued.session_id,queued.turn_id)||null;
  });}
  function sendQueuedPaneNow(scope,sessionId,turnId,at=now()) {if(!validOwner(scope,sessionId)||!OPAQUE.test(String(turnId||''))||!Number.isSafeInteger(at))return null;return withTx(db,()=>{
    const queued=db.prepare("SELECT q.queue_id,q.pane_member_id,q.principal_id FROM chat_v3_pane_queue q JOIN chat_v3_sessions s ON s.session_id=q.session_id AND s.principal_scope=q.principal_scope WHERE q.principal_scope=? AND q.session_id=? AND q.turn_id=? AND q.state='queued' AND s.deleted_at IS NULL AND s.pending_turn_id IS NULL").get(scope,sessionId,turnId);
    if(!queued||db.prepare("SELECT 1 AS active FROM chat_v3_sessions WHERE pane_member_id=? AND deleted_at IS NULL AND pending_turn_id IS NOT NULL LIMIT 1").get(queued.pane_member_id))return null;
    if(db.prepare('UPDATE chat_v3_sessions SET pending_turn_id=?,pending_since=?,updated_at=? WHERE principal_scope=? AND session_id=? AND pending_turn_id IS NULL AND deleted_at IS NULL').run(turnId,at,at,scope,sessionId).changes!==1)return null;
    db.prepare("UPDATE chat_v3_pane_queue SET state='sending' WHERE queue_id=? AND state='queued'").run(queued.queue_id);
    db.prepare("INSERT INTO chat_v3_turn_dispatches(session_id,turn_id,principal_id,state,created_at,send_now) VALUES(?,?,?,'queued',?,1)").run(sessionId,turnId,queued.principal_id,at);
    return db.prepare(`${turnDispatchSelect} WHERE d.session_id=? AND d.turn_id=?`).get(sessionId,turnId)||null;
  });}
  function setPaneMessageStatus(scope,sessionId,turnId,status,statusLabel,at=now()) {if(!validOwner(scope,sessionId)||!OPAQUE.test(String(turnId||''))||!['queued','failed','sent'].includes(status)||!statusLabel||!Number.isSafeInteger(at))return false;return withTx(db,()=>{
    const changed=db.prepare("UPDATE chat_v3_messages SET status=?,status_label_json=? WHERE session_id=? AND turn_id=? AND role='user'").run(status,json(statusLabel),sessionId,turnId).changes;
    if(changed)db.prepare('UPDATE chat_v3_sessions SET updated_at=? WHERE principal_scope=? AND session_id=?').run(at,scope,sessionId);
    return changed===1;
  });}
  function cancelPaneMessage(scope,sessionId,turnId,statusLabel,at=now()) {if(!validOwner(scope,sessionId)||!OPAQUE.test(String(turnId||''))||!statusLabel||!Number.isSafeInteger(at))return null;return withTx(db,()=>{
    const queued=db.prepare("SELECT queue_id FROM chat_v3_pane_queue WHERE principal_scope=? AND session_id=? AND turn_id=? AND state='queued'").get(scope,sessionId,turnId);if(!queued)return null;
    const changed=db.prepare("UPDATE chat_v3_messages SET status='cancelled',status_label_json=? WHERE session_id=? AND turn_id=? AND role='user'").run(json(statusLabel),sessionId,turnId).changes;
    if(changed!==1)return null;
    db.prepare('DELETE FROM chat_v3_pane_queue WHERE queue_id=?').run(queued.queue_id);
    db.prepare('UPDATE chat_v3_sessions SET updated_at=? WHERE principal_scope=? AND session_id=?').run(at,scope,sessionId);
    return {turnId,status:'cancelled'};
  });}
  function requeuePaneMessage(sessionId,turnId,statusLabel,at=now()) {if(!OPAQUE.test(String(sessionId||''))||!OPAQUE.test(String(turnId||''))||!statusLabel||!Number.isSafeInteger(at))return false;return withTx(db,()=>{
    let queued=db.prepare("SELECT queue_id FROM chat_v3_pane_queue WHERE session_id=? AND turn_id=? AND state='sending'").get(sessionId,turnId);
    if(!queued){const dispatch=db.prepare(`${turnDispatchSelect} WHERE d.session_id=? AND d.turn_id=?`).get(sessionId,turnId),session=db.prepare('SELECT pane_member_id FROM chat_v3_sessions WHERE session_id=?').get(sessionId);
      const message=db.prepare("SELECT at FROM chat_v3_messages WHERE session_id=? AND turn_id=? AND role='user'").get(sessionId,turnId);
      if(!dispatch||!session?.pane_member_id||!message)return false;
      const inserted=db.prepare(`INSERT OR IGNORE INTO chat_v3_pane_queue(session_id,turn_id,pane_member_id,principal_scope,principal_id,queued_at,state) VALUES(?,?,?,?,?,?,'queued')`)
        .run(sessionId,turnId,session.pane_member_id,dispatch.principal_scope,dispatch.principal_id,message.at);
      queued=inserted.changes?db.prepare('SELECT queue_id FROM chat_v3_pane_queue WHERE session_id=? AND turn_id=?').get(sessionId,turnId):null;
      if(!queued)return false;
    }
    db.prepare("UPDATE chat_v3_messages SET status='queued',status_label_json=? WHERE session_id=? AND turn_id=? AND role='user'").run(json(statusLabel),sessionId,turnId);
    db.prepare('UPDATE chat_v3_sessions SET pending_turn_id=NULL,pending_since=NULL,updated_at=? WHERE session_id=? AND pending_turn_id=?').run(at,sessionId,turnId);
    db.prepare("UPDATE chat_v3_pane_queue SET state='queued' WHERE queue_id=?").run(queued.queue_id);
    db.prepare('DELETE FROM chat_v3_turn_dispatches WHERE session_id=? AND turn_id=?').run(sessionId,turnId);
    return true;
  });}
  function acceptRetry({scope,method,route,key,requestHash,sessionId,turnId,at,principalId=null,attachmentIds=[],ttlMs=86400000}) {
    if(!HEX64.test(String(scope||''))||!/^[A-Z]+$/.test(String(method||''))||typeof route!=='string'||route.length>256||!/^[A-Za-z0-9._~-]{16,128}$/.test(String(key||''))||!HEX64.test(String(requestHash||''))||!OPAQUE.test(String(sessionId||''))||!OPAQUE.test(String(turnId||''))||!Number.isSafeInteger(at)||principalId!==null&&(typeof principalId!=='string'||principalId.length<1||principalId.length>128)||!Array.isArray(attachmentIds)||new Set(attachmentIds).size!==attachmentIds.length||attachmentIds.some(id=>!OPAQUE.test(String(id||'')))||!Number.isSafeInteger(ttlMs)||ttlMs<1)throw new Error('invalid chat retry acceptance');
    return withTx(db,()=>{
      const t=now(),old=db.prepare('SELECT * FROM chat_v3_idempotency WHERE principal_scope=? AND method=? AND route_key=? AND idem_key=?').get(scope,method,route,key);
      if(old&&old.expires_at<=t)db.prepare('DELETE FROM chat_v3_idempotency WHERE principal_scope=? AND method=? AND route_key=? AND idem_key=?').run(scope,method,route,key);
      else if(old){if(old.request_hash!==requestHash)return {kind:'conflict'};return {kind:old.state,result:old.result_json?JSON.parse(old.result_json):null,status:old.status_code};}
      const session=db.prepare('SELECT * FROM chat_v3_sessions WHERE principal_scope=? AND session_id=? AND deleted_at IS NULL').get(scope,sessionId);
      if(!session||session.retry_eligible_turn_id!==turnId||session.pending_turn_id||!db.prepare("SELECT 1 AS ok FROM chat_v3_messages WHERE session_id=? AND role='user' AND turn_id=?").get(sessionId,turnId))return {kind:'not-found'};
      const attachments=attachmentIds.map(id=>db.prepare("SELECT attachment_id FROM chat_v3_attachments WHERE principal_scope=? AND session_id=? AND attachment_id=? AND state='consumed'").get(scope,sessionId,id));
      if(attachments.some(row=>!row))return {kind:'not-found'};
      for(const id of attachmentIds)if(db.prepare("UPDATE chat_v3_attachments SET state='bound',consumed_at=NULL WHERE principal_scope=? AND session_id=? AND attachment_id=? AND state='consumed'").run(scope,sessionId,id).changes!==1)throw new Error('chat retry attachment reservation lost');
      const changed=db.prepare('UPDATE chat_v3_sessions SET pending_turn_id=?,pending_since=?,updated_at=?,retry_eligible_turn_id=NULL WHERE principal_scope=? AND session_id=? AND pending_turn_id IS NULL AND retry_eligible_turn_id=? AND deleted_at IS NULL').run(turnId,at,at,scope,sessionId,turnId).changes;
      if(changed!==1)throw new Error('chat retry acceptance lost session reservation');
      const result={turnId};
      db.prepare(`INSERT INTO chat_v3_idempotency(principal_scope,method,route_key,idem_key,request_hash,state,status_code,result_json,created_at,expires_at) VALUES(?,?,?,?,?,'uncertain',202,?,?,?)`).run(scope,method,route,key,requestHash,json(result),t,t+ttlMs);
      db.prepare("INSERT INTO chat_v3_turn_dispatches(session_id,turn_id,principal_id,state,created_at) VALUES(?,?,?,'queued',?)").run(sessionId,turnId,principalId,t);
      return {kind:'accepted',result,status:202};
    });
  }
  const turnDispatchSelect=`SELECT d.session_id,d.turn_id,d.principal_id,d.state,d.created_at,d.send_now,s.principal_scope,s.agent_id,s.runtime_id,s.native_agent_id,s.native_session_ref,t.target_kind,t.source_ref,t.runtime_id AS target_runtime_id,t.native_agent_id AS target_native_agent_id
    FROM chat_v3_turn_dispatches d JOIN chat_v3_sessions s ON s.session_id=d.session_id JOIN chat_v3_targets t ON t.target_id=s.agent_id`;
  function queuedTurnDispatches(limit=64,offset=0){return db.prepare(`${turnDispatchSelect} WHERE d.state='queued' ORDER BY d.created_at,d.session_id LIMIT ? OFFSET ?`).all(Math.min(256,Math.max(1,limit)),Math.max(0,Number.isSafeInteger(offset)?offset:0));}
  function dispatchingTurnDispatches(limit=256,after=null){const size=Math.min(256,Math.max(1,limit));return after?
    db.prepare(`${turnDispatchSelect} WHERE d.state='dispatching' AND (d.created_at>? OR (d.created_at=? AND d.session_id>?)) ORDER BY d.created_at,d.session_id LIMIT ?`).all(after.created_at,after.created_at,after.session_id,size):
    db.prepare(`${turnDispatchSelect} WHERE d.state='dispatching' ORDER BY d.created_at,d.session_id LIMIT ?`).all(size);}
  function pendingWithoutDispatches(limit=256,after=null){const size=Math.min(256,Math.max(1,limit)),base=`SELECT s.session_id,s.principal_scope,s.agent_id,s.pending_turn_id,s.pending_since FROM chat_v3_sessions s
    WHERE s.deleted_at IS NULL AND s.pending_turn_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM chat_v3_turn_dispatches d WHERE d.session_id=s.session_id)`;return after?
      db.prepare(`${base} AND (s.pending_since>? OR (s.pending_since=? AND s.session_id>?)) ORDER BY s.pending_since,s.session_id LIMIT ?`).all(after.pending_since,after.pending_since,after.session_id,size):
      db.prepare(`${base} ORDER BY s.pending_since,s.session_id LIMIT ?`).all(size);}
  function claimTurnDispatch(sessionId,turnId){return withTx(db,()=>{const changed=db.prepare("UPDATE chat_v3_turn_dispatches SET state='dispatching' WHERE session_id=? AND turn_id=? AND state='queued'").run(sessionId,turnId).changes;if(changed!==1)return null;return db.prepare(`${turnDispatchSelect} WHERE d.session_id=? AND d.turn_id=?`).get(sessionId,turnId)||null;});}
  function completeTurnDispatch(sessionId,turnId,message,{attachmentIds=[],retryEligible=false,unread=false}={}){return withTx(db,()=>{
    const dispatch=db.prepare("SELECT 1 AS ok FROM chat_v3_turn_dispatches WHERE session_id=? AND turn_id=? AND state='dispatching'").get(sessionId,turnId);if(!dispatch)return false;
    const session=db.prepare('SELECT pending_turn_id FROM chat_v3_sessions WHERE session_id=? AND deleted_at IS NULL').get(sessionId);if(!session||session.pending_turn_id!==turnId)return false;
    const messages=Array.isArray(message)?message:[message];if(!messages.length||messages.some(row=>!row||!['assistant','error'].includes(row.role)))throw new Error('invalid completed chat turn');
    // Keep each normalized result tied to the accepted turn so scoped
    // projections (for example project kickoff status) can resolve delivery.
    for(const row of messages)addMessage(sessionId,{...row,turnId:row.turnId||turnId},{unread});
    db.prepare('UPDATE chat_v3_sessions SET retry_eligible_turn_id=? WHERE session_id=?').run(retryEligible?turnId:null,sessionId);
    for(const id of attachmentIds)db.prepare("UPDATE chat_v3_attachments SET state='consumed',consumed_at=? WHERE attachment_id=? AND state='bound'").run(now(),id);
    db.prepare('DELETE FROM chat_v3_turn_dispatches WHERE session_id=? AND turn_id=?').run(sessionId,turnId);
    db.prepare('DELETE FROM chat_v3_pane_queue WHERE session_id=? AND turn_id=?').run(sessionId,turnId);
    return true;
  });}
  function resolvePendingWithoutDispatch(sessionId,turnId,message,{attachmentIds=[]}={}){return withTx(db,()=>{
    const session=db.prepare('SELECT pending_turn_id FROM chat_v3_sessions WHERE session_id=? AND deleted_at IS NULL').get(sessionId);
    if(!session||session.pending_turn_id!==turnId||db.prepare('SELECT 1 AS ok FROM chat_v3_turn_dispatches WHERE session_id=? AND turn_id=?').get(sessionId,turnId))return false;
    addMessage(sessionId,message);
    db.prepare('UPDATE chat_v3_sessions SET retry_eligible_turn_id=NULL WHERE session_id=?').run(sessionId);
    for(const id of attachmentIds)db.prepare("UPDATE chat_v3_attachments SET state='consumed',consumed_at=? WHERE attachment_id=? AND state IN ('bound','staged')").run(now(),id);
    db.prepare('DELETE FROM chat_v3_pane_queue WHERE session_id=? AND turn_id=?').run(sessionId,turnId);
    return true;
  });}
  function discardTurnDispatch(sessionId,turnId){return withTx(db,()=>{const removed=db.prepare('DELETE FROM chat_v3_turn_dispatches WHERE session_id=? AND turn_id=?').run(sessionId,turnId).changes>0;
    db.prepare('DELETE FROM chat_v3_pane_queue WHERE session_id=? AND turn_id=?').run(sessionId,turnId);return removed;});}
  function completeIdempotency({scope,method,route,key,requestHash,status,result,state='complete'}) {
    db.prepare(`UPDATE chat_v3_idempotency SET state=?,status_code=?,result_json=? WHERE principal_scope=? AND method=? AND route_key=? AND idem_key=? AND request_hash=?`).run(state,status,json(result),scope,method,route,key,requestHash);
  }
  function abandonIdempotency({scope,method,route,key,requestHash}) {return db.prepare("DELETE FROM chat_v3_idempotency WHERE principal_scope=? AND method=? AND route_key=? AND idem_key=? AND request_hash=? AND state='in-flight'").run(scope,method,route,key,requestHash).changes>0;}
  function prune(t=now(),limit=50,removeStorage=()=>false) {if(!Number.isSafeInteger(t)||!Number.isSafeInteger(limit)||limit<1||limit>100||typeof removeStorage!=='function')throw new Error('invalid chat prune bounds');return withTx(db,()=>{
    const sessions=db.prepare('SELECT session_id,principal_scope FROM chat_v3_sessions WHERE deleted_at IS NOT NULL AND delete_after IS NOT NULL AND delete_after<=? ORDER BY delete_after,session_id LIMIT ?').all(t,limit);
    const storageNames=[];
    let purgedSessions=0;
    for(const row of sessions){
      const names=db.prepare('SELECT storage_name FROM chat_v3_attachments WHERE principal_scope=? AND session_id=?').all(row.principal_scope,row.session_id).map(item=>item.storage_name);
      let filesRemoved=true;
      for(const name of names){let removed=false;try{removed=removeStorage(name)===true;}catch{}if(removed)storageNames.push(name);else filesRemoved=false;}
      if(filesRemoved)purgedSessions+=db.prepare('DELETE FROM chat_v3_sessions WHERE principal_scope=? AND session_id=? AND deleted_at IS NOT NULL AND delete_after<=?').run(row.principal_scope,row.session_id,t).changes;
    }
    const expiredAttachments=db.prepare("SELECT rowid,storage_name FROM chat_v3_attachments WHERE (state='staged' AND expires_at<=?) OR (state IN ('bound','consumed') AND coalesce(consumed_at,created_at)<=?) ORDER BY created_at,attachment_id LIMIT ?").all(t,t-30*86400000,limit);
    let purgedAttachments=0;
    for(const row of expiredAttachments){let removed=false;try{removed=removeStorage(row.storage_name)===true;}catch{}if(!removed)continue;storageNames.push(row.storage_name);purgedAttachments+=db.prepare('DELETE FROM chat_v3_attachments WHERE rowid=?').run(row.rowid).changes;}
    return {idempotency:db.prepare('DELETE FROM chat_v3_idempotency WHERE rowid IN (SELECT rowid FROM chat_v3_idempotency WHERE expires_at<=? LIMIT ?)').run(t,limit).changes,
      uploads:db.prepare('DELETE FROM chat_v3_upload_reservations WHERE rowid IN (SELECT rowid FROM chat_v3_upload_reservations WHERE expires_at<=? LIMIT ?)').run(t,limit).changes,
      attachments:purgedAttachments,sessions:purgedSessions,storageNames:[...new Set(storageNames.filter(name=>/^[a-f0-9]{64}$/.test(name)))]};
  }); }
  function attachment(row) { if(!validOwner(row.principalScope,row.attachmentId)||!OPAQUE.test(row.sessionId)||!CHAT_MIME.has(row.mimeType)||!Number.isSafeInteger(row.size)||row.size<1||row.size>20971520||!HEX64.test(row.sha256)||!/^[a-f0-9]{64}$/.test(row.storageName))throw new Error('invalid attachment');
    db.prepare(`INSERT INTO chat_v3_attachments(attachment_id,principal_scope,session_id,display_name,mime_type,byte_size,sha256,storage_name,state,created_at,expires_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(row.attachmentId,row.principalScope,row.sessionId,row.name,row.mimeType,row.size,row.sha256,row.storageName,'staged',now(),now()+15*60000);
  }
  function reserveUpload(scope,id,bytes,{sessionId,maxBytes=104857600,maxCountPerSession=Infinity,ttlMs=30*60000}={}) {
    if(!HEX64.test(String(scope||''))||!/^[a-f0-9]{64}$/.test(String(id||''))||!OPAQUE.test(String(sessionId||''))||!Number.isSafeInteger(bytes)||bytes<1||bytes>20971520||!(maxCountPerSession===Infinity||Number.isSafeInteger(maxCountPerSession)&&maxCountPerSession>0))throw new Error('invalid upload reservation');
    return withTx(db,()=>{const t=now();db.prepare('DELETE FROM chat_v3_upload_reservations WHERE expires_at<=?').run(t);
      const session=db.prepare('SELECT 1 AS ok FROM chat_v3_sessions WHERE principal_scope=? AND session_id=? AND deleted_at IS NULL').get(scope,sessionId);if(!session)return false;
      const count=db.prepare("SELECT (SELECT count(*) FROM chat_v3_attachments WHERE principal_scope=? AND session_id=? AND state IN ('staged','bound','consumed')) + (SELECT count(*) FROM chat_v3_upload_reservations WHERE principal_scope=? AND session_id=? AND expires_at>?) AS n").get(scope,sessionId,scope,sessionId,t).n;
      if(count>=maxCountPerSession)return false;
      const used=db.prepare('SELECT coalesce(sum(byte_size),0) AS n FROM chat_v3_attachments WHERE principal_scope=?').get(scope).n;
      const reserved=db.prepare('SELECT coalesce(sum(reserved_bytes),0) AS n FROM chat_v3_upload_reservations WHERE principal_scope=?').get(scope).n;
      if(used+reserved+bytes>maxBytes)return false;
      db.prepare('INSERT INTO chat_v3_upload_reservations(reservation_id,principal_scope,session_id,reserved_bytes,created_at,expires_at) VALUES(?,?,?,?,?,?)').run(id,scope,sessionId,bytes,t,t+ttlMs);return true;});
  }
  function releaseUpload(id){return db.prepare('DELETE FROM chat_v3_upload_reservations WHERE reservation_id=?').run(id).changes>0;}
  function addAttachment(row,reservationId) {return withTx(db,()=>{const reservation=db.prepare('SELECT * FROM chat_v3_upload_reservations WHERE reservation_id=? AND principal_scope=? AND session_id=?').get(reservationId,row.principalScope,row.sessionId);if(!reservation||row.size>reservation.reserved_bytes)throw new Error('missing upload reservation');attachment(row);releaseUpload(reservationId);});}
  function ownedAttachment(scope,sessionId,id) { if(!validOwner(scope,id)||!OPAQUE.test(sessionId))return null;return db.prepare("SELECT * FROM chat_v3_attachments WHERE principal_scope=? AND session_id=? AND attachment_id=? AND state IN ('staged','bound','consumed')").get(scope,sessionId,id)||null; }
  function attachmentById(scope,id) {if(!validOwner(scope,id))return null;return db.prepare('SELECT * FROM chat_v3_attachments WHERE principal_scope=? AND attachment_id=?').get(scope,id)||null;}
  function attachmentCount(scope,sessionId) {if(!HEX64.test(String(scope||''))||!OPAQUE.test(String(sessionId||'')))return 0;return db.prepare("SELECT count(*) AS n FROM chat_v3_attachments WHERE principal_scope=? AND session_id=? AND state IN ('staged','bound','consumed')").get(scope,sessionId).n;}
  function attachmentRowsForSession(sessionId){if(!OPAQUE.test(String(sessionId||'')))return [];return db.prepare('SELECT attachment_id,display_name,mime_type,byte_size FROM chat_v3_attachments WHERE session_id=?').all(sessionId);}
  function attachmentInboxTargets(limit=256, cursor=null){
    if(!Number.isSafeInteger(limit)||limit<1||limit>256)return {targets:[],nextCursor:cursor,done:true};
    const rows=cursor&&typeof cursor.principalScope==='string'&&typeof cursor.runtimeId==='string'&&typeof cursor.nativeAgentId==='string'
      ? db.prepare(`SELECT a.principal_scope,s.runtime_id,s.native_agent_id FROM chat_v3_attachments a
          JOIN chat_v3_sessions s ON s.session_id=a.session_id WHERE a.state IN ('bound','consumed')
          GROUP BY a.principal_scope,s.runtime_id,s.native_agent_id
          HAVING (a.principal_scope,s.runtime_id,s.native_agent_id)>(?,?,?)
          ORDER BY a.principal_scope,s.runtime_id,s.native_agent_id LIMIT ?`).all(cursor.principalScope,cursor.runtimeId,cursor.nativeAgentId,limit)
      : db.prepare(`SELECT a.principal_scope,s.runtime_id,s.native_agent_id FROM chat_v3_attachments a
          JOIN chat_v3_sessions s ON s.session_id=a.session_id WHERE a.state IN ('bound','consumed')
          GROUP BY a.principal_scope,s.runtime_id,s.native_agent_id
          ORDER BY a.principal_scope,s.runtime_id,s.native_agent_id LIMIT ?`).all(limit);
    const targets=rows.map(row=>({principal_scope:row.principal_scope,runtime_id:row.runtime_id,native_agent_id:row.native_agent_id}));
    if(!targets.length)return {targets,nextCursor:null,done:true};
    const last=targets.at(-1),nextCursor={principalScope:last.principal_scope,runtimeId:last.runtime_id,nativeAgentId:last.native_agent_id};
    const hasMore=!!db.prepare(`SELECT 1 AS found FROM chat_v3_attachments a JOIN chat_v3_sessions s ON s.session_id=a.session_id
      WHERE a.state IN ('bound','consumed') GROUP BY a.principal_scope,s.runtime_id,s.native_agent_id
      HAVING (a.principal_scope,s.runtime_id,s.native_agent_id)>(?,?,?) LIMIT 1`).get(nextCursor.principalScope,nextCursor.runtimeId,nextCursor.nativeAgentId);
    return {targets,nextCursor:hasMore?nextCursor:null,done:!hasMore};
  }
  function storageNameExists(name) {return /^[a-f0-9]{64}$/.test(String(name||''))&&!!db.prepare('SELECT 1 AS ok FROM chat_v3_attachments WHERE storage_name=?').get(name);}
  function cancelAttachment(scope,sessionId,id) {return withTx(db,()=>{const row=ownedAttachment(scope,sessionId,id);if(!row)return null;if(row.state!=='staged')return false;db.prepare('DELETE FROM chat_v3_attachments WHERE attachment_id=?').run(id);return row;});}
  function bindAttachments(scope,sessionId,ids) {return withTx(db,()=>{const rows=ids.map(id=>ownedAttachment(scope,sessionId,id));if(rows.some(row=>!row||row.state!=='staged'||row.expires_at<=now()))return null;
    for(const row of rows)db.prepare("UPDATE chat_v3_attachments SET state='bound' WHERE attachment_id=? AND state='staged'").run(row.attachment_id);return rows;});}
  function finishAttachments(ids) {if(!ids.length)return;withTx(db,()=>{for(const id of ids)db.prepare("UPDATE chat_v3_attachments SET state='consumed',consumed_at=? WHERE attachment_id=? AND state='bound'").run(now(),id);});}
  return { createTarget,targetForRef,target,targetRows,createSession,get,list,hasPaneSessions,activeSummary,archivedCount,renameSession,setArchived,softDelete,undoDelete,purgeExpired,all,sessionRefsForRuntime,messages,messageForTurn,addMessage,setPending,clearPending,acknowledge,reserveIdempotency,idempotencyResult,acceptTurn,enqueuePaneMessage,hasPaneQueue,queuedPaneMessage,paneHasPending,queuedPaneMembers,promotePaneQueue,sendQueuedPaneNow,setPaneMessageStatus,cancelPaneMessage,requeuePaneMessage,acceptRetry,queuedTurnDispatches,dispatchingTurnDispatches,pendingWithoutDispatches,claimTurnDispatch,completeTurnDispatch,resolvePendingWithoutDispatch,discardTurnDispatch,completeIdempotency,abandonIdempotency,prune,attachment,addAttachment,ownedAttachment,attachmentById,attachmentCount,attachmentRowsForSession,attachmentInboxTargets,storageNameExists,cancelAttachment,reserveUpload,releaseUpload,bindAttachments,finishAttachments };
}
module.exports={createChatV3Repo,CHAT_MIME,OPAQUE};
