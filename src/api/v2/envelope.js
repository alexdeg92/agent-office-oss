'use strict';
// The one success envelope (api.md §2.1): { data, meta: { modelVersion, generatedAt, stale, topic? } }.
const MODEL_VERSION = 1;          // data-model.md MODEL_VERSION
const CONTRACT_VERSION = '2.8';   // Canonical health checks and adapter-declared remedies
const CONTRACT_VERSION_V3 = '3.5';  // Provider-neutral team leadership projection

function okBody(data, { engine, now = Date.now(), topic } = {}) {
  const stale = engine ? engine.sources().filter((s) => s.state !== 'fresh').map((s) => s.id) : [];
  const meta = { modelVersion: MODEL_VERSION, generatedAt: now, stale };
  if (topic) meta.topic = { id: topic.id, rev: topic.rev };
  return { data, meta };
}

module.exports = { okBody, MODEL_VERSION, CONTRACT_VERSION, CONTRACT_VERSION_V3 };
