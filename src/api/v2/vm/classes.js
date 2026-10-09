'use strict';
// One class per page section (PM audit (B)): each VM schema (vm/schemas.js) as a frozen, constructor-validated class.
// The runtime check (vm/check.js) sends instances of these.
const { defineEntity } = require('../../../model/entity');
const { VM_SCHEMAS, VM_SCHEMAS_V3 } = require('./schemas');

const NAMES = { setup: 'SetupVM', meta: 'MetaVM', me: 'MeVM', office: 'OfficeVM', chat: 'ChatVM', flows: 'FlowListVM', flow: 'FlowDetailVM', access: 'AccessVM',
  interlocutor: 'InterlocutorVM', logs: 'LogsPageVM', session: 'SessionVM', skills: 'SkillListVM', skill: 'SkillDetailVM', health: 'HealthVM',
  projects: 'BoardVM', project: 'ProjectVM', history: 'HistoryPageVM', candidates: 'CandidatesVM', layout: 'LayoutVM', prefs: 'UiPrefs', comments: 'CommentThreadVM' };

const VM_CLASSES = {};
for (const [key, schema] of Object.entries(VM_SCHEMAS)) VM_CLASSES[key] = defineEntity(NAMES[key], schema, { fillOptional: false });
// G5: contract 3.0's classes (the same class where the VM didn't change)
const VM_CLASSES_V3 = {};
for (const [key, schema] of Object.entries(VM_SCHEMAS_V3)) VM_CLASSES_V3[key] = schema === VM_SCHEMAS[key] ? VM_CLASSES[key] : defineEntity(NAMES[key] + 'V3', schema, { fillOptional: false });
const classesFor = (version) => (version === 3 ? VM_CLASSES_V3 : VM_CLASSES);

module.exports = Object.assign({ VM_CLASSES, VM_CLASSES_V3, classesFor }, Object.fromEntries(Object.entries(VM_CLASSES).map(([k, C]) => [NAMES[k], C])));
