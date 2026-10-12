'use strict';

const { domainToASCII } = require('node:url');
const { canonicalDomain } = require('./dns-inspection');

const MODES = Object.freeze(['local', 'lan', 'private', 'public-same-origin', 'public-split-origin', 'tunnel']);
const PROXIES = Object.freeze(['caddy', 'traefik', 'cloudflare', 'manual']);
const SECURITY = Object.freeze({
  accessTokenMinutes: [5, 15],
  refreshIdleHours: [1, 24],
  refreshAbsoluteDays: [1, 30],
});
function fail(field, issue = 'invalid') { throw Object.assign(new Error('invalid access draft'), { code: 'EACCESSDRAFT', field, issue }); }
function object(value, field) { if (!value || typeof value !== 'object' || Array.isArray(value)) fail(field); return value; }
function exact(value, allowed, field) { for (const key of Object.keys(value)) if (!allowed.includes(key)) fail(field ? `${field}.${key}` : key, 'unexpected-field'); }

function canonicalOrigin(value, field) {
  if (typeof value !== 'string' || value.length > 2048) fail(field);
  let url;
  try { url = new URL(value); } catch { fail(field); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/' || url.hostname.includes('*')) fail(field);
  const asciiHost = domainToASCII(url.hostname).toLowerCase();
  if (!asciiHost || url.hostname !== asciiHost) fail(field);
  const normalized = url.origin;
  if (value !== normalized) fail(field);
  return normalized;
}

function canonicalApiBase(value) {
  if (typeof value !== 'string' || value.length > 2048) fail('apiPublicUrl');
  let url;
  try { url = new URL(value); } catch { fail('apiPublicUrl'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.hostname.includes('*')) fail('apiPublicUrl');
  const host = domainToASCII(url.hostname).toLowerCase();
  if (!host || url.hostname !== host || !value.startsWith(`https://${host}`)) fail('apiPublicUrl');
  // Deployment prefixes are allowed, but URL parsing must not normalize away hidden path syntax.
  if (url.pathname.split('/').some(part => part === '.' || part === '..') || /[%\\\x00-\x20]/.test(url.pathname) || url.pathname.includes('//')) fail('apiPublicUrl');
  if (url.pathname.length > 256 || url.pathname.split('/').some(part => part === '.' || part === '..')
    || (url.pathname !== '/' && !/^\/(?:[A-Za-z0-9_-]+)(?:\/[A-Za-z0-9_-]+)*$/.test(url.pathname))) fail('apiPublicUrl');
  const normalized = `${url.origin}${url.pathname === '/' ? '' : url.pathname.replace(/\/$/, '')}`;
  if (value !== normalized) fail('apiPublicUrl');
  return normalized;
}

function canonicalSecurity(input) {
  const value = object(input, 'security');
  const fields = [...Object.keys(SECURITY), 'partitionedCookie'];
  exact(value, fields, 'security');
  for (const [name, [min, max]] of Object.entries(SECURITY)) {
    if (!Number.isInteger(value[name]) || value[name] < min || value[name] > max) fail(`security.${name}`);
  }
  if (typeof value.partitionedCookie !== 'boolean') fail('security.partitionedCookie');
  return { accessTokenMinutes: value.accessTokenMinutes, refreshIdleHours: value.refreshIdleHours,
    refreshAbsoluteDays: value.refreshAbsoluteDays, partitionedCookie: value.partitionedCookie };
}

function validateAccessDraft(input) {
  const draft = object(input, 'draft');
  exact(draft, ['mode', 'apiPublicUrl', 'uiOrigins', 'domain', 'proxy', 'security'], 'draft');
  if (!MODES.includes(draft.mode)) fail('draft.mode');
  if (!PROXIES.includes(draft.proxy)) fail('draft.proxy');
  if (!Array.isArray(draft.uiOrigins) || draft.uiOrigins.length > 16) fail('draft.uiOrigins');
  const uiOrigins = draft.uiOrigins.map((origin, index) => canonicalOrigin(origin, `draft.uiOrigins.${index}`));
  if (new Set(uiOrigins).size !== uiOrigins.length) fail('draft.uiOrigins', 'duplicate');
  const domain = draft.domain === null ? null : canonicalDomain(draft.domain);
  if (domain !== null && draft.domain !== domain) fail('draft.domain');
  const nonPublic = ['local', 'lan', 'private'].includes(draft.mode);
  if (nonPublic) {
    if (draft.apiPublicUrl !== null || domain !== null || uiOrigins.length) fail('draft.mode', 'topology-mismatch');
  } else {
    if (domain === null) fail('draft.domain', 'required');
    canonicalApiBase(draft.apiPublicUrl);
  }
  if (['public-same-origin', 'tunnel'].includes(draft.mode) && uiOrigins.length) fail('draft.uiOrigins', 'topology-mismatch');
  if (draft.mode === 'public-split-origin' && (uiOrigins.length < 1 || uiOrigins.length > 16)) fail('draft.uiOrigins', 'required');
  return Object.freeze({ mode: draft.mode, apiPublicUrl: nonPublic ? null : canonicalApiBase(draft.apiPublicUrl),
    uiOrigins: Object.freeze(uiOrigins), domain, proxy: draft.proxy, security: Object.freeze(canonicalSecurity(draft.security)) });
}

module.exports = { validateAccessDraft, canonicalOrigin, canonicalApiBase, MODES, PROXIES, SECURITY };
