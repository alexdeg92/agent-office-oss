'use strict';
const fs = require('node:fs');
const { execFile } = require('node:child_process');
const { LIMITS } = require('./code');
// No delegates, URLs, or arbitrary paths: only known raster signatures passed on stdin with an explicit codec.
function rasterKind(bytes) {
  if (bytes.length < 16) return null;
  if (bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return 'png';
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'jpeg';
  if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  return null;
}
function createRasterizer({ bin = ['/usr/bin/convert', '/usr/local/bin/convert'].find((p) => fs.existsSync(p)) } = {}) {
  if (!bin) return null;
  return async (bytes, { signal } = {}) => {
    const kind = rasterKind(bytes);
    if (!kind || bytes.length > 8 * 1024 * 1024) throw new Error('invalid-raster');
    const render = (width, height, budget) => new Promise((resolve, reject) => {
      const args = ['-limit', 'thread', '1', '-limit', 'memory', '32MiB', '-limit', 'map', '32MiB', '-limit', 'disk', '0',
        '-limit', 'width', '8192', '-limit', 'height', '8192', kind + ':-[0]', '-auto-orient', '-strip', '-thumbnail', width + 'x' + height + '^',
        '-gravity', 'center', '-extent', width + 'x' + height, '-quality', '45', '-define', 'webp:method=2', 'webp:-'];
      const child = execFile(bin, args, { timeout: 10000, signal, encoding: 'buffer', maxBuffer: 256 * 1024 }, (err, out) => {
        if (err || !out || out.length > budget || rasterKind(out) !== 'webp') reject(new Error('raster-failed'));
        else resolve(out);
      });
      child.stdin.on('error', () => {}); child.stdin.end(bytes);
    });
    // Serial conversion, one process at a time.
    return { cover: await render(480, 270, LIMITS.cover), thumb: await render(160, 90, LIMITS.thumb), ext: 'webp' };
  };
}
module.exports = { createRasterizer, rasterKind };
