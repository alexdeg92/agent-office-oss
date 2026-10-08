'use strict';

const { createMemoryRepository, REPOSITORY_METHODS } = require('./memory');
const plan = require('./plan');
const { evaluateRisks } = require('./risks');
const { buildBoardVM, buildProjectVM, buildCandidatesVM, buildHistoryPage, presentHistory, compareCards, monogramAccent } = require('./vm');
const { createGithubSource } = require('./sources/github');
const { createRepoRefresh } = require('./repo-refresh');
const { createWorkspaceSource } = require('./sources/workspace');
const { createSessionGroupSource, createManualSource } = require('./sources/session-group');
const { ProjectError, projectConflictBody } = require('./errors');
const discovery = require('./discovery');
const { linkProjectActivity } = require('./activity');
const { scanFeatureFlags } = require('./flags');
const { createProjectService } = require('./service');

const commands = {
  createProject: (repo, input) => repo.createProject(input),
  rename: (repo, input) => repo.rename(input),
  setStatus: (repo, input) => repo.setStatus(input),
  reorder: (repo, input) => repo.reorder(input),
  setPriority: (repo, input) => repo.setPriority(input),
  editSummary: (repo, input) => repo.editSummary(input),
  edit: (repo, input) => repo.edit(input),
  addLabel: (repo, input) => repo.addLabel(input),
  addFlag: (repo, input) => repo.addFlag(input),
  removeFlag: (repo, input) => repo.removeFlag(input),
  setBlocked: (repo, input) => repo.setBlocked(input),
  ackRisk: (repo, input) => repo.ackRisk(input),
  linkSource: (repo, input) => repo.linkSource(input),
  unlinkSource: (repo, input) => repo.unlinkSource(input),
  setArchived: (repo, input) => repo.setArchived(input),
  setPersonOverride: (repo, input) => repo.setPersonOverride(input),
  applyRisks: (repo, input) => repo.applyRisks(input),
  applyProjectRisks: (repo, input) => repo.applyProjectRisks(input),
  ingestActivity: (repo, input) => repo.ingestActivity(input),
  replaceFeatureFlags: (repo, input) => repo.replaceFeatureFlags(input),
  appendHistory: (repo, input) => repo.appendHistory(input),
  importCandidates: (repo, input) => repo.importCandidates(input),
};

module.exports = {
  createMemoryRepository,
  REPOSITORY_METHODS,
  commands,
  plan,
  movesActivityClock: plan.movesActivityClock,
  activityAtFromHistory: plan.activityAtFromHistory,
  evaluateRisks,
  buildBoardVM,
  buildProjectVM,
  buildCandidatesVM,
  buildHistoryPage,
  presentHistory,
  projectConflictBody,
  compareCards,
  createGithubSource,
  createRepoRefresh,
  monogramAccent,
  createWorkspaceSource,
  createSessionGroupSource,
  createManualSource,
  ProjectError,
  discovery,
  linkProjectActivity,
  scanFeatureFlags,
  createProjectService,
  providerFor: require('./sources/code-host').providerFor,
  entities: require('./entities'),
};
