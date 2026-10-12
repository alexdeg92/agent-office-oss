// Settings reads the shared lightweight layout topic; portraits never hydrate character packs.
import {html,useMemo} from '../lib.js';
import {useTopic} from '../hooks.js';
import {services} from '../services.js';
import {config} from '../config.js';
import {indexManifest} from '../office/assets.js';
import {avatarSource,CharacterAvatar} from '../office/avatar.js';
import {resolveOccupants} from '../office/layout-rules.js';
import {lookQuery} from './settings-rules.js';

export function useSettingsPortraits(agents){
 const {data}=useTopic('layout','/api/v2/office/layout');
 return useMemo(()=>{
  const looks=new Map();if(!data)return looks;
  const index=indexManifest(data.manifest),sources=agents.map(a=>({key:`${a.runtime}:${a.agentId}`,id:lookQuery(a.lookRoute)?.agent||(a.isPrimary?'primary':`agent:${a.agentId}`),role:a.isPrimary?'primary':'subagent',sourceName:a.name||a.agentId}));
  const resolved=resolveOccupants(data.layout.data,index,sources);
  for(let n=0;n<sources.length;n++){
   const source=avatarSource(index,resolved[n].look,services.officeAssetBase??config.assetBase);
   if(source){looks.set(sources[n].key,source);looks.set(sources[n].id,source);}
  }
  return looks;
 },[data,agents]);
}

export function SettingsPortrait({look,size}){return html`<${CharacterAvatar} source=${look} size=${size} class="ao-settings__portrait" />`;}
