'use strict';
// URLs the server puts in a VM (api.md §3.11, frontend-07): the UI never prefixes data URLs, so every URL in a
// VM is ABSOLUTE. Third-party URLs (Discord CDN avatars, GitHub/OpenGraph images) already are. Media the server
// itself serves (e.g. S7d screenshots) is built here from the public origin + the public API prefix, never from
// request headers. Without a configured public origin there is no URL (the VM field is null).
function createPublicUrls({ publicUrl, publicApiBase = '' }) {
  let origin = null;
  if (publicUrl) { const u = new URL(publicUrl); if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('AO_PUBLIC_URL must be http(s)'); origin = u.origin; }
  const base = String(publicApiBase || '').replace(/\/+$/, '');
  if (base && !base.startsWith('/')) throw new Error('AO_PUBLIC_API_BASE must start with /');
  // forApi('/api/v2/media/x.png') → 'https://host/backend/api/v2/media/x.png' | null
  return { forApi: (pathname) => (origin && String(pathname).startsWith('/api/') ? origin + base + pathname : null), origin };
}
module.exports = { createPublicUrls };
