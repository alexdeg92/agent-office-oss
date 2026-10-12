import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { browserSkipReason, openLayoutBrowser } from './helpers/layout-browser.js';

const skip = browserSkipReason();
async function fixture(page, origin) {
  const body = await readFile(new URL('./fixtures/bureau-forms.html', import.meta.url), 'utf8');
  await page.route('**/__bureau-forms.html', route => route.fulfill({ contentType:'text/html', body }));
  await page.goto(`${origin}/__bureau-forms.html`, { waitUntil:'networkidle' });
  await page.getByRole('textbox', { name:'Nom', exact:true }).waitFor();
  await page.evaluate(() => document.fonts.ready);
}
const patch = (page, value) => page.evaluate(value => window.bureauForms.patch(value), value);

test('Field: preserved native id, stable association, linked error/environment and removed optional references', { skip, timeout:15000 }, async () => {
  const b = await openLayoutBrowser(); const p = b.page;
  try {
    await fixture(p, b.origin);
    const input = p.getByRole('textbox', { name:'Nom', exact:true });
    assert.equal(await input.getAttribute('id'), 'agent-name');
    await p.locator('label[for="agent-name"]').click(); assert.equal(await input.evaluate(e => document.activeElement === e), true);
    assert.equal(await input.getAttribute('aria-describedby'), 'agent-name-hint');
    await patch(p, { error:'Nom incorrect', environment:true });
    assert.equal(await input.getAttribute('aria-describedby'), 'agent-name-hint agent-name-error agent-name-environment');
    assert.equal(await input.getAttribute('aria-invalid'), 'true');
    assert.equal(await p.getByRole('alert').innerText(), 'Nom incorrect');
    assert.match(await p.locator('#agent-name-environment').innerText(), /AO_AGENT_NAME/);
    assert.equal(await input.evaluate(e => e.readOnly), true);
    await patch(p, { error:null, hint:false, environment:false });
    assert.equal(await input.getAttribute('aria-describedby'), null); assert.equal(await input.getAttribute('aria-invalid'), null);
    assert.equal(await p.locator('#agent-name-hint,#agent-name-error,#agent-name-environment').count(), 0);
    assert.equal(await input.getAttribute('aria-labelledby'), 'agent-name-label');
  } finally { await b.close(); }
});

test('native text controls: event payload, controlled acceptance/decline/transform, textarea/select and attribute contracts', { skip, timeout:15000 }, async () => {
  const b = await openLayoutBrowser(); const p = b.page;
  try {
    await fixture(p, b.origin);
    const name = p.locator('#agent-name');
    await name.fill('Vega'); assert.equal(await name.inputValue(), 'Vega');
    assert.deepEqual(await p.evaluate(() => window.bureauForms.state.events.slice(0,2)), [
      { kind:'controlled', key:'name', value:'Vega' }, { kind:'input', key:'name', value:'Vega' },
    ]);
    await patch(p, { decline:true }); await name.fill('Refused');
    await p.waitForFunction(() => document.querySelector('#agent-name').value === 'Vega');
    assert.equal(await p.evaluate(() => window.bureauForms.state.events.filter(e => e.key === 'name').at(-1).value), 'Refused');
    await patch(p, { decline:false, transform:true }); await name.fill('nova');
    await p.waitForFunction(() => document.querySelector('#agent-name').value === 'NOVA');
    await patch(p, { transform:false });
    const url = p.locator('#agent-url'); await url.fill('https://office.example.test');
    assert.equal(await url.inputValue(), 'https://office.example.test', 'native-only onInput may update the controlled parent');
    await p.locator('#agent-notes').fill('Line one\nLine two'); assert.equal(await p.locator('#agent-notes').inputValue(), 'Line one\nLine two');
    await p.locator('#agent-runtime').selectOption('claude'); assert.equal(await p.locator('#agent-runtime').inputValue(), 'claude');
    assert.deepEqual(await p.evaluate(() => window.bureauForms.state.events.filter(e => e.key === 'runtime')), [
      { kind:'controlled', key:'runtime', value:'claude' }, { kind:'change', key:'runtime', value:'claude' },
    ]);
    assert.equal(await p.locator('#agent-runtime option[value=missing]').isDisabled(), true);
    assert.deepEqual(await p.locator('#agent-port').evaluate(e => ({ type:e.type,min:e.min,max:e.max,step:e.step })), { type:'number',min:'1',max:'65535',step:'1' });
    assert.deepEqual(await name.evaluate(e => ({ name:e.name,form:e.form.id,autocomplete:e.autocomplete,maxLength:e.maxLength,required:e.required })),
      { name:'agentName',form:'settings-form',autocomplete:'nickname',maxLength:80,required:true });
    assert.equal(await url.getAttribute('autocomplete'), 'off'); assert.equal(await url.getAttribute('spellcheck'), 'false');
    assert.deepEqual(await p.locator('#secret-contract').evaluate(e => ({ type:e.type,autocomplete:e.autocomplete,maxLength:e.maxLength,value:e.value })),
      { type:'password',autocomplete:'new-password',maxLength:1024,value:'' });
  } finally { await b.close(); }
});

