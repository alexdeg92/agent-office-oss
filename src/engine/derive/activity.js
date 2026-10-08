'use strict';
/*
 * Activity on OpenClaw 2026.9.8 (data-model §3, engine.md §6.2): derived from the run state only.
 * A session whose canonical run is 'running' has Activity { kind: 'working', source: 'run-state' };
 * any other session has none. Finer kinds (thinking/writing/calling/researching) have no source on
 * this protocol and are never invented. Pure.
 */
function activityOf(session) {
  if (!session || !session.run || session.run.status !== 'running') return null;
  return { sessionKey: session.key, kind: 'working', source: 'run-state', since: session.run.startedAt || session.updatedAt || null };
}

module.exports = { activityOf };
