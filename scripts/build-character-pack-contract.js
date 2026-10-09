#!/usr/bin/env node
'use strict';
const fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'..'),source=require('../packaging/character-pack-contract.json');
const contract=Object.fromEntries(['id','canvas','accessories','budgets','frames'].map(k=>[k,source[k]]));
const target=path.join(root,'public/v2/generated/character-pack-contract.js');
const text='// Generated from packaging/character-pack-contract.json; run scripts/build-character-pack-contract.js.\nexport const contract = '+JSON.stringify(contract)+';\n';
if(process.argv.includes('--check')){if(fs.readFileSync(target,'utf8')!==text)throw Error('character pack contract is stale');}
else fs.writeFileSync(target,text);
