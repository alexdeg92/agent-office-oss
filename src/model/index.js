'use strict';
/*
 * The canonical entity classes (PM audit (B)): one class per canonical type, generated from its schema by
 * defineEntity (frozen, constructor-validated, optional = explicit null, never undefined, stable toJSON).
 * The engine builds these wherever it admits a canonical value; `entityOf(schema)` finds the class of a schema.
 */
const { defineEntity, EntityError } = require('./entity');
const C = require('../engine/model/canonical');
const { Session: SessionSchema, RunState: RunStateSchema, Classification: ClassificationSchema } = require('../engine/model/session');

const Agent = defineEntity('Agent', C.Agent);
const Flow = defineEntity('Flow', C.CronJob);              // a scheduled job (data-model CronJob)
const FlowRun = defineEntity('FlowRun', C.CronRun);
const Skill = defineEntity('Skill', C.Skill);
const SkillInfo = defineEntity('SkillInfo', C.SkillInfo);
const Channel = defineEntity('Channel', C.Channel);
const TraceEvent = defineEntity('TraceEvent', C.TraceEvent);
const Transcript = defineEntity('Transcript', C.Transcript);
const Config = defineEntity('Config', C.Config);
const LiveEvent = defineEntity('LiveEvent', C.LiveEvent);
const SessionGroup = defineEntity('SessionGroup', C.SessionGroup);
const RunState = defineEntity('RunState', RunStateSchema);
const Classification = defineEntity('Classification', ClassificationSchema);
const Session = defineEntity('Session', SessionSchema);

const BY_SCHEMA = new Map([[C.Agent, Agent], [C.CronJob, Flow], [C.CronRun, FlowRun], [C.Skill, Skill], [C.SkillInfo, SkillInfo], [C.Channel, Channel],
  [C.TraceEvent, TraceEvent], [C.Transcript, Transcript], [C.Config, Config], [C.LiveEvent, LiveEvent], [C.SessionGroup, SessionGroup],
  [RunStateSchema, RunState], [ClassificationSchema, Classification], [SessionSchema, Session]]);
const entityOf = (schema) => BY_SCHEMA.get(schema) || null;

module.exports = { Agent, Flow, FlowRun, Skill, SkillInfo, Channel, TraceEvent, Transcript, Config, LiveEvent, SessionGroup, RunState, Classification, Session,
  entityOf, EntityError };
