// Mock Flux de travail (api.md 2.1 §3.4, §5.1): FlowListVM, FlowDetailVM, CronRunVM and the flow commands, with the
// server's validation (5-field cron, IANA zone, lengths, not-editable, invalid-id). Invented French data only.
// « Exécuter maintenant » adds a `running` run that finishes a few seconds later (the page sees it live over SSE).
const MIN = 60_000, H = 60 * MIN, D = 24 * H;
const TZS = (() => { try { return new Set(Intl.supportedValuesOf('timeZone')); } catch { return new Set(['America/Toronto', 'UTC', 'Europe/Paris']); } })();
TZS.add('UTC');

const err = (status, code, message, details) => ({ error: [status, code, message, details] });
const invalid = (field, issue, message) => err(400, 'validation_failed', message, [{ field, issue }]);

/** Server-side checks of api.md §5.1, with French messages per field. */
function validateFields(b, { partial }) {
  if (b.name !== undefined && (typeof b.name !== 'string' || !b.name.trim() || b.name.trim().length > 80)) return invalid('name', 'length', 'Le nom doit compter entre 1 et 80 caractères.');
  if (b.cron !== undefined) {
    const parts = typeof b.cron === 'string' ? b.cron.trim().split(/\s+/) : [];
    if (parts.length !== 5 || !parts.every((p) => /^[\d*/,\-A-Za-z]+$/.test(p))) return invalid('cron', 'cron-format', 'La planification doit avoir 5 champs : minute heure jour mois jour-de-semaine (ex. « 0 9 * * 1 »).');
  }
  if (b.tz !== undefined && (typeof b.tz !== 'string' || !TZS.has(b.tz))) return invalid('tz', 'unknown-tz', 'Fuseau horaire inconnu. Utilisez un nom IANA, par exemple « America/Toronto ».');
  if (b.message !== undefined && (typeof b.message !== 'string' || !b.message.trim() || b.message.length > 4000)) return invalid('message', 'length', 'L’instruction doit compter entre 1 et 4 000 caractères.');
  if (!partial) for (const f of ['name', 'cron', 'tz', 'message']) if (b[f] === undefined) return invalid(f, 'required', 'Ce champ est obligatoire.');
  return null;
}

// A small, honest sentence builder for the mock (the real one is server-side): weekly / daily / generic.
function sentence(expr, tz) {
  const [m, h, dom, mon, dow] = expr.trim().split(/\s+/);
  const time = /^\d+$/.test(h) && /^\d+$/.test(m) ? `${h.padStart(2, '0')}:${m.padStart(2, '0')}` : null;
  if (time && dom === '*' && mon === '*' && /^[0-6]$/.test(dow)) return { key: 'schedule.weekly', params: { day: dow, time } };
  if (time && dom === '*' && mon === '*' && dow === '*') return { key: 'schedule.daily', params: { time } };
  if (time && dom === '*' && mon === '*' && dow === '1-5') return { key: 'schedule.weekdays', params: { time } };
  return { key: 'schedule.cron', params: { expr } };
}
function stepsOf(message) {
  const lines = message.split('\n').map((l) => l.replace(/^\s*(\d+[.)]|[-*])\s*/, '').trim()).filter(Boolean);
  return (lines.length > 1 ? lines : message.split(/(?<=\.)\s+/).filter(Boolean)).slice(0, 6).map((l) => (l.length > 48 ? l.slice(0, 47) + '…' : l));
}

