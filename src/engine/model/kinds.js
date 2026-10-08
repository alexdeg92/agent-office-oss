'use strict';
// Canonical vocabularies (data-model §2). Core vocabulary: adapters classify INTO it.
// G3b (ADR-001 §4.2, §12.3): generic kinds behind the 2.x projection (src/api/v2/project2x.js maps them back).
// `dashboard`, `acp` and `explicit` become `internal` + runtimeKind in contract 3.0 (G5).
const SESSION_KINDS = ['primary', 'dashboard', 'subagent', 'scheduled', 'conversation-direct', 'conversation-group', 'conversation',
  'acp', 'explicit', 'unrecognized'];
const CONVERSATION_KINDS = new Set(['conversation-direct', 'conversation-group', 'conversation']);
// ChannelRef: any adapter-normalised slug (§12.3). Never a closed union.
const CHANNEL_REF = /^[a-z][a-z0-9-]{0,31}$/;
// Interlocutor ids: '<channelRef>-(user|room):<opaque>' (§12.5); 'discord-channel' stays a legal 2.x alias of 'discord-room'.
// R26-01: id bounds count CODE POINTS (as SQLite's length() on TEXT does): the `u` flag makes {1,128} count code points
const INTERLOCUTOR_ID = /^([a-z][a-z0-9-]{0,31})-(user|room|channel):([^\u0000-\u001f\u007f]{1,128})$/u;
const isInterlocutorId = (v) => { const m = INTERLOCUTOR_ID.exec(String(v)); return !!m && (m[2] !== 'channel' || m[1] === 'discord'); };
// R24-01: ONE occupant-id limit, end to end. An occupant id is '<role>:<subject>' (subject: a sub-agent, cron job or
// interlocutor id, or a session key); the subject is validated at the edge (canonical models) to OCCUPANT_SUBJECT_MAX, and
// the stored id is bounded by the longest role prefix of EITHER vocabulary ('conversation:') plus that subject, so a
// 2.x → 3.0 conversion (cron → scheduled: +5) never exceeds it. The store's CHECK uses OCCUPANT_ID_MAX (test-asserted).
// R26-01: lengths in CODE POINTS everywhere (JS `.length` counts UTF-16 units; SQLite length() counts code points)
const cpLength = (s) => [...String(s)].length;
const OCCUPANT_SUBJECT_MAX = 200;
const OCCUPANT_ID_MAX = 'conversation:'.length + OCCUPANT_SUBJECT_MAX;   // 213
module.exports = { cpLength, OCCUPANT_SUBJECT_MAX, OCCUPANT_ID_MAX, SESSION_KINDS, CONVERSATION_KINDS, CHANNEL_REF, INTERLOCUTOR_ID, isInterlocutorId };
