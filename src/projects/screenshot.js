'use strict';

/** OpenGraph card size. The server's capturer (headless Chrome) uses these. */
const SHOT_WIDTH = 1200;
const SHOT_HEIGHT = 630;
const SHOT_TIMEOUT_MS = 10 * 1000;
const SHOT_MAX_BYTES = 2 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const SCREENSHOT_FRESH_MS = 24 * 60 * 60 * 1000;

function bareHost(host) {
  return String(host || '').toLowerCase().replace(/^\[|\]$/g, '');
}

function ipv4Parts(host) {
  if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) return null;
  const parts = host.split('.').map((part) => Number(part));
  if (parts.some((n) => n > 255)) return null;
  return parts;
}

function isBlockedAddress(host) {
  const h = bareHost(host);
  if (h === '::1' || h === '::' || h === '0:0:0:0:0:0:0:1' || h === '0:0:0:0:0:0:0:0') return true;
  const mapped = h.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (mapped) return isBlockedAddress(mapped[1]);
  if (h.startsWith('fe80:') || h.startsWith('fc') || h.startsWith('fd')) return true;
  if (/^\d+$/.test(h) || /^0x[0-9a-f.]+$/i.test(h)) return true;
  if (/^\d+(?:\.\d+){1,3}$/.test(h) && !ipv4Parts(h)) return true;
  const v4 = ipv4Parts(h);
  if (!v4) return false;
  const [a, b] = v4;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a >= 224) return true;
  return false;
}

function isLocalName(host) {
  const h = bareHost(host).replace(/\.$/, '');
  return h === 'localhost' || h.endsWith('.localhost')
    || h === 'local' || h.endsWith('.local')
    || h === 'internal' || h.endsWith('.internal');
}

function isIpLiteral(host) {
  const h = bareHost(host);
  return ipv4Parts(h) != null || h.includes(':');
}

/**
 * A homepage Chrome may open. https only, no userinfo, and not localhost, `.local`,
 * `.internal`, loopback, RFC1918, link-local, or CGNAT 100.64/10 (tailnet).
 */
function inspectSiteUrl(value) {
  if (typeof value !== 'string' || !value) return null;
  let url;
  try { url = new URL(value); } catch { return null; }
  if (url.protocol !== 'https:') return null;
  if (url.username || url.password) return null;
  const hostname = url.hostname;
  if (!hostname || isLocalName(hostname) || isBlockedAddress(hostname)) return null;
  return { href: url.href, hostname, ip: isIpLiteral(hostname) };
}

async function hostIsPublic(hostname, resolve) {
  if (!hostname || isLocalName(hostname) || isBlockedAddress(hostname)) return false;
  if (isIpLiteral(hostname)) return true;
  if (typeof resolve !== 'function') return false;
  let addresses;
  try { addresses = await resolve(hostname); } catch { return false; }
  if (!Array.isArray(addresses) || addresses.length === 0) return false;
  return addresses.every((addr) => !isBlockedAddress(addr) && !isLocalName(addr));
}

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), ms);
    promise.then((value) => { clearTimeout(timer); resolve(value); }, (err) => { clearTimeout(timer); reject(err); });
  });
}

/**
 * Capture `homepage` at 1200×630, or return null. `capture` and `resolve` are injected.
 * Each hop is checked before the call and again after it (DNS rebinding). A redirect is
 * checked the same way and never followed onto a private host. The capturer receives
 * `timeoutMs` and `maxBytes`; a timeout, an oversized body, or a bad URL yields null.
 */
async function capturePublicSite(homepage, options = {}) {
  const { capture, resolve } = options;
  const timeoutMs = options.timeoutMs ?? SHOT_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? SHOT_MAX_BYTES;
  if (typeof capture !== 'function') return null;
  let current = inspectSiteUrl(homepage);
  const seen = new Set();
  for (let hop = 0; hop < MAX_REDIRECTS && current; hop += 1) {
    if (seen.has(current.href)) return null;
    seen.add(current.href);
    if (!(await hostIsPublic(current.hostname, resolve))) return null;
    let result;
    try {
      result = await withTimeout(capture({
        url: current.href,
        width: SHOT_WIDTH,
        height: SHOT_HEIGHT,
        timeoutMs,
        maxBytes,
      }), timeoutMs);
    } catch {
      return null;
    }
    if (!result || result.timedOut) return null;
    if (Number.isFinite(result.bytes) && result.bytes > maxBytes) return null;
    if (!(await hostIsPublic(current.hostname, resolve))) return null;
    if (typeof result.redirect === 'string' && result.redirect) {
      let next;
      try { next = new URL(result.redirect, current.href).href; } catch { return null; }
      current = inspectSiteUrl(next);
      continue;
    }
    const stored = result.url && inspectSiteUrl(result.url);
    return stored ? { kind: 'screenshot', url: stored.href } : null;
  }
  return null;
}

module.exports = {
  SHOT_WIDTH, SHOT_HEIGHT, SHOT_TIMEOUT_MS, SHOT_MAX_BYTES, SCREENSHOT_FRESH_MS,
  inspectSiteUrl, isBlockedAddress, capturePublicSite,
};
