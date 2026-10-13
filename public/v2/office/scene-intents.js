export { screen, marker, bubble, tickScreens } from './monitor-screens.js';
// Canonical spatial intents are backend data. This module only projects them
// into the renderer's coordinates and chooses authored animation frames.
import { label as labelRef } from '../i18n.js';

export function label(c) { return c.occ.activity ? labelRef(c.occ.activity.label) : ''; }

const projected = (t, id) => t && ({ ...t.point, uid: t.stationUid ?? `intent:${id}`, mode: t.mode,
    seatIndex: t.seatIndex, facing: t.facing, approachPoint: t.approachPoint,
    seatContact: t.seatContact });
export function target(c) { return projected(c.occ.sceneTarget, c.id); }

// This cache records animation playback only. VM floor membership, counts,
// eligibility, destinations and journey identity remain backend-owned.
export function setTravel(scene) {
  const memory = scene._travelMemory, seed = !memory.initialized;
  memory.initialized = true;
  scene._travelById = new Map();
  for (const o of scene._travelRows || []) {
    const travel = o.sceneTravel;
    if (!travel) continue;
    scene._travelById.set(o.id, travel);
    if (!memory.has(travel.id)) memory.set(travel.id, { active: !seed, played: new Set() });
  }
  while (memory.size > 256) memory.delete(memory.keys().next().value);
}

export function arrival(scene, o) {
  const travel = scene._travelById?.get(o.id), memory = travel && scene._travelMemory.get(travel.id);
  if (!memory?.active || travel.toFloorId !== scene._floorId || memory.played.has(scene._floorId)) return null;
  memory.played.add(scene._floorId);
  return { id: travel.id, target: projected(travel.arrival, o.id) };
}

export function departure(scene, c) {
  const travel = scene._travelById?.get(c.id), memory = travel && scene._travelMemory.get(travel.id);
  if (!memory?.active || travel.fromFloorId !== scene._floorId || memory.played.has(scene._floorId)) return null;
  memory.played.add(scene._floorId);
  return { id: travel.id, target: projected(travel.departure, c.id) };
}

export function pose(c) {
  if (c.walking) return null;
  if (c.occ.state === 'idle' && (c.target?.mode ?? c.seatMode) === 'desk' &&
      !c.occ.activity && !c.activity && !c.deskTalk && !c.social && !c.cue && !c.egg && !c.reaction && !c.wave)
    return 'life-sleep-ne';
  if (!c.occ.activity) return null;
  if (c.target?.mode === 'sofa') return 'sofa-sit-sw';
  if (c.occ.activity.kind === 'gym') return `egg-curl-${c._sipRest ? 'high' : 'low'}-sw`;
  if (c.occ.activity.kind === 'smoke') return 'egg-smoke-sw';
  if (c.occ.activity.kind === 'coffee') return `life-${c._sipRest ? 'cupwalk' : 'drink'}-${c.target?.facing ?? 'sw'}`;
  return null;
}

export function activity(c) {
  if (pose(c) === 'life-sleep-ne') return 'sleep';
  return c.walking ? '' : c.occ.activity?.kind ?? '';
}

export function tick(scene, c, now) {
  if (c.walking || !['coffee', 'gym'].includes(c.occ.activity?.kind) || scene.reducedMotion) return;
  const interval = c.occ.activity.kind === 'gym' ? 750 : 1500;
  if (c._sipNext == null) c._sipNext = now + interval;
  if (now < c._sipNext) return;
  c._sipNext = now + interval;
  c._sipRest = !c._sipRest;
  scene._renderPose(c);
}