test('Checkbox and Radio: mixed semantics, native keyboard groups, accepted and declined edits preserve event payload', { skip, timeout:15000 }, async () => {
  const b = await openLayoutBrowser({ touch:true }); const p = b.page;
  try {
    await fixture(p, b.origin);
    const check = p.getByRole('checkbox', { name:'Actif dans le bureau' });
    await patch(p, { mixed:true }); assert.equal(await check.evaluate(e => e.indeterminate), true);
    await check.focus(); await p.keyboard.press('Space');
    assert.equal(await check.isChecked(), true); assert.equal(await check.evaluate(e => e.indeterminate), true, 'mixed remains parent-owned');
    assert.deepEqual(await p.evaluate(() => window.bureauForms.state.events.filter(e => e.key.startsWith('active'))), [
      { kind:'input',key:'active-input',value:true }, { kind:'change',key:'active-change',value:true },
    ]);
    await patch(p, { mixed:false, checked:false, decline:true }); await p.keyboard.press('Space');
    await p.waitForFunction(() => !document.querySelector('#agent-active').checked);
    assert.equal(await p.evaluate(() => window.bureauForms.state.events.filter(e => e.key === 'active-change').at(-1).value), true);
    const a = p.getByRole('radio', { name:'Atlas' }), v = p.getByRole('radio', { name:'Vega' });
    await v.click(); await p.waitForFunction(() => document.querySelector('#primary-a').checked && !document.querySelector('#primary-b').checked);
    assert.equal(await a.isChecked(), true, 'declined selection restores the previously checked native group member');
    await patch(p, { decline:false }); await a.focus(); await p.keyboard.press('ArrowDown');
    assert.equal(await v.isChecked(), true); assert.equal(await a.isChecked(), false);
    assert.equal(await v.evaluate(e => document.activeElement === e), true);
    await p.setViewportSize({ width:375,height:667 }); await check.locator('..').tap(); assert.equal(await check.isChecked(), true);
  } finally { await b.close(); }
});

test('Button: native external form submission and constraint validation, pending retains focus/name and blocks activation', { skip, timeout:15000 }, async () => {
  const b = await openLayoutBrowser(); const p = b.page;
  try {
    await fixture(p, b.origin);
    const save = p.getByRole('button', { name:'Enregistrer', exact:true });
    await save.click();
    assert.deepEqual(await p.evaluate(() => window.bureauForms.state.submits), [{
      agentName:'Atlas', port:'18789',runtime:'openclaw',url:'https://example.test',notes:'Équipe de démonstration',primary:'a',secret:'',intent:'save',
    }]);
    await patch(p, { port:'65536' }); await save.click();
    assert.equal(await p.evaluate(() => window.bureauForms.state.submits.length), 1, 'native max validation blocks submit');
    assert.equal(await p.locator('#agent-port').evaluate(e => e.validity.rangeOverflow), true);
    await patch(p, { port:'18789' }); await p.locator('#agent-name').focus(); await p.keyboard.press('Enter');
    assert.equal(await p.evaluate(() => window.bureauForms.state.submits.length), 2, 'Enter resolves the external native submit button');
    await p.getByRole('checkbox').check(); await p.getByRole('radio', { name:'Vega' }).check(); await save.click();
    const submitted = await p.evaluate(() => window.bureauForms.state.submits.at(-1));
    assert.equal(submitted.active, 'yes'); assert.equal(submitted.primary, 'b'); assert.equal(submitted.intent, 'save');
    await save.focus(); await patch(p, { busy:true });
    assert.equal(await save.evaluate(e => document.activeElement === e), true);
    assert.equal(await save.getAttribute('aria-busy'), 'true'); assert.equal(await save.innerText(), 'Enregistrer');
    assert.equal(await save.locator('.bu-compact-progress').count(), 1);
    await p.keyboard.press('Space'); await save.evaluate(e => { e.click(); e.click(); });
    assert.equal(await p.evaluate(() => window.bureauForms.state.submits.length), 3);
    await p.locator('#agent-name').focus(); await p.keyboard.press('Enter');
    assert.equal(await p.evaluate(() => window.bureauForms.state.submits.length), 3, 'busy external submit also blocks implicit submit');
    assert.equal(await p.locator('#agent-name').evaluate(e => e.readOnly), true);
    const calls = await p.evaluate(() => window.bureauForms.state.events.length);
    await p.getByRole('checkbox').evaluate(e => e.click()); await p.getByRole('radio', { name:'Vega' }).evaluate(e => e.click());
    await p.getByRole('radio', { name:'Vega' }).focus(); await p.keyboard.press('ArrowUp');
    assert.equal(await p.getByRole('radio', { name:'Vega' }).isChecked(), true);
    await p.locator('#agent-runtime').focus(); await p.keyboard.press('ArrowDown');
    assert.equal(await p.locator('#agent-runtime').inputValue(), 'openclaw');
    assert.equal(await p.evaluate(() => window.bureauForms.state.events.length), calls);
    await patch(p, { busy:false, disabled:true }); assert.equal(await save.isDisabled(), true);
  } finally { await b.close(); }
});

