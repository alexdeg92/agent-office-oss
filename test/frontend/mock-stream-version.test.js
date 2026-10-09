import { test } from 'node:test';
import assert from 'node:assert/strict';
import { configure, versioned } from '../../public/v2/config.js';
import * as mock from '../../public/v2/mock/server.js';
import { createStream } from '../../public/v2/stream.js';

for (const apiVersion of [2, 3]) test(`mock v${apiVersion}: metadata and SSE agree; chat reaches live data without a reload`, { timeout: 3000 }, async () => {
  configure({ apiVersion, apiBase: '' });
  mock.configure({ scenario: 'vide', standalone: true }); // No background tick interval in this fixture.
  const meta = (await mock.handle('GET', versioned('/api/v2/meta'))).body.data;
  const reloads = [], frames = [];
  let resolveData;
  const data = new Promise((resolve) => { resolveData = resolve; });
  const stream = createStream({
    openSource: (url) => {
      const source = new mock.MockEventSource(versioned(url));
      source.addEventListener('hello', (ev) => frames.push(JSON.parse(ev.data)));
      return source;
    },
    fetchVM: async (url) => {
      const r = await mock.handle('GET', versioned(url));
      return { data: r.body.data, topic: r.body.meta.topic };
    },
    postTopics: async (id, body) => (await mock.handle('POST', versioned(`/api/v2/stream/${id}/topics`), body)).body.data.topics,
    postResync: async () => {},
    onReload: (reason) => reloads.push(reason),
    modelVersion: meta.modelVersion,
    contractVersion: meta.contractVersion,
    network: null,
  });
  let unsubscribe;
  try {
    stream.start();
    unsubscribe = stream.subscribe('chat', '/api/v2/views/chat', (vm) => { if (vm.data) resolveData(vm); });
    const vm = await data;
    assert.equal(frames.length, 1);
    assert.equal(frames[0].contractVersion, meta.contractVersion);
    assert.equal(frames[0].modelVersion, meta.modelVersion);
    assert.deepEqual(reloads, [], 'version mismatch must never continually reload the page');
    assert.equal(stream.status.get().conn, 'open');
    assert.deepEqual(vm.data.messages, []);
  } finally { unsubscribe?.(); stream.stop(); }
});
