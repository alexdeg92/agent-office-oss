// Mock OfficeVM / LayoutVM for the /v2 mock API (frontend's mock/server.js calls these builders).
// Built FROM the authoritative 2.1 examples docs/architecture/examples/{office-vm,layout-vm}.json:
// test/office/contract-examples.test.js checks compareShape(example, mock) === [].
// Deterministic: the office follows a scripted timeline driven by tick(), so screenshots and tests
// are reproducible. Pure; no DOM.
import { indexManifest } from './assets.js';
import { resolveOccupants, validateLayout, toVocabulary, canonicalRole, canonicalRuleId } from './layout-rules.js';
import { planFloors, validateFloors, floorLayout, saveFloor } from './floors.js';
import { createMockLayoutStore } from './mock-store.js';

const MIN = 60_000;

/**
 * Scripted day at the office, one step per tick (the mock server ticks every 3 s).
 * Each step lists the sub-agents on stage with their state; `cue` frames are emitted on transitions.
 */
const SCRIPT = [
  { main: 'working', subs: [] },
  { main: 'thinking', subs: [] },
  { main: 'working', subs: [['scout', 'working']], cues: [['main', 'delegating', 'NEW']] },
  { main: 'working', subs: [['scout', 'researching']] },
  { main: 'writing', subs: [['scout', 'researching'], ['plume', 'working']], cues: [['main', 'delegating', 'NEW']] },
  { main: 'waiting', subs: [['scout', 'thinking'], ['plume', 'writing']] },
  { main: 'working', subs: [['scout', 'working'], ['plume', 'writing'], ['atlas', 'calling']], cues: [['main', 'delegating', 'NEW']] },
  { main: 'working', subs: [['scout', 'idle'], ['plume', 'working'], ['atlas', 'error']], cues: [['subagent:scout', 'celebrating']] },
  { main: 'thinking', subs: [['plume', 'working'], ['atlas', 'error']] },
  { main: 'working', subs: [['plume', 'idle'], ['atlas', 'working']], cues: [['subagent:plume', 'celebrating']] },
  { main: 'idle', subs: [['atlas', 'working']] },
  { main: 'idle', subs: [], cues: [['subagent:atlas', 'celebrating']] },
];
const NAMES = { scout: 'Scout', plume: 'Plume', atlas: 'Atlas' };
const ACTIVE = ['thinking', 'working', 'researching', 'writing', 'calling', 'waiting'];
const chip = (id, name, state) => ({ id: `per_${id.replace(/[^a-z0-9]/gi, '').padEnd(16, '0').slice(0, 16)}`, kind: 'agent', name, avatarUrl: null, state });

/**
 * @param {object} opts
 * @param {object} opts.manifest        design/office/manifest.example.json
 * @param {object} opts.layout          design/office/layout.example.json (seed + shipped default)
 * @param {'1'|'vide'|'panne'|string} [opts.scenario]
 * @param {() => number} [opts.now]
 */
/** The mock's stored layout carries the seen-agent period explicitly (O8 default, 30 minutes), so 3.0 reads show the optional field. */
const withPresence = (l) => structuredClone(l.presence ? l : { ...l, presence: { seenMinutes: 30 } });

