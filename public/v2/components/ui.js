// Small shared components on top of the Bureau classes (bundle.css). No colours here: tokens only.
import { html, useState, useRef } from '../lib.js';
import { useStore, useNow } from '../hooks.js';
import { toasts, dismiss } from '../toast.js';
import * as fmt from '../fmt.js';
import { msg } from '../i18n.js';
import { assetUrl } from '../config.js';
import { services } from '../services.js';

/** <${Icon} name="sante" size="md" /> — Lucide symbol from icons.js. Decorative unless `label` is set. */
export function Icon({ name, size, label, class: cls = '' }) {
  const c = ['bu-icon', size ? `bu-icon--${size}` : '', cls].filter(Boolean).join(' ');
  return label
    ? html`<svg class=${c} role="img" aria-label=${label}><title>${label}</title><use href=${'#i-' + name} /></svg>`
    : html`<svg class=${c} aria-hidden="true"><use href=${'#i-' + name} /></svg>`;
}

const TOAST_ICON = { info: 'info', success: 'success', warning: 'warning', danger: 'alert' };
export function Toasts() {
  const { items } = useStore(toasts);
  return html`<div class="bu-toasts" role="status" aria-live="polite">
    ${items.map((t) => html`<div key=${t.id} class=${'bu-toast' + (t.level !== 'info' ? ' bu-toast--' + t.level : '') + (t.className ? ' ' + t.className : '')}>
      <${Icon} name=${TOAST_ICON[t.level] || 'info'} />
      <span class="bu-toast__text">${t.message}${t.code || t.requestId ? html`<small><span class="bu-mono-sm">${[t.code, t.requestId].filter(Boolean).join(' · ')}</span></small>` : null}</span>
      ${t.action ? html`<button class=${'bu-btn bu-btn--sm' + (t.actionVariant === 'text' ? ' ao-toast-action--text' : '')} onClick=${() => { dismiss(t.id); t.action.run(); }}>${t.action.label}</button>` : null}
      <button class="bu-btn bu-btn--ghost bu-btn--icon bu-btn--sm" aria-label=${msg('common.close')} title=${msg('common.close')} onClick=${() => dismiss(t.id)}><${Icon} name="close" /></button>
    </div>`)}
  </div>`;
}

/** An empty or not-found state: the Bureau empty component (frontend-22: the original look), with an optional state spot. */
export function EmptyState({ icon = 'info', title, text, children, compact = false, art = null }) {
  return html`<div class=${'bu-empty' + (compact ? ' bu-empty--compact' : '')}>
    ${art ? html`<${StateArt} slug=${art} class="ao-state__art" />` : html`<div class="bu-empty__art"><${Icon} name=${icon} /></div>`}
    <p class="bu-empty__title">${title}</p>
    ${text ? html`<p class="bu-empty__text">${text}</p>` : null}
    ${children}
  </div>`;
}

/**
 * artist-15 state spots (480 × 320 CSS, 960 × 640 WebP, light and dark). Both variants are lazy images and CSS shows
 * the one for the active theme: a lazy image that isn't displayed is never fetched, so one file loads. The names are
 * literal (scripts/sync-design.js ships what the UI names).
 */
const STATE_ART = {
  'no-projects': ['state-no-projects-light.webp', 'state-no-projects-dark.webp'],
  'no-flows': ['state-no-flows-light.webp', 'state-no-flows-dark.webp'],
  'no-logs-filter': ['state-no-logs-filter-light.webp', 'state-no-logs-filter-dark.webp'],
  'gateway-unreachable': ['state-gateway-unreachable-light.webp', 'state-gateway-unreachable-dark.webp'],
  'not-found': ['state-not-found-light.webp', 'state-not-found-dark.webp'],
  'first-run': ['state-first-run-light.webp', 'state-first-run-dark.webp'],
};
export const STATE_ART_SLUGS = Object.keys(STATE_ART);
export function StateArt({ slug, class: cls = '' }) {
  const pair = STATE_ART[slug];
  if (!pair) return null;
  return html`<span class=${'ao-stateart ' + cls} aria-hidden="true">${pair.map((f, i) => html`<img key=${f} class=${'ao-illus ' + (i ? 'ao-art--dark' : 'ao-art--light')}
    src=${assetUrl('bureau/assets/Illustrations/' + f)} alt="" width="480" height="320" loading="lazy" decoding="async" />`)}</span>`;
}

