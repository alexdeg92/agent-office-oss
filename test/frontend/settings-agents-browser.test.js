import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { browserSkipReason,openLayoutBrowser,visit } from './helpers/layout-browser.js';

const skip=browserSkipReason();
test('Settings agents keeps the connector in the URL through edits, save, reload, and shows the all-connectors roster', {skip,timeout:60000}, async()=>{
  const h=await openLayoutBrowser();
  try {
    const p=h.page;
    const vmErrors=[];
    p.on('console',event=>{if(event.type()==='error'&&event.text().startsWith('[vm]'))vmErrors.push(event.text());});
    await visit(p,h.origin,'/parametres?onglet=agents&mock=settings-fixall','#settings-section-form');
    await p.waitForFunction(()=>document.querySelector('#settings-section-form')?.getAttribute('aria-busy')==='false');
    assert.equal(await p.locator('#settings-agent-runtime').inputValue(),'all');
    assert.ok(await p.locator('[data-testid^="settings-agent-all-"]').count()>0,'all configured and detected agents appear');
    assert.equal(new URL(p.url()).searchParams.get('connecteur'),'all','the default all-agents view is URL-backed');
    const allRows=p.locator('.ao-settings__all-agent');
    assert.ok(await allRows.locator('.ao-settings__portrait img').count()>0,'all-agents rows use each canonical character portrait');
    assert.equal(await allRows.locator('.ao-settings__connector-mark').count(),await allRows.count(),'each agent portrait has its connector badge');
    assert.ok(await allRows.locator('.ao-settings__connector-mark').first().evaluate(el=>getComputedStyle(el).position==='absolute'),'connector mark is overlaid as a small corner badge');
    const claudeMark=p.locator('[data-testid="settings-agent-all-claude-local-helper"] .ao-settings__connector-mark');
    assert.ok((await claudeMark.locator('img').getAttribute('src')).endsWith('/assets/connectors/claude-code.svg'));
    await p.waitForFunction(()=>document.querySelector('[data-testid="settings-agent-all-claude-local-helper"] .ao-settings__connector-mark')?.classList.contains('ao-brand-mark--ready'));
    assert.equal(await claudeMark.evaluate(el=>getComputedStyle(el).borderColor),'rgb(184, 117, 62)','adapter-declared connector color frames the official mark');
    assert.equal(await p.locator('[data-testid="settings-agent-all-claude-local-helper"] .ao-settings__connector-name').innerText(),'Claude Code','provider label is independent of the connector instance alias');
    assert.ok((await p.locator('[data-testid="settings-agent-all-openclaw-atlas"] .ao-settings__connector-mark img').getAttribute('src')).endsWith('/assets/connectors/openclaw.svg'));
    assert.ok((await p.locator('[data-testid="settings-agent-all-codex-agent-office"] .ao-settings__connector-mark .ao-brand-mark__image--light').getAttribute('src')).endsWith('/assets/connectors/codex.svg'));
    if(process.env.SETTINGS_SCREENSHOTS==='1') {
      await mkdir('design/reports/settings-1',{recursive:true});
      await p.screenshot({path:'design/reports/settings-1/agents-all-1440.png',animations:'disabled'});
    }
    for(const [width,height] of [[390,844],[375,667]]) {
      await p.setViewportSize({width,height});
      const bounds=await p.evaluate(()=>({width:document.documentElement.scrollWidth,card:document.querySelector('.ao-settings__all-agents').getBoundingClientRect().toJSON(),select:document.querySelector('#settings-agent-runtime').getBoundingClientRect().toJSON(),rows:[...document.querySelectorAll('.ao-settings__all-agent')].map(row=>({row:row.getBoundingClientRect().toJSON(),text:row.querySelector('.bu-list-row__text').getBoundingClientRect().toJSON(),action:row.querySelector('.bu-list-row__actions').getBoundingClientRect().toJSON()}))}));
      assert.ok(bounds.width<=width,'all-agents layout fits mobile');
      assert.ok(bounds.select.right<=bounds.card.right+1,'connector selector stays inside its mobile row');
      assert.ok(bounds.rows.every(({row,text,action})=>row.width>0&&row.height>0&&action.top>=text.bottom-1),'mobile connector actions have their own line');
      if(process.env.SETTINGS_SCREENSHOTS==='1') await p.screenshot({path:`design/reports/settings-1/agents-all-${width}.png`,animations:'disabled'});
    }
    await p.setViewportSize({width:1440,height:900});
    await p.locator('#settings-agent-runtime').selectOption('openclaw');
    await p.waitForFunction(()=>new URL(location.href).searchParams.get('connecteur')==='openclaw');
    const row=p.locator('[data-testid^="settings-agent-row-"]').first();
    await row.getByRole('button',{name:/^Actions/}).click();
    await p.getByRole('menuitem',{name:'Renommer',exact:true}).click();
    const name=row.locator('input[id^="settings-agent-name-"]');
    await name.fill('Atlas enregistré');
    await p.locator('.ao-settings__footer button[type=submit]').click();
    await p.getByText('Modifications enregistrées.',{exact:true}).waitFor({state:'visible'}).catch(async()=>{
      await p.getByText('Enregistré.',{exact:true}).waitFor({state:'visible'});
    });
    assert.equal(new URL(p.url()).searchParams.get('connecteur'),'openclaw','save keeps the selected connector');
    assert.equal(await p.locator('#settings-agent-runtime').inputValue(),'openclaw');
    assert.ok(await p.locator('[data-testid^="settings-agent-row-"]').count()>0);
    assert.equal(await row.locator('input[id^="settings-agent-name-"]').count(),1,'saved editor remains available for a quick correction');
    const layout=await row.evaluate(el=>({row:el.getBoundingClientRect().toJSON(),avatar:el.querySelector('.bu-list-row__avatar').getBoundingClientRect().toJSON(),text:el.querySelector('.bu-list-row__text').getBoundingClientRect().toJSON()}));
    assert.ok(layout.avatar.top<=layout.text.top+4,'avatar remains aligned with the row content after save');
    const field=await row.locator('.ao-settings__agent-editor .bu-setting-row').evaluate(el=>({label:el.querySelector('.bu-setting-row__text').getBoundingClientRect().toJSON(),control:el.querySelector('.bu-setting-row__control').getBoundingClientRect().toJSON()}));
    assert.ok(field.label.bottom<=field.control.top+4,'the saved name editor stacks its label and input cleanly');
    if(process.env.SETTINGS_SCREENSHOTS==='1') await p.screenshot({path:'design/reports/settings-1/agents-openclaw-saved-1440.png',animations:'disabled'});
    await p.evaluate(async()=>{
      const {readSettings,settingsCommand}=await import('/settings-api.js');
      const vm=await readSettings(),rows=vm.agents.filter(agent=>agent.runtime==='openclaw'&&agent.configured);
      await settingsCommand('agents',{expectedRevision:vm.revision,runtime:'openclaw',primary:rows.find(agent=>agent.isPrimary)?.agentId||null,
        agents:rows.map(agent=>({id:agent.agentId,name:agent.agentId==='atlas'?'Atlas via SSE':agent.name,hidden:agent.hidden}))},'PUT');
    });
    await p.waitForFunction(()=>document.querySelector('#settings-agent-name-0')?.value==='Atlas via SSE');
    assert.equal(new URL(p.url()).searchParams.get('connecteur'),'openclaw','SSE refresh keeps the selected connector');
    await p.reload({waitUntil:'domcontentloaded'});
    await p.locator('#settings-section-form').waitFor();
    await p.waitForFunction(()=>document.querySelector('#settings-section-form')?.getAttribute('aria-busy')==='false');
    assert.equal(await p.locator('#settings-agent-runtime').inputValue(),'openclaw','reload restores selected connector from URL');
    assert.equal(new URL(p.url()).searchParams.get('connecteur'),'openclaw');
    assert.deepEqual(vmErrors,[],'branded SettingsVM responses pass the shared schema validation');
  } finally { await h.close(); }
  if(process.env.SETTINGS_SCREENSHOTS==='1') {
    const dark=await openLayoutBrowser({theme:'dark'});
    try {
      const p=dark.page;
      await visit(p,dark.origin,'/parametres?onglet=agents&connecteur=all&mock=settings-fixall','#settings-section-form');
      await p.waitForFunction(()=>document.querySelector('#settings-section-form')?.getAttribute('aria-busy')==='false');
      assert.equal(await p.locator('html').getAttribute('data-theme'),'dark');
      assert.ok(await p.locator('.ao-settings__all-agent .ao-settings__portrait').count()>0);
      await mkdir('design/reports/settings-1',{recursive:true});
      for(const [width,height] of [[1440,900],[390,844],[375,667]]) {
        await p.setViewportSize({width,height});
        await p.screenshot({path:`design/reports/settings-1/agents-all-dark-${width}.png`,animations:'disabled'});
      }
    } finally { await dark.close(); }
  }
});

