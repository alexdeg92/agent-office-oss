import { html, useEffect, useState } from '../lib.js';
import { buildQuery } from '../config.js';
import * as api from '../api.js';
import { services } from '../services.js';
import { msg, getLang } from '../i18n.js';
import { Icon } from '../components/ui.js';
import {
  loadStyles as loadBureauStyles, Switch, SettingRow, ListRow, Menu, KeyValue, TextAction,
  CollapsedGroup, Field, TextInput, TextArea, Select, Checkbox, Radio, Button, TabButton,
} from '../components/bureau/index.js';
import { SettingsSection, Badge, StatusChip, Banner, Link, InlineEditableText, SecretField, ConfirmDialog, Disclosure, EmptyState } from '../components/bureau/primitives.js';

let sheet;
const tr = (fr, en) => getLang() === 'en' ? en : fr;
export async function loadStyles() {
  await loadBureauStyles();
  if (sheet) return sheet;
  const href = new URL('./design-system.css' + buildQuery, import.meta.url);
  sheet = new Promise((resolve, reject) => {
    const link = document.createElement('link');
    link.rel = 'stylesheet'; link.href = href.href; link.dataset.designSystemCss = '';
    link.onload = resolve; link.onerror = () => { link.remove(); sheet = null; reject(new Error('Design system gallery stylesheet unavailable')); };
    document.head.append(link);
  });
  return sheet;
}

const demo = {
  id: 'agent:sample:local:desk',
  source: 'Configuration locale (exemple)',
};

