'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { safeExternalUrl } = require('../../public/v2/url-policy.js');
const { allowed, rejected } = require('../helpers/external-url-cases');
const { normaliseSkills, normaliseSkillInfo } = require('../../src/adapters/openclaw/normalise/skill');
const { buildSkillDetailVM } = require('../../src/api/v2/vm/skills');
const { Skill, SkillInfo } = require('../../src/engine/model/canonical');
const { SkillDetailVM } = require('../../src/api/v2/vm/schemas');
const { validate } = require('../../src/schema');
const { validateVM } = require('../../public/v2/generated/vm-schemas.js');
const raw = { name: 'inert', source: 'openclaw-bundled', eligible: true };
const issue = () => { throw new Error('Unexpected normalization issue'); };
const list = (homepage) => normaliseSkills({ skills: [{ ...raw, homepage }] }, issue)[0];
const info = (homepage) => normaliseSkillInfo({ ...raw, homepage }, issue);
const vm = (skill, detail = null) => buildSkillDetailVM(skill, detail, null, false);

test('shared policy: canonical HTTP(S), bounded before and after normalization; all refused values return null', () => {
  for (const [input, expected] of allowed) {
    assert.equal(safeExternalUrl(input), expected);
    assert.equal(safeExternalUrl(expected), expected, 'idempotent');
  }
  for (const input of rejected) assert.equal(safeExternalUrl(input), null, JSON.stringify(input));
});

test('list/info adapter normalization and independent VM boundary enforce the same URL policy', () => {
  for (const [input, expected] of [...allowed, ...rejected.map((x) => [x, null])]) {
    const skill = list(input), detail = info(input);
    assert.equal(skill.homepage, expected);
    assert.equal(detail.homepage, expected);
    assert.equal(validate(Skill, skill).ok, true);
    assert.equal(validate(SkillInfo, detail).ok, true);
    assert.equal(vm(skill, detail).skill.homepage, expected);
    // A foreign adapter that skips normalization still cannot put a refused URL in the VM.
    assert.equal(vm({ ...list(null), homepage: input }).skill.homepage, expected);
    assert.equal(vm(list(null), { ...info(null), homepage: input }).skill.homepage, expected);
  }
  const fallback = 'https://example.invalid/info';
  assert.equal(vm({ ...list(null), homepage: 'javascript:inert' }, info(fallback)).skill.homepage, fallback);
  assert.equal(vm(list('http://example.invalid/list'), info(fallback)).skill.homepage, 'http://example.invalid/list');
  assert.equal(buildSkillDetailVM(null, null, null, false), null);
});

test('canonical and v2/v3 VM schemas reject raw unsafe/noncanonical URLs; browser and server agree', () => {
  for (const [input, expected] of [...allowed, ...rejected.map((x) => [x, null])]) {
    const rawSkill = { ...list(null), homepage: input };
    const rawInfo = { ...info(null), homepage: input };
    const rawVm = { ...vm(list(null)), skill: { ...vm(list(null)).skill, homepage: input } };
    const admitted = input === null || (expected !== null && input === expected);
    assert.equal(validate(Skill, rawSkill).ok, admitted);
    assert.equal(validate(SkillInfo, rawInfo).ok, admitted);
    assert.equal(validate(SkillDetailVM, rawVm).ok, admitted);
    for (const version of [2, 3]) assert.equal(validateVM('skill', rawVm, version).ok, admitted);
    const normalized = vm(list(input), info(input));
    assert.equal(validate(SkillDetailVM, normalized).ok, true);
    for (const version of [2, 3]) assert.equal(validateVM('skill', normalized, version).ok, true);
  }
});
