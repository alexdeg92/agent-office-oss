'use strict';
/*
 * architect-56 · Agent Office installs the project tag into an OpenClaw agent, like a package (docs/guide/project-tag.md).
 * It touches ONLY the agent's workspace files, never openclaw.json:
 *   - `<workspace>/skills/projet/` : SKILL.md (in the instance locale) and projet.js (the no-op script);
 *   - one block in `<workspace>/AGENTS.md`, between <!-- agent-office:projet:debut --> and <!-- agent-office:projet:fin -->,
 *     near the top (OpenClaw keeps the head when AGENTS.md exceeds 20,000 characters).
 * Idempotent (the markers); AGENTS.md is backed up before every change into Agent Office's data dir (<dataDir>/integrations/backups/
 * <agent>-AGENTS.md-<ts>, the last 5 kept; never in the agent's workspace); uninstall removes exactly what install added. A skill directory or block we didn't write is a `conflict`, never
 * overwritten without `force`. The exec policy is only READ (`openclaw approvals get --json`) and reported.
 * Statuses: installed | outdated | absent | conflict.
 */
const fs = require('fs');
const path = require('path');

const START = '<!-- agent-office:projet:debut -->', END = '<!-- agent-office:projet:fin -->';
const OURS = 'agent-office:projet';   // the mark in every file we write
// architect-57: v2 = the status rules (en-revue when handed over; livre only when the requester confirms)
const BLOCK_VERSION = 2;
const BACKUPS_KEPT = 5;   // PM: the last 5 per agent, in Agent Office's own data dir (never in the agent's workspace)
const SCRIPT = path.join(__dirname, '..', '..', '..', 'integrations', 'openclaw', 'projet', 'projet.js');

const BLOCK = {
  fr: (dir) => `${START}
<!-- ${OURS} v${BLOCK_VERSION} -->
## Étiquette projet (Agent Office)
De ta propre initiative, même si personne ne dit « projet », tiens le tableau de projets à jour avec la compétence \`projet\` :
\`node ${dir}/projet.js tag <slug> <statut> <P0-P9> ["titre"] [note]\`
- Étiquette tout travail substantiel : construire ou produire quelque chose, une demande longue ou en plusieurs étapes, un travail suivi.
  Ex. : « monte une page d’accueil pour le resto », « prépare la migration de la base clients », « suis le ticket PIVOT-2735 ».
- N’étiquette pas : une question simple, une recherche rapide, une conversation légère.
  Ex. : « quelle heure est-il à Tokyo ? », « trouve le numéro du fournisseur », « merci, bonne soirée ».
- slug : court, en minuscules avec des tirets (menu-builder, pivot-2735). Pour une suite, même dans une autre conversation, reprends exactement le même slug.
- statut : idee, a-faire, en-cours, en-revue ou livre. Priorité : de P0 (le plus urgent et important) à P9, selon l’urgence et l’impact.
- Quand tu remets ton travail au demandeur (un plan, un livrable, quelque chose à valider) : en-revue, jamais livre.
- livre seulement quand le demandeur confirme que c’est terminé ou accepté, ou te demande de le clore.
- Si le demandeur demande des changements : en-cours (ou a-faire si tu ne t’y mets pas tout de suite).
- Appelle-la quand le travail commence, puis à chaque changement de statut ou de priorité.
- C’est une métadonnée pour le tableau de bord : ne la mentionne jamais dans tes réponses, à personne.
${END}`,
  en: (dir) => `${START}
<!-- ${OURS} v${BLOCK_VERSION} -->
## Project tag (Agent Office)
On your own judgement, even when nobody says "project", keep the projects board up to date with the \`projet\` skill:
\`node ${dir}/projet.js tag <slug> <statut> <P0-P9> ["title"] [note]\`
- Tag any substantial work: building or producing something, a long or multi-step request, ongoing work.
  E.g. "build a landing page for the restaurant", "prepare the customer database migration", "follow ticket PIVOT-2735".
- Don't tag: a simple question, a quick lookup, small talk.
  E.g. "what time is it in Tokyo?", "find the supplier's number", "thanks, good night".
- slug: short, lower case with dashes (menu-builder, pivot-2735). For a follow-up, even in another conversation, reuse exactly the same slug.
- statut (keep these words): idee, a-faire, en-cours, en-revue or livre. Priority: from P0 (most urgent and important) to P9, by urgency and impact.
- When you hand your work to the requester (a plan, a deliverable, something to approve): en-revue, never livre.
- livre only when the requester confirms it is done or accepted, or asks you to close it.
- If the requester asks for changes: en-cours (or a-faire if you won't start right away).
- Call it when the work starts, then whenever the status or priority changes.
- It is metadata for the dashboard: never mention it in your replies, to anyone.
${END}`,
};

