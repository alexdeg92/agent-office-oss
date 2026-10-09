'use strict';
// A destination and its credential are selected together. Local credentials never
// fill a remote URL; an env override reuses config credentials only at the same URL.
const secret = value => typeof value === 'string' && value ? value : null;
function cleanUrl(value, secrets = []) {
  try {
    const u = new URL(value);
    if (!['ws:', 'wss:'].includes(u.protocol)) return null;
    for (const token of secrets.filter(Boolean)) {
      if (u.hostname.toLowerCase().includes(token.toLowerCase()) || u.pathname.includes(token) || u.pathname.includes(encodeURIComponent(token))) return null;
    }
    u.username = ''; u.password = ''; u.search = ''; u.hash = '';
    return u.origin + (u.pathname === '/' ? '' : u.pathname);
  } catch { return null; }
}
function connection(env, config = {}) {
  const rawPort = Number(config.gateway?.port), port = Number.isInteger(rawPort) && rawPort > 0 && rawPort <= 65535 ? rawPort : 18789;
  const tokens = [secret(env.OC_GATEWAY_TOKEN), secret(config.gateway?.auth?.token), secret(config.gateway?.remote?.token)];
  const local = { url: `ws://127.0.0.1:${port}`, token: tokens[1] };
  const remote = config.gateway?.remote?.url ? { url: cleanUrl(config.gateway.remote.url, tokens), token: tokens[2] } : null;
  let pair;
  if (env.OC_GATEWAY_URL) {
    const url = cleanUrl(env.OC_GATEWAY_URL, tokens);
    pair = { url, token: tokens[0] || (url && url === remote?.url ? remote.token : url === local.url ? local.token : null) };
  } else pair = remote || { ...local, token: tokens[0] || local.token };
  return { gatewayUrl: pair.url, token: pair.url ? pair.token : null };
}
function credential({ env, gatewayUrl }) {
  const pair = connection(env);
  return pair.gatewayUrl === gatewayUrl ? pair.token : null;
}
module.exports = { connection, credential, cleanUrl };
