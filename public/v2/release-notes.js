import { CURRENT_RELEASE } from './release-current.js';

const KEY_PREFIX = 'ao.release-notes.v1.';
const listeners = new Set();

// Stable, non-reversible key suffix: the email scopes the local device preference without storing it in the key.
export async function releaseUserKey(email) {
  const value = String(email || '').trim().toLowerCase();
  if (!value) return KEY_PREFIX + 'anonymous';
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return KEY_PREFIX + [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function hasNewRelease(seenSequence, currentSequence = CURRENT_RELEASE.sequence) {
  return currentSequence > (Number.isInteger(seenSequence) ? seenSequence : -1);
}

export async function hasUnseenRelease(email, storage = null) {
  try {
    const target = storage || globalThis.localStorage;
    const seen = JSON.parse(target.getItem(await releaseUserKey(email)) || 'null');
    return hasNewRelease(seen?.sequence);
  } catch { return true; }
}

export async function markCurrentReleaseSeen(email, storage = null) {
  try {
    const target = storage || globalThis.localStorage;
    target.setItem(await releaseUserKey(email), JSON.stringify(CURRENT_RELEASE));
    for (const listener of listeners) listener();
    return true;
  } catch { return false; }
}

export function onReleaseSeen(listener) {
  listeners.add(listener);
  const onStorage = (event) => { if (event.key?.startsWith(KEY_PREFIX)) listener(); };
  globalThis.addEventListener?.('storage', onStorage);
  return () => { listeners.delete(listener); globalThis.removeEventListener?.('storage', onStorage); };
}
