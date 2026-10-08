'use strict';
// v1 schemas for the core's own sources (not a runtime's): host metrics of the machine Agent Office runs on.
const s = require('../../schema');

const schemas = {
  'host.metrics': s.object({
    cpuPct: s.number(), load1: s.number(), ncpu: s.int().min(1), memUsed: s.number(), memTotal: s.number(),
    disk: s.object({ total: s.number(), used: s.number() }).nullable(), uptimeSec: s.number(), host: s.string(),
  }, { extra: 'reject' }),
};

// testedWith: the core's own schemas don't depend on a runtime version
module.exports = Object.fromEntries(Object.entries(schemas).map(([channel, schema]) => [channel, { id: channel, version: 1, testedWith: null, schema }]));
