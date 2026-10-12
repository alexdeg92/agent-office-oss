// À propos / About (F13): what this installation runs (MetaVM: server version and build, environment, runtime adapter
// and its version, the API contract in use), the keyboard shortcuts, and the third-party notices of what the UI ships
// (third-party.json, checked by test/frontend/notices.test.js). Each licence text loads when its notice is opened.
import { html, useEffect, useState } from '../lib.js';
import { services } from '../services.js';
import { getLang, msg } from '../i18n.js';
import { registerMessages } from '../messages.js';
import * as releaseMessages from '../messages/releases.js';
import { config, buildQuery } from '../config.js';
import { getAsset, getAssetText } from '../api.js';
import { ShortcutsList, openShortcuts } from '../components/shortcuts.js';
import { Icon } from '../components/ui.js';
import { CURRENT_RELEASE } from '../release-current.js';
import { markCurrentReleaseSeen } from '../release-notes.js';

registerMessages(releaseMessages);

/** '1.0.0+dev' → { version: '1.0.0', build: 'dev' }; a version without '+' has no separate build. */
export function splitVersion(v) {
  if (!v) return { version: null, build: null };
  const i = String(v).indexOf('+');
  return i < 0 ? { version: String(v), build: null } : { version: String(v).slice(0, i), build: String(v).slice(i + 1) };
}

const Rows = ({ rows }) => html`<dl class="bu-kv">${rows.map(([k, v]) => html`<div key=${k} class="bu-kv__row"><dt>${k}</dt><dd>${v}</dd></div>`)}</dl>`;

function Licence({ file }) {
  const [text, setText] = useState(null);
  const [error, setError] = useState(false);
  const load = () => { if (text == null) getAssetText(file).then(setText, () => setError(true)); };
  return html`<details class="ao-about__licence" onToggle=${(e) => { if (e.currentTarget.open) load(); }}>
    <summary>${msg('about.readLicence')}</summary>
    ${error ? html`<p class="bu-caption bu-text-secondary">${msg('about.licenceUnavailable')}</p>` : text == null ? html`<p class="bu-caption bu-text-secondary" role="status">${msg('editorial.loading')}</p>`
      : html`<pre class="ao-about__text" tabindex="0">${text}</pre>`}
  </details>`;
}

