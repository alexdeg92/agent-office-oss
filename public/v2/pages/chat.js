export { loadStyles } from './workspace-mobile.js';
import { Button, TextArea } from '../components/bureau/index.js';
import { useSmallWorkspace } from './workspace-mobile.js';
// Discuter (frontend-22: the Bureau chat, design/components/Chat): ChatVM from
// GET /api/v2/views/chat, kept fresh by the `chat` topic (api.md §3.3); POST /api/v2/chat/messages → 202 (§5.2).
// One fixed session, the last 50 messages, one pending turn at a time. The page states only what the VM proves:
// a pending turn means « working », elapsed time is not progress, and tool evidence lives in the session's trace,
// never guessed from the last message. Drafting stays possible while a turn runs.
import { assetUrl } from '../config.js';
import { html, useState, useEffect, useRef } from '../lib.js';
import { useTopic, useNow, useStore } from '../hooks.js';
import { services } from '../services.js';
import { msg, agentName } from '../i18n.js';
import * as fmt from '../fmt.js';
import { post } from '../api.js';
import { Frame, Icon, Skeleton, ErrorState } from '../components/ui.js';
import { ChatMessage } from '../components/chat-message.js';

const DRAFT_KEY = 'ao.chat.draft';
const readDraft = () => { try { return localStorage.getItem(DRAFT_KEY) || ''; } catch { return ''; } };
const saveDraft = (v) => { try { if (v) localStorage.setItem(DRAFT_KEY, v); else localStorage.removeItem(DRAFT_KEY); } catch { /* per-viewer convenience only */ } };

/** Show the latest exchange in the bounded thread; its composer stays in the footer row. */
function toLatest() {
  requestAnimationFrame(() => {
    const thread = document.querySelector('.ao-chat .bu-chat__thread');
    if (thread) thread.scrollTop = thread.scrollHeight;
  });
}
const PHONE = '(max-width: 820px)';
/** frontend-23: on phones the composer grows with its text, up to 160 px (CSSOM, CSP-safe); desktop keeps its rows. */
function autoGrow(t) {
  if (!t) return;
  if (!matchMedia(PHONE).matches) { t.rows = 2; t.style.removeProperty('height'); return; }
  t.rows = 1;
  t.style.setProperty('height', 'auto');
  t.style.setProperty('height', Math.min(t.scrollHeight + 2, 160) + 'px');
}

/** The stream's view of the world: live, interrupted, or the runtime's gateway down. */
function linkState(status) {
  if (status.gateway === 'down') return 'gateway-down';
  if (status.conn === 'open' || status.conn === 'idle') return 'live';
  return 'interrupted';
}