test('forms: native desktop/mobile light/dark state evidence and full labelled hit targets', { skip, timeout:45000 }, async () => {
  const b = await openLayoutBrowser(); const p = b.page; const records = [];
  const revision = execFileSync('git', ['rev-parse','HEAD'], { encoding:'utf8' }).trim();
  try {
    await fixture(p, b.origin); await p.emulateMedia({ reducedMotion:'reduce' });
    for (const [width,height] of [[1440,900],[390,844],[375,667]]) for (const theme of ['light','dark']) for (const scenario of ['default','invalid','pending','long-en','disabled','environment']) {
      await p.setViewportSize({ width,height });
      await p.evaluate(({ theme,scenario }) => {
        document.documentElement.dataset.theme = theme;
        window.bureauForms.setLang(scenario === 'long-en' ? 'en' : 'fr');
        window.bureauForms.patch({ english:scenario === 'long-en',long:scenario === 'long-en',error:scenario === 'invalid' ? 'Vérifiez le nom de cet agent avant de continuer.' : null,
          busy:scenario === 'pending',disabled:scenario === 'disabled',environment:scenario === 'environment',mixed:scenario === 'default',checked:scenario === 'long-en',hint:true });
        document.querySelector('[data-scroll-body]').scrollTop = 0;
        document.activeElement.blur();
      }, { theme,scenario });
      if (scenario === 'default') {
        await p.locator('#agent-name').focus(); await p.keyboard.press('Tab'); await p.keyboard.press('Shift+Tab');
      }
      const geometry = await p.evaluate(() => ({
        root:{ width:document.documentElement.scrollWidth,height:document.documentElement.scrollHeight },
        targets:[...document.querySelectorAll('.bu-text-input,.bu-choice,.bu-button')].map(e => ({ tag:e.tagName,...e.getBoundingClientRect().toJSON() })),
        footer:document.querySelector('.ao-frame__foot').getBoundingClientRect().toJSON(),
        pending:document.querySelector('#save').getAttribute('aria-busy'),
        focus:getComputedStyle(document.querySelector('#agent-name')).outlineStyle,
        inputSize:parseFloat(getComputedStyle(document.querySelector('#agent-name')).fontSize),
      }));
      assert.ok(geometry.root.width <= width && geometry.root.height <= height, 'document remains fixed');
      assert.ok(geometry.targets.every(r => r.height >= (width <= 820 ? 44 : 40) && r.left >= 0 && r.right <= width), 'native controls/associated choice hit regions fit');
      assert.ok(Math.abs(geometry.footer.bottom-height) <= 1, 'footer stays at frame bottom');
      assert.equal(geometry.pending, scenario === 'pending' ? 'true' : null);
      if (scenario === 'default') assert.equal(geometry.focus, 'solid');
      if (width <= 820) assert.ok(geometry.inputSize >= 16, 'native mobile fields avoid focus zoom');
      if (process.env.BUREAU_SCREENSHOTS === '1') {
        const dir = 'design/reports/bureau-components-checkpoint-4', filename = `forms-${width}-${theme}-${scenario}.png`;
        await mkdir(dir, { recursive:true }); await p.screenshot({ path:`${dir}/${filename}` });
        records.push({ filename,revision,width,height,theme,scenario,geometry });
      }
    }
    if (records.length) await writeFile('design/reports/bureau-components-checkpoint-4/captures.json', JSON.stringify(records,null,2)+'\n');
  } finally { await b.close(); }
});
