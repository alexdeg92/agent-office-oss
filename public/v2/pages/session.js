// Session transcript (S10): SessionVM from GET /api/v2/views/sessions/:key, kept fresh by `session:<encodedKey>`.
// Two views (Trace README), in the URL as ?vue=arbre|chronologie: the tree (turns + tool calls) and the waterfall.
import { SenderAvatar } from '../components/sender.js';
import { SessionParticipants } from '../components/session-participants.js';
import { senderName } from '../sender.js';
import { html } from '../lib.js';
import { useTopic } from '../hooks.js';
import { services } from '../services.js';
import { t, msg, label, agentName, agentAvatar } from '../i18n.js';
import * as fmt from '../fmt.js';
import { Icon, EmptyState, ErrorState, Ago, Skeleton } from '../components/ui.js';
import { Avatar } from '../components/project.js';
import { buildTree, waterfall } from '../trace.js';
import { Markdown } from '../components/markdown.js';
import { sessionTopic, modelText } from './journaux.js';
import { ConversationSummary } from '../components/conversation.js';
import { ordered, useOrder, OrderToggle } from '../components/order.js';

const enc = encodeURIComponent;
const runCopy = { fr: { observed: 'Activité observée', unknown: 'Inconnu', verified: 'Exécution confirmée', notVerified: 'Non confirmé', noEvidence: 'Aucune preuve récente' },
  en: { observed: 'Activity observed', unknown: 'Unknown', verified: 'Execution confirmed', notVerified: 'Not confirmed', noEvidence: 'No recent evidence' } };
const runText = (key) => { const c = runCopy[String(fmt.LOCALE).toLowerCase().startsWith('en') ? 'en' : 'fr']; return c[key] || t('runStatus.' + key); };
const RUN_TONE = { idle: null, running: 'success', succeeded: 'info', failed: 'danger' };
const RUN_ICON = { idle: 'state-idle', running: 'state-working', succeeded: 'success', failed: 'alert' };
const agentChip = () => ({ id: 'agent', kind: 'agent', name: agentName(), avatarUrl: agentAvatar(), state: null });
const VIEWS = [['arbre', 'session.view.tree'], ['chronologie', 'session.view.timeline']];