const SKILL_MD = {
  fr: `---
name: projet
description: Étiquette projet pour Agent Office. Signale, sans rien envoyer à personne, le projet sur lequel tu travailles, son statut et sa priorité.
---
<!-- ${OURS} -->

# projet

Métadonnée pour le tableau de bord Agent Office. L’outil ne fait rien : seul l’appel compte, et il reste dans l’historique de la session. Il n’est jamais envoyé à qui que ce soit.

\`\`\`
node {baseDir}/projet.js tag <slug> <statut> <P0-P9> ["titre"] [note]
\`\`\`

- \`slug\` : court, en minuscules avec des tirets, stable (\`pivot-2735\`, \`menu-builder\`). Reprends toujours le même pour un même projet, y compris dans une autre conversation.
- \`statut\` : \`idee\`, \`a-faire\`, \`en-cours\`, \`en-revue\` ou \`livre\`. Travail remis au demandeur : \`en-revue\` ; \`livre\` seulement quand il confirme que c’est terminé ou accepté ; changements demandés : \`en-cours\` (ou \`a-faire\`).
- \`P0-P9\` : la priorité, selon l’urgence et l’impact (P0 = le plus urgent et important, P9 = le moins).
- \`"titre"\` : le nom du projet, entre guillemets (facultatif, surtout au premier appel). \`note\` : facultative.

Ne mentionne jamais l’étiquette dans tes réponses.
`,
  en: `---
name: projet
description: Project tag for Agent Office. Records, without sending anything to anyone, the project you work on, its status and its priority.
---
<!-- ${OURS} -->

# projet

Metadata for the Agent Office dashboard. The tool does nothing: only the call matters, and it stays in the session's history. It is never sent to anyone.

\`\`\`
node {baseDir}/projet.js tag <slug> <statut> <P0-P9> ["title"] [note]
\`\`\`

- \`slug\`: short, lower case with dashes, stable (\`pivot-2735\`, \`menu-builder\`). Always reuse the same one for a project, also in another conversation.
- \`statut\` (keep these words): \`idee\`, \`a-faire\`, \`en-cours\`, \`en-revue\` or \`livre\`. Work handed to the requester: \`en-revue\`; \`livre\` only when they confirm it is done or accepted; changes asked: \`en-cours\` (or \`a-faire\`).
- \`P0-P9\`: the priority, by urgency and impact (P0 = the most urgent and important, P9 = the least).
- \`"title"\`: the project's name, quoted (optional, mostly on the first call). \`note\`: optional.

Never mention the tag in your replies.
`,
};

const localeOf = (l) => (String(l || '').toLowerCase().startsWith('en') ? 'en' : 'fr');
const expandHome = (p, home) => (typeof p === 'string' && p.startsWith('~/') ? path.join(home, p.slice(2)) : p);

/** The files and block a workspace should hold for this release, in a locale. */
function expected(workspace, locale) {
  const dir = path.join(workspace, 'skills', 'projet');
  const loc = localeOf(locale);
  return { dir, block: BLOCK[loc](dir), files: { 'SKILL.md': SKILL_MD[loc], 'projet.js': fs.readFileSync(SCRIPT, 'utf8') } };
}

// the block's span in AGENTS.md text: null (none), { start, end } (a well-formed block), or 'broken'
function blockSpan(text) {
  const a = text.indexOf(START), b = text.indexOf(END);
  if (a < 0 && b < 0) return null;
  if (a < 0 || b < a || text.indexOf(START, a + 1) >= 0 || text.indexOf(END, b + 1) >= 0) return 'broken';
  return { start: a, end: b + END.length };
}

