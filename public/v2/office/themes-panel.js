// Theme previews use the Store draft.
import { html, useEffect, useLayoutEffect, useRef, useState } from '../lib.js';
import { Frame, Icon } from '../components/ui.js';
import { config } from '../config.js';
import { timeZone } from '../fmt.js';
import { services } from '../services.js';
import { s as tr, labelOf, locale } from './strings.js';
import { themeChoices } from './catalog.js';
import { updateTheme } from './editor-model.js';
import { resolveUrl } from './assets.js';
import { OfficeScene } from './scene.js';
import { isNight, minutesIn } from './theme.js';
import { clockTime, readTime, snapTime, nightMinutes, nightSegments } from './theme-controls.js';
const assetBase = () => services.officeAssetBase ?? config.assetBase;
const modePatch = (t, mode) => mode === 'auto' ? { mode: 'auto', nightFrom: t.nightFrom ?? '19:00', nightTo: t.nightTo ?? '07:00' } : { mode: 'fixed', fixed: mode };
const resolvedAt = (t, minutes) => t.mode === 'fixed' ? t.fixed : isNight(minutes, t.nightFrom ?? '19:00', t.nightTo ?? '07:00') ? (t.night ?? 'night') : (t.day ?? 'day');
// Bureau renderer; preview only.
function OfficePreview({ index, layout, theme, minutes = 720, mini = false }) {
  const host = useRef(null), scene = useRef(null);
  const resolved = resolvedAt(theme, minutes);
  useEffect(() => {
    const sc = new OfficeScene(host.current, { manifest: index.manifest, layout: { ...layout, theme }, assetBase: assetBase(),
      theme: { mode: 'fixed', fixed: resolved }, timeZone,
      life: { idleAfterMs: Infinity, intervalMs: Infinity, longRunMs: Infinity }, surprises: { chance: 0 } });
    scene.current = sc;
    sc.setReducedMotion(true);
    sc.setOccupants([]);
    sc.viewport.tabIndex = -1;
    sc.viewport.inert = true;
    return () => { sc.destroy(); scene.current = null; };
  }, [index]);
  useEffect(() => {
    const sc = scene.current;
    if (!sc) return;
    sc.setLayout({ ...layout, theme });
    sc.setTheme({ mode: 'fixed', fixed: resolved });
    sc.setOccupants([]);
  }, [layout, JSON.stringify(theme), resolved]);
  return html`<div ref=${host} class=${'ao-theme-scene' + (mini ? ' ao-theme-scene--mini' : '')} aria-hidden="true" data-preview-theme=${resolved} data-preview-season=${theme.season ?? ''}></div>`;
}
function ModeThumbnail({ mode, index, layout }) {
  return mode === 'auto' ? html`<span class="ao-theme-thumb ao-theme-thumb--split">
    <${OfficePreview} index=${index} layout=${layout} theme=${{ mode: 'fixed', fixed: 'day', season: null }} mini />
    <${OfficePreview} index=${index} layout=${layout} theme=${{ mode: 'fixed', fixed: 'night', season: null }} mini />
  </span>` : html`<span class="ao-theme-thumb"><${OfficePreview} index=${index} layout=${layout} theme=${{ mode: 'fixed', fixed: mode, season: null }} mini /></span>`;
}

function SeasonThumbnail({ index, season }) {
  const image = season?.thumbnail ?? index.furniture.get(season?.extras?.[0]?.asset)?.image;
  return image ? html`<img src=${resolveUrl(image, assetBase())} alt="" />`
    : season ? html`<span>${labelOf(season, 'theme').slice(0, 2)}</span>` : html`<${Icon} name="sun" />`;
}

