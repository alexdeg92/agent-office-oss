'use strict';
// Adapter-private projection: no config secrets, commands or paths leave this module.
const s = require('../../schema');
const { readOpenclawConfig } = require('./config-source');
const text = () => s.string().min(1).max(256).optional();
const model = s.union([s.string(), s.object({ primary: text() }, { extra: 'strip' })]).optional();
const runtime = s.object({ type: text(), acp: s.object({ agent: text(), backend: text() }, { extra: 'strip' }).optional() }, { extra: 'strip' }).optional();
const schema = s.object({ agents: s.object({
  defaults: s.object({ model, agentRuntime: s.object({ id: text() }, { extra: 'strip' }).optional() }, { extra: 'strip' }).optional(),
  list: s.array(s.object({ id: s.string().min(1), name: text(), role: text(), description: text(), model, runtime,
    agentRuntime: s.object({ id: text() }, { extra: 'strip' }).optional() }, { extra: 'strip' })).optional(),
}, { extra: 'strip' }).optional() }, { extra: 'strip' });

function projectAgentSettings(value) {
  const result = s.validate(schema, value);
  return result.ok ? result.value.agents || {} : null;
}
function readAgentSettings(file) {
  const body = readOpenclawConfig(file);
  return body.kind === 'json' ? projectAgentSettings(body.value) : null;
}
module.exports = { projectAgentSettings, readAgentSettings };
