// « Redémarrer la passerelle » (api.md §5.1): kills the agents' running work, so it needs the typed word « redemarrer »,
// is rate-limited (429), and is refused on read-only instances (403 readonly). Only Owner triggers it (CLAUDE.md).
import { html, useState } from '../lib.js';
import { Modal } from './modal.js';
import { Icon } from './ui.js';
import { post } from '../api.js';
import { toast } from '../toast.js';
import { msg } from '../i18n.js';

export const CONFIRM_WORD = 'redemarrer';

export function RestartGatewayModal({ onClose, readonly = false }) {
  const [word, setWord] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const armed = word.trim().toLowerCase() === CONFIRM_WORD && !readonly;
  async function submit(e) {
    e.preventDefault();
    if (!armed) return;
    setBusy(true); setError(null);
    try {
      await post('/api/v2/gateway/restart', { confirm: CONFIRM_WORD }, { quiet: true });
      toast({ level: 'success', message: msg('restart.requested') });
      onClose();
    } catch (err) {
      setBusy(false);
      setError(err.message);
    }
  }
  return html`<${Modal} title=${msg('restart.title')} desc=${msg('restart.desc')} onClose=${onClose}
    footer=${html`<button type="button" class="bu-btn" onClick=${onClose}>${msg('common.cancel')}</button>
      <button type="submit" form="restart-form" class=${'bu-btn ' + (armed ? 'bu-btn--armed' : 'bu-btn--danger-ghost')} disabled=${!armed || busy} aria-busy=${busy ? 'true' : undefined}>
        <${Icon} name="refresh" />${msg('restart.submit')}</button>`}>
    <form id="restart-form" class="ao-form" onSubmit=${submit} novalidate>
      ${readonly ? html`<div class="bu-banner bu-banner--warning" role="status"><${Icon} name="warning" /><span class="bu-banner__text">${msg('restart.readonly')}</span></div>` : null}
      <div class="bu-banner bu-banner--danger"><${Icon} name="alert" /><span class="bu-banner__text">${msg('restart.warning')}</span></div>
      <div class="bu-field"><label class="bu-field__label" for="restart-word">${msg('restart.typeBefore')} <span class="bu-mono-sm">${CONFIRM_WORD}</span> ${msg('restart.typeAfter')}</label>
        <input class="bu-input" id="restart-word" autocomplete="off" autocapitalize="off" spellcheck="false" autofocus value=${word} disabled=${readonly}
          aria-invalid=${error ? 'true' : undefined} aria-describedby=${error ? 'restart-err' : undefined} onInput=${(e) => setWord(e.currentTarget.value)} />
        ${error ? html`<p class="bu-field__error" id="restart-err" role="alert"><${Icon} name="alert" />${error}</p>` : null}</div>
    </form>
  </${Modal}>`;
}