export function ThemesPanel({ index, draft, canWrite }) {
  const data = draft.data, t = data.theme;
  const [trying, setTrying] = useState(null);
  const [minutes, setMinutes] = useState(() => snapTime(minutesIn(new Date(), timeZone() || undefined)));
  // Hover must not mask undo/redo or a saved/server-followed draft.
  useLayoutEffect(() => setTrying(null), [data]);
  const shown = trying ? { ...t, ...trying } : t;
  const mode = t.mode === 'fixed' ? t.fixed : 'auto';
  const { modes, seasons } = themeChoices(index);
  const resolved = resolvedAt(shown, minutes);
  const commit = (patch, message) => { setTrying(null); draft.commit(updateTheme(data, patch), message); };
  const from = shown.nightFrom ?? '19:00', to = shown.nightTo ?? '07:00';
  return html`<div class="ao-shop__try ao-theme-panel">
    <section class="bu-card ao-theme-preview" aria-label=${tr('shop.theme.preview')}>
      <${OfficePreview} index=${index} layout=${data} theme=${shown} minutes=${minutes} />
      <div class="ao-theme-preview__caption">
        <div><strong>${tr('shop.theme.preview')}</strong><p class="bu-caption bu-text-secondary" aria-live="polite">${labelOf(index.themes.get(resolved), 'theme')} · ${shown.season ? labelOf(index.themes.get(shown.season), 'theme') : tr('ed.seasonNone')} · ${clockTime(minutes)}</p></div>
        <label class="ao-theme-preview__time"><span class="bu-caption">${tr('shop.theme.previewTime')}</span><input type="range" min="0" max="1425" step="15" value=${minutes} aria-label=${tr('shop.theme.previewTime')} aria-valuetext=${clockTime(minutes)} onInput=${e => setMinutes(Number(e.currentTarget.value))} /></label>
      </div>
    </section>
    <${Frame} class="ao-shop__catalog" bodyClass="ao-shop__catalogue ao-theme-controls" bodyLabel=${tr('shop.tab.themes')}>
      <fieldset class="ao-theme-group"><legend class="bu-label">${tr('ed.themeGroup')}</legend>
        <div class="ao-theme-modes" onPointerLeave=${() => setTrying(null)} onFocusOut=${e => { if (!e.currentTarget.contains(e.relatedTarget)) setTrying(null); }}>
          ${modes.map(m => html`<button type="button" key=${m} data-theme-mode=${m} class=${'bu-card bu-card--interactive ao-theme-mode' + (mode === m ? ' bu-card--selected' : '')} aria-pressed=${String(mode === m)} disabled=${!canWrite}
            onPointerEnter=${e => { if (e.pointerType === 'mouse') setTrying(modePatch(t, m)); }} onFocus=${() => setTrying(modePatch(t, m))}
            onClick=${() => commit(modePatch(t, m), tr('ed.themeSet', { theme: tr('office.theme.' + m) }))}>
            <${ModeThumbnail} mode=${m} index=${index} layout=${data} />
            <span class="ao-theme-mode__label"><${Icon} name=${m === 'day' ? 'sun' : m === 'night' ? 'moon' : 'monitor'} /><span>${tr('office.theme.' + m)}</span></span>
            <span class="ao-theme-mode__current">${mode === m ? tr('shop.currentShort') : ''}</span>
          </button>`)}
        </div>
      </fieldset>
      ${t.mode === 'auto' ? html`<section class="bu-card ao-theme-hours" aria-label=${tr('shop.theme.nightHours')}>
        <h3 class="bu-label">${tr('shop.theme.nightHours')}</h3>
        <${NightRange} from=${from} to=${to} canWrite=${canWrite} onPreview=${setTrying} onCommit=${patch => commit(patch, tr('shop.theme.hoursSet'))} onCancel=${() => setTrying(null)} />
        <p class="bu-caption ao-theme-summary" aria-live="polite">${tr('shop.theme.summary', { from, to, duration: new Intl.NumberFormat(locale()).format(nightMinutes(from, to) / 60) })}</p>
      </section>` : null}
      <fieldset class="ao-theme-group ao-theme-seasons"><legend class="bu-label">${tr('ed.season')}</legend>
        <div class="ao-theme-seasonrow" role="group" aria-label=${tr('ed.season')} onPointerLeave=${() => setTrying(null)} onFocusOut=${e => { if (!e.currentTarget.contains(e.relatedTarget)) setTrying(null); }}>
          ${[{ id: '', t: null }, ...seasons].map(s => html`<button type="button" key=${s.id} class=${'bu-btn ao-theme-season' + ((t.season ?? '') === s.id ? ' is-selected' : '')} aria-pressed=${String((t.season ?? '') === s.id)} disabled=${!canWrite} data-theme-season=${s.id}
            onPointerEnter=${e => { if (e.pointerType === 'mouse') setTrying({ season: s.id || null }); }} onFocus=${() => setTrying({ season: s.id || null })} onClick=${() => commit({ season: s.id || null }, tr('ed.seasonSet'))}>
            <span class="ao-theme-season__thumb"><${SeasonThumbnail} index=${index} season=${s.t} /></span>
            <span>${s.t ? labelOf(s.t, 'theme') : tr('ed.seasonNone')}</span><${Icon} name="check" class=${(t.season ?? '') === s.id ? '' : 'ao-theme-unchecked'} />
          </button>`)}
        </div>
        <p class="bu-caption bu-text-secondary">${tr(seasons.length ? 'ed.seasonHelp' : 'ed.seasonNoneAvailable')}</p>
      </fieldset>
    </${Frame}>
  </div>`;
}