/** → { agentId, workspace, status, skill: 'ours'|'absent'|'foreign'|'outdated', block: 'present'|'absent'|'outdated'|'broken' } */
function inspect(agent, { locale, fsx = fs } = {}) {
  const want = expected(agent.workspace, locale);
  const read = (f) => { try { return fsx.readFileSync(f, 'utf8'); } catch (_) { return null; } };
  let skill = 'absent';
  if (fsx.existsSync(want.dir)) {
    const got = Object.fromEntries(Object.keys(want.files).map((f) => [f, read(path.join(want.dir, f))]));
    const ours = Object.values(got).every((t) => t != null && (t.includes(OURS) || t.includes('Agent Office')));
    skill = !ours ? 'foreign' : Object.entries(want.files).every(([f, t]) => got[f] === t) ? 'ours' : 'outdated';
  }
  const agentsMd = read(path.join(agent.workspace, 'AGENTS.md'));
  const span = agentsMd == null ? null : blockSpan(agentsMd);
  const block = span === 'broken' ? 'broken' : !span ? 'absent' : agentsMd.slice(span.start, span.end) === want.block ? 'present' : 'outdated';
  const status = skill === 'foreign' || block === 'broken' ? 'conflict'
    : skill === 'ours' && block === 'present' ? 'installed'
    : skill === 'absent' && block === 'absent' ? 'absent' : 'outdated';
  return { agentId: agent.id, workspace: agent.workspace, status, skill, block };
}

