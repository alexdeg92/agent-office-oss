import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openLayoutBrowser, browserSkipReason } from './helpers/layout-browser.js';

const require = createRequire(import.meta.url);
const { officeSceneFixture } = require('../helpers/office-scene-fixture.cjs');
const { createOrchestratorTeamSnapshots } = require('../../src/sources/orchestrator-team-snapshots.js');
const { projectSnapshot } = require('../../src/adapters/agent-team-pm/store-reader.js');
const { openSse } = require('../helpers/sse-client.js');

const names = ['Atlas', 'Claude Task A', 'Claude Task B', 'Claude Task C', 'Codex Task A', 'Codex Task B', 'Codex Task C'];
const runtimes = ['claude-acp', 'claude-native-task', 'claude-native-task', 'claude-native-task', 'codex-acp', 'codex-acp', 'codex-acp'];
const memberIds = names.map((_, index) => `member:${String(index + 1).padStart(8, '0')}-aaaa-4aaa-8aaa-${String(index + 1).padStart(12, '0')}`);
const refs = names.map((_, index) => `acp-session-${index + 1}`);
const sessionKeys = names.map((_, index) => index === 0 ? 'main' : `worker-${index}`);
const titleCanary = 'CANARY-SUMMARY-private-runtime-title';
const teamAt = () => Date.now();

function syntheticTeamSource({ engine, teamRoot }) {
  const root = teamRoot;
  for (const dir of ['members', 'tasks', 'inbox']) fs.mkdirSync(path.join(root, dir), { recursive: true });
  for (let index = 0; index < names.length; index++) {
    const record = {
      id: memberIds[index], name: names[index], role: index === 0 ? 'lead' : 'engineer', runtime: runtimes[index],
      herdrPane: null, session: { source: 'synthetic-acp', kind: 'agent_session', value: refs[index] },
      spawnedBy: index === 0 ? null : memberIds[0], registered: '2026-10-20T12:00:00', updated: '2026-10-20T12:00:00',
    };
    fs.writeFileSync(path.join(root, 'members', `member-${index + 1}.json`), JSON.stringify(record), { mode: 0o600 });
  }
  engine.setIdentitySessionRefs(names.map((_, index) => ({
    sessionKey: sessionKeys[index], sessionRef: refs[index], agentId: index === 0 ? 'atlas' : `worker-${index}`,
  })));
  const read = () => projectSnapshot({ root, label: 'Headless ACP synthetic team', now: teamAt });
  const teamStore = { start({ onSnapshot }) { onSnapshot(read()); }, stop() {}, refresh: async () => read() };
  return createOrchestratorTeamSnapshots({ teamStore, runtimeIdentitySessions: () => engine.identitySessions('synthetic-office'), now: teamAt });
}

