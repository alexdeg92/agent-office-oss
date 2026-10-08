'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { FixtureRedactor, scanLeaks } = require('../../scripts/lib/fixture-redact');

const SEEDED = {
  token: 'SECRET-gateway-token-value',
  cfg: { channels: { discord: { token: ['MTAxMjM0NTY3ODkwMTIzNDU2', 'Gabcde', 'abcdefghijklmnopqrstuvwxyz0123456'].join('.') } } },
  device: { privateKeyPem: ['-----BEGIN', 'PRIVATE KEY-----'].join(' ') + '\nMC4CAQAwBQYDK2VwBCIEIA\n' + ['-----END', 'PRIVATE KEY-----'].join(' ') },
  auth: { authorization: 'Bearer abc' },
  note: 'Bot MTAxMjM0NTY3ODkwMTIzNDU2Nzg5MA.abcdef.ghijklmnop',
  apiKey: 'sk-ant-REDACTME0123456789abcdef',
  people: [{ username: 'example-user', globalName: 'Example Owner', email: 'Owner@example.invalid', id: '100000789012345678' }],
  sessions: [{ key: 'agent:main:discord:channel:100000789012345678', sessionId: '0b9c6a2e-1f2d-4c3b-9a8e-112233445566', updatedAt: 1791200000000, totalTokens: 12345 }],
  text: 'Call me at +15145551234 or see https://private.example.ca/path?x=1, workspace /home/example/notes',
};

describe('FixtureRedactor', () => {
  it('removes every seeded secret and personal value', () => {
    const r = new FixtureRedactor();
    const out = JSON.stringify(r.redact(SEEDED));
    for (const needle of ['SECRET-gateway', 'MTAxMjM0', 'BEGIN PRIVATE', 'Bearer abc', 'sk-ant', 'example-user', 'Example Owner', 'Owner@example.invalid', '100000789012345678',
      '0b9c6a2e', '5145551234', 'private.example.ca', '/home/example']) {
      assert.ok(!out.includes(needle), 'leaked: ' + needle);
    }
    assert.deepEqual(scanLeaks(out, 'x'), []);
  });

  it('keeps session-key structure and maps the same raw id to the same fake', () => {
    const r = new FixtureRedactor();
    const a = r.redact({ key: 'agent:main:cron:0b9c6a2e-1f2d-4c3b-9a8e-112233445566' });
    const b = r.redact({ id: '0b9c6a2e-1f2d-4c3b-9a8e-112233445566' });
    assert.match(a.key, /^agent:main:cron:ffffffff-/);
    assert.equal(a.key.split(':')[3], b.id);
    assert.equal(r.redact({ key: 'agent:main:main' }).key, 'agent:main:main');
  });

  it('keeps enum, slug and cron values verbatim and lists them in the report', () => {
    const r = new FixtureRedactor();
    const out = r.redact({ status: 'running', name: 'web_search', schedule: { kind: 'cron', expr: '0 9 * * 1', tz: 'America/Toronto' }, description: 'Texte libre' });
    assert.equal(out.status, 'running'); assert.equal(out.name, 'web_search'); assert.equal(out.schedule.expr, '0 9 * * 1');
    assert.notEqual(out.description, 'Texte libre');
    const md = r.reportMarkdown('t', []);
    assert.match(md, /enum:status\*\*: `running`/); assert.match(md, /tool:name\*\*: `web_search`/);
  });

  it('scrambles free text but keeps list numbering and SHOUTY: headings', () => {
    const r = new FixtureRedactor();
    const s = r.scrambleText('1. Cherche les prix\n2. Résume\nRAPPORT: court');
    assert.match(s, /^1\. \S+ \S+ \S+\n2\. \S+\n[A-Z]+: \S+$/);
    assert.ok(!s.includes('Cherche'));
  });

  it('shifts timestamps and rounds token counts', () => {
    const r = new FixtureRedactor({ timeShiftMs: -86400000 });
    assert.deepEqual(r.redact({ updatedAt: 1791200000000, totalTokens: 12345, durationMs: 4000 }), { updatedAt: 1791200000000 - 86400000, totalTokens: 12300, durationMs: 4000 });
  });

  it('scanLeaks flags real-looking ids and known secret values without echoing them', () => {
    // Invented non-fake shape: the scanner intentionally allows the generator's 100000 prefix.
    const id = '234567' + '890123456789';
    const leaks = scanLeaks(JSON.stringify({ id, t: 'hunter2-secret' }), 'f', ['hunter2-secret']);
    assert.deepEqual(leaks.map((l) => l.rule).sort(), ['known-secret-value', 'snowflake-not-fake']);
    assert.ok(!JSON.stringify(leaks).includes('hunter2'));
  });
});

