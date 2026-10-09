'use strict';
const fs = require('fs'), path = require('path');
const TOKEN = 'synthetic-onboarding-gateway-token';
function seed(tmp, { configuredAgent = false, gateway = null } = {}) {
  const state = path.join(tmp, '.openclaw'); fs.mkdirSync(state, { recursive: true });
  const agents = [{ id: 'atlas', workspace: path.join(tmp, 'workspaces', 'atlas'), default: true }, { id: 'scribe', workspace: path.join(tmp, 'workspaces', 'scribe') }];
  if (configuredAgent) agents.push({ id: 'nova', name: 'Vega', workspace: path.join(tmp, 'workspaces', 'nova') });
  for (const a of agents) { fs.mkdirSync(a.workspace, { recursive: true }); fs.writeFileSync(path.join(a.workspace, 'AGENTS.md'), '# Synthetic agents\n\nKeep this text.\n'); }
  fs.writeFileSync(path.join(agents[0].workspace, 'IDENTITY.md'), '- **Name:** Orion\n');
  fs.writeFileSync(path.join(state, 'openclaw.json'), JSON.stringify({ gateway: { port: gateway ? Number(new URL(gateway.url).port) : 19991, auth: { token: TOKEN } }, agents: { list: agents } }));
  fs.mkdirSync(path.join(tmp, '.claude')); fs.mkdirSync(path.join(tmp, '.codex'));
  return agents;
}
module.exports = { seed, TOKEN };
