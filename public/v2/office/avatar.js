import { html, useEffect, useState } from '../lib.js';
import { buildQuery } from '../config.js';
import { Icon } from '../components/ui.js';
import { resolveUrl } from './assets.js';

export function avatarSource(index, look, assetBase) {
  const character = look && index.characters.get(look.character);
  if (!character) return null;
  const variant = character.variants?.find(v => v.id === look.variant);
  const portrait = variant?.portrait ?? variant?.thumbnail ?? (variant ? null : character.portrait ?? character.thumbnail);
  const idle = variant?.poses?.idle ?? character.poses?.idle;
  const path = portrait ?? (typeof idle === 'string' ? idle : idle?.image ?? idle?.frames?.[0]);
  if (!path) return null;
  return { url: resolveUrl(path, assetBase), box: !portrait ? (variant?.landmarks?.idle ?? character.landmarks?.idle)?.headBox : null,
    canvas: typeof idle === 'object' ? idle.canvas ?? character.canvas : character.canvas };
}

export function CharacterAvatar(props) {
  const [Avatar, setAvatar] = useState(null);
  useEffect(() => {
    if (!props.source) return;
    let live = true;
    import('./avatar-framing.js' + buildQuery).then(m => { if (live) setAvatar(() => m.DecodedAvatar); }).catch(() => {});
    return () => { live = false; };
  }, [!!props.source]);
  if (Avatar) return html`<${Avatar} ...${props} />`;
  const size = props.size;
  return html`<span class=${'bu-avatar bu-avatar--agent ao-character-avatar ' + (props.class ?? '')} data-agent-state=${props.state}
    data-avatar-ready="false" style=${Number.isFinite(size) && size > 0 && size <= 128 ? { width: `${size}px`, height: `${size}px` } : undefined}>
    <${Icon} name="agent" />
  </span>`;
}