// Patterns found by the first live capture (PM, designer-02 review). Values are synthetic, shapes mirror the real keys.
// Under the PM privacy rule, undeclared field names are hashed, so these tests assert on VALUES
// (all string/number leaves), wherever they ended up.
const leaves = (v, out = []) => { if (v && typeof v === 'object') Object.values(v).forEach((x) => leaves(x, out)); else out.push(v); return out; };
const strs = (v) => leaves(v).filter((x) => typeof x === 'string');

describe('FixtureRedactor · live-capture patterns', () => {
  const SF = '100000789012345678', SF2 = '100000789012345679';
  const B64 = Buffer.from('x'.repeat(300)).toString('base64');                       // 400 chars, 300 bytes
  const HEX64 = 'a3f1c2d4e5b6978877665544332211aabbccddeeff00112233445566778899aa';
  const B64HASH = 'sha256:Qm9ndXNIYXNoVmFsdWUxMjM0NTY3ODkwQUJDREVGR0hJSktMTU5PUA==';
  const raw = {
    hello: { appliedConfigHash: B64HASH, recoveryScope: 'rs_9fK2mQ7xL0pZ4vB8nC1dE6hJ3tY5wR2u' },
    sessionsList: { sessions: [{ key: `agent:main:discord:channel:${SF}`, to: `channel:${SF}`, from: `discord:${SF2}`, lastTo: `channel:${SF}`,
      label: `Discord #${SF} (guild ${SF2})`, displayName: `Discord user ${SF2}`, channelAvatarUrl: `https://cdn.discordapp.com/icons/${SF}/a_1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e.png?size=128` }] },
    sessionsUsage: { sessions: [{ key: `agent:main:discord:channel:${SF}#thread`, label: `#${SF}`, to: SF, totalCost: 0.12345678901234568, outputCost: 0.000123456789012345,
      cost: 1.0000000000000002, cacheReadCost: 3.3333333333333335e-7, inputCost: 0.1 }] },
    sessionsGet: { messages: [
      { role: 'user', idempotencyKey: `discord:${SF}:msg:${SF2}`, content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: B64 } },
        { type: 'image', source: `data:image/jpeg;base64,${B64}` },
        { type: 'file', fileName: `${SF}_report.pdf`, path: `/srv/media/${SF}/${SF2}.png`, url: `https://media.discordapp.net/attachments/${SF}/${SF2}/photo.png?ex=abc` },
        { type: 'text', text: 'voir pièce jointe', unknownBlob: 'Zm9vYmFyYmF6' + B64.slice(0, 80), image: `attachment://${SF}.png`, task: `Analyse ${SF}` },
      ] },
    ] },
    cronRuns: { entries: [{ error: `Channel ${SF} not found`, summary: `Posted in <#${SF}>`, message: `ok ${SF2}` }] },
    cronList: { configRevision: HEX64, jobs: [{ label: `#${SF}`, to: `channel:${SF}`, payload: { message: `Use token ${B64HASH.slice(7)} then post to <#${SF}>` } }] },
  };
  const r = new FixtureRedactor();
  const out = Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, r.redact(v)]));   // one redactor: shared id map
  const text = JSON.stringify(out);

  it('leaves nothing the leak scanner flags', () => { assert.deepEqual(scanLeaks(text, 'live-patterns'), []); });

  it('fakes every snowflake inside strings with the shared id map', () => {
    assert.ok(!text.includes(SF) && !text.includes(SF2));
    const fake = r.fakeId(SF), fake2 = r.fakeId(SF2);
    assert.equal(out.sessionsList.sessions[0].key, `agent:main:discord:channel:${fake}`);
    const all = strs(out);
    assert.ok(all.filter((x) => x.includes(fake)).length >= 8, 'every SF occurrence uses the same fake');
    assert.ok(all.filter((x) => x.includes(fake2)).length >= 4);
    assert.ok(all.some((x) => x.includes(fake) && x.includes(fake2)), 'composite values keep both fakes');
  });

  it('keeps URL structure: allowlisted host, route words, faked ids, extension; drops the query', () => {
    const all = strs(out);
    assert.ok(all.some((x) => new RegExp(`^https://cdn\\.discordapp\\.com/icons/${r.fakeId(SF)}/[0-9a-f]{8}\\.png$`).test(x)));
    assert.ok(all.some((x) => new RegExp(`^https://media\\.discordapp\\.net/attachments/${r.fakeId(SF)}/${r.fakeId(SF2)}/[0-9a-f]{8}\\.png$`).test(x)));   // file names are user data
    assert.ok(all.some((x) => x.startsWith('/') && x.includes(r.fakeId(SF))), 'paths keep their faked ids');
  });

  it('replaces base64 payloads with a placeholder keeping media type and byte length', () => {
    const all = strs(out);
    assert.ok(all.includes('[base64 image/png 300 bytes]'));
    assert.ok(all.includes('image/png'));
    assert.ok(all.includes('data:image/jpeg;base64,[base64 image/jpeg 300 bytes]'));
    assert.ok(!text.includes(B64.slice(0, 40)));
  });

  it('replaces hashes with fakes of the same length', () => {
    assert.equal(out.cronList.configRevision.length, HEX64.length);   // configRevision is a declared name
    assert.match(out.cronList.configRevision, /^00000000[0-9a-f]+$/);
    assert.ok(strs(out.hello).some((x) => /^sha256:00000000[0-9a-f]+$/.test(x) && x.length === B64HASH.length));
    assert.ok(!text.includes('9fK2mQ7xL0pZ4vB8nC1dE6hJ3tY5wR2u'));
    assert.ok(!text.includes(B64HASH.slice(7, 30)));
  });

  it('rounds costs to 4 decimals (whatever the key became)', () => {
    const nums = leaves(out.sessionsUsage).filter((x) => typeof x === 'number');
    for (const n of [0.1235, 0.0001, 1, 0, 0.1]) assert.ok(nums.includes(n), String(n));
  });
});

