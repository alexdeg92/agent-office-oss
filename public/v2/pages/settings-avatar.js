import { html, useEffect, useRef, useState } from '../lib.js';
import { config } from '../config.js';
import { msg } from '../i18n.js';
import { Icon } from '../components/ui.js';
import { Button } from '../components/bureau/forms.js';
import { Modal } from '../components/modal.js';
import { ProfileAvatar } from '../components/profile-avatar.js';

export function avatarCropRect(width,height,zoom=1,pan={x:0,y:0}) {
  if (![width,height,zoom,pan?.x,pan?.y].every(Number.isFinite) || width<=0 || height<=0 || zoom<1 || zoom>3) throw new TypeError('Invalid avatar crop');
  const side=Math.min(width,height)/zoom;
  const cx=Math.max(side/2,Math.min(width-side/2,width/2+Math.max(-1,Math.min(1,pan.x))*Math.max(0,width-side)/2));
  const cy=Math.max(side/2,Math.min(height-side/2,height/2+Math.max(-1,Math.min(1,pan.y))*Math.max(0,height-side)/2));
  return {x:cx-side/2,y:cy-side/2,width:side,height:side};
}

function CharacterPicker({ avatar, busy, onClose, onUse }) {
  const choices = Array.isArray(avatar?.characterChoices) ? avatar.characterChoices : [];
  const initialChoice = choices.find(choice => choice.selected) || null;
  const initialColour = initialChoice?.colours?.find(colour => colour.selected) || initialChoice?.colours?.find(colour => colour.default) || null;
  const [look, setLook] = useState(() => initialChoice && initialColour ? { character: initialChoice.id, variant: initialColour.id,
    accessories: initialChoice.accessories.filter(item => item.selected).map(item => item.id) } : null);
  const [query, setQuery] = useState('');
  const selected = look ? choices.find(choice => choice.id === look.character) : null;
  const selectedColour = selected?.colours.find(colour => colour.id === look.variant) || null;
  const selectedName = selected?.displayName || '';
  const selectedAccessories = selected?.accessories.filter(item => look?.accessories.includes(item.id)) || [];
  const accessoryPreviewLayers = selectedAccessories.map(item => ({ item,
    layers: item.previewLayers?.find(layer => layer.variantId === look?.variant) || null,
  })).filter(row => row.layers);
  const previewBackLayers = accessoryPreviewLayers.filter(row => row.layers.backSpriteRef);
  const previewFrontLayers = accessoryPreviewLayers.filter(row => row.layers.frontSpriteRef);
  const visibleChoices = choices.filter(item => item.displayName.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  const setColour = colour => setLook(current => {
    if (!current || current.character !== selected?.id || current.variant === colour.id) return current;
    const previousDefaults = selectedColour?.defaultAccessories || [];
    const followsDefaults = current.accessories.length === previousDefaults.length
      && current.accessories.every(id => previousDefaults.includes(id));
    return { ...current, variant: colour.id,
      accessories: followsDefaults ? [...(colour.defaultAccessories || [])] : current.accessories };
  });
  const setCharacter = item => {
    const colour = item.colours.find(value => value.default);
    if (!colour) return;
    setLook({ character: item.id, variant: colour.id, accessories: item.accessories.filter(value => value.default).map(value => value.id) });
  };
  const toggleAccessory = item => setLook(current => {
    if (!current || current.character !== selected?.id) return current;
    const active = current.accessories.includes(item.id);
    return { ...current, accessories: active ? current.accessories.filter(id => id !== item.id)
      : current.accessories.filter(id => selected.accessories.find(value => value.id === id)?.slot !== item.slot).concat(item.id) };
  });
  return html`<${Modal} title=${msg('settings.avatar.charactersTitle')} desc=${msg('settings.avatar.charactersHint')} size="lg" class="ao-account-avatar-dialog" onClose=${onClose}
    footer=${html`<${Button} type="button" disabled=${busy} onClick=${onClose} variant="secondary" size="md" label=${msg('common.cancel')} />
      <${Button} type="button" disabled=${busy || !look?.character} busy=${busy} onClick=${() => onUse(look)} variant="primary" size="md" label=${look?.character ? msg('settings.avatar.useCharacterNamed', { name: selectedName }) : msg('settings.avatar.chooseCharacter')} />`}>
    <div class="ao-account-character-picker">
      <label class="bu-field ao-account-character-picker__search"><span class="bu-field__label">${msg('settings.avatar.searchCharacters')}</span><input type="search" value=${query} placeholder=${msg('settings.avatar.searchPlaceholder')} onInput=${event => setQuery(event.currentTarget.value)} /></label>
      <div class="ao-account-character-picker__grid" role="listbox" aria-label=${msg('settings.avatar.charactersTitle')}>
        ${visibleChoices.map(item => {
          const active = item.id === look?.character;
          return html`<button key=${item.id} data-character-id=${item.id} type="button" role="option" aria-selected=${active} class=${'ao-account-character-picker__tile' + (active ? ' is-selected' : '')} disabled=${busy} onClick=${() => setCharacter(item)}>
            <span class="ao-sc-figure ao-account-character-picker__figure"><img src=${config.assetBase + item.spriteRef} alt="" loading="lazy" decoding="async" /></span>
            <span>${item.displayName}</span>${active ? html`<small>${msg('settings.avatar.chosen')}</small>` : null}
          </button>`;
        })}
        ${!visibleChoices.length ? html`<p class="bu-caption" role="status">${msg('settings.avatar.noCharacterMatch')}</p>` : null}
      </div>
      ${look ? html`<section class="ao-account-character-picker__customize" aria-label=${msg('settings.avatar.customizeNamed', { name: selectedName })}>
        <h3>${msg('settings.avatar.customizeNamed', { name: selectedName })}</h3>
        <div class="ao-account-character-picker__preview"><span class="ao-sc-figure ao-account-character-picker__large" data-account-avatar-preview="true">
          ${previewBackLayers.map(({ item, layers }) => html`<img key=${item.id + ':back'} data-preview-accessory=${item.id} data-preview-layer="back" src=${config.assetBase + layers.backSpriteRef} alt="" decoding="async" />`)}
          ${selectedColour?.spriteRef ? html`<img key=${look.variant + ':body'} data-preview-layer="body" src=${config.assetBase + selectedColour.spriteRef} alt="" decoding="async" />` : null}
          ${previewFrontLayers.map(({ item, layers }) => html`<img key=${item.id + ':front'} data-preview-accessory=${item.id} data-preview-layer="front" src=${config.assetBase + layers.frontSpriteRef} alt="" decoding="async" />`)}
        </span></div>
        <div class="ao-account-character-picker__controls">
          <div class="ao-account-character-picker__colour"><span>${msg('settings.avatar.colour')}</span><div class="ao-account-character-picker__swatches">
            ${selected.colours.map(colour => html`<button key=${colour.id} type="button" class=${'ao-account-character-picker__swatch' + (colour.id === look.variant ? ' is-selected' : '')} style=${{ '--avatar-swatch': colour.swatch || 'var(--bu-surface)' }} aria-label=${colour.displayName} aria-pressed=${colour.id === look.variant} disabled=${busy} onClick=${() => setColour(colour)}></button>`)}
          </div></div>
          <div class="ao-account-character-picker__accessories"><span>${msg('settings.avatar.accessories')}</span><div>${selected.accessories.map(item => {
            const active = look.accessories.includes(item.id);
            const previewAvailable = item.previewLayers?.some(layer => layer.variantId === look.variant && (layer.backSpriteRef || layer.frontSpriteRef));
            return html`<button key=${item.id} data-accessory-id=${item.id} data-preview-available=${previewAvailable ? 'true' : 'false'} type="button" class=${'ao-account-character-picker__chip' + (active ? ' is-selected' : '')} aria-pressed=${active} disabled=${busy} onClick=${() => toggleAccessory(item)}>${item.displayName}</button>`;
          })}</div></div>
        </div>
      </section>` : null}
    </div>
  </${Modal}>`;
}

function CropPhoto({ file, capabilities, busy, onClose, onUse }) {
  const [url, setUrl] = useState(null);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [dimensions,setDimensions]=useState({width:0,height:0});
  const [error, setError] = useState(null);
  const imageRef = useRef(null), drag = useRef(null);
  useEffect(() => {
    const next = URL.createObjectURL(file); setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [file]);
  const accepted = capabilities.acceptedTypes;
  const maxBytes = capabilities.maxBytes;
  const maxPixels = capabilities.maxPixels;
  useEffect(() => {
    if (!accepted.includes(file.type)) setError(msg('settings.avatar.invalidType'));
    else if (file.size > maxBytes) setError(msg('settings.avatar.tooLarge', { size: Math.ceil(maxBytes / 1024 / 1024) }));
  }, [file]);
  function pointerDown(event) {
    if (busy) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { x: event.clientX, y: event.clientY, pan };
  }
  function pointerMove(event) {
    if (!drag.current) return;
    const box = event.currentTarget.getBoundingClientRect();
    const side=Math.min(dimensions.width,dimensions.height)/zoom;
    const rangeX=side>0?Math.max(0,(dimensions.width-side)/(2*side)):0;
    const rangeY=side>0?Math.max(0,(dimensions.height-side)/(2*side)):0;
    const dx=rangeX?(event.clientX-drag.current.x)/(box.width*rangeX):0;
    const dy=rangeY?(event.clientY-drag.current.y)/(box.height*rangeY):0;
    setPan(previous=>({x:Math.max(-1,Math.min(1,previous.x+dx)),y:Math.max(-1,Math.min(1,previous.y+dy))}));
    drag.current = { ...drag.current, x: event.clientX, y: event.clientY };
  }
  function moveCrop(event) {
    const delta={ArrowLeft:{x:-.08,y:0},ArrowRight:{x:.08,y:0},ArrowUp:{x:0,y:-.08},ArrowDown:{x:0,y:.08}}[event.key];
    if(!delta)return;
    event.preventDefault();setPan(previous=>({x:Math.max(-1,Math.min(1,previous.x+delta.x)),y:Math.max(-1,Math.min(1,previous.y+delta.y))}));
  }
  async function crop() {
    if (busy || error) return;
    setError(null);
    try {
      const image = imageRef.current;
      if (!image?.naturalWidth || !Number.isSafeInteger(maxPixels) || maxPixels < 1 || image.naturalWidth * image.naturalHeight > maxPixels) throw Error('decode');
      const {x,y,width,height}=avatarCropRect(image.naturalWidth,image.naturalHeight,zoom,pan);
      const canvas = document.createElement('canvas'); canvas.width = 512; canvas.height = 512;
      const context = canvas.getContext('2d');
      if (!context) throw Error('canvas');
      context.drawImage(image, x, y, width, height, 0, 0, 512, 512);
      const blob = await new Promise((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(Error('encode')), 'image/png'));
      await onUse(new File([blob], 'profile-avatar.png', { type: 'image/png' }));
    } catch { setError(msg('settings.avatar.processingFailed')); }
  }
  const cropSide=Math.min(dimensions.width,dimensions.height)/zoom;
  const offsetX=cropSide>0?Math.max(0,(dimensions.width-cropSide)/(2*cropSide))*100:0;
  const offsetY=cropSide>0?Math.max(0,(dimensions.height-cropSide)/(2*cropSide))*100:0;
  return html`<${Modal} title=${msg('settings.avatar.cropTitle')} desc=${msg('settings.avatar.cropHint')} size="lg" class="ao-account-avatar-dialog" onClose=${onClose}
    footer=${html`<${Button} type="button" disabled=${busy} onClick=${onClose} variant="secondary" size="md" label=${msg('common.cancel')} />
      <${Button} type="button" disabled=${busy || !!error} busy=${busy} onClick=${crop} variant="primary" size="md" label=${msg('settings.avatar.usePhoto')} />`}>
    <div class="ao-avatar-crop">
      <div class="ao-avatar-crop__frame" role="group" aria-label=${msg('settings.avatar.cropPreview')} tabIndex="0" onKeyDown=${moveCrop} onPointerDown=${pointerDown} onPointerMove=${pointerMove} onPointerUp=${() => { drag.current = null; }} onPointerCancel=${() => { drag.current = null; }}>
        ${url ? html`<img ref=${imageRef} src=${url} alt="" draggable="false" onLoad=${event=>{const image=event.currentTarget;setDimensions({width:image.naturalWidth,height:image.naturalHeight});setError(!Number.isSafeInteger(maxPixels)||maxPixels<1||image.naturalWidth*image.naturalHeight>maxPixels?msg('settings.avatar.processingFailed'):null);}} onError=${() => setError(msg('settings.avatar.processingFailed'))}
          style=${{ transform: `translate(${-pan.x*offsetX}%, ${-pan.y*offsetY}%) scale(${zoom})` }} />` : null}
        <span class="ao-avatar-crop__mask" aria-hidden="true"></span>
      </div>
      <label class="bu-field ao-avatar-crop__zoom"><span class="bu-field__label">${msg('settings.avatar.zoom')}</span>
        <input type="range" min="1" max="3" step="0.05" value=${zoom} disabled=${busy} onInput=${event => setZoom(Number(event.currentTarget.value))} /></label>
      <p class="bu-caption bu-text-secondary">${msg('settings.avatar.photoLimits', { types: accepted.map(type => type.replace('image/', '').toUpperCase()).join(', '), size: Math.ceil(maxBytes / 1024 / 1024) })}</p>
      ${error ? html`<p class="bu-banner bu-banner--danger" role="alert">${error}</p>` : null}
    </div>
  </${Modal}>`;
}

export function AccountAvatarEditor({ avatar, name, disabled, onStage, onRemove }) {
  const [dialog, setDialog] = useState(null);
  const [fileError, setFileError] = useState(null);
  const input = useRef(null);
  const caps = avatar?.capabilities;
  const characterChoices = Array.isArray(avatar?.characterChoices) ? avatar.characterChoices : [];
  const canChooseCharacter = caps?.chooseCharacter === true && characterChoices.length > 0;
  const limits = avatar?.uploadLimits;
  const allowed = Array.isArray(limits?.acceptedTypes) && limits.acceptedTypes.length > 0
    && limits.acceptedTypes.every(type => typeof type === 'string' && /^image\/[a-z0-9.+-]+$/i.test(type)) ? limits.acceptedTypes : [];
  const maxBytes = Number.isSafeInteger(limits?.maxBytes) && limits.maxBytes > 0 ? limits.maxBytes : 0;
  const maxPixels = Number.isSafeInteger(limits?.maxPixels) && limits.maxPixels > 0 ? limits.maxPixels : 0;
  const canUploadPhoto = caps?.uploadPhoto === true && allowed.length > 0 && maxBytes > 0 && maxPixels > 0;
  async function stageCharacter(look) {
    if (!canChooseCharacter || !characterChoices.some(choice => choice.id === look?.character)) return;
    await onStage('character', { characterId: look.character, variant: look.variant, accessories: look.accessories || [] }, () => setDialog(null));
  }
  async function stagePhoto(photo) {
    if (!canUploadPhoto || !allowed.includes(photo.type) || photo.size > maxBytes) return;
    const form = new FormData(); form.append('file', photo, photo.name);
    await onStage('photo', form, () => setDialog(null));
  }
  function choose(file) {
    if (!file) return;
    if (!allowed.includes(file.type)) { setFileError(msg('settings.avatar.invalidType')); return; }
    if (file.size > maxBytes) { setFileError(msg('settings.avatar.tooLarge', { size: Math.ceil(maxBytes / 1024 / 1024) })); return; }
    setFileError(null); setDialog({ kind: 'crop', file });
  }
  function acceptDrop(event) {
    event.preventDefault();
    delete event.currentTarget.dataset.drag;
    choose(event.dataTransfer?.files?.[0]);
  }
  return html`<section class="ao-settings__group ao-account-avatar" aria-labelledby="settings-avatar-title">
    <h2 class="bu-heading-sm ao-account-avatar__title" id="settings-avatar-title">${msg('settings.avatar.title')}</h2>
    <div class="ao-account-avatar__row"><${ProfileAvatar} avatar=${avatar} size="xl" decorative=${false} />
      <div class="ao-account-avatar__copy"><strong>${name || msg('settings.avatar.profile')}</strong><p>${msg('settings.avatar.visibility')}</p><div class="ao-account-avatar__actions">
      ${canChooseCharacter ? html`<${Button} type="button" disabled=${disabled} onClick=${() => setDialog({ kind: 'characters' })} variant="secondary" size="md" label=${msg('settings.avatar.chooseCharacter')} />` : null}
      ${canUploadPhoto ? html`<${Button} type="button" disabled=${disabled} onClick=${() => {setFileError(null);setDialog({kind:'upload'});}} variant="secondary" size="md" label=${msg('settings.avatar.uploadPhoto')} />` : null}
      ${caps?.remove === true ? html`<${Button} type="button" disabled=${disabled} onClick=${onRemove} variant="ghost" size="md" label=${msg('settings.avatar.reset')} />` : null}
      ${canUploadPhoto ? html`<input ref=${input} class="bu-sr-only" type="file" accept=${allowed.join(',')} disabled=${disabled} onChange=${event => { choose(event.currentTarget.files?.[0]); event.currentTarget.value = ''; }} />` : null}
      </div></div></div>
    ${fileError && !dialog ? html`<p class="bu-banner bu-banner--danger" role="alert">${fileError}</p>` : null}
    ${dialog?.kind === 'characters' && canChooseCharacter ? html`<${CharacterPicker} avatar=${avatar} busy=${disabled} onClose=${() => setDialog(null)} onUse=${stageCharacter} />` : null}
    ${dialog?.kind === 'upload' ? html`<${Modal} title=${msg('settings.avatar.uploadTitle')} desc=${msg('settings.avatar.uploadHint')} class="ao-account-avatar-dialog" onClose=${() => setDialog(null)}
      footer=${html`<${Button} type="button" onClick=${() => setDialog(null)} variant="secondary" size="md" label=${msg('common.cancel')} />`}>
      <div class="ao-avatar-upload" onDragOver=${event=>{event.preventDefault();event.currentTarget.dataset.drag='true';}} onDragLeave=${event=>{delete event.currentTarget.dataset.drag;}} onDrop=${acceptDrop}>
        <span class="ao-avatar-upload__icon" aria-hidden="true"><${Icon} name="tool-image" /></span>
        <p>${msg('settings.avatar.dropPhoto')}</p>
        <${Button} type="button" disabled=${disabled} onClick=${()=>input.current?.click()} variant="secondary" size="md" label=${msg('settings.avatar.browse')} />
        <p class="bu-caption bu-text-secondary">${msg('settings.avatar.photoLimits',{types:allowed.map(type=>type.replace('image/','').toUpperCase()).join(', '),size:Math.ceil(maxBytes/1024/1024)})}</p>
        ${fileError ? html`<p class="bu-banner bu-banner--danger" role="alert">${fileError}</p>` : null}
      </div>
    </${Modal}>` : null}
    ${dialog?.kind === 'crop' ? html`<${CropPhoto} file=${dialog.file} capabilities=${limits} busy=${disabled} onClose=${() => setDialog(null)} onUse=${stagePhoto} />` : null}
  </section>`;
}
