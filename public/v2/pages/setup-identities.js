// First-run setup, step « Les identités » (F8): the primary agent, then one look per agent.
// The looks are office-dev's component (office-dev-11 §1: SetupCharacters): character, colour and accessories,
// normalized and reported once at mount, then on every change. A look changes appearance, never permissions.
//   IdentitiesStep({ agents: [{ id, name, isPrimary }], value: { primary, looks }, onChange({ primary, looks }) })
import { html } from '../lib.js';
import { msg } from '../i18n.js';
import { SetupCharacters } from '../office/setup-characters.js';

export function IdentitiesStep({ agents, value, onChange }) {
  return html`<div class="ao-setup__identities">
    <fieldset class="ao-setup__primary">
      <legend class="bu-card__title">${msg('setup.ids.primary')}</legend>
      ${agents.map((a) => html`<label key=${a.id} class="ao-setup__radio">
        <input type="radio" name="setup-primary" checked=${value.primary === a.id} onChange=${() => onChange({ ...value, primary: a.id })} />
        <span class="ao-setup__name">${a.name}</span><span class="ao-setup__id">${a.id}</span></label>`)}
    </fieldset>
    <section class="ao-setup__looks" aria-labelledby="setup-looks">
      <h3 class="bu-card__title" id="setup-looks">${msg('setup.ids.looks')}</h3>
      <${SetupCharacters} embedded=${true} agents=${agents.map((a) => ({ id: a.id, name: a.name, primary: a.id === value.primary }))} value=${value.looks}
        onChange=${(looks) => onChange({ ...value, looks })} />
    </section>
  </div>`;
}
