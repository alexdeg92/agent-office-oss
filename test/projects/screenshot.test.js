'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { capturePublicSite, SHOT_MAX_BYTES } = require('../../src/projects/screenshot');

const PUBLIC = ['93.184.216.34'];

describe('screenshot capture', () => {
  it('refuses a redirect onto a private host and does not capture it', async () => {
    const calls = [];
    const shot = await capturePublicSite('https://demo.example/start', {
      resolve: async () => PUBLIC,
      capture: async (input) => {
        calls.push(input.url);
        return { redirect: 'https://127.0.0.1/secret' };
      },
    });
    assert.equal(shot, null);
    assert.deepEqual(calls, ['https://demo.example/start']);
  });

  it('follows a public redirect and stores only a public image url', async () => {
    const calls = [];
    const shot = await capturePublicSite('https://demo.example/start', {
      resolve: async (host) => (host === 'live.example' ? ['1.1.1.1'] : PUBLIC),
      capture: async (input) => {
        calls.push(input.url);
        if (input.url.startsWith('https://demo.example')) return { redirect: 'https://live.example/app' };
        return { url: 'https://shots.example/demo.png', bytes: 1000 };
      },
    });
    assert.deepEqual(calls, ['https://demo.example/start', 'https://live.example/app']);
    assert.deepEqual(shot, { kind: 'screenshot', url: 'https://shots.example/demo.png' });
  });

  it('drops the shot when a second DNS lookup rebinds the host to a private address', async () => {
    let n = 0;
    const calls = [];
    const shot = await capturePublicSite('https://demo.example/', {
      resolve: async () => {
        n += 1;
        return n === 1 ? PUBLIC : ['10.0.0.9'];
      },
      capture: async (input) => {
        calls.push(input.url);
        return { url: 'https://shots.example/rebind.png' };
      },
    });
    assert.equal(shot, null);
    assert.deepEqual(calls, ['https://demo.example/']);
    assert.ok(n >= 2);
  });

  it('stops on a timeout and on a body over the size cap', async () => {
    const hung = await capturePublicSite('https://demo.example/', {
      resolve: async () => PUBLIC,
      timeoutMs: 20,
      capture: () => new Promise(() => {}),
    });
    assert.equal(hung, null);
    const huge = await capturePublicSite('https://demo.example/', {
      resolve: async () => PUBLIC,
      capture: async () => ({ url: 'https://shots.example/big.png', bytes: SHOT_MAX_BYTES + 1 }),
    });
    assert.equal(huge, null);
  });
});
