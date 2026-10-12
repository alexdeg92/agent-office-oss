'use strict';

/** Canonical project statuses. French labels live in the view model and in /api/v2/meta. */
const PROJECT_STATUSES = Object.freeze(['idea', 'todo', 'in-progress', 'in-review', 'shipped']);

// architect-55 (PM): ten levels, P0 the most urgent and important (migration 010; stored P0–P3 values unchanged)
const PRIORITIES = Object.freeze(['P0', 'P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7', 'P8', 'P9']);

const PRIORITY_RANK = Object.freeze({ P0: 0, P1: 1, P2: 2, P3: 3, P4: 4, P5: 5, P6: 6, P7: 7, P8: 8, P9: 9 });

const RISK_KEYS = Object.freeze(['blocked', 'flow-failing', 'cron-failing', 'ci-red', 'stale']);

const RISK_SEVERITY = Object.freeze({
  blocked: 'high',
  'flow-failing': 'high',
  'cron-failing': 'high',
  'ci-red': 'medium',
  stale: 'low',
});

/** Days without activity before the `stale` risk is raised. */
const STALE_AFTER_DAYS = 14;

const FLAG_KINDS = Object.freeze(['label', 'risk', 'feature', 'priority']);

/** LabelChip display order. Cards reorder again (risks first) in the board VM. */
const FLAG_SORT = Object.freeze({ priority: 0, risk: 1, feature: 2, label: 3 });

const SOURCE_KINDS = Object.freeze(['github', 'workspace', 'sessionGroup', 'manual']);

/** Kinds already named in data-model.md §9.6 / storage.md. */
const STORAGE_HISTORY_KINDS = Object.freeze([
  'project-created', 'status', 'priority', 'commit', 'flow-run', 'cron-run', 'session',
  'risk-raised', 'risk-cleared', 'risk-acked', 'flag-added', 'flag-removed', 'summary-edited',
  'source-linked', 'source-unlinked', 'agent-action',
]);

/**
 * Kinds this module writes. The architect is adding the ones after the storage
 * list to §9.6 and the SQL CHECK (projects-01 decisions, plus archive, people, flags).
 */
const HISTORY_KINDS = Object.freeze([
  ...STORAGE_HISTORY_KINDS,
  'renamed', 'risk-unacked', 'archived', 'restored', 'people-override', 'flags-updated',
]);

/** History Timmy may append. Status moves go through setStatus, not this list. */
const TIMMY_HISTORY_KINDS = Object.freeze(['commit', 'flow-run', 'cron-run', 'session', 'agent-action']);

/**
 * History that is meaningful activity. `lastActivityAt` is the max `at` over
 * these events (and over `flag-added` / `flag-removed` when `flagKind` is
 * `label`). Risk, ack, archive, people and feature-flag events are excluded,
 * so raising `stale` cannot make the project look active.
 */
const ACTIVITY_CLOCK_KINDS = Object.freeze([
  'project-created', 'status', 'priority', 'renamed', 'summary-edited',
  'source-linked', 'source-unlinked',
  'commit', 'flow-run', 'cron-run', 'session', 'agent-action',
]);

// Historical owner command alias is a persisted integration contract, not a display name.
const OWNER_ACTOR_SHORT = Object.freeze(['owner']);
const ACTOR_SHORT = Object.freeze([...OWNER_ACTOR_SHORT, 'system']);

const AGENT_STATES = Object.freeze([
  'idle', 'thinking', 'working', 'researching', 'writing', 'calling', 'waiting', 'error', 'offline',
]);

const CI_STATES = Object.freeze(['passing', 'failing', 'running', 'none', 'unrecognized']);

const BOARD_FILTERS = Object.freeze(['all', 'at-risk', 'with-timmy', 'archived']);

const MONOGRAM_ACCENTS = Object.freeze(['slate', 'indigo', 'teal', 'amber', 'rose', 'green']);

/** Workspace folder names that are agent or tool trees, not projects. */
const DEFAULT_IGNORE_DIR_NAMES = Object.freeze(['claude', 'codex', 'cursor']);

const SOURCE_ERROR_CATEGORIES = Object.freeze([
  'timeout', 'not-connected', 'connection-closed', 'connection-refused', 'unknown-method', 'not-found',
  'permission-denied', 'invalid-json', 'error', 'rate-limited',
]);

const CARD_FLAG_CAP = 3;
const CARD_PEOPLE_CAP = 4;
const HISTORY_PAGE = 20;

module.exports = {
  PROJECT_STATUSES, PRIORITIES, PRIORITY_RANK, RISK_KEYS, RISK_SEVERITY, STALE_AFTER_DAYS,
  FLAG_KINDS, FLAG_SORT, SOURCE_KINDS, STORAGE_HISTORY_KINDS, HISTORY_KINDS, TIMMY_HISTORY_KINDS,
  ACTIVITY_CLOCK_KINDS, OWNER_ACTOR_SHORT, ACTOR_SHORT, DEFAULT_IGNORE_DIR_NAMES, SOURCE_ERROR_CATEGORIES,
  AGENT_STATES, CI_STATES, BOARD_FILTERS, MONOGRAM_ACCENTS,
  CARD_FLAG_CAP, CARD_PEOPLE_CAP, HISTORY_PAGE,
};
