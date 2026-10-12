'use strict';
// Gateway endpoints can contain secrets in every URL component, including the
// hostname/path. Keep the endpoint entirely out of this diagnostic record.
function gatewayStartupLine({ loginEmail }) {
  const email = String(loginEmail ?? '').replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029]/g, ' ');
  return 'Gateway: endpoint omitted  ·  login: ' + email;
}
module.exports = { gatewayStartupLine };
