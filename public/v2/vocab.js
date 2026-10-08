// Values that differ between contract 2.5 and 3.0 (G5, api-v3.md), read the same way on both, so each page works
// against either version and the switch is config.apiVersion alone (migration-v3.md step 2).
import { config } from './config.js';

/** D5: a channel or room (2.x `discord-channel`, 3.0 `room` + `channel`), else a person. */
export const isRoom = (i) => i.kind === 'room' || i.kind === 'discord-channel';
export const isPerson = (i) => i.kind === 'user' || i.kind === 'discord-user';
/** D5: the interlocutor's channel (3.0 sends it; 2.x is Discord only). */
export const channelOf = (i) => i.channel || 'discord';
/** D8: the board filter « with the agent » in the configured contract (2.x `with-timmy`, 3.0 `with-agent`). */
export const agentFilter = () => (config.apiVersion === 3 ? 'with-agent' : 'with-timmy');
/** D8: a filter value from a URL or a VM, either vocabulary → the configured contract's (unknown → null). */
export function boardFilter(f) {
  if (f === 'with-agent' || f === 'with-timmy') return agentFilter();
  return f === 'all' || f === 'at-risk' || f === 'archived' ? f : null;
}

/**
 * D1: what the runtime can do, from MetaVM.runtime.capabilities ('chat', 'flows.write', 'skills.toggle', …).
 * A 2.x server declares none: everything is on. A nav entry with `needs` is hidden when its capability is false.
 */
export function runtimeCan(path, meta) {
  let v = meta && meta.runtime && meta.runtime.capabilities;
  if (!v || !path) return true;
  for (const k of path.split('.')) { if (v == null || typeof v !== 'object') return true; v = v[k]; }
  return v !== false;
}
