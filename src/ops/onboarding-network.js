'use strict';
const os = require('os'), net = require('net'), dns = require('dns').promises;
const { execFile } = require('child_process');
const { promisify } = require('util');
const { binary } = require('./local-files');
const MODES = ['local', 'lan', 'tailnet', 'public', 'tunnel'];
function origin(value) {
  const u = new URL(value);
  if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || u.search || u.hash || u.pathname !== '/') throw new Error('invalid origin');
  return u.origin;
}
function networkConfig(value) {
  if (!value || !MODES.includes(value.mode) || !Number.isInteger(value.port) || value.port < 1 || value.port > 65535) throw new Error('invalid network');
  const host = value.mode === 'lan' ? '0.0.0.0' : '127.0.0.1';
  const publicUrl = value.publicUrl ? origin(value.publicUrl) : null;
  if (['public', 'tunnel', 'tailnet'].includes(value.mode) && (!publicUrl || !publicUrl.startsWith('https://'))) throw new Error('HTTPS origin required');
  if (value.mode === 'local' && publicUrl) throw new Error('local origin must remain local');
  if (value.mode === 'lan' && !publicUrl) throw new Error('LAN origin required');
  return { mode: value.mode, host, port: value.port, publicUrl, cookieSecure: !!publicUrl?.startsWith('https://') };
}
function snippets(domain, port) {
  if (!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i.test(domain || '')) return {};
  const upstream = `http://127.0.0.1:${port}`;
  return {
    caddy: `${domain} {\n  reverse_proxy ${upstream}\n}`,
    traefik: `http:\n  routers:\n    agent-office:\n      rule: "Host(\`${domain}\`)"\n      entryPoints: [websecure]\n      service: agent-office\n      tls:\n        certResolver: letsencrypt\n  services:\n    agent-office:\n      loadBalancer:\n        servers:\n          - url: "${upstream}"`,
    nginx: `server {\n  listen 443 ssl;\n  server_name ${domain};\n  ssl_certificate /path/to/fullchain.pem;\n  ssl_certificate_key /path/to/privkey.pem;\n  location / {\n    proxy_pass ${upstream};\n    proxy_http_version 1.1;\n    proxy_set_header Host $host;\n    proxy_set_header X-Forwarded-Proto $scheme;\n    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;\n    proxy_buffering off;\n    proxy_read_timeout 1h;\n  }\n}`,
    cloudflare: `cloudflared tunnel login\ncloudflared tunnel create agent-office\ncloudflared tunnel route dns agent-office ${domain}\n# Configure the named tunnel before running:\ncloudflared tunnel run agent-office`,
    cloudflareConfig: `tunnel: <TUNNEL-UUID>\ncredentials-file: <CREDENTIALS-JSON-PATH>\ningress:\n  - hostname: ${domain}\n    service: ${upstream}\n  - service: http_status:404`,
    dns: `dig +short A ${domain}\ndig +short CNAME ${domain}\ncurl --fail https://${domain}/build.json`,
  };
}
const PROBES = ['lookup', 'fetcher', 'interfaces', 'run', 'findBinary'];
const listener = env => ({ host: env.AO_UI_HOST || env.HOST || '127.0.0.1', port: Number(env.AO_UI_PORT || env.PORT || 18789) });
function createNetworkGuide(options = {}) {
  const { env = process.env, lookup = dns.lookup, fetcher = fetch, interfaces = os.networkInterfaces,
    run = promisify(execFile), findBinary = binary } = options;
  // Fail before any host read, binary discovery or network request if a test forgot a fixture.
  const assertFixtures = () => {
    if ((env.AO_ENV === 'test' || process.env.NODE_TEST_CONTEXT) && PROBES.some(key => typeof options[key] !== 'function')) {
      throw Object.assign(new Error('network probes require complete test fixtures'), { code: 'ETESTPROBE' });
    }
  };
  async function inspect({ domain = '', port = Number(env.PORT || 18789), publicIp = false } = {}) {
    assertFixtures();
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('invalid port');
    const addresses = Object.values(interfaces()).flat().filter(Boolean).map(a => a.address);
    const tail = findBinary('tailscale', env);
    let tailnet = null;
    if (tail) { try { const r = await run(tail, ['status', '--json'], { timeout: 2500, maxBuffer: 1024 * 1024, env }); const t = JSON.parse(r.stdout); tailnet = { online: t.BackendState === 'Running', dnsName: t.Self?.DNSName || null }; } catch { tailnet = { online: false, dnsName: null }; } }
    let ip = null;
    if (publicIp) { try { const r = await fetcher('https://api.ipify.org?format=json', { signal: AbortSignal.timeout(3000), redirect: 'error' }); const body = await r.json(); if (net.isIP(body.ip)) ip = body.ip; } catch {} }
    let resolved = [], dnsStatus = 'not-requested';
    const generated = snippets(domain, port);
    if (domain && !Object.keys(generated).length) throw new Error('invalid domain');
    if (domain) { try { resolved = await Promise.race([lookup(domain, { all: true }), new Promise((_, reject) => { const t = setTimeout(() => reject(new Error('DNS timeout')), 3000); t.unref(); })]); dnsStatus = resolved.some(a => addresses.includes(a.address) || a.address === ip) ? 'matches' : ip ? 'different' : 'unknown'; } catch { dnsStatus = 'unresolved'; } }
    return { bind: listener(env), addresses,
      publicIp: ip, tailnet, dns: { status: dnsStatus, addresses: resolved.map(a => a.address) }, snippets: generated,
      tailscaleCommand: `tailscale serve --bg http://127.0.0.1:${port}`, restartRequired: true };
  }
  async function probe(url) {
    assertFixtures();
    const base = origin(url);
    try {
      const r = await fetcher(base + '/build.json', { signal: AbortSignal.timeout(5000), redirect: 'error' });
      const type = r.headers.get('content-type') || '';
      if (!r.ok || !type.includes('json')) return { ok: false, status: r.status, issue: 'build-unavailable' };
      const reader = r.body.getReader(); let size = 0, chunks = [];
      while (true) { const v = await reader.read(); if (v.done) break; size += v.value.length; if (size > 65536) { await reader.cancel(); return { ok: false, status: r.status, issue: 'build-invalid' }; } chunks.push(Buffer.from(v.value)); }
      const body = JSON.parse(Buffer.concat(chunks).toString());
      return { ok: typeof body?.buildId === 'string', status: r.status, issue: typeof body?.buildId === 'string' ? null : 'build-invalid' };
    } catch { return { ok: false, status: null, issue: 'unreachable' }; }
  }
  return { inspect, probe };
}
module.exports = { MODES, networkConfig, createNetworkGuide, snippets, listener };
