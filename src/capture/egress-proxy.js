'use strict';
/*
 * The capturer's egress proxy (S7d, SSRF safety). Headless Chrome is started with --proxy-server pointing here and
 * with no bypass (not even loopback), so EVERY request it makes, the page, its redirects and all subresources, goes
 * through this check:
 *   - only ports 80 and 443;
 *   - the name is resolved here; if ANY address is special-purpose (loopback, private, CGNAT/tailnet, link-local and
 *     cloud metadata, multicast, reserved, NAT64, IPv4-mapped forms of those…), the request is refused;
 *   - the connection goes to the address that was checked (pinned), so a DNS rebinding between check and connect
 *     can't redirect it;
 *   - a byte budget per capture caps the total traffic.
 * Refused requests get a 403 and are counted (no URL or host is logged).
 */
const http = require('http');
const net = require('net');
const dns = require('dns');

// RFC 6890 special-purpose space and friends, v4 and v6
const BLOCKED = new net.BlockList();
for (const [a, p] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24],
  ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]]) BLOCKED.addSubnet(a, p, 'ipv4');
for (const [a, p] of [['::', 128], ['::1', 128], ['64:ff9b::', 96], ['64:ff9b:1::', 48], ['100::', 64], ['2001::', 23], ['2001:db8::', 32],
  ['2002::', 16], ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8]]) BLOCKED.addSubnet(a, p, 'ipv6');

function isBlockedIp(ip) {
  const family = net.isIP(ip);
  if (!family) return true;
  if (family === 6) {
    const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
    if (m) return isBlockedIp(m[1]);
  }
  return BLOCKED.check(ip, family === 6 ? 'ipv6' : 'ipv4');
}

const lookupAll = (host) => new Promise((resolve, reject) => dns.lookup(host, { all: true, verbatim: true }, (e, list) => (e ? reject(e) : resolve(list))));

/**
 * @param {object} [o]
 * @param {(host) => Promise<{address, family}[]>} [o.lookup]   injectable resolver (tests)
 * @param {number} [o.maxBytes]                                total traffic budget for one capture
 * → { listen() → port, stats, close() }
 */
function createEgressProxy({ lookup = lookupAll, maxBytes = 25 * 1024 * 1024 } = {}) {
  const stats = { allowed: 0, refused: 0, bytes: 0, overBudget: false };
  const sockets = new Set();

  // → the pinned address, or null when the host or ANY of its addresses is not public
  async function check(host, port) {
    if (port !== 80 && port !== 443) return null;
    const h = String(host || '').replace(/^\[|\]$/g, '').toLowerCase();
    if (!h || h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return null;
    let list;
    if (net.isIP(h)) list = [{ address: h }];
    else { try { list = await lookup(h); } catch (_) { return null; } }
    if (!Array.isArray(list) || !list.length || list.some((x) => isBlockedIp(x.address))) return null;
    return list[0].address;
  }
  const count = (n) => { stats.bytes += n; if (stats.bytes > maxBytes) stats.overBudget = true; return !stats.overBudget; };
  const meter = (src, dst) => src.on('data', (chunk) => { if (!count(chunk.length)) { src.destroy(); dst.destroy(); } });

  const server = http.createServer(async (req, res) => {
    // plain http through the proxy: absolute-form request URLs only
    let u; try { u = new URL(req.url); } catch (_) { stats.refused++; res.writeHead(400); return res.end(); }
    const port = Number(u.port || 80);
    const ip = u.protocol === 'http:' ? await check(u.hostname, port) : null;
    if (!ip) { stats.refused++; res.writeHead(403); return res.end(); }
    stats.allowed++;
    const headers = Object.assign({}, req.headers, { host: u.host }); delete headers['proxy-connection'];
    const up = http.request({ host: ip, port, method: req.method, path: u.pathname + u.search, headers }, (r) => {
      res.writeHead(r.statusCode, r.headers); meter(r, res); r.pipe(res);
    });
    up.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
    req.pipe(up);
  });
  // https (and wss): CONNECT host:port, tunnelled to the pinned address (TLS stays end to end with the real name)
  server.on('connect', async (req, client, head) => {
    sockets.add(client); client.on('close', () => sockets.delete(client)); client.on('error', () => {});
    const m = /^(\[[^\]]+\]|[^:]+):(\d+)$/.exec(req.url || '');
    const ip = m ? await check(m[1], Number(m[2])) : null;
    if (!ip) { stats.refused++; client.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return; }
    stats.allowed++;
    const up = net.connect(Number(m[2]), ip, () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head && head.length) up.write(head);
      meter(up, client); meter(client, up);
      up.pipe(client); client.pipe(up);
    });
    sockets.add(up); up.on('close', () => sockets.delete(up));
    up.on('error', () => client.destroy());
  });
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });

  return {
    stats,
    check,
    listen: () => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port))),
    close: () => new Promise((resolve) => { for (const s of sockets) s.destroy(); server.close(() => resolve()); }),
  };
}

module.exports = { createEgressProxy, isBlockedIp };
