// Additional chapters use the existing Bureau cards and the setup page's in-memory state.
import { html, useState } from '../lib.js';
import { msg } from '../i18n.js';
export function DetectionStep({ s, busy, detect }) {
  const found = (s.detections || []).filter(d => d.found);
  return html`<h2 class="bu-title ao-setup__h" id="setup-etape">${msg('onboarding.detect.head')}</h2>
    <p class="bu-text-secondary">${msg('onboarding.detect.text')}</p>
    <div role="status" aria-live="polite">${busy === 'detect' ? msg('onboarding.detect.wait') : !found.length ? msg('onboarding.detect.none') : null}</div>
    <ul class="bu-list">${found.map(d => html`<li key=${d.runtime} class="bu-card ao-onb-card" data-runtime=${d.runtime}>
      <strong>${d.name}</strong><p>${msg(d.supported ? 'onboarding.detect.found' : 'onboarding.detect.unsupported')}</p>
      ${d.connection?.gatewayUrl ? html`<p class="bu-caption" data-detected-connection>${msg(d.connection.tokenSet ? 'onboarding.detect.connectionReady' : 'onboarding.detect.addressReady')}</p>` : null}
      <ul class="ao-onb-detected-agents">${d.agents.map(a => html`<li key=${a.id} class="ao-onb-detected-agent" data-detected-agent=${a.id}>
        ${a.name ? html`<strong>${a.name}</strong>` : html`<span class="bu-chip bu-chip--sm bu-text-secondary" data-name-missing>${msg('onboarding.detect.nameMissing')}</span>`}
        <code>${a.id}</code>${a.nameSource ? html`<span class="bu-chip bu-chip--sm" data-name-source>${a.nameSource}</span>` : null}</li>`)}</ul></li>`)}</ul>
    <button type="button" class="bu-btn" disabled=${!!busy} onClick=${detect}>${msg('onboarding.detect.retry')}</button>`;
}
export function SkillsStep({ s, set, busy, plan, apply }) {
  const [confirm, setConfirm] = useState(false);
  const rows = s.skillPlan?.agents || [];
  return html`<h2 class="bu-title ao-setup__h" id="setup-etape">${msg('onboarding.skills.head')}</h2>
    <p class="bu-text-secondary">${msg('onboarding.skills.text')}</p>
    <button type="button" class="bu-btn" onClick=${() => { setConfirm(false); plan(); }} disabled=${!!busy}>${msg('onboarding.skills.plan')}</button>
    <ul class="bu-list">${rows.map(a => {
      const result = s.skillResults?.find(x => x.id === a.id), status = result?.status || a.status;
      return html`<li class="bu-card ao-onb-card" key=${a.id} data-skill-agent=${a.id}>
        <label class="bu-check"><input type="checkbox" checked=${s.skillSelection?.includes(a.id)} disabled=${a.status === 'unsupported' || !!busy}
          onChange=${e => { setConfirm(false); set({ skillSelection: e.currentTarget.checked ? [...(s.skillSelection || []), a.id] : s.skillSelection.filter(id => id !== a.id) }); }} />
          ${(s.agents || []).find(x => x.id === a.id)?.name || a.id}</label>
        <p role="status">${msg('onboarding.skills.' + (status === 'removed' ? 'absent' : status))}</p>
        ${a.files.length ? html`<ul class="ao-onb-files">${a.files.map(f => html`<li key=${f}><code>${f}</code></li>`)}</ul>` : html`<p class="bu-caption">${msg('onboarding.skills.none')}</p>`}
        ${a.uninstallFiles?.length ? html`<details><summary>${msg('onboarding.skills.removeFiles')}</summary><ul class="ao-onb-files">${a.uninstallFiles.map(f => html`<li key=${f}><code>${f}</code></li>`)}</ul></details>` : null}
        ${result?.backup ? html`<code class="ao-onb-path">${result.backup}</code>` : null}</li>`;
    })}</ul>
    ${(s.detections || []).filter(d => d.found && !d.supported).map(d => html`<p key=${d.runtime}>${d.name} — ${msg('onboarding.skills.unsupported')}</p>`)}
    ${s.skillPlan?.backupDir ? html`<p class="bu-caption ao-onb-path">${msg('onboarding.skills.backup', { path: s.skillPlan.backupDir })}</p>` : null}
    ${rows.some(a => a.status !== 'unsupported') ? html`<label class="bu-check"><input id="setup-skill-confirm" type="checkbox" checked=${confirm} onChange=${e => setConfirm(e.currentTarget.checked)} />${msg('onboarding.skills.confirm')}</label>
      <div class="ao-onb-actions"><button type="button" class="bu-btn bu-btn--primary" id="setup-install" disabled=${!confirm || !!busy || !s.skillSelection?.length} onClick=${() => apply('install')}>${msg('onboarding.skills.install')}</button>
      <button type="button" class="bu-btn" id="setup-uninstall" disabled=${!confirm || !!busy || !s.skillSelection?.length} onClick=${() => apply('uninstall')}>${msg('onboarding.skills.uninstall')}</button></div>` : null}`;
}
function Snippet({ name, text }) {
  const [copied, setCopied] = useState(null);
  return html`<details class="ao-onb-snippet"><summary>${name}</summary>
    <button type="button" class="bu-btn bu-btn--sm" onClick=${async () => { try { await navigator.clipboard.writeText(text); setCopied('onboarding.copied'); } catch { setCopied('onboarding.copy.failed'); } }}>${msg('onboarding.copy')}</button>
    ${copied ? html`<p role="status">${msg(copied)}</p>` : null}<pre><code>${text}</code></pre></details>`;
}
export function NetworkStep({ s, set, busy, inspect, probe }) {
  const n = s.network, g = s.networkGuide, detected = s.networkDetected || g;
  const change = patch => set({ network: { ...n, ...patch }, accessResult: null, networkGuide: null });
  const external = ['public', 'tunnel', 'tailnet'].includes(n.mode);
  return html`<h2 class="bu-title ao-setup__h" id="setup-etape">${msg('onboarding.network.head')}</h2>
    <p class="bu-text-secondary">${msg('onboarding.network.text')}</p>
    <div class="bu-field"><label for="setup-network-mode">${msg('onboarding.network.mode')}</label>
      <select class="bu-select" id="setup-network-mode" value=${n.mode} onChange=${e => change({ mode: e.currentTarget.value, publicUrl: '' })}>
        ${['local', 'lan', 'tailnet', 'public', 'tunnel'].map(mode => html`<option key=${mode} value=${mode}>${msg('onboarding.network.' + mode)}${mode === 'tailnet' && detected?.tailnet ? ' · ' + msg('onboarding.detect.found') : ''}</option>`)}</select></div>
    ${detected?.tailnet ? html`<p class="bu-text-secondary" data-network-suggestion>${msg('onboarding.network.tailSuggestion')}</p>` : null}
    <div class="bu-field"><label for="setup-network-port">${msg('onboarding.network.port')}</label><input class="bu-input" id="setup-network-port" type="number" min="1" max="65535" value=${n.port} onInput=${e => change({ port: Number(e.currentTarget.value) })} /></div>
    ${n.mode !== 'local' ? html`<div class="bu-field"><label for="setup-public-url">${msg('onboarding.network.origin')}</label><input class="bu-input" id="setup-public-url" type="url" placeholder=${n.mode === 'lan' ? 'http://192.168.1.10:18789' : 'https://bureau.example.com'} value=${n.publicUrl || ''} onInput=${e => change({ publicUrl: e.currentTarget.value })} /></div>` : null}
    ${external ? html`<p class="ao-setup__warn">${msg('onboarding.network.https')}</p>` : null}
    <div class="bu-field"><label for="setup-domain">${msg('onboarding.network.domain')}</label><input class="bu-input" id="setup-domain" autocomplete="off" value=${s.domain || ''} onInput=${e => set({ domain: e.currentTarget.value, networkGuide: null })} /></div>
    <div class="ao-onb-actions"><button type="button" class="bu-btn" disabled=${!!busy} onClick=${() => inspect(false)}>${msg('onboarding.network.inspect')}</button>
    <button type="button" class="bu-btn" disabled=${!!busy} onClick=${() => inspect(true)}>${msg('onboarding.network.publicIp')}</button>
    <button type="button" class="bu-btn" disabled=${!!busy} onClick=${probe}>${msg('onboarding.network.test')}</button></div>
    ${s.accessResult ? html`<p role="status">${msg(s.accessResult.ok ? 'onboarding.network.valid' : 'onboarding.network.failed')}</p>` : null}
    ${g ? html`<div class="bu-card bu-card--sunken ao-onb-card" role="status"><p>${msg('onboarding.network.bind', g.bind)}</p>
      ${g.publicIp ? html`<p>${msg('onboarding.network.ip', { ip: g.publicIp })}</p>` : null}
      <p>${msg(g.tailnet ? 'onboarding.network.tailFound' : 'onboarding.network.tailMissing')}</p>
      ${g.tailnet?.dnsName ? html`<code>${g.tailnet.dnsName}</code>` : null}
      <p>${msg('onboarding.network.dns.' + g.dns.status)}</p>
      ${g.dns.addresses.length ? html`<code>${g.dns.addresses.join(', ')}</code>` : null}</div>` : null}
    ${n.mode !== 'local' && n.mode !== 'lan' ? html`<p class="bu-text-secondary">${msg('onboarding.network.checklist')}</p>` : null}
    ${g ? html`<p class="bu-caption bu-text-secondary">${msg('onboarding.network.commands')}</p>
      ${n.mode === 'tailnet' ? html`<${Snippet} name="Tailscale" text=${g.tailscaleCommand} />` : null}
      ${Object.entries(g.snippets).map(([name, text]) => html`<${Snippet} key=${name} name=${name} text=${text} />`)}` : null}`;
}
