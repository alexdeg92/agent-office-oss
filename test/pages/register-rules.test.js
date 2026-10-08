'use strict';
// Flux de travail and Compétences (office-dev, F6): the sentence rules are pure (VM → descriptors) and every
// descriptor resolves to a full sentence in both languages. Evidence rules from editorial-guide.md §2 are pinned.
const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');

let F, S, i18n, mockFlows, mockSkills;
before(async () => {
  F = await import('../../public/v2/pages/flows-rules.js');
  S = await import('../../public/v2/pages/skills-rules.js');
  i18n = await import('../../public/v2/i18n.js');
  mockFlows = (await import('../../public/v2/mock/flows.js')).createFlows(Date.parse('2026-10-06T12:00:00Z'));
  mockSkills = (await import('../../public/v2/mock/skills.js')).createSkills();
  const { META } = await import('../../public/v2/mock/meta.js');
  i18n.setMeta(META);
});

/** Every descriptor must name a known message and render without a leftover placeholder or « Autre (…) ». */
function render(d, lang) {
  i18n.setLang(lang);
  const out = i18n.msg(d.key, S.localize(d, i18n.msg).params).replace(/[\u00a0\u202f]/g, ' ');
  assert.ok(out && out !== d.key, `${lang}: unknown message ${d.key}`);
  assert.doesNotMatch(out, /\{\w+\}|Autre \(|Other \(/, `${lang} ${d.key}: ${out}`);
  return out;
}
const all = (lead) => [...lead.head, ...lead.stand];
const flow = (o) => ({ id: 'f', name: 'Tâche', description: '', enabled: true, health: 'ok', nextRunAt: null, lastRunAt: null,
  schedule: { kind: 'cron', expr: '0 9 * * 1', tz: 'UTC', sentence: { key: 'schedule.weekly', params: { day: '1', time: '09:00' } } }, ...o });

describe('Flux de travail rules', () => {
  it('lead order: failing enabled first; a disabled failure is separate; never-run is its own fact', () => {
    const vm = { flows: [flow({ id: 'a', name: 'A', health: 'failing' }), flow({ id: 'b', enabled: false, health: 'failing' }), flow({ id: 'c', health: 'never-run', nextRunAt: 5 })], counts: { total: 3, enabled: 2 } };
    const l = F.listLead(vm);
    assert.deepEqual(l.head.map((x) => x.key), ['flows.head.failing']);
    assert.equal(l.readOn, 'a');
    assert.deepEqual(l.stand.map((x) => x.key), ['flows.stand.enabled', 'flows.stand.failingNames', 'flows.stand.disabledFailing', 'flows.stand.neverRun']);
    assert.equal(l.next.id, 'c');
    assert.equal(render(l.head[0], 'fr'), 'Une tâche active demande une vérification.');
    assert.equal(render(l.head[0], 'en'), 'One enabled task needs a review.');
    assert.equal(render(l.stand[1], 'en'), 'A failed result is reported for A.');
  });

  it('failing health is « a failed result is reported », never « the last run failed »; disabled + failing says both', () => {
    i18n.setLang('fr');
    assert.equal(render(F.stateSentence(flow({ health: 'failing' })), 'fr'), 'Un résultat en échec est signalé.');
    assert.equal(render(F.stateSentence(flow({ enabled: false, health: 'failing' })), 'fr'), 'Cette tâche est désactivée. Un résultat en échec est signalé.');
    assert.equal(render(F.stateSentence(flow({ enabled: false, health: 'failing' })), 'en'), 'This task is disabled. A failed result is reported.');
    assert.equal(render(F.stateSentence(flow({ health: 'never-run' })), 'en'), 'No run observed.');
  });

  it('empty, none enabled and cached snapshots get their own sentences (never zero counts as a claim)', () => {
    assert.equal(render(F.listLead({ flows: [], counts: { total: 0, enabled: 0 } }).head[0], 'fr'), 'Aucune tâche planifiée n’est enregistrée.');
    const off = F.listLead({ flows: [flow({ enabled: false })], counts: { total: 1, enabled: 0 } });
    assert.equal(render(off.head[0], 'en'), 'No task is enabled.');
    assert.equal(render(off.stand[0], 'fr'), 'Aucune tâche n’est active sur 1.');
    const c = F.listLead({ flows: [flow()], counts: { total: 1, enabled: 1 } }, { cached: true, cachedAt: Date.parse('2026-10-06T12:00:00Z') });
    assert.equal(c.head[0].key, 'editorial.cached');
  });

  it('detail: a running run leads with its duration; the newest run is told as a fact about that run', () => {
    const now = 1_000_000;
    const d = { job: flow({ health: 'failing', nextRunAt: now + 60_000 }), runs: [{ id: 'r', at: now - 90_000, status: 'running', durationMs: null, delivery: { status: null } }] };
    const l = F.detailLead(d, { now });
    assert.equal(l.head[0].key, 'flow.head.running');
    assert.match(render(l.head[0], 'fr'), /^Un passage est en cours depuis 1 min/);
    assert.equal(render(F.detailLead({ ...d, runs: [{ ...d.runs[0], at: now - 400 }] }, { now }).head[0], 'en'), 'A run has just started.');
    const failed = F.detailLead({ job: flow({ health: 'failing' }), runs: [{ id: 'r', at: now, status: 'failed', durationMs: 45_000, delivery: { status: 'not-delivered', channel: 'discord' } }] });
    assert.deepEqual(all(failed).map((x) => x.key), ['flows.state.failing', 'flow.stand.lastFailed', 'flow.stand.nextUnknown']);
    assert.equal(render(F.runSentence({ status: 'failed', durationMs: 45_000 }), 'en'), 'Failed after 45 s.');
    assert.equal(render(F.deliverySentence({ delivery: { status: 'not-delivered', channel: 'discord' } }), 'en'), 'Delivery: Not delivered, via Discord.');
    assert.equal(render(F.deliverySentence({ delivery: { status: 'queued-elsewhere', channel: null } }), 'fr'), 'Livraison : queued-elsewhere.');
    assert.equal(render(F.deliverySentence({ delivery: { status: null } }), 'fr'), 'Livraison : non renseignée.');
  });

  it('every sentence the mock data produces resolves in FR and EN', () => {
    const list = mockFlows.list();
    for (const lang of ['fr', 'en']) {
      for (const d of all(F.listLead(list))) render(d, lang);
      for (const f of list.flows) {
        render(F.stateSentence(f), lang);
        for (const m of F.rowMeta(f).slice(1)) render(m, lang);
        const det = mockFlows.detail(f.id);
        for (const d of all(F.detailLead(det))) render(d, lang);
        for (const r of det.runs) { render(F.runSentence(r), lang); render(F.deliverySentence(r), lang); }
      }
    }
  });

  it('instruction lines: numbered or bulleted steps become plain lines', () => {
    assert.deepEqual(F.instructionLines('1. Lire\n2) Calculer\n- Produire\n\n• Valider'), ['Lire', 'Calculer', 'Produire', 'Valider']);
  });
});

describe('Compétences rules', () => {
  const skill = (o) => ({ id: 'x', emoji: null, description: '', source: 'bundled', status: 'active', visibility: { model: true, command: false, user: true }, ...o });

  it('unavailable leads; the list never claims a missing requirement from the status alone', () => {
    const l = S.listLead({ skills: [skill({ id: 'a', status: 'unavailable' }), skill({ id: 'b', status: 'disabled' }), skill()], counts: { total: 3, active: 1 } });
    assert.deepEqual(l.head.map((x) => x.key), ['skills.head.unavailable']);
    assert.deepEqual(l.unavailable.map((s) => s.id), ['a']);
    for (const lang of ['fr', 'en']) for (const d of all(l)) assert.doesNotMatch(render(d, lang), /Prérequis manquant|requirements? (is|are) missing|Missing requirement|gcalcli/i);
    assert.equal(render(l.head[0], 'en'), 'One skill is unavailable.');
  });

  it('detail: missing requirements only from detail.missing; null details say so; a pending restart leads', () => {
    const base = { skill: skill({ status: 'unavailable' }), needsRestart: false, flow: { steps: [], outputs: [] }, markdown: '' };
    const missing = S.detailLead({ ...base, detail: { always: false, blockedBy: { allowlist: false, agentFilter: false, platform: false }, requirements: { bins: ['gcalcli'], anyBins: [], env: [], config: [], os: [] }, missing: { bins: ['gcalcli'], anyBins: [], env: [], config: [], os: [] }, install: [] } });
    assert.equal(render(missing.head[0], 'fr'), 'Prérequis manquant : gcalcli.');
    const none = S.detailLead({ ...base, detail: null });
    assert.deepEqual(all(none).map((x) => x.key), ['skill.head.unavailable', 'skill.stand.noDetails', 'skill.stand.enableDoesNotInstall']);
    const blocked = S.detailLead({ ...base, detail: { always: false, blockedBy: { allowlist: true, agentFilter: false, platform: true }, requirements: null, missing: null, install: [] } });
    assert.equal(render(blocked.stand[0], 'fr'), 'Elle est bloquée par la liste d’autorisation et la plateforme.');
    assert.equal(render(blocked.stand[0], 'en'), 'It is blocked by the allowlist and the platform.');
    const pending = S.detailLead({ ...base, skill: skill(), needsRestart: true, detail: null });
    assert.deepEqual(pending.head.map((x) => x.key), ['skill.head.restartPending', 'skill.head.active']);
    assert.equal(render(pending.head[0], 'en'), 'A change is awaiting a restart.');
  });

  it('visibility and outputs are this page’s own words (no « Autre (scope.model) »), in both languages', () => {
    assert.equal(render(S.visibilitySentence({ model: true, command: true, user: false }), 'fr'), 'Visible pour : le modèle et les commandes.');
    assert.equal(render(S.visibilitySentence({ model: true, command: true, user: true }), 'en'), 'Visible to: the model, commands and the user.');
    assert.equal(render(S.visibilitySentence({ model: false, command: false, user: false }), 'fr'), 'Usage interne uniquement.');
    i18n.setLang('en');
    assert.equal(i18n.msg('skill.plan.outputs', S.localize({ params: { outputs: S.outputsParam(['message', 'agent-reply']) } }, i18n.msg).params), 'Expected outputs: a message and an agent reply.');
  });

  it('requirement rows omit empty kinds and mark each value present or missing', () => {
    const rows = S.requirementRows({ requirements: { bins: ['curl', 'jq'], anyBins: [], env: ['TOKEN'], config: [], os: [] }, missing: { bins: ['jq'], anyBins: [], env: [], config: [], os: [] } });
    assert.deepEqual(rows, [{ kind: 'bins', values: [{ value: 'curl', missing: false }, { value: 'jq', missing: true }] }, { kind: 'env', values: [{ value: 'TOKEN', missing: false }] }]);
    assert.deepEqual(S.requirementRows(null), []);
  });

  it('every sentence the mock data produces resolves in FR and EN', () => {
    const list = mockSkills.list();
    for (const lang of ['fr', 'en']) {
      for (const d of all(S.listLead(list))) render(d, lang);
      for (const s of list.skills) {
        render(S.stateSentence(s), lang);
        render(S.visibilitySentence(s.visibility), lang);
        for (const d of all(S.detailLead(mockSkills.detail(s.id)))) render(d, lang);
      }
    }
    i18n.setLang('fr');
  });
});
