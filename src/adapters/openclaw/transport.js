'use strict';
// Persistent authenticated bridge to the OpenClaw gateway WebSocket.
// Reproduces the CLI's device-signed connect handshake (protocol v4).
const WebSocket = require('ws');
const fs = require('fs');
const { randomUUID, createPrivateKey, createPublicKey, sign } = require('crypto');
const { EventEmitter } = require('events');

// OpenClaw migrated identity/device.json into the state DB (device_identities);
// fall back to reading the CLI's primary identity from there, read-only.
// ADR-001 §12.1: both paths come from the runtime home (config), and a missing identity is a state, not a
// crash → { identity } | { missing: 'no-identity' | 'identity-invalid' }. Never logs key material.
function loadIdentity({ identityPath, stateDbPath }) {
  try {
    if (identityPath && fs.existsSync(identityPath)) {
      const id = JSON.parse(fs.readFileSync(identityPath, 'utf8'));
      return validIdentity(id) ? { identity: id } : { missing: 'identity-invalid' };
    }
    if (!stateDbPath || !fs.existsSync(stateDbPath)) return { missing: 'no-identity' };
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(stateDbPath, { readOnly: true });   // a live WAL database: a plain read-only open, as before
    try {
      const row = db.prepare("SELECT device_id, public_key_pem, private_key_pem FROM device_identities WHERE identity_key = 'primary'").get();
      if (!row) return { missing: 'no-identity' };
      const id = { deviceId: row.device_id, publicKeyPem: row.public_key_pem, privateKeyPem: row.private_key_pem };
      return validIdentity(id) ? { identity: id } : { missing: 'identity-invalid' };
    } finally { db.close(); }
  } catch (_) {
    return { missing: 'identity-invalid' };
  }
}
const validIdentity = (id) => !!id && typeof id.deviceId === 'string' && typeof id.publicKeyPem === 'string' && typeof id.privateKeyPem === 'string';

const b64u = (b) => Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

class Gateway extends EventEmitter {
  constructor(opts) {
    super();
    this.url = opts.url;
    this.gatewayToken = opts.gatewayToken;
    this.scopes = ['operator.read'];
    // §12.1: construction never throws. No token or no usable identity → `notConfigured` (a category), and
    // start() never connects; the server still boots and serves.
    this.notConfigured = null;
    this.identityOptions = { identityPath: opts.identityPath, stateDbPath: opts.stateDbPath };
    this._loadIdentity();
    this.pending = new Map();
    this.connected = false;
    this.backoff = 1000;
    this.ws = null;
    this.retry = opts.retry !== false;   // G4 setup probe: one attempt only
    this.lastErrorCode = null;           // the socket error's code (ECONNREFUSED…), never its message
    this.rejected = false;               // this attempt received an explicit refused connect
    this.rejectionBackoff = 30000;
    this.rejectionLogged = false;
    this.timers = opts.timers || { setTimeout, clearTimeout }; // injectable retry clock
    this.started = false;
  }

  _loadIdentity() {
    this.notConfigured = null;
    const loaded = this.gatewayToken ? loadIdentity(this.identityOptions) : { missing: 'no-token' };
    if (loaded.identity) {
      try {
        this.identity = loaded.identity;
        this.pubRaw = b64u(createPublicKey(this.identity.publicKeyPem).export({ format: 'der', type: 'spki' }).subarray(-32));
        this.pk = createPrivateKey(this.identity.privateKeyPem);
      } catch (_) { this.notConfigured = 'identity-invalid'; }
    } else this.notConfigured = loaded.missing;
    if (this.notConfigured) { this.identity = null; this.pk = null; this.pubRaw = null; }
  }

  _clearPending() {
    for (const [, p] of this.pending) p.resolve({ ok: false, error: { message: 'socket closed' } });
    this.pending.clear();
  }

