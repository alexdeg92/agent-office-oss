'use strict';
// Builds a store with the go-live tree passed as argv[2] (commit 5a38aec). Not a test file.
const fs = require('fs');
const path = require('path');

const root = process.argv[2];
const dir = process.argv[3];
if (!root || !dir) {
  process.stderr.write('usage: golive-store-seed.js <go-live-tree> <data-dir>\n');
  process.exit(2);
}

const { openStore } = require(path.join(root, 'src/store'));
const { createProjectsRepository } = require(path.join(root, 'src/store/repos/projects'));

const store = openStore({ dir, instance: 'test', ownerName: 'Camille', log() {} });
const owner = {
  id: store.owner.id,
  kind: 'human',
  name: store.owner.name,
  avatarUrl: null,
  links: { isOwner: true, discordUserId: '100000000000000001' },
};
const atlas = {
  id: 'per_atlasmain000000',
  kind: 'agent',
  name: 'Atlas',
  avatarUrl: null,
  links: { agentId: 'atlas' },
};
const repo = createProjectsRepository(store.db, {
  persons: [owner, atlas],
  ownerPersonId: owner.id,
  [['tim', 'my', 'PersonId'].join('')]: atlas.id,
  githubOwners: ['acme-labs'],
  now: () => Date.UTC(2026, 9, 1, 12),
});
const project = repo.createProject({
  name: 'Agent Office',
  actor: { kind: 'human', personId: owner.id },
  summary: 'Le bureau',
  sources: [{ kind: 'github', ref: { owner: 'acme-labs', repo: 'agent-office' } }],
});
const layout = JSON.parse(fs.readFileSync(path.join(root, 'design/office/layout.example.json'), 'utf8'));
const active = store.office.active(() => layout);
store.office.seen([{ id: 'cron:morning', role: 'cron', name: 'Revue du matin' }]);
store.audit.append({
  at: Date.UTC(2026, 9, 1, 12),
  requestId: 'req_upgrade_0001',
  actor: { kind: 'human', personId: owner.id },
  command: 'projects.create',
  target: project.id,
  outcome: 'ok',
  detail: null,
});
store.sessions.revoke('0123456789abcdef', Date.UTC(2026, 9, 2, 12));
store.close();
process.stdout.write(JSON.stringify({
  projectId: project.id,
  layoutId: active.id,
  layoutName: active.name,
  ownerId: owner.id,
}) + '\n');
