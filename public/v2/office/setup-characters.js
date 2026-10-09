import { buildQuery } from '../config.js';
// First-run setup, « characters » step (O5, office-dev; frontend embeds it in the setup flow, F8). For each agent
// the runtime discovered: a character, a colour and accessories, with a live preview drawn from the real sprites
// (body between the accessory back and front layers, as in the scene). The result is a plain object
// { agentId → { character, variant, accessories } } (setup-looks.js). Every character the manifest ships is offered,
// so a new family (family B) appears with no code change. FR + EN (strings.js), keyboard only works throughout.
//
// Use it as a Preact component:  html`<${SetupCharacters} agents=${…} value=${…} onChange=${(looks) => …} />`
// or mount it anywhere:          const step = mountSetupCharacters(el, { agents, value, onChange }); step.value(); step.destroy();
//   agents: [{ id, name, primary? }]  (id: the runtime's agent id; name: its display name, data, never translated)
//   manifest?: the asset manifest (default: <assetBase>office/manifest.example.json)   assetBase?: default config.assetBase
//   Embedding (O6, the Bureau editor): value is controlled (a new value, e.g. after undo, is shown); selected/onSelect
//   follow the caller's selection; embedded hides the setup heading; agents[].note replaces the « Agent » line.
import { html, render, useState, useEffect, useMemo, useRef } from '../lib.js';
import { config } from '../config.js';
import { indexManifest, poseImage, accessoryLayers, resolveUrl } from './assets.js';
import { s, labelOf } from './strings.js';
import * as M from './setup-looks.js';

const CSS = new URL('./setup-characters.css' + buildQuery, import.meta.url).href;
const POSES = ['idle', 'working', 'thinking', 'celebrating'];

function useCss() {
  useEffect(() => {
    if (document.querySelector('link[data-setup-characters]') || [...document.querySelectorAll('link[rel=stylesheet]')].some((l) => l.href === CSS)) return;
    const l = document.createElement('link');
    l.rel = 'stylesheet'; l.href = CSS; l.dataset.setupCharacters = '';
    document.head.append(l);
  }, []);
}

/** The manifest: the one given, else the shipped one. */
function useManifest(given, assetBase) {
  const [state, set] = useState(given ? { manifest: given, error: null } : { manifest: null, error: null });
  const [n, setN] = useState(0);
  useEffect(() => {
    if (given) { set({ manifest: given, error: null }); return undefined; }
    let live = true;
    fetch(`${assetBase}office/manifest.example.json`).then((r) => { if (!r.ok) throw new Error(String(r.status)); return r.json(); })
      .then((m) => live && set({ manifest: m, error: null }), (error) => live && set({ manifest: null, error }));
    return () => { live = false; };
  }, [given, assetBase, n]);
  return { ...state, retry: () => setN((x) => x + 1) };
}

/** Body and accessory layers of a look in a pose, as image paths (back layers, body, front layers). */
export function lookLayers(index, look, pose = 'idle') {
  const ch = index.characters.get(look.character);
  if (!ch) return [];
  const body = poseImage(ch, look.variant, pose);
  const acc = accessoryLayers(index, ch.id, look.accessories, body.pose, look.variant, { legacy: false });
  return [...acc.back.map((a) => a.path), body.path, ...acc.front.map((a) => a.path)];
}

export const Figure = ({ index, look, pose, assetBase, label, cls, thumbnail = false }) => {
  const [, refresh] = useState(0);
  useEffect(() => {
    let live = true;
    const controller = new AbortController();
    const c = index.characters.get(look.character);
    if (!thumbnail && c?.packManifest && !c.packLoaded) {
      import('./character-pack-loader.js' + buildQuery).then(m => m.ensureCharacterPack(index, look.character, assetBase, { signal: controller.signal }))
        .then(() => { if (live) refresh(n => n + 1); }).catch(() => {});
    }
    return () => { live = false; controller.abort(); };
  }, [index, look.character, assetBase, thumbnail]);
  const ch = index.characters.get(look.character), v = ch?.variants?.find(v => v.id === look.variant);
  const thumb = v?.thumbnail ?? ch?.thumbnail;
  const paths = thumbnail && thumb ? [thumb] : lookLayers(index, look, pose);
  return html`<span class=${'ao-sc-figure ' + (cls || '')} role=${label ? 'img' : undefined} aria-label=${label || undefined}
    aria-hidden=${label ? undefined : 'true'}>${paths.map((p, i) => html`<img key=${i} src=${resolveUrl(p, assetBase)} alt="" draggable="false" loading=${thumbnail ? 'lazy' : undefined} decoding="async" />`)}</span>`;
};

