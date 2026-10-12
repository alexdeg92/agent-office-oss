'use strict';

const https = require('node:https');
const net = require('node:net');
const { canonicalDomain } = require('./dns-inspection');

const MAX_BODY = 64 * 1024;
const CONNECT_TIMEOUT_MS = 5000;
const TOTAL_TIMEOUT_MS = 10000;
const BLOCKED_V4 = Object.freeze([
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16],
  ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
]);
const BLOCKED_V6 = Object.freeze([
  ['::', 128], ['::1', 128], ['64:ff9b:1::', 48], ['100::', 64], ['2001::', 23], ['2001:db8::', 32],
  ['2002::', 16], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8],
]);
const V4_BLOCKLIST = new net.BlockList();
for (const [address, prefix] of BLOCKED_V4) V4_BLOCKLIST.addSubnet(address, prefix, 'ipv4');
const V6_BLOCKLIST = new net.BlockList();
for (const [address, prefix] of BLOCKED_V6) V6_BLOCKLIST.addSubnet(address, prefix, 'ipv6');

function ipv4Mapped(address) {
  const source = address.toLowerCase();
  if (source.includes('%')) return null;
  const halves = source.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':') : [], right = halves[1] ? halves[1].split(':') : [];
  const words = halves.length === 1 ? left : [...left, ...Array(8 - left.length - right.length).fill('0'), ...right];
  if (words.length !== 8 || words.slice(0, 5).some(word => parseInt(word || '0', 16) !== 0) || parseInt(words[5], 16) !== 0xffff) return null;
  const value = (parseInt(words[6], 16) * 65536 + parseInt(words[7], 16)) >>> 0;
  return [value >>> 24, (value >>> 16) & 255, (value >>> 8) & 255, value & 255].join('.');
}
function isPublicAddress(address) {
  if (typeof address !== 'string' || address.includes('%')) return false;
  const family = net.isIP(address);
  if (family === 4) return !V4_BLOCKLIST.check(address, 'ipv4');
  if (family !== 6) return false;
  const mapped = ipv4Mapped(address);
  if (mapped) return !V4_BLOCKLIST.check(mapped, 'ipv4');
  // Only global-unicast IPv6 is eligible; special-use and future-use ranges fail closed.
  if (!V6_BLOCKLIST.check(address, 'ipv6')) {
    const first = parseInt(address.split(':')[0] || '0', 16);
    return (first & 0xe000) === 0x2000;
  }
  return false;
}

function collect(response, signal) {
  return new Promise((resolve, reject) => {
    response.on('error', reject);
    if (response.headers?.['content-encoding'] && response.headers['content-encoding'] !== 'identity') {
      response.destroy(new Error('compressed response')); return;
    }
    let size = 0; const chunks = [];
    response.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BODY) { response.destroy(new Error('oversized')); return; }
      chunks.push(chunk);
    });
    response.on('end', () => resolve({ status: response.statusCode || 0, headers: response.headers, body: Buffer.concat(chunks).toString('utf8') }));
    signal.addEventListener('abort', () => response.destroy(signal.reason || new Error('timeout')), { once: true });
  });
}
function requestPinned({ host, address, path, method, headers, body, signal, requester }) {
  if (requester) return requester({ host, address, path, method, headers, body, signal, rejectUnauthorized: true, redirect: 'error', maxBodyBytes: MAX_BODY });
  return new Promise((resolve, reject) => {
    const family = net.isIP(address);
    if (!family) return reject(new Error('invalid address'));
    const request = https.request({ hostname: host, servername: host, port: 443, path, method, headers,
      agent: false, rejectUnauthorized: true, maxHeaderSize: 16 * 1024,
      lookup: (_hostname, _options, callback) => callback(null, address, family) }, response => {
      collect(response, signal).then(resolve, reject);
    });
    const connectTimer = setTimeout(() => request.destroy(new Error('connect timeout')), CONNECT_TIMEOUT_MS);
    connectTimer.unref?.(); request.once('socket', socket => socket.once('secureConnect', () => clearTimeout(connectTimer)));
    request.setTimeout(TOTAL_TIMEOUT_MS, () => request.destroy(new Error('request timeout')));
    signal.addEventListener('abort', () => request.destroy(signal.reason || new Error('timeout')), { once: true });
    request.once('error', error => { clearTimeout(connectTimer); reject(error); });
    request.end(body);
  });
}

function resolverAddresses(observation) {
  if (!observation || observation.resolvers?.length !== 2 || observation.resolvers.some(row => row.state !== 'answered')) return { state: 'unknown', addresses: [] };
  const sets = observation.resolvers.map(row => [...new Set(['A', 'AAAA'].flatMap(type => row.records[type].map(record => record.value)))].sort());
  if (!sets[0].length || JSON.stringify(sets[0]) !== JSON.stringify(sets[1])) return { state: 'unknown', addresses: [] };
  if (sets[0].some(address => !isPublicAddress(address))) return { state: 'blocked', addresses: sets[0] };
  return { state: 'ready', addresses: sets[0] };
}
function originAllowed(headers, origin, { method = 'POST', requestedHeaders = ['authorization', 'content-type', 'x-ao-csrf', 'x-ao-request'], credentials = false } = {}) {
  const one = value => Array.isArray(value) ? value.join(',') : String(value || '');
  const vary = one(headers.vary).split(',').map(v => v.trim().toLowerCase());
  const methods = one(headers['access-control-allow-methods']).split(',').map(v => v.trim().toUpperCase());
  const allowedHeaders = one(headers['access-control-allow-headers']).split(',').map(v => v.trim().toLowerCase());
  return one(headers['access-control-allow-origin']) === origin
    && (credentials ? one(headers['access-control-allow-credentials']).toLowerCase() === 'true' : !headers['access-control-allow-credentials'])
    && ['origin', 'access-control-request-method', 'access-control-request-headers'].every(header => vary.includes(header))
    && methods.includes(method.toUpperCase())
    && requestedHeaders.every(header => allowedHeaders.includes(header.toLowerCase()));
}

