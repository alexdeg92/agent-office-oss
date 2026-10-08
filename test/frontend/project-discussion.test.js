import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seed, buildProjectVM, buildCommentsVM, commentCommand, replyToComment, requestSummary, timmyMove } from '../../public/v2/mock/projects.js';
import { applyOps } from '../../public/v2/delta.js';
import { diff } from '../../public/v2/mock/diff.js';

const id = 'prj_veille';
test('frontend-26 mock: mentions → pending → live reply; system lines; edits never re-deliver; deletion keeps the row', () => {
  const db = seed();
  const first = buildCommentsVM(db,id);
  assert.ok(first.items.length);
  const agent = first.mentionable[0];
  const out = commentCommand(db,'POST',id,null,{body:`@${agent.id} Prépare le suivi.`});
  assert.equal(out.comment.delivery[0].status,'pending');
  const pending = buildCommentsVM(db,id);
  replyToComment(db,id,out.comment);
  timmyMove(db);
  const next = buildCommentsVM(db,id);
  assert.deepEqual(applyOps(pending,diff(pending,next)),JSON.parse(JSON.stringify(next)));
  const reply = next.items.find((c) => c.replyTo === out.comment.id);
  assert.equal(reply.author.kind,'agent');
  assert.equal(next.items.find((c) => c.id === out.comment.id).delivery[0].status,'replied');
  assert.ok(next.items.some((c) => c.kind === 'system' && c.text.key === 'historyKind.status'));
  const edited = commentCommand(db,'PATCH',id,out.comment.id,{body:'Texte corrigé'});
  assert.ok(edited.comment.editedAt);
  assert.equal(edited.comment.delivery[0].status,'replied');
  assert.equal(commentCommand(db,'PATCH',id,reply.id,{body:'Interdit'}).error[0],403);
  commentCommand(db,'DELETE',id,out.comment.id);
  assert.equal(buildCommentsVM(db,id).items.find((c) => c.id === out.comment.id).deleted,true);
});
test('frontend-26 mock: mentions by name, duplicates, failure/unavailable states, validation and pagination', () => {
  const db = seed(), a = buildCommentsVM(db,id).mentionable[0];
  const c = commentCommand(db,'POST',id,null,{body:`@${a.name} @${a.id} Bonjour`},{canMention:false}).comment;
  assert.equal(c.mentions.length,1);
  assert.equal(c.delivery[0].status,'unavailable');
  const pending = commentCommand(db,'POST',id,null,{body:`@${a.id} Vérifie`}).comment;
  replyToComment(db,id,pending,{fail:true});
  assert.equal(pending.delivery[0].status,'failed');
  assert.equal(commentCommand(db,'POST',id,null,{body:''}).error[0],400);
  assert.equal(commentCommand(db,'POST',id,null,{body:'x'.repeat(4001)}).error[0],400);
  assert.equal(commentCommand(db,'POST','missing',null,{body:'x'}).error[0],404);
  for (let i=0;i<60;i++) commentCommand(db,'POST',id,null,{body:'Message '+i});
  const page = buildCommentsVM(db,id), older = buildCommentsVM(db,id,{cursor:page.nextCursor});
  assert.equal(page.items.length,50);
  assert.ok(older.items.length);
  assert.ok(older.items.every((c) => !page.items.some((x) => x.id===c.id)));
});
test('frontend-26 mock: summary request is accepted, appears in the thread and updates summary on reply', () => {
  const db=seed(), p=buildProjectVM(db,id);
  const r=requestSummary(db,id,{expectedRevision:p.revision});
  assert.equal(r.comment.kind,'event');
  assert.equal(r.comment.text.key,'projectThread.event.summary-requested');
  assert.equal(requestSummary(db,id,{expectedRevision:p.revision}).error[0],409);
  replyToComment(db,id,r.comment,{summary:true});
  const next=buildProjectVM(db,id);
  assert.notEqual(next.summary,p.summary);
  assert.ok(buildCommentsVM(db,id).items.some((c) => c.replyTo===r.comment.id));
});
test('frontend-26 mock: session rows keep structured who, summary, count and key after conform', () => {
  const db=seed();
  for (const projectId of ['prj_veille','prj_portail']) {
    const e=buildProjectVM(db,projectId).recentHistory.find((e) => e.kind==='session');
    assert.ok(e.session.summary);
    assert.equal(e.session.messages,14);
    assert.match(e.session.route,/^\/journaux\//);
    assert.equal(e.text.params.session.key,e.session.label.key);
  }
});

import { mentionQuery, insertMention } from '../../public/v2/pages/project-mentions.js';
import { sessionRow, conversationDigest } from '../../public/v2/pages/project-history.js';
import { setLang, setMeta } from '../../public/v2/i18n.js';
import { META } from '../../public/v2/mock/meta.js';
test('frontend-26: autocomplete works at caret, ignores emails, and keeps surrounding text', () => {
  const agents=[{id:'main',name:'Atlas'},{id:'scout',name:'Scout'}];
  assert.equal(mentionQuery('mail@sc',7,agents),null);
  const q=mentionQuery('Bonjour @sc demain',11,agents);
  assert.equal(q.items[0].id,'scout');
  assert.deepEqual(insertMention('Bonjour @sc demain',q,agents[1]),{body:'Bonjour @scout  demain',caret:15});
  assert.equal(mentionQuery('@at',3,agents).items[0].id,'main');
});
test('frontend-26: history fallback has no raw keys or placeholders, in FR/EN, and keeps zero counts', () => {
  setMeta(META);
  for (const lang of ['fr','en']) {
    setLang(lang);
    const e={actor:{name:'Atlas'},text:{key:'historyKind.missing',params:{session:'agent:main:unknown',messages:null}}};
    const row=sessionRow(e);
    assert.equal(row.who,'Atlas');
    assert.equal(row.key,'agent:main:unknown');
    assert.doesNotMatch(row.summary+row.messages,/\{messages\}|historyKind|agent:main/);
    e.session={key:'agent:main:test',label:{key:'historySession.conversation',params:{agent:'Atlas'}},messages:0};
    assert.equal(sessionRow(e).who,'Atlas','an incomplete LabelRef falls back to actor');
    assert.equal(sessionRow(e).messages,lang==='fr' ? 'Aucun message' : 'No messages');
  }
  setLang('fr');
});

import { threadItems, pendingSummary } from '../../public/v2/pages/project-thread.js';
test('frontend-26: replies stay under their parent; skewed timestamps keep insertion order; summary waits for reply', () => {
  const event={id:'e',at:100,kind:'event',text:{key:'projectThread.event.summary-requested'},delivery:[],replyTo:null};
  const another={id:'other',at:50,replyTo:null};
  const reply={id:'r',at:60,replyTo:'e'};
  assert.equal(pendingSummary([event,another]),true);
  assert.equal(pendingSummary([event,another,reply]),false);
  assert.deepEqual(threadItems([event,another,reply]).map((x) => [x.item.id,x.reply]),[['e',false],['r',true],['other',false]]);
  assert.deepEqual(threadItems([reply]).map((x) => x.item.id),['r'],'reply whose parent is on an older page stays visible');
});

test('frontend-28: preview keeps four person/agent messages and demand/actions/result; newest thread groups follow live replies', () => {
  const events = [{id:'u',kind:'user',sender:'Camille',text:'Prépare le plan'}, {kind:'tool',name:'write'},
    ...Array.from({length:4},(_,i)=>({id:'a'+i,kind:'assistant',text:'Réponse '+i}))];
  const preview=conversationDigest(events);
  assert.equal(preview.ask.sender,'Camille');
  assert.equal(preview.result.text,'Réponse 3');
  assert.equal(preview.steps,1);
  assert.deepEqual(preview.messages.map((e)=>e.id),['a0','a1','a2','a3']);
  const detailed='Le plan comprend trois envois mensuels, un calendrier et les tâches de préparation de chaque édition.';
  const summary=conversationDigest([{kind:'user',text:'[Subagent Context] contexte\n[Subagent Task]\nPrépare les trois éditions.'},
    {kind:'assistant',text:detailed},{kind:'assistant',text:'C’est fait.'}]);
  assert.equal(summary.ask.text,'Prépare les trois éditions.');
  assert.equal(summary.result.text,detailed);
  const first={id:'first'}, second={id:'second'}, reply={id:'reply',replyTo:'first'};
  assert.deepEqual(threadItems([first,second],'desc').map((x)=>x.item.id),['second','first']);
  assert.deepEqual(threadItems([first,second,reply],'desc').map((x)=>x.item.id),['first','reply','second']);
  assert.deepEqual(threadItems([first,second,reply],'asc').map((x)=>x.item.id),['first','reply','second']);
});


import { retryableDelivery } from '../../public/v2/pages/project-thread.js';
import { historyItems } from '../../public/v2/pages/project-history.js';
import { retryComment } from '../../public/v2/mock/projects.js';
test('frontend-29: retry is limited to owned failed/no-reply comments and summary events; working keeps summary pending', () => {
  const comment={kind:'comment',editable:true,deleted:false,author:{kind:'human',name:'Camille'}};
  for(const status of ['failed','no-reply']) assert.equal(retryableDelivery(comment,{status},true,'Camille'),true);
  for(const status of ['pending','working','replied','unavailable']) assert.equal(retryableDelivery(comment,{status},true,'Camille'),false);
  assert.equal(retryableDelivery(comment,{status:'failed'},false,'Camille'),false);
  assert.equal(retryableDelivery({...comment,deleted:true},{status:'failed'},true,'Camille'),false);
  assert.equal(retryableDelivery({...comment,editable:false},{status:'failed'},true,'Camille'),false);
  const event={...comment,id:'summary',kind:'event',editable:false,text:{key:'projectThread.event.summary-requested'},delivery:[{status:'no-reply'}]};
  assert.equal(retryableDelivery(event,{status:'no-reply'},true,'Camille'),true);
  assert.equal(retryableDelivery(event,{status:'no-reply'},true,'Autre personne'),false);
  assert.equal(pendingSummary([event]),false);event.delivery[0].status='working';assert.equal(pendingSummary([event]),true);
});
test('frontend-29: reply sends its immediate parent and the agent stays below that nested reply; retry preserves the comment', () => {
  const db=seed(),root=buildCommentsVM(db,id).items.find(c=>c.kind==='comment');
  const c=commentCommand(db,'POST',id,null,{body:'@main Réponds dans ce fil',replyTo:root.id}).comment;
  assert.equal(c.replyTo,root.id);replyToComment(db,id,c,{fail:true});
  assert.equal(retryComment(db,id,c.id,{agentId:'main'}).comment.id,c.id);
  assert.equal(c.delivery[0].status,'pending');assert.equal(retryComment(db,id,c.id,{agentId:'main'}).error[0],400);
  replyToComment(db,id,c);
  const rows=threadItems(buildCommentsVM(db,id).items),index=rows.findIndex(x=>x.item.id===c.id);
  assert.equal(rows[index+1].item.replyTo,c.id);assert.equal(rows[index+1].item.author.kind,'agent');
  assert.equal(commentCommand(db,'POST',id,null,{body:'Réponse',replyTo:'missing'}).error[0],400);
});
test('frontend-29: history current-order label agrees with chronological sorting, regardless of input order', () => {
  const items=[{id:'old',at:1},{id:'new',at:9},{id:'middle',at:5}];
  for(const input of [items,[...items].reverse()]) {
    assert.deepEqual(historyItems(input).map(x=>x.id),['new','middle','old']);
    assert.deepEqual(historyItems(input,'asc').map(x=>x.id),['old','middle','new']);
  }
  assert.equal(items[0].id,'old','sorting does not mutate the VM');
});