/** Error state for a failed view load: cause, way out, code in mono (README §2). */
export function ErrorState({ error, onRetry, compact = false }) {
  const code = error && error.code ? error.code.toUpperCase() : null;
  const unreachable = !compact && error && /^upstream_/.test(error.code || '');   // the runtime or its gateway, not our server
  return html`<div class=${'bu-empty bu-empty--error' + (compact ? ' bu-empty--compact' : '')} role="alert">
    ${unreachable ? html`<${StateArt} slug="gateway-unreachable" class="ao-state__art" />` : html`<div class="bu-empty__art"><${Icon} name="alert" /></div>`}
    <p class="bu-empty__title">${msg('common.loadFailed')}</p>
    <p class="bu-empty__text">${(error && error.message) || msg('common.unexpected')}${code || (error && error.requestId) ? html` <code class="bu-mono-sm">${[code, error && error.requestId].filter(Boolean).join(' · ')}</code>` : null}</p>
    ${onRetry ? html`<button class="bu-btn" onClick=${onRetry}><${Icon} name="refresh" />${msg('common.retry')}</button>` : null}
    ${unreachable && services.router ? html`<a class="bu-btn" href=${services.router.href('parametres',{}, {onglet:'connexion'})}>${msg('settings.openConnection')}</a>` : null}
  </div>`;
}

/**
 * F10: the connection banner. Shown when the stream has been down for 3 s or more (no flash on a quick reconnect):
 * offline → how old the data on screen is; retrying → the countdown to the next attempt and « Reconnecter ».
 */
export const BANNER_AFTER_MS = 3000;
export function ConnectionBanner({ status, onReconnect }) {
  const now = useNow(1000);
  const since = useRef(null);   // when the stream went down (useNow re-renders every second)
  const down = status.conn === 'offline' || status.conn === 'retrying';
  if (!down) since.current = null; else if (since.current == null) since.current = Date.now();
  if (!down || now - since.current < BANNER_AFTER_MS) return null;
  const offline = status.conn === 'offline';
  const wait = status.nextRetryAt ? Math.max(0, Math.ceil((status.nextRetryAt - now) / 1000)) : null;
  return html`<div class=${'bu-banner ao-connbanner' + (offline ? ' bu-banner--warning' : '')} role="status">
    <${Icon} name=${offline ? 'warning' : 'refresh'} />
    <span class="bu-banner__text">${offline ? msg('live.banner.offline') : wait ? msg('live.banner.retrying', { n: wait }) : msg('live.banner.retryingNow')}
      ${status.lastFrameAt ? html` ${msg('live.banner.age', { ago: { ago: status.lastFrameAt, now } })}` : null}</span>
    ${offline ? null : html`<button type="button" class="bu-btn bu-btn--sm" onClick=${onReconnect}>${msg('live.banner.reconnect')}</button>`}
    <a class="bu-btn bu-btn--sm" href=${services.router.href('parametres',{}, {onglet:'connexion'})}>${msg('settings.openConnection')}</a>
  </div>`;
}

/** Live pill: stream connection + gateway (S8: « Reconnexion… » when the gateway is down). */
export function LivePill({ status, compact = false }) {
  if (status.gateway === 'down') return html`<span class="bu-live bu-live--off" title=${msg('live.gatewayDown.title')}>${msg(compact ? 'live.offline' : 'live.gatewayDown')}</span>`;
  if (status.conn === 'open' && status.topicsOk !== false) return html`<span class="bu-live">${msg('live.on')}</span>`;
  if (status.conn === 'idle') return null;
  return html`<span class="bu-live bu-live--stale" title=${msg('live.lost.title')}>${msg('live.reconnecting')}</span>`;
}

