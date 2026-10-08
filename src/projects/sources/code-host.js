'use strict';
// CodeHostProvider. GitHub fetches. GitLab and Gitea are named and report not-supported until their examples exist.

const { ProjectError } = require('../errors');
const { createGithubSource } = require('./github');

function unsupported(id) {
  const fail = () => {
    throw new ProjectError('validation_failed', 'error.project.not-supported', {
      details: [{ field: 'source', issue: 'not-supported' }],
    });
  };
  return {
    id,
    parseRef: fail,
    fetch: async () => fail(),
    webUrl() { return null; },
    openGraphUrl() { return null; },
  };
}

function providerFor(id, options) {
  if (id === 'github') return createGithubSource(options);
  if (id === 'gitlab' || id === 'gitea') return unsupported(id);
  return unsupported(id);
}

module.exports = { providerFor, unsupported };