export function DesignSystemPage() {
  const [stylesReady, setStylesReady] = useState(false);
  const [styleError, setStyleError] = useState(false);
  const [access, setAccess] = useState('checking');
  const [checked, setChecked] = useState(false);
  const [name, setName] = useState('Atelier local');
  const [text, setText] = useState('');
  const [area, setArea] = useState('A short, editable multiline value.');
  const [selectValue, setSelectValue] = useState('medium');
  const [radio, setRadio] = useState('one');
  const [menuSeen, setMenuSeen] = useState('');
  const [tab, setTab] = useState('forms');
  const [dialog, setDialog] = useState(false);
  const [secret, setSecret] = useState(null);

  const ensureStyles = () => {
    setStyleError(false);
    loadStyles().then(() => setStylesReady(true), () => setStyleError(true));
  };
  useEffect(() => { ensureStyles(); }, []);

  useEffect(() => {
    if (!services.meta || !['dev','staging','production'].includes(services.meta.env)) { setAccess('denied'); return; }
    let active = true;
    (async () => {
      // The standalone mock represents the signed-in owner only; ordinary dev mocks still ask the API gate.
      if (api.isMock()) {
        const mock = await api.mock();
        if (mock.isStandalone() && services.me?.email) { if (active) setAccess('allowed'); return; }
      }
      try {
        const result = await api.get('/api/v2/design-system/access', { quiet:true, cache:'no-store' });
        if (active) setAccess(result.data?.allowed === true ? 'allowed' : 'denied');
      } catch { if (active) setAccess('denied'); }
    })();
    return () => { active = false; };
  }, []);

  if (!stylesReady) return styleError
    ? html`<div class="ds-gate" role="alert"><span>${tr('Styles indisponibles.','Styles are unavailable.')}</span><${Button} label=${tr('Réessayer','Retry')} onPress=${ensureStyles} /></div>`
    : html`<div class="ds-gate" role="status" aria-busy="true"><span class="bu-spinner" aria-hidden="true"></span><span>${tr('Chargement de la bibliothèque','Loading the library')}</span></div>`;
  if (access === 'checking') return html`<div class="ds-gate" role="status" aria-busy="true"><span class="bu-spinner" aria-hidden="true"></span><span>${tr('Vérification de l’accès','Checking gallery access')}</span></div>`;
  if (access !== 'allowed') return html`<div class="ds-gate"><${EmptyState} icon="system" title=${tr('Accès indisponible','Access unavailable')} text=${tr('Cette galerie est réservée au propriétaire de l’instance.','This design-system gallery is restricted to the instance owner.')} compact /></div>`;

  const menuItems = [
    { id:'primary', label:tr('Définir comme principal','Make primary'), onSelect:() => setMenuSeen(tr('Définir comme principal','Make primary')) },
    { id:'hide', label:tr('Masquer du bureau','Hide from office'), onSelect:() => setMenuSeen(tr('Masquer du bureau','Hide from office')) },
    { id:'sep', kind:'separator' },
    { id:'remove', label:tr('Retirer du bureau','Remove from office'), danger:true, onSelect:() => setMenuSeen(tr('Retirer du bureau','Remove from office')) },
  ];
  const tabs = [
    ['forms',tr('Formulaires','Forms')], ['rows',tr('Lignes','Rows')], ['actions',tr('Actions','Actions')], ['states',tr('États','States')],
  ];

  return html`<main class="ds-gallery" data-design-system-gallery>
    <header class="ds-intro">
      <p class="ds-eyebrow">${tr('Bureau · bibliothèque partagée','Bureau · shared library')}</p>
      <h2>${tr('Les composants en situation','Components in context')}</h2>
      <p>${tr('Exemples interactifs de la bibliothèque publique. Les actions sont locales et ne modifient aucune donnée.','Live examples from the public component API. Interactions below are local demonstrations; nothing is saved.')}</p>
      <div class="ds-meta"><span>${tr('Jetons d’identité actifs','Current identity tokens')}</span><span>${tr('Le clair et le sombre suivent le bureau','Light / dark follow the shell')}</span><span>1440 · 390 · 375</span></div>
    </header>

    <nav class="ds-tabs" role="tablist" aria-label="Component groups">
      ${tabs.map(([id,label], index) => html`<${TabButton} key=${id} id=${'ds-tab-' + id} label=${label} selected=${tab === id} controls=${'ds-panel-' + id} tabIndex=${tab === id ? 0 : -1}
        onClick=${() => setTab(id)} onKeyDown=${e => {
          if (!['ArrowLeft','ArrowRight','Home','End'].includes(e.key)) return;
          e.preventDefault();
          const next = e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1 : (index + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length;
          setTab(tabs[next][0]); document.getElementById('ds-tab-' + tabs[next][0])?.focus();
        }} />`)}
    </nav>
    ${menuSeen ? html`<p class="ds-action-feedback" role="status">${tr('Dernière action :','Last action:')} ${menuSeen}</p>` : null}

    ${tab === 'forms' ? html`<section id="ds-panel-forms" role="tabpanel" aria-labelledby="ds-tab-forms" class="ds-panel">
      <${SettingsSection} title=${tr('Champs et commandes','Form controls')} description=${tr('Libellés, associations, comportement natif et états de chargement.','Labels, associations, native behavior and real pending states.')} testId="forms-section">
        <div class="ds-grid ds-grid--two">
          <div class="ds-sample"><h3>${tr('Champ · normal, erreur, environnement','Field · default, error, environment')}</h3>
            <${Field} id="ds-name" label=${tr('Nom de l’instance','Instance name')} hint=${tr('Visible par les personnes de cet espace.','Visible to people in this workspace.')} control=${props => html`<${TextInput} ...${props} value=${name} onValueChange=${setName} autoComplete="organization" />`} />
            <${Field} id="ds-invalid" label=${tr('Port','Port')} error=${tr('Saisissez un port entre 1 et 65 535.','Use a port from 1 to 65,535.')} control=${props => html`<${TextInput} ...${props} type="number" value="70000" onValueChange=${() => {}} min=${1} max=${65535} width="short" />`} />
            <${Field} id="ds-env" label=${tr('Jeton de passerelle','Gateway token')} environment=${{variable:'OC_GATEWAY_TOKEN',reason:tr('Géré par l’environnement du processus.','Managed by the process environment.')}} control=${props => html`<${TextInput} ...${props} value=${tr('Configuré à l’extérieur','Configured externally')} readOnly />`} />
          </div>
          <div class="ds-sample"><h3>${tr('Saisie · vide, renseignée, en attente','Input · empty, filled, busy')}</h3>
            <${Field} id="ds-empty" label=${tr('URL de l’espace','Workspace URL')} control=${props => html`<${TextInput} ...${props} value=${text} placeholder="https://example.invalid" onValueChange=${setText} type="url" width="medium" />`} />
            <${Field} id="ds-area" label=${tr('Notes','Notes')} control=${props => html`<${TextArea} ...${props} rows=${3} value=${area} onValueChange=${setArea} maxLength=${180} />`} />
            <${Select} id="ds-select" label=${tr('Densité','Density')} value=${selectValue} onValueChange=${setSelectValue} options=${[
              {value:'compact',label:tr('Compacte','Compact')}, {value:'medium',label:tr('Confortable','Comfortable')}, {value:'roomy',label:tr('Aérée','Spacious')},
            ]} />
          </div>
          <div class="ds-sample"><h3>${tr('Case à cocher · sélection à valider','Checkbox · staged selection')}</h3>
            <${Checkbox} checked=${checked} label=${tr('Conserver comme brouillon','Keep this as a draft')} onCheckedChange=${setChecked} />
            <${Checkbox} checked=${true} label=${tr('Option sélectionnée','Selected option')} disabled />
            <${Radio} name="ds-choice" value="one" checked=${radio === 'one'} label=${tr('Première option','First option')} onCheckedChange=${v => v && setRadio('one')} />
            <${Radio} name="ds-choice" value="two" checked=${radio === 'two'} label=${tr('Deuxième option','Second option')} onCheckedChange=${v => v && setRadio('two')} />
          </div>
          <div class="ds-sample"><h3>${tr('Interrupteur · préférence immédiate','Switch · immediate preference')}</h3>
            <${Switch} checked=${checked} label=${tr('Activer cette préférence','Enable this preference')} onCheckedChange=${setChecked} />
            <${Switch} checked=${false} label=${tr('Préférence indisponible','Unavailable preference')} disabled />
            <${Switch} checked=${true} label=${tr('Demande en cours','Request pending')} busy />
            <${Switch} checked=${false} label=${tr('Échec de la demande','Request failed')} error=${tr('Impossible d’appliquer la préférence. Réessayez.','Could not apply the preference. Try again.')} />
          </div>
          <div class="ds-sample"><h3>${tr('Bouton · hiérarchie et états','Button · hierarchy and status')}</h3>
            <div class="ds-actions"><${Button} label=${tr('Enregistrer','Save changes')} variant="primary" /><${Button} label=${tr('Secondaire','Secondary')} /><${Button} label=${tr('Danger','Danger')} variant="danger" /><${Button} label=${tr('Enregistrement','Saving')} busy variant="primary" /><${Button} label=${tr('Indisponible','Unavailable')} disabled /></div>
          </div>
          <div class="ds-sample"><h3>${tr('SecretField · valeur non relue','SecretField · write-only')}</h3>
            <${SecretField} id="ds-secret" label=${tr('Jeton API','API token')} tokenSet=${true} replacement=${secret} onReplacementChange=${setSecret} />
          </div>
        </div>
      </${SettingsSection}>
    </section>` : null}

    ${tab === 'rows' ? html`<section id="ds-panel-rows" role="tabpanel" aria-labelledby="ds-tab-rows" class="ds-panel">
      <${SettingsSection} title=${tr('Lignes et informations','Rows and evidence')} description=${tr('Les valeurs en lecture seule restent lisibles et les états sont explicites.','Read-only values stay readable; status stays explicit.')} testId="rows-section">
        <div class="ds-grid ds-grid--two">
          <div class="ds-sample"><h3>${tr('SettingRow · aligné sur ordinateur, empilé sur mobile','SettingRow · desktop inline, mobile stacked')}</h3>
            <${SettingRow} label=${tr('Thème du bureau','Workspace theme')} description=${tr('Appliqué aux nouvelles vues de cette instance.','Applied to new views in this instance.')} status=${html`<${StatusChip} state="ok" />`} control=${html`<${Select} label=${tr('Thème du bureau','Workspace theme')} value="bureau" options=${[{value:'bureau',label:'Bureau'},{value:'observatoire',label:'Observatoire'}]} />`} />
            <${SettingRow} label=${tr('Vérifications avancées','Advanced checks')} description=${tr('À ouvrir uniquement pour le diagnostic.','Open only when troubleshooting.')} meta=${tr('Vérifié à l’instant','Last checked just now')} details=${html`<${KeyValue} label=${tr('Source de configuration','Configuration source')} value=${demo.source} />`} control=${html`<${Checkbox} checked=${checked} label=${tr('Activé','Enabled')} onCheckedChange=${setChecked} />`} />
          </div>
          <div class="ds-sample"><h3>${tr('ListRow · normal, atténuée, sélectionnée','ListRow · normal, muted, selected')}</h3>
            <ul class="ds-list">
              <${ListRow} avatar=${html`<span class="ds-avatar">A</span>`} title=${html`Atlas <${Badge} label=${tr('Principal','Primary')} kind="primary" />`} meta="ID · agent:sample:local:desk" actions=${html`<${Menu} label=${tr('Actions pour Atlas','Actions for Atlas')} items=${menuItems} onSelect=${setMenuSeen} />`} />
              <${ListRow} title=${tr('Agent discret','Quiet worker')} meta=${tr('Masqué du bureau','Hidden from the office')} muted />
              <${ListRow} title=${tr('Élément sélectionné','Selected item')} meta=${tr('Sélection actuelle','Current selection')} selected />
              <${ListRow} severity="warn" statusLabel=${tr('À vérifier','Needs review')} title=${tr('Connexion','Connection')} meta=${tr('En attente d’une réponse','Waiting for a response')} actions=${html`<${TextAction} label=${tr('Configurer','Configure')} targetName=${tr('la connexion','the connection')} onPress=${() => {}} />`} />
            </ul>
          </div>
          <div class="ds-sample"><h3>${tr('KeyValue · identifiant, chemin long, vide','KeyValue · ID, long path, empty')}</h3>
            <${KeyValue} label=${tr('Identifiant de l’agent','Agent ID')} value=${demo.id} />
            <${KeyValue} label=${tr('Source de configuration','Configuration source')} value=${demo.source} copyable />
            <${KeyValue} label=${tr('Valeur facultative','Optional value')} value=${null} emptyLabel=${tr('Non configuré','Not configured')} />
          </div>
          <div class="ds-sample"><h3>${tr('StatusChip · tous les états','StatusChip · every canonical state')}</h3>
            <div class="ds-actions">${['ok','warn','error','info','unknown','checking','disabled','unsupported'].map(state => html`<${StatusChip} key=${state} state=${state} />`)}</div>
            <div class="ds-actions"><${Badge} label="Primary" kind="primary" /><${Badge} label="Source: runtime" /></div>
          </div>
          <div class="ds-sample"><h3>${tr('InlineEditableText · affichage et édition','InlineEditableText · display and edit')}</h3>
            <${InlineEditableText} label=${tr('Espace de travail','Workspace')} value=${name} onCommit=${setName} emptyLabel=${tr('Espace sans nom','Unnamed workspace')} testId="inline-edit" />
          </div>
        </div>
      </${SettingsSection}>
    </section>` : null}

    ${tab === 'actions' ? html`<section id="ds-panel-actions" role="tabpanel" aria-labelledby="ds-tab-actions" class="ds-panel">
      <${SettingsSection} title=${tr('Actions et détails','Actions and disclosure')} description=${tr('Les actions secondaires restent compactes et explicites.','Secondary actions stay compact and named.')} testId="actions-section">
        <div class="ds-grid ds-grid--two">
          <div class="ds-sample"><h3>${tr('Menu · fermé, ouvert, inactif, destructif','Menu · closed, open, disabled, destructive')}</h3>
            <${Menu} label=${tr('Autres actions','More actions')} items=${menuItems} onSelect=${setMenuSeen} />
            <${TextAction} label=${tr('Configurer','Configure')} targetName="runtime" onPress=${() => {}} />
            <${TextAction} label=${tr('Ouvrir les détails','Open details')} targetName="runtime" href="#details" />
            <${TextAction} label=${tr('Réessayer','Retry')} busy error=${tr('Échec de la dernière tentative. Vous pouvez réessayer.','Last attempt failed. Retry when ready.')} onPress=${() => {}} />
          </div>
          <div class="ds-sample"><h3>CollapsedGroup · Disclosure</h3>
            <${CollapsedGroup} label=${tr('3 vérifications en ordre','3 checks in order')} defaultOpen=${false}><p>${tr('Vérifications réussies lors du dernier contrôle.','Checks that passed their latest run.')}</p></${CollapsedGroup}>
            <${Disclosure} title=${tr('Détails · source vérifiée','Details · verified source')}><${KeyValue} label=${tr('Source de configuration','Configuration source')} value=${demo.source} /></${Disclosure}>
          </div>
          <div class="ds-sample"><h3>${tr('Bannière · information et récupération','Banner · information and recovery')}</h3>
            <${Banner} tone="info" text=${tr('Une modification peut être examinée.','A change is ready to review.')} action=${{label:tr('Examiner','Review'),onPress:() => {}}} />
            <${Banner} tone="warning" title=${tr('Vérification nécessaire','Check needed')} text=${tr('Le service n’a pas encore été vérifié.','The runtime has not been checked yet.')} />
            <${Banner} tone="danger" title=${tr('Enregistrement impossible','Could not save')} text=${tr('Le brouillon est conservé.','Your draft is still here.')} action=${{label:tr('Réessayer','Retry'),onPress:() => {}}} />
          </div>
          <div class="ds-sample"><h3>${tr('Confirmation · annulation accessible','Confirmation · safe cancel first')}</h3>
            <${Button} label=${tr('Ouvrir la confirmation','Open confirmation')} onPress=${() => setDialog(true)} />
          </div>
          <div class="ds-sample"><h3>${tr('Lien · vraie navigation','Link · genuine navigation')}</h3>
            <${Link} href="#forms" label=${tr('Revenir aux exemples de formulaires','Return to form examples')} icon=${html`<${Icon} name="arrow-left" />`} />
          </div>
          <div class="ds-sample"><h3>${tr('EmptyState · aucun résultat','EmptyState · no results')}</h3>
            <${EmptyState} compact icon="agent" title=${tr('Aucun agent configuré','No configured agents')} text=${tr('Ajoutez un agent pour commencer à utiliser cet espace.','Add an agent to start using this workspace.')} />
          </div>
        </div>
      </${SettingsSection}>
    </section>` : null}

    ${tab === 'states' ? html`<section id="ds-panel-states" role="tabpanel" aria-labelledby="ds-tab-states" class="ds-panel">
      <${SettingsSection} title=${tr('États des composants','Component states')} description=${tr('Détails, attente, erreurs et gestion du focus sont visibles ici.','Disclosure, busy, errors and focus behavior are observable here.')} testId="states-section">
        <${Banner} tone="success" title=${tr('Brouillon enregistré','Saved to draft')} text=${tr('La page parente décide quand le brouillon est envoyé au serveur.','The parent page decides when a draft reaches the server.')} />
        <${CollapsedGroup} label=${tr('3 éléments en ordre','3 items in order')} defaultOpen=${true}><ul class="ds-list"><${ListRow} severity="ok" title=${tr('Première vérification','First check')} meta=${tr('Dernier résultat : sain','Latest result: healthy')} /><${ListRow} severity="ok" title=${tr('Deuxième vérification','Second check')} meta=${tr('Dernier résultat : sain','Latest result: healthy')} /><${ListRow} severity="info" title=${tr('Troisième vérification','Third check')} meta=${tr('Information uniquement','Information only')} /></ul></${CollapsedGroup}>
      </${SettingsSection}>
    </section>` : null}
    <${ConfirmDialog} open=${dialog} title=${tr('Retirer cet espace ?','Remove this workspace?')} description=${tr('Cet exemple local ne modifie aucune donnée enregistrée.','This local example does not change saved data.')} confirmLabel=${tr('Retirer du brouillon','Remove from draft')} cancelLabel=${tr('Annuler','Cancel')} onConfirm=${() => setDialog(false)} onCancel=${() => setDialog(false)} />
  </main>`;
}