test('Settings agents guards browser Back and keeps the editor and save target on one connector', {skip,timeout:60000}, async()=>{
  const h=await openLayoutBrowser();
  try {
    const p=h.page;
    await visit(p,h.origin,'/parametres?onglet=agents&connecteur=claude-local&mock=settings-fixall','#settings-section-form');
    await p.waitForFunction(()=>document.querySelector('#settings-section-form')?.getAttribute('aria-busy')==='false');
    // Create a real history entry for the other connector while keeping the app router in sync.
    await p.evaluate(()=>{
      const url=new URL(location.href);url.searchParams.set('connecteur','openclaw');
      history.pushState({},'',url);window.dispatchEvent(new PopStateEvent('popstate'));
    });
    await p.waitForFunction(()=>new URL(location.href).searchParams.get('connecteur')==='openclaw');
    await p.waitForFunction(()=>document.querySelector('#settings-agent-runtime')?.value==='openclaw');
    const openclawRow=p.locator('[data-testid^="settings-agent-row-"]').first();
    await openclawRow.getByRole('button',{name:/^Actions/}).click();
    await p.getByRole('menuitem',{name:'Renommer',exact:true}).click();
    await openclawRow.locator('input[id^="settings-agent-name-"]').fill('Unsaved OpenClaw');

    await p.goBack();
    const switchDialog=p.getByRole('dialog');
    await switchDialog.waitFor({state:'visible'});
    await switchDialog.getByRole('heading',{name:'Changer de moteur ?'}).waitFor();
    assert.equal(await p.locator('#settings-agent-runtime').inputValue(),'openclaw','a dirty Back navigation keeps the old editor visible while asking');
    await switchDialog.getByRole('button',{name:'Rester ici',exact:true}).click();
    await p.waitForFunction(()=>new URL(location.href).searchParams.get('connecteur')==='openclaw');
    assert.equal(await p.locator('#settings-agent-runtime').inputValue(),'openclaw','cancel restores the previous URL and selection');

    await p.goBack();
    await switchDialog.waitFor({state:'visible'});
    await switchDialog.getByRole('button',{name:'Changer de moteur',exact:true}).click();
    await p.waitForFunction(()=>new URL(location.href).searchParams.get('connecteur')==='claude-local');
    await p.waitForFunction(()=>document.querySelector('#settings-agent-runtime')?.value==='claude-local');
    assert.equal(await p.locator('[data-testid^="settings-agent-row-"]').count(),1,'Claude rows replace the discarded OpenClaw draft');
    const claudeRow=p.locator('[data-testid^="settings-agent-row-"]').first();
    assert.match(await claudeRow.innerText(),/Claude assistant/);
    await p.getByRole('button',{name:'Ajouter un agent',exact:true}).click();
    await p.locator('#settings-agent-id-1').fill('claude-back-check');
    await p.locator('#settings-agent-name-1').fill('Claude via guarded Back');
    await p.locator('.ao-settings__footer button[type=submit]').click();
    await p.getByText('Modifications enregistrées.',{exact:true}).waitFor({state:'visible'}).catch(async()=>{
      await p.getByText('Enregistré.',{exact:true}).waitFor({state:'visible'});
    });
    assert.equal(new URL(p.url()).searchParams.get('connecteur'),'claude-local');
    const saved=await p.evaluate(async()=>{
      const {readSettings}=await import('/settings-api.js');
      return (await readSettings()).agents.filter(agent=>agent.configured).map(({runtime,agentId,name})=>({runtime,agentId,name}));
    });
    assert.ok(saved.some(agent=>agent.runtime==='claude-local'&&agent.agentId==='claude-back-check'&&agent.name==='Claude via guarded Back'),'save targets the connector shown in the editor');
    assert.ok(!saved.some(agent=>agent.runtime==='openclaw'&&agent.name==='Unsaved OpenClaw'),'discarded edits never land on the previous connector');
  } finally { await h.close(); }
});
