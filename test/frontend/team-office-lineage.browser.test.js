import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { openLayoutBrowser, browserSkipReason } from './helpers/layout-browser.js';

const skip = browserSkipReason();
const evidenceDir = 'design/reports/orchestrators-teams-1';
const at = Date.UTC(2026, 9, 11, 12);
const teamData = { team: { id: 'team_fixture', label: 'Équipe de test · agents mixtes', status: 'active' }, members: [
  { id: 'member:pm-fixture', name: 'Camille', roleKind: 'lead', roleLabel: 'pm', status: 'active', statusLabel: { key: 'team.member.status.active' }, runtimeKind: 'claude-code', runtimeLabel: { key: 'team.runtime.claudeCode' }, runtimeQualifierLabel: null, brand: { mark: 'CC', color: '#6655aa', providerName: 'Claude Code', logo: 'assets/connectors/claude-code.svg' }, hostAgentId: 'host:pm-fixture', parentMemberId: null },
  { id: 'member:builder-fixture', name: 'Builder', roleKind: 'member', roleLabel: 'builder', status: 'active', statusLabel: { key: 'team.member.sessionUnknown' }, runtimeKind: 'codex', runtimeLabel: { key: 'team.runtime.codex' }, runtimeQualifierLabel: null, brand: { mark: 'CX', color: '#187b67', providerName: 'Codex', logo: 'assets/connectors/codex.svg' }, hostAgentId: 'host:builder-fixture', parentMemberId: 'member:pm-fixture', sessionStatus: 'unknown' },
  { id: 'member:critic-fixture', name: 'Critic', roleKind: 'member', roleLabel: 'reviewer', status: 'active', statusLabel: { key: 'team.member.status.active' }, runtimeKind: 'cursor', runtimeLabel: { key: 'team.runtime.other' }, runtimeQualifierLabel: null, hostAgentId: 'host:critic-fixture', parentMemberId: 'member:pm-fixture' },
  { id: 'member:unregistered-fixture', name: 'Unregistered participant', roleKind: 'unknown', roleLabel: null, status: 'active', statusLabel: { key: 'team.member.status.active' }, runtimeKind: null, runtimeLabel: { key: 'team.runtime.unknown' }, runtimeQualifierLabel: null, hostAgentId: null, parentMemberId: null },
], tasks: [{ id: 'task:fixture', title: 'Build the mixed-runtime team view with a deliberately long title that must be clamped to two lines and remain readable in its expanded details', state: 'working', priority: 1, ownerMemberId: 'member:builder-fixture',
    reviewerMemberIds: ['member:critic-fixture'], createdAt: at, updatedAt: at, reportPresent: false, briefPresent: true, messageCount: 0, reviews: [] }], diagnostics: { skippedTaskCount: 1, skippedMemberCount: 0,
    skippedCount: 4, partialLabel: { key: 'team.board.partial', params: { count: 4 } }, quality: 'partial' }, revision: 1 };
const orchestratorData = { hosts: [{ id: 'host:fixture', label: 'Synthetic host', platform: 'container', status: 'available', observedAt: at }],
  orchestrators: [{ id: 'herdr:fixture', hostId: 'host:fixture', kind: 'herdr', label: 'herdr', sourceStatus: 'available', observedAt: at }], agents: [
    { id: 'host:pm-fixture', hostId: 'host:fixture', orchestratorId: 'herdr:fixture', name: 'Camille', runtimeKind: 'claude-code', role: 'primary', status: 'working', observedAt: at, staleAfter: at + 60000, linkedOccupantId: 'primary' },
    { id: 'host:builder-fixture', hostId: 'host:fixture', orchestratorId: 'herdr:fixture', name: 'Builder', runtimeKind: 'codex', role: 'delegate', status: 'working', observedAt: at, staleAfter: at + 60000, linkedOccupantId: 'agent:builder' },
    { id: 'host:critic-fixture', hostId: 'host:fixture', orchestratorId: 'herdr:fixture', name: 'Critic', runtimeKind: 'cursor', role: 'delegate', status: 'working', observedAt: at, staleAfter: at + 60000, linkedOccupantId: 'agent:critic' },
  ], revision: 1, hostRevision: 1, teamRevision: 1, observedAt: at };
const envelope = (data, topic) => ({ data, meta: { modelVersion: '3.3', contractVersion: '3.3', generatedAt: at, topic: { id: topic, rev: 1 } } });

