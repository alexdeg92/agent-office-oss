import { Button, Checkbox, ListRow, TextAction } from '../components/bureau/index.js';
import { html } from '../lib.js';
import { msg } from '../i18n.js';
import { Modal } from '../components/modal.js';
import { settingsLabel, readOnlyBanner } from './settings-labels.js';
import * as R from './settings-rules.js';

/** The sheet retains its reviewed action labels after the fresh VM removes fixed rows. */
export function FixAllSheet({batch, busy, readonly, readonlyReason, stale, error, onClose, onToggle, onApply, onInput, restartAction}) {
  const result=batch.result;
  const count=R.fixAllItems(batch.fixes,batch.selected).length;
  return html`<${Modal} size="md" title=${msg(result ? 'settings.fixAll.results' : 'settings.fixAll.title')}
    desc=${msg(result ? 'settings.fixAll.resultsText' : 'settings.fixAll.text')} onClose=${() => !busy && onClose()}
    footer=${html`<${Button} type="button"  disabled=${busy} onClick=${onClose} variant="secondary" size="md" label=${msg(result ? 'common.close' : 'common.cancel')} />
      ${!result ? html`<${Button} type="button"  disabled=${busy || readonly || stale || !count} busy=${busy} onClick=${onApply} variant="primary" size="md" label=${msg(busy ? 'settings.fixAll.applying' : 'settings.fixAll.apply',{n:count})} />` : null}`}>
    <div class="ao-settings__fix-all" data-fix-all=${result ? 'results' : 'selection'}>
      ${error ? html`<div class="bu-banner bu-banner--danger" role="alert"><span class="bu-banner__text">${error}</span></div>` : null}
      ${readonly && !result ? html`<p role="status">${readOnlyBanner(readonlyReason)}</p>` : null}
      ${stale && !result ? html`<p role="status">${msg('settings.fixAll.stale')}</p>` : null}
      ${!result ? html`<ul class="ao-settings__list">${batch.fixes.map(f => html`<${ListRow} key=${f.id} testId=${'fix-'+f.id}
        title=${R.selectableFix(f) ? html`<${Checkbox} checked=${batch.selected.includes(f.id)} disabled=${busy||readonly||stale} label=${settingsLabel(f.label)} onCheckedChange=${checked=>onToggle(f.id,checked)} />` : settingsLabel(f.label)}
        meta=${html`${f.detail ? html`<p>${settingsLabel(f.detail)}</p>` : !f.detail && (f.requiresConsent || f.kind === 'runtime.enable') ? html`<p>${msg('settings.fix.runtime.enableDetail')}</p>` : null}${f.requiresRestart ? html`<p>${msg('settings.restart')}</p>` : null}`}
        actions=${f.requiresInput ? html`<${TextAction} targetName=${settingsLabel(f.label)} disabled=${busy} onPress=${()=>onInput(f)} label=${msg('settings.fixAll.configure')} />` : null} />`)}</ul>` : html`<ul class="ao-settings__list" aria-label=${msg('settings.fixAll.results')}>
        ${result.items.map(item => { const fix=batch.fixes.find(f => f.id === item.id),name=settingsLabel(fix?.label)||item.id; return html`<${ListRow} key=${item.id} testId=${'fix-result-'+item.status+'-'+item.id}
          title=${name} severity=${item.status==='applied'?'ok':item.status==='failed'?'error':'info'} statusLabel=${msg('settings.fixAll.'+item.status)}
          meta=${html`<p>${msg('settings.fixAll.'+item.status)}</p>${item.error ? html`<p>${msg(({ESTALEPLAN:'settings.fixAll.error.stalePlan','settings-revision':'settings.fixAll.error.revision','reauth-required':'settings.fixAll.error.reauth'})[item.error.issue] || 'settings.fixAll.failedText')}</p>` : null}`}
          actions=${['input-required','failed'].includes(item.status)&&fix ? html`<${TextAction} targetName=${name} disabled=${busy} onPress=${()=>onInput(fix)} label=${msg('settings.fixAll.configure')} />` : null} />`; })}
      </ul>
      ${result.restartRequired ? html`<p>${msg('settings.restart')}</p>${restartAction}` : null}
      <ul class="ao-settings__list">${batch.fixes.filter(f => f.requiresInput && !(f.kind === 'instance.restart' && result.restartRequired) && !result.items.some(i => i.id === f.id)).map(f => html`<${ListRow} key=${f.id} title=${settingsLabel(f.label)} actions=${html`<${TextAction} targetName=${settingsLabel(f.label)} disabled=${busy} onPress=${()=>onInput(f)} label=${msg('settings.fixAll.configure')} />`} />`)}</ul>
      `}
    </div>
  </${Modal}>`;
}