function NightRange({ from, to, canWrite, onPreview, onCommit, onCancel }) {
  const drag = useRef(null);
  const latest = useRef({ onCommit, onCancel }); latest.current = { onCommit, onCancel };
  useEffect(() => {
    const finish = () => { if (!drag.current) return; const patch = drag.current.patch; drag.current = null; if (patch) latest.current.onCommit(patch); };
    const cancel = () => { drag.current = null; latest.current.onCancel(); };
    addEventListener('pointerup', finish); addEventListener('pointercancel', cancel);
    return () => { removeEventListener('pointerup', finish); removeEventListener('pointercancel', cancel); };
  }, []);
  const change = (key, value) => { const patch = { [key]: clockTime(snapTime(Number(value))) }; if (drag.current) { drag.current.patch = patch; onPreview(patch); } else onCommit(patch); };
  return html`<div class="ao-night-range">
    <div class="ao-night-range__bar">
      ${nightSegments(from, to).map(([start, end]) => html`<span class="ao-night-range__shade" style=${{ left: start / 1440 * 100 + '%', width: (end - start) / 1440 * 100 + '%' }}></span>`)}
      ${[['nightFrom', from, 'shop.theme.start'], ['nightTo', to, 'shop.theme.end']].map(([key, value, label]) => html`<input class=${'ao-night-range__handle ao-night-range__handle--' + key} type="range" min="0" max="1440" step="15" value=${readTime(value)} disabled=${!canWrite}
        aria-label=${tr(label)} aria-valuetext=${value} onPointerDown=${() => { drag.current = {}; }} onInput=${e => change(key, e.currentTarget.value)} />`)}
    </div>
    <div class="ao-night-range__ticks" aria-hidden="true"><span>00</span><span>06</span><span>12</span><span>18</span><span>24</span></div>
    <div class="ao-night-range__fields">
      <${TimeField} label=${tr('shop.theme.start')} value=${from} disabled=${!canWrite} onCommit=${v => onCommit({ nightFrom: v })} />
      <span aria-hidden="true">—</span>
      <${TimeField} label=${tr('shop.theme.end')} value=${to} disabled=${!canWrite} onCommit=${v => onCommit({ nightTo: v })} />
      <span class="bu-caption bu-text-tertiary">${tr('shop.theme.quarters')}</span>
    </div>
  </div>`;
}
function TimeField({ label, value, disabled, onCommit }) {
  const [text, setText] = useState(value), [invalid, setInvalid] = useState(false);
  useLayoutEffect(() => { setText(value); setInvalid(false); }, [value]);
  const apply = () => {
    const minutes = readTime(text);
    if (minutes == null) { setInvalid(true); return; }
    const next = clockTime(snapTime(minutes)); setText(next); setInvalid(false);
    if (next !== value) onCommit(next);
  };
  return html`<label class="ao-theme-clock"><span class="bu-caption">${label}</span>
    <input class="bu-input" type="text" inputmode="numeric" maxlength="5" pattern="(?:[01][0-9]|2[0-3]):[0-5][0-9]" value=${text} disabled=${disabled} aria-invalid=${invalid ? 'true' : undefined}
      onInput=${e => setText(e.currentTarget.value)} onBlur=${apply} onKeyDown=${e => { if (e.key === 'Enter') { e.preventDefault(); apply(); } if (e.key === 'Escape') { setText(value); setInvalid(false); } }} />
    ${invalid ? html`<span class="bu-field__error" role="alert">${tr('shop.theme.timeFormat')}</span>` : null}
  </label>`;
}
