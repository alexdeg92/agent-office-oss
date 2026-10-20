// App shell (Nav README): desktop sidebar + top bar; mobile top bar + 5-slot bottom bar (BRIEF decisions log).
import { assetUrl, buildQuery } from '../config.js';
import { html, useEffect, useState } from '../lib.js';
import { Frame, Icon, LivePill, Clock, ConnectionBanner } from './ui.js';
import { NAV, BOTTOM_TABS, routeByName, activeNav, activeTab } from '../router.js';
import { services } from '../services.js';
import { useStore, runtimeCan } from '../hooks.js';
import { theme, setTheme } from '../theme.js';
import { isMock } from '../api.js';
import { withAgent, msg, getLang, LANGS } from '../i18n.js';
import { chooseLang } from '../lang.js';

const LOGOS = assetUrl('bureau/assets/Logos/');

export function watchReleaseBadgeFor(email, setBadge) {
  let active = true, stop = () => {};
  import('../release-badge.js' + buildQuery).then(({ watchReleaseBadge }) => {
    if (active) stop = watchReleaseBadge(email, setBadge);
  }).catch(() => { if (active) setBadge(true); });
  return () => { active = false; stop(); };
}

/** Light/dark logo pair; app.css shows the one that fits the current theme. */
export function Logo({ kind = 'wordmark', class: cls = '', alt = 'Agent Office' }) {   // the product name: not translated
  return html`<span class=${'ao-logo ao-logo--' + kind + ' ' + cls}>
    <img class="ao-on-dark" src=${LOGOS + kind + '-dark.svg'} alt=${alt} />
    <img class="ao-on-light" src=${LOGOS + kind + '.svg'} alt="" aria-hidden="true" />
  </span>`;
}

/** Shown whenever the data is fictitious; lives in the bars so it never covers an action. */
export const MockBadge = ({ floating = false }) => html`<span class=${'ao-mockbadge' + (floating ? ' ao-mockbadge--floating' : '')} title=${msg('shell.mock.title')}>${msg('shell.mock')}</span>`;

export function ThemeSwitch() {
  const { pref } = useStore(theme);
  const opts = [['system', 'monitor', msg('theme.system')], ['light', 'sun', msg('theme.light')], ['dark', 'moon', msg('theme.dark')]];
  return html`<div class="bu-segmented ao-theme" role="radiogroup" aria-label=${msg('theme.label')}>
    ${opts.map(([v, icon, label]) => html`<button type="button" class="bu-segmented__opt" role="radio" aria-checked=${pref === v ? 'true' : 'false'}
      title=${label} onClick=${() => setTheme(v)}><${Icon} name=${icon} /><span class="ao-theme__label">${label}</span></button>`)}
  </div>`;
}

/** UI language (F6): FR / EN, in the user menu beside the theme. Switching keeps the page, its filters and drafts. */
export function LangSwitch() {
  const cur = getLang();
  return html`<div class="bu-segmented ao-theme ao-lang" role="radiogroup" aria-label=${msg('lang.label')}>
    ${LANGS.map((l) => html`<button key=${l} type="button" class="bu-segmented__opt" role="radio" lang=${l} aria-checked=${cur === l ? 'true' : 'false'}
      title=${msg('lang.' + l)} onClick=${() => chooseLang(l)}><span aria-hidden="true">${l.toUpperCase()}</span><span class="bu-sr-only">${msg('lang.' + l)}</span></button>`)}
  </div>`;
}

function initials(email) {
  const name = (email || '').split('@')[0];
  return (name.slice(0, 2) || '?').toUpperCase();
}

