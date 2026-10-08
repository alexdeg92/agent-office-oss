'use strict';
// Projects canonical classes (defineEntity, architect item B). Optional fields become explicit null on the
// instance. The repository still stores the schema's own value, and admits each value through these classes.

const { defineEntity, EntityError } = require('../model/entity');
const { ProjectError } = require('./errors');
const {
  flagSchema, sourceSchema, sourceSchemaWithRootIds, personSchema, projectSchema, projectSchemaWithRootIds, historySchema,
} = require('./validate');

const Flag = defineEntity('Flag', flagSchema);
const ProjectSource = defineEntity('ProjectSource', sourceSchema);
const ProjectSourceWithRootIds = defineEntity('ProjectSource', sourceSchemaWithRootIds);
const Person = defineEntity('Person', personSchema);
const HistoryEvent = defineEntity('HistoryEvent', historySchema);
const Project = defineEntity('Project', projectSchema);
const ProjectWithRootIds = defineEntity('Project', projectSchemaWithRootIds);

function admit(Entity, data) {
  try {
    return new Entity(data);
  } catch (err) {
    if (err instanceof EntityError) {
      throw new ProjectError('validation_failed', 'Donnée invalide.', {
        details: err.issues.slice(0, 8).map((issue) => ({ field: issue.path, issue: issue.detail })),
      });
    }
    throw err;
  }
}

module.exports = {
  Flag, ProjectSource, ProjectSourceWithRootIds, Person, HistoryEvent, Project, ProjectWithRootIds, admit,
};