export function ChatPage() {
  const { router } = services;
  const small = useSmallWorkspace();
  const vm = useTopic('chat', '/api/v2/views/chat');
  const status = useStore(services.stream.status);
  const caps = status.capabilities || (services.meta && services.meta.capabilities) || { openclawWrites: true };
  const writes = caps.openclawWrites !== false;
  const link = linkState(status);
  const c = vm.data;
  const pending = c ? c.turnPending : null;
  const now = useNow(pending ? 1000 : 30_000);
  const [draft, setDraft] = useState(readDraft);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState(null);
  const [announce, setAnnounce] = useState('');
  const scrolled = useRef(false);
  const lastId = useRef(undefined);   // the latest message id seen (R19-05: the window stays at 50, so never a count)
  const draftRef = useRef(draft);       // the composer's current text, for an acknowledgement that arrives later (R19-01)

  // First data: bring the latest exchange and the composer into view, once (later updates keep the reading position).
  useEffect(() => {
    if (!c || scrolled.current) return;
    scrolled.current = true;
    toLatest();
  }, [!!c]);
  // Announce a received reply or a failed turn (a transition), never on first render. Keyed on the latest message's
  // id (R19-05): the server keeps the last 50, so a new message can leave the count unchanged. An identical text is
  // cleared first, so a second « reply received » is announced again.
  const last = c && c.messages.length ? c.messages[c.messages.length - 1] : null;
  useEffect(() => {
    if (!c) return;
    const id = last ? last.id : null;
    if (lastId.current !== undefined && id !== lastId.current && last && (last.role === 'assistant' || last.role === 'error')) {
      const text = last.role === 'assistant' ? msg('chat.replyReceived', { agent: agentName() }) : msg('chat.turnFailedAnnounce');
      setAnnounce('');
      setTimeout(() => setAnnounce(text), 60);
    }
    lastId.current = id;
  }, [c ? (last ? last.id : null) : undefined]);

  useEffect(() => autoGrow(document.getElementById('chat-texte')), [draft, !!c]);

  function onDraft(v) { draftRef.current = v; setDraft(v); saveDraft(v); setSendError(null); }
  const canSend = writes && !pending && !sending && link === 'live' && draft.trim().length > 0 && draft.length <= 8000;
  async function send(e) {
    if (e) e.preventDefault();
    if (!canSend) return;
    const sent = draft;
    setSending(true); setSendError(null);
    try {
      await post('/api/v2/chat/messages', { text: sent }, { quiet: true });
      // R19-01: clear only the exact text that was sent; a newer draft (typed while the 202 was on its way) stays.
      if (draftRef.current === sent) onDraft('');
      toLatest();
    } catch (err) {
      setSendError(err.code === 'conflict' ? msg('chat.error.pending') : err.code === 'readonly' ? msg('chat.readonly') : err.message);
    } finally { setSending(false); }
  }
  const lastUserText = c ? [...c.messages].reverse().find((m) => m.role === 'user')?.text : null;

  const hintKey = !writes ? 'chat.readonly' : link === 'interrupted' ? 'chat.hint.interrupted' : link === 'gateway-down' ? 'chat.hint.gatewayDown' : pending ? 'chat.hint.pending' : 'chat.hint';
  const hint = msg(hintKey);
  const banner = (text, retry, settings = false) => html`<div class="bu-banner bu-banner--warning" role="status"><${Icon} name="warning" /><span class="bu-banner__text">${text}</span>${retry ? html`<button class="bu-btn bu-btn--sm" onClick=${retry}>${msg('common.retry')}</button>` : null}${settings ? html`<a class="bu-btn bu-btn--sm" href=${router.href('parametres',{}, {onglet:'connexion'})}>${msg('settings.openConnection')}</a>` : null}</div>`;

  return html`<${Frame} class="bu-page ao-page ao-page--detail ao-chat" bodyClass=${c ? 'ao-frame__body--framed' : ''} aria-busy=${vm.resyncing || (!c && !vm.error) ? 'true' : undefined} head=${html`
    <div class="bu-toolbar">
      <h2 class="ao-chat__heading">${agentName()}</h2>
      ${c ? html`<span class="bu-count" title=${msg('chat.margin.window', { n: c.messages.length })}>${c.messages.length}</span>` : null}
      <span class="bu-spacer"></span>
      ${c ? html`<a class="bu-btn bu-btn--sm ao-chat__trace" href=${router.href('session', { sessionKey: c.sessionKey })} title=${msg('chat.margin.openTrace')}><${Icon} name="journaux" /><span class="ao-chat__btnlabel">${msg(small ? 'nav.journaux' : 'chat.margin.openTrace')}</span></a>` : null}
    </div>
    <p class="bu-sr-only" aria-live="polite">${announce}</p>`}>
    ${vm.data === undefined && vm.error ? html`<${ErrorState} error=${vm.error} onRetry=${vm.retry} />`
      : !c ? html`<div class="bu-card" role="status" aria-label=${msg('editorial.loading')}><${Skeleton} /><${Skeleton} w="70" /><${Skeleton} w="50" /></div>`
      : html`
      ${vm.error ? banner(msg('common.updateFailed', { error: vm.error.message }), vm.retry) : null}
      ${link === 'gateway-down' ? banner(msg('chat.hint.gatewayDown'),null,true) : null}
      <${Frame} tag="section" class="bu-card ao-chat__card" aria-label=${msg('chat.title', { agent: agentName() })} bodyClass="bu-chat__thread"
        bodyLabel=${msg('chat.youAnd', { agent: agentName() })} foot=${html`          <form class="bu-composer ao-chat__composer" onSubmit=${send} onKeyDown=${(e) => { if (e.target.id === 'chat-texte' && e.key === 'Enter' && (e.ctrlKey || e.metaKey)) send(e); }} id="chat-fin" aria-label=${msg(pending ? 'chat.compose.next' : 'chat.compose')}>
            <${TextArea} class="ao-chat__input" id="chat-texte" rows=${2} maxLength=${8000} value=${draft}
              label=${msg('chat.compose.label', { agent: agentName() })} placeholder=${msg('chat.compose.placeholder', { agent: agentName() })} describedBy="chat-aide"
              onInput=${(e) => { onDraft(e.currentTarget.value); autoGrow(e.currentTarget); }} />
            <${Button} type="submit" class="ao-chat__send" label=${msg('chat.send')} icon=${html`<${Icon} name="arrow-right" />`}
              iconOnly=${small} variant="primary" disabled=${!canSend} busy=${sending} />
          </form>
          <div class="ao-chat__foot">
            <p class=${'bu-caption bu-text-tertiary' + (hintKey === 'chat.hint' ? ' ao-chat__hint--keys' : '')} id="chat-aide">${hint}</p>
            ${sendError ? html`<p class="bu-field__error" role="alert"><${Icon} name="alert" />${sendError}</p>` : null}
          </div>
`}>
            ${c.messages.length ? html`<ol class="ao-chat__messages">${c.messages.map((m, i) => html`
              ${i === 0 || fmt.dayKey(m.at) !== fmt.dayKey(c.messages[i - 1].at) ? html`<li key=${'d' + m.id} class="bu-msg bu-msg--system ao-chat__day"><span class="bu-msg__bubble">${fmt.longDate(m.at, now)}</span></li>` : null}
              <li key=${m.id} class=${'ao-chat__msg ao-chat__msg--' + m.role}><${ChatMessage} m=${m} now=${now} onRetry=${m.role === 'error' && lastUserText && !pending ? () => onDraft(lastUserText) : null} /></li>`)}
            </ol>`
            : html`<div class="bu-empty ao-chat__empty"><img class="ao-illus" src=${assetUrl('bureau/assets/Illustrations/new-chat-thread.webp')} alt="" width="400" height="300" />
                <p class="bu-empty__title">${msg('chat.empty')}</p><p class="bu-empty__text">${msg('chat.empty.text', { agent: agentName() })}</p></div>`}
            ${pending ? html`<${Pending} pending=${pending} now=${now} link=${link} />` : null}
      </${Frame}>`}
  </${Frame}>`;
}

