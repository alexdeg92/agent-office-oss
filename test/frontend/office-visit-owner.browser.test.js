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

for (const groupConversation of [false, true]) test(groupConversation
  ? 'group conversation still visits its canonical owner in the mounted Bureau'
  : 'human contact annotates only its canonical owner in the mounted Bureau at desktop and mobile', { skip, timeout: 180000 }, async () => {
  await mkdir(OUT, { recursive: true });
  let browser, fixture, baseline;
  try {
    browser = await openLayoutBrowser({ apiVersion: 3, apiProxy: async publicUrl => {
      fixture = await officeSceneFixture({ publicUrl, occupantCount: 2, namedAgents: true, primaryName: 'Atlas', ...emptyTeamOptions, enrichment: {
        handles: id => id === 'discord-user:synthetic-visit-1',
        nameOf: id => id === 'discord-user:synthetic-visit-1' ? 'Riley Contact' : null,
        peek: id => ({ resolution: 'resolved', profile: { id, displayName: 'Riley Contact', avatarUrl: null } }),
        resolve: async () => {}, resolveAll: async () => {}, onChange: () => () => {},
      } });
      baseline = (await fixture.get('/api/v3/views/office')).json.data;
      const at = fixture.clock.value;
      const contact = {
        key: 'synthetic:discord:contact-session', sessionId: null,
        class: { kind: groupConversation ? 'conversation-group' : 'conversation-direct', ruleId: 'synthetic', agentId: 'atlas', channel: 'discord',
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
    assert.ok(owner);
    const rawId = 'discord-user:synthetic-visit-1';
    const expected = 'En conversation avec Riley Contact · Discord';
    if (groupConversation) {
      assert.ok(contact, 'a group conversation remains a physical visitor');
      assert.equal(contact.parentId, owner.id, 'canonical owner overrides worker parentKey');
      assert.equal(contact.stationUid, null);
      assert.equal(contact.sceneTarget.kind, 'visit');
      assert.equal(vm.visitIntent.visitors.find(row => row.id === contact.id).hostId, owner.id);
      const hostGroup = vm.rosterItems.find(item => item.occupantIds?.includes(contact.id));
      assert.equal(hostGroup?.rootId, owner.id);
      assert.ok(hostGroup.childIds.includes(contact.id));
    } else {
      assert.equal(contact, undefined, 'a human DM never becomes an occupant');
      assert.equal(vm.occupants.length, 2, 'only the two canonical agents remain');
      assert.deepEqual(owner.visitLabel, { key: 'office.visitingWithChannel', params: {
        name: 'Riley Contact', channel: { key: 'channel.discord' } } });
      assert.equal(vm.visitIntent?.visitors?.length || 0, 0);
      assert.ok(vm.occupants.every(row => row.stateKind !== 'visitor' && !row.visitPhase));
      assert.deepEqual(vm.rosterItems.map(item => ({ id: item.id, rootId: item.rootId, childIds: item.childIds, occupantIds: item.occupantIds })),
        baseline.rosterItems.map(item => ({ id: item.id, rootId: item.rootId, childIds: item.childIds, occupantIds: item.occupantIds })),
        'the DM creates no additional occupant, visitor or host group in the roster');
    }
    assert.ok(owner.stationUid, 'the owner keeps its desk');
    for (const row of vm.occupants) assert.equal(JSON.stringify({ name: row.name, summary: row.summary,
      title: row.title, roleLabel: row.roleLabel, stateLabel: row.stateLabel, visitLabel: row.visitLabel }).includes(rawId), false);
    assert.equal(vm.kpis.find(row => row.id === 'active').value, 1);
    assert.equal(vm.kpis.find(row => row.id === 'active').sub.params.n, 2, 'conversation is not an extra agent');
    assert.equal(vm.rosterSummary.count, 2);
    assert.equal(vm.rosterSummary.activeCount, 1);
    const ownerFloor = vm.rosterFloors.find(row => row.id === owner.floorId);
    assert.equal(ownerFloor.count, 2);
    assert.equal(ownerFloor.activeCount, 1);

    for (const theme of ['light', 'dark']) {
      await page.addInitScript(value => localStorage.setItem('ao.uiTheme', value), theme);
      for (const [width, height] of [[1440, 900], [390, 844]]) {
        await page.setViewportSize({ width, height });
        await page.goto(`${browser.origin}/bureau`, { waitUntil: 'domcontentloaded' });
        assert.equal(await page.locator('html').getAttribute('data-theme'), theme);
        await page.locator('.ao-bureau__stage').waitFor({ state: 'visible' });
        await page.waitForFunction(({ ownerId, visitorId }) => {
          const scene = document.querySelector('.ao-bureau__stage')?.aoScene;
          const host = scene?.chars.get(ownerId);
          if (!host || host.walking || !host.target?.uid) return false;
          if (!visitorId) return scene.chars.size === 2;
          const visitor = scene.chars.get(visitorId);
          return visitor && !visitor.walking && visitor.target?.uid && visitor.occ.sceneTarget?.kind === 'visit';
        }, { ownerId: owner.id, visitorId: contact?.id });
        const rendered = await page.evaluate(({ ownerId, visitorId }) => {
          const scene = document.querySelector('.ao-bureau__stage').aoScene;
          const host = scene.chars.get(ownerId), visitor = scene.chars.get(visitorId);
          return { hostState: host.occ.state, hostSeat: host.seatMode, ids: [...scene.chars.keys()],
            visitor: visitor ? { parent: visitor.occ.parentId, floor: visitor.occ.floorId,
              target: visitor.target, position: visitor.pos } : null };
        }, { ownerId: owner.id, visitorId: contact?.id });
        assert.equal(rendered.hostState, owner.state);
        assert.equal(rendered.hostSeat, 'desk');
        if (groupConversation) {
          assert.equal(rendered.visitor.parent, owner.id);
          assert.equal(rendered.visitor.floor, owner.floorId);
          assert.ok(rendered.visitor.target);
          assert.ok(Number.isFinite(rendered.visitor.position.x) && Number.isFinite(rendered.visitor.position.y));
        } else {
          assert.deepEqual(rendered.ids.sort(), vm.occupants.map(row => row.id).sort(), 'scene has only canonical agents');
        }
        if (width < 600) {
          const preview = page.locator('.ao-mobile-team-preview').filter({ has: page.locator(`[data-floor-agent-occupant="${owner.id}"]`) });
          if (await preview.count()) await preview.click();
        }
        const card = page.locator(`.ao-roster[data-occupant="${groupConversation ? contact.id : owner.id}"]:visible, [data-mobile-agent="${groupConversation ? contact.id : owner.id}"]:visible`).first();
        await card.waitFor({ state: 'visible' });
        const line = card.locator('.ao-roster__summary, .bu-cell-sub').first();
        assert.equal((await line.innerText()).trim(), groupConversation ? 'En conversation avec Atlas' : expected);
        assert.equal(await line.evaluate(node => node.scrollWidth <= node.clientWidth + 1), true, 'conversation line is readable without horizontal clipping');
        assert.equal((await page.locator('body').innerText()).includes(rawId), false, 'raw chat id never reaches displayed text');
        if (!groupConversation) {
          assert.equal(await page.locator('[data-state-kind="visitor"]:visible').count(), 0);
          assert.equal(await page.locator('.ao-roster__name:visible').filter({ hasText: 'Riley Contact' }).count(), 0);
        }
        await page.evaluate(async () => { await document.fonts.ready; });
        await page.screenshot({ path: `${OUT}/${groupConversation ? 'group' : 'direct'}-${width}-${theme}.png`, animations: 'disabled' });
      }
    }
    assert.notDeepEqual(await readFile(`${OUT}/${groupConversation ? 'group' : 'direct'}-390-light.png`),
      await readFile(`${OUT}/${groupConversation ? 'group' : 'direct'}-390-dark.png`), 'mobile light and dark themes differ');
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    await fixture?.close();
  }
});
