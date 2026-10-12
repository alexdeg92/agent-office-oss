'use strict';
// The same native/composed identity policy at admission and union projection.
// This returns declared field paths only, never a payload value or exception.
const { validNativeId } = require('../runtime-ids');
function identityIssue(type, row) {
  let issue = null;
  const check = (value, field, required = false) => { if ((!required && value == null) || issue) return; if (!validNativeId(value)) issue = field; };
  const fields = map => { for (const [field, required] of Object.entries(map)) check(row?.[field], '.' + field, required); };
  const sender = (raw, field) => {
    if (!raw) return;
    check(raw.kind === 'agent' && typeof raw.id === 'string' ? raw.id.replace(/^agent:/, '') : raw.id, field + '.id', true);
    check(raw.delegation?.sessionKey, field + '.delegation.sessionKey');
  };
  switch (type) {
    case 'agent': fields({ id: true, mainSessionKey: false }); break;
    case 'session':
      fields({ key: true, sessionId: false, parentKey: false, group: false });
      for (const field of ['agentId', 'heartbeatOf', 'subagentId', 'cronJobId']) check(row?.class?.[field], '.class.' + field);
      check(row?.run?.lastRunId, '.run.lastRunId');
      for (const key of row?.childKeys || []) check(key, '.childKeys[]', true);
      break;
    case 'cronJob': fields({ id: true, agentId: false, sessionKey: false }); break;
    case 'cronRun': fields({ id: true, jobId: true, sessionKey: false }); break;
    case 'skill': case 'skillInfo': fields({ name: true }); break;
    case 'channel': case 'sessionGroup': fields({ id: true }); break;
    case 'transcript':
      fields({ sessionKey: true });
      for (const p of row?.participants || []) sender(p, '.participants[]');
      for (const e of row?.events || []) {
        check(e.id, '.events[].id', true);
        check(JSON.stringify([row.sessionKey, e.id]), '.events[].id', true);
        if (e.callId != null) { check(e.callId, '.events[].callId', true); check(JSON.stringify([row.sessionKey, e.callId]), '.events[].callId', true); }
        sender(e.senderInfo, '.events[].senderInfo');
      }
      break;
  }
  return issue;
}
module.exports = { identityIssue };