export function createFlows(now = Date.now()) {
  let seq = 0;
  const flows = new Map();
  const add = (id, name, description, expr, tz, message, { enabled = true, kind = 'cron', payload = 'agent-turn', runs = [], created = 40 * D } = {}) => {
    flows.set(id, { id, name, description, enabled, expr, tz, message, scheduleKind: kind, payloadKind: payload, agentId: 'main', sessionTarget: 'isolated',
      wakeMode: 'now', model: null, timeoutSeconds: null, createdAt: now - created, updatedAt: now - created / 4, runs });
  };
  const run = (ago, status, durationMs, summary, extra = {}) => ({ id: 'run_' + (++seq).toString(36), at: now - ago, status, durationMs, nextRunAt: null,
    model: 'gpt-5.5', tokens: status === 'skipped' ? null : { total: 3800 + seq * 37, input: 3000, output: 800 + seq * 37 },
    delivery: status === 'succeeded' ? { status: 'delivered', delivered: true, channel: 'discord' } : { status: status === 'skipped' ? 'skipped' : 'not-delivered', delivered: false, channel: null },
    summary, error: null, ...extra });
  add('ffffffff-0c01-4000-8000-000000000001', 'Veille hebdomadaire', 'Résumé des nouveautés des concurrents suivis.', '0 9 * * 1', 'America/Toronto',
    '1. Parcourir les sites des cinq concurrents suivis\n2. Comparer avec la semaine passée\n3. Rédiger une synthèse de deux pages\n4. Publier la synthèse sur Discord',
    { runs: [run(D * 2, 'succeeded', 128_000, 'Synthèse publiée dans #veille : 3 nouveautés, dont une baisse de prix.'), run(D * 9, 'succeeded', 141_000, 'Synthèse publiée dans #veille.'), run(D * 16, 'failed', 45_000, '', { error: 'Délai dépassé en récupérant un des sites.' })] });
  add('ffffffff-0c01-4000-8000-000000000002', 'Résumé du matin', 'Les messages de la nuit et l’agenda du jour.', '30 7 * * *', 'America/Toronto',
    'Lire les messages reçus depuis 19:00, résumer l’essentiel et lister les rendez-vous du jour. Envoyer le résumé à Owner en message privé.',
    { runs: Array.from({ length: 6 }, (_, i) => run(D * (i + 0.2), 'succeeded', 52_000 + i * 3_000, `Résumé envoyé : ${4 + i} messages, ${i % 3} rendez-vous.`)) });
  add('ffffffff-0c01-4000-8000-000000000003', 'Factures mensuelles', 'Générer les factures le premier du mois.', '0 8 1 * *', 'America/Toronto',
    '1. Lire les feuilles de temps du mois\n2. Calculer les montants\n3. Produire les factures PDF\n4. Demander la validation d’Owner',
    { runs: [run(D * 4, 'failed', 45_000, 'Deux clients sans adresse de facturation.', { error: 'Adresse de facturation manquante pour 2 clients.' }), run(D * 34, 'succeeded', 128_000, '12 factures produites et validées.')] });
  add('ffffffff-0c01-4000-8000-000000000004', 'Audit SEO nocturne', 'Vérifier les balises et les liens morts du site vitrine.', '0 2 * * 1-5', 'America/Toronto',
    'Explorer le site vitrine, vérifier les balises et lister les liens morts. Ouvrir un ticket si plus de 5 liens sont morts.',
    { enabled: false, runs: [run(30 * H, 'failed', 45_000, '', { error: 'Le site a répondu 503.' }), run(54 * H, 'skipped', null, 'Ignorée : la tâche précédente tournait encore.')] });
  add('ffffffff-0c01-4000-8000-000000000005', 'Sauvegarde du serveur', 'Copie chiffrée vers le second disque.', '0 3 * * *', 'UTC', '', { payload: 'command', created: 20 * D, runs: [run(20 * H, 'succeeded', 312_000, 'Copie terminée (18,4 Go).')] });
  add('ffffffff-0c01-4000-8000-000000000006', 'Battement de Timmy', 'Vérification régulière de la session principale.', '', null, '', { kind: 'every', payload: 'heartbeat', created: 60 * D, runs: [] });
  add('ffffffff-0c01-4000-8000-000000000007', 'Infolettre de l’automne', 'Préparer le brouillon une seule fois.', '', null, 'Rédiger le brouillon de l’infolettre avec les nouveautés du trimestre.', { kind: 'at', created: 2 * D, runs: [] });

  const scheduleVM = (f) => (f.scheduleKind === 'cron' ? { kind: 'cron', expr: f.expr, tz: f.tz, sentence: sentence(f.expr, f.tz) }
    : f.scheduleKind === 'every' ? { kind: 'every', everyMs: 30 * MIN, anchorAt: null, sentence: { key: 'schedule.every', params: { duration: 'PT30M' } } }
    : { kind: 'at', at: now + 3 * D, sentence: { key: 'schedule.at', params: { at: new Date(now + 3 * D).toISOString() } } });
  const health = (f) => (!f.runs.length ? 'never-run' : f.runs.find((r) => r.status !== 'running' && r.status !== 'skipped')?.status === 'failed' ? 'failing' : 'ok');
  const nextRun = (f) => (f.enabled ? (f.scheduleKind === 'every' ? Date.now() + 12 * MIN : now + ((f.id.charCodeAt(f.id.length - 1) % 5) + 1) * 7 * H) : null);
  const summary = (f) => ({ id: f.id, name: f.name, description: f.description, enabled: f.enabled, schedule: scheduleVM(f), health: health(f),
    nextRunAt: nextRun(f), lastRunAt: f.runs[0] ? f.runs[0].at : null });
  const payloadVM = (f) => (f.payloadKind === 'agent-turn' ? { kind: 'agent-turn', message: f.message, model: f.model, timeoutSeconds: f.timeoutSeconds }
    : f.payloadKind === 'command' ? { kind: 'command', argv: ['restic', 'backup', '/srv'] } : { kind: 'heartbeat' });
  const editable = (f) => f.scheduleKind === 'cron' && f.payloadKind === 'agent-turn';
  const diagram = (f) => ({ nodes: [
    { kind: 'trigger', label: f.scheduleKind === 'cron' ? f.expr : f.scheduleKind === 'every' ? 'Toutes les 30 min' : 'Une seule fois' },
    ...(f.payloadKind === 'agent-turn' ? stepsOf(f.message).map((label) => ({ kind: /^(si|ouvrir un ticket si)\b/i.test(label) ? 'decision' : 'step', label }))
      : f.payloadKind === 'command' ? [{ kind: 'step', label: 'Exécuter la commande' }] : [{ kind: 'step', label: 'Vérifier la session principale' }]),
    { kind: 'output', label: f.payloadKind === 'agent-turn' ? 'Message' : 'Journal' },
  ] });
  const validId = (id) => typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/.test(id);

  return {
    list() {
      const all = [...flows.values()].sort((a, b) => Number(b.enabled) - Number(a.enabled) || a.name.localeCompare(b.name, 'fr'));
      return { flows: all.map(summary), counts: { total: all.length, enabled: all.filter((f) => f.enabled).length } };
    },
    detail(id) {
      const f = flows.get(id);
      if (!f) return null;
      return { job: { ...summary(f), agentId: f.agentId, sessionTarget: f.sessionTarget, wakeMode: f.wakeMode, payload: payloadVM(f), createdAt: f.createdAt, updatedAt: f.updatedAt },
        editable: editable(f), diagram: diagram(f), runs: f.runs.slice(0, 25).map((r) => ({ ...r, nextRunAt: r.status === 'running' ? null : nextRun(f) })) };
    },
    /** Commands → { result } | { error: [status, code, message, details] }; `touched` = job ids whose topics change. */
    create(b) {
      for (const k of Object.keys(b || {})) if (!['name', 'cron', 'tz', 'message'].includes(k)) return invalid(k, 'unexpected-field', 'Certaines valeurs sont invalides.');
      const bad = validateFields(b || {}, { partial: false });
      if (bad) return bad;
      const id = 'ffffffff-0c01-4000-8000-' + String(100 + flows.size).padStart(12, '0');
      flows.set(id, { id, name: b.name.trim(), description: '', enabled: true, expr: b.cron.trim(), tz: b.tz, message: b.message, scheduleKind: 'cron', payloadKind: 'agent-turn',
        agentId: 'main', sessionTarget: 'isolated', wakeMode: 'now', model: null, timeoutSeconds: null, createdAt: Date.now(), updatedAt: Date.now(), runs: [] });
      return { result: { jobId: id }, touched: [id] };
    },
    edit(id, b) {
      if (!validId(id)) return invalid('jobId', 'invalid-id', 'Identifiant de tâche invalide.');
      const f = flows.get(id);
      if (!f) return err(404, 'not_found', 'Cette tâche n’existe plus.');
      if (!editable(f)) return invalid('jobId', 'not-editable', 'Cette tâche ne peut pas être modifiée ici : seules les tâches cron avec une instruction le peuvent.');
      for (const k of Object.keys(b || {})) if (!['name', 'cron', 'tz', 'message'].includes(k)) return invalid(k, 'unexpected-field', 'Certaines valeurs sont invalides.');
      if (!Object.keys(b || {}).length) return invalid('body', 'empty', 'Aucun changement à enregistrer.');
      const bad = validateFields(b, { partial: true });
      if (bad) return bad;
      if (b.name !== undefined) f.name = b.name.trim();
      if (b.cron !== undefined) f.expr = b.cron.trim();
      if (b.tz !== undefined) f.tz = b.tz;
      if (b.message !== undefined) f.message = b.message;
      f.updatedAt = Date.now();
      return { result: null, touched: [id] };
    },
    setEnabled(id, b) {
      const f = flows.get(id);
      if (!validId(id)) return invalid('jobId', 'invalid-id', 'Identifiant de tâche invalide.');
      if (!f) return err(404, 'not_found', 'Cette tâche n’existe plus.');
      if (!b || typeof b.enabled !== 'boolean' || Object.keys(b).length !== 1) return invalid('enabled', 'invalid', 'Certaines valeurs sont invalides.');
      f.enabled = b.enabled;
      return { result: null, touched: [id] };
    },
    runNow(id, onDone) {
      const f = flows.get(id);
      if (!validId(id)) return invalid('jobId', 'invalid-id', 'Identifiant de tâche invalide.');
      if (!f) return err(404, 'not_found', 'Cette tâche n’existe plus.');
      if (f.runs[0] && f.runs[0].status === 'running') return err(409, 'conflict', 'Une exécution est déjà en cours.');
      const r = run(0, 'running', null, '', { at: Date.now(), tokens: null, delivery: { status: null, delivered: null, channel: null } });
      f.runs.unshift(r);
      setTimeout(() => {
        Object.assign(r, { status: 'succeeded', durationMs: 4_100, tokens: { total: 2_950, input: 2_400, output: 550 }, delivery: { status: 'delivered', delivered: true, channel: 'discord' },
          summary: 'Exécution manuelle terminée ; le résultat a été publié sur Discord.' });
        onDone([id]);
      }, 4_000);
      return { result: null, touched: [id] };
    },
    remove(id) {
      if (!validId(id)) return invalid('jobId', 'invalid-id', 'Identifiant de tâche invalide.');
      if (!flows.delete(id)) return err(404, 'not_found', 'Cette tâche n’existe plus.');
      return { result: null, touched: [id] };
    },
  };
}