function createAccessProbes({ inspector, requester = null, now = Date.now, env = process.env } = {}) {
  if (!inspector?.inspect) throw new TypeError('DNS inspector required');
  async function run({ draft, kind, signal, diagnostic = null }) {
    if (!['tls', 'cors'].includes(kind)) return { state: 'unknown', reason: 'check.not-run', evidence: null };
    const api = new URL(draft.apiPublicUrl);
    if (api.port && api.port !== '443') return { state: 'blocked', reason: 'target.unsupported-port', evidence: null };
    let host;
    try { host = canonicalDomain(api.hostname); } catch { return { state: 'blocked', reason: 'target.invalid-host', evidence: null }; }
    if (!(host === draft.domain || host.endsWith('.' + draft.domain))) return { state: 'blocked', reason: 'target.outside-domain', evidence: null };
    if ((env.AO_ENV === 'test' || process.env.NODE_TEST_CONTEXT) && !requester) throw Object.assign(new Error('HTTPS probes require an injected fixture'), { code: 'ETESTPROBE' });
    const dns = await inspector.inspect(host);
    if (signal.aborted) return { state: 'unknown', reason: 'check.cancelled', evidence: null };
    const pinned = resolverAddresses(dns);
    if (pinned.state !== 'ready') return { state: pinned.state, reason: pinned.state === 'blocked' ? 'target.blocked-address' : 'dns.resolver-disagreement', evidence: { resolverStates: dns.resolvers.map(row => row.state) } };
    const controller = new AbortController();
    const abort = () => controller.abort(signal.reason || new Error('cancelled'));
    signal.addEventListener('abort', abort, { once: true });
    const deadline = setTimeout(() => controller.abort(new Error('probe timeout')), TOTAL_TIMEOUT_MS);
    deadline.unref?.();
    try {
      const address = pinned.addresses[0];
      const basePath = api.pathname === '/' ? '' : api.pathname;
      const path = kind === 'tls' ? `${basePath}/healthz` : `${basePath}/api/auth/access-diagnostic`;
      const origin = draft.uiOrigins[0];
      const corsHeaders = ['authorization', 'content-type', 'x-ao-csrf', 'x-ao-request'];
      const response = await requestPinned({ host, address, path, method: kind === 'tls' ? 'GET' : 'OPTIONS', signal: controller.signal, requester,
        headers: kind === 'cors' ? { Origin: origin, 'Access-Control-Request-Method': 'POST',
          'Access-Control-Request-Headers': corsHeaders.join(',') } : { Accept: 'application/json' } });
      if (response.status >= 300 && response.status < 400) return { state: 'blocked', reason: 'target.redirect-refused', evidence: { address } };
      if (kind === 'cors') {
        const passed = response.status >= 200 && response.status < 300
          && originAllowed(response.headers, origin, { method: 'POST', requestedHeaders: corsHeaders, credentials: false });
        if (!passed) return { state: 'failed', reason: 'cors.origin-not-allowed', evidence: { address, status: response.status } };
        if (!diagnostic || !/^[a-f0-9]{64}$/.test(diagnostic.nonce || '') || typeof diagnostic.planId !== 'string'
          || typeof diagnostic.installationId !== 'string' || !Number.isSafeInteger(diagnostic.accessRevision)) {
          return { state: 'unknown', reason: 'access.diagnostic-unavailable', evidence: { address, status: response.status } };
        }
        const body = JSON.stringify({ nonce: diagnostic.nonce, planId: diagnostic.planId });
        const checked = await requestPinned({ host, address, path, method: 'POST', signal: controller.signal, requester, body,
          headers: { Origin: origin, 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(body)), 'X-AO-Request': '1', Accept: 'application/json' } });
        if (checked.status >= 300 && checked.status < 400) return { state: 'blocked', reason: 'target.redirect-refused', evidence: { address } };
        let identity = null;
        if (checked.status >= 200 && checked.status < 300 && typeof checked.body === 'string' && checked.body.length <= 2048) {
          try { identity = JSON.parse(checked.body); } catch { /* invalid diagnostic payload */ }
        }
        const verified = identity && identity.nonce === diagnostic.nonce
          && identity.installationId === diagnostic.installationId && identity.accessRevision === diagnostic.accessRevision;
        return { state: verified ? 'passed' : 'failed', reason: verified ? null : 'cors.installation-mismatch',
          evidence: { address, status: checked.status, installationVerified: !!verified } };
      }
      const passed = response.status >= 200 && response.status < 300;
      return { state: passed ? 'passed' : 'failed', reason: passed ? null : 'tls.endpoint-unavailable',
        evidence: { address, status: response.status, verifiedHostname: host, observedAt: now() } };
    } catch (error) {
      return { state: 'failed', reason: controller.signal.aborted ? 'check.timeout' : kind === 'cors' ? 'cors.diagnostic-unavailable' : 'tls.certificate-invalid', evidence: null };
    } finally { clearTimeout(deadline); signal.removeEventListener('abort', abort); }
  }
  return Object.freeze({ run });
}

module.exports = { createAccessProbes, isPublicAddress, resolverAddresses, originAllowed, MAX_BODY, CONNECT_TIMEOUT_MS, TOTAL_TIMEOUT_MS };
