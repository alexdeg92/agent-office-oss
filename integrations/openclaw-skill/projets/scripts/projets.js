#!/usr/bin/env node
'use strict';

const STATUSES = new Set(['idea', 'todo', 'in-progress', 'in-review', 'shipped']);
const HISTORY_KINDS = new Set(['commit', 'flow-run', 'cron-run', 'session', 'agent-action']);
const HISTORY_FIELDS = {
  commit: new Set(['branch', 'shas', 'dedupeKey', 'eventAt']),
  'flow-run': new Set(['jobId', 'runId', 'status', 'durationMs', 'dedupeKey', 'eventAt']),
  'cron-run': new Set(['jobId', 'runId', 'status', 'durationMs', 'dedupeKey', 'eventAt']),
  session: new Set(['sessionKey', 'messages', 'tokens', 'dedupeKey', 'eventAt']),
  'agent-action': new Set(['action', 'note', 'subjectPersonId', 'dedupeKey', 'eventAt']),
};
const ACTIONS = new Set(['delegated', 'commented']);
const RUN_STATUS = new Set(['succeeded', 'failed', 'skipped', 'running']);

function fail(message) {
  process.stderr.write(`${message}\n`);
  return 2;
}

function scrub(text, token) {
  const raw = String(text ?? '');
  return token ? raw.split(token).join('[jeton]') : raw;
}

function projectId(value) {
  return typeof value === 'string' && /^prj_[a-z0-9]{8,32}$/.test(value);
}

function revision(value) {
  if (!/^[0-9]+$/.test(String(value ?? ''))) return null;
  const n = Number(value);
  return Number.isInteger(n) ? n : null;
}

function portalUrl(env) {
  const raw = env.AGENT_OFFICE_URL || 'https://office.example.com';
  let url;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.username || url.password) return null;
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  return url.origin;
}

function pairs(args) {
  const out = {};
  for (const arg of args) {
    const eq = String(arg).indexOf('=');
    if (eq <= 0) return null;
    out[arg.slice(0, eq)] = arg.slice(eq + 1);
  }
  return out;
}

function historyBody(kind, args) {
  if (!HISTORY_KINDS.has(kind)) return { error: 'Cet événement n’est pas ouvert à Timmy.' };
  const fields = pairs(args);
  if (!fields) return { error: 'Les détails s’écrivent clé=valeur.' };
  const allowed = HISTORY_FIELDS[kind];
  for (const key of Object.keys(fields)) {
    if (!allowed.has(key)) return { error: 'Champ refusé pour cet événement.' };
  }
  const body = { kind };
  if (fields.dedupeKey) body.dedupeKey = fields.dedupeKey;
  if (fields.eventAt) {
    const at = revision(fields.eventAt);
    if (at == null) return { error: 'eventAt doit être un nombre.' };
    body.eventAt = at;
  }
  if (kind === 'commit') {
    if (!fields.branch || !fields.shas) return { error: 'Un commit exige branch et shas.' };
    body.branch = fields.branch;
    body.shas = fields.shas.split(',').filter(Boolean);
  } else if (kind === 'flow-run' || kind === 'cron-run') {
    if (!fields.jobId || !fields.runId || !RUN_STATUS.has(fields.status || '')) {
      return { error: 'Une exécution exige jobId, runId et status.' };
    }
    body.jobId = fields.jobId;
    body.runId = fields.runId;
    body.status = fields.status;
    body.durationMs = fields.durationMs == null || fields.durationMs === '' ? null : revision(fields.durationMs);
    if (fields.durationMs && body.durationMs == null) return { error: 'durationMs doit être un nombre.' };
  } else if (kind === 'session') {
    if (!fields.sessionKey) return { error: 'Une session exige sessionKey.' };
    body.sessionKey = fields.sessionKey;
    body.messages = fields.messages == null || fields.messages === '' ? null : revision(fields.messages);
    body.tokens = fields.tokens == null || fields.tokens === '' ? 0 : revision(fields.tokens);
    if (fields.messages && body.messages == null) return { error: 'messages doit être un nombre.' };
    if (body.tokens == null) return { error: 'tokens doit être un nombre.' };
  } else {
    if (!ACTIONS.has(fields.action || '')) return { error: 'action doit être delegated ou commented.' };
    body.action = fields.action;
    body.note = fields.note || '';
    if (body.note.length > 500) return { error: 'La note dépasse 500 caractères.' };
    if (fields.subjectPersonId) body.subjectPersonId = fields.subjectPersonId;
  }
  return { body };
}

function commandOf(argv) {
  const [name, id, revRaw, ...rest] = argv;
  if (!name || name === 'help' || name === '--help') {
    return { error: 'Commandes : status, reorder, label, summary, history.' };
  }
  if (!['status', 'reorder', 'label', 'summary', 'history'].includes(name)) {
    return { error: 'Commande hors du jeton de Timmy.' };
  }
  if (!projectId(id)) return { error: 'Identifiant de projet invalide.' };
  const expectedRevision = revision(revRaw);
  if (expectedRevision == null) return { error: 'Révision invalide.' };
  const root = `/api/v2/projects/${id}`;
  if (name === 'status' || name === 'reorder') {
    if (rest.some((part) => part === '--index' || part.startsWith('index='))) {
      return { error: 'La position dans la colonne n’est pas acceptée.' };
    }
    if (rest.length !== 1 || !STATUSES.has(rest[0])) return { error: 'Statut invalide.' };
    return { method: 'PUT', path: `${root}/status`, body: { expectedRevision, status: rest[0] } };
  }
  if (name === 'label') {
    const label = rest.join(' ').trim();
    if (label.length < 1 || label.length > 32) return { error: 'Étiquette invalide.' };
    return { method: 'POST', path: `${root}/flags`, body: { expectedRevision, kind: 'label', label } };
  }
  if (name === 'summary') {
    const summary = rest.join(' ').trim();
    if (summary.length > 4000) return { error: 'Le résumé dépasse 4000 caractères.' };
    return { method: 'PATCH', path: root, body: { expectedRevision, summary } };
  }
  const built = historyBody(rest[0], rest.slice(1));
  if (built.error) return built;
  return { method: 'POST', path: `${root}/history`, body: { expectedRevision, ...built.body } };
}

async function main(argv, env, fetchImpl) {
  const token = env.AGENT_OFFICE_TOKEN;
  if (!token) return fail('AGENT_OFFICE_TOKEN manquant.');
  if (/\s/.test(token)) return fail('AGENT_OFFICE_TOKEN invalide.');
  const origin = portalUrl(env);
  if (!origin) return fail('AGENT_OFFICE_URL invalide.');
  const command = commandOf(argv);
  if (command.error) return fail(command.error);
  const payload = JSON.stringify(command.body);
  if (payload.includes(token)) return fail('Le corps ne doit pas contenir le jeton.');
  let response;
  try {
    response = await fetchImpl(`${origin}${command.path}`, {
      method: command.method,
      redirect: 'manual',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: payload,
    });
  } catch (err) {
    process.stderr.write(`${scrub(err && err.message, token) || 'Le portail est injoignable.'}\n`);
    return 1;
  }
  if (response.status >= 300 && response.status < 400) {
    process.stderr.write('Redirection refusée.\n');
    return 1;
  }
  const text = scrub(await response.text(), token);
  process.stdout.write(text.endsWith('\n') || text.length === 0 ? text : `${text}\n`);
  return response.ok ? 0 : 1;
}

if (require.main === module) {
  main(process.argv.slice(2), process.env, globalThis.fetch).then((code) => {
    process.exitCode = code;
  });
}

module.exports = { main, commandOf };
