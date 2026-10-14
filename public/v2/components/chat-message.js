// Chat's message body renders classification, author appearance and labels supplied by the VM.
import {html} from '../lib.js';
import {msg,label,agentName} from '../i18n.js';
import * as fmt from '../fmt.js';
import {senderName} from '../sender.js';
import {SenderAvatar} from './sender.js';
import {AuthorAvatar} from './author-avatar.js';
import {Markdown} from './markdown.js';
import {Icon} from './ui.js';
import {CollapsedGroup,Button} from './bureau/index.js';
import '../messages/workspace.js';

export function ChatMessage({ m, now, onRetry }) {
  const metaParts = m.meta ? [m.meta.model, m.meta.durationMs != null ? fmt.duration(m.meta.durationMs) : null, m.meta.tokens != null ? fmt.tokens(m.meta.tokens) : null].filter(Boolean) : [];
  const time = html`<time datetime=${new Date(m.at).toISOString()} title=${fmt.dateTime(m.at, now)}>${fmt.time(m.at)}</time>`;
  if (m.role === 'user') {
    return html`<div class="bu-msg bu-msg--user">
      <div class="bu-msg__head"><${SenderAvatar} event=${m} /><span class="bu-msg__who">${senderName(m, msg('chat.you'))}</span><span class="bu-msg__meta">${time}${m.id.startsWith('pending_') ? ' · ' + msg('chat.sent') : ''}</span></div>
      <div class="bu-msg__bubble">${m.text}</div></div>`;
  }
  const error = m.role === 'error';
  return html`<div class=${'bu-msg bu-msg--agent' + (error ? ' bu-msg--error' : '')}>
    <div class="bu-msg__head"><${AuthorAvatar} look=${m.avatar} state=${error ? 'error' : undefined} />
      <span class="bu-msg__who">${error ? msg('chat.failed') : senderName(m, agentName())}</span>
      <span class="bu-msg__meta">${time}${metaParts.length ? ' · ' + metaParts.join(' · ') : ''}</span></div>
    ${m.kind === 'subagent-result' ? html`<div class="bu-msg__bubble ao-chat__result">
      <${CollapsedGroup} defaultOpen=${!m.collapsedByDefault} class="ao-chat__result-card"
        label=${html`<span>${m.title ?? msg('chat.subagentResult')} ${m.statusLabel ? html`<span class="bu-caption bu-text-secondary">· ${label(m.statusLabel)}</span>` : null}</span>`}>
        <${Markdown} source=${m.body?.text ?? m.text} headingOffset=${3} />
      </${CollapsedGroup}>
    </div>` : error ? html`<div class="bu-msg__bubble"><p>${m.text}</p>
        ${onRetry ? html`<${Button} size="sm" class="ao-chat__retry" label=${msg('chat.retry')} icon=${html`<${Icon} name="undo" />`} onClick=${onRetry} />` : null}</div>`
      : html`<div class="bu-msg__bubble bu-prose"><${Markdown} source=${m.body?.text ?? m.text} headingOffset=${3} /></div>`}
  </div>`;
}

