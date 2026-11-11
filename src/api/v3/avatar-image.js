'use strict';

// Untrusted profile images are decoded and rewritten to one static format before
// they enter private storage. Keep both the byte and native decoder work bounded.
const sharp = require('sharp');
const MAX_INPUT_BYTES = 5 * 1024 * 1024;
const MAX_DIMENSION = 4096;
const MAX_PIXELS = 16_000_000;
const MAX_OUTPUT_BYTES = 1024 * 1024;
const MAX_ACTIVE = 2;
const MAX_QUEUED = 8;
let active = 0;
const waiting = [];

function invalid() { return Object.assign(new Error('invalid avatar image'), { code: 'invalid-avatar-image' }); }
function tooLarge() { return Object.assign(new Error('avatar image too large'), { code: 'avatar-too-large' }); }
function busy() { return Object.assign(new Error('avatar image processing unavailable'), { code: 'avatar-busy' }); }

function sniff(bytes) {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg';
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') return 'webp';
  return null;
}

function hasAnimation(bytes, format) {
  if (format === 'png') return bytes.indexOf(Buffer.from('acTL')) !== -1;
  if (format === 'webp') return bytes.indexOf(Buffer.from('ANIM')) !== -1 || bytes.indexOf(Buffer.from('ANMF')) !== -1;
  return false;
}

function withDecodeSlot(run) {
  if (active >= MAX_ACTIVE && waiting.length >= MAX_QUEUED) return Promise.reject(busy());
  return new Promise((resolve, reject) => {
    const start = () => {
      active++;
      Promise.resolve().then(run).then(resolve, reject).finally(() => {
        active--;
        const next = waiting.shift();
        if (next) next();
      });
    };
    if (active < MAX_ACTIVE) start(); else waiting.push(start);
  });
}

async function normalizeAvatarImage(bytes, declaredMimeType) {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0) throw invalid();
  if (bytes.length > MAX_INPUT_BYTES) throw tooLarge();
  const format = sniff(bytes);
  const mimeType = format === 'jpeg' ? 'image/jpeg' : format ? `image/${format}` : null;
  if (!mimeType || String(declaredMimeType || '').toLowerCase() !== mimeType || hasAnimation(bytes, format)) throw invalid();
  return withDecodeSlot(async () => {
    try {
      const image = sharp(bytes, { failOn: 'warning', limitInputPixels: MAX_PIXELS, limitInputChannels: 4, pages: 1, animated: false, sequentialRead: true });
      const metadata = await image.metadata();
      if (metadata.format !== format || !Number.isInteger(metadata.width) || !Number.isInteger(metadata.height)
        || metadata.width < 1 || metadata.height < 1 || metadata.width > MAX_DIMENSION || metadata.height > MAX_DIMENSION
        || metadata.width * metadata.height > MAX_PIXELS || (metadata.pages && metadata.pages !== 1)) throw invalid();
      const { data, info } = await image.rotate().resize(512, 512, { fit: 'cover', position: 'centre', withoutEnlargement: false })
        .webp({ quality: 84, effort: 4 }).toBuffer({ resolveWithObject: true });
      if (data.length > MAX_OUTPUT_BYTES || info.format !== 'webp' || info.width !== 512 || info.height !== 512) throw invalid();
      return { bytes: data, mimeType: 'image/webp', width: 512, height: 512 };
    } catch (error) {
      if (error?.code === 'avatar-too-large' || error?.code === 'invalid-avatar-image') throw error;
      throw invalid();
    }
  });
}

module.exports = { normalizeAvatarImage, sniff, hasAnimation, MAX_INPUT_BYTES, MAX_DIMENSION, MAX_PIXELS, MAX_OUTPUT_BYTES };