export function createOfficeMock({ manifest, layout, floorDefaults = [], scenario = '1', now = () => Date.now(), mainName = 'Morgan', timeZone = undefined, version = 2 }) {
  if(floorDefaults.length)layout={...layout,floors:floorDefaults.map(f=>({id:f.id,kind:f.kind,layout:{room:f.layout.room,theme:f.layout.theme,items:f.layout.items}}))};
  // The contract version this mock speaks (api-v3.md D3/D4): 2 → 2.x names (main, *cron, dm:…), 3 → 3.0 names (primary,
  // *scheduled, direct:…). Internally the mock keeps 2.x ids; every VM, cue and layout is projected on the way out,
  // and layouts written in either vocabulary are accepted (layout-rules.js reads both).
  const v3 = version === 3;
  const pid = (id) => (v3 ? (canonicalRuleId(id) ?? id) : id);
  const prole = (role) => (v3 ? (canonicalRole(role) ?? role) : role);
  // O8 presence, like the server (operations.md §4): 3.0 reads show it; a 2.x read doesn't, and a 2.x save keeps it.
  const playout = (d) => { const out = toVocabulary(d, v3 ? '3.0' : '2.x'); if (!v3 && out) delete out.presence; return out; };
  const keepPresence = (d) => (v3 || !d || d.presence !== undefined || !data()?.presence ? d : { ...d, presence: data().presence });
  const pvm = (vm) => vm && ({ allowNoDesk:false,...vm, layout: { ...vm.layout, data: playout(vm.layout.data) }, default: vm.default && { ...vm.default, data: playout(vm.default.data) },
    agentsSeen: (vm.agentsSeen ?? []).map((a) => ({ ...a, id: pid(a.id), role: prole(a.role) })) });
  const index = indexManifest(manifest);
  const store = createMockLayoutStore({
    data: withPresence(layout), defaultData: withPresence(layout), manifest, now, timeZone,
    validate: (d) => [...validateLayout(d, index), ...(d.floors ? validateFloors(d, index) : [])],
    agentsSeen: [{ id: 'subagent:archiviste', role: 'subagent', name: 'Archiviste', lastSeenAt: now() - 3 * 86_400_000 }],
  });
  let step = 0;
  const since = new Map();       // occupant id → { state, at }
  const journal = [];
  let seq = 0;
  let layoutRev = store.revision;
  const t0 = now();
  let visitLastAt = t0;

  function stepNow() {
    if (scenario === 'vide') return { main: 'idle', subs: [] };
    if (scenario === 'panne') return { main: 'offline', subs: [] };
    return SCRIPT[step % SCRIPT.length];
  }

  // The seen inventory, like the server's (migration 008): every occupant on stage is « seen now »; one that leaves
  // keeps its last time. Merged into LayoutVM.agentsSeen (newest first).
  const seenLog = new Map();
  function recordSeen(list) {
    const t = now();
    for (const o of list) seenLog.set(o.id, { id: o.id, role: o.role, name: o.sourceName, lastSeenAt: t });
  }
  // O9 scenario « foule »: 30 agents (the primary and 29 sub-agents in varied states), to fill the office and annexes.
  const CROWD_STATES = ['working', 'thinking', 'writing', 'researching', 'calling', 'waiting', 'idle', 'working', 'error', 'thinking'];
  function sources() {
    // office-dev-22 scenario « visite »: a Discord DM. Step 0: a person's first message (the agent works, they visit his desk);
    // 1: the run over (the DM off stage: the person lingers, then walks out); 2: a second message (a conversation → the
    // meeting table); 3+: quiet (the agent back at his desk, the person gone). The primary works while its DM runs, as
    // the server does.
    if (scenario === 'visite') {
      const talking = step === 0 || step === 2;
      const visitorPresent = step !== 1 || now() - visitLastAt < 60_000;
      return [{ id: 'main', role: 'main', sourceName: mainName, state: talking ? 'working' : 'idle' },
        ...(visitorPresent ? [{ id: 'dm:camille', role: 'dm', sourceName: 'Camille', state: step === 1 ? 'idle' : 'working' }] : [])];
    }
    // T-0062: ?mock=lignee — canonical lineage (OccupantVM.parentId): two spawned sub-agents and a DM of the main agent
    if (scenario === 'lignee') {
      return [{ id: 'main', role: 'main', sourceName: mainName, state: 'working' },
        { id: 'subagent:scout', role: 'subagent', sourceName: NAMES.scout, state: 'researching', parent: 'main' },
        { id: 'subagent:plume', role: 'subagent', sourceName: NAMES.plume, state: 'writing', parent: 'main' },
        { id: 'dm:camille', role: 'dm', sourceName: 'Camille', state: 'working', parent: 'main' }];
    }
    if (scenario === 'foule') {
      return [{ id: 'main', role: 'main', sourceName: mainName, state: CROWD_STATES[step % CROWD_STATES.length] },
        ...Array.from({ length: 29 }, (_, i) => ({ id: `subagent:a${String(i + 2).padStart(2, '0')}`, role: 'subagent', sourceName: `Agent ${String(i + 2).padStart(2, '0')}`,
          // about three agents change state per tick (a busy office), the others keep theirs
          state: CROWD_STATES[(i * 3 + Math.floor((step + i) / 10)) % CROWD_STATES.length] }))];
    }
    const s = stepNow();
    return [
      // The primary agent's name is instance data (configured or discovered by the adapter), never a literal.
      { id: 'main', role: 'main', sourceName: mainName, state: s.main },
      ...s.subs.map(([k, state]) => ({ id: `subagent:${k}`, role: 'subagent', sourceName: NAMES[k], state })),
    ];
  }

  // Journal items use only the LiveEvent variants the example shows: run.started (agent actor) and
  // cron.fired (system actor), so compareShape stays exact.
  function stamp(id, state, sourceName = null) {
    const prev = since.get(id);
    if (prev && prev.state === state) return prev.at;
    const at = now();
    since.set(id, { state, at });
    const name = id === 'main' ? mainName : sourceName ?? NAMES[id.split(':')[1]] ?? id;
    if (ACTIVE.includes(state) && (!prev || !ACTIVE.includes(prev.state))) {
      journal.unshift({ id: `le_${++seq}`, at, count: 1, actor: chip(id, name, state), text: { key: 'liveEvent.run.started', params: { occupant: name } }, kind: 'run.started' });
      journal.length = Math.min(journal.length, 14);
    }
    return at;
  }
  journal.push({ id: `le_${++seq}`, at: t0 - 5 * MIN, count: 1, actor: { kind: 'system', name: 'Système' }, text: { key: 'liveEvent.cron.fired', params: { job: 'Résumé du matin' } }, kind: 'cron.fired' });

  const data = () => store.vmNow().layout.data;
  const scoped = (vm,id) => id == null ? vm : {...vm,allowNoDesk:floorDefaults.find(f=>f.id===id)?.allowNoDesk ?? false,
    layout:{...vm.layout,data:floorLayout(vm.layout.data,index,id)},default:{...vm.default,data:floorLayout(vm.default.data,index,id)}};

  return {
    /** Advance the script; returns the cue frames to emit (SSE `cue`). */
    tick() {
      step++;
      if (scenario === 'visite') visitLastAt = now();
      // delegating carries the newly arrived sub-agent as partnerId (api.md 2.1 §4.4) and an interactionId.
      const prev = new Set(SCRIPT[(step - 1 + SCRIPT.length) % SCRIPT.length].subs.map(([k]) => k));
      const fresh = stepNow().subs.map(([k]) => k).filter((k) => !prev.has(k));
      return (stepNow().cues ?? []).map(([occupantId, cue, partner]) => ({
        type: 'cue', occupantId: pid(occupantId), cue, at: now(),
        ...(partner === 'NEW' && fresh.length ? { partnerId: `subagent:${fresh[0]}`, interactionId: `int_${step}_${fresh[0]}` } : {}),
      }));
    },

    /** OfficeVM (api.md §3.2). Synchronous; `await` works too. */
    officeVM() {
      const d = data();
      const src = sources();
      recordSeen(src);
      for (const id of since.keys()) if (!src.some((x) => x.id === id)) since.delete(id);   // one who left starts afresh
      const resolved = resolveOccupants(d, index, src);
      let occupants = src.map((s, i) => {
        const r = resolved[i];
        return {
          id: pid(s.id), role: prole(s.role), name: r.name,
          roleLabel: r.roleLabel.key === 'custom' ? r.roleLabel : { key: `occupantRole.${prole(s.role)}` }, ruleId: r.ruleId && (v3 ? canonicalRuleId(r.ruleId) : toVocabulary({ agents: [{ agentId: r.ruleId }] }, '2.x').agents[0].agentId),
          // 2.4 (architect-26): the session title as a LabelRef; a discovered name is `sessionTitle.named`, an unnamed
          // primary session `sessionTitle.main`, an unnamed sub-agent `sessionTitle.subagent {id}`.
          title: s.sourceName && !/^(main|subagent:)/.test(s.sourceName) ? { key: 'sessionTitle.named', params: { name: s.sourceName } }
            : s.role === 'main' ? { key: 'sessionTitle.main' } : { key: 'sessionTitle.subagent', params: { id: s.id.split(':')[1].slice(0, 4) } },
          state: s.state, stateSince: stamp(s.id, s.state, s.sourceName),
          stationUid: r.stationUid, look: r.look,
          // Scripted exec tool: Atlas « calling » goes to the server rack (server-authoritative destination).
          destination: s.id === 'subagent:atlas' && s.state === 'calling' && d.items.some((it) => it.uid === 'rack') ? { kind: 'server', stationUid: 'rack' } : null,
          sessionKey: s.id === 'main' ? 'agent:main:main' : `agent:main:subagent:${s.id.split(':')[1]}`,
          execution: s.state === 'unknown' || s.state === 'offline' ? { status: 'unknown', evidence: { level: 'unknown', observedAt: null, expiresAt: null } }
            : s.state === 'observed' ? { status: 'unknown', evidence: { level: 'observed', observedAt: now(), expiresAt: now() + 30000 } }
              : { status: s.state === 'working' || s.state === 'calling' || s.state === 'thinking' || s.state === 'writing' || s.state === 'researching' ? 'running'
                : s.state === 'error' ? 'failed' : 'idle',
                evidence: { level: 'verified', observedAt: now(), expiresAt: null } },
          tokens: 52_300 + i * 8_100 + step * 640, lastSeenAt: now(), ...(s.parent ? { parentId: pid(s.parent) } : {}),
        };
      });
      let visitIntent = { hostId: pid('main'), hosts: [], desk: [], meeting: [], talking: false, speaker: null, until: null, visitors: [] };
      if (scenario === 'visite') {
        const visitor = occupants.find(o => o.id === pid('dm:camille'));
        const elapsed = now() - visitLastAt;
        let phase = null;
        if (visitor && step === 0) phase = elapsed < 12_000 ? 'person' : 'agent';
        else if (visitor && step === 1 && elapsed < 60_000) phase = 'linger';
        else if (visitor && step === 2) phase = 'person';
        if (visitor && phase) {
          if (phase === 'agent') { visitor.state = 'waiting'; visitor.stateLabel = { key: 'agentState.waiting' }; }
          if (phase === 'linger') { visitor.state = 'idle'; visitor.stateLabel = { key: 'agentState.idle' }; }
          visitor.visitPhase = phase; visitor.visitOnStage = true; visitor.visitStateLabel = visitor.stateLabel;
          visitor.stateDetailLabel = visitor.stateLabel; visitor.stateLastLabel = { key: 'office.lastState', params: { state: visitor.stateLabel } };
          const meeting = step === 2;
          visitIntent = { hostId: pid('main'), hosts: [{ id: pid('main'), visitorIds: [visitor.id] }],
            desk: meeting ? [] : [visitor.id], meeting: meeting ? [pid('main'), visitor.id] : [],
            talking: phase !== 'linger', speaker: phase === 'person' ? visitor.id : phase === 'agent' ? pid('main') : null,
            until: phase === 'person' ? visitLastAt + 12_000 : phase === 'linger' ? visitLastAt + 60_000 : null,
            visitors: [{ id: visitor.id, phase, stateLabel: visitor.stateLabel, onStage: true }] };
        }
      }
      const floorPlan = planFloors(index, d, occupants);
      occupants = floorPlan.occupants;
      const active = occupants.filter((o) => !['idle', 'offline'].includes(o.state)).length;
      for (const o of occupants) delete o.sourceName;
      // The mock is a source fixture for the same render-only OfficeVM contract
      // as production; grouping, order and floor counts are provided here.
      const byId = new Map(occupants.map(o => [o.id, o]));
      const parentOf = new Map(occupants.map(o => [o.id, typeof o.parentId === 'string' && byId.has(o.parentId) ? o.parentId : null]));
      const children = new Map();
      for (const [id, parentId] of parentOf) if (parentId) { const rows = children.get(parentId) || []; rows.push(id); children.set(parentId, rows); }
      const ordered = [], seen = new Set();
      const visit = (id, rootId, depth) => { if (seen.has(id)) return; seen.add(id); ordered.push({ id, rootId, depth }); for (const child of children.get(id) || []) visit(child, rootId, depth + 1); };
      for (const o of occupants) if (!parentOf.get(o.id)) visit(o.id, o.id, 0);
      for (const o of occupants) if (!seen.has(o.id)) { parentOf.set(o.id, null); visit(o.id, o.id, 0); }
      const conversationRoles = new Set(['direct', 'group', 'conversation', 'session', 'dm', 'channel']);
      const conversationIds = occupants.filter(o => conversationRoles.has(o.role)).map(o => o.id);
      const conversations = new Set(conversationIds);
      const rows = new Map();
      for (const [order, entry] of ordered.entries()) {
        const o = byId.get(entry.id), parentId = parentOf.get(entry.id);
        rows.set(entry.id, { ...o, parentId, parentName: !conversations.has(entry.id) && parentId ? byId.get(parentId)?.name || null : null,
          parentAmbiguous: false, rosterDepth: conversations.has(entry.id) ? 0 : entry.depth, teamId: null, groupId: entry.rootId, rosterOrder: order, floorId: o.floorId || '1', standingPoint: null,
          stateActive: !['unknown', 'idle', 'offline'].includes(o.state), stateLabel: { key: `agentState.${o.state}` },
          stateDetailLabel: { key: `agentState.${o.state}` }, stateLastLabel: { key: 'office.lastState', params: { state: { key: `agentState.${o.state}` } } } });
      }
      const rosterItems = ordered.filter(entry => !parentOf.get(entry.id) && !conversations.has(entry.id)).map(({ id: rootId }) => {
        const childIds = ordered.filter(entry => entry.rootId === rootId && entry.id !== rootId && !conversations.has(entry.id)).map(entry => entry.id);
        const previewOccupantIds = [rootId, ...childIds.slice(0, 2)], overflowCount = Math.max(0, childIds.length - 2);
        return { id: rootId, kind: childIds.length ? 'group' : 'occupant', isGroup: childIds.length > 0, rootId, occupantIds: [rootId, ...childIds], childIds,
          previewOccupantIds, overflowCount, openLabel: { key: 'office.mobile.openTeam', params: { name: rows.get(rootId).name, n: childIds.length } },
          delegatesLabel: { key: 'office.mobile.delegates', params: { n: childIds.length } }, overflowLabel: overflowCount ? { key: 'office.mobile.overflowCount', params: { n: overflowCount } } : null,
          order: rows.get(rootId).rosterOrder, count: childIds.length, label: rows.get(rootId).title };
      });
      const rosterPreviewItems = rosterItems.slice(0, 5);
      const rosterPopulation = occupants.filter(o => !conversations.has(o.id));
      const order = id => id === 'rdc' ? 0 : id === 'gym' ? 10002 : Number(id) || 1;
      const rosterFloors = floorPlan.floors.map(floor => {
        const people = floor.occupants, floorActive = people.some(o => o.state === 'unknown') ? null : people.filter(o => !['idle','offline'].includes(o.state)).length;
        return { id: floor.id, order: order(floor.id), label: { key: floor.id === 'rdc' ? 'office.floor.rdc' : floor.id === 'gym' ? 'office.floor.gym' : floor.id === '1' ? 'office.floor.first' : 'office.floor.number', ...(Number(floor.id) > 1 ? { params: { n: Number(floor.id) } } : {}) },
          countLabel: { key: 'office.floor.count', params: { n: people.length } },
          statusLabel: floorActive == null ? { key: 'office.floor.activityUnknown' } : { key: 'office.floor.status', params: { active: floorActive, idle: people.filter(o => ['idle','offline'].includes(o.state)).length } },
          kind: floor.kind, occupantIds: people.map(o => o.id), mobileLabelIds: [], items: people.map(o => ({ kind: 'occupant', id: `occupant:${o.id}`, occupantId: o.id })), count: people.length, activeCount: floorActive,
          idleCount: people.filter(o => ['idle','offline'].includes(o.state)).length,
          layout: { room: floor.layout.room, theme: floor.layout.theme, items: floor.layout.items }, capacity: floor.capacity };
      });
      return {
        connection: { gateway: scenario === 'panne' ? 'down' : 'up', since: t0 - 42 * MIN },
        kpis: [
          { id: 'active', label: { key: 'kpi.active' }, value: active, unit: 'count', sub: { key: 'kpi.onStage', params: { n: occupants.length } } },
          { id: 'runs', label: { key: 'kpi.runs' }, value: scenario === '1' ? active : 0, unit: 'count', sub: null },
          { id: 'subagents', label: { key: 'kpi.subagents' }, value: occupants.length - 1, unit: 'count', sub: null },
          { id: 'flows', label: { key: 'kpi.flows' }, value: 4, unit: 'count', sub: { key: 'kpi.nextFlow', params: { time: '09:00' } } },
          { id: 'tokens', label: { key: 'kpi.tokens' }, value: occupants.reduce((n, o) => n + o.tokens, 0), unit: 'tokens', sub: null },
          { id: 'cpu', label: { key: 'kpi.cpu' }, value: 18 + (step % 5) * 3, unit: 'percent', sub: null },
        ],
        occupants: ordered.map(entry => rows.get(entry.id)), rosterGroups: [], rosterItems, rosterPreviewItems,
        rosterOverflowCount: Math.max(0, rosterItems.length - rosterPreviewItems.length), rosterSummary: { count: rosterPopulation.length,
          activeCount: rosterPopulation.some(o => o.state === 'unknown') ? null : rosterPopulation.filter(o => !['idle', 'offline'].includes(o.state)).length },
        rosterAllLabel: { key: 'office.mobile.all', params: { n: rosterItems.length } },
        rosterOverflowLabel: { key: 'office.mobile.overflowCount', params: { n: Math.max(0, rosterItems.length - rosterPreviewItems.length) } },
        conversationIds, conversationCount: conversationIds.length, conversationLabel: { key: 'office.mobile.conversations', params: { n: conversationIds.length } },
        stateLabels: Object.fromEntries(['unknown','observed','idle','thinking','working','researching','writing','calling','executing','waiting','blocked','error','offline'].map(state => [state, { key: `agentState.${state}` }])),
        visitIntent, rosterFloors, unseatedTeams: [],
        journal: [...journal],
        layoutRevision: store.revision,
        queue: [
          { id: 'ffffffff-0c01-4000-8000-000000000001', name: 'Veille hebdomadaire', schedule: { key: 'schedule.weekly', params: { day: '1', time: '09:00' } } },
          { id: 'ffffffff-0c01-4000-8000-000000000002', name: 'Résumé du matin', schedule: { key: 'schedule.daily', params: { time: '07:30' } } },
        ],
      };
    },

    /** LayoutVM (api.md §3.10 + proposal §5: default, revisions, agentsSeen). */
    /** LayoutVM (api.md §3.10). Synchronous; `await` works too. */
    layoutVM: (floor = null) => {
      const vm = store.vmNow();
      recordSeen(sources());
      const ids = new Set(seenLog.keys());
      return pvm(scoped({ ...vm, agentsSeen: [...seenLog.values(), ...(vm.agentsSeen ?? []).filter((a) => !ids.has(a.id))].sort((a, b) => b.lastSeenAt - a.lastSeenAt) },floor));
    },
    getRevision: (rev,floor=null) => store.getRevision(rev).then(x=>({...x,data:playout(floor==null?x.data:floorLayout(x.data,index,floor))})),
    /** PUT /api/v2/office/layout → CommandResult; throws {status, error} like the API. */
    async putLayout(body,floor=null) {
      try { const next=keepPresence(body.data);const r = await store.put({ ...body, data: floor==null?next:saveFloor(data(),index,floor,next) }); layoutRev = r.revision; return r && r.vm ? { ...r, vm: pvm(scoped(r.vm,floor)) } : r; }
      catch (e) { if (e?.error?.current?.vm) e.error.current.vm = pvm(scoped(e.error.current.vm,floor)); throw e; }
    },
    /** PUT /api/v2/office/layout/theme (proposal §4): replace the theme only, same concurrency rule. */
    async putTheme({ expectedRevision, theme },floor=null) {
      const local=floor==null?data():floorLayout(data(),index,floor);
      return this.putLayout({expectedRevision,data:{...local,theme}},floor);
    },
    /** Demo/test hook: another device saves meanwhile. */
    externalEdit: (fn) => store.externalEdit(fn),
    get layoutRevision() { return layoutRev; },
    get step() { return step; },
  };
}
