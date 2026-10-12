// Project adapter-declared connector branding through a shared, provider-neutral style.
import { html } from '../lib.js';
import { assetUrl } from '../config.js';
import { getAsset } from '../api.js';
let preparedBrands;
/** Prepared local marks supplement detectable providers without a registered adapter brand. */
export function loadPreparedConnectorBrands() {
  return preparedBrands ||= getAsset('assets/connectors/provenance.json').then(catalog=>new Map(catalog.assets.filter(a=>a.canonicalPath).map(a=>[a.id,{
    providerName:a.provider,mark:a.fallback?.monogram,color:a.fallback?.color,
    logo:a.canonicalPath.replace(/^public\/v2\//,''),
    ...(a.darkCanonicalPath && {logoDark:a.darkCanonicalPath.replace(/^public\/v2\//,'')}),
  }]))).catch(error=>{preparedBrands=null;throw error;});
}
export function connectorMarkStyle(brand) {
  return { backgroundColor: brand?.color || '#596579', color: brand?.foreground || '#ffffff' };
}

export function ConnectorBrandMark({ brand, className = '', label = null }) {
  const logo = typeof brand?.logo === 'string' ? brand.logo : null;
  const logoDark = typeof brand?.logoDark === 'string' ? brand.logoDark : null;
  const monogram = brand?.mark || brand?.monogram || '?';
  const ready = event => event.currentTarget.closest('.ao-brand-mark')?.classList.add('ao-brand-mark--ready');
  const failed = event => {
    const mark = event.currentTarget.closest('.ao-brand-mark');
    mark?.classList.add('ao-brand-mark--failed');
    if (mark && brand?.color) { mark.style.backgroundColor = brand.color; mark.style.color = brand.foreground || '#ffffff'; }
  };
  const style = logo ? { backgroundColor: 'var(--bu-surface)', color: 'var(--bu-text-primary)', '--ao-brand-color': brand?.color || '#596579' } : connectorMarkStyle(brand);
  return html`<span class=${'ao-brand-mark ' + (logo ? 'ao-brand-mark--with-logo ' : '') + (logoDark ? 'ao-brand-mark--theme-variants ' : '') + className} style=${style} aria-hidden="true" title=${label || brand?.providerName || undefined}>
    ${logo ? html`<span class="ao-brand-mark__picture"><img class="ao-brand-mark__image ao-brand-mark__image--light" src=${assetUrl(logo)} alt="" onLoad=${ready} onError=${failed} />${logoDark ? html`<img class="ao-brand-mark__image ao-brand-mark__image--dark" src=${assetUrl(logoDark)} alt="" onLoad=${ready} onError=${failed} />` : null}</span>` : null}
    <span class="ao-brand-mark__fallback">${monogram}</span>
  </span>`;
}
