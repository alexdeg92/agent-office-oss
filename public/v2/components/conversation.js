import { SenderAvatar } from './sender.js';
import { senderName } from '../sender.js';
import { msg, agentName } from '../i18n.js';
import { conversationDigest } from '../pages/project-history.js';
import { html } from '../lib.js';
import { useTopic } from '../hooks.js';
import { services } from '../services.js';
import { Icon, ErrorState } from './ui.js';
import { plainText } from '../md.js';

const snippet = (text) => plainText(text).replace(/\s+/g, ' ').trim().slice(0, 280);
export function ConversationSummary({ events }) {
  const d = conversationDigest(events);
  return html`<dl class="ao-conversation-summary">
    <div><dt>${msg('project.history.ask')}</dt><dd>${d.ask ? (senderName(d.ask, msg('session.user'))) + ' : ' + snippet(d.ask.text) : msg('project.history.ask.empty')}</dd></div>
    <div><dt>${msg('project.history.actions')}</dt><dd>${d.steps ? msg('project.history.steps', { n: d.steps }) + ' · ' + d.tools.join(', ') : msg('project.history.actions.reply')}</dd></div>
    <div><dt>${msg('project.history.result')}</dt><dd>${d.result ? snippet(d.result.text) : msg('project.history.result.empty')}</dd></div>
  </dl>`;
}
export function ConversationPreview({ sessionKey, href }) {
  const vm = useTopic('session:' + encodeURIComponent(sessionKey), '/api/v2/views/sessions/' + encodeURIComponent(sessionKey));
  const s = vm.data;
  const d = s ? conversationDigest(s.events) : null;
  return html`<div class="ao-conversation-preview">
    ${vm.error ? html`<${ErrorState} error=${vm.error} onRetry=${vm.retry} />` : null}
    ${!s && !vm.error ? html`<p role="status">${msg('editorial.loading')}</p>` : null}
    ${s ? html`
      <h4 class="bu-eyebrow">${msg('project.history.summary')}</h4>
      <${ConversationSummary} events=${s.events} />
      ${s.traceState !== 'fresh' ? html`<p role="status" class="bu-text-secondary">${msg('session.trace.' + s.traceState)}</p>` : null}
      <h4 class="bu-eyebrow">${msg('project.history.lastMessages')}</h4>
      ${d.messages.length ? html`<ol class="ao-conversation-messages">${d.messages.map((e) => html`<li key=${e.id} class=${'ao-conversation-bubble ao-conversation-bubble--' + e.kind}>
        ${e.kind === 'user' ? html`<${SenderAvatar} event=${e} />` : null}<b>${senderName(e, e.kind === 'user' ? msg('session.user') : agentName())}</b><p>${snippet(e.text)}${e.text.length > 280 ? '…' : ''}</p>
      </li>`)}</ol>` : html`<p>${msg(s.traceState === 'fresh' ? 'session.noEvents' : 'session.trace.staleEmpty')}</p>`}` : null}
    <a class="bu-btn bu-btn--sm" href=${href}>${msg('project.history.openFull')}<${Icon} name="arrow-right" /></a>
  </div>`;
}
