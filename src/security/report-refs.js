'use strict';

const crypto = require('crypto');

// An issuer owns the WeakSet that brands the only reference objects accepted
// by the public projection. Source rows cannot brand a path-shaped string by
// matching its syntax. The lookup itself remains in a separate private map.
function createReportRefIssuer({ randomBytes = crypto.randomBytes } = {}) {
  const issued = new WeakSet();
  return Object.freeze({
    issue() {
      const token = randomBytes(24).toString('base64url');
      if (!/^[A-Za-z0-9_-]{32}$/.test(token)) throw new TypeError('invalid random report reference');
      const displayName = Object.freeze({ key: 'team.report' });
      const ref = Object.freeze({ id: `rpt_${token}`, displayName });
      issued.add(ref);
      return ref;
    },
    isIssued(ref) {
      return !!ref && typeof ref === 'object' && issued.has(ref)
        && Object.keys(ref).length === 2 && /^rpt_[A-Za-z0-9_-]{32}$/.test(ref.id)
        && ref.displayName && Object.keys(ref.displayName).length === 1 && ref.displayName.key === 'team.report';
    },
  });
}

module.exports = { createReportRefIssuer };
