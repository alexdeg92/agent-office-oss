'use strict';
// Text-free communication from canonical senders in an occupant's exact session.
// Neither roster lineage nor provider names establish a message exchange.
const crypto = require('node:crypto');
const { canonicalRuleId } = require('./layout-rules');
const { buildGrid, findPath, isWalkable } = require('./pathfind');
const WINDOW_MS = 120_000, DEFAULT_MEETING_PERCENT = 10;
const canonicalId = id => canonicalRuleId(id) || id;
const hash = value => crypto.createHash('sha256').update(value).digest('hex').slice(0, 20);
const STATE_SCREEN = Object.freeze({ working: 'coding', observed: 'coding', researching: 'browsing', writing: 'writing',
  executing: 'terminal', calling: 'terminal', thinking: 'thinking', waiting: 'waiting', blocked: 'blocked', error: 'blocked' });
const label = screen => ({ key: `office.screen.${screen}` });

function communicationPairs(occupants, engine, now) {
  const bySession = new Map(), byAgent = new Map();
  const agents = new Set((engine.agents?.() || []).map(agent => agent.id));
  const add = (map, key, row) => { if (!key) return; const rows = map.get(key) || []; rows.push(row); map.set(key, rows); };
  for (const row of occupants) {
    add(bySession, row.sessionKey, row);
    const agentId = row.sessionKey && engine.session?.(row.sessionKey)?.class?.agentId;
    if (agents.has(agentId)) add(byAgent, `agent:${agentId}`, row);
  }
  const peerOf = sender => {
    if (sender?.kind !== 'agent') return null;
    // Delegation identifies an exact session and must never fall back to its lead.
    const rows = sender.delegation?.sessionKey ? bySession.get(sender.delegation.sessionKey)
      : byAgent.get(sender.id);
    return rows?.length === 1 ? rows[0] : null;
  };
  const pairs = new Map();
  const record = (sender, receiver, event, sessionKey) => {
    if (!sender || sender.id === receiver.id || !Number.isSafeInteger(event.at)
      || event.at > now || now - event.at > WINDOW_MS) return;
    const identities = [canonicalId(sender.id), canonicalId(receiver.id)].sort();
    const key = hash(JSON.stringify([sessionKey, identities]));
    const pair = { id: `communication:${key}`, senderId: sender.id, receiverId: receiver.id, at: event.at, eventId: event.id };
    const old = pairs.get(key);
    if (!old || pair.at > old.at || pair.at === old.at && pair.eventId > old.eventId) pairs.set(key, pair);
  };
  for (const owner of occupants) {
    if (!owner.sessionKey) continue;
    const transcript = engine.transcript?.(owner.sessionKey);
    if (!transcript || transcript.sessionKey !== owner.sessionKey) continue;
    let replyPeer = null;
    for (const event of transcript.events || []) {
      if (event.kind === 'user') {
        replyPeer = peerOf(event.senderInfo);
        record(replyPeer, owner, event, owner.sessionKey);
      } else if (event.kind === 'assistant') {
        const explicit = peerOf(event.senderInfo);
        if (explicit && explicit.id !== owner.id) record(explicit, owner, event, owner.sessionKey);
        else if (replyPeer && (!explicit || explicit.id === owner.id)) record(owner, replyPeer, event, owner.sessionKey);
        replyPeer = null;
      }
    }
  }
  // One current conversation per participant, bounded by the Office population.
  const used = new Set();
  return [...pairs.values()].sort((a,b) => b.at-a.at || a.id.localeCompare(b.id)).filter(pair => {
    if (used.has(pair.senderId) || used.has(pair.receiverId)) return false;
    used.add(pair.senderId); used.add(pair.receiverId); return true;
  });
}

