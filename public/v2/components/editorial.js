// Editorial building blocks (F6, design/components/Editorial): render message descriptors { key, params, tone }
// from page rules as sentences. Figures inside a sentence stay prose (bu-ed-fig); tone is colour AND wording.
import { html } from '../lib.js';
import { rich, msg } from '../i18n.js';

const FIGURE = (raw) => typeof raw === 'number' || (raw && typeof raw === 'object' && ('n' in raw || 'at' in raw || 'ago' in raw || 'clock' in raw));

/** One sentence. Numeric and time params become figures; `level` (a second descriptor) follows as its own sentence. */
export function Say({ s, as = 'span', figures = true }) {
  if (!s) return null;
  const body = rich(s.key, s.params, (name, text, raw) => (figures && FIGURE(raw) ? html`<span class="bu-ed-fig">${text}</span>` : text));
  const level = s.level ? html` <strong>${msg(s.level.key, s.level.params)}</strong>` : null;
  const cls = s.tone ? 'bu-ed-tone--' + s.tone : undefined;
  return as === 'span' ? html`<span class=${cls}>${body}${level}</span>` : html`<p class=${cls}>${body}${level}</p>`;
}

/** Several sentences in one paragraph, separated by spaces. */
export const Says = ({ list, cls = 'bu-ed-prose' }) => html`<p class=${cls}>${list.map((s, i) => html`${i ? ' ' : ''}<${Say} key=${s.key + i} s=${s} />`)}</p>`;

/** A decorative section number (01, 02…): hidden from screen readers, the heading says the same. */
export const Folio = ({ n, sm = false }) => html`<span class=${'bu-ed-folio' + (sm ? ' bu-ed-folio--sm' : '')} aria-hidden="true">${String(n).padStart(2, '0')}</span>`;
