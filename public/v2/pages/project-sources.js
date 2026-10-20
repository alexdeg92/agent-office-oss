import {html} from '../lib.js';
import {msg,label} from '../i18n.js';
import {Icon} from '../components/ui.js';
import {ConnectorBrandMark} from './connector-brand.js';
export function ProjectSources({sources=[]}) {
 return html`<ul class="ao-project-sources" aria-label=${msg('project.sources')}>${sources.map(source=>html`<li key=${source.id} data-source-id=${source.id}>${source.brand?html`<${ConnectorBrandMark} brand=${source.brand} label=${label(source.label)}/>`:html`<${Icon} name="projets"/>`}<span>${label(source.label)}</span></li>`)}</ul>`;
}
