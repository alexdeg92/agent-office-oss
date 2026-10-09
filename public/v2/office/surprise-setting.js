import { html, useState, useEffect } from '../lib.js';
import { surprisesEnabled, saveSurprises } from './surprises.js';
import { s as tr } from './strings.js';
export function SurpriseSetting() {
  const [on,setOn]=useState(surprisesEnabled);
  useEffect(()=>{const sync=e=>setOn(e.detail);window.addEventListener('office-surprises-setting',sync);return ()=>window.removeEventListener('office-surprises-setting',sync);},[]);
  return html`<label class="bu-field"><span><input type="checkbox" checked=${on} onChange=${e=>saveSurprises(e.target.checked)} /> ${tr('egg.setting')}</span><span class="bu-field__hint">${tr('egg.settingHint')}</span></label>`;
}
