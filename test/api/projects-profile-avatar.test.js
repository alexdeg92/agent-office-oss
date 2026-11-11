'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { settingsFixture } = require('../helpers/settings-fixture');
const { hashPassword } = require('../../src/security/password');
const sharp = require('sharp');
const { createAvatarStorage } = require('../../src/api/v3/avatar-storage');

describe('ProjectVM account profile avatar', () => {
  let h;
  before(async () => { h = await settingsFixture({ enforceAuthorization: true }); });
  after(async () => { await h?.close(); });

  for (const version of [2, 3]) it(`projects the requesting person's avatar in v${version} project history`, async () => {
    const ownerCookie=h.cookie;
    const owner=h.store.users.owner();
    const storage=createAvatarStorage({dataDir:h.store.dir});
    const image=await sharp({create:{width:12,height:12,channels:3,background:'#33aacc'}}).webp().toBuffer();
    const blobId=storage.write(image);h.store.avatars.setPhoto(owner.id,blobId);
    const me = await h.get(`/api/v${version}/me`);
    assert.equal(me.status, 200, me.text);
    assert.ok(me.json.data.avatar?.kind, 'the authenticated account has an avatar descriptor');
    const create = await h.post(`/api/v${version}/projects`, { name: `Avatar test ${version}`, status: 'todo', sources: [] });
    assert.equal(create.status, 200, create.text);
    const detail = await h.get(`/api/v${version}/views/projects/${encodeURIComponent(create.json.data.vm.id)}`);
    assert.equal(detail.status, 200, detail.text);
    const human = detail.json.data.recentHistory.flatMap(row => row.actor?.kind === 'human' ? [row.actor] : []).at(-1);
    assert.ok(human, 'project history includes its human creator');
    const { capabilities: _capabilities, ...displayAvatar } = me.json.data.avatar;
    assert.ok(human.profileAvatar);
    assert.equal(human.profileAvatar.kind,'photo');
    assert.match(human.profileAvatar.imageUrl,/^\/api\/v3\/profile-avatars\//,'person image URL is bound to the exact user, not the viewer-relative /me route');
    assert.notEqual(human.profileAvatar.imageUrl,displayAvatar.imageUrl);
    const served=await fetch(h.base+human.profileAvatar.imageUrl,{headers:{cookie:h.cookie}});
    assert.equal(served.status,200);
    assert.deepEqual(Buffer.from(await served.arrayBuffer()),image);

    const context={userId:owner.id,authGeneration:owner.auth_generation,requestId:'req_avatar_second_user',authorize:()=>{}};
    const secondEmail=`avatar-second-${version}@example.invalid`;
    const invited=h.store.userManagement.invite({name:'Second avatar user',email:secondEmail,roleId:'rol_admin'},context);
    h.store.userManagement.accept({token:invited.token,purpose:'invite',passwordHash:await hashPassword('synthetic-second-avatar-password')},{requestId:'req_avatar_second_accept'});
    const second=h.store.users.byId(invited.user.id),secondImage=storage.write(await sharp({create:{width:10,height:10,channels:3,background:'#aa3377'}}).webp().toBuffer());
    h.store.avatars.setPhoto(second.id,secondImage);
    const secondCookie='taco_sess='+h.auth.signSession({userId:second.id,authGeneration:second.auth_generation,sid:`second-avatar-viewer-${version}`,exp:Date.now()+60000});
    h.cookie=secondCookie;
    const viewerMe=await h.get(`/api/v${version}/me`);assert.equal(viewerMe.json.data.avatar.imageUrl,'/api/v3/me/avatar');
    const secondProject=await h.post(`/api/v${version}/projects`,{name:`Second avatar project ${version}`,status:'todo',sources:[]});
    assert.equal(secondProject.status,200,secondProject.text);
    h.cookie=ownerCookie;
    const asSecond=await h.get(`/api/v${version}/views/projects/${encodeURIComponent(secondProject.json.data.vm.id)}`);
    assert.equal(asSecond.status,200,asSecond.text);
    const ownerActor=asSecond.json.data.recentHistory.flatMap(row=>row.actor?.kind==='human'?[row.actor]:[]).at(-1);
    assert.equal(ownerActor.id,second.person_id);
    assert.ok(ownerActor.profileAvatar,"a visible person receives that person's read-only avatar descriptor");
    assert.notEqual(ownerActor.profileAvatar.imageUrl,displayAvatar.imageUrl,'the viewer photo is never substituted onto another person');
    const exactImage=await fetch(h.base+ownerActor.profileAvatar.imageUrl,{headers:{cookie:h.cookie}});
    assert.equal(exactImage.status,200);assert.deepEqual(Buffer.from(await exactImage.arrayBuffer()),await storage.read(secondImage));
    assert.equal((await fetch(h.base+ownerActor.profileAvatar.imageUrl,{headers:{cookie:secondCookie}})).status,404,
      'the signed exact-user URL is bound to the authorized viewer');
    h.cookie=ownerCookie;
  });
});