export function SessionPage({ match }) {
  const [order, setOrder] = useOrder('trace');
  const { router } = services;
  const key = match.params.sessionKey;
  const vm = useTopic(sessionTopic(key), '/api/v2/views/sessions/' + enc(key));
  const view = match.query.vue === 'chronologie' ? 'chronologie' : 'arbre';
  const back = services.lastLogsUrl || router.href('journaux');
  const Back = () => html`<a class="bu-backlink" href=${back}><${Icon} name="arrow-left" />${msg('session.back')}</a>`;

  if (vm.data === undefined && vm.error) {
    return html`<div class="bu-page ao-page ao-page--detail"><${Back} />
      ${vm.error.code === 'not_found' ? html`<${EmptyState} icon="journaux" title=${msg('session.notFound')} text=${msg('session.notFound.text')}><a class="bu-btn" href=${back}>${msg('session.back')}</a></${EmptyState}>`
        : html`<${ErrorState} error=${vm.error} onRetry=${vm.retry} />`}</div>`;
  }
  if (vm.data === undefined) return html`<div class="bu-page ao-page ao-page--detail ao-session" aria-busy="true"><${Back} /><p class="bu-sr-only" role="status">${msg('editorial.loading')}</p><${Skeleton} kind="title" /><${Skeleton} kind="block" /></div>`;
  const s = vm.data;
  const shown = s.window.to - s.window.from;
  const windowed = s.window.from > 0;
  return html`<div class="bu-page ao-page ao-page--detail ao-session" aria-busy=${vm.resyncing ? 'true' : undefined}>
    <${Back} />
    ${vm.error ? html`<div class="bu-banner bu-banner--warning" role="status"><${Icon} name="warning" /><span class="bu-banner__text">${msg('common.updateFailed', { error: vm.error.message })}</span><button class="bu-btn bu-btn--sm" onClick=${vm.retry}>${msg('common.retry')}</button></div>` : null}
    <header class="ao-session__head">
      <div class="ao-session__chips">
        <span class="bu-tag">${t('sessionKind.' + s.kind)}${s.runtimeKind ? ' · ' + t('runtimeKind.' + s.runtimeKind) : ''}</span>
        <span class=${'bu-chip bu-chip--sm' + (RUN_TONE[s.run.status] ? ' bu-chip--' + RUN_TONE[s.run.status] : '')}>
          ${s.run.status === 'running' && s.run.evidence.level === 'verified' ? html`<span class="bu-dot bu-dot--success bu-dot--live" aria-hidden="true"></span>` : html`<${Icon} name=${RUN_ICON[s.run.status] || 'info'} />`}${s.run.evidence.level === 'observed' ? runText('observed') : s.run.status === 'unknown' ? runText('unknown') : t('runStatus.' + s.run.status)}</span>
        <span class="bu-caption bu-text-tertiary" data-execution-evidence=${s.run.evidence.level}>${runText(s.run.evidence.level === 'verified' ? 'verified' : s.run.evidence.level === 'observed' ? 'notVerified' : 'noEvidence')}</span>
        ${s.run.endReason ? html`<span class="bu-caption bu-text-tertiary">${t('runEnd.' + s.run.endReason)}</span>` : null}
      </div>
      <h2 class="bu-detail-header__title ao-session__title" id="session-titre">${s.title ? label(s.title) : s.label}</h2>
      <${SessionParticipants} participants=${s.participants} subagents=${s.subagents} />
      <p class="bu-mono-sm bu-text-tertiary ao-session__key">${s.key}</p>
      <dl class="ao-session__facts">
        <div><dt>${msg('session.model')}</dt><dd class="bu-mono-sm">${modelText(s) || '—'}</dd></div>
        <div><dt>${msg('logs.col.tokens')}</dt><dd class="bu-num">${fmt.number(s.tokens)}</dd></div>
        <div><dt>${msg('session.f.messages')}</dt><dd class="bu-num">${s.messageCount == null ? '—' : fmt.number(s.messageCount)}</dd></div>
        <div><dt>${msg('session.f.tools')}</dt><dd class="bu-num">${fmt.number(s.toolCount)}</dd></div>
        <div><dt>${msg('logs.col.updated')}</dt><dd>${s.updatedAt ? html`<${Ago} at=${s.updatedAt} />` : '—'}</dd></div>
        ${s.cwd ? html`<div><dt>${msg('session.cwd')}</dt><dd class="bu-mono-sm">${s.cwd}</dd></div>` : null}
      </dl>
    </header>
    ${s.events.length ? html`<section class="bu-card ao-section" aria-labelledby="session-resume"><h3 class="bu-card__title" id="session-resume">${msg('session.summary')}</h3><${ConversationSummary} events=${s.events} /></section>` : null}
    <div class="bu-toolbar ao-session__bar">
      <h2 class="bu-eyebrow">${msg('session.trace')}${windowed ? html` · <span class="ao-session__window">${msg('session.window', { shown, total: s.messageCount })}</span>` : null}</h2>
      <span class="bu-spacer"></span>
      <${OrderToggle} view="trace" order=${order} onChange=${setOrder} />
      <div class="bu-segmented" role="radiogroup" aria-label=${msg('session.views')}>
        ${VIEWS.map(([v, l]) => html`<button key=${v} type="button" role="radio" class="bu-segmented__opt" aria-checked=${view === v ? 'true' : 'false'}
          onClick=${() => router.setQuery({ vue: v === 'arbre' ? null : v })}><${Icon} name=${v === 'arbre' ? 'list' : 'clock'} />${msg(l)}</button>`)}
      </div>
    </div>
    ${s.traceState === 'stale' ? html`<div class="bu-banner bu-banner--warning ao-session__tracestate" role="status"><${Icon} name="warning" /><span class="bu-banner__text">${msg('session.trace.stale')}</span></div>` : null}
    ${s.traceState === 'unavailable' ? html`<div class="bu-banner ao-session__tracestate" role="status"><${Icon} name="info" /><span class="bu-banner__text">${msg('session.trace.unavailable')}</span></div>` : null}
    ${!s.events.length ? (s.traceState === 'unavailable' ? null : html`<div class="bu-card bu-card--sunken"><${EmptyState} compact icon="journaux" title=${msg(s.traceState === 'stale' ? 'session.trace.staleEmpty' : 'session.noEvents')} /></div>`)
      : view === 'arbre' ? html`<${Tree} events=${s.events} order=${order} live=${s.run.status === 'running'} />` : html`<${Waterfall} events=${s.events} order=${order} />`}
  </div>`;
}

/** Prose from the transcript as safe Markdown (Q03-F08): readable emphasis and lists, code kept as code. */
function Prose({ e }) {
  return html`<div class="bu-trace__body ao-trace__md"><${Markdown} source=${e.text} headingOffset=${3} />${e.truncated ? html`<p class="ao-trunc">${msg('session.truncated')}</p>` : null}</div>`;
}

function Text({ e }) {
  return html`${e.text}${e.truncated ? html`<span class="ao-trunc"> ${msg('session.truncated')}</span>` : null}`;
}


