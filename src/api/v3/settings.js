'use strict';
const { ApiError } = require('../v2/errors');
function mountSettings({ r, settings, auth, authed, ok, check, reauthentication = null, externalAccess = null }) {
  const owner = (req, res, next) => {
    if (req.apiVersion !== 3) return next(new ApiError('not_found'));
    const session = auth.sessionOf(req);
    if (req.principal || !session) return next(new ApiError('unauthorized'));
    req.session = session; next();
  };
  r.get('/settings/recovery', authed, owner, (req,res,next) => {
    if(!req.session?.recoveryOnly)return next(new ApiError('not_found'));
    try { return res.json(require('../v2/envelope').okBody({recovery:settings.recoveryVm(req)})); }
    catch(error){return next(error);}
  });
  r.get('/settings', authed, owner, (req, res) => ok(res, settings.vm(req), null, 'settings'));
  if (externalAccess) {
    const respond = (res, result) => res.json(require('../v2/envelope').okBody({ ok: true, result, revision: null, vm: null }));
    const strict = (req, allowed) => {
      const body = req.body;
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw require('../v2/errors').invalid(null, 'invalid-body');
      for (const key of Object.keys(body)) if (!allowed.includes(key)) throw require('../v2/errors').invalid(key, 'unexpected-field');
      return body;
    };
    const v3 = (req, res, next) => req.apiVersion === 3 ? next() : next(new ApiError('not_found'));
    const accessOp = fn => async (req, res, next) => { try { await fn(req, res); } catch (error) { next(error); } };
    r.get('/settings/access', authed, owner, v3, (req, res) => res.json(require('../v2/envelope').okBody(externalAccess.stateVm())));
    r.post('/settings/access/plan', authed, owner, v3, accessOp(async (req, res) => {
      const b = strict(req, ['settingsRevision', 'draft']);
      respond(res, await externalAccess.createPlan({ req, draft: b.draft, expectedRevision: b.settingsRevision }));
    }));
    r.post('/settings/access/checks', authed, owner, v3, accessOp(async (req, res) => {
      const b = strict(req, ['planId', 'checks']); respond(res, externalAccess.startChecks({ req, planId: b.planId, checks: b.checks }));
    }));
    r.post('/settings/access/checks/status', authed, owner, v3, accessOp(async (req, res) => {
      const b = strict(req, ['jobId']); respond(res, externalAccess.status({ req, jobId: b.jobId }));
    }));
    r.post('/settings/access/checks/cancel', authed, owner, v3, accessOp(async (req, res) => {
      const b = strict(req, ['jobId']); respond(res, externalAccess.cancel({ req, jobId: b.jobId }));
    }));
    r.post('/settings/access/apply', authed, owner, v3, accessOp(async (req, res) => {
      const b = strict(req, ['planId', 'settingsRevision', 'confirmation']);
      if (!b.confirmation || typeof b.confirmation !== 'object' || Array.isArray(b.confirmation)
        || Object.keys(b.confirmation).some(key => key !== 'configDigest') || typeof b.confirmation.configDigest !== 'string') throw require('../v2/errors').invalid('confirmation', 'invalid');
      const published = await externalAccess.applySettings({ req, planId: b.planId, expectedRevision: b.settingsRevision, digest: b.confirmation.configDigest,
        publish: async candidate => {
          const original = req.body;
          req.body = { expectedRevision: candidate.expectedRevision, draft: candidate.draft, configDigest: candidate.configDigest };
          try { return await settings.run('access', req, res); } finally { req.body = original; }
        } });
      // The publisher acknowledgement only describes the write operation. Return
      // the canonical state after the commit so clients can distinguish saved
      // configuration from the policy currently active in this process.
      const vm = externalAccess.stateVm();
      respond(res, { vm, changed: published?.result?.changed || [], restartRequired: vm.restartRequired });
    }));
  }
  const command = name => async (req, res, next) => { try {
    const result=await settings.run(name, req, res);
    // A committed self credential change invalidates the incoming cookie. Return only its accepted acknowledgement.
    if(req.accountCommitted&&['owner','password'].includes(name))return res.json(require('../v2/envelope').okBody(result));
    if(result.vm&&!req.authorize) result.vm=check(result.vm); ok(res,result);
  } catch (e) { next(e); } };
  r.post('/settings/restart', authed, owner, command('restart'));
  r.post('/settings/fix-all', authed, owner, command('fixAll'));
  r.post('/settings/reauth', authed, owner, reauthentication?async(req,res,next)=>{try{
    const body=req.body;
    if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).some(key=>key!=='password'))throw require('../v2/errors').invalid(null,'invalid-body');
    const result=await reauthentication.confirm(req,body.password,res);
    ok(res,{ok:true,result,revision:null,vm:null});
  }catch(error){next(error);}}:command('reauth'));
  r.post('/settings/check', authed, owner, command('check'));
  r.post('/settings/detect', authed, owner, command('detect'));
  r.post('/settings/herdr/check', authed, owner, command('herdrCheck'));
  r.put('/settings/agents', authed, owner, command('agents'));
  r.put('/settings/auto-add', authed, owner, command('autoAdd'));
  r.put('/settings/runtime', authed, owner, command('runtime'));
  r.put('/settings/runtimes', authed, owner, command('runtimes'));
  r.put('/settings/instance', authed, owner, command('instance'));
  r.put('/settings/network', authed, owner, command('network'));
  r.put('/settings/owner', authed, owner, command('owner'));
  r.post('/settings/password', authed, owner, command('password'));
  r.post('/settings/integrations/plan', authed, owner, command('integrationPlan'));
  r.post('/settings/integrations/apply', authed, owner, command('integrationApply'));
}
module.exports = { mountSettings };
