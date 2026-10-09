import { html } from '../lib.js';
import { participantRoster } from '../sender.js';
import { msg } from '../i18n.js';
import { services } from '../services.js';

export function SessionParticipants({ participants, subagents }) {
  const roster = participantRoster(participants, subagents);
  const names = [...roster.names];
  for (const kind of ['human', 'agent']) {
    const n = roster.unknown[kind];
    if (n) names.push(msg('session.unknown.' + kind + (n === 1 ? '' : '.many'), { n }));
  }
  if (!roster.count && !roster.subagents.length) return null;
  return html`<div class="ao-session__roster">
    ${roster.count ? html`<p class="ao-session__participants">${msg('session.participants', { n: roster.count })} : ${names.join(', ')}</p>` : null}
    ${roster.subagents.length ? html`<details class="ao-session__subagents">
      <summary>${msg(roster.subagents.length === 1 ? 'session.subagent.count' : 'session.subagents.count', { n: roster.subagents.length })}</summary>
      <ul>${roster.subagents.map((p, i) => {
        const name = p.delegation.label || p.name || msg('session.subagent.unknown', { n: i + 1 });
        return html`<li key=${p.runtime + ':' + p.delegation.sessionKey}><a href=${services.router.href('session', { sessionKey: p.delegation.sessionKey })}>${name}</a></li>`;
      })}</ul>
    </details>` : null}
  </div>`;
}
