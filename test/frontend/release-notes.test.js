import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { CURRENT_RELEASE } from '../../public/v2/release-current.js';
import { hasNewRelease, hasUnseenRelease, markCurrentReleaseSeen, onReleaseSeen, releaseUserKey } from '../../public/v2/release-notes.js';

const require = createRequire(import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('../../public/v2/releases.json', import.meta.url), 'utf8'));
const packageVersion = require('../../package.json').version;

test('release notes cover the running application version and the newest deploy tag', () => {
  assert.equal(manifest.appVersion, packageVersion);
  assert.ok(manifest.releases.some((release) => release.version === packageVersion), 'running package version has a release entry');
  assert.deepEqual(manifest.current, CURRENT_RELEASE);
  assert.equal(manifest.releases[0].tag, CURRENT_RELEASE.tag);
  assert.equal(manifest.releases[0].sequence, CURRENT_RELEASE.sequence);
  assert.deepEqual(manifest.releases.map((release) => release.sequence), manifest.releases.map((release) => release.sequence).sort((a, b) => b - a));
  assert.equal(new Set(manifest.releases.map((release) => release.tag)).size, manifest.releases.length);
  for (const release of manifest.releases) {
    assert.match(release.date, /^2026-10-(10|11)$/);
    assert.match(release.time, /^\d{2}:\d{2}$/);
    assert.ok(release.title.fr && release.title.en, release.tag + ' has a localized title');
    assert.ok(release.fr.length && release.en.length, release.tag + ' has French and English bullets');
  }
  assert.equal(new Set(manifest.releases.map((release) => release.title.fr)).size, manifest.releases.length, 'each deploy has a distinct French title');
  assert.equal(new Set(manifest.releases.map((release) => release.title.en)).size, manifest.releases.length, 'each deploy has a distinct English title');
  for (const tag of [
    'deploy-20261010-2037', 'deploy-20261010-2148', 'deploy-20261010-2159', 'deploy-20261010-2215-office',
    'deploy-20261010-2248-store', 'deploy-20261010-2254-names', 'deploy-20261010-2303-themes', 'deploy-20261010-2349-health',
    'deploy-20261010-2356-looks', 'deploy-20261010-2358-mobile', 'deploy-20261011-0019-journaux', 'deploy-20261011-0129-healthfix',
    'deploy-20261011-0134-avatar', 'deploy-20261011-0147-lineage',
  ]) assert.ok(manifest.releases.some((release) => release.tag === tag), tag);
});

test('release badge compares release sequence and stores the seen version per user on this device', async () => {
  const values = new Map();
  const storage = { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
  const userKey = await releaseUserKey('owner@example.test');
  assert.match(userKey, /^ao\.release-notes\.v1\.[0-9a-f]{64}$/);
  assert.notEqual(userKey, await releaseUserKey('other@example.test'));
  assert.equal(hasNewRelease(13, 14), true);
  assert.equal(hasNewRelease(14, 14), false);
  assert.equal(await hasUnseenRelease('owner@example.test', storage), true);
  let notified = 0;
  const unsubscribe = onReleaseSeen(() => notified++);
  assert.equal(await markCurrentReleaseSeen('owner@example.test', storage), true);
  unsubscribe();
  assert.equal(notified, 1);
  assert.equal(await hasUnseenRelease('owner@example.test', storage), false);
  assert.equal(await hasUnseenRelease('other@example.test', storage), true);
});
