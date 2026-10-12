import test from 'node:test';
import assert from 'node:assert/strict';
import * as R from '../../public/v2/pages/settings-rules.js';
import { connectorFixture } from './helpers/settings-connectors-fixture.js';
test('provider grouping accepts any adapter, aliases instance routes and uses saved connection evidence',async()=>{
 const vm=(await connectorFixture()).data,draft=R.initialDrafts(vm).connexion;
 let providers=R.connectionProviders(draft,vm);
 assert.equal(providers.length,6);
 const claude=R.connectionProvider(providers,'claude-local');
 assert.equal(claude.id,'claude-code');assert.equal(claude.rows.length,2);assert.equal(claude.instances,1);assert.equal(claude.status,'connected');
 assert.equal(R.connectionProvider(providers,'codex').status,'detected','a candidate probe is not a connection');
 draft.enabled.codex=true;assert.equal(R.connectionProvider(R.connectionProviders(draft,vm),'codex').status,'detected','pending activation does not claim success');
 const added=R.addRuntime(draft,vm,vm.runtimes[0]);
 assert.equal(R.connectionProvider(R.connectionProviders(added,vm),'openclaw').rows.length,2);
 assert.equal(R.connectionProvider(R.connectionProviders(added,vm),'openclaw').instances,1,'draft additions are not saved instances');
 vm.runtimes[0].connection.status='unauthorized';assert.equal(R.connectionProvider(R.connectionProviders(draft,vm),'openclaw').status,'error');
 vm.runtimes[0].enabled=false;assert.equal(R.connectionProvider(R.connectionProviders(draft,vm),'openclaw').status,'detected');
 const future={...vm.runtimes[0],id:'future-instance',adapter:'future-provider',brand:{providerName:'Future Provider',logo:'assets/connectors/codex.svg'}};
 vm.runtimes.push(future);providers=R.connectionProviders(draft,vm);
 assert.equal(R.connectionProvider(providers,'future-instance').name,'Future Provider');assert.equal(R.connectionProvider(providers,'future-provider').brand.logo,future.brand.logo);
 assert.equal(R.connectionProvider(providers,'missing'),undefined);
});

test('herdr source is one provider with saved activation and health, independent of runtime instances',async()=>{
 const vm=(await connectorFixture()).data;vm.herdr={found:true,enabled:true,active:true,status:'available',checkedAt:1234};
 const draft=R.initialDrafts(vm).connexion;
 let source=R.connectionProvider(R.connectionProviders(draft,vm),'herdr');
 assert.equal(source.kind,'source');assert.equal(source.status,'connected');assert.deepEqual(source.rows,[]);
 draft.herdrEnabled=false;assert.equal(R.connectionProvider(R.connectionProviders(draft,vm),'herdr').status,'connected','an unsaved disable preserves the saved badge');
 const body=R.runtimesBody(draft,vm);assert.equal(body.herdrEnabled,false);assert.ok(body.runtimes.every(r=>r.adapter!=='herdr'));
 vm.herdr.status='not-checked';assert.equal(R.connectionProvider(R.connectionProviders(draft,vm),'herdr').status,'running');vm.herdr.status='available';
 vm.herdr.enabled=false;vm.herdr.active=false;assert.equal(R.connectionProvider(R.connectionProviders(draft,vm),'herdr').status,'detected');
 vm.herdr.enabled=true;vm.herdr.status='stale';assert.equal(R.connectionProvider(R.connectionProviders(draft,vm),'herdr').status,'error');
 vm.herdr.enabled=false;vm.herdr.found=false;assert.equal(R.connectionProvider(R.connectionProviders(draft,vm),'herdr').status,'notDetected');
 const absent={...vm};delete absent.herdr;assert.equal(R.connectionProvider(R.connectionProviders(draft,absent),'herdr'),undefined,'legacy VMs without a source do not fabricate cards');
});

test('unrelated runtime edits preserve the source default; only explicit source changes are sent',async()=>{
 const vm=(await connectorFixture()).data,draft=R.initialDrafts(vm).connexion;
 draft.names.openclaw='Synthetic renamed gateway';
 assert.equal(Object.hasOwn(R.runtimesBody(draft,vm),'herdrEnabled'),false,'absence stays automatic when another runtime is edited');
 draft.herdrTouched=true;draft.herdrEnabled=false;
 assert.equal(R.runtimesBody(draft,vm).herdrEnabled,false,'an intentional OFF is sent even while the default is waiting for a response');
});
