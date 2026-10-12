import { buildQuery } from '../config.js';
import { resolveUrl } from './assets.js';
import { DECOR_BUDGETS, checkDecorPack, installDecorPack } from './decor-packs.js';
const requests = new Map();
const aborted = () => new DOMException('Decor pack load cancelled', 'AbortError');
async function metadata(response, signal) {
  if (!response.ok) throw Error('decor pack ' + response.status);
  const limit = DECOR_BUDGETS.metadata;
  const length = response.headers.get('content-length');
  if (length && /^\d+$/.test(length) && Number(length) > limit) {
    await response.body?.cancel().catch(() => {}); throw Error('decor metadata exceeds budget');
  }
  if (!response.body) throw Error('decor metadata body missing');
  const reader = response.body.getReader(), buffer = new Uint8Array(limit);
  const cancel = () => { void reader.cancel(aborted()).catch(() => {}); };
  signal.addEventListener('abort', cancel, { once: true });
  let bytes = 0;
  try {
    for (;;) {
      if (signal.aborted) throw aborted();
      const { done, value } = await reader.read();
      if (signal.aborted) throw aborted();
      if (done) break;
      if (value.byteLength > limit - bytes) throw Error('decor metadata exceeds budget');
      buffer.set(value, bytes); bytes += value.byteLength;
    }
    return { pack: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, bytes))), bytes };
  } catch (error) { await reader.cancel(error).catch(() => {}); throw error; }
  finally { signal.removeEventListener('abort', cancel); reader.releaseLock(); }
}
export async function ensureDecorPack(index, asset, assetBase, { signal } = {}) {
  if (signal?.aborted) throw aborted();
  const f = index.furniture.get(asset);
  if (!f?.packManifest || f.packLoaded) return f;
  const url = resolveUrl(f.packManifest, assetBase) + buildQuery;
  let entry = requests.get(url);
  if (entry?.controller.signal.aborted) { requests.delete(url); entry = null; }
  if (!entry) {
    const controller = new AbortController();
    entry = { controller, users: 0, done: false };
    requests.set(url, entry);
    entry.promise = Promise.resolve().then(() => {
      if (controller.signal.aborted) throw aborted();
      return fetch(url, { signal: controller.signal });
    }).then(r => metadata(r, controller.signal)).then(({ pack, bytes }) => {
      const shape = checkDecorPack(pack, { id: f.packId, metadataBytes: bytes });
      if (!shape.ok) throw Error('decor pack invalid: ' + shape.errors.join('; '));
      entry.done = true;
      if (requests.size > 16) for (const [key, cached] of requests) {
        if (cached.done && !cached.users && key !== url) { requests.delete(key); break; }
      }
      return pack;
    }).catch(error => { if (requests.get(url) === entry) requests.delete(url); throw error; });
  }
  entry.users++;
  let cancel;
  try {
    const cancelled = new Promise((_, reject) => { cancel = () => reject(aborted()); signal?.addEventListener('abort', cancel, { once: true }); });
    const pack = await Promise.race([entry.promise, cancelled]);
    if (signal?.aborted) throw aborted();
    try { installDecorPack(index, pack, f.packManifest.replace(/manifest\.json$/, '')); }
    catch (error) { if (requests.get(url) === entry) requests.delete(url); throw error; }
    return index.furniture.get(asset);
  } finally {
    signal?.removeEventListener('abort', cancel);
    if (--entry.users === 0 && !entry.done) { entry.controller.abort(); if (requests.get(url) === entry) requests.delete(url); }
  }
}
export function ensureDecorPacks(index, assets, assetBase, options) {
  return Promise.all([...new Set(assets)].map(id => ensureDecorPack(index, id, assetBase, options)));
}
