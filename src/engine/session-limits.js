'use strict';

// Shared, runtime-agnostic ingestion and presentation bounds. OpenClaw's page
// size and Codex/Claude transcript windows remain within these limits.
const MAX_SESSION_PAGE_SIZE = 300;
const MAX_SESSION_PAGES = 20;
const MAX_RUNTIME_SESSIONS = MAX_SESSION_PAGE_SIZE * MAX_SESSION_PAGES;
const MAX_CANONICAL_SESSION_SNAPSHOT = MAX_RUNTIME_SESSIONS;
const MAX_OFFICE_OCCUPANTS = 64;

module.exports = { MAX_SESSION_PAGE_SIZE, MAX_SESSION_PAGES, MAX_RUNTIME_SESSIONS,
  MAX_CANONICAL_SESSION_SNAPSHOT, MAX_OFFICE_OCCUPANTS };
