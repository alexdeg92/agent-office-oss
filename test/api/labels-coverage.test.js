'use strict';
// S6.1: every key the server can emit has a French label in GET /api/v2/meta (the UI never shows a raw key).
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { LABELS, ENUMS } = require('../../src/i18n/fr');
const { CODES } = require('../../src/engine/quarantine');
const { ERROR_CATEGORIES } = require('../../src/engine/redact');
const { SOURCE_ERROR_CATEGORIES } = require('../../src/projects/constants');

const missing = (keys) => keys.filter((k) => !LABELS[k]);

describe('labels coverage (MetaVM.labels)', () => {
  it('sources, issue codes, source errors, severities and states', () => {
    const sources = ['gateway', 'cli', 'config', 'host', 'discord', 'github', 'store', 'engine'];
    const categories = new Set(ERROR_CATEGORIES.map(([, c]) => c).concat(['error', 'invalid-output', 'not-ok', 'payload-rejected', 'killed-or-timeout', 'not-connected', 'invalid-json'], SOURCE_ERROR_CATEGORIES));
    assert.deepEqual(missing(sources.map((s) => 'source.' + s)), []);
    assert.deepEqual(missing([...CODES].map((c) => 'issueCode.' + c)), []);
    assert.deepEqual(missing([...categories].map((c) => 'sourceError.' + c)), []);
    assert.deepEqual(missing(['error', 'warn', 'info'].map((s) => 'issueSeverity.' + s).concat(['open', 'resolved', 'muted'].map((s) => 'issueState.' + s))), []);
  });

  it('channels (canonical ids), channel health, health cards and every healthValue/healthSub key the builder uses', () => {
    const ids = ['discord', 'whatsapp', 'wechat'];   // canonical ChannelId (2.2), 'unrecognized' shows the source label
    assert.deepEqual(missing(ids.map((c) => 'channel.' + c)), []);
    assert.deepEqual(missing(['connected', 'running', 'stopped', 'error', 'not-configured'].map((h) => 'channelHealth.' + h)), []);
    assert.deepEqual(missing(['gateway', 'cpu', 'memory', 'disk', 'event-loop', 'uptime', 'cron', 'plugins'].map((c) => 'healthCard.' + c)), []);
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'api', 'v2', 'vm', 'health.js'), 'utf8');
    const used = [...new Set(src.match(/'(healthValue|healthSub)\.[A-Za-z-]+'/g).map((x) => x.slice(1, -1)))];
    assert.ok(used.length > 10);
    assert.deepEqual(missing(used), []);
  });

  it('every member of every served enum has a label in its namespace', () => {
    const gaps = [];
    for (const [ns, members] of Object.entries(ENUMS)) for (const m of members) if (!LABELS[ns + '.' + m]) gaps.push(ns + '.' + m);
    assert.deepEqual(gaps, []);
  });
});
