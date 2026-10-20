'use strict';

const {connectorBrand}=require('./runtime-sources');
const generic=(kind,id,label,params)=>({id,kind,runtime:null,label:{key:label,...(params?{params}:{})},brand:null});

// Linked-source IDs identify a project's stored link, not a filter category.
// Connector identity/branding comes only from the canonical engine registry.
function projectSourceDescriptors(project,{sourceConnectors=()=>[]}={}) {
  const unique=new Map();
  const add=descriptor=>{if(descriptor?.id&&!unique.has(descriptor.id))unique.set(descriptor.id,descriptor);};
  if(Array.isArray(project.sourceDescriptors))project.sourceDescriptors.forEach(add);
  else if(project.teamProject?.sourceDescriptor)add(project.teamProject.sourceDescriptor);
  else for(const source of project.sources||[]) {
    if(source.sourceDescriptor){add(source.sourceDescriptor);continue;}
    if(source.kind==='sessionGroup') {
      const connectors=sourceConnectors(source)||[];
      if(!connectors.length)add(generic(source.kind,'source:sessionGroup','project.source.sessionGroup'));
      for(const connector of connectors)if(connector?.id) add({id:'source:sessionGroup:'+connector.id,kind:source.kind,
        runtime:connector.adapter||null,label:{key:'project.source.label',params:{label:connector.name||connector.adapter||'Runtime'}},
        brand:connectorBrand(connector.mark)});
    }else if(source.kind==='github') {
      const owner=source.ref?.owner;
      add(generic(source.kind,'source:github:'+(owner?owner.toLowerCase():'unknown'),owner?'project.source.github':'project.source.github.generic',owner?{owner}:null));
    }else if(source.kind==='workspace') {
      add(generic(source.kind,'source:workspace:'+(source.ref?.rootId||'local'),'project.source.workspace'));
    }else add(generic(source.kind,'source:'+source.kind,source.kind==='manual'?'project.source.manual':'project.source.other'));
  }
  return structuredClone([...unique.values()]);
}
module.exports={projectSourceDescriptors};
