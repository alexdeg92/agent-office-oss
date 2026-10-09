// Shared opt-in QA controls. Registry entries stay live so future animations need no UI edits.
import { ACTIVITIES, REACTIONS, watchLife } from './life.js';
import { EGG_KINDS } from './surprises.js';
import { STATES, CUES } from './states.js';
export { STATES };
export function animationEntries() {
  return [
    ...Object.keys(ACTIVITIES).map(id => ({ id, kind:'activity', partner:!!(ACTIVITIES[id].partner || ACTIVITIES[id].visitor) })),
    ...Object.keys(REACTIONS).map(id => ({ id, kind:'reaction' })),
    ...EGG_KINDS.map(id => ({ id, kind:'egg' })),
    ...Object.keys(CUES).map(id => ({ id, kind:'cue' })),
  ].map(e => ({ ...e, key:e.kind+':'+e.id }));
}
export function changeTestState(scene, ids, state) {
  if (!STATES.includes(state)) return;
  scene.setOccupants([...scene.chars.values()].filter(c => !c.leaving).map(c => ({ ...c.occ,
    ...(ids.includes(c.id) ? { state, stateSince:scene.now() } : {}) })));
}
export function playAnimation(scene, id, entry, { partnerId, weather } = {}) {
  if (!entry) return false;
  if (entry.kind === 'egg') return scene.surprise(id, entry.id, { weather });
  if (entry.kind === 'activity') return scene.interact(id, entry.id, { partnerId });
  if (entry.kind === 'reaction') return scene.react(id, entry.id);
  if (entry.kind === 'cue') { scene.cue(id, entry.id, { partnerId }); return !!scene.chars.get(id); }
  return false;
}
export function animationBusy(scene, id) {
  const c=scene.chars.get(id);
  return !!(c && (c.walking || c.activity || c.social || c.egg || c.reaction || c.cue || c.meet));
}
/** A single subscription to the existing life clock, including return walks before the next animation. */
export function createAnimationPlayer(scene, { onStatus = () => {}, prepare = () => {} } = {}) {
  let queue=[],active=null,deadline=0,subject=null,options={};
  const stop=()=>{queue=[];active=null;subject=null;};
  const next=async()=>{
    if (!subject || active || !queue.length) return;
    const entry=queue.shift(),id=subject;active=entry;deadline=scene.now()+120_000;
    prepare(id,entry,options);onStatus({entry,phase:'playing'});
    const ok=await playAnimation(scene,id,entry,options);
    if (active!==entry || subject!==id) return;
    if (!ok) {active=null;onStatus({entry,phase:'unavailable'});}
  };
  const unwatch=watchLife(()=>{
    if (!subject) return;
    if (!scene.chars.has(subject) || scene.destroyed) {stop();return;}
    if (active && scene.now()>=deadline) {onStatus({entry:active,phase:'timeout'});stop();return;}
    if (active && !animationBusy(scene,subject)) {onStatus({entry:active,phase:'finished'});active=null;}
    if (!active && queue.length) void next();
    else if (!active) {onStatus({phase:'done'});stop();}
  });
  return {
    play(id,entries,opts={}) {stop();subject=id;queue=[...entries];options=opts;void next();},
    stop,
    destroy(){stop();unwatch();},
  };
}
/** The legacy ?life=1 harness shares the same states, registry list and dispatch. */
export function mountAnimationControls(scene, root, { weather } = {}) {
  const panel=document.createElement('div');panel.className='bu-row';panel.style.padding='12px';
  const state=document.createElement('select');state.setAttribute('aria-label','État de test');
  STATES.forEach(id=>state.add(new Option(id,id)));
  const action=document.createElement('select');action.setAttribute('aria-label','Animation de test');
  animationEntries().forEach(e=>action.add(new Option(e.id,e.key)));
  const button=document.createElement('button');button.textContent='Jouer';button.className='bu-btn';
  state.onchange=()=>changeTestState(scene,[...scene.chars.keys()],state.value);
  button.onclick=()=>playAnimation(scene,scene.chars.keys().next().value,animationEntries().find(e=>e.key===action.value),{weather});
  panel.append(state,action,button);root.prepend(panel);
  return panel;
}