export function SetupCharacters({ agents = [], value = null, onChange, manifest: given = null, assetBase = config.assetBase, selected = null, onSelect = null, embedded = false }) {
  useCss();
  const m = useManifest(given, assetBase);
  if (!agents.length) return html`<section class="ao-sc"><p class="ao-sc__help">${s('setup.noAgents')}</p></section>`;
  if (m.error) return html`<section class="ao-sc"><p class="ao-sc__help" role="alert">${s('setup.failed')}</p>
    <button type="button" class="bu-btn" onClick=${m.retry}>${s('office.retry')}</button></section>`;
  if (!m.manifest) return html`<section class="ao-sc" aria-busy="true"><p class="ao-sc__help" role="status">${s('setup.loading')}</p></section>`;
  return html`<${Step} agents=${agents} value=${value} onChange=${onChange} manifest=${m.manifest} assetBase=${assetBase} selected=${selected} onSelect=${onSelect} embedded=${embedded} />`;
}

function Step({ agents, value, onChange, manifest, assetBase, selected, onSelect, embedded }) {
  const index = useMemo(() => indexManifest(manifest), [manifest]);
  // Controlled when the caller passes both `value` and `onChange` (the Bureau editor, the setup flow): the looks shown
  // are always derived from `value`, and an edit only calls onChange. There is no internal copy that an echo could
  // overwrite (office-dev-13: the stale-echo race of office-dev-12 is gone by construction). Without a value, the
  // step keeps its own looks and reports them.
  const controlled = value != null && typeof onChange === 'function';
  const agentsKey = agents.map((a) => a.id).join('\n');
  const [own, setOwn] = useState(() => M.initialLooks(index, agents, value || {}));
  const valueKey = controlled ? JSON.stringify(value) : '';
  const looks = useMemo(() => M.initialLooks(index, agents, controlled ? value : own), [controlled, valueKey, own, index, agentsKey]);
  const [ownCurrent, setOwnCurrent] = useState(agents[0].id);
  const current = selected && agents.some((a) => a.id === selected) ? selected : ownCurrent;
  const setCurrent = (id) => { setOwnCurrent(id); onSelect?.(id); };
  const [pose, setPose] = useState('idle');
  const [say, setSay] = useState('');
  const [hint, setHint] = useState(null);
  useEffect(() => { if (!agents.some((a) => a.id === current)) setCurrent(agents[0].id); }, [agentsKey]);
  // The caller always holds a complete, normalized result: once at mount, then on every change.
  useEffect(() => { onChange?.(M.result(looks, agents)); }, []);
  const first = useRef(true);
  useEffect(() => { if (first.current) { first.current = false; return; } if (!controlled) onChange?.(M.result(own, agents)); }, [own]);

  const agent = agents.find((a) => a.id === current) ?? agents[0];
  const look = looks[agent.id];
  if (!look) return null;
  const ch = index.characters.get(look.character);
  const variants = ch?.variants ?? [];
  const charLabel = (c) => labelOf(c, 'character');
  const variantLabel = (v) => labelOf(v, 'variant');
  const accLabel = (a) => labelOf(a, 'accessory');
  const summary = (l) => {
    const c = index.characters.get(l.character);
    const v = c?.variants?.find((x) => x.id === l.variant);
    return v ? s('setup.lookSummary', { character: charLabel(c), variant: variantLabel(v) }) : s('setup.lookSummaryPlain', { character: charLabel(c) });
  };
  const update = (next, message) => {
    if (controlled) onChange(M.result({ ...looks, [agent.id]: next }, agents));
    else setOwn((prev) => ({ ...M.initialLooks(index, agents, prev), [agent.id]: next }));
    if (message) setSay(message);
  };
  // Grouped lists (O7: the editor separates agents from default rules); one Tab stop and arrows across all of them.
  const grouped = agents.some((a) => a.group);
  const groups = grouped ? ['agents', 'defaults'].map((id) => ({ id, label: s('setup.group.' + id), items: agents.map((a, i) => ({ a, i })).filter(({ a }) => (a.group ?? 'agents') === id) })).filter((g) => g.items.length)
    : [{ id: 'all', label: null, items: agents.map((a, i) => ({ a, i })) }];
  const choices = M.characterChoices(index);
  const slots = M.accessorySlots(index);
  const notDrawn = look.accessories.some((id) => !M.accessoryDrawn(index, look, id));

  function onAgentKey(e, i) {
    const k = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 }[e.key] ?? (e.key === 'Home' ? -Infinity : e.key === 'End' ? Infinity : 0);
    if (!k) return;
    e.preventDefault();
    const j = Math.max(0, Math.min(agents.length - 1, Number.isFinite(k) ? i + k : k < 0 ? 0 : agents.length - 1));
    setCurrent(agents[j].id);
    // Focus moves at once (every agent's button is rendered): fast repeated arrows each move one agent.
    e.currentTarget.closest('.ao-sc__agents')?.querySelectorAll('.ao-sc__agent')[j]?.focus();
  }

  return html`<section class=${'ao-sc' + (embedded ? ' ao-sc--embedded' : '')} aria-labelledby=${embedded ? 'ao-sc-editing' : 'ao-sc-title'}>
    ${embedded ? null : html`<h2 class="ao-sc__title" id="ao-sc-title">${s('setup.title')}</h2>
    <p class="ao-sc__help">${s('setup.help')}</p>`}
    <div class="ao-sc__grid">
      <div class="ao-sc__agents">
        ${embedded ? null : html`<p class="ao-sc__label" id="ao-sc-agents">${s('setup.agents')}</p>`}
        ${embedded ? html`<label class="bu-field ao-sc__pick"><span class="bu-field__label">${s('setup.agents')}</span>
          <select class="bu-select" value=${agent.id} onChange=${(e) => setCurrent(e.currentTarget.value)}>
            ${agents.map((a) => html`<option key=${a.id} value=${a.id}>${a.name} · ${summary(looks[a.id])}</option>`)}</select></label>` : null}
        ${groups.map((g) => html`${g.label ? html`<p class="ao-sc__group" id=${'ao-sc-group-' + g.id}>${g.label}</p>` : null}
        <ul class="ao-sc__list" aria-labelledby=${g.label ? 'ao-sc-group-' + g.id : embedded ? undefined : 'ao-sc-agents'} aria-label=${!g.label && embedded ? s('setup.agents') : undefined}>${g.items.map(({ a, i }) => html`<li key=${a.id}>
          <button type="button" id=${'ao-sc-agent-' + i} class="ao-sc__agent" title=${embedded ? `${a.note ?? ''} · ${summary(looks[a.id])}` : undefined} aria-current=${a.id === agent.id ? 'true' : undefined}
            tabindex=${a.id === agent.id ? 0 : -1} onClick=${() => setCurrent(a.id)} onKeyDown=${(e) => onAgentKey(e, i)}>
            <${Figure} index=${index} look=${looks[a.id]} pose="idle" assetBase=${assetBase} cls="ao-sc-figure--sm" />
            <span class="ao-sc__agenttext"><span class="ao-sc__name">${a.name}</span>
              <span class=${'ao-sc__role' + (embedded ? ' ao-sr' : '')}>${a.note ?? s(a.primary ? 'setup.primary' : 'setup.other')}</span>
              <span class=${'ao-sc__look' + (embedded ? ' ao-sr' : '')}>${summary(looks[a.id])}</span></span>
          </button></li>`)}</ul>`)}
      </div>
      <div class="ao-sc__editor" role="group" aria-labelledby="ao-sc-editing">
        <h3 class="ao-sc__subtitle" id="ao-sc-editing">${s('setup.editing', { name: agent.name })}</h3>
        <div class="ao-sc__preview">
          <${Figure} index=${index} look=${look} pose=${pose} assetBase=${assetBase} cls="ao-sc-figure--lg"
            label=${s('setup.preview', { name: agent.name, character: summary(look), pose: s('setup.pose.' + pose) })} />
          <label class="bu-field ao-sc__pose"><span class="bu-field__label">${s('setup.pose')}</span>
            <select class="bu-select" value=${pose} onChange=${(e) => setPose(e.currentTarget.value)}>
              ${POSES.map((p) => html`<option key=${p} value=${p}>${s('setup.pose.' + p)}</option>`)}</select></label>
        </div>
        <fieldset class="ao-sc__set"><legend class="ao-sc__label">${s('setup.character')}</legend>
          <div class="ao-sc__cards">${choices.map((c) => html`<label key=${c.id} class=${'ao-sc__card' + (c.id === look.character ? ' is-on' : '')}>
            <input type="radio" name=${'ao-sc-char-' + agent.id} value=${c.id} checked=${c.id === look.character}
              onChange=${() => { const next = M.withCharacter(index, look, c.id); setHint(null); update(next, s('setup.set.character', { name: agent.name, character: charLabel(index.characters.get(c.id)) })); }} />
            <${Figure} index=${index} look=${M.withCharacter(index, { character: null, variant: null, accessories: [] }, c.id)} pose="idle" assetBase=${assetBase} thumbnail=${true} cls="ao-sc-figure--sm" />
            <span>${charLabel(index.characters.get(c.id))}</span></label>`)}</div>
        </fieldset>
        ${variants.length ? html`<fieldset class="ao-sc__set"><legend class="ao-sc__label">${s('setup.colour')}</legend>
          <div class="ao-sc__swatches">${variants.map((v) => html`<label key=${v.id} class=${'ao-sc__swatch' + (v.id === look.variant ? ' is-on' : '')}>
            <input type="radio" name=${'ao-sc-var-' + agent.id} value=${v.id} checked=${v.id === look.variant}
              onChange=${() => update(M.withVariant(index, look, v.id), s('setup.set.colour', { name: agent.name, colour: variantLabel(v) }))} />
            <span class="ao-sc__dot" style=${{ backgroundColor: safeColor(v.swatch) }} aria-hidden="true"></span>${variantLabel(v)}</label>`)}</div>
        </fieldset>` : null}
        <fieldset class="ao-sc__set"><legend class="ao-sc__label">${s('setup.accessories')}</legend>
          ${slots.map(([slot, items]) => html`<div key=${slot} class="ao-sc__slot" role="group" aria-labelledby=${'ao-sc-slot-' + slot}>
            <span class="ao-sc__slotlabel" id=${'ao-sc-slot-' + slot}>${s('ed.slot.' + slot)}</span>
            ${items.map((a) => html`<button key=${a.id} type="button" class="bu-btn bu-btn--sm ao-sc__acc" aria-pressed=${look.accessories.includes(a.id) ? 'true' : 'false'}
              onClick=${() => {
                const r = M.withAccessory(index, look, a.id);
                setHint(r.replaced ? s('setup.set.replaced', { name: agent.name, old: accLabel(index.accessories.get(r.replaced)), accessory: accLabel(a) }) : null);
                update(r.look, r.replaced ? s('setup.set.replaced', { name: agent.name, old: accLabel(index.accessories.get(r.replaced)), accessory: accLabel(a) })
                  : s(r.added ? 'setup.set.added' : 'setup.set.removed', { name: agent.name, accessory: accLabel(a) }));
              }}>${accLabel(a)}</button>`)}
          </div>`)}
          ${look.accessories.length ? null : html`<p class="ao-sc__note">${s('setup.noAccessories')}</p>`}
          ${hint ? html`<p class="ao-sc__note">${hint}</p>` : null}
          ${notDrawn ? html`<p class="ao-sc__note">${s('setup.notDrawn')}</p>` : null}
        </fieldset>
        <button type="button" class="bu-btn ao-sc__reset" onClick=${() => {
          const i = agents.filter((a) => !a.primary).findIndex((a) => a.id === agent.id);
          update(M.defaultLook(index, agent, agent.primary ? 0 : i), s('setup.set.reset', { name: agent.name }));
        }}>${s('setup.reset')}</button>
      </div>
    </div>
    <p class="ao-sr ao-sc__live" aria-live="polite">${say}</p>
  </section>`;
}

/** Manifest colours only: hex, rgb() or hsl(); anything else is dropped (never reaches CSS unvalidated). */
const COLOR_RE = /^(#[0-9a-f]{3,8}|rgba?\([\d.,%\s]+\)|hsla?\([\d.,%\sdeg]+\))$/i;
const safeColor = (c) => (typeof c === 'string' && COLOR_RE.test(c.trim()) ? c.trim() : '');

/** Mount the step on any element; returns { value(), update(opts), destroy() }. */
export function mountSetupCharacters(host, opts = {}) {
  let current = null;
  let props = opts;
  const draw = () => render(html`<${SetupCharacters} ...${props} onChange=${(v) => { current = v; props.onChange?.(v); }} />`, host);
  draw();
  return {
    value: () => current,
    update(next) { props = { ...props, ...next }; draw(); },
    destroy() { render(null, host); },
  };
}
