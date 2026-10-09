'use strict';
// Presentation of canonical engine events; shared registry, no adapter vocabulary.
const {SIGNALS}=require('../../../public/v2/office/life.js');
function officeSignalFrame(e,P) {
 if(!e?.occupantId||!SIGNALS[e.kind])return null;
 const d=SIGNALS[e.kind];
 return {type:'cue',occupantId:P.occupantId(e.occupantId),cue:d.cue??(d.reaction==='success'?'celebrating':'talking'),at:e.at,
  signal:{id:e.id,kind:e.kind,at:e.at,count:e.count,...(e.activity?{activity:e.activity}:{}),...(e.toolKind?{toolKind:e.toolKind}:{})}};
}
module.exports={officeSignalFrame};