test('headless ACP team members join the mounted Office by exact session ref and render by registered name', {
  skip: browserSkipReason(), timeout: 120000,
}, async () => {
  let h, browser;
  const teamRoot = await mkdtemp(path.join(os.tmpdir(), 'ao-headless-acp-browser-team-'));
  try {
    browser = await openLayoutBrowser({ apiVersion: 3, theme: 'light', apiProxy: async origin => {
      h = await officeSceneFixture({ publicUrl: origin, occupantCount: names.length, namedAgents: true, idleRunStatus: 'succeeded',
        primaryName: names[0], runtimeDisplayName: titleCanary, runtimeSummary: titleCanary, enforceAuthorization: true,
        orchestratorTeams: options => syntheticTeamSource({ ...options, teamRoot }) });
      return h.base;
    } });
    const page = browser.page;
    const memberCookie = h.cookie.indexOf('=');
    await page.context().addCookies([{ name: h.cookie.slice(0, memberCookie), value: h.cookie.slice(memberCookie + 1), url: browser.origin,
      httpOnly: true, sameSite: 'Lax' }]);
    await page.clock.setFixedTime(new Date(h.clock.value));

    for (const version of [2, 3]) {
      const officeResponse = await h.get(`/api/v${version}/views/office`);
      assert.equal(officeResponse.status, 200, officeResponse.text);
      assert.equal(JSON.stringify(officeResponse.json.data).includes(titleCanary), false,
        `v${version} OfficeVM never exposes a transcript-derived runtime title`);
      const officeStream = openSse(h.base, `/api/v${version}/stream?topics=office`, { cookie: h.cookie });
      try {
        const frame = await officeStream.next(event => event.event === 'snapshot' && event.data?.topic === 'office');
        assert.equal(JSON.stringify(frame.data).includes(titleCanary), false,
          `v${version} Office SSE never exposes a transcript-derived runtime title`);
      } finally { officeStream.close(); }
    }
    const response = await h.get('/api/v3/views/office');
    assert.equal(response.status, 200, response.text);
    const office = response.json.data;
    assert.equal(office.occupants.length, names.length, 'the primary plus six exact-linked ACP members produce one occupant each');
    const leadOccupant = office.occupants.find(occupant => occupant.name === names[0]);
    assert.ok(leadOccupant?.teamId, 'the team lead carries a backend-provided team id');
    for (let index = 0; index < names.length; index++) {
      const row = office.occupants.find(occupant => occupant.name === names[index]);
      assert.ok(row, `OfficeVM includes ${names[index]} by stable member ID`);
      assert.equal(row.name, names[index]);
      assert.equal(row.teamId, leadOccupant.teamId);
      assert.equal(row.parentId, index === 0 ? null : leadOccupant.id,
        'backend VM supplies the team lead parent');
      assert.equal(row.memberId, memberIds[index], 'OfficeVM supplies the stable identity used by the member portrait');
      assert.notEqual(row.state, 'unknown', 'runtime session evidence supplies a known current state');
    }
    const serialized = JSON.stringify(response.json);
    for (const secret of refs) assert.equal(serialized.includes(secret), false, 'native ACP session refs stay out of the OfficeVM');
    assert.equal(office.occupants.filter(occupant => occupant.name === 'Subagent').length, 0);

    let projectCard;
    for (const version of [2, 3]) {
      const projectsResponse = await h.get(`/api/v${version}/views/projects`);
      assert.equal(projectsResponse.status, 200, projectsResponse.text);
      assert.equal(JSON.stringify(projectsResponse.json.data).includes(titleCanary), false,
        `v${version} project board never exposes a transcript-derived runtime title`);
      projectCard = projectsResponse.json.data.columns.flatMap(column => column.cards)
        .find(card => card.origin === 'orchestrator-team');
      assert.ok(projectCard, `v${version} includes the headless team project without enabling Herdr`);
      const projectDetail = await h.get(`/api/v${version}/views/projects/${encodeURIComponent(projectCard.id)}`);
      assert.equal(projectDetail.status, 200, projectDetail.text);
      assert.equal(JSON.stringify(projectDetail.json.data).includes(titleCanary), false,
        `v${version} ProjectVM never exposes a transcript-derived runtime title`);
      assert.equal(projectDetail.json.data.teamProject.roster.memberCount, names.length);
      assert.deepEqual(projectDetail.json.data.teamProject.roster.members.map(member => member.identity.name), names);
      const projectStream = openSse(h.base,
        `/api/v${version}/stream?topics=${encodeURIComponent(`project:${projectCard.id}`)}`, { cookie: h.cookie });
      try {
        const frame = await projectStream.next(event => event.event === 'snapshot' && event.data?.topic === `project:${projectCard.id}`);
        assert.equal(JSON.stringify(frame.data).includes(titleCanary), false,
          `v${version} Project SSE never exposes a transcript-derived runtime title`);
      } finally { projectStream.close(); }
    }
    const teamResponse = await h.get('/api/v3/teams');
    assert.equal(teamResponse.status, 200, teamResponse.text);
    const projectedMembers = teamResponse.json.data.members;
    assert.deepEqual(projectedMembers.map(member => member.runtimeLabel.key), Array(4).fill('team.runtime.claudeCode').concat(Array(3).fill('team.runtime.codex')));
    assert.deepEqual(projectedMembers.map(member => member.runtimeQualifierLabel?.key || null), [
      'team.runtime.transport.acp', 'team.runtime.transport.nativeTask', 'team.runtime.transport.nativeTask', 'team.runtime.transport.nativeTask',
      'team.runtime.transport.acp', 'team.runtime.transport.acp', 'team.runtime.transport.acp',
    ]);

    await page.setViewportSize({ width: 1440, height: 960 });
    assert.ok(leadOccupant.floorId, 'the backend supplies a floor for the headless team');
    await page.goto(`${browser.origin}/bureau?etage=${encodeURIComponent(leadOccupant.floorId)}`, { waitUntil: 'domcontentloaded' });
    await page.locator('.ao-bureau__stage').waitFor({ state: 'visible' });
    await page.locator('[data-testid="team-office"]').waitFor({ state: 'visible' });
    await page.waitForFunction(() => {
      const link = document.querySelector('link[href*="project-member-row.css"]');
      return !!link?.sheet;
    });
    for (const name of names) await page.locator('.ao-team-list [data-testid="team-member"]').filter({ hasText: name }).first().waitFor({ state: 'visible' });
    assert.equal(await page.getByTestId('team-office').getByText(/Présences Herdr · 0/).count(), 0,
      'the Herdr section is omitted when this ACP team has no Herdr presences');
    const rosterStatuses = new Map();
    for (const id of memberIds) {
      const occupant = office.occupants.find(row => row.memberId === id);
      assert.ok(occupant, `OfficeVM includes roster member ${id}`);
      const rosterStatus = page.locator(`[data-occupant="${occupant.id}"] .ao-roster__state`).first();
      await rosterStatus.waitFor({ state: 'attached' });
      rosterStatuses.set(id, await rosterStatus.innerText());
    }
    const desktopTeam = await page.locator('[data-testid="team-office"]').innerText();
    assert.doesNotMatch(desktopTeam, /Claude Acp|Claude Native Task|Codex Acp|\?/);
    for (const index of names.keys()) {
      const label = index === 0 || index >= 4 ? 'ACP' : 'Tâche native';
      const row = page.locator(`.ao-team-list [data-member-id="${memberIds[index]}"]`).first();
      assert.ok((await row.innerText()).includes(index < 4 ? 'Claude Code' : 'Codex'));
      assert.ok((await row.innerText()).includes(label));
      assert.equal(await row.locator('.ao-project-member__runtime .ao-brand-mark__image').count(), index < 4 ? 1 : 2,
        'adapter-declared connector logo variants are present');
      assert.notEqual(await row.locator('.ao-project-member__runtime .ao-brand-mark__fallback').innerText(), '?', 'provider logo fallback is never an unknown-runtime question mark');
      assert.equal(await row.locator('.ao-project-member__portrait .ao-character-avatar').count(), 1, 'member reuses its canonical Office portrait');
      const rowBounds = await row.boundingBox();
      const titleBounds = await row.locator('.ao-project-member__copy > strong').boundingBox();
      const statusBounds = await row.locator('.ao-project-member__status').boundingBox();
      const detailBounds = await row.locator('.ao-project-member__detail').boundingBox();
      assert.ok(Math.abs((statusBounds.y + statusBounds.height / 2) - (rowBounds.y + rowBounds.height / 2)) < 8,
        'desktop status is flush-right and centered on the single-line member row');
      assert.ok(Math.abs((detailBounds.y + detailBounds.height / 2) - (titleBounds.y + titleBounds.height / 2)) < 8,
        'desktop name, role and reports-to stay on one line in the shared People row');
    }
    await page.waitForFunction(() => [...document.querySelectorAll('.ao-project-member--compact .ao-character-avatar')].length === 7
      && [...document.querySelectorAll('.ao-project-member--compact .ao-character-avatar')].every(node => node.dataset.avatarReady === 'true'), null, { timeout: 30000 });
    await page.evaluate(async () => {
      await Promise.all([...document.querySelectorAll('.ao-project-member--compact .ao-project-member__runtime img[src]')].map(image => image.decode().catch(() => {})));
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    });
    await page.waitForFunction(({ floor, count }) => {
      const scene = document.querySelector('.ao-bureau__stage')?.aoScene;
      return scene?._floorId === floor && scene.chars.size === count && [...scene.chars.values()].every(character =>
        !character.leaving && !character.walking && character.displayed?.classList.contains('is-in'));
    }, { floor: leadOccupant.floorId, count: names.length }, { timeout: 30000 });
    await page.evaluate(async () => {
      await document.fonts.ready;
      await Promise.all([...document.querySelectorAll('.ao-bureau__stage img[src]')].map(image => image.decode().catch(() => {})));
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    });
    await mkdir('design/reports/t0248-acp', { recursive: true });
    await page.screenshot({ path: 'design/reports/t0248-acp/office-desktop-1440.png', fullPage: true, animations: 'disabled' });

    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const membersButton = page.getByTestId('team-open-members');
    await membersButton.waitFor({ state: 'visible' });
    assert.ok(await membersButton.evaluate(node => node.getBoundingClientRect().width <= 390));
    await membersButton.click();
    const mobileMembers = page.locator('.bu-modal [data-testid="team-member"]');
    assert.equal(await mobileMembers.count(), names.length, 'mobile member sheet renders all registered names');
    for (let index = 0; index < names.length; index++) {
      const row = page.locator(`.bu-modal [data-member-id="${memberIds[index]}"]`);
      assert.equal(await row.count(), 1, `mobile sheet includes one row for ${names[index]}`);
      assert.ok((await row.innerText()).includes(names[index]));
      const occupant = office.occupants.find(candidate => candidate.memberId === memberIds[index]);
      assert.equal(await row.getAttribute('data-member-status'), occupant.state,
        'sheet state comes from the same Office occupant state as the roster');
      assert.equal((await row.locator('.ao-project-member__status').innerText()).trim(), rosterStatuses.get(memberIds[index]),
        'the sheet and roster show the same live status text');
    }
    assert.doesNotMatch(await page.locator('.bu-modal').innerText(), /Session inconnue/i,
      'exact ACP session refs are not presented as unknown merely because there is no Herdr pane');
    const modal = page.locator('.ao-team-members-sheet');
    const modalBounds = await modal.boundingBox();
    const closeBounds = await modal.locator('.bu-modal__header > button').boundingBox();
    assert.ok(closeBounds.x + closeBounds.width >= modalBounds.x + modalBounds.width - 64,
      'member sheet close control stays at the top-right edge');
    assert.ok(closeBounds.y < modalBounds.y + 100, 'member sheet close control stays in the top header');
    const mobileText = await modal.innerText();
    assert.equal(mobileText.includes(titleCanary), false, 'the member sheet never exposes a transcript-derived runtime title');
    assert.doesNotMatch(mobileText, /Claude Acp|Claude Native Task|Codex Acp|\?/);
    assert.doesNotMatch(mobileText, /Présences Herdr · 0/);
    for (const index of names.keys()) {
      const row = modal.locator(`[data-member-id="${memberIds[index]}"]`);
      assert.ok((await row.innerText()).includes(index === 0 ? 'lead' : 'engineer'));
      assert.equal(await row.locator('.ao-project-member__portrait .ao-character-avatar').count(), 1);
      const title = await row.locator('.ao-project-member__copy > strong').boundingBox();
      const detail = await row.locator('.ao-project-member__detail').boundingBox();
      const status = await row.locator('.ao-project-member__status').boundingBox();
      const runtime = await row.locator('.ao-project-member__runtime').boundingBox();
      const rowBounds = await row.boundingBox();
      assert.ok(detail.y >= title.y + 8,
        `phone role → reports-to is the only second text line: ${JSON.stringify({ title, detail })}`);
      assert.ok(Math.abs((status.y + status.height / 2) - (rowBounds.y + rowBounds.height / 2)) < 3,
        `phone status stays centered in the shared two-line member row: ${JSON.stringify({ rowBounds, title, detail, status, runtime })}`);
      assert.ok(Math.abs((status.x + status.width) - (rowBounds.x + rowBounds.width - 4)) < 3,
        `phone status stays flush right in the shared member row: ${JSON.stringify({ rowBounds, status })}`);
      assert.ok(Math.abs((runtime.y + runtime.height / 2) - (title.y + title.height / 2)) < 8,
        'phone runtime mark stays aligned with the name line');
    }
    await page.waitForFunction(() => [...document.querySelectorAll('.ao-team-members-sheet .ao-character-avatar')].length === 7
      && [...document.querySelectorAll('.ao-team-members-sheet .ao-character-avatar')].every(node => node.dataset.avatarReady === 'true'), null, { timeout: 30000 });
    await page.evaluate(async () => {
      await Promise.all([...document.querySelectorAll('.ao-team-members-sheet .ao-project-member__runtime img[src]')].map(image => image.decode().catch(() => {})));
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    });
    await page.screenshot({ path: 'design/reports/t0248-acp/office-mobile-390.png', fullPage: false, animations: 'disabled' });
    await page.setViewportSize({ width: 1440, height: 960 });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const desktopModal = await modal.boundingBox();
    assert.ok(desktopModal.x >= 0 && desktopModal.x + desktopModal.width <= 1440,
      'the desktop member sheet fits within the viewport');
    const desktopClose = await modal.locator('.bu-modal__header > button').boundingBox();
    assert.ok(desktopClose.x + desktopClose.width >= desktopModal.x + desktopModal.width - 64,
      'the desktop sheet close control stays at the top-right edge');
    for (const id of memberIds) {
      const row = modal.locator(`[data-member-id="${id}"]`);
      const name = row.locator('.ao-project-member__copy > strong');
      assert.ok(await name.evaluate(node => node.scrollWidth <= node.clientWidth + 1),
        `desktop member name is not clipped: ${await name.innerText()}`);
    }
    await page.screenshot({ path: 'design/reports/t0248-acp/office-members-desktop-1440.png', fullPage: false, animations: 'disabled' });
    await modal.locator('.bu-modal__header > button').click();
    await modal.waitFor({ state: 'hidden' });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await page.evaluate(() => window.scrollTo(0, 0));
    await membersButton.click();
    await modal.waitFor({ state: 'visible' });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await modal.isVisible(), true, 'the bottom capture is taken with the member sheet reopened at phone width');
    assert.equal(await modal.locator('[data-testid="team-member"]').count(), names.length,
      'the open bottom-capture sheet still contains every member');
    const body = page.locator('.bu-modal__body');
    const lastRow = mobileMembers.last();
    await body.evaluate(node => { node.scrollTop = node.scrollHeight; });
    await lastRow.scrollIntoViewIfNeeded();
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const lastRowBounds = await lastRow.evaluate(row => {
      const rect = row.getBoundingClientRect(), body = row.closest('.bu-modal__body'), bounds = body.getBoundingClientRect();
      const modal = row.closest('.ao-team-members-sheet'), modalBounds = modal.getBoundingClientRect();
      const style = getComputedStyle(body), paddingBottom = parseFloat(style.paddingBottom) || 0;
      return { top: rect.top, bottom: rect.bottom, bodyTop: bounds.top, bodyBottom: bounds.bottom,
        bottomPadding: paddingBottom, bodyScrollHeight: body.scrollHeight, bodyClientHeight: body.clientHeight,
        scrollTop: body.scrollTop, modalTop: modalBounds.top, modalBottom: modalBounds.bottom,
        viewportTop: 0, viewportBottom: innerHeight };
    });
    assert.ok(lastRowBounds.top >= Math.max(lastRowBounds.bodyTop, lastRowBounds.viewportTop)
      && lastRowBounds.bottom <= Math.min(lastRowBounds.bodyBottom - lastRowBounds.bottomPadding, lastRowBounds.viewportBottom) + 1,
    `the final row itself is visible inside the body padding and viewport: ${JSON.stringify(lastRowBounds)}`);
    assert.ok(lastRowBounds.modalTop >= lastRowBounds.viewportTop && lastRowBounds.modalBottom <= lastRowBounds.viewportBottom + 2,
      `the complete member sheet is visible in the mobile viewport: ${JSON.stringify(lastRowBounds)}`);
    assert.ok(lastRowBounds.bodyClientHeight > 0 && lastRowBounds.bodyScrollHeight >= lastRowBounds.bodyClientHeight,
      `the member sheet body is laid out and reachable: ${JSON.stringify(lastRowBounds)}`);
    await page.screenshot({ path: 'design/reports/t0248-acp/office-mobile-390-bottom.png', fullPage: false, animations: 'disabled' });
  } finally {
    await browser?.close();
    await h?.close();
    await rm(teamRoot, { recursive: true, force: true });
  }
});
