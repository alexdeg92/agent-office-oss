'use strict';
// openclaw.json projection → OpenclawConfig. The Discord bot token is wrapped in a Secret here.
const { Secret } = require('../../../engine/secret');

function normaliseConfig(v) {
  const d = (v.channels && v.channels.discord) || null;
  const channels = {};
  if (d && d.guilds) for (const g of Object.values(d.guilds)) for (const [id, c] of Object.entries((g && g.channels) || {})) channels[id] = { enabled: !!c.enabled, requireMention: !!c.requireMention };
  return {
    discord: d ? { dmPolicy: d.dmPolicy || null, groupPolicy: d.groupPolicy || null, channels, token: new Secret(d.token || null) } : null,
    execSecurity: (v.tools && v.tools.exec && v.tools.exec.security) || null,
    skillsEnabled: Object.fromEntries(Object.entries((v.skills && v.skills.entries) || {}).map(([k, e]) => [k, e.enabled !== false])),
  };
}
module.exports = { normaliseConfig };
