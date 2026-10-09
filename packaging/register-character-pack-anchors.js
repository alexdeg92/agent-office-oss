'use strict';
// Sole integrator: derive the shared 26c anchor ledger from enabled, validated packs.
const fs=require('node:fs'),path=require('node:path');
const {validateIntegratedPack}=require('./character-pack-registry');
function registerPackAnchors(ledger,pack,root,measuredBounds={}) {
 const result=validateIntegratedPack(pack,root);if(!result.ok)throw Error(pack.id+': '+result.errors.join('; '));
 const prefix='Characters/'+pack.id+'/';
 const measured=path.resolve(root,'../../tools/chars-'+pack.id+'-sources/registration.json');
 const review={...(fs.existsSync(measured)?JSON.parse(fs.readFileSync(measured)):{}),...measuredBounds};
 for(const key of Object.keys(ledger.assets))if(key.startsWith(prefix))delete ledger.assets[key];
 for(const v of pack.variants) {
  ledger.assets[prefix+v.thumbnail]={canvas:[96,144],anchor:[48,138],thumbnail:true};
  for(const f of v.frames){
   const a=f.anchors,body=prefix+f.image;
   ledger.assets[body]={canvas:pack.canvas,anchor:a.ground,facing:f.facing,handAnchor:a[f.facing==='se'||f.facing==='ne'?'handRight':'handLeft'],handAnchors:{left:a.handLeft,right:a.handRight},
    ...(f.seated?{seatAnchor:a.hip}:{}),...(a.fx?{fxAnchor:a.fx}:{}),...(f.heldProp?{heldProp:f.heldProp}:{}),
    headLandmarks:{headBox:a.headBox??review[v.id+'/'+f.id]?.headBox,headCentre:a.head,tiltDegreesClockwise:a.tilt,earPoints:{left:a.earLeft,right:a.earRight},eyeLine:a.eyes.line,eyeLineVisibility:a.eyes.visibility,neckPoint:a.neck,chestPoint:a.chest,method:'Pack-authored per-frame registration; source measurements remain in tools.'},packManifest:prefix+'manifest.json'};
   for(const [id,reg] of Object.entries(f.accessories))for(const side of ['back','front']){
    if(!reg[side])continue;const key=prefix+reg[side];
    // Empty shared layers have no pose-specific geometry. Do not assign a false single owner.
    const record={canvas:pack.canvas,anchor:a.ground};
    if(reg[side]!=='z.webp')record.poseRegistration={body,facing:f.facing,anchor:reg.anchor,headCentre:a.head,occluded:reg.occluded,...(reg.matrix?{matrix:reg.matrix,sourceFacing:reg.sourceFacing,mirrored:reg.mirrored}:{})};
    ledger.assets[key]=record;
   }
  }
 }
 return result;
}
// Optional integrator measurements support producer ledgers that contain gear transforms only.
function main(){const base=path.resolve(__dirname,'../design/assets'),file=path.join(base,'anchors.json');const ledger=JSON.parse(fs.readFileSync(file));const boundsFile=process.argv[2]??path.join(base,'tools/character-pack-head-bounds.json');const bounds=fs.existsSync(boundsFile)?JSON.parse(fs.readFileSync(boundsFile)):{};const ids=JSON.parse(fs.readFileSync(path.join(base,'../office/character-packs.enabled.json')));for(const id of ids){const root=path.join(base,'Characters',id),pack=JSON.parse(fs.readFileSync(path.join(root,'manifest.json')));registerPackAnchors(ledger,pack,root,bounds[id]);}const temp=file+'.packs-tmp';fs.writeFileSync(temp,JSON.stringify(ledger,null,2)+'\n');fs.renameSync(temp,file);}
if(require.main===module)main();module.exports={registerPackAnchors};
