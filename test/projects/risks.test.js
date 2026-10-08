'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { evaluateRisks, DAY_MS } = require('../../src/projects/risks');
const { activityAtFromHistory, commands } = require('../../src/projects');
const { STALE_AFTER_DAYS } = require('../../src/projects/constants');
const { AT, repository } = require('./helpers');

const flow = (over = {}) => ({ jobId: 'flow-1', runId: 'run-f', status: 'failed', at: AT, ...over });
const cron = (over = {}) => ({ jobId: 'cron-1', runId: 'run-c', status: 'failed', at: AT, ...over });

describe('risk monitor', () => {
  it('raises flow, cron, ci and stale risks with the default severities', () => {
    const plan = evaluateRisks({
      now: AT,
      lastActivityAt: AT - STALE_AFTER_DAYS * DAY_MS,
      flows: [flow()],
      crons: [cron()],
      ci: { state: 'failing', at: AT, url: 'https://github.com/alexdeg92/demo/actions/runs/1' },
      current: [],
    });
    const byKey = Object.fromEntries(plan.raise.map((r) => [r.key, r]));
    assert.equal(byKey['flow-failing'].severity, 'high');
    assert.equal(byKey['cron-failing'].severity, 'high');
    assert.equal(byKey['ci-red'].severity, 'medium');
    assert.equal(byKey['ci-red'].evidence.kind, 'ci');
    assert.equal(byKey.stale.severity, 'low');
    assert.equal(byKey.stale.staleDays, 14);
    assert.equal(byKey.stale.evidence.kind, 'inactivity');
    assert.equal(plan.raise.some((r) => r.key === 'blocked'), false);
  });

  it('does not raise stale before 14 days, or ci-red while a run is still going', () => {
    const quiet = evaluateRisks({
      now: AT,
      lastActivityAt: AT - (STALE_AFTER_DAYS * DAY_MS - 1),
      flows: [{ ...flow(), status: 'succeeded', health: 'ok' }],
      crons: [],
      ci: { state: 'running', at: AT, url: null },
      current: [],
    });
    assert.deepEqual(quiet, { raise: [], clear: [], refresh: [] });
  });

  it('clears auto risks when the condition is gone and leaves a manual block', () => {
    const current = [
      { kind: 'risk', key: 'flow-failing', origin: 'auto', clearedAt: null, evidence: { kind: 'cron-run', ref: 'run-f', at: AT }, ack: null },
      { kind: 'risk', key: 'blocked', origin: 'manual', clearedAt: null, evidence: null, ack: null },
    ];
    const plan = evaluateRisks({ now: AT + DAY_MS, lastActivityAt: AT + DAY_MS, flows: [], crons: [], ci: { state: 'passing', at: AT, url: null }, current });
    assert.deepEqual(plan.clear, ['flow-failing']);
    assert.equal(plan.raise.length, 0);
  });

  it('unacks when a newer failure arrives and keeps the ack when evidence is unchanged', () => {
    const acked = {
      kind: 'risk', key: 'ci-red', origin: 'auto', clearedAt: null, severity: 'medium',
      evidence: { kind: 'ci', ref: 'https://example.test/1', at: AT },
      ack: { by: { kind: 'human', personId: 'per_alexowner000000' }, at: AT + 10 },
    };
    const same = evaluateRisks({
      now: AT + 50, lastActivityAt: AT + 50,
      ci: { state: 'failing', at: AT, url: 'https://example.test/1' },
      current: [acked],
    });
    assert.deepEqual(same.refresh, []);
    const newer = evaluateRisks({
      now: AT + 50, lastActivityAt: AT + 50,
      ci: { state: 'failing', at: AT + 20, url: 'https://example.test/2' },
      current: [acked],
    });
    assert.equal(newer.refresh[0].unack, true);
    assert.equal(newer.raise.length, 0);
  });

  it('lets a newer success clear that job and keeps another job that is still failing', () => {
    const failed = flow({ at: AT, runId: 'run-old' });
    const succeeded = flow({ at: AT + 1, runId: 'run-new', status: 'succeeded' });
    const none = evaluateRisks({ now: AT + 10, lastActivityAt: AT + 10, flows: [failed, succeeded], current: [] });
    assert.equal(none.raise.some((r) => r.key === 'flow-failing'), false);
    const existing = {
      kind: 'risk', key: 'flow-failing', origin: 'auto', clearedAt: null,
      evidence: { kind: 'cron-run', ref: 'run-old', at: AT }, ack: null,
    };
    const gone = evaluateRisks({
      now: AT + 10, lastActivityAt: AT + 10, flows: [failed, succeeded], current: [existing],
    });
    assert.deepEqual(gone.raise, []);
    assert.deepEqual(gone.clear, ['flow-failing']);
    const other = evaluateRisks({
      now: AT + 10, lastActivityAt: AT + 10,
      flows: [failed, succeeded, flow({ jobId: 'flow-2', runId: 'run-2', at: AT })],
      current: [],
    });
    assert.equal(other.raise.filter((r) => r.key === 'flow-failing').length, 1);
    const crons = evaluateRisks({
      now: AT + 10, lastActivityAt: AT + 10,
      crons: [cron({ at: AT }), cron({ at: AT + 1, runId: 'run-c2', status: 'succeeded' })],
      current: [],
    });
    assert.equal(crons.raise.some((r) => r.key === 'cron-failing'), false);
  });

  it('does not refresh, unack, or replace a manual risk', () => {
    const manual = {
      kind: 'risk', key: 'ci-red', origin: 'manual', clearedAt: null, severity: 'medium',
      evidence: { kind: 'ci', ref: 'https://example.test/1', at: AT },
      ack: { by: { kind: 'human', personId: 'per_alexowner000000' }, at: AT },
    };
    const plan = evaluateRisks({
      now: AT + 50, lastActivityAt: AT + 50,
      ci: { state: 'failing', at: AT + 20, url: 'https://example.test/2' },
      current: [manual],
    });
    assert.deepEqual(plan.refresh, []);
    assert.deepEqual(plan.raise, []);
    assert.deepEqual(plan.clear, []);
    const replaced = evaluateRisks({
      now: AT + 50, lastActivityAt: AT + 50,
      ci: { state: 'failing', at: AT + 20, url: 'https://example.test/2' },
      current: [{ ...manual, clearedAt: AT + 5 }],
    });
    assert.equal(replaced.raise.some((r) => r.key === 'ci-red'), false);
    assert.deepEqual(replaced.refresh, []);
  });

  it('applies a plan through the repository and clears it on the next pass', () => {
    const repo = repository();
    const project = commands.createProject(repo, { name: 'Portail', actor: 'owner', at: AT });
    const raised = commands.applyProjectRisks(repo, {
      id: project.id,
      expectedRevision: 1,
      at: AT + 1000,
      flows: [flow({ at: AT + 1000 })],
      ci: { state: 'failing', at: AT + 1000, url: 'https://github.com/alexdeg92/demo/actions/runs/9' },
      actor: 'system',
    });
    assert.equal(raised.revision, 2);
    assert.equal(raised.lastActivityAt, project.lastActivityAt);
    assert.ok(raised.flags.some((f) => f.key === 'flow-failing' && f.clearedAt == null));
    const ev = repo.getHistory(project.id).events.find((e) => e.kind === 'risk-raised');
    assert.equal(ev.actor.component, 'risk-monitor');
    const cleared = commands.applyProjectRisks(repo, {
      id: project.id,
      expectedRevision: raised.revision,
      at: AT + 2000,
      flows: [flow({ status: 'succeeded', at: AT + 2000 })],
      ci: { state: 'passing', at: AT + 2000, url: 'https://github.com/alexdeg92/demo/actions/runs/10' },
    });
    const flowFlag = cleared.flags.find((f) => f.key === 'flow-failing');
    assert.equal(flowFlag.clearedAt, AT + 2000);
    assert.ok(repo.getHistory(project.id).events.some((e) => e.kind === 'risk-cleared' && e.key === 'flow-failing'));
    assert.equal(cleared.flags.some((f) => f.key === 'ci-red' && f.clearedAt == null), false);
  });

  it('reopens an acked ci risk when a new red run is observed', () => {
    const repo = repository();
    const project = commands.createProject(repo, { name: 'Portail', actor: 'owner', at: AT });
    const raised = commands.applyProjectRisks(repo, {
      id: project.id, expectedRevision: 1, at: AT + 1,
      ci: { state: 'failing', at: AT, url: 'https://github.com/alexdeg92/demo/actions/runs/1' },
    });
    const acked = commands.ackRisk(repo, {
      id: project.id, expectedRevision: raised.revision, key: 'ci-red', ack: true, actor: 'owner', at: AT + 2,
    });
    const reopened = commands.applyProjectRisks(repo, {
      id: project.id, expectedRevision: acked.revision, at: AT + 4,
      ci: { state: 'failing', at: AT + 3, url: 'https://github.com/alexdeg92/demo/actions/runs/2' },
    });
    const flag = reopened.flags.find((f) => f.key === 'ci-red');
    assert.equal(flag.ack, null);
    assert.equal(flag.clearedAt, null);
    assert.ok(repo.getHistory(project.id).events.some((e) => e.kind === 'risk-unacked'));
    assert.equal(reopened.lastActivityAt, project.lastActivityAt);
  });

  it('does not let a stale risk, or its history, reset the activity clock', () => {
    const repo = repository();
    const born = AT - 20 * DAY_MS;
    const project = commands.createProject(repo, { name: 'Portail', actor: 'owner', at: born });
    const raised = commands.applyProjectRisks(repo, { id: project.id, at: AT });
    assert.equal(raised.lastActivityAt, born);
    assert.equal(raised.flags.find((f) => f.key === 'stale').clearedAt, null);
    const still = commands.applyProjectRisks(repo, { id: project.id, at: AT + 1000, lastActivityAt: AT + 1000 });
    assert.equal(still.lastActivityAt, born);
    assert.equal(still.flags.find((f) => f.key === 'stale').clearedAt, null);
    const events = repo.getHistory(project.id).events;
    assert.equal(activityAtFromHistory(events, project.createdAt), born);
    assert.ok(events.some((e) => e.kind === 'risk-raised' && e.at === AT));
    const blocked = commands.setBlocked(repo, { id: project.id, expectedRevision: still.revision, actor: 'owner', at: AT + 2000 });
    assert.equal(blocked.lastActivityAt, born);
    const active = commands.ingestActivity(repo, {
      id: project.id,
      actor: 'system',
      at: AT + 3000,
      sessions: [{ sessionKey: 'agent:main:demo', messages: 2, tokens: 10, at: AT + 3000 }],
    });
    assert.equal(active.lastActivityAt, AT + 3000);
    const cleared = commands.applyProjectRisks(repo, { id: project.id, at: AT + 3000 });
    assert.equal(cleared.flags.find((f) => f.key === 'stale').clearedAt, AT + 3000);
    assert.equal(cleared.lastActivityAt, AT + 3000);
    assert.equal(activityAtFromHistory(repo.getHistory(project.id).events, project.createdAt), AT + 3000);
  });
});
