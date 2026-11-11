'use strict';
const {describe,it,before,after}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const sharp=require('sharp');
const {settingsFixture}=require('../helpers/settings-fixture');
const {hashPassword}=require('../../src/security/password');

describe('AccountVM avatar endpoints',()=>{
  let f,png,fakeNow;
  before(async()=>{fakeNow=Date.now();f=await settingsFixture({enforceAuthorization:true,now:()=>fakeNow});png=await sharp({create:{width:8,height:6,channels:4,background:'#36a4d8'}}).png().toBuffer();});
  after(async()=>{await f?.close();});

  it('returns the server-owned initial avatar, capabilities, labels, and limits from MeVM',async()=>{
    const response=await f.get('/api/v3/me');
    assert.equal(response.status,200);
    assert.equal(response.json.data.avatar.kind,'initials');
    assert.equal(response.json.data.avatar.initials,'CA','the configured owner display name is Camille');
    const avatar=response.json.data.avatar;
    assert.deepEqual(avatar.capabilities,{chooseCharacter:true,uploadPhoto:true,remove:false});
    assert.deepEqual(avatar.uploadLimits,{acceptedTypes:['image/png','image/jpeg','image/webp'],maxBytes:5*1024*1024,maxPixels:16_000_000});
    assert.equal(avatar.characterChoices.length,11,'only named user-facing character packs are supplied');
    assert.ok(avatar.characterChoices.every(choice=>choice.displayName&&choice.spriteRef&&!['timmy','subagent','family-b'].includes(choice.id)));
    assert.ok(avatar.characterChoices.every(choice=>choice.colours.length>0&&Array.isArray(choice.accessories)));
    assert.ok(avatar.characterChoices.every(choice=>choice.colours.every(colour=>Array.isArray(colour.defaultAccessories))));
    const cosmo=avatar.characterChoices.find(choice=>choice.id==='cosmo');
    const slotOrder=['body','neck','face','head','badge'];
    assert.deepEqual(cosmo.accessories.map(accessory=>accessory.slot),cosmo.accessories.map(accessory=>accessory.slot).slice().sort((a,b)=>slotOrder.indexOf(a)-slotOrder.indexOf(b)),
      'accessories use the same canonical order as the Office renderer');
    const cap=cosmo.accessories.find(accessory=>accessory.id==='cap');
    assert.deepEqual(cap.previewLayers.map(layer=>layer.variantId),cosmo.colours.map(colour=>colour.id),
      'each accessory exposes preview layers in the corresponding colour order');
    assert.ok(cap.previewLayers.some(layer=>layer.backSpriteRef||layer.frontSpriteRef),
      'the server supplies renderable accessory layers so selected gear changes the preview');
    assert.ok(cap.previewLayers.every(layer=>[layer.backSpriteRef,layer.frontSpriteRef].every(ref=>ref===null||ref.startsWith('assets/'))),
      'preview layers contain only bounded relative asset references');
    assert.equal(avatar.characterChoices.some(choice=>choice.selected),false,'initials do not preselect a character');
    assert.equal(avatar.characterChoices.find(choice=>choice.id==='cosmo').displayName,'Cosmonaute');
    assert.equal((await f.get('/api/v3/me?locale=en')).json.data.avatar.characterChoices.find(choice=>choice.id==='cosmo').displayName,'Astronaut');
    const meta=await f.get('/api/v3/meta');
    assert.equal(meta.json.data.labels['account.avatar.initials'],'Initiales du profil');
  });

  it('accepts a catalogue character look and rejects unsupported characters/accessories',async()=>{
    const accepted=await f.put('/api/v3/me/avatar/character',{characterId:'cosmo',variant:'sage',accessories:[]});
    assert.equal(accepted.status,200);
    assert.equal(accepted.json.data.result.staged,true);
    assert.deepEqual(accepted.json.data.result.avatar.character,{id:'cosmo',variant:'sage',accessories:[]});
    assert.equal(accepted.json.data.result.avatar.capabilities.remove,true,'the VM enables reset for a staged character');
    assert.equal(accepted.json.data.result.avatar.characterChoices.find(choice=>choice.id==='cosmo').selected,true,
      'the staged choice is reflected in the server-provided records');
    assert.equal((await f.get('/api/v3/me')).json.data.avatar.kind,'initials','selection is staged until the account Save');
    assert.equal(f.store.avatars.get(f.store.users.owner().id),null);
    await f.reauth();
    const saved=await f.put('/api/v3/settings/owner',{expectedRevision:f.store.users.owner().permission_revision,avatarStageId:accepted.json.data.result.stageId});
    assert.equal(saved.status,200,saved.text);
    assert.equal((await f.get('/api/v3/me')).json.data.avatar.kind,'character');
    const changed=await f.put('/api/v3/me/avatar/character',{characterId:'cosmo',variant:'sage',accessories:[]});
    assert.equal(changed.status,200,changed.text);
    const cancelled=await fetch(f.base+`/api/v3/me/avatar/staged/${encodeURIComponent(changed.json.data.result.stageId)}` ,{method:'DELETE',headers:{cookie:f.cookie,'x-ao-request':'1'}});
    assert.equal(cancelled.status,200);
    assert.equal((await f.get('/api/v3/me')).json.data.avatar.character.variant,'sage','Annuler drops the staged choice and keeps the committed avatar');
    const rejected=await f.put('/api/v3/me/avatar/character',{characterId:'timmy',variant:null,accessories:[]});
    assert.equal(rejected.status,400,'the primary-only character cannot be chosen as a profile avatar');
    const genericRole=await f.put('/api/v3/me/avatar/character',{characterId:'subagent',variant:'sage',accessories:[]});
    assert.equal(genericRole.status,400,'generic role placeholders are not selectable profile characters');
    const badAccessory=await f.put('/api/v3/me/avatar/character',{characterId:'cosmo',variant:'sage',accessories:['not-a-real-item']});
    assert.equal(badAccessory.status,400);
  });

  it('stores only a private canonical WebP and serves it to the authenticated owner with no-store headers',async()=>{
    const form=new FormData();form.set('file',new Blob([png],{type:'image/png'}),'untrusted-filename.png');
    const uploaded=await fetch(f.base+'/api/v3/me/avatar/photo',{method:'POST',headers:{cookie:f.cookie,'x-ao-request':'1'},body:form});
    assert.equal(uploaded.status,200,await uploaded.clone().text());
    const uploadBody=(await uploaded.json()).data.result;
    const result=uploadBody.avatar;
    assert.equal(uploadBody.staged,true);
    assert.equal(result.kind,'photo');assert.match(result.imageUrl,/^\/api\/v3\/me\/avatar\/staged\//);
    assert.equal((await f.get('/api/v3/me')).json.data.avatar.kind,'character','upload is not the committed profile until Save');
    await f.reauth();
    const saved=await f.put('/api/v3/settings/owner',{expectedRevision:f.store.users.owner().permission_revision,avatarStageId:uploadBody.stageId});
    assert.equal(saved.status,200,saved.text);
    const committed=(await f.get('/api/v3/me')).json.data.avatar;
    assert.equal(committed.kind,'photo');
    const image=await fetch(f.base+committed.imageUrl,{headers:{cookie:f.cookie}});
    assert.equal(image.status,200);assert.equal(image.headers.get('content-type'),'image/webp');
    assert.equal(image.headers.get('cache-control'),'private, no-store');
    assert.equal(image.headers.get('x-content-type-options'),'nosniff');
    const bytes=Buffer.from(await image.arrayBuffer());assert.equal(bytes.subarray(8,12).toString('ascii'),'WEBP');
    const root=path.join(f.store.dir,'user','avatar');const files=fs.readdirSync(root).filter(name=>name.endsWith('.webp'));
    assert.equal(files.length,1);assert.match(files[0],/^[0-9a-f-]{36}\.webp$/i);
    const stat=fs.statSync(path.join(root,files[0]));assert.equal(stat.mode&0o077,0);assert.ok(stat.size<1024*1024);
  });

  it('rejects spoofed uploads, refuses anonymous reads, and removes the stored image idempotently',async()=>{
    const form=new FormData();form.set('file',new Blob([png],{type:'image/jpeg'}),'avatar.jpg');
    const bad=await fetch(f.base+'/api/v3/me/avatar/photo',{method:'POST',headers:{cookie:f.cookie,'x-ao-request':'1'},body:form});
    assert.equal(bad.status,400);
    const cookie=f.cookie;f.cookie='';
    assert.equal((await f.get('/api/v3/me/avatar')).status,401);
    f.cookie=cookie;
    const removed=await fetch(f.base+'/api/v3/me/avatar',{method:'DELETE',headers:{cookie:f.cookie,'x-ao-request':'1'}});
    assert.equal(removed.status,200);assert.equal(removed.headers.get('cache-control'),'no-store');
    assert.equal(removed.headers.get('content-type')?.includes('application/json'),true);
    assert.equal((await f.get('/api/v3/me')).json.data.avatar.kind,'photo','removal is staged until Save');
    const removal=(await removed.json()).data.result;
    assert.equal(removal.avatar.capabilities.remove,false,'the VM disables reset for a staged initials avatar');
    await f.reauth();
    const saved=await f.put('/api/v3/settings/owner',{expectedRevision:f.store.users.owner().permission_revision,avatarStageId:removal.stageId});
    assert.equal(saved.status,200,saved.text);
    assert.equal((await f.get('/api/v3/me')).json.data.avatar.kind,'initials');
    assert.equal((await f.get('/api/v3/me/avatar')).status,404);
  });

  it('bounds the complete streamed multipart body even when content-length is absent',async()=>{
    const body=new ReadableStream({start(controller){
      controller.enqueue(new TextEncoder().encode('--x\r\nContent-Disposition: form-data; name="file"; filename="a.png"\r\nContent-Type: image/png\r\n\r\n'));
      controller.enqueue(new Uint8Array(5*1024*1024-1));
      controller.enqueue(new TextEncoder().encode('\r\n--x--\r\n'));
      controller.enqueue(new Uint8Array(32*1024));controller.close();
    }});
    const response=await fetch(f.base+'/api/v3/me/avatar/photo',{method:'POST',duplex:'half',headers:{cookie:f.cookie,'x-ao-request':'1','content-type':'multipart/form-data; boundary=x'},body});
    assert.equal(response.status,413,await response.text());
  });

  it('expires abandoned photo staging blobs and removes them from private storage',async()=>{
    const root=path.join(f.store.dir,'user','avatar');
    const priorFiles=fs.readdirSync(root).filter(name=>name.endsWith('.webp')).length;
    const form=new FormData();form.set('file',new Blob([png],{type:'image/png'}),'preview.png');
    const response=await fetch(f.base+'/api/v3/me/avatar/photo',{method:'POST',headers:{cookie:f.cookie,'x-ao-request':'1'},body:form});
    assert.equal(response.status,200,await response.clone().text());
    const staged=(await response.json()).data.result;
    assert.equal(fs.readdirSync(root).filter(name=>name.endsWith('.webp')).length,priorFiles+1,'the pending preview is staged in private storage');
    fakeNow+=31*60*1000;
    assert.equal((await f.get(staged.avatar.imageUrl)).status,404,'expired previews are no longer readable');
    assert.equal(fs.readdirSync(root).filter(name=>name.endsWith('.webp')).length,priorFiles,'expiration removes the unreferenced staged blob');
  });

  it('keeps avatar writes self-scoped for active accounts and rejects revoked sessions',async()=>{
    const owner=f.store.users.owner(),ctx={userId:owner.id,authGeneration:owner.auth_generation,requestId:'req_avatar_invite',authorize:()=>{}};
    const invited=f.store.userManagement.invite({name:'Avatar Reader',email:'avatar-reader@example.invalid',roleId:'rol_reader'},ctx);
    f.store.userManagement.accept({token:invited.token,purpose:'invite',passwordHash:await hashPassword('synthetic-avatar-reader-password')},{requestId:'req_avatar_accept'});
    const reader=f.store.users.byId(invited.user.id);
    f.cookie='';
    const readerLogin=await f.login('synthetic-avatar-reader-password','avatar-reader@example.invalid');
    assert.equal(readerLogin.status,200,readerLogin.text);
    const beforeOwner=f.store.avatars.get(owner.id);
    const staged=await f.put('/api/v3/me/avatar/character',{characterId:'cosmo',variant:'sage',accessories:[]});
    assert.equal(staged.status,200,staged.text,'an active account manages its own profile avatar');
    assert.equal(f.store.avatars.get(reader.id),null,'selection remains staged for this principal');
    assert.deepEqual(f.store.avatars.get(owner.id),beforeOwner,'one account cannot mutate another account through self routes');
    const recent=await f.post('/api/v3/settings/reauth',{password:'synthetic-avatar-reader-password'});
    assert.equal(recent.status,200,recent.text);
    const saved=await f.put('/api/v3/settings/owner',{expectedRevision:reader.permission_revision,avatarStageId:staged.json.data.result.stageId});
    assert.equal(saved.status,200,saved.text);
    assert.equal(f.store.avatars.get(reader.id)?.characterId,'cosmo');
    f.store.userManagement.revoke(reader.id,{expectedRevision:f.store.users.byId(reader.id).permission_revision},ctx);
    assert.equal((await f.get('/api/v3/me/avatar')).status,401,'revoked active-session credentials cannot read the avatar');
    assert.equal((await f.put('/api/v3/me/avatar/character',{characterId:'cosmo',variant:'sage',accessories:[]})).status,401);
    assert.equal((await fetch(f.base+'/api/v3/me/avatar/photo',{method:'POST',headers:{cookie:f.cookie,'x-ao-request':'1'},body:new FormData()})).status,401);
    assert.equal((await fetch(f.base+'/api/v3/me/avatar',{method:'DELETE',headers:{cookie:f.cookie,'x-ao-request':'1'}})).status,401);
    assert.equal((await f.put('/api/v3/settings/owner',{expectedRevision:2,displayName:'Revoked',avatarStageId:staged.json.data.result.stageId})).status,401,
      'a revoked session cannot commit a staged avatar/profile save');
  });
});
