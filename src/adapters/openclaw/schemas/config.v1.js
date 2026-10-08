'use strict';
// v1 schema for the openclaw.json PROJECTION (OpenClaw adapter). Host metrics are core: src/engine/schemas/core.v1.js.
const s = require('../../../schema');

const TESTED = ['2026.9.8'];
const str = () => s.string().optional();
const bool = () => s.boolean().optional();

// Only the fields Agent Office reads are loaded; everything else in openclaw.json is stripped at the
// door and never reaches the registry (engine.md §3.3). The bot token becomes a Secret in the engine.
const ChannelCfg = s.object({ enabled: bool(), requireMention: bool() }, { extra: 'strip' });
const schemas = {
  'config.openclaw': s.object({
    channels: s.object({
      discord: s.object({
        dmPolicy: str(), groupPolicy: str(), token: str(),
        guilds: s.record(s.object({ channels: s.record(ChannelCfg).optional() }, { extra: 'strip' })).optional(),
      }, { extra: 'strip' }).optional(),
    }, { extra: 'strip' }).optional(),
    tools: s.object({ exec: s.object({ security: str() }, { extra: 'strip' }).optional() }, { extra: 'strip' }).optional(),
    skills: s.object({ entries: s.record(s.object({ enabled: bool() }, { extra: 'strip' })).optional() }, { extra: 'strip' }).optional(),
  }, { extra: 'strip' }),

};

module.exports = Object.fromEntries(Object.entries(schemas).map(([channel, schema]) => [channel, { id: channel, version: 1, testedWith: TESTED, schema }]));