export function Clock() {
  const now = useNow(1000);
  return html`<time class="bu-topbar__clock" datetime=${new Date(now).toISOString()}>${fmt.time(now, { seconds: true })}</time>`;
}

/** Relative time that stays fresh while the page is open. */
export function Ago({ at }) {
  const now = useNow(15_000);
  return html`<time datetime=${Number.isFinite(at) ? new Date(at).toISOString() : undefined} title=${fmt.dateTime(at, now)}>${fmt.relative(at, now)}</time>`;
}

/**
 * Single-series sparkline (up to 24 h, one point per stepMs; it says the span it actually covers). 2px line in text ink, no legend (the tile names it),
 * a hover readout, and an aria-label summary for screen readers.
 */
export function Sparkline({ values, at0, stepMs, label, format = fmt.percent, max = 100 }) {
  const [hover, setHover] = useState(null);
  const ref = useRef(null);
  if (!values || values.length < 2) return null;
  const W = 240, H = 40, n = values.length;
  const top = Math.max(max, ...values);
  const x = (i) => (i / (n - 1)) * W;
  const y = (v) => H - 2 - (v / top) * (H - 4);
  const d = values.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join('');
  const lo = Math.min(...values), hi = Math.max(...values), last = values[n - 1];
  // The span actually observed (first to last sample), never the retention target (explorer-qa-03 Q03-F05).
  const span = { n: (n - 1) * stepMs, unit: 'ms' };
  const summary = msg('spark.summary', { label, duration: span, lo: format(lo), hi: format(hi), last: format(last) });
  const onMove = (e) => {
    const r = ref.current.getBoundingClientRect();
    const i = Math.round(Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * (n - 1));
    setHover(i);
  };
  return html`<div class="ao-spark">
    <svg ref=${ref} class="ao-spark__svg" viewBox=${`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label=${summary}
      onPointerMove=${onMove} onPointerLeave=${() => setHover(null)}>
      <path class="ao-spark__line" d=${d} vector-effect="non-scaling-stroke" />
      ${hover != null ? html`<line class="ao-spark__cursor" x1=${x(hover)} x2=${x(hover)} y1="0" y2=${H} vector-effect="non-scaling-stroke" />` : null}
    </svg>
    <span class="ao-spark__read bu-mono-sm" aria-hidden="true">${hover != null ? `${fmt.time(at0 + hover * stepMs)} · ${format(values[hover])}` : msg('spark.footer', { duration: span, hi: format(hi) })}</span>
  </div>`;
}

/** Loading placeholder. `w` (30 | 40 | 50 | 60 | 70) shortens a line; `style` stays for the office's own sizes. */
export function Skeleton({ kind, w, style }) {
  return html`<span class=${'bu-skeleton' + (kind ? ' bu-skeleton--' + kind : '') + (w ? ' ao-sk--w' + w : '')} style=${style} aria-hidden="true"></span>`;
}

// Shared bounded region: only its body scrolls; head and foot occupy grid rows.
export function Frame({ tag = 'div', class: cls = '', head, bar, foot, bodyClass = '', bodyLabel, bodyProps = {}, elementRef, children, ...attrs }) {
  const framed = bodyClass.split(' ').includes('ao-frame__body--framed');
  return html`<${tag} class=${'ao-frame ' + cls} ref=${elementRef} ...${attrs}>
    <div class="ao-frame__head">${head}</div>
    <div class="ao-frame__bar">${bar}</div>
    <div class=${'ao-frame__body ' + bodyClass} data-scroll-body tabindex=${framed ? undefined : '0'}
      role=${bodyLabel ? 'region' : undefined} aria-label=${bodyLabel} ...${bodyProps}>${children}</div>
    <div class="ao-frame__foot">${foot}</div>
  </${tag}>`;
}
