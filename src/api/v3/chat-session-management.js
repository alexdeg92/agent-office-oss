'use strict';

const {ApiError,invalid}=require('../v2/errors');
const {LABELS}=require('../../i18n/fr');

const DELETION_WINDOW_MS=30000;
const MAX_PURGE_PER_REQUEST=20;
const label=(key,params=null)=>({key,...(params?{params}:{})});

function cleanTitle(value){
  if(typeof value!=='string')return null;
  const normalized=value.normalize('NFKC').trim();
  if(!normalized||Array.from(normalized).length>120||/[\u0000-\u001f\u007f\u200e\u200f\u202a-\u202e\u2066-\u2069]/.test(normalized))return null;
  return normalized;
}

function buildSessionRows(repo,owner,targetId,filter,previewFor){
  return repo.list(owner,targetId,{filter}).map(row=>({
    id:row.session_id,title:row.title||label('chat.newSession'),preview:previewFor(row.session_id),updatedAt:row.updated_at||null,
    unread:{count:row.unread_count,label:row.unread_count?label('chat.unread.count',{count:row.unread_count}):label('chat.unread.none')},
    stateLabel:row.archived_at?label('chat.session.archived'):label(row.pending_turn_id?'chat.session.waiting':'chat.session.idle'),
    turnPending:!!row.pending_turn_id,archived:row.archived_at!=null,
    actions:{rename:true,archive:row.archived_at==null,restore:row.archived_at!=null,delete:!row.pending_turn_id},
    runtimeTranscriptDeleteLabel:label('chat.session.runtimeTranscriptRetained'),
  }));
}

function listLabels(filter,archivedCount){return {
  active:label('chat.sessions.active'),archived:label('chat.sessions.archived'),
  archivedCount:label(archivedCount?'chat.sessions.archivedCount':'chat.sessions.noArchived',{count:archivedCount}),
  empty:label(filter==='archived'?'chat.sessions.emptyArchived':'chat.sessions.emptyActive'),
};}

function mountChatSessionManagement({r,repo,authed,scopeOf,requireGrant,reserve,respondReplay,complete,abandon,invalidate,
  checkVersion,mutationOk,now=()=>Date.now(),purgeExpired=()=>{},onPurge=()=>{},onDelete=()=>{},readonly=()=>false}){
  const ownerSession=(req,id)=>repo.get(scopeOf(req),id);
  const write=(req)=>{requireGrant(req,'chat','write');if(readonly())throw new ApiError('readonly');};
  const body=(req,fields)=>{const value=req.body||{};if(!value||typeof value!=='object'||Array.isArray(value))throw invalid(null,'invalid-body');for(const key of Object.keys(value))if(!fields.includes(key))throw invalid(key,'unexpected-field');return value;};
  const finish=(res,reservation,result)=>{complete(reservation,200,result);res.status(200);mutationOk(res,{ok:true,result,revision:null,vm:null});};
  const afterPurge=owner=>{const result=purgeExpired(owner,now(),MAX_PURGE_PER_REQUEST);if(result?.sessions?.length)onPurge(owner,result);};

  r.patch('/chat/sessions/:sessionId/title',authed,(req,res)=>{
    checkVersion(req);write(req);const input=body(req,['title']),title=cleanTitle(input.title);if(!title)throw invalid('title','invalid');
    const route='/chat/sessions/:sessionId/title',payload={sessionId:req.params.sessionId,title},reservation=reserve(req,route,payload);if(respondReplay(res,reservation))return;
    const row=ownerSession(req,req.params.sessionId);if(!row){abandon(reservation);throw new ApiError('not_found');}
    const changed=repo.renameSession(scopeOf(req),row.session_id,title,now());if(changed?.kind==='turn-pending'){abandon(reservation);throw new ApiError('conflict',{details:[{issue:'turn-pending'}]});}if(!changed){abandon(reservation);throw new ApiError('not_found');}
    const result={sessionId:row.session_id,title};finish(res,reservation,result);invalidate(row.session_id,scopeOf(req),row.agent_id);
  });

  r.post('/chat/sessions/:sessionId/archive',authed,(req,res)=>{
    checkVersion(req);write(req);const input=body(req,['archived']);if(typeof input.archived!=='boolean')throw invalid('archived','invalid');
    const route='/chat/sessions/:sessionId/archive',payload={sessionId:req.params.sessionId,archived:input.archived},reservation=reserve(req,route,payload);if(respondReplay(res,reservation))return;
    const row=ownerSession(req,req.params.sessionId);if(!row){abandon(reservation);throw new ApiError('not_found');}
    const changed=repo.setArchived(scopeOf(req),row.session_id,input.archived,now());if(!changed){abandon(reservation);throw new ApiError('not_found');}
    const result={sessionId:row.session_id,archived:changed.archived};finish(res,reservation,result);invalidate(row.session_id,scopeOf(req),row.agent_id);
  });

  r.delete('/chat/sessions/:sessionId',authed,async(req,res)=>{
    checkVersion(req);write(req);if(req.body&&Object.keys(req.body).length)throw invalid(null,'unexpected-field');
    const route='/chat/sessions/:sessionId',payload={sessionId:req.params.sessionId},reservation=reserve(req,route,payload);if(respondReplay(res,reservation))return;
    const row=ownerSession(req,req.params.sessionId);if(!row){abandon(reservation);throw new ApiError('not_found');}
    const deleted=repo.softDelete(scopeOf(req),row.session_id,now(),DELETION_WINDOW_MS);if(deleted?.kind==='turn-pending'){abandon(reservation);throw new ApiError('conflict',{details:[{issue:'turn-pending'}]});}if(!deleted){abandon(reservation);throw new ApiError('not_found');}
    try{await onDelete(scopeOf(req),row);}catch{}
    const result={sessionId:row.session_id,deletedAt:deleted.deletedAt,undoUntil:deleted.undoUntil,deletedLabel:label('chat.session.deletedUndoable'),
      runtimeTranscriptDeleted:false,runtimeTranscriptLabel:label('chat.session.runtimeTranscriptRetained')};
    finish(res,reservation,result);invalidate(row.session_id,scopeOf(req),row.agent_id);
  });

  r.post('/chat/sessions/:sessionId/undo-delete',authed,(req,res)=>{
    checkVersion(req);write(req);if(req.body&&Object.keys(req.body).length)throw invalid(null,'unexpected-field');
    const route='/chat/sessions/:sessionId/undo-delete',payload={sessionId:req.params.sessionId},reservation=reserve(req,route,payload);if(respondReplay(res,reservation))return;
    const owner=scopeOf(req);afterPurge(owner);
    const restored=repo.undoDelete(owner,req.params.sessionId,now());if(!restored||restored.kind==='expired'){abandon(reservation);throw new ApiError('not_found');}
    const result={sessionId:req.params.sessionId,restored:true};finish(res,reservation,result);invalidate(req.params.sessionId,owner,restored.session.agent_id);
  });
}

module.exports={mountChatSessionManagement,buildSessionRows,listLabels,cleanTitle,DELETION_WINDOW_MS,MAX_PURGE_PER_REQUEST};
