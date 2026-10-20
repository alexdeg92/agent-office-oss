'use strict';

async function drainQueuedPaneMembers({listPage,visit,isClosed=()=>false,pageSize=256}){
  if(typeof listPage!=='function'||typeof visit!=='function')throw new TypeError('pane queue drain requires listPage and visit');
  let cursor='',throughQueueId=null;
  while(!isClosed()){
    const page=listPage(pageSize,cursor,throughQueueId);
    if(!page||!Array.isArray(page.members)||!Number.isSafeInteger(page.throughQueueId))return;
    throughQueueId=page.throughQueueId;
    if(!page.members.length)return;
    for(const memberId of page.members){
      if(isClosed())return;
      if(typeof memberId==='string'&&memberId)await visit(memberId);
    }
    if(page.done||typeof page.nextCursor!=='string'||page.nextCursor<=cursor)return;
    cursor=page.nextCursor;
  }
}

module.exports={drainQueuedPaneMembers};
