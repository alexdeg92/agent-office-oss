import { html } from '../lib.js';
import { senderName, senderInitials, senderColour } from '../sender.js';
import { safeImageUrl } from '../board.js';
import { Icon } from './ui.js';
import { msg } from '../i18n.js';
import { ProfileAvatar } from './profile-avatar.js';
export function SenderAvatar({ event }) {
  const kind = event?.senderInfo?.kind || 'human';
  const who = senderName(event, msg('session.user'));
  if (kind === 'human' && event?.profileAvatar) return html`<${ProfileAvatar} avatar=${event.profileAvatar} size="sm" class="ao-sender-avatar" />`;
  return html`<span class=${'bu-avatar bu-avatar--' + kind + ' ao-sender-avatar'} aria-hidden="true" ref=${(el) => { if (el && kind === 'human') { el.style.backgroundColor = senderColour(event); el.style.color = '#fff'; } }}>
    ${safeImageUrl(event?.senderInfo?.avatarHint) ? html`<img src=${safeImageUrl(event.senderInfo.avatarHint)} alt="" />` : kind === 'agent' ? html`<${Icon} name="agent" />` : kind === 'system' ? html`<${Icon} name="system" />` : senderInitials(who)}</span>`;
}
