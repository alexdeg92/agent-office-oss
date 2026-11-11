'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { createFiles } = require('../../src/adapters/codex/files');

test('codex thread names come from session_index.jsonl: bounded, last entry wins, never through a symlink', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-codex-threads-')); t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const files = createFiles({ home }); t.after(() => files.close());
  assert.deepEqual([...await files.threadNames()], [], 'no index, no names');
  const index = path.join(home, 'session_index.jsonl');
  fs.writeFileSync(index, ['{"id":"a","thread_name":"First"}', 'not json', '{"id":"b","thread_name":"Line\\nbreak\\u0007"}',
    '{"id":"a","thread_name":"Renamed"}', '{"id":"c","thread_name":""}', '{"id":42,"thread_name":"Bad id"}'].join('\n') + '\n');
  assert.deepEqual(Object.fromEntries(await files.threadNames()), { a: 'Renamed', b: 'Line break' });
  const outside = path.join(home, 'elsewhere.jsonl'); fs.writeFileSync(outside, '{"id":"x","thread_name":"Outside"}\n');
  fs.rmSync(index); fs.symlinkSync(outside, index);
  assert.deepEqual([...await files.threadNames()], [], 'a symlinked index is refused');
});
