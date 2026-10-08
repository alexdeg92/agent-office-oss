import { buildQuery } from '../config.js';
// Standalone harness for the setup « characters » step (O5). Query: ?lang=en  ?theme=light  ?agents=0 (none)
//   ?value=<json> (an initial value)  ?manifest=404 (the manifest can't be loaded)
import * as fmt from '../fmt.js';
import * as i18n from '../i18n.js';
import { mountSetupCharacters } from './setup-characters.js';

const q = new URLSearchParams(location.search);
const designBase = '../../../design/';
for (const href of ['css/bureau.css', 'components/bundle.css']) {
  const l = document.createElement('link'); l.rel = 'stylesheet'; l.href = designBase + href + buildQuery; document.head.append(l);
}
if (q.get('lang')) { if (typeof i18n.setLang === 'function') i18n.setLang(q.get('lang')); else fmt.setLocale(q.get('lang') === 'en' ? 'en-CA' : 'fr-CA'); }
document.documentElement.lang = q.get('lang') === 'en' ? 'en-CA' : 'fr-CA';
if (q.get('theme')) document.documentElement.dataset.theme = q.get('theme');

// Synthetic runtime agents (names are data; never « Timmy » assumed, never `main` as the primary).
const agents = q.get('agents') === '0' ? [] : [
  { id: 'orion', name: 'Orion', primary: true },
  { id: 'lyra', name: 'Lyra' },
  { id: 'vega', name: 'Vega' },
  { id: 'atlas', name: 'Atlas' },
];
const out = document.getElementById('out');
const step = mountSetupCharacters(document.getElementById('step'), {
  agents,
  value: q.get('value') ? JSON.parse(q.get('value')) : null,
  assetBase: q.get('manifest') === '404' ? '/nowhere/' : designBase,
  onChange: (v) => { out.textContent = JSON.stringify(v, null, 1); window.setupValue = v; },
});
window.setupStep = step;