export function Shell({ match, me, status, onLogout, children }) {
  const { router } = services;
  const navActive = activeNav(match);
  const tab = activeTab(match);
  const route = match.route && (match.route.parent ? routeByName(match.route.parent) : match.route);
  const override = key => key && msg(key) !== key ? msg(key) : null;
  const title = override(match.route?.titleKey) || (route ? route.label : msg('shell.notFound'));
  const question = override(match.route?.subtitleKey) || (route ? route.question : msg('shell.notFound.question'));
  // MeVM.displayName (2.2): the owner's name, else the e-mail's local part (v1 /api/me has no displayName).
  const who = (me && me.displayName) || (me && me.email ? me.email.split('@')[0] : '');
  const email = me?.email || '';
  const [hasNewRelease, setHasNewRelease] = useState(false);
  useEffect(() => watchReleaseBadgeFor(email, setHasNewRelease), [email]);

  return html`<div class="bu-shell">
    <a class="ao-skip" href="#contenu">${msg('shell.skip')}</a>
    <nav class="bu-sidebar" aria-label=${msg('shell.nav')}>
      <a class="bu-brand" href=${router.href('bureau')} aria-label=${msg('shell.home')}><${Logo} kind="wordmark" class="ao-brand-wordmark" /></a>
      <ul class="bu-nav">
        ${NAV.filter((r) => runtimeCan(r.needs)).map((r) => html`<li key=${r.name}><a class="bu-nav__item" href=${router.href(r.name)} aria-current=${navActive === r.name ? 'page' : undefined}>
          <${Icon} name=${r.icon} />${r.label}</a></li>`)}
      </ul>
      <div class="ao-sidebar-foot">
        <div class="ao-prefs"><${ThemeSwitch} /><${LangSwitch} /></div>
        <div class="bu-usercard">
          <span class="bu-avatar bu-avatar--human" aria-hidden="true">${initials(who)}</span>
          <div class="bu-usercard__text"><span class="bu-usercard__name">${who}</span><span class="bu-usercard__role" title=${me?.roleName||msg('shell.role.member')}>${me?.roleName||msg('shell.role.member')}</span></div>
          <a class=${'bu-btn bu-btn--ghost bu-btn--sm ao-about-entry' + (hasNewRelease ? ' ao-about-entry--new' : '')} href=${router.href('a-propos')} aria-label=${msg('nav.a-propos') + (hasNewRelease ? ', ' + msg('release.notes.new') : '')} title=${msg('nav.a-propos')}
            aria-current=${match.name === 'a-propos' ? 'page' : undefined}><${Icon} name="info" />${hasNewRelease ? html`<span class="bu-tag ao-new-release">${msg('release.notes.new')}</span>` : null}</a>
          <button class="bu-btn bu-btn--icon bu-btn--ghost bu-btn--sm" aria-label=${msg('shell.logout')} title=${msg('shell.logout')} onClick=${onLogout}><${Icon} name="logout" /></button>
        </div>
      </div>
    </nav>
    <div class="bu-shell__main">
      <header class="bu-topbar">
        <div class="bu-topbar__titles"><h1 class="bu-topbar__title">${title}</h1><p class="bu-topbar__question">${withAgent(question)}</p></div>
        <span class="bu-spacer"></span>
        ${isMock() ? html`<${MockBadge} />` : null}
        <${LivePill} status=${status} />
        <${Clock} />
      </header>
      <header class="bu-mtopbar">
        <${Logo} kind="mark" class="bu-brand__mark" alt="" />
        <h1 class="bu-topbar__title ao-mtitle">${title}</h1>
        <span class="bu-spacer"></span>
        ${isMock() ? html`<${MockBadge} />` : null}
        <${LivePill} status=${status} compact />
      </header>
      <${ConnectionBanner} status=${status} onReconnect=${() => services.stream.reconnect()} />
      <${Frame} tag="main" id="contenu" class="ao-main" tabindex="-1" bodyLabel=${title}
        bodyClass=${match.route?.framed ? 'ao-frame__body--framed' : ''} bodyProps=${{ key: match.name + JSON.stringify(match.params) }}>${children}</${Frame}>
      <nav class="bu-bottombar" aria-label=${msg('shell.tabs')}>
        ${BOTTOM_TABS.filter((name) => runtimeCan(routeByName(name).needs)).map((name) => {
          const r = routeByName(name);
          return html`<a key=${name} class="bu-bottombar__item" href=${router.href(name)} aria-current=${tab === name ? 'page' : undefined}><${Icon} name=${r.icon} />${r.label}</a>`;
        })}
      </nav>
    </div>
  </div>`;
}