  // A URL and its token are an explicit pair; changing either invalidates old callbacks and retry state.
  updateConnection(pair) {
    if (!pair || !Object.hasOwn(pair, 'url') || !Object.hasOwn(pair, 'gatewayToken')) throw Error('gateway URL/token pair required');
    if (pair.url === this.url && pair.gatewayToken === this.gatewayToken) return false;
    this.timers.clearTimeout(this._retryTimer); this._retryTimer = null;
    const old = this.ws; this.ws = null; this.connected = false; this._clearPending();
    try { old?.terminate(); } catch (_) {}
    this.url = pair.url; this.gatewayToken = pair.gatewayToken;
    this.rejected = false; this.rejectionLogged = false; this.rejectionBackoff = 30000; this.backoff = 1000; this.lastErrorCode = null;
    this._loadIdentity();
    if (old) this.emit('close');
    if (this.started) this.start();
    return true;
  }

  close() {
    this.retry = false; this.started = false;
    this.timers.clearTimeout(this._retryTimer); this._retryTimer = null;
    const old = this.ws; this.ws = null; this.connected = false; this._clearPending();
    try { old?.terminate(); } catch (_) {}
    if (old) this.emit('close');
  }

  start() {
    this.started = true;
    if (this._retryTimer || this.ws && this.ws.readyState !== WebSocket.CLOSED) return;
    if (this.notConfigured) {
      this.emit('log', 'not configured (' + this.notConfigured + '): not connecting');
      this.emit('not-configured', this.notConfigured);
      return;
    }
    this._connect();
  }

  _connect() {
    this.rejected = false; this.lastErrorCode = null;
    let ws;
    try { ws = new WebSocket(this.url); } catch (e) { this.lastErrorCode = 'bad-url'; this.emit('close'); return this.retry ? this._retry() : undefined; }
    this.ws = ws;
    const hardTimeout = setTimeout(() => { try { ws.close(); } catch (_) {} }, 15000);

    ws.on('message', async (data) => {
      if (this.ws !== ws) return;
      let m;
      try { m = JSON.parse(data.toString()); } catch (_) { return; }
      if (m.type === 'res' && this.pending.has(m.id)) {
        const { resolve } = this.pending.get(m.id);
        this.pending.delete(m.id);
        resolve(m);
        return;
      }
      if (m.type === 'event') {
        if (m.event === 'connect.challenge') {
          try {
            const nonce = m.payload.nonce;
            // G11 (doctor): the gateway's clock at the challenge (it refuses a signature skewed by more than 120 s)
            this.challenge = { ts: Number.isFinite(m.payload.ts) ? m.payload.ts : null, receivedAt: Date.now() };
            const signedAt = Date.now();
            const payload = ['v3', this.identity.deviceId, 'cli', 'cli', 'operator', this.scopes.join(','),
              String(signedAt), this.gatewayToken, nonce, 'linux', ''].join('|');
            const signature = b64u(sign(null, Buffer.from(payload), this.pk));
            const r = await this._raw('connect', {
              minProtocol: 4, maxProtocol: 4,
              client: { id: 'cli', version: '2026.6.11', platform: 'linux', mode: 'cli', instanceId: randomUUID() },
              caps: [], auth: { token: this.gatewayToken }, role: 'operator', scopes: this.scopes,
              device: { id: this.identity.deviceId, publicKey: this.pubRaw, signature, signedAt, nonce },
            }, 10000);
            if (this.ws !== ws) return;
            if (!r.ok) {
              // Synthetic timeout/socket errors from _raw are transport failures, not a refused response.
              if (r.type === 'res' && r.ok === false) {
                this.rejected = true;
                if (!this.rejectionLogged) {
                  this.rejectionLogged = true;
                  this.emit('log', 'connect rejected: retrying with backoff from 30 seconds to 10 minutes');
                }
              }
              throw new Error('connect failed');
            }
            clearTimeout(hardTimeout);
            this.connected = true;
            this.backoff = 1000; this.rejected = false; this.rejectionBackoff = 30000; this.rejectionLogged = false;
            this.hello = r.payload;
            this.emit('open', r.payload);
          } catch (e) {
            if (this.ws !== ws) return;
            if (!this.rejected) this.emit('log', 'connect failed (transport)');
            try { ws.close(); } catch (_) {}
          }
        } else {
          // live gateway event (health, cron, sessions.changed, presence, tick, etc.)
          this.emit('gwevent', m.event, m.payload);
        }
      }
    });

    ws.on('close', () => {
      clearTimeout(hardTimeout);
      if (this.ws !== ws) return;
      this.connected = false;
      this._clearPending();
      this.emit('close');
      if (this.retry) this._retry();
    });
    ws.on('error', (e) => { if (this.ws !== ws) return; this.lastErrorCode = (e && e.code) || 'error'; this.emit('log', 'ws error (' + this.lastErrorCode + ')'); });
  }

