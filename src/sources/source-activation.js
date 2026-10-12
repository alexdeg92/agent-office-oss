'use strict';

// Source-declared default, independent of provider and runtime kinds. A default
// becomes effective only after a valid response. Later read failures keep the
// activation choice; freshness and connection health remain separate.
function createSourceActivation({configured,detected=false,capabilities={}}={}) {
  let choice=configured,responded=false;
  const defaultEnabled=capabilities.autoEnableDefault===true;
  const enabled=()=>typeof choice==='boolean'?choice:!!detected&&defaultEnabled&&responded;
  return Object.freeze({
    observe(responding){if(responding===true)responded=true;return enabled();},
    configure(value){if(typeof value!=='boolean')throw new TypeError('Source activation must be boolean');choice=value;return enabled();},
    get enabled(){return enabled();},
    get shouldProbe(){return !!detected&&(choice===true||choice!==false&&defaultEnabled);},
  });
}
module.exports={createSourceActivation};
