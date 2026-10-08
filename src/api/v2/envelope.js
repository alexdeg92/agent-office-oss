'use strict';
// The one success envelope (api.md §2.1): { data, meta: { modelVersion, generatedAt, stale, topic? } }.
const MODEL_VERSION = 1;          // data-model.md MODEL_VERSION
const CONTRACT_VERSION = '2.5';   // G4: first-run setup, MetaVM.instance.configured
const CONTRACT_VERSION_V3 = '3.0';  // G5: /api/v3 (api-v3.md)

function okBody(data, { engine, now = Date.now(), topic } = {}) {
  const stale = engine ? engine.sources().filter((s) => s.state !== 'fresh').map((s) => s.id) : [];
  const meta = { modelVersion: MODEL_VERSION, generatedAt: now, stale };
  if (topic) meta.topic = { id: topic.id, rev: topic.rev };
  return { data, meta };
}

module.exports = { okBody, MODEL_VERSION, CONTRACT_VERSION, CONTRACT_VERSION_V3 };
