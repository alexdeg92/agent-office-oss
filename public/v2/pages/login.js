// Login (Login README): brand panel with the day office on desktop, a single form. No pre-filled e-mail.
import { html, useState } from '../lib.js';
import { Icon } from '../components/ui.js';
import { Logo } from '../components/shell.js';
import { login } from '../api.js';
import { msg } from '../i18n.js';
import { services } from '../services.js';


export function LoginPage({ onLoggedIn }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  async function submit(e) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setBusy(true); setError(null);
    try {
      await login(String(f.get('email') || '').trim(), String(f.get('password') || ''));
      await onLoggedIn();
    } catch (err) {
      // architect-20: identical 401s for any bad pair; a 429 says how long to wait.
      setError(err.code === 'unauthorized' ? msg('login.invalid')
        : err.code === 'rate_limited' && Number.isFinite(err.retryAfterSec) ? msg('login.tooMany', { n: err.retryAfterSec })
        : err.message);
      setBusy(false);
    }
  }

  // The runtime's name comes from its adapter (MetaVM.runtime, G2); nothing when the server doesn't say.
  const runtime = services.meta && services.meta.runtime && services.meta.runtime.name;
  return html`<div class="bu-login">
    <div class="bu-login__art">
      <${Logo} kind="wordmark" class="ao-login-wordmark" />
      <div><h1 class="bu-login__pitch">${msg('login.pitch')}</h1>
        <p class="bu-login__lede">${msg('login.lede')}</p></div>
      <div class="bu-login__stage ao-login-stage" role="img" aria-label=${msg('login.art')}></div>
      <div class="bu-login__foot"><span>${msg('login.private')}</span>${runtime ? html`<span class="bu-mono-sm">${runtime}</span>` : null}</div>
    </div>
    <div class="bu-login__panel">
      <form class="bu-login__form" onSubmit=${submit} novalidate>
        <div class="ao-login-hero" role="img" aria-label=${msg('login.art')}></div>
        <${Logo} kind="mark" class="ao-login-mark" alt="Agent Office" />
        <div><h2 class="bu-login__title">${msg('login.title')}</h2><p class="bu-login__sub">${msg('login.sub')}</p></div>
        <div class="bu-field"><label class="bu-field__label" for="login-email">${msg('login.email')}</label>
          <input class="bu-input" id="login-email" name="email" type="email" autocomplete="username" required placeholder=${msg('login.emailPlaceholder')}
            aria-invalid=${error ? 'true' : undefined} aria-describedby=${error ? 'login-error' : undefined} /></div>
        <div class="bu-field"><label class="bu-field__label" for="login-password">${msg('login.password')}</label>
          <input class="bu-input" id="login-password" name="password" type="password" autocomplete="current-password" required
            aria-invalid=${error ? 'true' : undefined} aria-describedby=${error ? 'login-error' : undefined} /></div>
        ${error ? html`<div class="bu-banner bu-banner--danger" id="login-error" role="alert"><${Icon} name="alert" /><span class="bu-banner__text">${error}</span></div>` : null}
        <button class="bu-btn bu-btn--primary bu-btn--lg bu-btn--block" type="submit" aria-busy=${busy ? 'true' : undefined} disabled=${busy}>${msg(busy ? 'login.busy' : 'login.submit')}</button>
      </form>
    </div>
  </div>`;
}
