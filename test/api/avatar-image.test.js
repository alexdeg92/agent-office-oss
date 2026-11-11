'use strict';
const {describe,it,before}=require('node:test');
const assert=require('node:assert/strict');
const sharp=require('sharp');
const {normalizeAvatarImage,MAX_INPUT_BYTES}=require('../../src/api/v3/avatar-image');

let png;

describe('account avatar image normalization',()=>{
  before(async()=>{png=await sharp({create:{width:8,height:6,channels:4,background:'#36a4d8'}}).png().toBuffer();});
  it('sniffs, fully decodes, strips metadata, crops and emits only static 512px WebP',async()=>{
    const source=await sharp(png).withMetadata({orientation:6}).png().toBuffer();
    const result=await normalizeAvatarImage(source,'image/png');
    assert.equal(result.mimeType,'image/webp');
    assert.ok(result.bytes.length>12);
    assert.equal(result.bytes.subarray(0,4).toString('ascii'),'RIFF');
    assert.equal(result.bytes.subarray(8,12).toString('ascii'),'WEBP');
    const meta=await sharp(result.bytes).metadata();
    assert.deepEqual([meta.width,meta.height,meta.pages||1],[512,512,1]);
    assert.equal(meta.exif,undefined);
    assert.equal(meta.icc,undefined);
  });

  it('rejects MIME/signature mismatches, unsupported formats, animation and malformed/polyglot bytes generically',async()=>{
    for(const [bytes,mime] of [[png,'image/jpeg'],[Buffer.from('GIF89a000000','ascii'),'image/gif'],[Buffer.concat([png,Buffer.from('acTL','ascii')]),'image/png']]) {
      await assert.rejects(normalizeAvatarImage(bytes,mime),error=>error.code==='invalid-avatar-image'&& !/sharp|decode|path/i.test(error.message));
    }
    const animated=await sharp({create:{width:2,height:2,channels:4,background:'#00f'}}).png().toBuffer();
    const withAnimationMarker=Buffer.concat([animated,Buffer.from('acTL','ascii')]);
    await assert.rejects(normalizeAvatarImage(withAnimationMarker,'image/png'),error=>error.code==='invalid-avatar-image');
  });

  it('rejects oversized byte, dimension and decoded-pixel inputs before returning output',async()=>{
    await assert.rejects(normalizeAvatarImage(Buffer.alloc(MAX_INPUT_BYTES+1),'image/png'),error=>error.code==='avatar-too-large');
    const large=await sharp({create:{width:4097,height:1,channels:3,background:'#000'}}).png().toBuffer();
    await assert.rejects(normalizeAvatarImage(large,'image/png'),error=>error.code==='invalid-avatar-image');
    const tooManyPixels=await sharp({create:{width:4096,height:4096,channels:3,background:'#000'}}).png().toBuffer();
    await assert.rejects(normalizeAvatarImage(tooManyPixels,'image/png'),error=>error.code==='invalid-avatar-image');
  });
});
