// Decorative life never changes server state. All durations can be shortened by QA.
export const LIFE = { idleAfterMs: 45_000, intervalMs: 5_000, cooldownMs: 90_000, longRunMs: 5 * 60_000, maxWanderers: 3 };
export const ACTIVITIES = {
  coffee: { asset: 'coffee-machine', weight: 5, ms: 6000, pose: 'talking', prop: 'cup', frames: 'life-drink-{facing}', restFrames: 'life-cupwalk-{facing}', sipMs: 1100, carry: 'cup' },
  water: { asset: 'plant-small|plant-large', weight: 2, ms: 5500, pose: 'talking', prop: 'water', frames: 'life-water-{facing}' },
  window: { asset: 'window', weight: 3, ms: 6500, pose: 'thinking', prop: 'view' },
  book: { asset: 'shelf', weight: 3, ms: 7000, pose: 'thinking', prop: 'book', frames: 'life-book-{facing}' },
  whiteboard: { asset: 'whiteboard', weight: 3, ms: 7500, pose: 'talking', prop: 'pen', frames: 'life-pen-{facing}' },
  chat: { partner: true, weight: 3, ms: 6500, pose: 'talking', prop: 'chat' },
  highfive: { partner: true, weight: 1, ms: 3000, pose: 'celebrating', prop: 'highfive' },
  wave: { visitor: true, weight: 2, ms: 3000, pose: 'talking', prop: 'wave' },
  sleep: { home: true, afterMs: 4 * 60_000, weight: 1, ms: 9000, pose: 'sleeping-ne', prop: 'sleep' },
  server: { asset: 'server-rack', weight: 2, ms: 6000, pose: 'thinking', prop: 'server' },
};
export const REACTIONS = {
  success: { ms: 1600, symbol: '✓', motion: 'pump', pose: 'life-success-sw' },
  error: { ms: 2200, symbol: '!', motion: 'scratch', pose: 'life-error-sw' },
  message: { ms: 1800, symbol: '✉', motion: 'notice' },
  stretch: { ms: 3000, symbol: '↔', motion: 'stretch', pose: 'life-stretch-ne' },
  waiting: { ms: 3000, symbol: '…', motion: 'tap' },
};
// Canonical engine vocabulary. Adapters never appear in this presentation registry.
export const SIGNALS = {
  'run.started': { preempt: true }, 'run.succeeded': { reaction: 'success' },
  'run.failed': { reaction: 'error', preempt: true },
  'waiting-on-human': { reaction: 'waiting', state: 'waiting', preempt: true },
  'message.inbound': { reaction: 'message' }, 'subagent.spawn': { cue: 'delegating', preempt: true },
  'tool.kind': { categories: { search: 'researching', web: 'researching', browser: 'researching', 'file-read': 'researching', memory: 'researching', 'file-write': 'writing', message: 'calling', exec: 'working', image: 'working', other: 'working' }, preempt: true },
  activity: { stateField: 'activity', preempt: true },
};
const wanderers = new Set();
export const wanderCount = () => wanderers.size;
export function acquireWander(owner, peers = [], max = LIFE.maxWanderers) {
  const group = [owner, ...peers];
  if (group.some(c => wanderers.has(c)) || wanderers.size + group.length > max) return false;
  group.forEach(c => wanderers.add(c)); return true;
}
export function releaseWander(owner) { wanderers.delete(owner); }
const clocks = new Set();
let clock = null;
export function watchLife(tick) {
  clocks.add(tick);
  if (!clock) clock = setInterval(() => { for (const fn of clocks) fn(); }, 50);
  return () => { clocks.delete(tick); if (!clocks.size) { clearInterval(clock); clock = null; } };
}
export const canIdle = o => o?.state === 'idle' && !o.presence && !o.destination;
export function pickActivity({ now, idleSince, history = {}, last, available, random = Math.random, config = LIFE }) {
  if (now - idleSince < config.idleAfterMs) return null;
  const pool = Object.entries(ACTIVITIES).filter(([k, d]) => k !== last && available(k)
    && now - idleSince >= (d.afterMs ?? 0) && now - (history[k] ?? -Infinity) >= config.cooldownMs);
  const total = pool.reduce((sum, [, d]) => sum + d.weight, 0);
  let roll = random() * total;
  for (const [k, d] of pool) { roll -= d.weight; if (roll < 0) return k; }
  return null;
}
// Only transitions actually present in OfficeVM are inferred. Success comes from celebrating SSE.
export function reactionFor(previous, next, now, cfg = LIFE) {
  if (!previous) return null;
  if (next.state === 'error' && previous.state !== 'error') return 'error';
  if (next.state === 'waiting' && previous.state !== 'waiting') return 'waiting';
  if (previous.state === 'idle' && !['idle', 'offline'].includes(next.state)) return 'message';
  if (!['idle', 'offline', 'waiting', 'error'].includes(next.state) && now - next.stateSince >= cfg.longRunMs) return 'stretch';
  return null;
}
