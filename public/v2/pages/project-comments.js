import { html, useState, useEffect, useRef } from '../lib.js';
import { useTopic, runtimeCan } from '../hooks.js';
import { services } from '../services.js';
import { get, request } from '../api.js';
import { msg, label, has } from '../i18n.js';
import { Icon, Ago, ErrorState } from '../components/ui.js';
import { Avatar } from '../components/project.js';
import { mentionQuery, insertMention } from './project-mentions.js';
import { threadItems, retryableDelivery } from './project-thread.js';
import { completeRef } from './project-history.js';
import { useOrder, OrderToggle } from '../components/order.js';
const enc = encodeURIComponent;
const statusText = (d, agents) => {
  const name = agents.find((a) => a.id === d.agentId)?.name || d.agentId;
  const ref = { key: 'projectThread.delivery.' + d.status, params: { agent: name } };
  return has(ref.key) ? label(ref) : msg('project.comments.delivery.' + d.status, { name });
};
export function Comments({ p, writes }) {
  const [order, setOrder] = useOrder('comments', 'asc');
  const id = p.id, topic = 'comments:' + enc(id), url = '/api/v2/views/projects/' + enc(id) + '/comments';
  const vm = useTopic(topic,url);
  const [draft,setDraft] = useState(''), [edit,setEdit] = useState(null), [reply,setReply] = useState(null), [busy,setBusy] = useState(false), [error,setError] = useState(null);
  const [query,setQuery] = useState(null), [active,setActive] = useState(0), [older,setOlder] = useState({ items:[], cursor:undefined, loading:false });
  const [said,setSaid] = useState('');
  const previousReply = useRef(undefined);
  const input = () => document.getElementById('project-comment');
  useEffect(() => { setDraft(''); setEdit(null); setReply(null); setError(null); setQuery(null); setOlder({items:[],cursor:undefined,loading:false}); previousReply.current = undefined; }, [id]);
  const data=vm.data, agents=data?.mentionable || [];
  const canComment = writes && data?.canComment !== false;
  const canMention = canComment && data?.canMention !== false && runtimeCan('projectComments');
  const seen = new Set((data?.items || []).map((c) => c.id));
  const items = older.items.filter((c) => !seen.has(c.id)).concat(data?.items || []);
  const cursor = older.cursor === undefined ? data?.nextCursor : older.cursor;
  useEffect(() => {
    if (!data) return;
    const last = data.items.filter((c) => c.kind === 'comment' && c.author.kind === 'agent' && !c.deleted).at(-1);
    if (previousReply.current !== undefined && last && previousReply.current !== last.id) setSaid(msg('project.comments.reply.received',{name:last.author.name}));
    previousReply.current = last?.id || null;
  }, [data]);
  function change(e) { const el=e.currentTarget; setDraft(el.value); setQuery(canMention ? mentionQuery(el.value,el.selectionStart,agents) : null); setActive(0); }
  function pick(a) {
    const next=insertMention(draft,query,a); setDraft(next.body); setQuery(null);
    requestAnimationFrame(() => { input()?.focus(); input()?.setSelectionRange(next.caret,next.caret); });
  }
  async function send(e) {
    e.preventDefault(); if (!canComment || busy || !draft.trim()) return;
    setBusy(true); setError(null);
    try { await request(edit ? 'PATCH' : 'POST', '/api/v2/projects/'+enc(id)+'/comments'+(edit ? '/'+enc(edit) : ''),{body:draft,...(!edit && reply ? {replyTo:reply} : {})},{quiet:true}); setDraft(''); setEdit(null); setReply(null); setQuery(null); services.stream.resync(topic); }
    catch (err) { setError(err); }
    finally { setBusy(false); }
  }
  async function remove(c) {
    setBusy(true); setError(null);
    try { await request('DELETE','/api/v2/projects/'+enc(id)+'/comments/'+enc(c.id),undefined,{quiet:true}); if (edit===c.id || reply===c.id) {setEdit(null);setReply(null);setDraft('');} services.stream.resync(topic); }
    catch(err) { setError(err); } finally {setBusy(false);}
  }
  async function retry(c,d) {
    setBusy(true); setError(null);
    try { await request('POST','/api/v2/projects/'+enc(id)+'/comments/'+enc(c.id)+'/retry',{agentId:d.agentId},{quiet:true}); services.stream.resync(topic); }
    catch(err) { setError(err); } finally {setBusy(false);}
  }
  function answer(c) { setReply(c.id);setEdit(null);setDraft('');setQuery(null);setError(null);requestAnimationFrame(() => input()?.focus()); }
  async function more() {
    setOlder((s) => ({...s,loading:true})); setError(null);
    try {const r=await get(url+'?cursor='+enc(cursor),{quiet:true});setOlder((s) => ({items:r.data.items.concat(s.items),cursor:r.data.nextCursor,loading:false}));}
    catch(err) {setError(err);setOlder((s) => ({...s,loading:false}));}
  }
  const options=canMention ? query?.items || [] : [], open=options.length>0;
  const loadMore = cursor ? html`<button type="button" class="bu-btn bu-btn--sm ao-more" disabled=${older.loading} onClick=${more}>${msg('project.comments.older')}</button>` : null;
  const composer = data ? html`<form class="ao-comments__composer" onSubmit=${send} data-reply-to=${reply || undefined} data-write-actions>
      <label class="bu-field__label" for="project-comment">${msg(edit ? 'project.comments.edit' : reply ? 'project.comments.reply.write' : 'project.comments.write',{name:items.find(c=>c.id===reply)?.author.name})}</label>
      <div class="ao-comments__input">
        <textarea id="project-comment" class="bu-textarea" maxlength="4000" rows="3" value=${draft} disabled=${!canComment || busy}
          role="combobox" aria-expanded=${open ? 'true' : 'false'} aria-autocomplete="list" aria-haspopup="listbox" aria-controls=${open ? 'project-mentions' : undefined}
          aria-activedescendant=${open ? 'project-mention-'+active : undefined} aria-describedby="project-comment-help" onInput=${change}
          onClick=${change} onKeyUp=${(e) => {if (e.key==='ArrowLeft' || e.key==='ArrowRight') change(e);}}
          onKeyDown=${(e) => {
            if ((e.ctrlKey || e.metaKey) && e.key==='Enter') {e.preventDefault();send(e);return;}
            if (e.key==='Escape') {setQuery(null);return;}
            if (!open) return;
            if (e.key==='ArrowDown' || e.key==='ArrowUp') {e.preventDefault();setActive((active+(e.key==='ArrowDown' ? 1 : options.length-1))%options.length);}
            if (e.key==='Enter' || e.key==='Tab') {e.preventDefault();pick(options[active]);}
          }} />
        ${open ? html`<ul class="ao-mentions" id="project-mentions" role="listbox" aria-label=${msg('project.comments.agents')}>${options.map((a,i) => html`<li id=${'project-mention-'+i} key=${a.id} role="option" aria-selected=${active===i ? 'true' : 'false'} onMouseDown=${(e) => e.preventDefault()} onClick=${() => pick(a)}><${Avatar} person=${{...a,kind:'agent'}} size="sm" /><span><b>${a.name}</b><span class="bu-caption">@${a.id}</span></span></li>`)}</ul>` : null}
      </div>
      <p class="bu-caption bu-text-secondary ao-ro" id="project-comment-help">${msg(!canComment ? 'project.comments.readonly' : !canMention ? 'project.comments.noDelivery' : 'project.comments.hint')}</p>
      <div class="bu-btn-group"><button type="submit" class="bu-btn bu-btn--primary bu-btn--sm" disabled=${!canComment || busy || !draft.trim()} aria-busy=${busy ? 'true' : undefined}>${msg(edit ? 'common.save' : 'project.comments.send')}</button>
        ${edit || reply ? html`<button type="button" class="bu-btn bu-btn--sm" disabled=${busy} onClick=${() => {setEdit(null);setReply(null);setDraft('');setQuery(null);}}>${msg('common.cancel')}</button>` : null}
      </div>
    </form>` : null;
  return html`<section class="bu-card ao-section ao-section--comments" aria-labelledby="commentaires">
    <div class="ao-section__head"><h3 class="bu-card__title" id="commentaires">${msg('project.comments.title')}</h3><${OrderToggle} view="comments" order=${order} onChange=${setOrder} />${data?.session ? html`<span class="bu-spacer"></span><a class="bu-btn bu-btn--ghost bu-btn--sm" href=${services.router.href('session',{sessionKey:data.session.key})}>${msg('project.comments.session')}</a>` : null}</div>
    ${vm.error ? html`<${ErrorState} error=${vm.error} onRetry=${vm.retry} />` : null}
    ${!data && !vm.error ? html`<p role="status">${msg('common.loading')}</p>` : null}
    ${order === 'asc' ? loadMore : null}
    ${data && !items.length ? html`<p class="bu-text-secondary">${msg('project.comments.empty')}</p>` : null}
    <ol class="ao-comments" role="list">${threadItems(items,order).map(({item:c,reply:isReply}) => {
      const line=c.kind !== 'comment';
      const ref=c.text ? {...c.text,params:{actor:c.author.name,...(c.text.params || {})}} : null;
      const parent=items.find((x) => x.id===c.replyTo);
      const delivery=c.delivery.length ? html`<ul class="ao-comment__delivery">${c.delivery.map((d) => html`<li key=${d.agentId} data-delivery=${d.status} class=${['failed','no-reply'].includes(d.status) ? 'ao-comment__failed' : 'bu-text-secondary'}>
        ${d.status==='working' ? html`<span class="ao-comment__working" aria-hidden="true"></span>` : null}${statusText(d,agents)}
        ${retryableDelivery(c,d,canMention,services.me?.displayName) ? html`<button type="button" class="bu-btn bu-btn--ghost bu-btn--sm" data-retry=${d.agentId} title=${msg('project.comments.retry.agent',{name:agents.find(a=>a.id===d.agentId)?.name || d.agentId})} disabled=${busy} onClick=${() => retry(c,d)}>${msg('project.comments.retry')}</button>` : null}
      </li>`)}</ul>` : null;
      return html`<li key=${c.id} id=${'comment-'+c.id} data-comment=${c.id} data-comment-kind=${c.kind} data-reply-to=${c.replyTo || undefined} class=${'ao-comment'+(isReply ? ' ao-comment--reply' : '')+(line ? ' ao-comment--system' : c.author.kind==='agent' ? ' ao-comment--agent' : '')}>
        ${line ? html`<${Icon} name=${c.kind==='event' ? 'agent' : 'arrow-right'} /><div class="ao-comment__content"><p>${completeRef(ref) ? label(ref) : msg(c.kind==='event' ? 'project.comments.summary.requested' : 'project.comments.system',{name:c.author.name})}</p><${Ago} at=${c.at} />${delivery}${c.kind==='event' && !c.delivery.length && !items.some((x) => x.replyTo===c.id) ? html`<p class="ao-comment__pending" role="status">${msg('project.summary.pending')}</p>` : null}</div>` : html`
          <${Avatar} person=${c.author} size="sm" /><div class="ao-comment__content">
            <div class="ao-comment__head"><b>${c.author.name}</b><${Ago} at=${c.at} />${c.editedAt ? html`<span>${msg('project.comments.edited')}</span>` : null}</div>
            ${parent ? html`<a class="ao-comment__reply" href=${'#comment-'+parent.id} onClick=${(e) => {e.preventDefault();document.getElementById('comment-'+parent.id)?.scrollIntoView({block:'center'});}}>${msg('project.comments.replyTo',{name:parent.author.name})}</a>` : null}
            <p class="ao-comment__body">${c.deleted ? msg('project.comments.deleted') : c.body}</p>
            ${delivery}
            ${canComment && !c.deleted ? html`<div class="bu-btn-group ao-comment__actions" data-write-actions>
              ${c.editable ? html`<button type="button" class="bu-btn bu-btn--ghost bu-btn--sm" disabled=${busy} onClick=${() => {setEdit(c.id);setReply(null);setDraft(c.body);setQuery(null);setError(null);requestAnimationFrame(() => input()?.focus());}}>${msg('project.edit')}</button>` : null}
              ${c.deletable ? html`<button type="button" class="bu-btn bu-btn--ghost bu-btn--sm" disabled=${busy} onClick=${() => remove(c)}>${msg('project.comments.delete')}</button>` : null}
              <button type="button" class="bu-btn bu-btn--ghost bu-btn--sm" data-reply onClick=${() => answer(c)} disabled=${busy}>${msg('project.comments.reply')}</button>
            </div>` : null}
            ${reply===c.id ? composer : null}
          </div>`}
      </li>`;
    })}</ol>
    ${order === 'desc' ? loadMore : null}
    <p class="bu-sr-only" role="status" aria-live="polite">${said}</p>
    ${error ? html`<p class="bu-field__error" role="alert">${error.message}</p>` : null}
    ${!reply ? composer : null}
  </section>`;
}
