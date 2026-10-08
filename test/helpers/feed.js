'use strict';
// Feed every fixture of a scenario through an engine, in a fixed order, as RawEnvelopes.
const fs = require('fs');
const path = require('path');
const { FIXTURES_DIR, readFixture } = require('./scenario');

function envelopesOf(sc) {
  const out = [];
  const root = sc.fixturesDir || FIXTURES_DIR;
  const add = (rel, key) => { const f = readFixture(rel, root); out.push({ source: f.$fixture.source, channel: f.$fixture.channel, receivedAt: sc.now, context: { key }, body: f.body }); };
  const hello = path.join('gw', 'hello', sc.openclawVersion, sc.name + '.json');
  if (fs.existsSync(path.join(root, hello))) add(hello);
  for (const [method, spec] of Object.entries(sc.rpc || {})) {
    if (typeof spec === 'string') add(spec);
    else for (const [k, rel] of Object.entries(spec.files)) add(rel, k);
  }
  for (const rel of (sc.events && (sc.events.observed || sc.events.onConnect)) || []) add(rel);
  if (sc.cli && sc.cli['skills.list']) add(sc.cli['skills.list']);
  for (const [k, rel] of Object.entries((sc.cli && sc.cli['skills.info']) || {})) add(rel, k);
  return out;
}

function feed(engine, sc) {
  const hello = envelopesOf(sc).find((e) => e.channel === 'gw.hello');
  engine.setOpenclawVersion(hello ? hello.body.value.server.version : sc.openclawVersion);
  for (const env of envelopesOf(sc)) engine.ingest(env);
  return engine;
}

module.exports = { envelopesOf, feed };
