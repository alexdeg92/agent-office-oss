'use strict';

async function pruneAttachmentInboxPage({repo,cursor,runtimeForInstance,runtimeOf,attachmentFilePort,now,log}){
  const page=repo.attachmentInboxTargets?.(256,cursor);
  if(!page)return {cursor,failures:0};
  let failures=0;
  for(const target of page.targets){
    try{
      const runtime=runtimeForInstance?.(target.runtime_id)||runtimeOf(target.native_agent_id);
      const port=attachmentFilePort(runtime);
      if(port)await port.prune({agentId:target.native_agent_id,principalScope:target.principal_scope,olderThan:now()-86400000,limit:50});
    }catch{failures++;}
  }
  if(failures)try{log({event:'chat.attachment.inbox_prune_failed',count:failures});}catch{}
  return {cursor:page.done?null:page.nextCursor,failures};
}

module.exports={pruneAttachmentInboxPage};