// AGENTS.md before a change, into `backupDir` (Agent Office's <dataDir>/integrations/backups): <agentId>-AGENTS.md-<ts>
function backup(file, agentId, { backupDir, fsx = fs, now = Date.now } = {}) {
  if (!fsx.existsSync(file)) return null;
  if (!backupDir) throw Object.assign(new Error('no backup directory'), { code: 'ENOBACKUPDIR' });
  fsx.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  const base = `${agentId}-AGENTS.md-`;
  const out = path.join(backupDir, base + now());
  fsx.copyFileSync(file, out); fsx.chmodSync(out, 0o600);
  const all = fsx.readdirSync(backupDir).filter((f) => f.startsWith(base)).sort((a, b) => Number(a.slice(base.length)) - Number(b.slice(base.length)));
  for (const f of all.slice(0, Math.max(0, all.length - BACKUPS_KEPT))) fsx.rmSync(path.join(backupDir, f), { force: true });
  return out;
}
function writeAtomic(file, text, { fsx = fs, mode = 0o644 } = {}) {
  const tmp = `${file}.agent-office-tmp-${process.pid}`;
  fsx.writeFileSync(tmp, text, { mode });
  fsx.renameSync(tmp, file);
}
// near the top: right after the first level-1 heading in the first 30 lines, else at the very top
function insertBlock(text, block) {
  const lines = text.split('\n');
  const h = lines.slice(0, 30).findIndex((l) => /^#\s/.test(l));
  if (h < 0) return block + '\n\n' + text;
  return lines.slice(0, h + 1).join('\n') + '\n\n' + block + '\n' + (lines.length > h + 1 ? '\n' + lines.slice(h + 1).join('\n').replace(/^\n+/, '') : '');
}

/** → { agentId, done: [...], backup, status } ; dryRun plans only. A conflict is refused unless force. */
function install(agent, { locale, force = false, dryRun = false, backupDir = null, fsx = fs, now = Date.now } = {}) {
  const before = inspect(agent, { locale, fsx });
  if (before.status === 'installed') return { agentId: agent.id, done: [], backup: null, status: 'installed' };
  if (before.status === 'conflict' && !force) return { agentId: agent.id, done: [], backup: null, status: 'conflict', refused: before.skill === 'foreign' ? 'skill-not-ours' : 'block-markers-broken' };
  const want = expected(agent.workspace, locale);
  const done = [];
  if (before.skill !== 'ours') {
    done.push('skill');
    if (!dryRun) { fsx.mkdirSync(want.dir, { recursive: true }); for (const [f, t] of Object.entries(want.files)) writeAtomic(path.join(want.dir, f), t, { fsx, mode: f.endsWith('.js') ? 0o755 : 0o644 }); }
  }
  let bak = null;
  if (before.block !== 'present') {
    done.push('block');
    const file = path.join(agent.workspace, 'AGENTS.md');
    if (!dryRun) {
      const text = fsx.existsSync(file) ? fsx.readFileSync(file, 'utf8') : '';
      const span = blockSpan(text);
      let next;
      if (span && span !== 'broken') next = text.slice(0, span.start) + want.block + text.slice(span.end);
      else if (span === 'broken') next = insertBlock(text.split(START).join('').split(END).join(''), want.block);   // force: stray markers dropped
      else next = insertBlock(text, want.block);
      bak = backup(file, agent.id, { backupDir, fsx, now });
      writeAtomic(file, next, { fsx });
    }
  }
  return { agentId: agent.id, done, backup: bak, status: dryRun ? before.status : 'installed', dryRun };
}

/** Removes exactly what install added: the block (AGENTS.md backed up first) and our skill directory (only if ours). */
function uninstall(agent, { locale, dryRun = false, backupDir = null, fsx = fs, now = Date.now } = {}) {
  const before = inspect(agent, { locale, fsx });
  const done = [], kept = [];
  let bak = null;
  const file = path.join(agent.workspace, 'AGENTS.md');
  if (before.block === 'present' || before.block === 'outdated') {
    done.push('block');
    if (!dryRun) {
      const text = fsx.readFileSync(file, 'utf8');
      const span = blockSpan(text);
      // the block and the blank lines insertBlock added around it
      const next = (text.slice(0, span.start).replace(/\n\n$/, '\n') + text.slice(span.end).replace(/^\n\n/, '\n')).replace(/^\n/, '');
      bak = backup(file, agent.id, { backupDir, fsx, now });
      writeAtomic(file, next, { fsx });
    }
  } else if (before.block === 'broken') kept.push('block-markers-broken');
  if (before.skill === 'ours' || before.skill === 'outdated') {
    done.push('skill');
    if (!dryRun) fsx.rmSync(expected(agent.workspace, locale).dir, { recursive: true, force: true });
  } else if (before.skill === 'foreign') kept.push('skill-not-ours');
  return { agentId: agent.id, done, kept, backup: bak, dryRun };
}

/** The agents OpenClaw lists (`openclaw agents list --json`), workspaces expanded. → [{ id, workspace, isDefault }] */
async function discoverAgents(cli, { home }) {
  const r = await cli.run(['agents', 'list', '--json'], 30000);
  if (!r.ok) return null;
  const out = r.out || '';
  const i = out.search(/[[{]/);
  let v; try { v = JSON.parse(out.slice(i)); } catch (_) { return null; }
  const list = Array.isArray(v) ? v : (v && (v.agents || v.items)) || [];
  return list.filter((a) => a && typeof a.id === 'string' && typeof a.workspace === 'string')
    .map((a) => ({ id: a.id, workspace: expandHome(a.workspace, home), isDefault: !!(a.isDefault || a.default) }));
}

/** Read-only: does the agent's exec policy run commands without asking? → 'full' | 'prompts' | 'unknown' */
async function execPolicy(cli, agentId) {
  const r = await cli.run(['approvals', 'get', '--json'], 30000);
  if (!r.ok) return 'unknown';
  let v; try { v = JSON.parse((r.out || '').slice((r.out || '').indexOf('{'))); } catch (_) { return 'unknown'; }
  const scopes = (v && v.effectivePolicy && v.effectivePolicy.scopes) || [];
  const s = scopes.find((x) => x && x.agentId === agentId) || scopes.find((x) => x && x.configPath === 'tools.exec');
  const mode = s && s.mode && s.mode.effective;
  return mode === 'full' ? 'full' : mode ? 'prompts' : 'unknown';
}

module.exports = { BLOCK_VERSION, inspect, install, uninstall, discoverAgents, execPolicy, expected, blockSpan, START, END, localeOf };
