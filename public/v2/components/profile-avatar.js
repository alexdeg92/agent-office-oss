import { html, useEffect, useState } from '../lib.js';
import { loadModule } from '../build-update.js';
import { buildQuery, apiUrl } from '../config.js';
import { label, msg } from '../i18n.js';
import { Icon } from './ui.js';

let stylePromise;
function loadStyles() {
  if (!globalThis.document) return Promise.resolve();
  return stylePromise ||= new Promise((resolve,reject) => {
    const link=document.createElement('link');link.rel='stylesheet';link.href=new URL('./profile-avatar.css' + buildQuery,import.meta.url).href;
    link.onload=resolve;link.onerror=()=>{link.remove();stylePromise=null;reject(Error('Profile avatar styles unavailable'));};
    document.head.append(link);
  });
}

function safeAvatarUrl(value) {
  if (typeof value !== 'string' || !value || value.length > 4096 || value.startsWith('//') || /[\u0000-\u0020"'();]/.test(value)) return null;
  try {
    const target=value.startsWith('/api/v3/')?apiUrl(value,3):value;
    const url = new URL(target, globalThis.location?.origin || 'http://localhost');
    return url.protocol === 'https:' || url.origin === (globalThis.location?.origin || 'http://localhost') ? url.href : null;
  } catch { return null; }
}

/** Render the account avatar exactly as projected by MeVM/ProjectVM/ChatVM. */
export function ProfileAvatar({ avatar, size = 'md', class: cls = '', decorative = true }) {
  const [Character, setCharacter] = useState(null);
  const kind = avatar?.kind;
  useEffect(() => { loadStyles().catch(() => {}); }, []);
  useEffect(() => {
    if (kind !== 'character' || Character) return;
    let live = true;
    loadModule(() => import('./author-avatar.js' + buildQuery)).then(module => {
      if (live) setCharacter(() => module.AuthorAvatar);
    }).catch(() => {});
    return () => { live = false; };
  }, [kind, Character]);
  const accessible = decorative ? { 'aria-hidden': 'true' } : { role: 'img', 'aria-label': label(avatar?.altLabel) };
  const normalizedSize=['sm','md','lg','xl'].includes(size)?size:'md';
  const sizeClass = 'ao-profile-avatar--' + normalizedSize;
  if (kind === 'character' && avatar?.character?.id && Character) {
    const pixels={sm:32,md:40,lg:56,xl:80}[normalizedSize];
    return html`<span class=${['ao-profile-avatar',sizeClass,cls].filter(Boolean).join(' ')} ...${accessible}>
      <${Character} look=${{ character: avatar.character.id, variant: avatar.character.variant, accessories: avatar.character.accessories || [] }} size=${pixels} />
    </span>`;
  }
  const image = kind === 'photo' ? safeAvatarUrl(avatar?.imageUrl) : null;
  return html`<span class=${['bu-avatar','bu-avatar--human',sizeClass,'ao-profile-avatar',cls].filter(Boolean).join(' ')} ...${accessible}>
    ${image ? html`<img src=${image} alt="" referrerPolicy="no-referrer" decoding="async" />` : kind === 'character' ? html`<span class="ao-profile-avatar__fallback">${avatar?.initials || ''}</span>` : avatar?.initials || ''}
  </span>`;
}

function initials(email) { return ((email || '').split('@')[0].slice(0,2) || '?').toUpperCase(); }
export function ProfileUserCard({ me: initialMe, hasNewRelease, aboutHref, isAbout, onLogout }) {
  const [me,setMe]=useState(initialMe);
  useEffect(()=>{const update=event=>setMe(event.detail||null);window.addEventListener('agent-office:me',update);return()=>window.removeEventListener('agent-office:me',update);},[]);
  const who=me?.displayName||(me?.email?me.email.split('@')[0]:'');
  const role=me?.roleName||msg('shell.role.member');
  return html`<div class="bu-usercard">
    ${me?.avatar?html`<${ProfileAvatar} avatar=${me.avatar} size="md" />`:html`<span class="bu-avatar bu-avatar--human" aria-hidden="true">${initials(me?.email)}</span>`}
    <div class="bu-usercard__text"><span class="bu-usercard__name">${who}</span><span class="bu-usercard__role" title=${role}>${role}</span></div>
    <a class=${'bu-btn bu-btn--ghost bu-btn--sm ao-about-entry'+(hasNewRelease?' ao-about-entry--new':'')} href=${aboutHref} aria-label=${msg('nav.a-propos')+(hasNewRelease?', '+msg('release.notes.new'):'')} title=${msg('nav.a-propos')}
      aria-current=${isAbout?'page':undefined}><${Icon} name="info" />${hasNewRelease?html`<span class="bu-tag ao-new-release">${msg('release.notes.new')}</span>`:null}</a>
    <button class="bu-btn bu-btn--icon bu-btn--ghost bu-btn--sm" aria-label=${msg('shell.logout')} title=${msg('shell.logout')} onClick=${onLogout}><${Icon} name="logout" /></button>
  </div>`;
}