function Tree({ events, live, order }) {
  const nodes = ordered(buildTree(events), order);
  return html`<ol class="bu-trace ao-trace" aria-live=${live ? 'polite' : undefined}>
    ${nodes.map((n, i) => {
      const nodeKey = n.event?.id || n.tools[0]?.id || n.thinking[0]?.id || i;
      if (n.type === 'human') {
        const who = senderName(n.event, msg('session.user'));
        return html`<li key=${nodeKey} class="bu-trace__node bu-trace__node--human">
          <${SenderAvatar} event=${n.event} />
          <div class="bu-trace__head"><span class="bu-trace__who">${who}</span><${When} at=${n.event.at} /></div>
          ${(n.events || [n.event]).map((e) => html`<${Prose} key=${e.id} e=${e} />`)}
        </li>`;
      }
      if (n.type === 'system') {
        return html`<li key=${nodeKey} class="bu-trace__node ao-trace__system">
          <span class="bu-avatar" aria-hidden="true"><${Icon} name="system" /></span>
          <div class="bu-trace__head"><span class="bu-trace__who">${msg('session.system')}</span><${When} at=${n.event.at} /></div>
          <div class="bu-trace__body"><${Text} e=${n.event} /></div>
        </li>`;
      }
      const e = n.event;
      const meta = e ? [e.model, e.outputTokens != null ? fmt.tokens(e.outputTokens) : null].filter(Boolean).join(' · ') : '';
      return html`<li key=${nodeKey} class="bu-trace__node">
        <${Avatar} person=${agentChip()} />
        <div class="bu-trace__head"><span class="bu-trace__who">${senderName(e, agentName())}</span>${e ? html`<${When} at=${e.at} />` : null}${meta ? html`<span class="bu-trace__meta">${meta}</span>` : null}</div>
        ${n.thinking.map((th, k) => html`<details key=${'th' + k} class="ao-thinking"><summary><${Icon} name="state-thinking" />${msg('session.thinking')}</summary><p><${Text} e=${th} /></p></details>`)}
        ${e && e.text ? html`<${Prose} e=${e} />` : null}
        ${e && e.stopReason === 'error' ? html`<div class="bu-banner bu-banner--danger"><${Icon} name="alert" /><span class="bu-banner__text">${msg('session.stoppedOnError')}${e.error ? html` <code>${e.error}</code>` : null}</span></div>` : null}
        ${n.tools.length ? html`<ul class="bu-trace__tools">${n.tools.map((tool) => html`<li key=${tool.callId}><${Tool} tool=${tool} /></li>`)}</ul>` : null}
        ${n.notes.map((o, k) => html`<p key=${'ob' + k} class="ao-observation"><${Icon} name="eye" /><span><${Text} e=${o} /></span></p>`)}
      </li>`;
    })}
  </ol>`;
}

function When({ at }) {
  return html`<time class="bu-trace__time" datetime=${new Date(at).toISOString()} title=${fmt.dateTime(at)}>${fmt.time(at, { seconds: true })}</time>`;
}

function Tool({ tool }) {
  return html`<details class=${'bu-tool' + (tool.isError ? ' bu-tool--error' : '')}>
    <summary>
      <${Icon} name=${'tool-' + (tool.toolKind || 'other')} label=${t('toolKind.' + (tool.toolKind || 'other'))} />
      <span class="bu-tool__name">${tool.name}</span>
      <span class=${'bu-chip bu-chip--sm ' + (tool.isError ? 'bu-chip--danger' : 'bu-chip--success')}><${Icon} name=${tool.isError ? 'error' : 'check'} />${msg(tool.isError ? 'session.tool.failed' : 'session.tool.ok')}</span>
      <span class="bu-tool__dur">${tool.durationMs != null ? fmt.duration(tool.durationMs) : '—'}</span>
    </summary>
    <div class="bu-tool__body">
      <div class="bu-code"><div class="bu-code__header">${msg('session.tool.input')}</div><pre><code>${tool.input}</code></pre></div>
      <div class="bu-code"><div class="bu-code__header">${msg('session.tool.output')}${tool.truncated ? ' ' + msg('session.truncated') : ''}</div><pre><code>${tool.output}</code></pre></div>
    </div>
  </details>`;
}

function Waterfall({ events, order }) {
  const w = waterfall(events);
  if (!w.rows.length) return null;
  return html`<div class="bu-card ao-waterfall-card"><div class="bu-waterfall" role="table" aria-label=${msg('session.timelineLabel')}>
    <div class="bu-waterfall__axis" role="row"><span role="columnheader">${msg('session.wf.step')}</span><span role="columnheader">${fmt.time(w.t0, { seconds: true })} → ${fmt.time(w.t1, { seconds: true })} · ${fmt.duration(w.totalMs)}</span><span role="columnheader">${msg('session.wf.duration')}</span></div>
    ${ordered(w.rows, order).map((r) => html`<div key=${r.key} role="row" class="ao-contents">
      <span class="bu-waterfall__label" role="cell">${r.toolKind ? html`<${Icon} name=${'tool-' + r.toolKind} />` : null}${r.event?.kind === 'user' ? html`<${SenderAvatar} event=${r.event} />${senderName(r.event, msg('session.user'))}` : r.label}</span>
      <span class="bu-waterfall__track" role="cell" aria-label=${msg('session.wf.start', { pct: Math.round(r.start) })}><span class=${'bu-waterfall__bar' + (r.kind === 'tool' ? '' : ' bu-waterfall__bar--' + r.kind)} ref=${(el) => { if (el) { el.style.setProperty('--start', r.start.toFixed(2) + '%'); el.style.setProperty('--len', r.len.toFixed(2) + '%'); } }}></span></span>
      <span class="bu-waterfall__dur" role="cell">${r.durMs != null ? fmt.duration(r.durMs) : '—'}</span>
    </div>`)}
  </div></div>`;
}
