import { atComputer } from './states.js';
// Registered T-0123 monitor frames.
const STATE_SCREEN = {"working": "coding", "observed": "coding", "thinking": "thinking", "researching": "browsing", "writing": "writing", "executing": "terminal", "calling": "terminal", "waiting": "waiting", "blocked": "blocked", "error": "blocked"};
const SCREENS = new Set(['message-sent', 'message-received', 'coding', 'terminal', 'browsing', 'writing', 'thinking', 'waiting', 'blocked']);

export function screen(scene, occupant, now) {
  const intent = occupant?.screenIntent;
  if (intent && intent.surface !== 'monitor') return null;
  const id = intent ? intent.screen : STATE_SCREEN[occupant?.state];
  return SCREENS.has(id) ? `assets/Office/monitor-screens/frames/${id}-${scene.reducedMotion ? 1 : 1 + Math.floor(now / 700) % 2}.png` : null;
}
export function marker(c, fallback) {
  if (atComputer(c)) return null;
  const intent = c.occ?.screenIntent;
  if (!intent) return c.cue ? null : fallback;
  if (intent.surface === 'none') return null;
  return ['message-sent', 'message-received'].includes(intent.screen) ? 'thought' : c.cue ? null : fallback;
}
export function bubble(c, glyph) {
  return atComputer(c) || c.occ?.screenIntent?.surface === 'none' ? null : glyph;
}
export function tickScreens(scene, now) {
  const frame = scene.reducedMotion ? 0 : Math.floor(now / 700) % 2;
  if (scene._monitorFrame === frame) return;
  scene._monitorFrame = frame;
  for (const [uid, node] of scene.itemNodes) if (node.parts?.monitor) scene._updateStation(uid);
}
