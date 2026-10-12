import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const root=process.cwd();
const registry=JSON.parse(fs.readFileSync(path.join(root,'design/identity-1/registry.json'),'utf8'));
const luminance=hex=>{
 const rgb=hex.slice(1).match(/../g).map(v=>parseInt(v,16)/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4);
 return .2126*rgb[0]+.7152*rgb[1]+.0722*rgb[2];
};
const ratio=(a,b)=>{const x=luminance(a),y=luminance(b);return (Math.max(x,y)+.05)/(Math.min(x,y)+.05);};

test('identity registry token sets pass every shipped contrast report and generate isolated runtime assets',()=>{
 assert.equal(registry.default,'bureau');
 assert.deepEqual(registry.themes.map(theme=>theme.id),['bureau','observatoire','atelier']);
 for(const theme of registry.themes){
  const dir=path.join(root,'design/identity-1',theme.id),tokens=JSON.parse(fs.readFileSync(path.join(dir,'tokens.json'),'utf8'));
  const report=fs.readFileSync(path.join(dir,'contrast.txt'),'utf8');
  assert.match(report,/Sombre: 127\/127 paires conformes/);assert.match(report,/Clair: 127\/127 paires conformes/);
  for(const mode of ['light','dark']){
   const values=Object.fromEntries(tokens.color.tokens.map(token=>[token.name,token.value[mode]]));
   for(const fg of ['text-primary','text-secondary','text-tertiary'])for(const bg of ['bg','bg-sunken','surface','surface-raised','surface-overlay','surface-hover','surface-selected'])assert.ok(ratio(values[fg],values[bg])>=4.5,`${theme.id}/${mode} ${fg} on ${bg}`);
   assert.ok(ratio(values['text-on-accent'],values.accent)>=4.5,`${theme.id}/${mode} text on accent`);
   assert.ok(ratio(values['border-control'],values.surface)>=3,`${theme.id}/${mode} control boundary`);
  }
 }
 require('../../scripts/build-identity-themes.js').build();
 for(const theme of registry.themes){
  const css=fs.readFileSync(path.join(root,'public/v2/identity-themes',theme.id,'theme.css'),'utf8');
  assert.ok(css.includes(`[data-identity="${theme.id}"]`));
  assert.match(css,/url\("fonts\//);
  assert.ok(fs.statSync(path.join(root,'public/v2/identity-themes',theme.id,'fonts')).isDirectory());
  assert.ok((css.match(/@font-face/g)||[]).length>0);
    assert.match(css,new RegExp(`\\[data-identity="${theme.id}"\\] \\.scrim`),'direction overlays are scoped to their own identity');
    assert.ok(!fs.existsSync(path.join(root,'public/v2/identity-themes',theme.id,'fonts','fonts.json')),'design metadata is not shipped in runtime assets');
    for(const font of fs.readdirSync(path.join(root,'public/v2/identity-themes',theme.id,'fonts')).filter(file=>/\.ttf$/i.test(file)))
      assert.match(css,/format\("truetype"\)/,`${theme.id}/${font} declares its actual font format`);
 }
});
