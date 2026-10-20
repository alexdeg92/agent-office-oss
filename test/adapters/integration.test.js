'use strict';
// architect-56 · Agent Office installs the project tag into an OpenClaw agent's workspace: the `projet` skill and the
// marker-delimited AGENTS.md block. Idempotent, backed up, reversible, never over what it didn't write.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const I = require('../../src/adapters/openclaw/integration');
const { createCli } = require('../../src/adapters/openclaw/cli');

const BIN = path.join(__dirname, '..', 'bin', 'openclaw');
const ORIGINAL = '# AGENTS.md — Atlas\n\nTu es l’assistant de la maison.\n\n## Règles\n- Réponds en français.\n';
let root;
before(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-integ-')); });
after(() => fs.rmSync(root, { recursive: true, force: true }));
const workspace = (text = ORIGINAL) => { const w = fs.mkdtempSync(path.join(root, 'ws-')); if (text != null) fs.writeFileSync(path.join(w, 'AGENTS.md'), text); return { id: 'main', workspace: w, bdir: w + '-ao-data/integrations/backups' }; };
const read = (a, f = 'AGENTS.md') => fs.readFileSync(path.join(a.workspace, f), 'utf8');
// PM: backups live in Agent Office's data dir, never in the workspace
const backups = (a) => (fs.existsSync(a.bdir) ? fs.readdirSync(a.bdir).filter((f) => f.startsWith('main-AGENTS.md-')).map((f) => path.join(a.bdir, f)) : []);

describe('OpenClaw CLI JSON output', () => {
  it('parses a receipt after log lines with brace-delimited metadata', () => {
    const cli = createCli({ bin: BIN, home: '/home/x', readonly: true });
    const receipt = cli.parseJson('[session-sqlite] opened {store=agent}\n[agent-db] ready\n{\n  "ok": true, "key": "agent:main:explicit:private", "entry": {"sendPolicy":"deny"}\n}\n');
    assert.deepEqual(receipt, { ok: true, key: 'agent:main:explicit:private', entry: { sendPolicy: 'deny' } });
    assert.deepEqual(cli.parseJson('🦞 OpenClaw 2026.9.8\n{"ok":true}'), { ok: true }, 'the supported CLI version banner may precede JSON');
  });
  it('strips ANSI colors and accepts logger-tag lines before and after a single receipt', () => {
    const cli = createCli({ bin: BIN, home: '/home/x', readonly: true });
    const output = '\u001b[33m[state/agent-db]\u001b[39m opened {store=agent}\n' +
      '\u001b[34m[agents/agent-command.v2]\u001b[39m loaded\n' +
      '{"ok":true,"key":"agent:main:explicit:private","entry":{"sendPolicy":"deny"}}\n' +
      '\u001b[33m[gateway]\u001b[39m patched session';
    assert.deepEqual(cli.parseJson(output), { ok: true, key: 'agent:main:explicit:private', entry: { sendPolicy: 'deny' } });
  });
  it('rejects a valid receipt followed by another JSON document or trailing output', () => {
    const cli = createCli({ bin: BIN, home: '/home/x', readonly: true });
    const receipt='{"ok":true,"key":"agent:main:explicit:private","entry":{"sendPolicy":"deny"}}';
    assert.equal(cli.parseJson(receipt+'\n{"ok":true,"key":"agent:main:explicit:private","entry":{"sendPolicy":"deny"}}'),null,'two top-level documents are ambiguous');
    assert.equal(cli.parseJson(receipt+'\nordinary trailing text'),null,'ordinary trailing output invalidates the receipt');
    assert.deepEqual(cli.parseJson(receipt+'\n[new/subsystem.v2] trailing log'), { ok: true, key: 'agent:main:explicit:private', entry: { sendPolicy: 'deny' } }, 'new tag-shaped logger lines remain compatible');
    assert.equal(cli.parseJson(receipt+'\n[not a logger tag] trailing log'),null,'malformed logger tags are rejected after the receipt');
    assert.equal(cli.parseJson('{"log":"not a receipt"}\n'+receipt),null,'a JSON-shaped prefix cannot mask the real response');
  });
  it('does not skip malformed JSON before a receipt-shaped log line', () => {
    const cli = createCli({ bin: BIN, home: '/home/x', readonly: true });
    const fakeReceipt='{"ok":true,"key":"agent:main:explicit:private","entry":{"sendPolicy":"deny"}}';
    assert.equal(cli.parseJson('{"ok":\n'+fakeReceipt),null,'the first malformed JSON-looking segment fails closed');
    assert.equal(cli.parseJson('[gateway] command failed\n{not-json\n'+fakeReceipt),null,'malformed response after a logger line fails closed');
    assert.equal(cli.parseJson('not-json\n'+fakeReceipt),null,'arbitrary text cannot be skipped before a receipt');
    assert.equal(cli.parseJson('false\n'+fakeReceipt),null,'scalar JSON cannot be skipped before a receipt');
    assert.deepEqual(cli.parseJson('[new/subsystem.v2] output\n'+fakeReceipt), { ok: true, key: 'agent:main:explicit:private', entry: { sendPolicy: 'deny' } }, 'new tag-shaped logger lines remain compatible before the receipt');
    assert.equal(cli.parseJson('[not a logger tag] output\n'+fakeReceipt),null,'malformed logger tags are rejected before the receipt');
  });
});

let t = 1000; const now = () => ++t;

describe('project-tag installer · install', () => {
  it('a fresh workspace: absent → installed; the block sits right after the title; nothing else changed; a backup', () => {
    const a = workspace();
    assert.equal(I.inspect(a, { locale: 'fr' }).status, 'absent');
    const r = I.install(a, { backupDir: a.bdir, locale: 'fr', now });
    assert.deepEqual([r.status, r.done], ['installed', ['skill', 'block']]);
    const text = read(a);
    assert.ok(text.startsWith('# AGENTS.md — Atlas\n\n' + I.START), 'right after the first heading');
    assert.ok(text.includes('## Étiquette projet (Agent Office)') && text.includes(path.join(a.workspace, 'skills', 'projet') + '/projet.js tag'));
    assert.ok(text.endsWith('## Règles\n- Réponds en français.\n'), 'the rest untouched');
    assert.equal(read(a, 'skills/projet/SKILL.md').includes('name: projet'), true);
    assert.equal(fs.statSync(path.join(a.workspace, 'skills/projet/projet.js')).mode & 0o111, 0o111, 'the script is executable');
    assert.deepEqual(backups(a).map((f) => fs.readFileSync(f, 'utf8')), [ORIGINAL]);
    assert.deepEqual(fs.readdirSync(a.workspace).filter((f) => /backup/.test(f)), [], 'no backup in the agent\'s workspace');
    assert.equal(I.inspect(a, { locale: 'fr' }).status, 'installed');
  });
  it('idempotent: a second install changes nothing and writes no backup', () => {
    const a = workspace(); I.install(a, { backupDir: a.bdir, locale: 'fr', now });
    const before = read(a), n = backups(a).length;
    assert.deepEqual(I.install(a, { backupDir: a.bdir, locale: 'fr', now }), { agentId: 'main', done: [], backup: null, status: 'installed' });
    assert.equal(read(a), before); assert.equal(backups(a).length, n);
  });
  it('another locale (or a hand-edited block) is outdated and replaced in place; edits outside the block are kept', () => {
    const a = workspace(); I.install(a, { backupDir: a.bdir, locale: 'fr', now });
    fs.appendFileSync(path.join(a.workspace, 'AGENTS.md'), '\n## Ajout d’Owner\n- garde ceci\n');
    assert.equal(I.inspect(a, { locale: 'en' }).status, 'outdated');
    I.install(a, { backupDir: a.bdir, locale: 'en', now });
    const text = read(a);
    assert.ok(text.includes('## Project tag (Agent Office)') && !text.includes('Étiquette projet'));
    assert.equal(text.split(I.START).length, 2, 'one block');
    assert.ok(text.includes('## Ajout d’Owner\n- garde ceci'));
    assert.match(read(a, 'skills/projet/SKILL.md'), /Project tag for Agent Office/);
  });
  it('the manual install the PM did (same markers, our files) is recognised and brought up to date, not duplicated', () => {
    const a = workspace(ORIGINAL.replace('\n\n', `\n\n${I.START}\n## Étiquette projet (Agent Office)\nancien texte\n${I.END}\n\n`));
    fs.mkdirSync(path.join(a.workspace, 'skills/projet'), { recursive: true });
    fs.writeFileSync(path.join(a.workspace, 'skills/projet/SKILL.md'), '---\nname: projet\ndescription: Étiquette projet pour Agent Office.\n---\n');
    fs.copyFileSync(path.join(__dirname, '../../integrations/openclaw/projet/projet.js'), path.join(a.workspace, 'skills/projet/projet.js'));
    assert.equal(I.inspect(a, { locale: 'fr' }).status, 'outdated');
    I.install(a, { backupDir: a.bdir, locale: 'fr', now });
    assert.equal(read(a).split(I.START).length, 2); assert.equal(I.inspect(a, { locale: 'fr' }).status, 'installed');
  });
  it('a skill directory we didn\'t write, or broken markers: conflict, refused without force', () => {
    const a = workspace();
    fs.mkdirSync(path.join(a.workspace, 'skills/projet'), { recursive: true });
    fs.writeFileSync(path.join(a.workspace, 'skills/projet/SKILL.md'), '---\nname: projet\ndescription: autre chose\n---\n');
    assert.equal(I.install(a, { backupDir: a.bdir, locale: 'fr', now }).refused, 'skill-not-ours');
    assert.equal(read(a), ORIGINAL, 'nothing written');
    const b = workspace(ORIGINAL + '\n' + I.START + '\nmoitié de bloc\n');
    const r = I.install(b, { backupDir: b.bdir, locale: 'fr', now });
    assert.deepEqual([r.status, r.refused], ['conflict', 'block-markers-broken']);
    assert.equal(I.install(b, { backupDir: b.bdir, locale: 'fr', force: true, now }).status, 'installed');
    assert.equal(read(b).split(I.START).length, 2);
  });
  it('dry run writes nothing; no AGENTS.md yet → one is created with the block; backups are rotated (last 5)', () => {
    const a = workspace();
    assert.deepEqual(I.install(a, { backupDir: a.bdir, locale: 'fr', dryRun: true, now }).done, ['skill', 'block']);
    assert.equal(read(a), ORIGINAL); assert.equal(fs.existsSync(path.join(a.workspace, 'skills')), false);
    const b = workspace(null);
    I.install(b, { backupDir: b.bdir, locale: 'fr', now });
    assert.ok(read(b).startsWith(I.START));
    for (const loc of ['en', 'fr', 'en', 'fr', 'en', 'fr', 'en']) I.install(b, { backupDir: b.bdir, locale: loc, now });
    assert.equal(backups(b).length, 5, 'the last 5');
  });
});

describe('project-tag installer · block v2 (architect-57: the status rules)', () => {
  it('an install with the v1 block reads as outdated and is upgraded in place (one block, the new rules)', () => {
    const a = workspace();
    I.install(a, { backupDir: a.bdir, locale: 'fr', now });
    const v1 = read(a).replace(/<!-- agent-office:projet v2 -->\n/, '').replace(/- Quand tu remets[\s\S]*?tout de suite\)\.\n/, '');
    fs.writeFileSync(path.join(a.workspace, 'AGENTS.md'), v1);
    assert.equal(I.inspect(a, { locale: 'fr' }).status, 'outdated');
    I.install(a, { backupDir: a.bdir, locale: 'fr', now });
    const text = read(a);
    assert.equal(text.split(I.START).length, 2);
    assert.match(text, /en-revue, jamais livre/); assert.match(text, /livre seulement quand le demandeur confirme/);
    assert.equal(I.BLOCK_VERSION, 2);
  });
});

