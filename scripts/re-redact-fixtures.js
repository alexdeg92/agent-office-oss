#!/usr/bin/env node
'use strict';
/*
 * Deterministic re-redaction of an EXISTING captured scenario with the current redaction policy,
 * without touching the live gateway (R1-02). One FixtureRedactor instance (fixed salt, no time
 * shift) processes every file of the scenario so fakes stay consistent across files; the skills
 * list goes first so public (bundled/extra) skill names are known before they reappear.
 *
 *   node scripts/re-redact-fixtures.js --scenario capture-20261005 [--fixtures dir] [--already-redacted] [--dry-run]
 *
 * --already-redacted: the input files were already redacted (no original available), so values
 * shaped exactly like our fakes are kept instead of re-faked (ids stay stable across passes).
 *
 * Rewrites, in place under test/fixtures/local/ (captures are local-only, never committed): the scenario's envelope files, its skill SKILL.md files
 * (moved to their re-redacted names), the scenario manifest (keys re-mapped) and the report.
 * Refuses to write if the leak scan finds anything. Goldens must be regenerated afterwards.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { FixtureRedactor, scanLeaks } = require('./lib/fixture-redact');
const { redactCliText, scrambleMarkdown } = require('./capture-fixtures');

// --fixtures <dir>: the fixtures root to read AND write (default test/fixtures). Lets a pass run on a
// backup tree (e.g. to re-derive from an earlier redaction with a corrected rule) before copying back.
const fixArg = process.argv.indexOf('--fixtures');
const { assertLocal, LOCAL_FIXTURES } = require('./lib/local-roots');
const FIX = fixArg > 0 ? path.resolve(process.argv[fixArg + 1]) : LOCAL_FIXTURES;   // captures are local-only
// R8-03: refuse any root outside test/fixtures/local (by real path), before reading or writing anything
try { assertLocal(FIX); } catch (e) { console.error(e.message); process.exit(2); }

function main() {
  const args = process.argv.slice(2);
  const name = args[args.indexOf('--scenario') + 1];
  const dry = args.includes('--dry-run');
  if (!name || args.indexOf('--scenario') < 0) { console.error('usage: --scenario <name> [--fixtures <dir>] [--dry-run]'); process.exit(2); }
  const manifestFile = path.join(FIX, 'scenarios', name + '.json');
  const sc = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  if (sc.origin !== 'capture') { console.error('only captured scenarios are re-redacted'); process.exit(2); }

  const red = new FixtureRedactor({ salt: crypto.createHash('sha256').update('agent-office/re-redact/v1/' + name).digest(), timeShiftMs: 0, assumeRedacted: process.argv.includes('--already-redacted') });
  const out = new Map();           // rel path → content
  const remove = new Set();        // rel paths to delete (moved skill files)
  const read = (rel) => JSON.parse(fs.readFileSync(path.join(FIX, rel), 'utf8'));
  const put = (rel, obj) => out.set(rel, typeof obj === 'string' ? red.sweepString(obj) : JSON.stringify(red.sweep(obj), null, 2) + '\n');

  const skillName = (n) => red.redact(n, '$', 'name');
  function envelope(rel, opts = {}) {
    const f = read(rel);
    if (f.$fixture.params) f.$fixture.params = red.redact(f.$fixture.params, '$params');
    const b = f.body;
    if (b.kind === 'json') b.value = red.redact(b.value);
    else if (b.kind === 'text') b.value = redactCliText(red, b.value, opts.post);
    else if (b.kind === 'error') b.message = red.text(b.message || '');
    f.$fixture.redaction = 'R1-02 default-deny (re-redacted from the original capture files, no recapture)';
    put(rel, f);
  }

  // 1. skills list first (learns which names are public)
  if (sc.cli && sc.cli['skills.list']) envelope(sc.cli['skills.list']);
  // 2. skill details + their SKILL.md files, re-keyed by the re-redacted name
  const infos = {};
  for (const [oldName, rel] of Object.entries((sc.cli && sc.cli['skills.info']) || {})) {
    const newName = skillName(oldName);
    const placeholder = `{{FIXTURES_DIR}}/files/skills/${newName}/SKILL.md`;
    envelope(rel, { post: (json) => { if (json && typeof json === 'object' && typeof json.filePath === 'string') json.filePath = placeholder; } });
    infos[newName] = rel;
    const oldMd = path.join('files', 'skills', oldName, 'SKILL.md');
    if (fs.existsSync(path.join(FIX, oldMd))) {
      put(path.join('files', 'skills', newName, 'SKILL.md'), scrambleMarkdown(red, fs.readFileSync(path.join(FIX, oldMd), 'utf8')));
      if (newName !== oldName) remove.add(oldMd);
    }
  }
  // 3. everything else
  const helloRel = path.join('gw', 'hello', sc.openclawVersion, name + '.json');
  if (fs.existsSync(path.join(FIX, helloRel))) envelope(helloRel);
  const rpc = {};
  for (const [method, spec] of Object.entries(sc.rpc || {})) {
    if (typeof spec === 'string') { envelope(spec); rpc[method] = spec; continue; }
    const files = {};
    for (const [k, rel] of Object.entries(spec.files)) { envelope(rel); files[spec.param === 'key' ? red.redact(k, '$', 'key') : red.redact(k, '$', 'id')] = rel; }
    rpc[method] = Object.assign({}, spec, { files });
  }
  for (const rel of new Set([...((sc.events && sc.events.observed) || []), ...((sc.events && sc.events.onConnect) || [])])) envelope(rel);
  if (sc.host && sc.host.df) envelope(sc.host.df);

  const manifest = Object.assign({}, sc, { rpc, cli: Object.assign({}, sc.cli, { 'skills.info': infos }),
    notes: (sc.notes || []).filter((n) => !/re-redacted/.test(n)).concat(['Re-redacted with the R1-02 default-deny policy (scripts/re-redact-fixtures.js); no live recapture.']) });
  put(path.join('scenarios', name + '.json'), manifest);

  // 4. scan everything, including the new report
  const leaks = [];
  for (const [rel, content] of out) leaks.push(...scanLeaks(content, rel));
  let report = red.reportMarkdown(name + ' (re-redacted)', leaks);
  leaks.push(...scanLeaks(report, 'report'));
  if (leaks.length) report = red.reportMarkdown(name + ' (re-redacted)', leaks, { minimal: true });
  out.set(path.join('captures', name + '.report.md'), report);
  console.log(report);
  if (leaks.length) { console.error(`${leaks.length} possible leak(s): nothing written`); process.exit(1); }
  if (dry) { console.error(`dry run: ${out.size} files would be written, ${remove.size} removed`); return; }
  for (const rel of [...out.keys(), ...remove]) assertLocal(path.join(FIX, rel));   // every file, whatever its name (R8-03)
  for (const [rel, content] of out) { fs.mkdirSync(path.dirname(path.join(FIX, rel)), { recursive: true }); fs.writeFileSync(path.join(FIX, rel), content); }
  for (const rel of remove) { fs.rmSync(path.join(FIX, rel)); try { fs.rmdirSync(path.dirname(path.join(FIX, rel))); } catch (_) {} }
  console.error(`wrote ${out.size} files, removed ${remove.size}`);
}

main();
