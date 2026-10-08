'use strict';
/*
 * architect-56 · `agent-office integrations [status|install|uninstall] [--agent id]… [--all] [--dry-run] [--force]
 *                                         [--json] [--lang fr|en] [--env-file file] [--config file]`
 * What Agent Office installs into the runtime's agents: today the project tag (OpenClaw adapter; docs/guide/project-tag.md).
 * The same effective configuration as the server (env, then the instance config file). Default target: the primary
 * agent (AO_PRIMARY_AGENT, else OpenClaw's default agent); --agent for others, --all for every agent.
 * Opt-out: AO_INTEGRATIONS=none (or the instance config's integrations.projet: false) refuses install; a read-only
 * instance (PORTAL_READONLY=1) never writes. Never prints a value.
 * Exit: 0 done or nothing to do · 1 something to do (status) or refused · 2 failed · 64 usage.
 */
const IC = require('../instance-config');
const path = require('path');
const { openclawPaths, defaultDataDir } = require('../config');

const USAGE = 'usage: agent-office integrations [status|install|uninstall] [--agent <id>]… [--all] [--dry-run] [--force] [--json] [--lang fr|en] [--env-file <file>] [--config <file>]';
const T = {
  fr: { title: 'Agent Office · intégrations · étiquette projet', installed: 'installée', outdated: 'à mettre à jour', absent: 'absente', conflict: 'conflit (pas de notre main)',
    skill: 'compétence', block: 'bloc AGENTS.md', done: 'fait', nothing: 'rien à faire', backup: 'sauvegarde', kept: 'laissé en place', dry: '(simulation : rien n’est écrit)',
    off: 'L’intégration est désactivée (AO_INTEGRATIONS=none ou integrations.projet: false).', ro: 'Instance en lecture seule : rien n’est écrit.',
    noAgents: 'Aucun agent trouvé (openclaw agents list).', notOpenclaw: 'Cette intégration est propre à OpenClaw ; l’instance utilise un autre adaptateur.',
    unknownAgent: 'Agent inconnu', prompts: 'La politique exec de cet agent demande une approbation : autorisez la commande avec « openclaw approvals allowlist add » (voir le guide).',
    refused: { 'skill-not-ours': 'refusé : skills/projet existe et n’est pas de nous (--force pour remplacer)', 'block-markers-broken': 'refusé : marqueurs du bloc cassés dans AGENTS.md (--force pour réparer)' } },
  en: { title: 'Agent Office · integrations · project tag', installed: 'installed', outdated: 'outdated', absent: 'absent', conflict: 'conflict (not ours)',
    skill: 'skill', block: 'AGENTS.md block', done: 'done', nothing: 'nothing to do', backup: 'backup', kept: 'left in place', dry: '(dry run: nothing written)',
    off: 'The integration is turned off (AO_INTEGRATIONS=none or integrations.projet: false).', ro: 'Read-only instance: nothing is written.',
    noAgents: 'No agent found (openclaw agents list).', notOpenclaw: 'This integration is OpenClaw-specific; the instance uses another adapter.',
    unknownAgent: 'Unknown agent', prompts: 'This agent\'s exec policy asks for approval: allow the command with "openclaw approvals allowlist add" (see the guide).',
    refused: { 'skill-not-ours': 'refused: skills/projet exists and is not ours (--force to replace)', 'block-markers-broken': 'refused: broken block markers in AGENTS.md (--force to repair)' } },
};

function parse(args) {
  const o = { action: 'status', agents: [], all: false, dryRun: false, force: false, json: false };
  let i = 0;
  if (args[0] && !args[0].startsWith('-')) { o.action = args[0]; i = 1; }
  if (!['status', 'install', 'uninstall'].includes(o.action)) throw new Error('unknown action (status, install or uninstall)');
  for (; i < args.length; i++) {
    const a = args[i];
    if (a === '--all') o.all = true;
    else if (a === '--dry-run') o.dryRun = true;
    else if (a === '--force') o.force = true;
    else if (a === '--json') o.json = true;
    else if (['--agent', '--lang', '--env-file', '--config'].includes(a)) {
      const v = args[++i];
      if (v === undefined || v.startsWith('-')) throw new Error(`missing value for ${a}`);
      if (a === '--agent') { if (!/^[A-Za-z0-9_-]{1,64}$/.test(v)) throw new Error('--agent takes an agent id'); o.agents.push(v); } else o[a.slice(2).replace('-f', 'F')] = v;
    } else throw new Error(`unknown argument #${i + 1}` + (/^--?[a-z][a-z-]{0,24}$/.test(a.split('=')[0]) ? ` (${a.split('=')[0]})` : ''));
  }
  if (o.lang && !['fr', 'en'].includes(o.lang)) throw new Error('--lang is fr or en');
  return o;
}

