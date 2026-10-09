// Compétence (S11; frontend-22: the original Bureau page, as in 75895f4): SkillDetailVM from
// GET /api/v2/views/skills/:name, kept fresh by `skill:<name>`. Toggle: PUT /api/v2/skills/:name/enabled, an OpenClaw
// write (403 « Instance de test : actions désactivées. » on staging); a toggle waits for a gateway restart (needsRestart).
// The switch needs `skills.toggle`, the restart action `restart` (api-v3 D1); without them the reason is said (.ao-ro).
import { html, useState } from '../lib.js';
import { useTopic, runtimeCan } from '../hooks.js';
import { services } from '../services.js';
import { t, msg, agentName } from '../i18n.js';
import { put } from '../api.js';
import { toast } from '../toast.js';
import { Icon, EmptyState, ErrorState, Skeleton } from '../components/ui.js';
import { Markdown } from '../components/markdown.js';
import { RestartGatewayModal } from '../components/restart.js';
import { useOpenclawWrites } from './flows.js';
import { skillTopic, StatusChip, visibilityText } from './skills.js';
import * as rules from './skills-rules.js';
import { safeExternalUrl } from '../url-policy.js';

const enc = encodeURIComponent;
const yesNo = (v) => msg(v ? 'common.yes' : 'common.no');