export function AboutPage() {
  const meta = services.meta || {};
  const [notices, setNotices] = useState(null);
  const [failed, setFailed] = useState(false);
  const [releases, setReleases] = useState(null);
  const [releasesFailed, setReleasesFailed] = useState(false);
  useEffect(() => { getAsset('third-party.json').then((j) => setNotices(j.entries), () => setFailed(true)); }, []);
  useEffect(() => {
    let alive = true;
    getAsset('releases.json' + buildQuery).then((data) => {
      if (!alive) return;
      if (!Array.isArray(data.releases) || data.current?.tag !== CURRENT_RELEASE.tag || data.current?.sequence !== CURRENT_RELEASE.sequence) throw new Error('invalid release notes');
      setReleases(data.releases);
      markCurrentReleaseSeen(services.me?.email);
    }).catch(() => { if (alive) setReleasesFailed(true); });
    return () => { alive = false; };
  }, []);
  const nd = msg('editorial.notProvided');
  const { version, build } = splitVersion(meta.serverVersion);
  const rt = meta.runtime || {};
  const locale = getLang() === 'en' ? 'en-CA' : 'fr-CA';
  const dateLabel = (iso) => new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(new Date(iso + 'T12:00:00Z'));
  const rows = [
    [msg('about.version'), version || nd],
    [msg('about.build'), build || nd],
    [msg('about.env'), meta.env || nd],
    [msg('about.runtime'), rt.name ? `${rt.name}${rt.id && rt.id !== rt.name ? ' (' + rt.id + ')' : ''}` : nd],
    [msg('about.runtimeVersion'), rt.version || nd],
    [msg('about.api'), msg('about.apiValue', { path: '/api/v' + config.apiVersion, contract: meta.contractVersion || nd, model: meta.modelVersion ?? nd })],
  ];
  return html`<div class="bu-page ao-page ao-page--detail ao-about" aria-label=${msg('about.title')}>
    <section class="bu-card ao-section ao-release-notes" aria-labelledby="about-releases">
      <div class="ao-section__head"><h2 class="bu-card__title" id="about-releases">${msg('release.notes.title')}</h2></div>
      <p class="bu-caption bu-text-secondary">${msg('release.notes.lead')}</p>
      ${releasesFailed ? html`<p class="bu-text-secondary" role="status">${msg('release.notes.unavailable')}</p>` : !releases ? html`<p class="bu-text-secondary" role="status">${msg('editorial.loading')}</p>`
        : html`<ol class="ao-release-notes__list">${releases.map((release) => html`<li key=${release.tag} class=${'ao-release-notes__item' + (release.sequence === CURRENT_RELEASE.sequence ? ' ao-release-notes__item--latest' : '')}>
            <div class="ao-release-notes__head"><div class="ao-release-notes__title"><strong>${dateLabel(release.date)} · ${release.time} UTC — ${release.title[getLang()] || release.title.fr}</strong>
                <span class="ao-release-notes__version">${msg('release.notes.version', { version: release.version })}</span></div>
              ${release.sequence === CURRENT_RELEASE.sequence ? html`<span class="bu-tag ao-release-notes__latest">${msg('release.notes.latest')}</span>` : null}</div>
            <ul>${(release[getLang()] || release.fr).map((bullet, index) => html`<li key=${index}>${bullet}</li>`)}</ul>
          </li>`)}</ol>`}
    </section>
    <div class="bu-grid--2 ao-about__pair">
      <section class="bu-card ao-section" aria-labelledby="about-install">
        <h3 class="bu-card__title" id="about-install">${msg('about.install')}</h3>
        <${Rows} rows=${rows} />
      </section>
      <section class="bu-card ao-section" aria-labelledby="about-keys">
        <div class="ao-section__head"><h3 class="bu-card__title" id="about-keys">${msg('shortcut.title')}</h3><span class="bu-spacer"></span>
          <button type="button" class="bu-btn bu-btn--sm ao-about__keysbtn" onClick=${openShortcuts}>${msg('about.openKeys')}</button></div>
        <p class="bu-caption bu-text-secondary">${msg('about.keysLead')}</p>
        <${ShortcutsList} />
      </section>
    </div>
    <section class="bu-card ao-section" aria-labelledby="about-notices">
      <div class="ao-section__head"><h3 class="bu-card__title" id="about-notices">${msg('about.notices')}</h3>${notices ? html`<span class="bu-count">${notices.length}</span>` : null}</div>
      <p class="bu-caption bu-text-secondary">${msg('about.noticesLead')}</p>
      ${failed ? html`<p class="bu-text-secondary">${msg('about.noticesUnavailable')}</p>` : !notices ? html`<p class="bu-text-secondary" role="status">${msg('editorial.loading')}</p>`
        : html`<ul class="bu-list ao-about__notices">${notices.map((n) => html`<li key=${n.name} class="ao-about__notice">
            <div class="ao-about__row">
              <span class="bu-row__main"><span class="bu-row__title">${n.name} <span class="ao-about__ver">${n.version}</span></span>
                <span class="bu-row__sub">${n.copyright || msg('about.seeLicence')}</span></span>
              <span class="bu-tag">${n.licence}</span>
              ${n.url ? html`<a class="bu-btn bu-btn--sm bu-btn--ghost ao-about__url" href=${n.url} rel="noopener noreferrer" target="_blank">${msg('about.site')}<${Icon} name="external" /></a>` : null}
            </div>
            <${Licence} file=${n.licenceFile} />
          </li>`)}</ul>`}
    </section>
  </div>`;
}