const Avatar = ({ state }) => html`<span class="bu-avatar bu-avatar--agent" data-agent-state=${state} aria-hidden="true"><${Icon} name="agent" /></span>`;

/** The pending turn, as known: running since `since`; with an interrupted link, its end is unconfirmed. */
function Pending({ pending, now, link }) {
  const elapsed = Math.max(0, now - pending.since);
  const interrupted = link !== 'live';
  return html`<section class=${'bu-msg bu-msg--agent ao-chat__pending' + (interrupted ? ' is-interrupted' : '')} aria-labelledby="chat-encours">
    <div class="bu-msg__head"><${Avatar} state=${interrupted ? 'offline' : 'thinking'} /><span class="bu-msg__who">${agentName()}</span>
      <span class=${'bu-chip bu-chip--sm ' + (interrupted ? 'bu-chip--warning' : 'bu-chip--success')}>${interrupted ? html`<${Icon} name="warning" />` : html`<span class="bu-dot bu-dot--success bu-dot--live" aria-hidden="true"></span>`}${msg(interrupted ? 'chat.pending.kickerInterrupted' : 'chat.pending.kicker')}</span></div>
    <div class="bu-msg__bubble">
      ${interrupted ? null : html`<div class="bu-typing" aria-hidden="true"><span></span><span></span><span></span></div>`}
      <p class="ao-chat__pending-title" id="chat-encours">${msg(interrupted ? 'chat.pending.interrupted' : 'chat.pending.working', { agent: agentName() })}</p>
      <p class="bu-caption bu-text-secondary">${msg(interrupted ? 'chat.pending.interruptedText' : 'chat.pending.text')}</p>
      <p class="bu-msg__meta ao-chat__since">${msg('chat.pending.since', { duration: fmt.duration(elapsed), at: fmt.time(pending.since) })}</p>
    </div>
  </section>`;
}