// Second live-capture round (PM, designer-03 review): generic final sweep over every string and number.
describe('FixtureRedactor · final sweep', () => {
  const SF = '100000789012345678';

  it('fakes ids in prefixed keys, relative paths, JSON embedded in text, and big numbers', () => {
    const r = new FixtureRedactor();
    const out = r.redact({
      idempotencyKey: `a-abcdefghi:${SF}`,
      avatar: `/avatars/user/${SF}.`,
      content: [{ type: 'text', text: `Résultat : {\\"userId\\": \\"${SF}\\", \\"n\\": 1}` }],
      hello: { capabilities: 100000789012345680, nested: [{ deep: { x: `k:${SF}:v` } }] },
      [`map-${SF}`]: true,
    });
    const text = JSON.stringify(out);
    assert.ok(!text.includes(SF) && !text.includes('10000078901234568'), text);
    assert.deepEqual(scanLeaks(text, 'sweep'), []);
    const fake = r.fakeId(SF);
    assert.ok(out.idempotencyKey.endsWith(':' + fake), out.idempotencyKey);
    const all = strs(out);
    assert.ok(all.some((x) => x.startsWith('/') && x.includes(fake)), 'relative path');
    assert.ok(out.content[0].text.includes(fake), out.content[0].text);
    assert.ok(all.some((x) => x.includes(':' + fake + ':')), 'composite value');
    assert.ok(leaves(out).some((x) => typeof x === 'number' && String(x).startsWith('100000')), 'big number faked');
  });

  it('leaves our own fakes alone when they pass through again', () => {
    const r = new FixtureRedactor();
    const fake = r.fakeId(SF);
    assert.ok(r.text(`id ${fake} again`).includes(fake));
    assert.ok(r.redact({ lastTo: `channel:${fake}`, n: Number(fake) }).lastTo.endsWith(':' + fake));
  });

  it('sweeps digit runs that appear by chance inside generated hex', () => {
    const r = new FixtureRedactor();
    assert.equal(r.text('x 00000000123456789 y').includes('00000000123456789'), false);
    assert.deepEqual(scanLeaks(JSON.stringify(r.redact({ v: '0000000012345678901' })), 's'), []);
  });

  // Live samples vary and fakes depend on a random salt, so check many salts, not one.
  it('is clean for any salt (300 random runs over a mixed payload)', () => {
    const B64 = Buffer.from('y'.repeat(120)).toString('base64');
    const payload = {
      sessions: Array.from({ length: 20 }, (_, i) => ({
        key: `agent:main:discord:channel:${BigInt(SF) + BigInt(i)}`, sessionId: '0b9c6a2e-1f2d-4c3b-9a8e-1122334455' + String(10 + i),
        label: `#${BigInt(SF) + BigInt(i * 7)}`, avatar: `/icons/${BigInt(SF) + BigInt(i)}/a_${'f00d'.repeat(8)}.png`,
        configRevision: ('ab12' + i).repeat(10).slice(0, 40), cost: 0.1234567890123456 * i, big: 1e17 + i * 1e3,
        text: `{"id":"${BigInt(SF) * 3n + BigInt(i)}","tok":"${B64.slice(i, i + 40)}9"}`, idempotencyKey: `x-abcdefghi:${BigInt(SF) + 99n}`,
      })),
    };
    for (let i = 0; i < 300; i++) {
      const r = new FixtureRedactor();
      const leaks = scanLeaks(JSON.stringify(r.redact(payload)) + r.text('see 222222222222222222 and 00000000a1'), 'salt-' + i);
      assert.deepEqual(leaks, [], 'run ' + i);
    }
  });
});

