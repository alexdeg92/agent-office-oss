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
  throttle = createLoginThrottle(), audit = null, ownerPersonId = () => null, credential = null, credentialGeneration = () => 0,
  identity = null, allowMultiUser = false }) {
  // the hash to verify against: the configured one, else the plaintext's (hashed once, lazily)
  let hashReady = null;
  const theHash = () => hashReady || (hashReady = passwordHash ? Promise.resolve(passwordHash) : loginPassword ? hashPassword(loginPassword) : Promise.resolve(null));
  const digest = (x) => crypto.createHmac('sha256', secret).update('login-email:' + String(x)).digest();
  const emailDigest = digest(String(loginEmail || '').toLowerCase().trim());
  const revokeListeners = [];
  let humanAccess=null;
  const attrs = (maxAgeSec) => '; HttpOnly; SameSite=Lax; Path=/; Max-Age=' + maxAgeSec + (cookieSecure ? '; Secure' : '');
  const legacyId=cookie=>'legacy:'+crypto.createHash('sha256').update(cookie).digest('base64url');
  const generationOf=account=>identity ? account?.auth_generation : credentialGeneration();
  const readAccount=email=>identity ? identity.users.credential(email) : credential?.(email);
  const hashOf=async account=>identity ? account?.credential_source==='env' ? theHash() : account?.password_hash || identity.users.owner()?.password_hash || theHash() : credential ? (account || credential(null))?.password_hash : theHash();
  function currentAccount(session) {return identity ? identity.users.byId(session?.userId) : credential?.(null);}
  function signSession(payload) {
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const mac = crypto.createHmac('sha256', secret).update(body).digest('base64url');
    return body + '.' + mac;
  }
  function verifySession(cookie) {
    if (!cookie) return null;
    if (typeof cookie !== 'string' || cookie.length > 4096) return null;
    const parts=cookie.split('.');if(parts.length!==2)return null;
    const [body, mac] = parts; if (!body || !mac) return null;
    const good = crypto.createHmac('sha256', secret).update(body).digest('base64url');
    let ok = false; try { ok = crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(good)); } catch (_) { return null; }
    if (!ok) return null;
    let p; try { p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); } catch (_) { return null; }
    if (!p || typeof p !== 'object' || !Number.isFinite(p.exp) || p.exp <= Date.now()) return null;
    if (p.sid != null && (typeof p.sid !== 'string' || (revocations && revocations.isRevoked(p.sid)))) return null;
    if(identity) {
      let account;
      if(p.userId==null) {
        const state=identity.state();account=identity.users.byId(state.owner_user_id);
        if(!state.legacy_cookie_deadline||Date.now()>=state.legacy_cookie_deadline||p.exp>state.legacy_cookie_deadline
          ||state.legacy_cookie_generation!==0||account?.auth_generation!==0||(p.authGeneration??0)!==0) return null;
        p.userId=account.id;p.authGeneration=0;p.legacy=true;
      } else account=identity.users.byId(p.userId);
      if(!account||account.status!=='active'||(!allowMultiUser&&account.id!==identity.users.owner()?.id)||!Number.isSafeInteger(p.authGeneration??0)||(p.authGeneration??0)!==account.auth_generation)return null;
      if(p.sid==null) {p.legacyId=legacyId(cookie);if(revocations?.isRevoked(p.legacyId))return null;}
      p.email=account.email;p.personId=account.person_id;
    } else {
      if (credential && (p.userId !== credential(null)?.id || credential(null)?.status!=='active' || (p.authGeneration || 0) !== credentialGeneration())) return null;
      if (credential) p.email = credential(null).email;
    }
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
  function sessionOf(req) {
    if(Object.hasOwn(req.headers,'authorization'))return humanAccess?.resolve(req)||null;
    if(humanAccess&&!humanAccess.cookieAllowed(req))return null;
    return verifySession(parseCookies(req)[COOKIE]);
  }
  function useHumanAccess(value) {
    if(humanAccess||typeof value?.resolve!=='function'||typeof value?.cookieAllowed!=='function')throw new Error('invalid human credential resolver');
    humanAccess=value;
  }
  function upgradeLegacySession(req,res,session) {
    if(!identity||!session?.legacy||res.headersSent)return;
    req.session={...session,...(!session.sid&&session.legacyId?{sid:session.legacyId}:{})};
    refreshSession(req,res);
  }
  function requireAuth(req, res, next) { const s = sessionOf(req); if (!s) return res.status(401).json({ error: 'unauthorized' }); req.session = s; upgradeLegacySession(req,res,s);next(); }
  const onRevoke = (fn) => revokeListeners.push(fn);
  // Public credential-link acceptance uses the same IP/global/in-flight budget before body parsing.
  const admitted=new WeakMap();
  function credentialAdmission(req,workOnly) {
    const gate=(workOnly?throttle.reserveWork:throttle.reserve)(req.ip||req.socket?.remoteAddress||'unknown');
    if(gate.ok) {
      const state={req,released:false,started:false,hashing:false,verified:false,workOnly,beginPassword:gate.beginPassword,release:gate.release};admitted.set(gate,state);
      delete gate.beginPassword;
      gate.release=success=>{if(state.released)return;state.released=true;if(!state.hashing)state.release(success&&(!workOnly||state.verified));};
    }
    return gate;
  }
  const reserveCredentialAttempt=req=>credentialAdmission(req,false);
  const reserveCredentialWork=req=>credentialAdmission(req,true);
  // No public handler may start a credential derivation without a live admission
  // from this auth instance, bound to that exact request. The transport keeps the
  // slot through hashing and checks connection/timeout before committing login.
  async function verifyAdmittedCredentials(req,{email,password},gate) {
    const admission=admitted.get(gate);
    if(!admission||admission.req!==req||admission.released||admission.started)throw new Error('credential verification requires current admission');
    admission.started=true;
    if(admission.workOnly) {const rate=admission.beginPassword();if(!rate.ok)return {ok:false,retryAfterSec:rate.retryAfterSec};}
    email=typeof email==='string'?email.toLowerCase().trim():'';password=typeof password==='string'?password:'';
    const account=readAccount(email),generation=generationOf(account);
    const emailOk=identity ? !!account&&account.status==='active'&&(account.credential_source==='database'||account.credential_source==='env'&&account.id===identity.users.owner()?.id)&&(allowMultiUser||account.id===identity.users.owner()?.id)
      : credential ? !!account&&account.id===credential(null)?.id&&account.status==='active' : crypto.timingSafeEqual(digest(email),emailDigest);
    // Unknown/unsupported users still perform the owner's normal derivation.
    let passwordOk;admission.hashing=true;
    try {passwordOk=await verifyPassword(password,await hashOf(account));}
    finally {admission.hashing=false;if(admission.released)admission.release(false);}
    const latest=identity?identity.users.byId(account?.id):credential?.(null);
    if(admission.released||!emailOk||!passwordOk||(identity||credential)&&(generation!==generationOf(latest)||latest?.status!=='active'||latest?.id!==account?.id||latest?.email!==account?.email||latest?.credential_source!==account?.credential_source||latest?.password_hash!==account?.password_hash))return {ok:false};
    admission.verified=true;
    return {ok:true,identity:{email,...(identity||credential?{userId:account.id,personId:account.person_id,authGeneration:generation}:{})}};
  }

  // POST /api/login, POST /api/logout, GET /api/me
  function mountRoutes(app, { isGwConnected }) {
    const record = (req, outcome, detail, personId = null) => {
      if (!audit) return;
      try { audit({ at: Date.now(), requestId: req.requestId || 'req_unknown', actor: personId ? { kind: 'human', personId } : { kind: 'anonymous' }, command: 'auth.login', target: null, outcome, detail }); } catch (_) { /* audit never blocks a login */ }
    };
    app.post('/api/login', async (req, res) => {
      if (!req.is('application/json')) { record(req, 'rejected', 'not-json'); return res.status(415).json({ error: 'Requête JSON attendue.' }); }
      const gate = reserveCredentialAttempt(req);   // R16-01: reserved synchronously, BEFORE scrypt runs
      if (!gate.ok) {
        record(req, 'rejected', 'throttled-' + gate.scope);
        res.setHeader('Retry-After', String(gate.retryAfterSec));
        return res.status(429).json({ error: 'Trop de tentatives. Réessayez dans quelques minutes.', retryAfterSec: gate.retryAfterSec });
      }
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const email = typeof body.email === 'string' ? body.email.toLowerCase().trim().slice(0, 320) : '';
      const password = typeof body.password === 'string' ? body.password : '';
      let verified;
      try {verified=await verifyAdmittedCredentials(req,{email,password},gate);}
      finally {gate.release(verified?.ok===true);}
      if(!verified.ok) {
        record(req,'rejected','invalid-credentials');
        return res.status(401).json({error:'Identifiants invalides.'});
      }
      const binding=verified.identity;
      record(req,'ok',null,identity?binding.personId:ownerPersonId());
      identity?.users.touchSeen(binding.userId);
      const cookie=signSession({email:binding.email,...(identity||credential?{userId:binding.userId,authGeneration:binding.authGeneration}:{}),exp:Date.now()+ttlMs,sid:crypto.randomBytes(16).toString('hex')});
      res.setHeader('Set-Cookie',COOKIE+'='+cookie+attrs(ttlMs/1000));
      res.json({ ok: true, email });
    });
    app.post('/api/logout', (req, res) => {
      const s = sessionOf(req);
      if (s && s.sid && revocations) revocations.revoke(s.sid, s.exp);
      if (s && s.legacyId && revocations) revocations.revoke(s.legacyId, s.exp);
      if (s) for (const fn of revokeListeners) { try { fn(s); } catch (_) {} }
      res.setHeader('Set-Cookie', COOKIE + '=' + attrs(0));
      res.json({ ok: true });
    });
    app.get('/api/me', (req, res) => { const s = sessionOf(req); if (!s) return res.status(401).json({ error: 'unauthorized' }); upgradeLegacySession(req,res,s);res.json({ email: s.email, gwConnected: isGwConnected() }); });
  }

  // R16-05: a login refused before the route (media type, CSRF, unparsable body) counts and is audited like a failure
  function loginRefused(req, detail) {
    const ip = req.ip || (req.socket && req.socket.remoteAddress) || 'unknown';
    throttle.failure(ip);
    if (!audit) return;
    try { audit({ at: Date.now(), requestId: req.requestId || 'req_unknown', actor: { kind: 'anonymous' }, command: 'auth.login', target: null, outcome: 'rejected', detail }); } catch (_) { /* never blocks */ }
  }

  async function confirmPassword(req, password) {
    const gate = throttle.reserve(req.ip || req.socket?.remoteAddress || 'unknown');
    if (!gate.ok) return { ok: false, rateLimit: gate };
    let valid = false;const session=sessionOf(req),account=currentAccount(session),generation=generationOf(account);
    try {
      valid = await verifyPassword(password, await hashOf(account));
      if(identity) {
        const current=currentAccount(sessionOf(req));
        const eligible=account?.credential_source==='database' || account?.credential_source==='env' && account.id===identity.users.owner()?.id;
        valid=valid && eligible && !!session && current?.status==='active' && current?.id===account?.id && current?.auth_generation===generation && current?.password_hash===account?.password_hash && current?.credential_source===account?.credential_source;
      }
    }
    finally { gate.release(valid); }
    return { ok: valid };
  }
  function refreshSession(req, res, { revokeOthers = false } = {}) {
    const old = req.session;
    // A bearer mutation cannot mint ambient cookie authority or silently upgrade
    // its revoked generation. The next token login establishes fresh authority.
    if(old?.familyId)return;
    const current = currentAccount(old);
    const session = { ...old, email: current?.email || old.email, ...(current ? { userId: current.id } : {}), ...(identity || credential ? { authGeneration: generationOf(current) } : {}) };
    delete session.legacy;delete session.legacyId;
    req.session = session;
    res.setHeader('Set-Cookie', COOKIE + '=' + signSession(session) + attrs(Math.max(0, Math.floor((session.exp - Date.now()) / 1000))));
    if (revokeOthers) for (const fn of revokeListeners) { try { fn({ allExcept: old.sid, ...(current ? {userId:current.id} : {}) }); } catch (_) {} }
  }

  const useDatabase = (read, generation) => { credential = read; credentialGeneration = generation; };
  return { useDatabase, useHumanAccess, signSession, verifySession, parseCookies, sessionOf, requireAuth, onRevoke, mountRoutes, cookieSecure, loginRefused, confirmPassword, refreshSession, upgradeLegacySession, reserveCredentialAttempt, reserveCredentialWork, verifyAdmittedCredentials };
}

module.exports = { createAuth, COOKIE };
