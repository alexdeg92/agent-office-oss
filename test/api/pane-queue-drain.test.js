'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {drainQueuedPaneMembers}=require('../../src/api/v3/pane-queue-drain');

test('busy earliest pane pages do not starve idle panes after member 256',async()=>{
  const members=Array.from({length:620},(_,n)=>`member:${String(n).padStart(4,'0')}`),busy=new Set(members.slice(0,310)),visited=[],delivered=[];
  const listPage=(limit,cursor,throughQueueId)=>{
    visited.push(cursor);
    const page=members.filter(member=>member>cursor).slice(0,limit);
    return {members:page,nextCursor:page.at(-1)||cursor,throughQueueId:throughQueueId??members.length,done:page.length<limit};
  };
  await drainQueuedPaneMembers({listPage,pageSize:256,visit:async member=>{if(!busy.has(member))delivered.push(member);}});
  assert.equal(visited.length,3,'the drain scans later keyset pages even when the first page remains busy');
  assert.deepEqual(delivered,members.slice(310),'later idle panes all get a drain attempt');
});
