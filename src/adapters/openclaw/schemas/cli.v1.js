'use strict';
// v1 raw schemas for `openclaw … --json` output (tested with 2026.9.8). The text before the first '{' is ignored.
const s = require('../../../schema');

const TESTED = ['2026.9.8'];
const str = () => s.string().optional();
const bool = () => s.boolean().optional();
const Req = s.object({ bins: s.array(s.string()), anyBins: s.array(s.string()), env: s.array(s.string()), config: s.array(s.string()), os: s.array(s.string()) });

const schemas = {
  'cli.skills.list': s.object({
    skills: s.array(s.object({
      name: s.string().min(1), description: str(), emoji: str(), source: str(), bundled: bool(),
      eligible: bool(), disabled: bool(), modelVisible: bool(), commandVisible: bool(), userInvocable: bool(),
      homepage: str(), missing: Req.optional(),
    }, { known: ['blockedByAllowlist', 'blockedByAgentFilter', 'primaryEnv'] }), { perItem: true }),
  }, { known: ['workspaceDir', 'managedSkillsDir'] }),

  'cli.skills.info': s.object({
    name: s.string().min(1), description: str(), source: str(), bundled: bool(), filePath: str().nullable(), baseDir: str().nullable(), skillKey: str(),
    always: bool(), disabled: bool(), eligible: bool(), blockedByAllowlist: bool(), blockedByAgentFilter: bool(), platformIncompatible: bool(),
    modelVisible: bool(), userInvocable: bool(), commandVisible: bool(), emoji: str(), homepage: str(),
    missing: Req.optional(), requirements: Req.optional(),
    install: s.array(s.object({ id: s.string(), kind: s.string(), label: str(), bins: s.array(s.string()).optional() })).optional(),
  }, { known: ['configChecks'] }),
};

module.exports = Object.fromEntries(Object.entries(schemas).map(([channel, schema]) => [channel, { id: channel, version: 1, testedWith: TESTED, schema }]));