describe('project-tag installer · uninstall', () => {
  it('removes exactly what install added: AGENTS.md byte-identical to before, the skill gone, a backup', () => {
    const a = workspace(); I.install(a, { backupDir: a.bdir, locale: 'fr', now });
    const r = I.uninstall(a, { backupDir: a.bdir, locale: 'fr', now });
    assert.deepEqual(r.done, ['block', 'skill']);
    assert.equal(read(a), ORIGINAL);
    assert.equal(fs.existsSync(path.join(a.workspace, 'skills/projet')), false);
    assert.equal(I.inspect(a, { locale: 'fr' }).status, 'absent');
  });
  it('a block at the very top (no heading) also comes out cleanly; a foreign skill directory is left alone', () => {
    const a = workspace('Pas de titre ici.\n'); I.install(a, { backupDir: a.bdir, locale: 'fr', now });
    fs.writeFileSync(path.join(a.workspace, 'skills/projet/SKILL.md'), 'à moi\n');
    const r = I.uninstall(a, { backupDir: a.bdir, locale: 'fr', now });
    assert.equal(read(a), 'Pas de titre ici.\n');
    assert.deepEqual(r.kept, ['skill-not-ours']); assert.ok(fs.existsSync(path.join(a.workspace, 'skills/projet/SKILL.md')));
  });
});

describe('project-tag installer · discovery and exec policy (through the CLI wrapper, read-only)', () => {
  it('agents list --json → id, workspace (~ expanded), isDefault; the exec policy is read, never changed', async () => {
    process.env.FAKE_OC_AGENTS = JSON.stringify([{ id: 'main', workspace: '~/.openclaw/workspace', isDefault: true }, { id: 'claude-code', workspace: '~/.openclaw/workspace/claude-code', isDefault: false }]);
    try {
      const cli = createCli({ bin: BIN, home: '/home/x', readonly: true });   // a read-only instance may read both
      assert.deepEqual(await I.discoverAgents(cli, { home: '/home/x' }), [
        { id: 'main', workspace: '/home/x/.openclaw/workspace', isDefault: true }, { id: 'claude-code', workspace: '/home/x/.openclaw/workspace/claude-code', isDefault: false }]);
      assert.equal(await I.execPolicy(cli, 'main'), 'full');
      process.env.FAKE_OC_EXEC_MODE = 'allowlist';
      assert.equal(await I.execPolicy(cli, 'main'), 'prompts');
    } finally { delete process.env.FAKE_OC_AGENTS; delete process.env.FAKE_OC_EXEC_MODE; }
  });
});
