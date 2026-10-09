'use strict';
// Single-user login with an HMAC-signed session cookie. The cookie name `taco_sess` must not change
// (renaming it logs everyone out).
// S6:
//   - R1-09, logout semantics: a cookie carries a random session id (`sid`); logout revokes that sid
//     server-side (persisted in the store), so the cookie AND any copy of it stop working at once, and the
//     session's open streams close. Cookies issued before S6 have no sid: they stay valid until they expire.
//   - R1-10: the `Secure` attribute when `cookieSecure` (PORTAL_COOKIE_SECURE; default on in production,
//     off on staging/dev, which are served over plain HTTP on the tailnet).
// PM audit (A), go-live gate:
//   - the password is verified against an scrypt hash (PORTAL_PASSWORD_HASH; a plaintext PORTAL_PASSWORD is hashed in
//     memory at boot, with a deprecation warning from the config), in constant time; scrypt always runs, so a wrong
//     e-mail and a wrong password take the same time; the e-mail is compared as HMAC digests (timingSafeEqual);
//   - login throttling per client IP and global (src/security/login-throttle.js): 429 + Retry-After;
//   - JSON bodies only (415 otherwise); every attempt is audited (auth.login: ok / rejected + a category).
const crypto = require('crypto');
const { hashPassword, verifyPassword } = require('./security/password');
const { createLoginThrottle } = require('./security/login-throttle');

const COOKIE = 'taco_sess';

