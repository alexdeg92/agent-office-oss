'use strict';
const crypto=require('node:crypto');
const {withTx}=require('../tx'),{mintId}=require('../ids');
const {HUMAN_TOKEN_SECURITY}=require('../../security/human-token-policy');
const ACCESS_MS=HUMAN_TOKEN_SECURITY.accessTokenMinutes*60000,IDLE_MS=HUMAN_TOKEN_SECURITY.refreshIdleHours*3600000,
  ABSOLUTE_MS=HUMAN_TOKEN_SECURITY.refreshAbsoluteDays*86400000,CHALLENGE_MS=120000;
const STREAM_TICKET_MS=30000,MAX_STREAM_TICKETS=4096,MAX_FAMILY_TICKETS=64;
const REASONS=new Set(['logout','reuse','logout-everywhere','credentials-changed','origin-removed','audience-changed','login-replaced','expired']);
const digest=token=>crypto.createHash('sha256').update(token).digest('hex');
const mint=prefix=>prefix+crypto.randomBytes(32).toString('base64url');
function originOf(value) {
  if(typeof value!=='string'||value.length>512)throw new TypeError('invalid token origin');
  let url;try{url=new URL(value);}catch{throw new TypeError('invalid token origin');}
  if(url.protocol!=='https:'||url.hostname.includes('*')||url.username||url.password||url.search||url.hash||url.pathname!=='/'||url.origin!==value)throw new TypeError('invalid token origin');
  return value;
}
const audienceOf=value=>{if(typeof value!=='string'||!value||value.length>1024||/[\x00-\x20\x7f]/.test(value))throw new TypeError('invalid token audience');return value;};
const failure=issue=>({ok:false,issue});
// Trusted persistence API only. No HTTP endpoint or bearer gate is enabled by this repository.
function createHumanTokensRepo(db,{rbac,sessions,now=Date.now,changed=()=>{}}) {
  const family=db.prepare('SELECT * FROM auth_families WHERE id=?');
  const access=db.prepare('SELECT * FROM human_access_tokens WHERE digest=?');
  const refresh=db.prepare('SELECT * FROM refresh_tokens WHERE digest=?'),challenge=db.prepare('SELECT * FROM auth_bootstrap_challenges WHERE digest=?'),ticket=db.prepare('SELECT * FROM stream_tickets WHERE digest=?');
  const validToken=(raw,prefix)=>typeof raw==='string'&&new RegExp('^'+prefix+'[A-Za-z0-9_-]{43}$').test(raw);
  const refreshRow=raw=>validToken(raw,'ao_rt_')?refresh.get(digest(raw)):null;
  function clock(){const at=now();if(!Number.isSafeInteger(at)||at<0)throw new TypeError('invalid token clock');return at;}
  function tx(fn){if(db.isTransaction)throw new Error('token mutation requires its own transaction');return withTx(db,fn);}
  function active(f,at,audience) {
    if(!f||f.revoked_at!==null||f.audience!==audience||at<f.created_at||at>=f.idle_expires_at||at>=f.absolute_expires_at||sessions.isRevoked(f.session_id))return null;
    const s=rbac.snapshot(f.user_id);
    return s?.user.status==='active'&&s.user.auth_generation===f.auth_generation?s:null;
  }
  function writeAccess(f,s,at,ttlMs) {
    const token=mint('ao_at_'),expiresAt=Math.min(at+ttlMs,f.idle_expires_at,f.absolute_expires_at);
    db.prepare('INSERT INTO human_access_tokens(id,digest,family_id,user_id,session_id,audience,issued_at,expires_at,auth_generation,role_id,role_revision,permission_revision,registry_revision) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(mintId('hat'),digest(token),f.id,f.user_id,f.session_id,f.audience,at,expiresAt,s.user.auth_generation,s.user.role_id,s.role.revision,s.user.permission_revision,s.registryRevision);
    return {token,expiresAt};
  }
  function lifetime(value,min,max){if(!Number.isSafeInteger(value)||value<min||value>max)throw new TypeError('invalid token lifetime');return value;}
  function familyOptions(options) {
    if(options?.recoveryOnly===true)throw new TypeError('recovery-only identity cannot create token families');
    let {userId,expectedGeneration,origin,audience,accessTtlMs=ACCESS_MS,idleMs=IDLE_MS,absoluteMs=ABSOLUTE_MS,linkedCookieSid=null,linkedCookieExpiresAt=null}=options||{};
    origin=originOf(origin);audience=audienceOf(audience);
    lifetime(accessTtlMs,300000,900000);lifetime(idleMs,300000,86400000);lifetime(absoluteMs,idleMs,2592000000);
    if(!Number.isSafeInteger(expectedGeneration)||expectedGeneration<0||linkedCookieSid!==null&&(typeof linkedCookieSid!=='string'||!linkedCookieSid||linkedCookieSid.length>256)
      ||linkedCookieSid===null&&linkedCookieExpiresAt!==null||linkedCookieExpiresAt!==null&&!Number.isSafeInteger(linkedCookieExpiresAt))throw new TypeError('invalid token identity');
    return {userId,expectedGeneration,origin,audience,accessTtlMs,idleMs,absoluteMs,linkedCookieSid,linkedCookieExpiresAt};
  }
  function createInside(options,at) {
    const {userId,expectedGeneration,origin,audience,accessTtlMs,idleMs,absoluteMs,linkedCookieSid,linkedCookieExpiresAt}=options;
    const s=rbac.snapshot(userId);if(s?.user.status!=='active'||s.user.auth_generation!==expectedGeneration)return failure('unauthorized');
    if(!Number.isSafeInteger(at+absoluteMs)||linkedCookieExpiresAt!==null&&linkedCookieExpiresAt<=at)throw new TypeError('invalid token clock');
    const id=mintId('fam'),sessionId='family:'+id;
    const f={id,user_id:userId,session_id:sessionId,origin,audience,auth_generation:expectedGeneration,created_at:at,authenticated_at:at,last_used_at:at,idle_expires_at:at+idleMs,absolute_expires_at:at+absoluteMs,linked_cookie_sid:linkedCookieSid,linked_cookie_expires_at:linkedCookieExpiresAt};
    db.prepare('INSERT INTO auth_families(id,user_id,session_id,origin,audience,auth_generation,created_at,authenticated_at,last_used_at,idle_expires_at,absolute_expires_at,linked_cookie_sid,linked_cookie_expires_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(id,userId,sessionId,origin,audience,expectedGeneration,at,at,at,f.idle_expires_at,f.absolute_expires_at,linkedCookieSid,linkedCookieExpiresAt);
    const issued=writeAccess(f,s,at,accessTtlMs),refreshToken=mint('ao_rt_');
    db.prepare('INSERT INTO refresh_tokens(id,digest,family_id,created_at,expires_at) VALUES (?,?,?,?,?)').run(mintId('rft'),digest(refreshToken),id,at,f.absolute_expires_at);
    return {ok:true,familyId:id,sessionId,accessToken:issued.token,accessExpiresAt:issued.expiresAt,refreshToken,refreshExpiresAt:f.absolute_expires_at};
  }
  function createFamily(options) {
    const validated=familyOptions(options);return tx(()=>createInside(validated,clock()));
  }
  function resolveAccess(token,{audience,origin}={}) {
    try{originOf(origin);}catch{return failure('unauthorized');}
    if(typeof token!=='string'||!/^ao_at_[A-Za-z0-9_-]{43}$/.test(token))return failure('unauthorized');
    const row=access.get(digest(token)),at=clock();
    if(!row||row.revoked_at!==null||row.audience!==audience||at>=row.expires_at||at<row.issued_at)return failure('unauthorized');
    const f=family.get(row.family_id),s=active(f,at,audience);
    if(!s||row.user_id!==f.user_id||row.session_id!==f.session_id||row.auth_generation!==s.user.auth_generation||origin!==f.origin)return failure('unauthorized');
    if(row.role_id!==s.user.role_id||row.role_revision!==s.role.revision||row.permission_revision!==s.user.permission_revision||row.registry_revision!==s.registryRevision)return failure('access-stale');
    return {ok:true,session:{userId:s.user.id,personId:s.user.person_id,email:s.user.email,authGeneration:s.user.auth_generation,sid:f.session_id,familyId:f.id,origin:f.origin,audience,exp:row.expires_at}};
  }
  function createStreamTicket({userId,familyId,sessionId,origin,audience,topics,fingerprint,sessionExpiresAt,resume=null}) {
    try{origin=originOf(origin);audience=audienceOf(audience);}catch{return failure('unauthorized');}
    if(typeof userId!=='string'||typeof familyId!=='string'||typeof sessionId!=='string'||typeof fingerprint!=='string'||!fingerprint||fingerprint.length>256
      ||!Number.isSafeInteger(sessionExpiresAt)||!Array.isArray(topics)||topics.length<1||topics.length>32||topics.some(t=>typeof t!=='string'||!t||t.length>300)||new Set(topics).size!==topics.length
      ||JSON.stringify(topics).length>12000||resume!==null&&(typeof resume!=='object'||Array.isArray(resume)||JSON.stringify(resume).length>1024))throw new TypeError('invalid stream ticket');
    const result=tx(()=>{
      const at=clock(),f=family.get(familyId),s=active(f,at,audience);
      if(!s||f.user_id!==userId||f.session_id!==sessionId||f.origin!==origin||fingerprint!==rbac.fingerprint(userId)||sessionExpiresAt<=at)return failure('unauthorized');
      db.prepare('DELETE FROM stream_tickets WHERE expires_at<=?').run(at);
      if(Number(db.prepare('SELECT COUNT(*) AS n FROM stream_tickets WHERE expires_at>? AND revoked_at IS NULL').get(at).n)>=MAX_STREAM_TICKETS
        ||Number(db.prepare('SELECT COUNT(*) AS n FROM stream_tickets WHERE family_id=? AND expires_at>? AND revoked_at IS NULL').get(familyId,at).n)>=MAX_FAMILY_TICKETS)return failure('limited');
      const raw=mint('ao_st_'),expiresAt=Math.min(at+STREAM_TICKET_MS,sessionExpiresAt,f.idle_expires_at,f.absolute_expires_at);
      if(expiresAt<=at)return failure('unauthorized');
      db.prepare('INSERT INTO stream_tickets(id,digest,user_id,family_id,cookie_sid,origin,audience,topics_json,fingerprint,session_expires_at,created_at,expires_at,resume_json) VALUES (?,?,?,?,NULL,?,?,?,?,?,?,?,?)')
        .run(mintId('stt'),digest(raw),userId,familyId,origin,audience,JSON.stringify(topics),fingerprint,sessionExpiresAt,at,expiresAt,resume===null?null:JSON.stringify(resume));
      return {ok:true,ticket:raw,expiresAt,topics:[...topics]};
    });
    return result;
  }
  function consumeStreamTicket({ticket:raw,origin,audience}) {
    try{originOf(origin);audienceOf(audience);}catch{return failure('unauthorized');}
    if(!validToken(raw,'ao_st_'))return failure('unauthorized');
    return tx(()=>{
      const at=clock(),row=ticket.get(digest(raw));
      if(!row||row.consumed_at!==null||row.revoked_at!==null||row.origin!==origin||row.audience!==audience||at<row.created_at||at>=row.expires_at||at>=row.session_expires_at)return failure('unauthorized');
      const f=family.get(row.family_id),s=active(f,at,audience);
      if(!s||f.user_id!==row.user_id||f.origin!==origin||row.fingerprint!==rbac.fingerprint(row.user_id))return failure('unauthorized');
      const topics=JSON.parse(row.topics_json),resume=row.resume_json===null?null:JSON.parse(row.resume_json);
      const changedRows=db.prepare('UPDATE stream_tickets SET consumed_at=? WHERE id=? AND consumed_at IS NULL AND revoked_at IS NULL').run(at,row.id);
      if(changedRows.changes!==1)return failure('unauthorized');
      return {ok:true,userId:row.user_id,familyId:f.id,sessionId:f.session_id,generation:f.auth_generation,roleId:s.user.role_id,
        fingerprint:row.fingerprint,origin:row.origin,audience:row.audience,topics,expiresAt:Math.min(row.session_expires_at,f.idle_expires_at,f.absolute_expires_at),resume};
    });
  }
  // Durable work retains only verified family metadata and the access deadline.
  // It must recheck the persisted family, never reconstruct a bearer credential.
  function validFamilySession({familyId,sessionId,userId,generation,origin,audience}) {
    try{originOf(origin);audienceOf(audience);}catch{return false;}
    const f=family.get(familyId),s=active(f,clock(),audience);
    return !!s&&f.session_id===sessionId&&f.user_id===userId&&f.auth_generation===generation&&f.origin===origin;
  }
  // Call only inside the repository's own transaction; emit after COMMIT. Write linked
  // cookie revocation directly to avoid poisoning the session cache on a rollback.
  function revokeInside(f,reason,at,events) {
    if(!f||f.revoked_at!==null)return false;
    db.prepare('UPDATE auth_families SET revoked_at=?,revoked_reason=? WHERE id=?').run(at,reason,f.id);
    db.prepare('UPDATE human_access_tokens SET revoked_at=? WHERE family_id=? AND revoked_at IS NULL').run(at,f.id);
    db.prepare('UPDATE stream_tickets SET revoked_at=? WHERE family_id=? AND revoked_at IS NULL').run(at,f.id);
    // Historical families without a captured signed-cookie expiry retain their
    // conservative permanent tombstone; newly linked cookies use verified expiry.
    if(f.linked_cookie_sid)db.prepare('INSERT INTO revoked_sessions(sid,expires_at) VALUES (?,?) ON CONFLICT(sid) DO UPDATE SET expires_at=MAX(revoked_sessions.expires_at,excluded.expires_at)').run(f.linked_cookie_sid,f.linked_cookie_expires_at??Number.MAX_SAFE_INTEGER);
    events.push({familyId:f.id,sessionId:f.session_id});
    if(f.linked_cookie_sid)events.push({sessionId:f.linked_cookie_sid});
    return true;
  }
  function revokeFamily(id,reason='logout') {
    if(!REASONS.has(reason))throw new TypeError('invalid family revocation');
    const events=[],result=tx(()=>revokeInside(family.get(id),reason,clock(),events));
    for(const event of events)changed(event);return result;
  }
  // Trusted activation primitive. Own transaction and post-commit events make
  // removal persistent: restoring an allowlist entry cannot revive credentials.
  // Config publication/live gate activation are owned by the calling service.
  function reconcileBoundary({audience,origins,auditWrite=null}) {
    audience=audienceOf(audience);origins=require('../../security/access-boundary').allowedOrigins(origins);
    if(auditWrite!==null&&typeof auditWrite!=='function')throw new TypeError('invalid activation audit');
    const allowed=new Set(origins),events=[],result=tx(()=>{
      const at=clock();let familiesRevoked=0,ticketsRevoked=0;
      for(const f of db.prepare('SELECT * FROM auth_families WHERE revoked_at IS NULL').all()) {
        if(f.audience===audience&&allowed.has(f.origin))continue;
        ticketsRevoked+=Number(db.prepare('SELECT COUNT(*) AS n FROM stream_tickets WHERE family_id=? AND revoked_at IS NULL').get(f.id).n);
        if(revokeInside(f,f.audience===audience?'origin-removed':'audience-changed',at,events))familiesRevoked++;
      }
      for(const ticket of db.prepare('SELECT id,cookie_sid,origin,audience FROM stream_tickets WHERE revoked_at IS NULL').all()) {
        if(ticket.audience===audience&&allowed.has(ticket.origin))continue;
        ticketsRevoked+=Number(db.prepare('UPDATE stream_tickets SET revoked_at=? WHERE id=? AND revoked_at IS NULL').run(at,ticket.id).changes);
        if(ticket.cookie_sid)events.push({sessionId:ticket.cookie_sid});
      }
      // Nonces are an activation epoch, including unbound login challenges whose
      // issuing API audience cannot be reconstructed from a family reference.
      const challengesInvalidated=Number(db.prepare('DELETE FROM auth_bootstrap_challenges').run().changes);
      const summary={familiesRevoked,ticketsRevoked,challengesInvalidated};auditWrite?.(summary);return summary;
    });
    for(const event of events)changed(event);return result;
  }
  function createChallenge({purpose,origin,audience,refreshToken=null,auditWrite=null}) {
    if(!['login','refresh','logout'].includes(purpose))throw new TypeError('invalid challenge purpose');
    origin=originOf(origin);audience=audienceOf(audience);
    return tx(()=>{
      const at=clock(),r=refreshRow(refreshToken),f=r&&family.get(r.family_id);
      // Login has its own admitted password authority and may replace the cookie
      // from another allowed UI origin or a revoked family. Bind any recognized
      // presented local digest so that overwriting that cookie also revokes it.
      const bound=purpose==='login'?r&&f&&r.created_at<=at:r&&f&&r.expires_at>at&&r.created_at<=at&&f.origin===origin&&active(f,at,audience);
      if(purpose!=='login'&&!bound)return failure('unauthorized');
      // A consumed refresh can still obtain a bound challenge: its use detects reuse.
      db.prepare('DELETE FROM auth_bootstrap_challenges WHERE expires_at<=?').run(at);
      if(db.prepare('SELECT COUNT(*) AS n FROM auth_bootstrap_challenges').get().n>=4096||db.prepare('SELECT COUNT(*) AS n FROM auth_bootstrap_challenges WHERE origin=?').get(origin).n>=256
        ||bound&&db.prepare('SELECT COUNT(*) AS n FROM auth_bootstrap_challenges WHERE family_id=?').get(f.id).n>=32)return failure('limited');
      const csrfToken=mint('ao_cs_'),expiresAt=at+CHALLENGE_MS;
      db.prepare('INSERT INTO auth_bootstrap_challenges(id,digest,purpose,origin,family_id,refresh_digest,created_at,expires_at) VALUES (?,?,?,?,?,?,?,?)')
        .run(mintId('abc'),digest(csrfToken),purpose,origin,bound?f.id:null,bound?r.digest:null,at,expiresAt);
      auditWrite?.(null,'ok',null);return {ok:true,csrfToken,expiresAt,purpose};
    });
  }
  function boundary({refreshToken,csrfToken,origin,audience},purpose,at) {
    const r=refreshRow(refreshToken),c=validToken(csrfToken,'ao_cs_')?challenge.get(digest(csrfToken)):null,f=r&&family.get(r.family_id);
    if(!r||!c||!f||c.purpose!==purpose||c.origin!==origin||f.origin!==origin||f.audience!==audience||c.family_id!==f.id||c.refresh_digest!==r.digest
      ||at<c.created_at||at>=c.expires_at||at<r.created_at||at>=r.expires_at)return null;
    return {r,c,f};
  }
  function rotate(options) {
    const {accessTtlMs=ACCESS_MS,idleMs=IDLE_MS}=options;
    lifetime(accessTtlMs,300000,900000);lifetime(idleMs,300000,86400000);
    const events=[],result=tx(()=>{
      const at=clock(),b=boundary(options,'refresh',at);if(!b)return failure('unauthorized');
      const {r,c,f}=b;
      // Order matters: exact replay of the successful request revokes the successor,
      // even though that request already consumed its challenge. Expired/unbound
      // challenges never authorize this path or mutate another family.
      if(r.consumed_at!==null){if(revokeInside(f,'reuse',at,events))options.auditWrite?.(null,'rejected','refresh-reuse');return failure('unauthorized');}
      if(c.consumed_at!==null)return failure('unauthorized');
      const s=active(f,at,options.audience);if(!s)return failure('unauthorized');
      db.prepare('UPDATE auth_bootstrap_challenges SET consumed_at=? WHERE id=?').run(at,c.id);
      db.prepare('UPDATE refresh_tokens SET consumed_at=? WHERE id=?').run(at,r.id);
      const refreshToken=mint('ao_rt_'),id=mintId('rft');
      db.prepare('INSERT INTO refresh_tokens(id,digest,family_id,parent_id,created_at,expires_at) VALUES (?,?,?,?,?,?)').run(id,digest(refreshToken),f.id,r.id,at,f.absolute_expires_at);
      db.prepare('UPDATE refresh_tokens SET successor_id=? WHERE id=?').run(id,r.id);
      f.last_used_at=at;f.idle_expires_at=Math.min(at+idleMs,f.absolute_expires_at);
      db.prepare('UPDATE auth_families SET last_used_at=?,idle_expires_at=? WHERE id=?').run(at,f.idle_expires_at,f.id);
      const issued=writeAccess(f,s,at,accessTtlMs);options.auditWrite?.(s.user,'ok',null);
      return {ok:true,familyId:f.id,sessionId:f.session_id,accessToken:issued.token,accessExpiresAt:issued.expiresAt,refreshToken,refreshExpiresAt:f.absolute_expires_at};
    });
    for(const event of events)changed(event);return result;
  }
  function logout(options) {
    const events=[],result=tx(()=>{
      const at=clock(),b=boundary(options,'logout',at);if(!b)return failure('unauthorized');
      const {r,c,f}=b;
      if(r.consumed_at!==null){if(revokeInside(f,'reuse',at,events))options.auditWrite?.(null,'rejected','refresh-reuse');return failure('unauthorized');}
      const s=active(f,at,options.audience);if(c.consumed_at!==null||!s)return failure('unauthorized');
      db.prepare('UPDATE auth_bootstrap_challenges SET consumed_at=? WHERE id=?').run(at,c.id);
      revokeInside(f,'logout',at,events);options.auditWrite?.(s.user,'ok',null);return {ok:true};
    });
    for(const event of events)changed(event);return result;
  }
  function loginBoundary(options,at) {
    const c=validToken(options.csrfToken,'ao_cs_')?challenge.get(digest(options.csrfToken)):null;
    if(!c||c.purpose!=='login'||c.origin!==options.origin||c.consumed_at!==null||at<c.created_at||at>=c.expires_at)return null;
    const r=refreshRow(options.refreshToken),f=r&&family.get(r.family_id);
    if(c.family_id!==null) {
      if(!r||!f||r.created_at>at||c.family_id!==f.id||c.refresh_digest!==r.digest)return null;
    } else if(r&&f)return null;
    return {c,f};
  }
  // Read-only precheck avoids password work on an invalid nonce. Consumption is
  // rechecked inside loginFamily after the asynchronous derivation.
  function loginChallengeCurrent(options) {
    try{originOf(options.origin);audienceOf(options.audience);}catch{return false;}
    return !!loginBoundary(options,clock());
  }
  // Trusted caller supplies the identity only after admitted password verification.
  // Recheck generation inside the same transaction as nonce consumption, replacement
  // and minting. A verified cookie may link only the new user's current identity.
  function loginFamily(options) {
    const validated=familyOptions({...options,linkedCookieSid:null,linkedCookieExpiresAt:null}),events=[];
    const result=tx(()=>{
      const at=clock(),b=loginBoundary({...options,origin:validated.origin,audience:validated.audience},at);if(!b)return failure('unauthorized');
      const {c,f}=b;
      const s=rbac.snapshot(validated.userId);if(s?.user.status!=='active'||s.user.auth_generation!==validated.expectedGeneration)return failure('unauthorized');
      const cookie=options.cookieSession;
      if(cookie&&cookie.userId===s.user.id&&cookie.authGeneration===s.user.auth_generation&&Number.isSafeInteger(cookie.exp)&&cookie.exp>at) {
        const sid=cookie.sid||cookie.legacyId;
        if(typeof sid==='string'&&sid&&sid.length<=256&&!sessions.isRevoked(sid)) {
          validated.linkedCookieSid=sid;validated.linkedCookieExpiresAt=cookie.exp;
        }
      }
      db.prepare('UPDATE auth_bootstrap_challenges SET consumed_at=? WHERE id=?').run(at,c.id);
      if(f)revokeInside(f,'login-replaced',at,events);
      const issued=createInside(validated,at);
      if(!issued.ok)throw new Error('token identity changed inside transaction');
      if(validated.linkedCookieSid) {
        db.prepare('INSERT INTO revoked_sessions(sid,expires_at) VALUES (?,?) ON CONFLICT(sid) DO UPDATE SET expires_at=MAX(revoked_sessions.expires_at,excluded.expires_at)').run(validated.linkedCookieSid,validated.linkedCookieExpiresAt);
        events.push({sessionId:validated.linkedCookieSid});
      }
      options.auditWrite?.(s.user,'ok',null);return issued;
    });
    for(const event of events)changed(event);return result;
  }
  // Maintenance owns this transaction. Keep all refresh predecessor digests,
  // including revoked/idle-expired ones, until the absolute family deadline.
  function pruneExpired(at) {
    if(!db.isTransaction)throw new Error('token maintenance requires a transaction');
    const challenges=Number(db.prepare('DELETE FROM auth_bootstrap_challenges WHERE expires_at<=?').run(at).changes);
    const tickets=Number(db.prepare('DELETE FROM stream_tickets WHERE expires_at<=?').run(at).changes);
    const families=Number(db.prepare('DELETE FROM auth_families WHERE absolute_expires_at<=?').run(at).changes);
    return {challenges,tickets,families};
  }
  return {createFamily,resolveAccess,validFamilySession,revokeFamily,reconcileBoundary,createChallenge,createStreamTicket,consumeStreamTicket,rotate,logout,loginFamily,loginChallengeCurrent,refreshAuditActor(raw,{origin,audience}){try{originOf(origin);}catch{return null;}const r=refreshRow(raw),f=r&&family.get(r.family_id),at=clock(),s=r&&r.consumed_at===null&&r.created_at<=at&&r.expires_at>at&&f?.origin===origin&&active(f,at,audience);return s?{kind:'human',personId:s.user.person_id}:null;},pruneExpired,refreshAdmissionId:raw=>refreshRow(raw)?.family_id||null};
}
module.exports={createHumanTokensRepo,ACCESS_MS,IDLE_MS,ABSOLUTE_MS,CHALLENGE_MS};
