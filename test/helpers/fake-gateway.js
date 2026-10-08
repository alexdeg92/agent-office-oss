'use strict';
/*
 * In-process fake of the OpenClaw gateway WebSocket (protocol v4 frames, as used by gateway.js).
 *
 * - Sends `connect.challenge` on connection and accepts any `connect` request (no signature check).
 * - Answers RPCs from a handler map: method → payload | (params) → payload | { error }.
 * - Unknown methods answer { ok:false, error:{ message:'unknown method' } }, like a real refusal.
 * - `emit(event, payload)` pushes a live event to every connected client.
 * - Records every request in `calls` for assertions.
 */
const { WebSocketServer } = require('ws');
const { randomUUID } = require('crypto');

class FakeGateway {
  // `token` (G4 tests): when set, a connect with another auth token is refused like the real gateway does
  constructor({ handlers = {}, hello = { server: { version: '2026.9.8' }, protocol: 4 }, onConnectEvents = [], token = null } = {}) {
    this.token = token;
    this.handlers = handlers;
    this.hello = hello;
    this.onConnectEvents = onConnectEvents;     // [{ event, payload }] sent right after a successful connect
    this.calls = [];
    this.clients = new Set();
    this.wss = null;
  }

  async start() {
    this.wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await new Promise((r) => this.wss.once('listening', r));
    this.wss.on('connection', (ws) => this._onConnection(ws));
    return this;
  }
  get url() { return `ws://127.0.0.1:${this.wss.address().port}`; }

  _send(ws, frame) { if (ws.readyState === 1) ws.send(JSON.stringify(frame)); }

  _onConnection(ws) {
    let authed = false;
    this._send(ws, { type: 'event', event: 'connect.challenge', payload: { nonce: randomUUID(), ts: Date.now() + (this.clockOffsetMs || 0) } });   // like 2026.9.8 (G11: clockOffsetMs skews it)
    ws.on('message', async (data) => {
      let m; try { m = JSON.parse(String(data)); } catch (_) { return; }
      if (m.type !== 'req') return;
      this.calls.push({ method: m.method, params: m.params, at: Date.now() });
      if (m.method === 'connect') {
        if (this.token && !(m.params && m.params.auth && m.params.auth.token === this.token)) {
          this._send(ws, { type: 'res', id: m.id, ok: false, error: { code: 'unauthorized', message: 'unauthorized' } });
          return;
        }
        authed = true; this.clients.add(ws);
        this._send(ws, { type: 'res', id: m.id, ok: true, payload: this.hello });
        for (const e of this.onConnectEvents) this._send(ws, { type: 'event', event: e.event, payload: e.payload });
        return;
      }
      if (!authed) return this._send(ws, { type: 'res', id: m.id, ok: false, error: { message: 'not connected' } });
      const h = this.handlers[m.method];
      if (h === undefined) return this._send(ws, { type: 'res', id: m.id, ok: false, error: { message: 'unknown method: ' + m.method } });
      try {
        const out = typeof h === 'function' ? await h(m.params || {}) : h;
        if (out && out.__error) return this._send(ws, { type: 'res', id: m.id, ok: false, error: out.__error });
        this._send(ws, { type: 'res', id: m.id, ok: true, payload: out });
      } catch (e) {
        this._send(ws, { type: 'res', id: m.id, ok: false, error: { message: e.message } });
      }
    });
    ws.on('close', () => this.clients.delete(ws));
  }

  emit(event, payload) { for (const ws of this.clients) this._send(ws, { type: 'event', event, payload }); }
  dropAll() { for (const ws of this.clients) ws.terminate(); }
  callsTo(method) { return this.calls.filter((c) => c.method === method); }

  async stop() {
    for (const ws of this.clients) ws.terminate();
    if (this.wss) await new Promise((r) => this.wss.close(r));
  }
}

FakeGateway.error = (message, code) => ({ __error: { message, code } });

module.exports = { FakeGateway };