describe('FixtureRedactor · protocol vocabulary', () => {
  it('keeps vocabulary values under declared names, shifts ISO dates, scrambles free text', () => {
    const r = new FixtureRedactor({ timeShiftMs: -86400000 });
    const out = r.redact({
      features: { events: ['session.tool', 'sessions.changed', 'tick'], methods: ['sessions.list', 'cron.runs'], capabilities: ['tools'] },
      mainKey: 'agent:main:main',
      sessions: [{ classification: 'direct', peerKind: 'group', subagentRunState: 'running', category: 'Projet Client', chatType: 'channel' }],
      jobs: [{ schedule: { kind: 'at', at: '2026-10-06T13:00:00.000Z' }, lastRunStatus: 'error', description: 'texte libre' }],
    });
    assert.deepEqual(out.features.events, ['session.tool', 'sessions.changed', 'tick']);
    assert.deepEqual(out.features.methods, ['sessions.list', 'cron.runs']);
    assert.equal(out.mainKey, 'agent:main:main');
    assert.equal(out.sessions[0].classification, 'direct'); assert.equal(out.sessions[0].subagentRunState, 'running'); assert.equal(out.sessions[0].peerKind, 'group');
    assert.notEqual(out.sessions[0].category, 'Projet Client');
    assert.equal(out.jobs[0].schedule.at, '2026-10-05T13:00:00.000Z');
    assert.equal(out.jobs[0].lastRunStatus, 'error');
    assert.notEqual(out.jobs[0].description, 'texte libre');
    assert.deepEqual(scanLeaks(JSON.stringify(out), 'vocab'), []);
  });
});

