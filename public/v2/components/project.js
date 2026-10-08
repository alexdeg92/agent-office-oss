// Projets building blocks on the Bureau classes: thumb, priority, status, the four flag kinds, avatars.
import { html, useState } from '../lib.js';
import { Icon } from './ui.js';
import { t, has, enumOf } from '../i18n.js';
import { labelTone, accentTone, sortFlags, safeImageUrl, priorityRank } from '../board.js';

const STATUS_ICON = { idea: 'state-thinking', todo: 'list', 'in-progress': 'state-working', 'in-review': 'eye', shipped: 'check' };

/**
 * The project image by `thumb.kind` (BRIEF, Owner's iPad review): `screenshot` (the live site) or `opengraph` (GitHub card)
 * or the backend's content-addressed `cover`, as a validated lazy image. While a cover is queued, use the
 * existing typographic placeholder. A failed image keeps its reserved dimensions.
 */
export function Thumb({ thumb, id, showRepo = true, size }) {
  const src = ['screenshot', 'opengraph', 'cover'].includes(thumb.kind) ? safeImageUrl(thumb.url) : null;
  const [failed, setFailed] = useState(null);
  const repo = showRepo && thumb.repoLabel ? html`<span class="bu-thumb__repo"><${Icon} name="branche" />${thumb.repoLabel}</span>` : null;
  const labelText = thumb.repoLabel ? `Image du dépôt ${thumb.repoLabel}` : 'Image du projet';
  if (src && failed !== src) {
    return html`<span class="bu-thumb ao-thumb" data-cover=${thumb.kind} role="img" aria-label=${labelText}>
      <img class="ao-thumb__img" src=${src} alt="" width="480" height="270" loading="lazy" decoding="async" onError=${() => setFailed(src)} />${repo}</span>`;
  }
  return html`<span class=${'bu-thumb bu-thumb--generated ao-monogram ao-tint--' + accentTone(thumb.accent ?? thumb.tint, id) + (size ? ' ao-monogram--' + size : '')}
      data-cover="monogram" role="img" aria-label=${'Monogramme ' + (thumb.initials || '')}>
    <span class="ao-monogram__text" aria-hidden="true">${thumb.initials || '·'}</span>${repo}</span>`;
}

/** The priorities the server accepts (MetaVM.enums.priority), in rank order; P0–P9 (architect-55) until meta has loaded. */
export const priorityOptions = () => { const e = enumOf('priority'); return (e.length ? e.slice() : ['P0', 'P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7', 'P8', 'P9']).sort((a, b) => priorityRank(a) - priorityRank(b)); };

/** Badge tone: one DS class per level (bu-priority--p0 … --p9); anything unknown gets the quietest. */
const priorityTone = (p) => 'p' + Math.min(priorityRank(p), 9);
/** Picker text: « P0 · critique » from the server's labels, else the bare key. */
export const priorityText = (p) => (has('priority.' + p) ? t('priority.' + p) : p);
export const Priority = ({ p }) => html`<span class=${'bu-priority bu-priority--' + priorityTone(p)} data-priority=${p} title=${priorityText(p)}>${p}</span>`;

export const PStatus = ({ status }) => html`<span class="bu-pstatus" data-project-status=${status}><${Icon} name=${STATUS_ICON[status]} />${t('projectStatus.' + status)}</span>`;

/** One flag, shaped by kind (LabelChip README): risk = outlined pill, feature = dashed mono, label = tinted square. */
export function Flag({ flag }) {
  switch (flag.kind) {
    case 'priority': return html`<${Priority} p=${flag.key} />`;
    case 'risk': {
      const sev = flag.severity === 'high' ? ' bu-risk--high' : flag.severity === 'low' ? ' bu-risk--low' : '';
      return html`<span class=${'bu-risk' + sev + (flag.acked ? ' ao-risk--acked' : '')} title=${flag.acked ? 'Risque pris en compte' : 'Risque'}>
        <${Icon} name=${flag.acked ? 'check' : 'warning'} />${flag.label}</span>`;
    }
    case 'feature': return html`<span class=${'bu-feature' + (flag.state === 'on' ? ' bu-feature--on' : '')}
      title=${flag.state === 'on' ? 'Drapeau de fonctionnalité actif' : flag.state === 'off' ? 'Drapeau de fonctionnalité inactif' : 'État inconnu'}>${flag.label}</span>`;
    default: return html`<span class=${'bu-label-chip bu-label-chip--' + labelTone(flag.key)}>${flag.label}</span>`;
  }
}

export function FlagList({ flags, hiddenCount = 0, skipPriority = true }) {
  const list = sortFlags(flags).filter((f) => !(skipPriority && f.kind === 'priority'));
  if (!list.length && !hiddenCount) return null;
  return html`<ul class="bu-labels">
    ${list.map((f) => html`<li key=${f.kind + ':' + f.key}><${Flag} flag=${f} /></li>`)}
    ${hiddenCount ? html`<li><span class="bu-tag" title=${`${hiddenCount} autre${hiddenCount > 1 ? 's' : ''}`}>+${hiddenCount}</span></li>` : null}
  </ul>`;
}

function initials(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  return (parts.length >= 2 ? parts.slice(0, 2).map((w) => [...w][0]) : [...(parts[0] || '?')].slice(0, 2)).join('').toLocaleUpperCase('fr-CA');
}

/** Avatar by person kind (Avatar README); agents keep their state ring. */
export function Avatar({ person, size, title }) {
  const cls = ['bu-avatar', 'bu-avatar--' + person.kind, size ? 'bu-avatar--' + size : ''].filter(Boolean).join(' ');
  const label = title || person.name;
  const content = person.avatarUrl ? html`<img src=${person.avatarUrl} alt="" />` : person.kind === 'agent' ? html`<${Icon} name="agent" />` : initials(person.name);
  return html`<span class=${cls} data-agent-state=${person.kind === 'agent' && person.state ? person.state : undefined} title=${label} role="img" aria-label=${label}>${content}</span>`;
}

export function AvatarStack({ people, hiddenCount = 0, size = 'sm', hiddenNames }) {
  return html`<ul class=${'bu-avatar-stack' + (size === 'sm' ? ' bu-avatar-stack--sm' : '')} aria-label="Personnes impliquées">
    ${people.map((p) => html`<li key=${p.id}><${Avatar} person=${p} size=${size} title=${p.name + (p.kind === 'agent' ? ' · agent' : p.kind === 'git' ? ' · auteur git' : '')} /></li>`)}
    ${hiddenCount ? html`<li><span class="bu-avatar-stack__more" title=${hiddenNames || `${hiddenCount} autre${hiddenCount > 1 ? 's' : ''}`}>+${hiddenCount}</span></li>` : null}
  </ul>`;
}

/** Agent state badge: icon + label + colour, never colour alone. */
export const StateBadge = ({ state }) => html`<span class="bu-state" data-agent-state=${state}><${Icon} name=${'state-' + state} />${t('agentState.' + state)}</span>`;
