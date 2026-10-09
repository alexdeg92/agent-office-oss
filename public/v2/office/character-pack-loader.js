import { buildQuery } from '../config.js';
import { installCharacterPack } from './character-packs.js';
import { checkPackShape } from './character-pack-shape.js';
import { contract } from '../generated/character-pack-contract.js';
import { resolveUrl } from './assets.js';
// Shared metadata requests, with independent consumer cancellation. No raster prefetch.
const requests = new Map();
const aborted = () => new DOMException('Character pack load cancelled', 'AbortError');
async function readMetadata(response, signal) {
  const limit = contract.budgets.manifestBytes;
  const tooLarge = () => Error('manifest exceeds metadata budget');
  const length = response.headers.get('content-length');
  if (length && /^\d+$/.test(length) && Number(length) > limit) {
    await response.body?.cancel().catch(() => {});
    throw tooLarge();
  }
  if (!response.body) throw Error('character pack metadata body missing');
  const reader = response.body.getReader();
  const cancel = () => { void reader.cancel(aborted()).catch(() => {}); };
  signal.addEventListener('abort', cancel, { once: true });
  // Copy only admitted chunks; never concatenate an unbounded response or decode
  // before admission. Count raw bytes even when Content-Length is missing/wrong.
  const buffer = new Uint8Array(limit);
  let metadataBytes = 0;
  try {
    for (;;) {
      if (signal.aborted) throw aborted();
      const { done, value } = await reader.read();
      if (signal.aborted) throw aborted();
      if (done) break;
      if (value.byteLength > limit - metadataBytes) throw tooLarge();
      buffer.set(value, metadataBytes);
      metadataBytes += value.byteLength;
    }
    return { text: new TextDecoder().decode(buffer.subarray(0, metadataBytes)), metadataBytes };
  } catch (error) {
    await reader.cancel(error).catch(() => {});
    throw error;
  } finally {
    signal.removeEventListener('abort', cancel);
    reader.releaseLock();
  }
}
export async function ensureCharacterPack(index, id, assetBase, { signal } = {}) {
  const c = index.characters.get(id);
  if (signal?.aborted) throw aborted();
  if (!c?.packManifest || c.packLoaded) return c;
  const url = resolveUrl(c.packManifest, assetBase) + buildQuery;
  let entry = requests.get(url);
  if (entry && !entry.done && entry.controller.signal.aborted) {
    requests.delete(url);
    entry = null;
  }
  if (!entry) {
    const controller = new AbortController();
    entry = { controller, users: 1, done: false };
    requests.set(url, entry);
    // Claim the consumer and publish the entry before invoking fetch, which may re-enter.
    entry.promise = Promise.resolve().then(() => {
      if (controller.signal.aborted) throw aborted();
      return fetch(url, { signal: controller.signal });
    })
      .then(async r => {
        if (!r.ok) throw Error('character pack ' + r.status);
        const { text, metadataBytes } = await readMetadata(r, controller.signal);
        const pack = JSON.parse(text), shape = checkPackShape(pack, { id, metadataBytes });
        if (!shape.ok) throw Error('character pack invalid: ' + shape.errors.join('; '));
        entry.done = true;
        // Bounded metadata cache; decoded raster lifetime belongs to the renderer.
        if (requests.size > 24) for (const [key, item] of requests) {
          if (item.done && !item.users && key !== url) { requests.delete(key); break; }
        }
        return pack;
      }).catch(error => { if (requests.get(url) === entry) requests.delete(url); throw error; });
  } else entry.users++;
  let cancel;
  try {
    const cancelled = new Promise((_, reject) => { cancel = () => reject(aborted()); signal?.addEventListener('abort', cancel, { once: true }); });
    const pack = await Promise.race([entry.promise, cancelled]);
    if (signal?.aborted) throw aborted();
    return installCharacterPack(index, pack, c.packManifest.replace(/manifest\.json$/, ''));
  } finally {
    signal?.removeEventListener('abort', cancel);
    if (--entry.users === 0 && !entry.done) { entry.controller.abort(); if (requests.get(url) === entry) requests.delete(url); }
  }
}
export function ensureCharacterPacks(index, ids, assetBase, options) {
  return Promise.all([...new Set(ids)].map(id => ensureCharacterPack(index, id, assetBase, options)));
}
