'use strict';
// channels.status (+ config policies) → Channel[] (data-model.md §7).
// S6.1 (PM): the canonical id of the WeChat channel is 'wechat' (raw 'openclaw-weixin' in channels.status, 'wechat' in keys).
// G3b (ADR-001 §12.3): the family is OPEN. OpenClaw's own spellings are aliased; any other valid slug is its own ChannelRef.
const { CHANNEL_REF } = require('../../../engine/model/kinds');
const ALIASES = { 'openclaw-weixin': 'wechat', weixin: 'wechat' };
// Known channels have fixed display labels (the gateway's label varies: 'Weixin', or the raw id); others keep the source label.
const LABEL = { discord: 'Discord', whatsapp: 'WhatsApp', wechat: 'WeChat' };
// Raw channel name → ChannelRef (own-property lookup, R2-03), or 'unrecognized' only for a raw value that is not a slug.
// Shared with cron delivery (R6-09) and the session classifier.
const channelRefOf = (raw) => (Object.prototype.hasOwnProperty.call(ALIASES, raw) ? ALIASES[raw] : CHANNEL_REF.test(String(raw)) ? String(raw) : null);
const channelIdOf = (raw) => channelRefOf(raw) || 'unrecognized';
const LIFECYCLE = new Set(['ready', 'stopped', 'running', 'starting', 'stopping']);

function normaliseChannels(v, issue, config) {
  const order = v.channelOrder || Object.keys(v.channels || {});
  const accountsRaw = v.channelAccounts && typeof v.channelAccounts === 'object' ? v.channelAccounts : {};
  return order.filter((raw) => v.channels && v.channels[raw]).map((raw) => {
    const c = v.channels[raw];
    const id = channelIdOf(raw);
    if (id === 'unrecognized') issue('enum.unmapped', 'warn', '$.channels', 'value not in the table', { length: String(raw).length });
    const accounts = (Array.isArray(accountsRaw[raw]) ? accountsRaw[raw] : []).map((a) => {
      let lifecycle = a.lifecycle || null;
      if (lifecycle && !LIFECYCLE.has(lifecycle)) { issue('enum.unmapped', 'info', '$.channelAccounts.*[].lifecycle', 'value not in the table', { length: String(lifecycle).length }); lifecycle = 'unrecognized'; }
      return { accountId: String(a.accountId || 'default'), enabled: a.enabled !== false, lifecycle, busy: !!a.busy,
        activeRuns: Number.isInteger(a.activeRuns) ? a.activeRuns : 0, lastInboundAt: a.lastInboundAt || null, lastOutboundAt: a.lastOutboundAt || null,
        bot: a.bot && a.bot.id ? { id: String(a.bot.id), username: a.bot.username || '' } : null };
    });
    const health = !c.configured ? 'not-configured' : c.lastError ? 'error' : c.connected ? 'connected' : c.running ? 'running' : 'stopped';
    const d = config && config.discord;
    return {
      id, rawId: raw, label: LABEL[id] || (v.channelLabels && v.channelLabels[raw]) || raw,
      configured: !!c.configured, health, lastError: c.lastError || null, lastStartAt: c.lastStartAt || null,
      lastInboundAt: c.lastInboundAt || accounts.reduce((m, a) => Math.max(m, a.lastInboundAt || 0), 0) || null,
      accounts,
      policy: id === 'discord' && d ? { dm: d.dmPolicy, group: d.groupPolicy } : { dm: null, group: null },
    };
  });
}

module.exports = { normaliseChannels, channelIdOf, channelRefOf, ALIASES };
