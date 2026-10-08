'use strict';

/** French strings that the history payload stores because the event shape requires a label. */
const RISK_LABELS = {
  blocked: 'Bloqué',
  'flow-failing': 'Flow en échec',
  'cron-failing': 'Cron en échec',
  'ci-red': 'CI rouge',
};

function riskLabel(key, staleDays) {
  if (key === 'stale') return staleDays ? `Inactif depuis ${staleDays} j` : 'Inactif';
  return RISK_LABELS[key] || key;
}

const STATUS_LABELS = {
  idea: 'Idée',
  todo: 'À faire',
  'in-progress': 'En cours',
  'in-review': 'En revue',
  shipped: 'Livré',
};

/** Printed confidence. The stored value stays `high` | `medium` | `low`. */
const CONFIDENCE_LABELS = {
  high: 'haute',
  medium: 'moyenne',
  low: 'faible',
};

function confidenceText(value) {
  return CONFIDENCE_LABELS[value] || '—';
}

module.exports = { RISK_LABELS, riskLabel, STATUS_LABELS, CONFIDENCE_LABELS, confidenceText };
