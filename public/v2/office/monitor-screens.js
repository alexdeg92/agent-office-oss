// T-0123 registered frames, route-lazy with Bureau. Presentation of the supplied VM state only.
const STATE_SCREEN = {"working": "coding", "observed": "coding", "thinking": "thinking", "researching": "browsing", "writing": "writing", "executing": "terminal", "calling": "terminal", "waiting": "waiting", "blocked": "blocked", "error": "blocked"};
const SCREENS = {
  "coding": [
    "assets/Office/monitor-screens/frames/coding-1.png",
    "assets/Office/monitor-screens/frames/coding-2.png"
  ],
  "terminal": [
    "assets/Office/monitor-screens/frames/terminal-1.png",
    "assets/Office/monitor-screens/frames/terminal-2.png"
  ],
  "browsing": [
    "assets/Office/monitor-screens/frames/browsing-1.png",
    "assets/Office/monitor-screens/frames/browsing-2.png"
  ],
  "writing": [
    "assets/Office/monitor-screens/frames/writing-1.png",
    "assets/Office/monitor-screens/frames/writing-2.png"
  ],
  "thinking": [
    "assets/Office/monitor-screens/frames/thinking-1.png",
    "assets/Office/monitor-screens/frames/thinking-2.png"
  ],
  "waiting": [
    "assets/Office/monitor-screens/frames/waiting-1.png",
    "assets/Office/monitor-screens/frames/waiting-2.png"
  ],
  "blocked": [
    "assets/Office/monitor-screens/frames/blocked-1.png",
    "assets/Office/monitor-screens/frames/blocked-2.png"
  ]
};
export function screen(scene, occupant, now) {
  const id = STATE_SCREEN[occupant?.state];
  return SCREENS[id]?.[scene.reducedMotion ? 0 : Math.floor(now / 700) % 2] ?? null;
}
const atComputer = c => (c.target?.mode ?? c.seatMode) === 'desk' && !c.walking;
export function marker(c, fallback) { return atComputer(c) ? null : c.cue ? null : fallback; }
export function bubble(c, glyph) { return atComputer(c) ? null : glyph; }
export function tickScreens(scene, now) {
  const frame = scene.reducedMotion ? 0 : Math.floor(now / 700) % 2;
  if (scene._monitorFrame === frame) return;
  scene._monitorFrame = frame;
  for (const [uid, node] of scene.itemNodes) if (node.parts?.monitor) scene._updateStation(uid);
}
