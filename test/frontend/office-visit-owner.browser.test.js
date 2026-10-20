import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { openLayoutBrowser, browserSkipReason } from './helpers/layout-browser.js';

const require = createRequire(import.meta.url);
const { officeSceneFixture } = require('../helpers/office-scene-fixture.cjs');
const { emptyTeamOptions } = require('../helpers/office-empty-team-source.cjs');
const OUT = 'design/reports/human-contact-visit-0140';
const skip = browserSkipReason();

test('human contact visits its canonical owner in the mounted Bureau at desktop and mobile', { skip, timeout: 180000 }, async () => {
  await mkdir(OUT, { recursive: true });
  let browser, fixture;
  try {
    browser = await openLayoutBrowser({ apiVersion: 3, apiProxy: async publicUrl => {
      fixture = await officeSceneFixture({ publicUrl, occupantCount: 2, namedAgents: true, primaryName: 'Atlas', ...emptyTeamOptions, enrichment: {
        handles: id => id === 'discord-user:synthetic-visit-1',
        nameOf: id => id === 'discord-user:synthetic-visit-1' ? 'Riley Contact' : null,
        peek: id => ({ resolution: 'resolved', profile: { id, displayName: 'Riley Contact', avatarUrl: null } }),
        resolve: async () => {}, resolveAll: async () => {}, onChange: () => () => {},
      } });
      const at = fixture.clock.value;
      const contact = {
        key: 'synthetic:discord:contact-session', sessionId: null,
        class: { kind: 'conversation-direct', ruleId: 'synthetic', agentId: 'atlas', channel: 'discord',
          interlocutorId: 'discord-user:synthetic-visit-1', heartbeatOf: null, background: false, rawClassification: null },
        displayName: 'Contact test', summarySource: 'runtime', summary: null, model: null, provider: 'synthetic',
        usage: { total: 0, input: null, output: null }, updatedAt: at,
        run: { status: 'running', endReason: null, evidence: 'status-field', evidenceLevel: 'verified', observedAt: at,
          expiresAt: at + 30_000, startedAt: at - 1000, endedAt: null, hasActiveSubagentRun: false, runtimeMs: null,
          lastRunId: null, lastError: null },
        costUsd: null, parentKey: 'worker-1', childKeys: [], goal: null, cwd: null, messageCount: 2, interactive: true, group: null,
      };
      const accepted = fixture.viewEngine.ingestCanonical('sessions.snapshot', [...fixture.viewEngine.sessions(), contact]);
      assert.equal(accepted.ok, true, JSON.stringify(accepted.issues));
      fixture.api.topics.invalidate();
      return fixture.base;
    } });
    const { page } = browser;
    const cookieSplit = fixture.cookie.indexOf('=');
    await page.context().addCookies([{ name: fixture.cookie.slice(0, cookieSplit), value: fixture.cookie.slice(cookieSplit + 1),
      url: browser.origin, httpOnly: true, sameSite: 'Lax' }]);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));

    const response = await fixture.get('/api/v3/views/office');
    assert.equal(response.status, 200, response.text);
    const vm = response.json.data;
    const owner = vm.occupants.find(row => row.id === 'primary');
    const contact = vm.occupants.find(row => row.sessionKey === 'synthetic:discord:contact-session');
    assert.ok(owner && contact);
    assert.equal(contact.name, 'Riley Contact', 'the visitor uses its safe resolved human display identity');
    assert.equal(JSON.stringify({ name: contact.name, summary: contact.summary, title: contact.title, roleLabel: contact.roleLabel,
      stateLabel: contact.stateLabel }).includes('discord-user:synthetic-visit-1'), false, 'display text in the OfficeVM never contains the raw chat identity');
    assert.equal(contact.parentId, owner.id, 'canonical session owner overrides the worker parentKey');
    assert.equal(contact.parentName, null, 'a visitor is not described as launched by its host');
    assert.deepEqual(contact.roleLabel, { key: 'occupantRole.visitor' });
    assert.deepEqual(contact.stateLabel, { key: 'occupantRole.visitor' });
    assert.equal(contact.rosterDepth, 1);
    assert.equal(contact.floorId, owner.floorId);
    assert.equal(contact.stationUid, null, 'the visitor has no desk of its own');
    assert.equal(contact.sceneTarget.kind, 'visit');
    assert.ok(owner.stationUid, 'the host stays assigned to its own desk');
    assert.equal(vm.visitIntent.visitors.find(row => row.id === contact.id).hostId, owner.id);
    assert.deepEqual(vm.kpis.find(row => row.id === 'active').value, 1, 'a working visiting person is not an active agent');
    assert.equal(vm.kpis.find(row => row.id === 'active').sub.params.n, 2, 'on-stage agent count excludes the visiting person');
    assert.equal(vm.rosterSummary.count, 2);
    assert.equal(vm.rosterSummary.activeCount, 1);
    const ownerFloor = vm.rosterFloors.find(row => row.id === owner.floorId);
    assert.equal(ownerFloor.count, 2);
    assert.equal(ownerFloor.activeCount, 1);
    const mobileGroup = vm.rosterItems.find(item => item.occupantIds.includes(contact.id));
    assert.ok(mobileGroup, 'the backend supplies a host group containing its current visitor');
    assert.equal(mobileGroup.rootId, owner.id);
    assert.equal(mobileGroup.childIds.includes(contact.id), true);

    for (const theme of ['light', 'dark']) {
      await page.addInitScript(value => localStorage.setItem('ao.uiTheme', value), theme);
      for (const [width, height, touch] of [[1440, 900, false], [390, 844, true]]) {
        await page.setViewportSize({ width, height });
        await page.goto(`${browser.origin}/bureau`, { waitUntil: 'domcontentloaded' });
        assert.equal(await page.locator('html').getAttribute('data-theme'), theme);
        await page.locator('.ao-bureau__stage').waitFor({ state: 'visible' });
        try {
          await page.waitForFunction(({ ownerId, contactId }) => {
            const scene = document.querySelector('.ao-bureau__stage')?.aoScene;
            const host = scene?.chars.get(ownerId), visitor = scene?.chars.get(contactId);
            return host && visitor && !host.walking && !visitor.walking && host.target?.uid
              && visitor.occ.sceneTarget?.kind === 'visit' && visitor.target?.uid;
          }, { ownerId: owner.id, contactId: contact.id });
        } catch (error) {
          const debug = await page.evaluate(({ ownerId, contactId }) => {
            const scene = document.querySelector('.ao-bureau__stage')?.aoScene;
            return { ownerId, contactId, chars: scene ? [...scene.chars.keys()] : null,
              occupants: scene ? [...scene.chars.values()].map(char => ({ id: char.id, floorId: char.occ?.floorId, target: char.target?.uid,
                kind: char.occ?.sceneTarget?.kind, walking: char.walking })) : null,
              stageFloor: document.querySelector('.ao-bureau__stage')?.dataset.floor,
              packError: document.querySelector('.ao-bureau__stage')?.dataset.packError,
              body: document.body.innerText.slice(-1000) };
          }, { ownerId: owner.id, contactId: contact.id });
          throw new Error(error.message + '\nScene debug: ' + JSON.stringify({ ...debug, errors }));
        }
        await page.evaluate(async () => { await document.fonts.ready; await Promise.all([...document.querySelectorAll('.ao-bureau__stage img[src]')].map(image => image.decode().catch(() => {}))); });
        const rendered = await page.evaluate(({ ownerId, contactId }) => {
          const scene = document.querySelector('.ao-bureau__stage').aoScene;
          const host = scene.chars.get(ownerId), visitor = scene.chars.get(contactId);
          return { hostState: host.occ.state, hostSeat: host.seatMode, hostFloor: host.occ.floorId,
            visitorFloor: visitor.occ.floorId, visitorParent: visitor.occ.parentId,
            visitorServerTarget: visitor.occ.sceneTarget,
            visitorTarget: visitor.target, visitorPosition: visitor.pos };
        }, { ownerId: owner.id, contactId: contact.id });
        assert.equal(rendered.hostState, owner.state, 'the scene keeps the backend-projected host state');
        assert.equal(rendered.hostSeat, 'desk', 'host remains seated while the person visits');
        assert.equal(rendered.visitorFloor, rendered.hostFloor);
        assert.equal(rendered.visitorParent, owner.id);
        assert.equal(rendered.visitorServerTarget.kind, 'visit', 'the backend supplies the visitor target');
        assert.ok(rendered.visitorTarget, 'the visitor has a resolved target beside the host');
        assert.ok(Number.isFinite(rendered.visitorPosition.x) && Number.isFinite(rendered.visitorPosition.y));
        const rosterRow = page.locator(`.ao-bureau__roster [data-occupant="${contact.id}"]`);
        await rosterRow.waitFor({ state: 'attached' });
        assert.equal(await rosterRow.evaluate(row => row.closest('li').classList.contains('ao-roster__child')), true,
          'the roster renders the visitor beneath its owner');
        if (width === 1440) {
          assert.equal(await rosterRow.locator('.ao-roster__summary').innerText(), 'En conversation avec Atlas');
          assert.equal(await rosterRow.locator('.bu-cell-main').getAttribute('data-by'), null,
            'the visitor relationship uses its visit label, never the launcher wording');
        } else {
          const ownerGroup = page.locator('.ao-mobile-group').filter({ has: page.locator(`.ao-mobile-parent[data-mobile-agent="${owner.id}"]`) });
          await ownerGroup.locator('.ao-mobile-stack').click();
          await page.locator('.ao-office-sheet[role="dialog"]').waitFor({ state: 'visible' });
          assert.equal(await page.locator('.ao-office-sheet .bu-modal__title').innerText(), 'Équipe · Atlas');
          await page.waitForFunction(() => {
            const avatars = [...document.querySelectorAll('.ao-office-sheet .ao-character-avatar')];
            return avatars.length >= 3 && avatars.every(avatar => avatar.dataset.avatarReady === 'true');
          }, null, { timeout: 15000 });
          const sheetVisitor = page.locator(`.ao-office-sheet [data-occupant="${contact.id}"]`);
          await sheetVisitor.waitFor({ state: 'visible' });
          await page.waitForFunction(id => {
            const image = document.querySelector(`.ao-office-sheet [data-occupant="${CSS.escape(id)}"] .ao-character-avatar img`);
            return image?.complete && image.naturalWidth > 0;
          }, contact.id, { timeout: 15000 });
          assert.equal(await sheetVisitor.locator('.ao-roster__state').innerText(), 'En visite');
          assert.equal(await sheetVisitor.locator('.ao-roster__state').getAttribute('data-state-kind'), 'visitor');
          assert.equal(await sheetVisitor.locator('.ao-roster__state').getAttribute('data-agent-state'), 'visitor',
            'visit presence uses a neutral visitor tone rather than the working state treatment');
          assert.equal(await sheetVisitor.evaluate(row => row.closest('li').classList.contains('ao-roster__child')), true,
            'the mobile grouped roster exposes the visiting contact under its exact host');
          await page.getByRole('button', { name: 'Fermer', exact: true }).last().click();
          const parentCard = page.locator(`.ao-mobile-parent[data-mobile-agent="${owner.id}"]`);
          await parentCard.click();
          await page.locator('.bu-drawer').waitFor({ state: 'visible' });
          const back = page.getByRole('button', { name: 'Équipe · Atlas', exact: true });
          await back.waitFor({ state: 'visible' });
          await back.click();
          await page.getByRole('dialog', { name: 'Équipe · Atlas', exact: true }).waitFor();
          assert.equal(await page.locator('.ao-office-sheet .bu-modal__title').innerText(), 'Équipe · Atlas',
            'the server-provided team label survives parent-card → drawer → Back');
          assert.equal(await page.locator('.bu-drawer').count(), 0, 'Back closes the drawer before restoring the team sheet');
          await page.waitForFunction(() => {
            const avatars = [...document.querySelectorAll('.ao-office-sheet .ao-character-avatar')];
            return avatars.length >= 3 && avatars.every(avatar => avatar.dataset.avatarReady === 'true'
              && [...avatar.querySelectorAll('img')].every(image => image.complete && image.naturalWidth > 0));
          }, null, { timeout: 15000 });
        }
        await page.screenshot({ path: `${OUT}/${width}-${theme}-active.png`, animations: 'disabled' });
      }
    }
    assert.notDeepEqual(await readFile(`${OUT}/390-light-active.png`), await readFile(`${OUT}/390-dark-active.png`),
      'light and dark mobile captures must show distinct applied themes');
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    await fixture?.close();
  }
});