function meetingTargets(floor, index, reserved) {
  if (!floor?.layout) return [];
  const room = index.rooms.get(floor.layout.room);
  if (!room) return [];
  const grid = buildGrid(room.cols, room.rows, floor.layout.items, index.furniture);
  const entrance = room.entrance || { x: 0, y: room.rows - 1 };
  return floor.layout.items.flatMap(item => {
    const asset = index.furniture.get(item.asset), station = asset?.station;
    if (station?.kind !== 'meeting' || item.wall != null || item.orientation && item.orientation !== 'sw') return [];
    const seats = (station.seats || []).map((seat, seatIndex) => {
      const point = { x: item.x + seat.x, y: item.y + seat.y }, cell = { x: Math.floor(point.x), y: Math.floor(point.y) };
      if (reserved.has(`${floor.id}:${cell.x},${cell.y}`) || !isWalkable(grid, cell.x, cell.y) || !findPath(grid, entrance, cell)) return null;
      return { kind: 'visit', floorId: floor.id, stationUid: item.uid, point, approachPoint: point, seatContact: null,
        mode: 'stand', seatIndex, facing: seat.facing === 'se' ? 'se' : 'sw' };
    }).filter(Boolean);
    // Use authored seats only: never allocate extra standing tiles around a table.
    return seats.length >= 2 ? [seats.slice(0, 2)] : [];
  });
}

function projectCommunication(office, { engine, index, layout, now, canReadSessions = false } = {}) {
  if (!office?.occupants || !engine) return office;
  const rows = new Map(office.occupants.map(row => [row.id, { ...row, communication: null }]));
  const reserved = new Set([...rows.values()].filter(row => row.sceneTarget && row.sceneTarget.mode !== 'desk')
    .map(row => `${row.floorId}:${Math.floor(row.sceneTarget.point.x)},${Math.floor(row.sceneTarget.point.y)}`));
  const configured = layout?.communicationMeetingPercent;
  const percent = Number.isInteger(configured) && configured >= 0 && configured <= 100 ? configured : DEFAULT_MEETING_PERCENT;
  const usedTables = new Set();
  if (canReadSessions) for (const pair of communicationPairs([...rows.values()], engine, now)) {
    const sender = rows.get(pair.senderId), receiver = rows.get(pair.receiverId);
    // Alarms retain their supplied state and target even during a fresh exchange.
    if ([sender, receiver].some(row => ['blocked', 'error'].includes(row.state))) continue;
    const floor = office.rosterFloors?.find(floor => floor.id === sender.floorId);
    const sample = parseInt(pair.id.slice(-8), 16) % 100;
    const seats = sample < percent && sender.floorId === receiver.floorId
      && [sender, receiver].every(row => !row.activity && !row.sceneTravel && row.sceneTarget?.mode === 'desk')
      ? meetingTargets(floor, index, reserved).find(seats => !usedTables.has(`${floor.id}:${seats[0].stationUid}`)) : null;
    if (seats) usedTables.add(`${floor.id}:${seats[0].stationUid}`);
    [sender, receiver].forEach((row, position) => {
      if (seats) { row.sceneTarget = seats[position]; row.sceneTravel = null; }
      row.communication = { id: pair.id, mode: seats ? 'meeting' : 'desk',
        peerIds: [position === 0 ? receiver.id : sender.id], expiresAt: pair.at + WINDOW_MS, screen: position === 0 ? 'message-sent' : 'message-received',
        surface: row.sceneTarget?.mode === 'desk' ? 'monitor' : 'bubble', label: label(position === 0 ? 'message-sent' : 'message-received') };
    });
  }
  for (const row of rows.values()) row.screenIntent = projectScreenIntent(row);
  return { ...office, occupants: [...rows.values()] };
}
function projectScreenIntent(row) {
  const screen = row.communication?.screen || STATE_SCREEN[row.state] || null;
  return { screen, surface: screen ? row.sceneTarget?.mode === 'desk' ? 'monitor' : 'bubble' : 'none',
    label: screen ? label(screen) : null };
}
module.exports = { projectScreenIntent, communicationPairs, projectCommunication, WINDOW_MS, DEFAULT_MEETING_PERCENT };
