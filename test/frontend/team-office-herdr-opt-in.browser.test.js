import test from 'node:test';
import assert from 'node:assert/strict';
import { openLive, skip } from './helpers/settings-live-browser.js';

test('the v2 Bureau shows the herdr opt-in hint for an administrator only when detection is available', { skip, timeout: 30000 }, async () => {
  const b = await openLive({ sessionsReadable: () => true, sourcePrincipalFor: () => ({ id: 'owner-hint', role: 'admin', permissionRevision: 1 }), orchestratorTeams: () => ({ detected: true, hasHerdr: false, hasTeamStore: false,
    getSnapshot: () => null, start() {}, close() {}, onChange: () => () => {} }) });
  try {
    const office = await b.h.get('/api/v2/views/office');
    assert.equal(office.status, 200, office.text);
    assert.equal(office.json.data.orchestratorActivationAvailable, true);
    let bureauResponse=null;
    b.page.on('response',async response=>{if(new URL(response.url()).pathname.endsWith('/api/v2/views/office'))bureauResponse={status:response.status(),text:await response.text().catch(()=> '')};});
    await b.page.goto(b.origin + '/bureau', { waitUntil: 'domcontentloaded' });
    await b.page.locator('.ao-bureau__stage').waitFor();
    const hint = b.page.getByTestId('team-herdr-opt-in-hint');
    await hint.waitFor({ state: 'visible', timeout: 5000 }).catch(async error => {
      const api=await b.page.evaluate(async()=>{const r=await fetch('/backend/api/v2/views/office');return {status:r.status,body:await r.json()};});
      const stream=await b.page.evaluate(async()=>{const {services}=await import('/services.js');const row=services.stream?._topics?.get('office');return {apiVersion:(await import('/config.js')).config.apiVersion,entry:row?.state?.data,topic:row?.meta?.topic?.id};});
      throw new Error(error.message+'\napi='+JSON.stringify({status:api.status,activation:api.body.data?.orchestratorActivationAvailable,topic:api.body.meta?.topic?.id})+'\nbureauResponse='+JSON.stringify(bureauResponse)+'\nstream='+JSON.stringify(stream)+'\n'+(await b.page.locator('body').innerText()).slice(-1500));
    });
    assert.equal(await hint.innerText(), 'Activez herdr pour regrouper les équipes');
  } finally { await b.close(); }
});
