'use strict';

const { createHash } = require('node:crypto');

const SYNTHETIC_EVENT_ID = /^(?:ev:\d+:\d+|msg:[a-f0-9]{64}:\d+)$/;
const canonicalJson = value => JSON.stringify(value);

// A source may repeat a row while joining a full-history read to an incremental
// window. Exact repeats are delivery duplicates. If two different rows claim
// the same synthetic event identity, keep both while assigning the later row a
// deterministic canonical id. No source-private id is exposed in that repair.
function normalizeTranscriptEvents(transcript, sessionKey = transcript?.sessionKey || '') {
  if (!transcript || !Array.isArray(transcript.events)) return { transcript, repaired: 0 };
  const events = [], byId = new Map(), occurrences = new Map(), seenSourceRows = new Set();
  // Reserve IDs from the complete input before repairing any collision. A
  // replacement must never claim the ID of a later, otherwise-valid event.
  const used = new Set(transcript.events.map(event => event?.id).filter(id => typeof id === 'string' && id));
  let repaired = 0;
  for (const event of transcript.events) {
    const id = event?.id;
    if (typeof id !== 'string' || !id) { events.push(event); continue; }
    const sourceRow = canonicalJson(event), signature = `${id}\0${sourceRow}`;
    if (seenSourceRows.has(signature)) { repaired++; continue; }
    seenSourceRows.add(signature);
    const priorIndex = byId.get(id);
    if (priorIndex === undefined) {
      byId.set(id, events.length); used.add(id); events.push(event); continue;
    }
    if (!SYNTHETIC_EVENT_ID.test(id)) { events.push(event); continue; }
    const identity = eventIdentity(event);
    const occurrenceKey = canonicalJson([id, identity]);
    const occurrence = occurrences.get(occurrenceKey) || 1;
    occurrences.set(occurrenceKey, occurrence + 1);
    let suffix = 0, replacement;
    do {
      const digest = createHash('sha256').update(canonicalJson([sessionKey, id, identity, occurrence, suffix++])).digest('hex');
      replacement = `msg:${digest}:0`;
    } while (used.has(replacement));
    used.add(replacement); repaired++;
    events.push({ ...event, id: replacement });
  }
  return repaired ? { transcript: { ...transcript, events }, repaired } : { transcript, repaired: 0 };
}

// Only stable, non-content metadata participates in repair identity. Text and
// other transcript payload never enter the hash; occurrence is scoped to the
// conflicting source ID, so unrelated repairs cannot renumber this event.
function eventIdentity(event) {
  const sender = event?.senderInfo || {};
  return [event?.kind || null, Number.isSafeInteger(event?.at) ? event.at : null,
    sender.kind || null, sender.id || null, sender.runtime || null, sender.channel || null];
}

module.exports = { normalizeTranscriptEvents, eventIdentity };