test('Bureau shell renders the mixed-runtime team hierarchy with exact stable parent IDs', { skip, timeout: 90000 }, async () => {
  const browser = await openLayoutBrowser({ apiVersion: 3 });
  const page = browser.page;
  try {
    await page.route('**/backend/api/v3/teams', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(envelope(teamData, 'teams:fixture')) }));
    await page.route('**/backend/api/v3/orchestrators', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(envelope(orchestratorData, 'orchestrators:fixture')) }));
    for (const theme of ['light', 'dark']) {
      await page.setViewportSize({ width: 1440, height: 1000 });
      await page.goto(`${browser.origin}/bureau?mock=1&agent=Atlas`, { waitUntil: 'domcontentloaded' });
      await page.evaluate(async value => { document.documentElement.dataset.theme = value; await document.fonts.ready; }, theme);
      await page.getByTestId('team-office').waitFor({ state: 'visible' });
      const parent = page.locator('[data-testid="team-member"][data-member-id="member:pm-fixture"]');
      const builder = page.locator('[data-testid="team-member"][data-member-id="member:builder-fixture"]');
      const critic = page.locator('[data-testid="team-member"][data-member-id="member:critic-fixture"]');
      assert.equal(await parent.getAttribute('data-parent-member-id'), null);
      assert.equal(await builder.getAttribute('data-parent-member-id'), 'member:pm-fixture');
      assert.equal(await critic.getAttribute('data-parent-member-id'), 'member:pm-fixture');
      assert.ok((await builder.getAttribute('class')).includes('ao-team-member-child'));
      assert.ok((await critic.getAttribute('class')).includes('ao-team-member-child'));
      assert.match(await builder.innerText(), /Session inconnue/i);
      for (const [memberId, label] of [['member:pm-fixture', 'Claude Code'], ['member:builder-fixture', 'Codex'], ['member:critic-fixture', 'Runtime']]) {
        const badge = page.locator(`[data-testid="team-member"][data-member-id="${memberId}"] .ao-project-member__runtime`);
        assert.equal(await badge.count(), 1, memberId);
        assert.equal(await badge.getAttribute('aria-label'), label, memberId + ' uses its adapter-declared provider label');
        assert.ok((await badge.innerText()).trim().endsWith(label), memberId + ' visible provider label');
      }
      const logoMarks = page.locator('[data-testid="team-member"] .ao-brand-mark--with-logo');
      assert.equal(await logoMarks.count(), 2, 'adapter-declared connector marks use the shared logo helper');
      const taskTitle = teamData.tasks[0].title;
      assert.equal(await page.locator('.ao-team-partial').count(), 1);
      assert.equal(await page.locator('.ao-team-partial').getAttribute('data-team-quality'), 'partial');
      assert.match(await page.locator('.ao-team-partial').innerText(), /4 (?:entrée\(s\) d’équipe|team record)/i, 'the board renders the server aggregate LabelRef');
      const taskHeading = page.locator('.ao-team-task .bu-list-row__title');
      assert.equal(await taskHeading.evaluate(node => getComputedStyle(node).webkitLineClamp), '2', 'board titles clamp to two lines');
      await page.locator('[data-testid="team-task"] summary').click();
      assert.equal(await page.locator('.ao-team-task__full-title').innerText(), taskTitle, 'expanded task shows the complete title');
      const unknownRuntime = page.locator('[data-testid="team-member"][data-member-id="member:unregistered-fixture"] .ao-project-member__runtime');
      assert.equal(await unknownRuntime.getAttribute('aria-label'), 'Runtime inconnu');
      if (process.env.TEAM_OFFICE_SCREENSHOTS === '1') {
        await mkdir(evidenceDir, { recursive: true });
        await page.screenshot({ path: `${evidenceDir}/office-desktop-${theme}.png`, fullPage: true, animations: 'disabled' });
      }

      await page.setViewportSize({ width: 390, height: 844 });
      await page.evaluate(async value => { document.documentElement.dataset.theme = value; await document.fonts.ready; }, theme);
      const boardButton = page.getByTestId('team-open-board');
      assert.equal(await boardButton.evaluate(node => getComputedStyle(node).whiteSpace), 'nowrap', 'mobile board label and task count stay together');
      await page.getByTestId('team-open-members').click();
      const mobileParent = page.locator('[data-testid="team-member"][data-member-id="member:pm-fixture"]').last();
      const mobileBuilder = page.locator('[data-testid="team-member"][data-member-id="member:builder-fixture"]').last();
      const mobileCritic = page.locator('[data-testid="team-member"][data-member-id="member:critic-fixture"]').last();
      assert.equal(await mobileBuilder.getAttribute('data-parent-member-id'), 'member:pm-fixture');
      assert.equal(await mobileCritic.getAttribute('data-parent-member-id'), 'member:pm-fixture');
      assert.ok((await mobileBuilder.getAttribute('class')).includes('ao-team-member-child'));
      assert.ok((await mobileCritic.getAttribute('class')).includes('ao-team-member-child'));
      if (process.env.TEAM_OFFICE_SCREENSHOTS === '1') {
        await mkdir(evidenceDir, { recursive: true });
        await page.screenshot({ path: `${evidenceDir}/office-mobile-${theme}.png`, fullPage: false, animations: 'disabled' });
      }
      await page.getByRole('button', { name: 'Fermer' }).click().catch(() => {});
    }
  } finally { await browser.close(); }
});