export function SkillPage({ match }) {
  const { router } = services;
  const name = match.params.skillName;
  const vm = useTopic(skillTopic(name), '/api/v2/views/skills/' + enc(name));
  const writes = useOpenclawWrites();
  const [busy, setBusy] = useState(false);
  const [restart, setRestart] = useState(false);
  const back = router.href('competences');
  const Back = () => html`<a class="bu-backlink" href=${back}><${Icon} name="arrow-left" />${msg('skill.back')}</a>`;

  if (vm.data === undefined && vm.error) {
    return html`<div class="bu-page ao-frame ao-frame--detail"><${Back} />
      ${vm.error.code === 'not_found' ? html`<${EmptyState} icon="competences" title=${msg('skill.notFound.head')} text=${msg('skill.notFound.text')}><a class="bu-btn" href=${back}>${msg('skill.back')}</a></${EmptyState}>`
        : html`<${ErrorState} error=${vm.error} onRetry=${vm.retry} />`}</div>`;
  }
  if (vm.data === undefined) return html`<div class="bu-page ao-frame ao-frame--detail ao-skill" aria-busy="true"><${Back} /><${Skeleton} kind="title" /><${Skeleton} w="60" /><${Skeleton} kind="block" /><${Skeleton} kind="block" /></div>`;
  const { skill: s, detail: d, markdown, flow, needsRestart } = vm.data;
  const homepage = safeExternalUrl(s.homepage);
  const enabled = s.status !== 'disabled';
  const canToggle = runtimeCan('skills.toggle');
  const canRestart = runtimeCan('restart');
  const blocked = rules.blockers(d);
  const reqs = d ? rules.requirementRows(d) : [];

  async function toggle() {
    setBusy(true);
    try {
      await put(`/api/v2/skills/${enc(s.id)}/enabled`, { enabled: !enabled }, { quiet: true });
      toast({ level: 'success', message: msg(enabled ? 'skill.toast.disabled' : 'skill.toast.enabled') });
    } catch (err) {
      // readonly (403) on staging: the server's message « Instance de test : actions désactivées. »
      toast({ level: err.code === 'readonly' ? 'warning' : 'danger', message: err.message, code: err.code ? err.code.toUpperCase() : null, requestId: err.requestId });
    } finally { setBusy(false); }
  }

  return html`<div class="bu-page ao-frame ao-frame--detail ao-skill" aria-busy=${vm.resyncing ? 'true' : undefined}>
    <${Back} />
    ${vm.error ? html`<div class="bu-banner bu-banner--warning" role="status"><${Icon} name="warning" /><span class="bu-banner__text">${msg('common.updateFailed', { error: vm.error.message })}</span><button class="bu-btn bu-btn--sm" onClick=${vm.retry}>${msg('common.retry')}</button></div>` : null}
    <header class="bu-detail-header">
      <span class="bu-icon-tile bu-icon-tile--lg ao-emoji" aria-hidden="true">${s.emoji || html`<${Icon} name="competences" size="md" />`}</span>
      <div class="ao-skill__headtext">
        <h2 class="bu-detail-header__title">${s.id}<${StatusChip} status=${s.status} /></h2>
        ${s.description ? html`<p class="bu-detail-header__desc">${s.description}</p>` : null}
        <p class="bu-detail-header__meta">${t('skillSource.' + s.source)} · ${msg('skill.meta.agent', { agent: agentName() })} · ${visibilityText(s.visibility)}</p>
      </div>
    </header>

    <div class="ao-skill__actions">
      <span class="ao-skill__write" data-write-actions>
        ${canToggle ? html`<label class="bu-switch"><input type="checkbox" role="switch" checked=${enabled} disabled=${busy} aria-busy=${busy ? 'true' : undefined}
          aria-describedby=${writes ? undefined : 'skill-ro'} onChange=${(e) => { e.currentTarget.checked = enabled; toggle(); }} />${msg(enabled ? 'skill.switch' : 'skill.switch.off')}</label>` : null}
      </span>
      ${homepage ? html`<a class="bu-btn bu-btn--ghost bu-btn--sm" href=${homepage} target="_blank" rel="noopener noreferrer"><${Icon} name="external" />${msg('skill.action.homepage')}</a>` : null}
      ${!canToggle ? html`<p class="bu-caption bu-text-tertiary ao-ro" id="skill-ro"><${Icon} name="info" />${msg('skill.capability.toggle')}</p>`
        : writes ? null : html`<p class="bu-caption bu-text-tertiary ao-ro ao-skill__ro" id="skill-ro"><${Icon} name="info" />${msg('skill.readonly')}</p>`}
    </div>
    ${needsRestart ? html`<div class="bu-banner bu-banner--warning" role="status"><${Icon} name="refresh" />
      <span class="bu-banner__text">${msg('skill.stand.restartPending')}${canRestart ? '' : ' ' + msg('skill.capability.restart')}</span>
      ${canRestart ? html`<span data-write-actions><button type="button" class="bu-btn bu-btn--sm" onClick=${() => setRestart(true)}>${msg('skill.action.restart')}</button></span>` : null}</div>` : null}
    ${s.status === 'unavailable' ? html`<div class="bu-banner"><${Icon} name="info" /><span class="bu-banner__text">${msg('skill.unavailable')}</span></div>` : null}

    <section class="bu-card ao-section" aria-labelledby="sk-flow">
      <h3 class="bu-card__title" id="sk-flow">${msg('skill.flow.title')}</h3>
      <ol class="bu-flow">
        <li class="bu-flow__node bu-flow__node--trigger"><span class="bu-flow__kind"><${Icon} name="state-calling" />${msg('skill.flow.trigger')}</span><span class="bu-flow__label">${msg('skill.flow.request', { agent: agentName() })}</span></li>
        ${flow.steps.map((step, i) => html`<li key=${'a' + i} class="bu-flow__arrow" aria-hidden="true"><${Icon} name="arrow-right" /></li>
          <li key=${'s' + i} class="bu-flow__node bu-flow__node--step"><span class="bu-flow__kind">${msg('skill.flow.step')}</span><span class="bu-flow__label">${step}</span></li>`)}
        ${flow.outputs.length ? html`<li class="bu-flow__arrow" aria-hidden="true"><${Icon} name="arrow-right" /></li>
          <li class="bu-flow__node bu-flow__node--output"><span class="bu-flow__kind"><${Icon} name="check" />${msg('skill.flow.output')}</span><span class="bu-flow__label">${flow.outputs.map((o) => t('skillOutput.' + o)).join(' · ')}</span></li>` : null}
      </ol>
      <p class="bu-caption bu-text-tertiary">${msg('skill.plan.note')}</p>
    </section>

    ${d ? html`<div class="bu-grid--2 ao-skill__pair">
      <section class="bu-card ao-section" aria-labelledby="sk-config">
        <h3 class="bu-card__title" id="sk-config">${msg('skill.config.title')}</h3>
        <dl class="bu-kv">
          <div class="bu-kv__row"><dt>${msg('skill.config.source')}</dt><dd>${t('skillSource.' + s.source)}</dd></div>
          <div class="bu-kv__row"><dt>${msg('skill.config.always')}</dt><dd>${yesNo(d.always)}</dd></div>
          ${rules.SCOPES.map((k) => html`<div key=${k} class="bu-kv__row"><dt>${t('skillVisibility.' + k)}</dt><dd>${yesNo(s.visibility && s.visibility[k])}</dd></div>`)}
          <div class="bu-kv__row"><dt>${msg('skill.config.blocked')}</dt><dd class=${blocked.length ? 'is-warning' : ''}>${blocked.map((b) => msg('skill.blocker.' + b)).join(', ') || msg('skill.config.nothing')}</dd></div>
        </dl>
      </section>
      <section class="bu-card ao-section" aria-labelledby="sk-deps">
        <h3 class="bu-card__title" id="sk-deps">${msg('skill.deps.title')}</h3>
        ${reqs.length ? html`<dl class="bu-kv">${reqs.map((r) => html`<div key=${r.kind} class="bu-kv__row"><dt>${msg('skill.req.kind.' + r.kind)}</dt><dd class="ao-deps">
            ${r.values.map((v) => html`<span key=${v.value} class=${v.missing ? 'bu-chip bu-chip--sm bu-chip--warning' : 'bu-tag'}>${v.missing ? html`<${Icon} name="warning" />` : null}${v.value}<span class="bu-sr-only"> (${msg(v.missing ? 'skill.req.isMissing' : 'skill.req.isPresent')})</span></span>`)}
          </dd></div>`)}</dl>` : html`<p class="bu-text-secondary">${msg('skill.deps.none')}</p>`}
        ${d.install.length ? html`<div class="ao-install"><h4 class="bu-eyebrow">${msg('skill.req.install')}</h4><ul class="ao-sources__list">${d.install.map((i) => html`<li key=${i.id} class="bu-source"><${Icon} name="tool-exec" />${i.label}${i.bins.length ? html` <span class="bu-mono-sm bu-text-tertiary">${i.bins.join(', ')}</span>` : null}</li>`)}</ul></div>` : null}
      </section>
    </div>` : html`<div class="bu-banner bu-banner--warning" role="status"><${Icon} name="warning" /><span class="bu-banner__text">${msg('skill.noDetails')}</span></div>`}

    <section class="bu-card ao-section" aria-labelledby="sk-runs">
      <h3 class="bu-card__title" id="sk-runs">${msg('skill.runs.title')}</h3>
      <p class="bu-text-secondary">${msg('skill.runs.text')}</p>
      <p class="ao-skill__links"><a class="bu-btn bu-btn--sm" href=${router.href('journaux')}><${Icon} name="journaux" />${msg('skill.runs.logs')}</a>
        <a class="bu-btn bu-btn--sm" href=${router.href('flux')}><${Icon} name="flux" />${msg('skill.runs.flows')}</a></p>
    </section>

    <section class="bu-card ao-section" aria-labelledby="sk-md">
      <h3 class="bu-card__title" id="sk-md">${msg('skill.doc.title')}</h3>
      ${markdown ? html`<div class="bu-prose ao-skill__md"><${Markdown} source=${markdown} headingOffset=${3} /></div>` : html`<p class="bu-text-tertiary">${msg('skill.doc.none')}</p>`}
    </section>
    ${restart ? html`<${RestartGatewayModal} onClose=${() => setRestart(false)} readonly=${!writes} />` : null}
  </div>`;
}