  _retry() {
    if (this._retryTimer) return;
    const delay = this.rejected ? this.rejectionBackoff : this.backoff;
    this._retryTimer = this.timers.setTimeout(() => { this._retryTimer = null; this._connect(); }, delay);
    if (this.rejected) this.rejectionBackoff = Math.min(600000, this.rejectionBackoff * 2);
    else this.backoff = Math.min(30000, Math.round(this.backoff * 1.7));
  }

  _raw(method, params, timeoutMs) {
    return new Promise((resolve) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return resolve({ ok: false, error: { message: 'not connected' } });
      const id = randomUUID();
      const timer = setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); resolve({ ok: false, error: { message: 'timeout' } }); }
      }, timeoutMs || 12000);
      this.pending.set(id, { resolve: (v) => { clearTimeout(timer); resolve(v); } });
      try { this.ws.send(JSON.stringify({ type: 'req', id, method, params: params || {} })); }
      catch (e) { clearTimeout(timer); this.pending.delete(id); resolve({ ok: false, error: { message: e.message } }); }
    });
  }

  // Public RPC call; returns payload or throws.
  async call(method, params) {
    const r = await this._raw(method, params, 12000);
    if (!r.ok) throw new Error((r.error && r.error.message) || 'rpc failed');
    return r.payload;
  }
}

/**
 * G4 first-run setup: ONE connection attempt to a gateway being configured (no retry, nothing kept).
 * → { status: 'connected'|'unreachable'|'refused'|'unauthorized', protocol, latencyMs, gw }; with `connected` the
 * caller may use `gw.call()` and MUST `gw.close()`. The token is only sent to that gateway; nothing is logged.
 */
function probeGateway({ url, token, identityPath, stateDbPath, timeoutMs = 8000, now = Date.now }) {
  return new Promise((resolve) => {
    const t0 = now();
    const gw = new Gateway({ url, gatewayToken: token, identityPath, stateDbPath, retry: false });
    // no token or no device identity: the gateway can't accept us → the credentials are the problem
    if (gw.notConfigured) return resolve({ status: 'unauthorized', protocol: null, latencyMs: null, gw: null });
    let done = false;
    const finish = (r) => { if (done) return; done = true; clearTimeout(timer); if (r.status !== 'connected') gw.close(); resolve(r); };
    const timer = setTimeout(() => finish({ status: 'unreachable', protocol: null, latencyMs: null, gw: null }), timeoutMs);
    gw.on('open', (hello) => finish({ status: 'connected', protocol: Number.isInteger(hello && hello.protocol) ? hello.protocol : 4, latencyMs: now() - t0, gw }));
    gw.on('close', () => finish({ status: gw.rejected ? 'unauthorized' : gw.lastErrorCode === 'ECONNREFUSED' ? 'refused' : 'unreachable', protocol: null, latencyMs: null, gw: null }));
    gw._connect();
  });
}

module.exports = { Gateway, loadIdentity, probeGateway };
