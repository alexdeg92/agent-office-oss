'use strict';

const STATUS = {
  validation_failed: 400,
  not_found: 404,
  conflict: 409,
  upstream_failed: 502,
  internal: 500,
};

class ProjectError extends Error {
  /**
   * @param {'validation_failed'|'not_found'|'conflict'|'upstream_failed'|'internal'} code
   * @param {string} message French, safe to show
   * @param {{ revision?: number|null, details?: {field?: string, issue?: string}[]|null, status?: number }} [extra]
   */
  constructor(code, message, extra = {}) {
    super(message);
    this.name = 'ProjectError';
    this.code = code;
    this.status = extra.status ?? STATUS[code] ?? 500;
    this.revision = extra.revision ?? null;
    this.details = extra.details ?? null;
    if (typeof extra.category === 'string') this.category = extra.category;
  }
}

function validation(message, field, issue = message) {
  return new ProjectError('validation_failed', message, { details: [{ field, issue }] });
}

const CONFLICT_MESSAGE = 'Le projet a changé entre-temps.';

function conflict(revision) {
  return new ProjectError('conflict', CONFLICT_MESSAGE, { revision });
}

function projectConflictBody({ requestId, vm }) {
  return {
    error: {
      code: 'conflict',
      message: CONFLICT_MESSAGE,
      requestId,
      current: { revision: vm.revision, vm },
    },
  };
}

function sourceInUse() {
  return new ProjectError('conflict', 'Ce dépôt est déjà lié à un autre projet.', {
    revision: null,
    details: [{ field: 'source', issue: 'source-in-use' }],
  });
}

function notFound(message = 'Projet introuvable.') {
  return new ProjectError('not_found', message);
}

module.exports = { ProjectError, validation, conflict, projectConflictBody, sourceInUse, notFound, STATUS, CONFLICT_MESSAGE };
