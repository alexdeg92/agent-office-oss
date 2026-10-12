import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
test('Settings owns behavior and uses shared Bureau controls for every native control',()=>{
 for(const name of ['settings','settings-frame','settings-views','settings-fix-all']){
  const source=readFileSync(new URL('../../public/v2/pages/'+name+'.js',import.meta.url),'utf8');
  assert.doesNotMatch(source,/<(?:input|select|textarea|button)\b/i,name+' must consume a shared control');
 }
});