describe('FixtureRedactor · object keys (PM rule)', () => {
  it('declared names kept (even long ones); undeclared names and id-like keys replaced; channel ids kept as map keys', () => {
    const r = new FixtureRedactor();
    const out = r.redact({ lastFailureNotificationDeliveryStatus: 1, veryLongProtocolFieldNameWithoutAnyDigits: 1, a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7: 2, 100000789012345678: 3, discord: 4 });
    assert.ok('lastFailureNotificationDeliveryStatus' in out && 'discord' in out);
    for (const k of ['veryLongProtocolFieldNameWithoutAnyDigits', 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7', '100000789012345678']) assert.ok(!(k in out), k);
  });
});

describe('FixtureRedactor · R5 reviewer seeds (PM rule)', () => {
  it("{status:'private-client', model:'alice-private-model', map:{privateclient:1}} → none survive, nor in the report", () => {
    const r = new FixtureRedactor();
    const out = r.redact({ status: 'private-client', model: 'alice-private-model', map: { privateclient: 1 }, provider: 'acme-llm' });
    const md = r.reportMarkdown('seeds', []);
    for (const needle of ['private-client', 'alice-private-model', 'privateclient', 'acme-llm']) {
      assert.ok(!JSON.stringify(out).includes(needle), needle);
      assert.ok(!md.includes(needle), 'report: ' + needle);
    }
    const ok = r.redact({ status: 'active', model: 'gpt-5.5', provider: 'openai' });
    assert.deepEqual(ok, { status: 'active', model: 'gpt-5.5', provider: 'openai' });
  });
});

// R1-02: default-deny for identities. Assertions use fixed needles, never scanLeaks (which shares
// assumptions with the redactor).
describe('FixtureRedactor · seeded identities (R1-02)', () => {
  const NEEDLES = ['private-client', 'alice-case-1234', 'Alice', 'alice', 'owes', 'privateclient', 'merger', 'confidential', 'model-test-9544',
    'clientx', 'acme-billing', 'Projet Lune', 'tremblay', 'my-secret-agent'];
  const found = (text) => NEEDLES.filter((n) => text.toLowerCase().includes(n.toLowerCase()));

  it("reviewer's reproduction no longer survives", () => {
    const r = new FixtureRedactor();
    const out = r.redact({ name: 'private-client', sessionId: 'alice-case-1234', reason: 'Alice owes 90 dollars', url: 'https://github.com/privateclient/merger', map: { 'Alice confidential note': 1 } });
    assert.deepEqual(found(JSON.stringify(out)), [], JSON.stringify(out));
    assert.ok(strs(out).some((x) => /^https:\/\/github\.com\/[0-9a-f]{8}\/[0-9a-f]{8}$/.test(x)), 'URL keeps its structure (url is undeclared, so its key is hashed)');
  });

  it('every id is faked except protocol ids; session-key segments only from the grammar', () => {
    const r = new FixtureRedactor();
    const out = r.redact({
      sessions: [{ key: 'agent:main:explicit:model-test-9544', sessionId: 'model-test-9544', agentId: 'my-secret-agent', accountId: 'default' },
        { key: 'agent:my-secret-agent:acp:clientx', agentId: 'main' }],
    });
    const t = JSON.stringify(out);
    assert.deepEqual(found(t), [], t);
    assert.match(out.sessions[0].key, /^agent:main:explicit:id_[0-9a-f]+$/);
    assert.equal(out.sessions[0].accountId, 'default'); assert.equal(out.sessions[1].agentId, 'main');
    assert.match(out.sessions[1].key, /^agent:id_[0-9a-f]+:acp:id_[0-9a-f]+$/);
    assert.equal(out.sessions[1].key.split(':')[1], r.fakeId('my-secret-agent'), 'same fake as the agentId elsewhere');
  });

  it('custom skills, job names and their requirements are faked; public skills and built-in tools are kept', () => {
    const r = new FixtureRedactor();
    const list = r.redact({ skills: [
      { name: 'weather', source: 'openclaw-bundled', bins: ['curl'] },
      { name: 'acme-billing', source: 'openclaw-workspace', bins: ['clientx-cli'], skillKey: 'acme-billing' },
    ] });
    const info = r.redact({ name: 'weather', source: 'openclaw-bundled' }, '$', '');
    const custom = r.redact('acme-billing', '$', 'name');
    const jobs = r.redact({ jobs: [{ id: 'job-1', name: 'clientx-weekly-report', displayName: 'Projet Lune' }], messages: [{ toolName: 'web_search' }, { toolName: 'clientx_crm_lookup' }] });
    const t = JSON.stringify([list, info, custom, jobs]);
    assert.deepEqual(found(t), [], t);
    assert.equal(list.skills[0].name, 'weather'); assert.deepEqual(list.skills[0].bins, ['curl']); assert.equal(info.name, 'weather');
    assert.equal(list.skills[1].name, custom, 'custom skill faked consistently');
    assert.equal(jobs.messages[0].toolName, 'web_search');
    assert.notEqual(jobs.messages[1].toolName, 'clientx_crm_lookup');
  });

  it('enum keys keep only strict tokens; free-text keys like reason/domain are scrambled', () => {
    const r = new FixtureRedactor();
    const out = r.redact({ status: 'Alice owes', kind: 'direct', reason: 'tremblay', domain: 'clientx.ca', version: '2026.9.8', tz: 'America/Toronto', expr: 'Projet Lune' });
    assert.equal(out.kind, 'direct'); assert.equal(out.version, '2026.9.8'); assert.equal(out.tz, 'America/Toronto');
    assert.deepEqual(found(JSON.stringify(out)), [], JSON.stringify(out));
  });

  it('dynamic object keys: ids faked, free-text keys hashed, identifier field names kept', () => {
    const r = new FixtureRedactor();
    const out = r.redact({ 'Alice confidential note': 1, 'clientx.ca': 2, 'claude-cli/model': 3, lastFailureNotificationDeliveryStatus: 4, 'openclaw-weixin': 5 });
    assert.deepEqual(found(JSON.stringify(out)), []);
    assert.ok('lastFailureNotificationDeliveryStatus' in out && 'openclaw-weixin' in out);
  });

  it('the report never contains seeded values (it is scanned too)', () => {
    const r = new FixtureRedactor();
    r.redact({ name: 'acme-billing', sessionId: 'alice-case-1234', reason: 'Alice owes', token: 'clientx-secret-token-1234567890', 'Alice key': { password: 'x' } });
    const md = r.reportMarkdown('t', []);
    assert.deepEqual(found(md), [], md);
  });
});

describe('FixtureRedactor · camelCase protocol tokens (S4 fix)', () => {
  it('keeps camelCase enum values (agentTurn, toolCall, toolResult, toolUse) but not free text', () => {
    const r = new FixtureRedactor();
    const out = r.redact({ payload: { kind: 'agentTurn' }, content: [{ type: 'toolCall' }], role: 'toolResult', stopReason: 'toolUse', status: 'Alice owes', kind: 'AliceCorp' });
    assert.deepEqual([out.payload.kind, out.content[0].type, out.role, out.stopReason], ['agentTurn', 'toolCall', 'toolResult', 'toolUse']);
    assert.notEqual(out.status, 'Alice owes'); assert.notEqual(out.kind, 'AliceCorp');
  });
});

describe('FixtureRedactor · R6 (S4.1)', () => {
  it('R6-03: secret fields are removed whatever their leaf type; status fields are not secrets', () => {
    const r = new FixtureRedactor();
    const out = r.redact({ password: 12345678, apiKey: 987654321, token: true, tokenStatus: 'ok', totalTokens: 1200 });
    const t = JSON.stringify(out);
    for (const n of ['12345678', '987654321']) assert.ok(!t.includes(n), n);
    assert.deepEqual(leaves(out).filter((x) => x === '[redacted]').length, 3);
    assert.notEqual(out.tokenStatus, '[redacted]', 'a status field is not a secret'); assert.ok(leaves(out).includes(1200));
  });

  it('R6-02: only exact reviewed model ids survive; family-prefixed private names are faked, in output and report', () => {
    const r = new FixtureRedactor();
    const out = r.redact({ sessions: [{ model: 'gpt-private-client-merger' }, { model: 'openai/gpt-5.5' }, { model: 'claude-acme-finetune' }] });
    const t = JSON.stringify(out), md = r.reportMarkdown('r6', []);
    for (const n of ['gpt-private-client-merger', 'claude-acme-finetune', 'private-client', 'acme']) { assert.ok(!t.includes(n), n); assert.ok(!md.includes(n), 'report: ' + n); }
    assert.equal(out.sessions[1].model, 'openai/gpt-5.5');
  });
});
