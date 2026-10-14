import { html, useEffect, useRef, useState } from '../lib.js';
import { Icon } from '../components/ui.js';

export function DecodedAvatar({ source, state, size, class: cls = '' }) {
  const ref = useRef(null);
  const [decoded, setDecoded] = useState(null);
  const key = JSON.stringify(source ?? null);
  const ready = decoded?.key === key && decoded.style;
  useEffect(() => {
    const image = ref.current;
    if (!source || !image) return;
    return observeAvatar(image, source, style => setDecoded({ key, style }));
  }, [key]);
  return html`<span class=${'bu-avatar bu-avatar--agent ao-character-avatar ' + cls} data-agent-state=${state}
    data-avatar-ready=${ready ? 'true' : 'false'} style=${{ overflow: 'hidden', ...(Number.isFinite(size) && size > 0 && size <= 128 ? { width: `${size}px`, height: `${size}px` } : {}) }}>
    ${ready ? null : html`<${Icon} name="agent" />`}
    ${source ? html`<img key=${key} ref=${ref} src=${source.url} alt="" draggable="false" decoding="async"
      style=${{ position: 'absolute', inset: 'auto', maxWidth: 'none', borderRadius: '0', objectFit: 'fill',
        width: '100%', height: '100%', left: '0%', top: '0%', ...(decoded?.key === key ? decoded.style : {}), visibility: ready ? 'visible' : 'hidden' }} />` : null}
  </span>`;
}

function framing(box, width, height) {
  if (!box || ![box.x, box.y, box.w, box.h, width, height].every(Number.isFinite) ||
      box.w <= 0 || box.h <= 0 || width <= 0 || height <= 0 || box.x < 0 || box.y < 0 || box.x + box.w > width || box.y + box.h > height) return null;
  const scale = 85 / Math.max(box.w, box.h);
  return { width: `${width * scale}%`, height: `${height * scale}%`,
    left: `${50 - (box.x + box.w / 2) * scale}%`, top: `${50 - (box.y + box.h / 2) * scale}%` };
}

export function observeAvatar(image, source, accept, onFailure = null) {
  let live = true, started = false;
  const failed = () => { if (live) onFailure?.(); };
  const loaded = async () => {
    if (started) return;
    started = true;
    try {
      await image.decode();
      if (!live) return;
      const style = decodedFraming(image, source);
      if (style) accept(style); else failed();
    } catch { failed(); }
  };
  image.addEventListener('load', loaded);
  image.addEventListener('error', failed);
  if (image.complete && image.naturalWidth > 0) void loaded();
  else if (image.complete && image.currentSrc) failed();
  return () => { live = false; image.removeEventListener('load', loaded); image.removeEventListener('error', failed); };
}

export function decodedFraming(image, source) {
  const declared = framing(source.box, source.canvas?.w, source.canvas?.h);
  if (declared) return declared;
  // Transparent padding in pack thumbnails is authored canvas, not portrait content.
  // Measure alpha once after decoding; work is bounded even for a large portrait.
  const scale = Math.min(1, 512 / Math.max(image.naturalWidth, image.naturalHeight));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
  try {
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
    const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let left = canvas.width, top = canvas.height, right = 0, bottom = 0;
    for (let y = 0; y < canvas.height; y++) for (let x = 0; x < canvas.width; x++) {
      if (pixels[(y * canvas.width + x) * 4 + 3] < 32) continue;
      left = Math.min(left, x); top = Math.min(top, y); right = Math.max(right, x + 1); bottom = Math.max(bottom, y + 1);
    }
    return framing({ x: left, y: top, w: right - left, h: bottom - top }, canvas.width, canvas.height);
  } catch {
    // A remote asset without CORS permission can still be displayed without a pixel read.
    return { width: '100%', height: '100%', left: '0%', top: '0%', objectFit: 'contain' };
  }
}
