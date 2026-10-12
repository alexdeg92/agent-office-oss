// The not-found page, the mobile « Plus » page, and a neutral placeholder for any route without a page yet.
import { html, useEffect, useState } from '../lib.js';
import { EmptyState, Icon } from '../components/ui.js';
import { ThemeSwitch, LangSwitch } from '../components/shell.js';
import { NAV, routeByName, BOTTOM_TABS } from '../router.js';
import { services } from '../services.js';
import { msg } from '../i18n.js';
import { runtimeCan } from '../hooks.js';
import { watchReleaseBadge } from '../release-badge.js';

export function PlaceholderPage({ match }) {
  const r = match.route.parent ? routeByName(match.route.parent) : match.route;
  return html`<div class="bu-page bu-page--narrow">
    <${EmptyState} icon=${r.icon} title=${msg('placeholder.title', { page: r.label })} text=${msg('placeholder.text')} />
  </div>`;
}

export function NotFoundPage() {
  return html`<div class="bu-page bu-page--narrow">
    <${EmptyState} icon="warning" art="not-found" title=${msg('shell.notFound')} text=${msg('shell.notFound.text')}>
      <a class="bu-btn" href=${services.router.href('bureau')}>${msg('shell.backToOffice')}</a>
    </${EmptyState}>
  </div>`;
}

/** « Plus » (mobile): the pages that aren't in the bottom bar, the theme, and logout. */
export function MorePage({ onLogout }) {
  const { router } = services;
  const email = services.me?.email || '';
  const [hasNewRelease, setHasNewRelease] = useState(false);
  useEffect(() => watchReleaseBadge(email, setHasNewRelease), [email]);
  const extra = NAV.filter((r) => !BOTTOM_TABS.includes(r.name) && runtimeCan(r.needs));
  return html`<div class="bu-page">
    <ul class="bu-morelist">
      ${extra.map((r) => html`<li key=${r.name}><a class="bu-morelist__item" href=${router.href(r.name)}><${Icon} name=${r.icon} size="md" />${r.label}<${Icon} name="chevron-right" /></a></li>`)}
      <li key="a-propos"><a class="bu-morelist__item" href=${router.href('a-propos')}><${Icon} name="info" size="md" />${msg('nav.a-propos')}${hasNewRelease ? html`<span class="bu-tag ao-new-release">${msg('release.notes.new')}</span>` : null}<${Icon} name="chevron-right" /></a></li>
    </ul>
    <section class="bu-section" aria-labelledby="plus-apparence">
      <h2 class="bu-eyebrow" id="plus-apparence">${msg('shell.appearance')}</h2>
      <${ThemeSwitch} />
      <${LangSwitch} />
    </section>
    <button class="bu-btn bu-btn--danger-ghost bu-btn--block" onClick=${onLogout}><${Icon} name="logout" />${msg('shell.logout')}</button>
  </div>`;
}