/** deps (tests): { cli, integration, now } */
async function run(args, env = process.env, io = {}, deps = {}) {
  const out = io.out || ((m) => process.stdout.write(m)), err = io.err || ((m) => process.stderr.write(m));
  let o;
  try { o = parse(args); } catch (e) { err(`agent-office integrations: ${e.message}\n${USAGE}\n`); return 64; }
  let e2 = env;
  if (o.envFile) { try { e2 = deps.loadEnvFile(o.envFile, env); } catch (e) { err(`agent-office integrations: ${e.message}\n`); return 64; } }
  if (o.config) e2 = Object.assign({}, e2, { AO_CONFIG: o.config });
  let files; try { files = IC.readInstanceConfig(e2); } catch (_) { files = { config: null, secrets: null }; }
  const eff = IC.effectiveEnv(e2, files);
  const locale = o.lang || (String(eff.AO_LOCALE || '').toLowerCase().startsWith('en') ? 'en' : 'fr');
  const t = T[locale];
  const report = { version: 1, locale, action: o.action, dryRun: o.dryRun, agents: [], notes: [] };
  const finish = (code) => {
    if (o.json) out(JSON.stringify(Object.assign(report, { exitCode: code }), null, 2) + '\n');
    else {
      const lines = [t.title];
      for (const a of report.agents) {
        lines.push(`- ${a.agentId}: ${t[a.status] || a.status}${a.done && a.done.length ? ` · ${t.done}: ${a.done.map((x) => t[x]).join(', ')}` : a.done ? ` · ${t.nothing}` : ''}` +
          `${a.refused ? ` · ${t.refused[a.refused]}` : ''}${a.kept && a.kept.length ? ` · ${t.kept}: ${a.kept.join(', ')}` : ''}${a.backup ? ` · ${t.backup}: ${a.backup}` : ''}`);
        if (a.workspace) lines.push(`  ${a.workspace}`);
        if (a.execPolicy === 'prompts') lines.push(`  ! ${t.prompts}`);
      }
      for (const n of report.notes) lines.push(t[n] || n);
      if (o.dryRun) lines.push(t.dry);
      out(lines.join('\n') + '\n');
    }
    return code;
  };
  if ((eff.AO_RUNTIME || 'openclaw') !== 'openclaw') { report.notes.push('notOpenclaw'); return finish(o.action === 'status' ? 0 : 1); }
  const integration = deps.integration || require('../adapters').adapterById('openclaw').projectTag();
  const paths = openclawPaths(eff);
  const cli = deps.cli || integration.cli({ openclawBin: paths.openclawBin, openclawHome: paths.openclawHome, readonly: true });
  const agents = await integration.discoverAgents(cli, { home: paths.openclawHome });
  if (!agents || !agents.length) { report.notes.push('noAgents'); return finish(2); }
  const primary = eff.AO_PRIMARY_AGENT || (agents.find((a) => a.isDefault) || agents[0]).id;
  const ids = o.all ? agents.map((a) => a.id) : o.agents.length ? o.agents : [primary];
  const unknown = ids.filter((id) => !agents.some((a) => a.id === id));
  if (unknown.length) { report.notes.push(`${t.unknownAgent}: ${unknown.join(', ')}`); return finish(64); }
  const targets = agents.filter((a) => ids.includes(a.id));
  const writes = o.action !== 'status' && !o.dryRun;
  // AGENTS.md backups go to Agent Office's own data dir (PM), never into the agent's workspace
  const named = eff.AO_ENV || (eff.PORTAL_READONLY === '1' ? 'staging' : eff.NODE_ENV === 'production' ? 'production' : 'dev');
  const dataDir = path.resolve(eff.AO_DATA_DIR || defaultDataDir(eff, ['production', 'staging', 'dev', 'test'].includes(named) ? named : 'dev'));
  const backupDir = path.join(dataDir, 'integrations', 'backups');
  if (writes && eff.PORTAL_READONLY === '1') { report.notes.push('ro'); return finish(1); }
  if (o.action === 'install' && String(eff.AO_INTEGRATIONS || 'projet').split(',').map((x) => x.trim()).includes('none')) { report.notes.push('off'); return finish(1); }
  let code = 0;
  for (const a of targets) {
    try {
      if (o.action === 'status') {
        const s = integration.inspect(a, { locale });
        report.agents.push(Object.assign({}, s, { execPolicy: await integration.execPolicy(cli, a.id) }));
        if (s.status !== 'installed') code = Math.max(code, 1);
      } else if (o.action === 'install') {
        const r = integration.install(a, { locale, force: o.force, dryRun: o.dryRun, backupDir, now: deps.now });
        report.agents.push(Object.assign({ workspace: a.workspace, execPolicy: await integration.execPolicy(cli, a.id) }, r));
        if (r.status === 'conflict') code = Math.max(code, 1);
      } else {
        const r = integration.uninstall(a, { locale, dryRun: o.dryRun, backupDir, now: deps.now });
        report.agents.push(Object.assign({ workspace: a.workspace, status: o.dryRun ? integration.inspect(a, { locale }).status : 'absent' }, r));
      }
    } catch (e) { report.agents.push({ agentId: a.id, status: 'failed', error: e.code || 'error' }); code = 2; }
  }
  return finish(code);
}

module.exports = { run, parse, USAGE };
