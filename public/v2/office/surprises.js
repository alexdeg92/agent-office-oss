// Decorative, neutral idle signals only; shared leases cover main and annex scenes.
export const SURPRISES = { idleAfterMs: 15 * 60_000, everyMs: 20 * 60_000, chance: .035, arrowMs: 1300, transitionMs: 700 };
export const EGGS = {
  hide: { weight:1, landmark:'plant-large|plant-small', ms:12000, poses:['egg-hide-sw'], peekMs:2600 },
  gym: { weight:2, room:'gym', enter:{id:'enter',point:'mat',poses:['walking']}, steps:[
    {id:'curls',point:'mat',poses:['egg-curl-low-sw','egg-curl-high-sw'],loopMs:750,ms:6000,fx:'sweat'},
    {id:'bench',point:'bench',poses:['egg-bench-low-sw','egg-bench-high-sw'],anchor:'seat',approach:'benchFloor',loopMs:850,ms:6000,fx:'sweat'},
    {id:'wipe',point:'mat',poses:['egg-wipe-sw'],ms:2200},
    {id:'leave',point:'entry',poses:['walking-nw'],ms:1800},
  ] },
  smoke: { weight:1, room:'outdoor', enter:{id:'enter',point:'covered',poses:['walking']}, steps:[
    {id:'light',point:'covered',poses:['egg-light-sw'],ms:2000,fx:'ember'},
    {id:'smoke',point:'covered',poses:['egg-smoke-sw'],ms:6500,fx:'smoke'},
    {id:'drop',point:'covered',poses:['idle'],ms:900,fx:'drop'},
    {id:'crush',point:'covered',poses:['egg-crush-sw'],ms:1800,fx:'crush'},
    {id:'shake',point:'covered',poses:['egg-shake-sw'],ms:1400,weather:'rain'},
    {id:'leave',point:'entry',poses:['walking-ne'],ms:1800},
  ] },
};
export const EGG_KINDS = Object.keys(EGGS);
const KEY = 'office.animations-surprises';
let lease = null;
const history = new Map();
export const surpriseHistory = id => history.get(id);
export function rememberSurprise(id,at,kind) {
  history.delete(id); history.set(id,{at,kind});
  if(history.size>1024) history.delete(history.keys().next().value);
}
export function surprisesEnabled() { try { return localStorage.getItem(KEY) !== 'off'; } catch { return true; } }
export function saveSurprises(enabled) {
  try { localStorage.setItem(KEY, enabled ? 'on' : 'off'); } catch { /* restricted storage */ }
  window.dispatchEvent(new CustomEvent('office-surprises-setting', { detail: !!enabled }));
}
export function acquireSurprise(owner) { if (lease) return false; lease = owner; return true; }
export function releaseSurprise(owner) { if (lease === owner) lease = null; }
export function eggEligible(o, now, lastAt, cfg = SURPRISES) {
  return o?.state === 'idle' && !o.presence && !o.destination && Number.isFinite(o.stateSince)
    && now - o.stateSince >= cfg.idleAfterMs && now - (lastAt ?? -Infinity) >= cfg.everyMs;
}
export function pickEgg(last, available, random=Math.random) {
  const pool=Object.entries(EGGS).filter(([id])=>id!==last && available(id));
  let roll=random()*pool.reduce((n,[,d])=>n+d.weight,0);
  for(const [id,d] of pool) {roll-=d.weight;if(roll<0)return id;}
  return null;
}
