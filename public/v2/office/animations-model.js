// Synthetic identities and URL state. Catalog entries come from the same manifest index as the Store.
import { characterItems, colourItems, accessoryItems } from './catalog.js';
import { STATES } from './states.js';
export function lookChoices(index) {
  const first=index.characters.keys().next().value;
  return characterItems(index,{character:first,variant:null,accessories:[]},[],{}).flatMap(it=>{
    const colours=colourItems(index,it.look,[],{});
    return colours.length?colours.map(v=>({key:it.id+':'+v.id,c:it.c,v:v.v,look:{...v.look,accessories:[]}}))
      :[{key:it.id,c:it.c,look:{...it.look,accessories:[]}}];
  });
}
export const headChoices=(index,look)=>accessoryItems(index,look,[],{}).filter(it=>it.slot==='head');
const integer=(s,fallback,min,max)=>Number.isFinite(Number(s))&&s!==undefined?Math.max(min,Math.min(max,Math.floor(Number(s)))):fallback;
export function readAnimationQuery(query,index,lay) {
  const choices=lookChoices(index),count=integer(query.agents,2,1,100);
  const agents=Array.from({length:count},(_,i)=>{
    const suffix=i?i+1:'';
    const look=choices.find(x=>x.key===query['look'+suffix] || x.c.id===query['look'+suffix])??choices[i%choices.length];
    const accessory=headChoices(index,look.look).find(x=>x.id===query['accessoire'+suffix])?.id??'';
    return {look:look.key,accessory,state:STATES.includes(query['etat'+suffix])?query['etat'+suffix]:'idle'};
  });
  return {agents,selected:integer(query.agent,1,1,count)-1,partner:integer(query.partenaire,2,1,count)-1,
    moment:['jour','nuit','auto'].includes(query.moment)?query.moment:lay.theme.mode==='auto'?'auto':lay.theme.resolved==='night'?'nuit':'jour',
    rain:query.meteo==='pluie',uiTheme:['system','light','dark'].includes(query.theme)?query.theme:null,
    reduced:query.mouvement==='reduit',follow:query.suivre==='1',anim:query.anim??''};
}
export function animationQuery(cfg) {
  const q={agents:cfg.agents.length,agent:cfg.selected+1,partenaire:cfg.partner+1,moment:cfg.moment,meteo:cfg.rain?'pluie':'sec',
    theme:cfg.uiTheme,mouvement:cfg.reduced?'reduit':'normal',suivre:cfg.follow?'1':'0',anim:cfg.anim||null};
  cfg.agents.forEach((a,i)=>{const s=i?i+1:'';q['look'+s]=a.look;q['accessoire'+s]=a.accessory||'none';q['etat'+s]=a.state;});
  return q;
}
export function agentLetters(n) {let s='';do{s=String.fromCharCode(65+n%26)+s;n=Math.floor(n/26)-1;}while(n>=0);return s;}
export function testOccupants(cfg,index,layout,now,name) {
  const choices=lookChoices(index),stations=layout.items.filter(it=>index.furniture.get(it.asset)?.station?.kind==='desk');
  return cfg.agents.map((a,i)=>({id:'animation-agent-'+(i+1),role:'subagent',name:name(agentLetters(i)),sourceName:name(agentLetters(i)),
    state:a.state,stateSince:now,stationUid:stations[i]?.uid??null,
    look:{...(choices.find(x=>x.key===a.look)??choices[0]).look,accessories:a.accessory?[a.accessory]:[]}}));
}