function createAuth({ secret, ttlMs, email: loginEmail, password: loginPassword = null, passwordHash = null, cookieSecure = false, revocations = null,
  throttle = createLoginThrottle(), audit = null, ownerPersonId = () => null, credential = null }) {
  // the hash to verify against: the configured one, else the plaintext's (hashed once, lazily)
  let hashReady = null;
  const theHash = () => hashReady || (hashReady = passwordHash ? Promise.resolve(passwordHash) : loginPassword ? hashPassword(loginPassword) : Promise.resolve(null));
  const digest = (x) => crypto.createHmac('sha256', secret).update('login-email:' + String(x)).digest();
  const emailDigest = digest(String(loginEmail || '').toLowerCase().trim());
  const revokeListeners = [];
  const attrs = (maxAgeSec) => '; HttpOnly; SameSite=Lax; Path=/; Max-Age=' + maxAgeSec + (cookieSecure ? '; Secure' : '');
  function signSession(payload) {
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const mac = crypto.createHmac('sha256', secret).update(body).digest('base64url');
    return body + '.' + mac;
  }
  function verifySession(cookie) {
    if (!cookie) return null;
    if (typeof cookie !== 'string' || cookie.length > 4096) return null;
    const [body, mac] = cookie.split('.'); if (!body || !mac) return null;
    const good = crypto.createHmac('sha256', secret).update(body).digest('base64url');
    let ok = false; try { ok = crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(good)); } catch (_) { return null; }
    if (!ok) return null;
    let p; try { p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); } catch (_) { return null; }
    if (!p || typeof p !== 'object' || !Number.isFinite(p.exp) || p.exp < Date.now()) return null;
    if (p.sid != null && (typeof p.sid !== 'string' || (revocations && revocations.isRevoked(p.sid)))) return null;
    if (credential && p.userId !== credential(null)?.id) return null;
    return p;
  }
  // Malformed percent-encoding is ignored (that cookie is treated as absent → 401), never a 500 (R1-08).
  function parseCookies(req) {
    const out = Object.create(null);
    (req.headers.cookie || '').split(';').forEach((c) => {
      const i = c.indexOf('='); if (i < 0) return;
      try { out[c.slice(0, i).trim()] = decodeURIComponent(c.slice(i + 1).trim()); } catch (_) { /* malformed: ignore */ }
    });
    return out;
  }
  function sessionOf(req) { return verifySession(parseCookies(req)[COOKIE]); }
  function requireAuth(req, res, next) { const s = sessionOf(req); if (!s) return res.status(401).json({ error: 'unauthorized' }); req.session = s; next(); }
  const onRevoke = (fn) => revokeListeners.push(fn);

  // POST /api/login, POST /api/logout, GET /api/me
  function mountRoutes(app, { isGwConnected }) {
    const record = (req, outcome, detail, personId = null) => {
      if (!audit) return;
      try { audit({ at: Date.now(), requestId: req.requestId || 'req_unknown', actor: personId ? { kind: 'human', personId } : { kind: 'anonymous' }, command: 'auth.login', target: null, outcome, detail }); } catch (_) { /* audit never blocks a login */ }
    };
    app.post('/api/login', async (req, res) => {
      if (!req.is('application/json')) { record(req, 'rejected', 'not-json'); return res.status(415).json({ error: 'Requête JSON attendue.' }); }
      const ip = req.ip || (req.socket && req.socket.remoteAddress) || 'unknown';
      const gate = throttle.reserve(ip);   // R16-01: reserved synchronously, BEFORE scrypt runs
      if (!gate.ok) {
        record(req, 'rejected', 'throttled-' + gate.scope);
        res.setHeader('Retry-After', String(gate.retryAfterSec));
        return res.status(429).json({ error: 'Trop de tentatives. Réessayez dans quelques minutes.', retryAfterSec: gate.retryAfterSec });
      }
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const email = typeof body.email === 'string' ? body.email.toLowerCase().trim().slice(0, 320) : '';
      const password = typeof body.password === 'string' ? body.password : '';
      const account = credential ? credential(email) : null;
      const emailOk = credential ? !!account && account.role === 'owner' : crypto.timingSafeEqual(digest(email), emailDigest);
      let passwordOk = false;
      // Unknown DB e-mails still pay the same scrypt cost as the owner.
      try { passwordOk = await verifyPassword(password, credential ? (account || credential(null))?.password_hash : await theHash()); } finally { /* released below */ }
      if (!emailOk || !passwordOk) {
        gate.release(false);   // the attempt was already counted at admission
        record(req, 'rejected', 'invalid-credentials');
        return res.status(401).json({ error: 'Identifiants invalides.' });
      }
      gate.release(true);
      record(req, 'ok', null, ownerPersonId());
      const cookie = signSession({ email, ...(credential ? { userId: account.id } : {}), exp: Date.now() + ttlMs, sid: crypto.randomBytes(16).toString('hex') });
      res.setHeader('Set-Cookie', COOKIE + '=' + cookie + attrs(ttlMs / 1000));
      res.json({ ok: true, email });
    });
    app.post('/api/logout', (req, res) => {
      const s = sessionOf(req);
      if (s && s.sid && revocations) revocations.revoke(s.sid, s.exp);
      if (s) for (const fn of revokeListeners) { try { fn(s); } catch (_) {} }
      res.setHeader('Set-Cookie', COOKIE + '=' + attrs(0));
      res.json({ ok: true });
    });
    app.get('/api/me', (req, res) => { const s = sessionOf(req); if (!s) return res.status(401).json({ error: 'unauthorized' }); res.json({ email: s.email, gwConnected: isGwConnected() }); });
  }

  // R16-05: a login refused before the route (media type, CSRF, unparsable body) counts and is audited like a failure
  function loginRefused(req, detail) {
    const ip = req.ip || (req.socket && req.socket.remoteAddress) || 'unknown';
    throttle.failure(ip);
    if (!audit) return;
    try { audit({ at: Date.now(), requestId: req.requestId || 'req_unknown', actor: { kind: 'anonymous' }, command: 'auth.login', target: null, outcome: 'rejected', detail }); } catch (_) { /* never blocks */ }
  }

  return { signSession, verifySession, parseCookies, sessionOf, requireAuth, onRevoke, mountRoutes, cookieSecure, loginRefused };
}

module.exports = { createAuth, COOKIE };
