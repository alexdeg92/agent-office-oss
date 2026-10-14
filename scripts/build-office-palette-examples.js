#!/usr/bin/env node
'use strict';
const fs=require('node:fs'),path=require('node:path');
const {officeDefaults}=require('../src/api/v2/vm/office');
const {buildOfficePaletteVM}=require('../src/api/v2/vm/office-palette');
const {createVmCheck}=require('../src/api/v2/vm/check');
const index=officeDefaults().index,vm=buildOfficePaletteVM({index});
const write=(file,value)=>{fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,JSON.stringify(value,null,2)+'\n');};
for(const [version,dir] of [[2,'docs/architecture/examples'],[3,'docs/architecture/examples/v3']]) {
  createVmCheck({mode:'throw',version}).check('officePalette',vm);
  write(dir+'/office-palette-vm.json',{data:vm,meta:{modelVersion:1,generatedAt:1791888000000,stale:[]}});
  write(dir+'/office-palette-vm.types.json',{$comment:'OfficePaletteVM: identical v2/v3.',types:{},nullable:[]});
}
// Mock producer owns its search projection; the product editor never filters catalogue data.
write('public/v2/mock/examples/office-palette-catalog.json',{vm,items:[...index.furniture.values()].map(i=>({id:i.id,category:i.category,label:i.label,names:i.names||{}}))});
console.log('Office Palette examples and mock catalogue rebuilt.');
