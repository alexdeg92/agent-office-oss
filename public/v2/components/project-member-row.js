import { html } from '../lib.js';
import { Avatar } from './project.js';
import { AuthorAvatar } from './author-avatar.js';
import { Icon } from './ui.js';
import { ConnectorBrandMark } from '../pages/connector-brand.js';
import { buildQuery } from '../config.js';

let styles;
export function loadProjectMemberRowStyles() {
  return styles ||= new Promise((resolve, reject) => {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = new URL('./project-member-row.css' + buildQuery, import.meta.url).href;
    link.onload = resolve;
    link.onerror = () => { link.remove(); styles = null; reject(Error('Project member row stylesheet unavailable')); };
    document.head.append(link);
  });
}

/** Shared, compact People involved row. Values and hierarchy are supplied by the caller. */
export function ProjectMemberRow({ id, name, roleLabel = null, parentLabel = null, parentId = null, parentMemberId = null, depth = 0,
  look = null, avatarState = null, avatarUrl = null, sourceLabel = null, sourceBrand = null, statusLabel = '', status = '',
  testId = null, className = '' }) {
  return html`<li class=${'ao-project-member ao-project-member--compact ' + className}
    data-member-id=${id} data-parent-id=${parentId || undefined} data-parent-member-id=${parentMemberId || undefined} data-member-depth=${depth}
    data-member-status=${status}
    data-testid=${testId || undefined} style=${{ '--member-depth': depth }}>
    <span class="ao-project-member__portrait" role="img" aria-label=${name}>
      ${look ? html`<${AuthorAvatar} look=${look} state=${avatarState} />` : html`<${Avatar} person=${{ id, name, kind: 'agent', avatarUrl, state: null }} />`}
    </span>
    <span class="ao-project-member__copy"><strong>${name}</strong>
      <span class="ao-project-member__detail">
        ${roleLabel ? html`<span class="ao-project-member__role">${roleLabel}</span>` : null}
        ${parentLabel ? html`<span class="ao-project-member__parent"><${Icon} name="arrow-right" />${parentLabel}</span>` : null}
      </span>
    </span>
    ${sourceLabel ? html`<span class="ao-project-member__runtime" aria-label=${sourceLabel} title=${sourceLabel}>
      ${sourceBrand ? html`<${ConnectorBrandMark} brand=${sourceBrand} label=${sourceLabel} />` : null}
      <span class="ao-project-member__runtime-label">${sourceLabel}</span>
    </span>` : html`<span class="ao-project-member__runtime ao-project-member__runtime--empty" aria-hidden="true"></span>`}
    <span class="bu-chip bu-chip--sm ao-project-member__status" data-member-status=${status}>${statusLabel}</span>
  </li>`;
}
